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
/// `session/load` replays a whole transcript before resolving.
const LOAD_TIMEOUT: Duration = Duration::from_secs(120);
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
    /// Whether engine_install can run on this platform.
    pub install_supported: bool,
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

/// The permission-mode vocabulary this client knows, in the engine's
/// escalation order (packetcode/internal/acp/server.go `PermissionModes`).
/// Used as the conservative fallback for engines that advertise no
/// `permissionModes` list, so they keep offering exactly what they did before
/// capability negotiation existed.
pub const PERMISSION_MODES: [&str; 5] = ["ask", "accept-edits", "auto", "read-only", "bypass"];

/// The engine's `agentCapabilities._packetcode` vendor extension block.
///
/// `advertised` is the load-bearing field: an engine that sent no
/// `_packetcode` object at all (an older packetcode, or a third-party ACP
/// agent) leaves every boolean `false`, and the frontend must NOT read those
/// as "feature missing" — the call-time method-not-found fallbacks still
/// decide. Only when `advertised` is true are the booleans authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketcodeCapabilities {
    /// Whether the engine sent an `agentCapabilities._packetcode` object.
    pub advertised: bool,
    /// Gates `_packetcode/sessions/list`.
    pub sessions_list: bool,
    /// Gates `_packetcode/sessions/rename`.
    pub sessions_rename: bool,
    /// Gates `_packetcode/sessions/usage` and prompt-result enrichment.
    pub sessions_usage: bool,
    /// Gates `_packetcode/models/list`.
    pub models_list: bool,
    /// Modes `session/new` will accept. The engine trims this to the
    /// operator's configured ceiling; anything above it fails -32602, so the
    /// picker must offer exactly this set. Never empty: an engine that
    /// advertises nothing (or garbage) yields all five.
    pub permission_modes: Vec<String>,
    /// Mode a `session/new` without an override resolves to, when the engine
    /// says. `None` means "unknown" — the UI must not guess "ask".
    pub default_permission_mode: Option<String>,
}

impl Default for PacketcodeCapabilities {
    fn default() -> Self {
        Self {
            advertised: false,
            sessions_list: false,
            sessions_rename: false,
            sessions_usage: false,
            models_list: false,
            permission_modes: PERMISSION_MODES.iter().map(|m| m.to_string()).collect(),
            default_permission_mode: None,
        }
    }
}

/// What the engine advertised in its ACP `initialize` response. Retained from
/// the handshake so the UI can offer only what the engine will actually
/// accept, instead of discovering that from -32601/-32602 errors at call time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub protocol_version: u64,
    /// Spec capability: whether `session/load` may be used to resume.
    pub load_session: bool,
    /// Spec capability (`sessionCapabilities.close`): whether the engine can
    /// release a session's runtime on request. False for engines that predate
    /// it — eviction there still drops the client-side transcript, but the
    /// engine keeps its runtime until a re-load supersedes it.
    pub session_close: bool,
    pub packetcode: PacketcodeCapabilities,
}

