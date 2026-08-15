//! The packetcode engine bridge.
//!
//! Resolves the separately-installed `packetcode` binary (never bundled),
//! gates on a minimum engine version via `packetcode doctor --json`, then
//! spawns `packetcode acp` and speaks Agent Client Protocol v1 — NDJSON
//! JSON-RPC 2.0 over stdio. Session updates and permission requests are
//! forwarded to the webview as Tauri events.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

/// Oldest engine this client is tested against.
pub const MINIMUM_ENGINE_VERSION: &str = "0.1.0";
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `session/prompt` runs an entire agent turn; give it room.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub minimum_version: String,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DoctorReport {
    #[allow(dead_code)]
    schema_version: Option<u64>,
    status: Option<String>,
    version: Option<String>,
}

pub struct EngineState {
    inner: Arc<Mutex<Option<Engine>>>,
    next_request_id: AtomicU64,
    /// Pending client->agent requests awaiting a response.
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    /// Pending agent->client permission requests awaiting the user's answer.
    permission_waiters: Arc<Mutex<HashMap<u64, u64>>>,
}

struct Engine {
    child: Child,
    stdin: ChildStdin,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            next_request_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            permission_waiters: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn engine_binary() -> String {
    std::env::var("PACKETCODE_GUI_ENGINE").unwrap_or_else(|_| "packetcode".to_string())
}

fn version_at_least(found: &str, minimum: &str) -> bool {
    // Source builds report "dev"; trust them as current — the ACP capability
    // handshake is the real compatibility check for unversioned engines.
    if found.trim_start_matches('v').starts_with("dev") {
        return true;
    }
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .take(3)
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let f = parse(found);
    let m = parse(minimum);
    if f.is_empty() {
        return false;
    }
    for i in 0..3 {
        let a = f.get(i).copied().unwrap_or(0);
        let b = m.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

#[tauri::command]
pub async fn engine_probe() -> Result<EngineProbe, String> {
    let bin = engine_binary();
    let output = timeout(
        PROBE_TIMEOUT,
        Command::new(&bin)
            .args(["doctor", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await;

    let output = match output {
        Err(_) => {
            return Ok(EngineProbe {
                found: true,
                path: Some(bin),
                version: None,
                status: None,
                minimum_version: MINIMUM_ENGINE_VERSION.into(),
                compatible: false,
                detail: Some("doctor --json timed out".into()),
            })
        }
        Ok(Err(e)) => {
            return Ok(EngineProbe {
                found: false,
                path: None,
                version: None,
                status: None,
                minimum_version: MINIMUM_ENGINE_VERSION.into(),
                compatible: false,
                detail: Some(format!("could not run {bin}: {e}")),
            })
        }
        Ok(Ok(o)) => o,
    };

    let report: DoctorReport = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("doctor --json returned invalid JSON: {e}"))?;
    let version = report.version.clone();
    let compatible = version
        .as_deref()
        .map(|v| version_at_least(v, MINIMUM_ENGINE_VERSION))
        .unwrap_or(false);

    Ok(EngineProbe {
        found: true,
        path: Some(bin),
        version,
        status: report.status,
        minimum_version: MINIMUM_ENGINE_VERSION.into(),
        compatible,
        detail: None,
    })
}

#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let mut child = Command::new(engine_binary())
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn packetcode acp: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin on engine process")?;
    let stdout = child.stdout.take().ok_or("no stdout on engine process")?;

    // Reader task: route responses, notifications, and server->client requests.
    let pending = state.pending.clone();
    let waiters = state.permission_waiters.clone();
    let reader_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let has_id = msg.get("id").is_some();
            let method = msg.get("method").and_then(Value::as_str);
            match (has_id, method) {
                // Response to one of our requests.
                (true, None) => {
                    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let result = match msg.get("error") {
                            Some(err) => Err(err.to_string()),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(result);
                    }
                }
                // Notification from the agent.
                (false, Some("session/update")) => {
                    if let Some(params) = msg.get("params") {
                        let _ = reader_app.emit("acp:update", params);
                    }
                }
                // Request from the agent — today only permission prompts.
                (true, Some("session/request_permission")) => {
                    let Some(rpc_id) = msg.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    waiters.lock().await.insert(rpc_id, rpc_id);
                    if let Some(params) = msg.get("params") {
                        let mut payload = params.clone();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("requestId".into(), json!(rpc_id));
                        }
                        let _ = reader_app.emit("acp:permission_request", payload);
                    }
                }
                _ => {}
            }
        }
    });

    let mut engine = Engine { child, stdin };
    engine_initialized(&mut engine, &state).await?;
    *guard = Some(engine);
    Ok(())
}

async fn engine_initialized(engine: &mut Engine, state: &EngineState) -> Result<Value, String> {
    request_on(
        engine,
        state,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            "clientInfo": { "name": "packetcode-gui", "version": env!("CARGO_PKG_VERSION") }
        }),
        REQUEST_TIMEOUT,
    )
    .await
}