/// Parses an ACP `initialize` result into [`EngineCapabilities`].
///
/// Every field is optional and unknown fields are ignored: the engine may be
/// newer than this client, older than the capability block, or (in the limit)
/// answer something malformed. Missing or unusable input degrades to the
/// conservative defaults rather than failing the handshake.
fn parse_capabilities(result: &Value) -> EngineCapabilities {
    let agent = result.get("agentCapabilities").filter(|v| v.is_object());
    let ext = agent
        .and_then(|a| a.get("_packetcode"))
        .filter(|v| v.is_object());
    let flag = |name: &str| {
        ext.and_then(|e| e.get(name))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };

    // An absent, non-array, or empty list means "the engine did not say":
    // keep all five so pre-capability engines behave exactly as before.
    let permission_modes = ext
        .and_then(|e| e.get("permissionModes"))
        .and_then(Value::as_array)
        .map(|items| {
            let mut modes: Vec<String> = Vec::with_capacity(items.len());
            for mode in items.iter().filter_map(Value::as_str) {
                let mode = mode.trim();
                if !mode.is_empty() && !modes.iter().any(|m| m == mode) {
                    modes.push(mode.to_string());
                }
            }
            modes
        })
        .filter(|modes| !modes.is_empty())
        .unwrap_or_else(|| PERMISSION_MODES.iter().map(|m| m.to_string()).collect());

    // A default outside the advertised set is nonsense; drop it rather than
    // let the UI preselect a mode session/new would reject.
    let default_permission_mode = ext
        .and_then(|e| e.get("defaultPermissionMode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|mode| !mode.is_empty() && permission_modes.iter().any(|m| m == mode))
        .map(String::from);

    EngineCapabilities {
        protocol_version: result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(1),
        load_session: agent
            .and_then(|a| a.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // SessionCapabilities is object-shaped, not boolean-shaped: the spec
        // says `{}` means supported while an absent or null field means the
        // agent does not advertise it. Anything else (a stray `true`, a
        // number) is not the shape the spec defines, so it is not taken as
        // support.
        session_close: agent
            .and_then(|a| a.get("sessionCapabilities"))
            .and_then(|s| s.get("close"))
            .map(Value::is_object)
            .unwrap_or(false),
        packetcode: PacketcodeCapabilities {
            advertised: ext.is_some(),
            sessions_list: flag("sessionsList"),
            sessions_rename: flag("sessionsRename"),
            sessions_usage: flag("sessionsUsage"),
            models_list: flag("modelsList"),
            permission_modes,
            default_permission_mode,
        },
    }
}

/// Sink for agent-initiated traffic. The Tauri layer forwards these to the
/// webview as events; tests collect them directly.
pub trait AcpEvents: Send + Sync + 'static {
    /// Params of a `session/update` notification.
    fn on_update(&self, params: Value);
    /// Params of a `session/request_permission` request, with `requestId` added.
    fn on_permission_request(&self, payload: Value);
}

struct TauriEvents {
    app: AppHandle,
}

impl AcpEvents for TauriEvents {
    fn on_update(&self, params: Value) {
        let _ = self.app.emit("acp:update", params);
    }
    fn on_permission_request(&self, payload: Value) {
        let _ = self.app.emit("acp:permission_request", payload);
    }
}

/// The ACP protocol client: owns the engine's stdin, the reader/dispatch task,
/// and request/response bookkeeping. Knows nothing about Tauri, so integration
/// tests can drive it against a mock engine without an AppHandle.
pub struct AcpBridge {
    next_request_id: AtomicU64,
    /// Pending client->agent requests awaiting a response.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    /// Agent->client permission requests awaiting the user's answer, keyed by
    /// the canonical JSON of the request id. The real engine uses STRING ids
    /// ("packetcode-permission-1"), so the raw id Value is stored and echoed
    /// back verbatim in the reply frame.
    permission_waiters: Mutex<HashMap<String, PendingPermission>>,
    /// The engine's stdin, or None once it has been closed. Held in an Option
    /// purely so it can be DROPPED: closing the pipe is what makes the
    /// engine's ACP loop return and run its own shutdown (see close_stdin).
    stdin: Mutex<Option<ChildStdin>>,
}

/// One unanswered `session/request_permission`. The session id is kept next to
/// the raw JSON-RPC id because sessions run concurrently: cancelling one
/// session must answer only ITS outstanding requests and leave another
/// session's request waiting for the user.
struct PendingPermission {
    session_id: String,
    raw_id: Value,
}

impl AcpBridge {
    /// Wraps an engine's stdio and spawns the reader task.
    /// Must be called from within a tokio runtime.
    pub fn start(
        stdin: ChildStdin,
        stdout: tokio::process::ChildStdout,
        sink: Arc<dyn AcpEvents>,
    ) -> Arc<Self> {
        let bridge = Arc::new(Self {
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            permission_waiters: Mutex::new(HashMap::new()),
            stdin: Mutex::new(Some(stdin)),
        });
        let reader = bridge.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                reader.dispatch(&line, sink.as_ref()).await;
            }
            // Engine went away: fail pending requests now instead of letting
            // callers sit out their full timeout, and drop stale waiters.
            for (_, tx) in reader.pending.lock().await.drain() {
                let _ = tx.send(Err("engine closed the connection".into()));
            }
            reader.permission_waiters.lock().await.clear();
        });
        bridge
    }

    /// Routes one incoming NDJSON line: a response, a notification, or a
    /// server->client request. Unparseable or unrecognized lines are ignored.
    async fn dispatch(&self, line: &str, sink: &dyn AcpEvents) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        let has_id = msg.get("id").is_some();
        let method = msg.get("method").and_then(Value::as_str);
        match (has_id, method) {
            // Response to one of our requests.
            (true, None) => {
                let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                    return;
                };
                if let Some(tx) = self.pending.lock().await.remove(&id) {
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
                    sink.on_update(params.clone());
                }
            }
            // Request from the agent — today only permission prompts. The id
            // may be a string or a number; it is stored and echoed verbatim.
            (true, Some("session/request_permission")) => {
                let Some(rpc_id) = msg.get("id").cloned() else {
                    return;
                };
                let session_id = msg
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.permission_waiters.lock().await.insert(
                    rpc_id.to_string(),
                    PendingPermission {
                        session_id,
                        raw_id: rpc_id.clone(),
                    },
                );
                if let Some(params) = msg.get("params") {
                    let mut payload = params.clone();
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("requestId".into(), rpc_id);
                    }
                    sink.on_permission_request(payload);
                }
            }
            _ => {}
        }
    }

    async fn write_line(&self, frame: &Value) -> Result<(), String> {
        let mut line = frame.to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("engine stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("engine write failed: {e}"))
    }

    /// Closes the engine's stdin, which is the ONLY graceful way to stop it:
    /// its ACP loop returns on end-of-input and then runs its own shutdown,
    /// releasing every session's runtime and, with them, the MCP child
    /// processes those sessions started. Killing the engine outright (what
    /// `kill_on_drop` does when this process exits) skips all of that and
    /// leaves those grandchildren orphaned.
    pub async fn close_stdin(&self) {
        // Dropping the handle is what closes the pipe; tokio's AsyncWrite
        // shutdown for ChildStdin does not.
        drop(self.stdin.lock().await.take());
    }

    /// Sends a request and awaits its response. The stdin lock is held only
    /// for the write, never across the await on the response — cancel and
    /// permission replies must be able to go out while a prompt is in flight.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_line(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match timeout(wait, rx).await {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{method} timed out"))
            }
            Ok(Err(_)) => Err(format!("{method}: engine closed the channel")),
            Ok(Ok(result)) => result,
        }
    }

    /// Sends a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    /// Cancels a session turn: sends `session/cancel` and answers THIS
    /// session's outstanding permission requests with a `cancelled` outcome
    /// (the ACP contract on cancellation). Late `permission_reply` calls for
    /// those requests then fail cleanly instead of double-answering the agent.
    /// Other sessions' requests are left pending — they belong to turns that
    /// are still running and still need the user's answer.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await?;
        let stale: Vec<Value> = {
            let mut waiters = self.permission_waiters.lock().await;
            let doomed: Vec<String> = waiters
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(key, _)| key.clone())
                .collect();
            doomed
                .into_iter()
                .filter_map(|key| waiters.remove(&key).map(|pending| pending.raw_id))
                .collect()
        };
        for id in stale {
            let _ = self
                .write_line(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
        }
        Ok(())
    }

    /// Answers a pending agent permission request with the selected option.
    /// `request_id` is the raw JSON-RPC id from the permission event.
    pub async fn permission_reply(&self, request_id: &Value, option_id: &str) -> Result<(), String> {
        let Some(pending) = self
            .permission_waiters
            .lock()
            .await
            .remove(&request_id.to_string())
        else {
            return Err(format!("no pending permission request {request_id}"));
        };
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
        }))
        .await
    }
}

#[derive(Default)]
pub struct EngineState {
    inner: Arc<Mutex<Option<Engine>>>,
    /// Binary path the last probe validated; engine_start spawns exactly this.
    resolved_binary: Arc<Mutex<Option<String>>>,
    /// What the running engine advertised in `initialize`. `None` until the
    /// handshake completes (and again after engine_stop).
    capabilities: Arc<Mutex<Option<EngineCapabilities>>>,
}

struct Engine {
    child: Child,
    bridge: Arc<AcpBridge>,
}

/// Resolution order: explicit override, PATH, then install.ps1's default
/// target (`%LOCALAPPDATA%\Programs\PacketCode\bin` — the script warns it does
/// not modify PATH and expects clients to check that documented location).
/// Returns an absolute path whenever one was verified, so the binary the probe
/// validated is byte-identical to the one later spawned (a bare name would let
/// CreateProcess prefer the application directory over PATH).
fn resolve_engine_binary() -> String {
    if let Ok(exe) = std::env::var("PACKETCODE_GUI_ENGINE") {
        let exe = exe.trim();
        if !exe.is_empty() {
            return exe.to_string();
        }
    }
    if let Some(hit) = path_search("packetcode") {
        return hit.to_string_lossy().to_string();
    }
    if let Some(default) = default_install_binary() {
        return default.to_string_lossy().to_string();
    }
    "packetcode".to_string()
}