async fn request_on(
    engine: &mut Engine,
    state: &EngineState,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let id = state.next_request_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().await.insert(id, tx);

    let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let mut line = frame.to_string();
    line.push('\n');
    engine
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("engine write failed: {e}"))?;

    match timeout(wait, rx).await {
        Err(_) => {
            state.pending.lock().await.remove(&id);
            Err(format!("{method} timed out"))
        }
        Ok(Err(_)) => Err(format!("{method}: engine closed the channel")),
        Ok(Ok(result)) => result,
    }
}

async fn request(
    state: &EngineState,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let mut guard = state.inner.lock().await;
    let engine = guard.as_mut().ok_or("engine not started")?;
    request_on(engine, state, method, params, wait).await
}

#[tauri::command]
pub async fn engine_new_session(
    cwd: String,
    state: State<'_, EngineState>,
) -> Result<String, String> {
    let abs = std::fs::canonicalize(&cwd)
        .map_err(|e| format!("cwd {cwd}: {e}"))?
        .to_string_lossy()
        .to_string();
    // Windows canonicalize yields \\?\ paths; the engine wants plain absolutes.
    let abs = abs.trim_start_matches(r"\\?\").to_string();
    let result = request(
        &state,
        "session/new",
        json!({ "cwd": abs, "mcpServers": [] }),
        REQUEST_TIMEOUT,
    )
    .await?;
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "session/new returned no sessionId".into())
}

#[tauri::command]
pub async fn engine_prompt(
    session_id: String,
    text: String,
    state: State<'_, EngineState>,
) -> Result<String, String> {
    let result = request(
        &state,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }]
        }),
        PROMPT_TIMEOUT,
    )
    .await?;
    Ok(result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn")
        .to_string())
}

#[tauri::command]
pub async fn engine_cancel(session_id: String, state: State<'_, EngineState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let engine = guard.as_mut().ok_or("engine not started")?;
    let frame = json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    });
    let mut line = frame.to_string();
    line.push('\n');
    engine
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("engine write failed: {e}"))
}

#[tauri::command]
pub async fn engine_permission_reply(
    request_id: u64,
    option_id: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    if state
        .permission_waiters
        .lock()
        .await
        .remove(&request_id)
        .is_none()
    {
        return Err(format!("no pending permission request {request_id}"));
    }
    let mut guard = state.inner.lock().await;
    let engine = guard.as_mut().ok_or("engine not started")?;
    let frame = json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
    });
    let mut line = frame.to_string();
    line.push('\n');
    engine
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("engine write failed: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub name: String,
    pub updated_at: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub cost_usd: f64,
}

/// Session history for the sidebar. Prefers the engine's
/// `_packetcode/sessions/list` ACP extension; falls back to reading
/// `~/.packetcode/sessions/*.json` when the engine predates it.
#[tauri::command]
pub async fn engine_list_sessions(
    state: State<'_, EngineState>,
) -> Result<Vec<SessionSummary>, String> {
    match request(&state, "_packetcode/sessions/list", json!({}), REQUEST_TIMEOUT).await {
        Ok(result) => {
            let sessions = result.get("sessions").cloned().unwrap_or(json!([]));
            serde_json::from_value(sessions).map_err(|e| format!("bad sessions payload: {e}"))
        }
        Err(err) if err.contains("-32601") || err.contains("Method not found") => {
            list_sessions_from_disk()
        }
        Err(err) => Err(err),
    }
}

fn packetcode_home() -> Option<std::path::PathBuf> {
    if let Ok(home) = std::env::var("PACKETCODE_HOME") {
        if !home.trim().is_empty() {
            return Some(std::path::PathBuf::from(home));
        }
    }
    let user_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::PathBuf::from(user_home).join(".packetcode"))
}

fn list_sessions_from_disk() -> Result<Vec<SessionSummary>, String> {
    #[derive(Deserialize)]
    struct DiskCost {
        #[serde(default)]
        total_usd: f64,
    }
    #[derive(Deserialize)]
    struct DiskSession {
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        updated_at: String,
        #[serde(default)]
        provider: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        working_dir: String,
        #[serde(default)]
        messages: Vec<serde::de::IgnoredAny>,
        #[serde(default)]
        cost: Option<DiskCost>,
    }

    let Some(dir) = packetcode_home().map(|h| h.join("sessions")) else {
        return Ok(Vec::new());
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let Ok(s) = serde_json::from_slice::<DiskSession>(&data) else {
            continue;
        };
        out.push(SessionSummary {
            session_id: s.id,
            name: s.name,
            updated_at: s.updated_at,
            provider: s.provider,
            model: s.model,
            working_dir: s.working_dir,
            message_count: s.messages.len() as u64,
            cost_usd: s.cost.map(|c| c.total_usd).unwrap_or(0.0),
        });
    }
    // Newest first, same as the engine's ordering.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(mut engine) = state.inner.lock().await.take() {
        let _ = engine.child.kill().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::version_at_least;

    #[test]
    fn version_gate() {
        assert!(version_at_least("0.1.0", "0.1.0"));
        assert!(version_at_least("0.2.0", "0.1.0"));
        assert!(version_at_least("v1.0.0", "0.9.9"));
        assert!(version_at_least("0.1.1-dev", "0.1.0"));
        assert!(version_at_least("dev", "0.1.0"));
        assert!(!version_at_least("0.0.9", "0.1.0"));
        assert!(!version_at_least("garbage", "0.1.0"));
    }
}