fn path_search(name: &str) -> Option<std::path::PathBuf> {
    let paths = std::env::var_os("PATH")?;
    // On Windows, honor PATHEXT so .cmd/.bat shims resolve, and skip
    // extensionless files (not executable there anyway).
    let candidates: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|e| e.trim().to_lowercase())
            .filter(|e| e.starts_with('.'))
            .map(|e| format!("{name}{e}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&paths) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

fn default_install_binary() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let full = std::path::PathBuf::from(local)
        .join("Programs")
        .join("PacketCode")
        .join("bin")
        .join("packetcode.exe");
    full.is_file().then_some(full)
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
pub async fn engine_probe(state: State<'_, EngineState>) -> Result<EngineProbe, String> {
    run_probe(&state).await
}

async fn run_probe(state: &EngineState) -> Result<EngineProbe, String> {
    let bin = resolve_engine_binary();
    *state.resolved_binary.lock().await = Some(bin.clone());
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
            return Ok(probe_result(
                true,
                Some(bin),
                None,
                None,
                false,
                Some("doctor --json timed out".into()),
            ))
        }
        Ok(Err(e)) => {
            let detail = format!("could not run {bin}: {e}");
            return Ok(probe_result(false, None, None, None, false, Some(detail)));
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

    Ok(probe_result(
        true,
        Some(bin),
        version,
        report.status,
        compatible,
        None,
    ))
}

fn probe_result(
    found: bool,
    path: Option<String>,
    version: Option<String>,
    status: Option<String>,
    compatible: bool,
    detail: Option<String>,
) -> EngineProbe {
    EngineProbe {
        found,
        path,
        version,
        status,
        minimum_version: MINIMUM_ENGINE_VERSION.into(),
        compatible,
        install_supported: cfg!(windows),
        detail,
    }
}

#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    // Spawn exactly what the probe validated; fall back to a fresh resolution
    // only if no probe ran (direct dev invocation).
    let bin = state
        .resolved_binary
        .lock()
        .await
        .clone()
        .unwrap_or_else(resolve_engine_binary);
    start_engine(&state, &bin, &["acp"], Arc::new(TauriEvents { app })).await
}

/// Spawns `program args..`, wires up an [`AcpBridge`], and performs the ACP
/// initialize handshake. Split out of the Tauri command (with explicit
/// program/args/sink) so integration tests can run the real start path
/// against a mock engine without an AppHandle.
pub async fn start_engine(
    state: &EngineState,
    program: &str,
    args: &[&str],
    sink: Arc<dyn AcpEvents>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn {program} {}: {e}", args.join(" ")))?;

    let stdin = child.stdin.take().ok_or("no stdin on engine process")?;
    let stdout = child.stdout.take().ok_or("no stdout on engine process")?;

    let bridge = AcpBridge::start(stdin, stdout, sink);
    let handshake = bridge
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
                "clientInfo": { "name": "packetcode-gui", "version": env!("CARGO_PKG_VERSION") }
            }),
            REQUEST_TIMEOUT,
        )
        .await?;
    // Keep what the engine advertised: the UI offers only the permission modes
    // and extensions this engine will actually accept, instead of discovering
    // them from -32601/-32602 errors at call time.
    *state.capabilities.lock().await = Some(parse_capabilities(&handshake));
    *guard = Some(Engine { child, bridge });
    Ok(())
}

/// Whether a bridge error is the engine answering method-not-found. The
/// bridge stringifies the whole JSON-RPC error object rather than parsing it,
/// so this sniffs the serialized text. Every optional `_packetcode/*` vendor
/// extension routes its "engine predates this feature" case through here and
/// degrades instead of failing.
fn is_method_not_found(err: &str) -> bool {
    err.contains("-32601") || err.contains("Method not found")
}

/// Capabilities the running engine advertised. Before the handshake (or after
/// a stop) this yields the conservative defaults — all five permission modes,
/// nothing advertised — which is exactly how a pre-capability engine is
/// treated, so callers never need a second set of fallbacks.
pub async fn capabilities_of(state: &EngineState) -> EngineCapabilities {
    state.capabilities.lock().await.clone().unwrap_or_default()
}

#[tauri::command]
pub async fn engine_capabilities(
    state: State<'_, EngineState>,
) -> Result<EngineCapabilities, String> {
    Ok(capabilities_of(&state).await)
}

/// Clones the bridge handle out of the state so protocol awaits never hold
/// the state lock (holding it across a prompt is what used to deadlock
/// cancel and permission replies).
async fn bridge_of(state: &EngineState) -> Result<Arc<AcpBridge>, String> {
    state
        .inner
        .lock()
        .await
        .as_ref()
        .map(|e| e.bridge.clone())
        .ok_or_else(|| "engine not started".to_string())
}

/// Builds the `session/new` params object. Optional per-session provider,
/// model, and permission-mode overrides ride in the engine's "_packetcode"
/// vendor-extension params object. The extension is omitted entirely when the
/// caller wants the engine defaults, so older engines see a spec-only call;
/// engines too old for a given field ignore it (plain JSON decode).
fn new_session_params(
    cwd_abs: &str,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
) -> Value {
    let mut params = json!({ "cwd": cwd_abs, "mcpServers": [] });
    let provider = provider
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let permission_mode = permission_mode
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    if provider.is_some() || model.is_some() || permission_mode.is_some() {
        let mut ext = serde_json::Map::new();
        if let Some(p) = provider {
            ext.insert("provider".into(), json!(p));
        }
        if let Some(m) = model {
            ext.insert("model".into(), json!(m));
        }
        if let Some(mode) = permission_mode {
            ext.insert("permissionMode".into(), json!(mode));
        }
        params
            .as_object_mut()
            .expect("session/new params are an object")
            .insert("_packetcode".into(), Value::Object(ext));
    }
    params
}

pub async fn new_session_on(
    state: &EngineState,
    cwd: &str,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
) -> Result<String, String> {
    let abs = std::fs::canonicalize(cwd)
        .map_err(|e| format!("cwd {cwd}: {e}"))?
        .to_string_lossy()
        .to_string();
    // Windows canonicalize yields \\?\ paths; the engine wants plain absolutes.
    let abs = abs.trim_start_matches(r"\\?\").to_string();
    let params = new_session_params(&abs, provider, model, permission_mode);
    let result = bridge_of(state)
        .await?
        .request("session/new", params, REQUEST_TIMEOUT)
        .await?;
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "session/new returned no sessionId".into())
}

/// Resumes a persisted session via ACP `session/load`. The engine replays the
/// stored transcript as `session/update` notifications (forwarded to the
/// webview as `acp:update`) before this request resolves, so callers must
/// subscribe to updates before invoking it.
pub async fn load_session_on(
    state: &EngineState,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    let abs = std::fs::canonicalize(cwd)
        .map_err(|e| format!("cwd {cwd}: {e}"))?
        .to_string_lossy()
        .to_string();
    // Windows canonicalize yields \\?\ paths; the engine wants plain absolutes.
    let abs = abs.trim_start_matches(r"\\?\").to_string();
    bridge_of(state)
        .await?
        .request(
            "session/load",
            json!({ "sessionId": session_id, "cwd": abs, "mcpServers": [] }),
            LOAD_TIMEOUT,
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn engine_load_session(
    session_id: String,
    cwd: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    load_session_on(&state, &session_id, &cwd).await
}

#[tauri::command]
pub async fn engine_new_session(
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    state: State<'_, EngineState>,
) -> Result<String, String> {
    new_session_on(&state, &cwd, provider, model, permission_mode).await
}

/// Per-session token/cost usage, as served by the engine's
/// `_packetcode/sessions/usage` extension and attached to successful
/// `session/prompt` results under `_packetcode.usage`. Parsed defensively:
/// the engine may be newer and grow fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    #[serde(default)]
    pub context_tokens: u64,
    #[serde(default)]
    pub total_input: u64,
    #[serde(default)]
    pub total_output: u64,
    #[serde(default)]
    pub cost_usd: f64,
}

/// Outcome of one prompt turn. `usage` is present only when the engine
/// enriched the result (`_packetcode.usage`); older engines yield `None` and
/// the frontend falls back to an explicit usage query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOutcome {
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsage>,
}

pub async fn prompt_on(
    state: &EngineState,
    session_id: &str,
    text: &str,
) -> Result<PromptOutcome, String> {
    let result = bridge_of(state)
        .await?
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            PROMPT_TIMEOUT,
        )
        .await?;
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn")
        .to_string();
    // Vendor enrichment is best-effort: a malformed usage object degrades to
    // None rather than failing a turn that already completed.
    let usage = result
        .pointer("/_packetcode/usage")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    Ok(PromptOutcome { stop_reason, usage })
}

#[tauri::command]
pub async fn engine_prompt(
    session_id: String,
    text: String,
    state: State<'_, EngineState>,
) -> Result<PromptOutcome, String> {
    prompt_on(&state, &session_id, &text).await
}

/// Usage for one session via the engine's `_packetcode/sessions/usage` ACP
/// extension. Engines that predate the extension answer method-not-found;
/// that is not an error — the statusline simply has nothing to show.
pub async fn session_usage_on(
    state: &EngineState,
    session_id: &str,
) -> Result<Option<SessionUsage>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/sessions/usage",
            json!({ "sessionId": session_id }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => serde_json::from_value(result)
            .map(Some)
            .map_err(|e| format!("bad usage payload: {e}")),
        Err(err) if is_method_not_found(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn engine_session_usage(
    session_id: String,
    state: State<'_, EngineState>,
) -> Result<Option<SessionUsage>, String> {
    session_usage_on(&state, &session_id).await
}

pub async fn cancel_on(state: &EngineState, session_id: &str) -> Result<(), String> {
    bridge_of(state).await?.cancel_session(session_id).await
}

#[tauri::command]
pub async fn engine_cancel(session_id: String, state: State<'_, EngineState>) -> Result<(), String> {
    cancel_on(&state, &session_id).await
}

/// Releases a session's engine-side runtime via the spec's `session/close`.
///
/// This is what makes client-side eviction real: without it, every session the
/// user ever opened keeps a provider registry, a tool registry, a backup
/// manager, its whole transcript, and one MCP child process per configured
/// server alive inside the engine until the engine dies.
///
/// Engines predating the method answer `-32601`, which degrades to `Ok`
/// exactly like the optional vendor extensions: eviction then still frees the
/// client's copy of the transcript, and the stale engine-side runtime is
/// superseded the next time the session is loaded. `session/close` on an
/// engine that has it is idempotent, so a doubled or racing eviction is fine.
pub async fn close_session_on(state: &EngineState, session_id: &str) -> Result<(), String> {
    let response = bridge_of(state)
        .await?
        .request(
            "session/close",
            json!({ "sessionId": session_id }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(err) if is_method_not_found(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn engine_close_session(
    session_id: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    close_session_on(&state, &session_id).await
}

pub async fn permission_reply_on(
    state: &EngineState,
    request_id: &Value,
    option_id: &str,
) -> Result<(), String> {
    bridge_of(state)
        .await?
        .permission_reply(request_id, option_id)
        .await
}

#[tauri::command]
pub async fn engine_permission_reply(
    request_id: Value,
    option_id: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    permission_reply_on(&state, &request_id, &option_id).await
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
    let listed = match bridge_of(&state).await {
        Ok(bridge) => {
            bridge
                .request("_packetcode/sessions/list", json!({}), REQUEST_TIMEOUT)
                .await
        }
        Err(e) => Err(e),
    };
    match listed {
        Ok(result) => {
            let sessions = result.get("sessions").cloned().unwrap_or(json!([]));
            serde_json::from_value(sessions).map_err(|e| format!("bad sessions payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => {
            list_sessions_from_disk()
        }
        Err(err) => Err(err),
    }
}

/// Renames a persisted session via the engine's `_packetcode/sessions/rename`
/// ACP extension. Engines that predate the extension answer method-not-found;
/// that is silently ignored — titles then simply stay engine-generated.
pub async fn rename_session_on(
    state: &EngineState,
    session_id: &str,
    name: &str,
) -> Result<(), String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/sessions/rename",
            json!({ "sessionId": session_id, "name": name }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(err) if is_method_not_found(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn engine_rename_session(
    session_id: String,
    name: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    rename_session_on(&state, &session_id, &name).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub default: bool,
}

/// Provider/model choices via the engine's `_packetcode/models/list` ACP
/// extension. Engines that predate the extension answer method-not-found;
/// that is not an error — the picker simply has nothing to offer.
#[tauri::command]
pub async fn engine_list_models(
    state: State<'_, EngineState>,
) -> Result<Vec<ModelOption>, String> {
    let response = bridge_of(&state)
        .await?
        .request("_packetcode/models/list", json!({}), REQUEST_TIMEOUT)
        .await;
    match response {
        Ok(result) => {
            let models = result.get("models").cloned().unwrap_or(json!([]));
            serde_json::from_value(models).map_err(|e| format!("bad models payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

/// One invocable slash command from the engine's `_packetcode/commands/list`
/// extension. `source` is "builtin", "user", or "project"; `argumentHint` is a
/// short usage tail such as "[arguments]" and is absent for commands that take
/// none. Today's engine reports only markdown commands from
/// `~/.packetcode/commands` and `<cwd>/.packetcode/commands` — its built-in
/// slash commands are TUI affordances with no ACP equivalent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

/// Slash commands available in `cwd`, via the engine's
/// `_packetcode/commands/list` ACP extension. Engines that predate the
/// extension answer method-not-found; that is not an error — the composer's
/// "/" menu simply has nothing to offer and stops advertising itself.
pub async fn list_commands_on(
    state: &EngineState,
    cwd: &str,
) -> Result<Vec<SlashCommand>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/commands/list",
            json!({ "cwd": cwd }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => {
            let commands = result.get("commands").cloned().unwrap_or(json!([]));
            serde_json::from_value(commands).map_err(|e| format!("bad commands payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn engine_list_commands(
    cwd: String,
    state: State<'_, EngineState>,
) -> Result<Vec<SlashCommand>, String> {
    list_commands_on(&state, &cwd).await
}

/// How many @-mention candidates one search asks the engine for. The menu
/// shows a scrollable list, so this is a legibility bound rather than a
/// protocol one; the engine clamps anything larger itself.
const FILE_MENTION_LIMIT: u32 = 20;

/// Project files matching `query`, via the engine's
/// `_packetcode/project/files` ACP extension. Paths are project-relative and
/// slash-separated, ranked best-match first by the engine. Engines that
/// predate the extension answer method-not-found; that is not an error — the
/// composer's "@" menu simply has nothing to offer.
pub async fn search_files_on(
    state: &EngineState,
    cwd: &str,
    query: &str,
) -> Result<Vec<String>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/project/files",
            json!({ "cwd": cwd, "query": query, "limit": FILE_MENTION_LIMIT }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => {
            let files = result.get("files").cloned().unwrap_or(json!([]));
            serde_json::from_value(files).map_err(|e| format!("bad files payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn engine_search_files(
    cwd: String,
    query: String,
    state: State<'_, EngineState>,
) -> Result<Vec<String>, String> {
    search_files_on(&state, &cwd, &query).await
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

const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_URL: &str =
    "https://raw.githubusercontent.com/packetloss404/packetcode/main/install.ps1";

/// Runs the official packetcode install script (the documented one-liner from
/// the README), streaming its output to the webview as `engine:install_output`
/// events. Success means the engine actually resolves and passes the version
/// gate afterwards, not merely that PowerShell exited 0.
#[tauri::command]
pub async fn engine_install(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(
            "Automatic install is only available on Windows. Install packetcode with the \
             install.sh script and make sure it is on PATH, then relaunch."
                .to_string(),
        );
    }

    let url = std::env::var("PACKETCODE_GUI_INSTALL_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| INSTALL_URL.to_string());
    // Stop turns the script's non-terminating errors into a nonzero exit
    // instead of red text with exit code 0.
    let command = format!(
        "$ErrorActionPreference='Stop'; & ([scriptblock]::Create((Invoke-WebRequest {url} -UseBasicParsing).Content))"
    );
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to launch installer: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout on installer")?;
    let stderr = child.stderr.take().ok_or("no stderr on installer")?;
    let readers = [
        tauri::async_runtime::spawn(stream_install_output(app.clone(), stdout)),
        tauri::async_runtime::spawn(stream_install_output(app, stderr)),
    ];

    let status = match timeout(INSTALL_TIMEOUT, child.wait()).await {
        Err(_) => {
            kill_process_tree(&child).await;
            return Err("installer timed out".to_string());
        }
        Ok(result) => result.map_err(|e| format!("installer failed to run: {e}"))?,
    };
    // Drain the pipes so the log tail (install location, error text) is
    // delivered before we report a result. Readers end at pipe EOF.
    for reader in readers {
        let _ = timeout(Duration::from_secs(5), reader).await;
    }
    if !status.success() {
        return Err(format!("installer exited with {status}"));
    }

    // The real post-condition: the engine resolves and passes the gate.
    let probe = run_probe(&state).await?;
    if !probe.found {
        return Err(
            "The installer finished, but packetcode still was not found. It may have \
             installed to a custom location — set PACKETCODE_GUI_ENGINE to its full path."
                .to_string(),
        );
    }
    if !probe.compatible {
        return Err(format!(
            "The installer finished, but the installed packetcode ({}) is older than the \
             required {}.",
            probe.version.as_deref().unwrap_or("unknown"),
            probe.minimum_version
        ));
    }
    Ok(())
}

/// Best-effort kill of the installer and everything it spawned. kill_on_drop
/// only terminates powershell itself; Windows needs an explicit tree kill.
async fn kill_process_tree(child: &Child) {
    if !cfg!(windows) {
        return;
    }
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

async fn stream_install_output(app: AppHandle, pipe: impl tokio::io::AsyncRead + Unpin) {
    // Read raw bytes and convert lossily: PowerShell 5.1 emits OEM-codepage
    // output, and one invalid UTF-8 byte must not truncate the log.
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                let _ = app.emit("engine:install_output", line);
            }
        }
    }
}

pub async fn stop_on(state: &EngineState) -> Result<(), String> {
    if let Some(mut engine) = state.inner.lock().await.take() {
        let _ = engine.child.kill().await;
    }
    *state.capabilities.lock().await = None;
    Ok(())
}

/// How long a graceful engine shutdown may take before it is killed anyway.
/// Short on purpose: quitting the app must never appear to hang.
const ENGINE_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Stops the engine the polite way, for app exit: close its stdin so its ACP
/// loop ends normally and runs its own shutdown — every session's runtime
/// released, every MCP child process shut down — then wait briefly for it to
/// go, killing it if it will not.
///
/// This deliberately does NOT enumerate resident sessions and close them one
/// by one. End-of-input releases every session the engine holds, including any
/// this client lost track of, in one write; and it is the one path that also
/// works on engines too old for `session/close`.
///
/// Best-effort by nature. It only runs when this process gets to run code at
/// all: a window close, or an explicit stop. A crash, a `taskkill /F`, or an
/// OS-forced logoff kills the app before any of this, and `kill_on_drop` then
/// kills the engine the same abrupt way — leaving MCP grandchildren orphaned.
/// There is no client-side fix for that; do not read this as a guarantee.
pub async fn shutdown_engine_on(state: &EngineState) -> Result<(), String> {
    let engine = state.inner.lock().await.take();
    *state.capabilities.lock().await = None;
    let Some(mut engine) = engine else {
        return Ok(());
    };
    engine.bridge.close_stdin().await;
    if timeout(ENGINE_EXIT_TIMEOUT, engine.child.wait())
        .await
        .is_err()
    {
        let _ = engine.child.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    stop_on(&state).await
}

#[cfg(test)]
mod tests {
    use super::{
        new_session_params, parse_capabilities, version_at_least, PacketcodeCapabilities,
        PERMISSION_MODES,
    };
    use serde_json::{json, Value};

    fn modes(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

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

    #[test]
    fn session_params_omit_extension_when_unset() {
        let params = new_session_params("/w", None, None, None);
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
        // Blank-only overrides are treated as unset.
        let params = new_session_params("/w", Some("  ".into()), None, Some("".into()));
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
    }

    #[test]
    fn session_params_carry_packetcode_overrides() {
        let params = new_session_params(
            "/w",
            Some("anthropic".into()),
            Some("claude-fable-5".into()),
            Some("accept-edits".into()),
        );
        assert_eq!(
            params["_packetcode"],
            json!({
                "provider": "anthropic",
                "model": "claude-fable-5",
                "permissionMode": "accept-edits",
            })
        );
        // A mode alone still rides the extension object.
        let params = new_session_params("/w", None, None, Some("bypass".into()));
        assert_eq!(params["_packetcode"], json!({ "permissionMode": "bypass" }));
    }

    #[test]
    fn capabilities_from_modern_engine() {
        // A current engine started under a "read-only" ceiling: the vendor
        // block is present, so its flags are authoritative and the advertised
        // mode list is exactly what session/new will accept.
        let caps = parse_capabilities(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": false },
                "mcpCapabilities": { "http": false },
                // Advertised the spec's way: "{}" means supported.
                "sessionCapabilities": { "close": {} },
                "_packetcode": {
                    "sessionsList": true,
                    "sessionsRename": true,
                    "sessionsUsage": true,
                    "modelsList": false,
                    "permissionModes": ["ask", "read-only"],
                    "defaultPermissionMode": "read-only",
                    "somethingNewerThanThisClient": 7
                }
            },
            "agentInfo": { "name": "packetcode", "version": "0.2.0" },
            "authMethods": []
        }));
        assert_eq!(caps.protocol_version, 1);
        assert!(caps.load_session);
        assert!(caps.session_close);
        assert!(caps.packetcode.advertised);
        assert!(caps.packetcode.sessions_list);
        assert!(caps.packetcode.sessions_rename);
        assert!(caps.packetcode.sessions_usage);
        assert!(!caps.packetcode.models_list);
        assert_eq!(caps.packetcode.permission_modes, modes(&["ask", "read-only"]));
        assert_eq!(
            caps.packetcode.default_permission_mode.as_deref(),
            Some("read-only")
        );
    }

    #[test]
    fn capabilities_from_pre_capability_engine() {
        // An engine that predates the vendor block: nothing is advertised, so
        // every extension flag stays false (the call-time -32601 fallbacks
        // still apply) and all five permission modes remain on offer.
        let caps = parse_capabilities(&json!({
            "protocolVersion": 1,
            "agentCapabilities": { "loadSession": true },
            "agentInfo": { "name": "packetcode", "version": "0.1.0" }
        }));
        assert!(caps.load_session);
        // No sessionCapabilities block at all: the engine cannot release
        // sessions, so eviction frees only this client's copy.
        assert!(!caps.session_close);
        assert!(!caps.packetcode.advertised);
        assert!(!caps.packetcode.sessions_list);
        assert!(!caps.packetcode.sessions_rename);
        assert!(!caps.packetcode.sessions_usage);
        assert!(!caps.packetcode.models_list);
        assert_eq!(caps.packetcode.permission_modes, modes(&PERMISSION_MODES));
        assert_eq!(caps.packetcode.default_permission_mode, None);
        // Identical to the state used before the handshake completes.
        assert_eq!(caps.packetcode, PacketcodeCapabilities::default());
    }

    #[test]
    fn capabilities_from_garbage_are_conservative() {
        for garbage in [
            Value::Null,
            json!("not an object"),
            json!({}),
            json!({ "agentCapabilities": 42 }),
            json!({ "agentCapabilities": { "loadSession": "yes", "_packetcode": [] } }),
        ] {
            let caps = parse_capabilities(&garbage);
            assert_eq!(caps.protocol_version, 1, "for {garbage}");
            assert!(!caps.load_session, "for {garbage}");
            assert!(!caps.session_close, "for {garbage}");
            assert!(!caps.packetcode.advertised, "for {garbage}");
            assert_eq!(
                caps.packetcode.permission_modes,
                modes(&PERMISSION_MODES),
                "for {garbage}"
            );
        }

        // Vendor block present but its contents are unusable: the block still
        // counts as advertised (so the flags are authoritative and default to
        // false), while an empty/garbage mode list falls back to all five and
        // a default outside the advertised set is dropped.
        let caps = parse_capabilities(&json!({
            "agentCapabilities": {
                "_packetcode": {
                    "sessionsList": "true",
                    "permissionModes": [1, null, "  ", "ask", "ask"],
                    "defaultPermissionMode": "bypass"
                }
            }
        }));
        assert!(caps.packetcode.advertised);
        assert!(!caps.packetcode.sessions_list);
        assert_eq!(caps.packetcode.permission_modes, modes(&["ask"]));
        assert_eq!(caps.packetcode.default_permission_mode, None);

        let caps = parse_capabilities(&json!({
            "agentCapabilities": { "_packetcode": { "permissionModes": [] } }
        }));
        assert_eq!(caps.packetcode.permission_modes, modes(&PERMISSION_MODES));

        // sessionCapabilities.close is object-shaped. Only "{}" (or an object
        // with fields, since the type is open) counts; a block that omits it,
        // nulls it, or sends the boolean an ACP-naive engine might guess at is
        // not the spec's shape and must not be read as support.
        for absent in [
            json!({}),
            json!({ "close": null }),
            json!({ "close": true }),
            json!({ "close": "yes" }),
        ] {
            let caps =
                parse_capabilities(&json!({ "agentCapabilities": { "sessionCapabilities": absent } }));
            assert!(!caps.session_close, "for {absent}");
        }
        let caps = parse_capabilities(
            &json!({ "agentCapabilities": { "sessionCapabilities": { "close": {} } } }),
        );
        assert!(caps.session_close);
    }
}
