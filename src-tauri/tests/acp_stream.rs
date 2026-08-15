//! End-to-end streaming tests for the ACP bridge, driven against the mock
//! engine in `testdata/mock-engine.mjs` (spawned as `node ... acp`). These run
//! the real start/prompt/cancel/permission code paths with a test event sink
//! instead of a Tauri AppHandle; no packetcode binary is required.

use packetcode_gui_lib::engine::{
    cancel_on, capabilities_of, list_commands_on, list_mcp_servers_on, load_session_on,
    new_session_on, permission_reply_on, prompt_on, rename_session_on, search_files_on,
    session_usage_on, start_engine, stop_on, AcpEvents, EngineState, McpServerStatus,
    PromptOutcome, SessionUsage, PERMISSION_MODES,
};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

/// Every await in these tests is bounded: a regression that wedges the
/// reader or deadlocks a reply should fail fast, not hang the suite.
const STEP: Duration = Duration::from_secs(10);

#[derive(Debug)]
enum Event {
    Update(Value),
    Permission(Value),
}

struct TestSink {
    tx: mpsc::UnboundedSender<Event>,
}

impl AcpEvents for TestSink {
    fn on_update(&self, params: Value) {
        let _ = self.tx.send(Event::Update(params));
    }
    fn on_permission_request(&self, payload: Value) {
        let _ = self.tx.send(Event::Permission(payload));
    }
}

fn mock_engine_path() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("mock-engine.mjs");
    assert!(path.is_file(), "mock engine missing at {}", path.display());
    path.to_string_lossy().to_string()
}

async fn start_mock() -> (Arc<EngineState>, mpsc::UnboundedReceiver<Event>) {
    start_mock_with(&[]).await
}

async fn start_mock_with(
    extra_args: &[&str],
) -> (Arc<EngineState>, mpsc::UnboundedReceiver<Event>) {
    let state = Arc::new(EngineState::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let mock = mock_engine_path();
    let mut args = vec![mock.as_str(), "acp"];
    args.extend_from_slice(extra_args);
    timeout(
        STEP,
        start_engine(&state, "node", &args, Arc::new(TestSink { tx })),
    )
    .await
    .expect("start_engine timed out")
    .expect("start_engine failed");
    (state, rx)
}

/// The usage values baked into the mock engine's scripted responses.
fn mock_usage() -> SessionUsage {
    SessionUsage {
        context_tokens: 41234,
        total_input: 82000,
        total_output: 12000,
        cost_usd: 1.84,
    }
}

async fn next_event(rx: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    timeout(STEP, rx.recv())
        .await
        .expect("timed out waiting for an event")
        .expect("event channel closed")
}

async fn next_update(rx: &mut mpsc::UnboundedReceiver<Event>) -> Value {
    match next_event(rx).await {
        Event::Update(v) => v,
        other => panic!("expected session/update, got {other:?}"),
    }
}

async fn next_permission(rx: &mut mpsc::UnboundedReceiver<Event>) -> Value {
    match next_event(rx).await {
        Event::Permission(v) => v,
        other => panic!("expected permission request, got {other:?}"),
    }
}

fn kind(update: &Value) -> &str {
    update
        .pointer("/update/sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("?")
}

fn chunk_text(update: &Value) -> &str {
    update
        .pointer("/update/content/text")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn tool_status(update: &Value) -> &str {
    update
        .pointer("/update/status")
        .and_then(Value::as_str)
        .unwrap_or("?")
}

/// Runs a prompt turn concurrently and returns its JoinHandle so the test can
/// drive events (permission replies, cancel) while the prompt is in flight.
fn spawn_prompt(
    state: &Arc<EngineState>,
    session_id: &str,
    text: &str,
) -> tokio::task::JoinHandle<Result<PromptOutcome, String>> {
    let state = state.clone();
    let session_id = session_id.to_string();
    let text = text.to_string();
    tokio::spawn(async move { prompt_on(&state, &session_id, &text).await })
}

/// Drains the standard scripted sequence up to (excluding) the permission
/// request, asserting exact order and content.
async fn expect_streamed_prefix(rx: &mut mpsc::UnboundedReceiver<Event>, session_id: &str) {
    let u = next_update(rx).await;
    assert_eq!(u.get("sessionId").and_then(Value::as_str), Some(session_id));
    assert_eq!(kind(&u), "agent_thought_chunk");
    assert_eq!(chunk_text(&u), "Thinking about the task.");

    for expected in ["Hello, ", "streaming ", "world."] {
        let u = next_update(rx).await;
        assert_eq!(kind(&u), "agent_message_chunk");
        assert_eq!(chunk_text(&u), expected);
    }

    let u = next_update(rx).await;
    assert_eq!(kind(&u), "plan");
    assert_eq!(
        u.pointer("/update/entries").and_then(Value::as_array).map(Vec::len),
        Some(2)
    );

    let u = next_update(rx).await;
    assert_eq!(kind(&u), "tool_call");
    assert_eq!(tool_status(&u), "pending");
    assert_eq!(
        u.pointer("/update/toolCallId").and_then(Value::as_str),
        Some("call-1")
    );

    let u = next_update(rx).await;
    assert_eq!(kind(&u), "tool_call_update");
    assert_eq!(tool_status(&u), "in_progress");

    let u = next_update(rx).await;
    assert_eq!(kind(&u), "tool_call_update");
    assert_eq!(tool_status(&u), "completed");
    assert_eq!(
        u.pointer("/update/content/0/content/text").and_then(Value::as_str),
        Some("demo tool output")
    );
}

fn permission_request_id(payload: &Value) -> Value {
    let id = payload
        .get("requestId")
        .expect("permission payload carries requestId")
        .clone();
    // The real engine uses string ids ("packetcode-permission-N"); the bridge
    // must carry them verbatim, not coerce or drop them.
    assert!(id.is_string(), "request id should be a string, got {id}");
    id
}

#[tokio::test]
async fn happy_path_streams_events_in_order() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .expect("session/new");
    assert!(session.starts_with("sess-"), "unexpected session id {session}");

    let turn = spawn_prompt(&state, &session, "run the demo");
    expect_streamed_prefix(&mut rx, &session).await;

    let perm = next_permission(&mut rx).await;
    assert_eq!(perm.get("sessionId").and_then(Value::as_str), Some(session.as_str()));
    assert!(perm.pointer("/options/0/optionId").is_some());
    let request_id = permission_request_id(&perm);

    // The KNOWN-BUG regression check: this reply must go through while the
    // prompt request is still in flight. With the old code (state mutex held
    // across the prompt await) this deadlocked until the prompt timeout.
    timeout(STEP, permission_reply_on(&state, &request_id, "allow_once"))
        .await
        .expect("permission reply deadlocked while prompt was in flight")
        .expect("permission reply failed");

    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_message_chunk");
    assert_eq!(chunk_text(&u), "Permission granted, continuing.");

    let outcome = timeout(STEP, turn)
        .await
        .expect("prompt did not finish")
        .expect("prompt task panicked")
        .expect("prompt failed");
    assert_eq!(outcome.stop_reason, "end_turn");
    // The engine enriches successful turns with usage; the bridge surfaces it.
    assert_eq!(outcome.usage, Some(mock_usage()));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn permission_reject_fails_tool_and_ends_turn() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    let turn = spawn_prompt(&state, &session, "run the demo");
    expect_streamed_prefix(&mut rx, &session).await;

    let perm = next_permission(&mut rx).await;
    let request_id = permission_request_id(&perm);
    timeout(STEP, permission_reply_on(&state, &request_id, "reject_once"))
        .await
        .expect("permission reply deadlocked")
        .expect("permission reply failed");

    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "tool_call_update");
    assert_eq!(tool_status(&u), "failed");

    let outcome = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome.stop_reason, "end_turn");

    // Answering the same request twice must fail cleanly.
    let err = permission_reply_on(&state, &request_id, "allow_once")
        .await
        .expect_err("second reply to the same request should fail");
    assert!(err.contains("no pending permission request"), "got: {err}");

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn cancel_mid_prompt_yields_cancelled_and_rejects_late_permission_reply() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    let turn = spawn_prompt(&state, &session, "slow demo");
    expect_streamed_prefix(&mut rx, &session).await;
    let perm = next_permission(&mut rx).await;
    let request_id = permission_request_id(&perm);

    // Cancel while the prompt is blocked on the (unanswered) permission
    // request — the cancel notification must go out despite the in-flight
    // prompt, and the turn must come back with stopReason "cancelled".
    timeout(STEP, cancel_on(&state, &session))
        .await
        .expect("cancel deadlocked while prompt was in flight")
        .expect("cancel failed");

    let outcome = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome.stop_reason, "cancelled");
    // Cancelled turns are not enriched.
    assert_eq!(outcome.usage, None);

    // The permission request was answered "cancelled" on our side; a late
    // user reply must be rejected instead of double-answering the agent.
    let err = permission_reply_on(&state, &request_id, "allow_once")
        .await
        .expect_err("late permission reply after cancel should be rejected");
    assert!(err.contains("no pending permission request"), "got: {err}");

    // The engine and reader are still healthy: a fresh turn runs to end_turn.
    let session2 = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    let turn2 = spawn_prompt(&state, &session2, "run the demo");
    expect_streamed_prefix(&mut rx, &session2).await;
    let perm2 = next_permission(&mut rx).await;
    permission_reply_on(&state, &permission_request_id(&perm2), "allow_once")
        .await
        .unwrap();
    let u = next_update(&mut rx).await;
    assert_eq!(chunk_text(&u), "Permission granted, continuing.");
    let outcome2 = timeout(STEP, turn2).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome2.stop_reason, "end_turn");

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn cancel_during_streaming_chunks_yields_cancelled() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    let turn = spawn_prompt(&state, &session, "slow demo");

    // Cancel as soon as the first streamed chunk arrives, mid-sequence.
    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_thought_chunk");
    timeout(STEP, cancel_on(&state, &session))
        .await
        .expect("cancel deadlocked")
        .expect("cancel failed");

    let outcome = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome.stop_reason, "cancelled");

    // Anything already in flight when the cancel landed is fine; the session
    // must still accept new turns afterwards.
    let session2 = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    assert!(session2.starts_with("sess-"));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn malformed_and_interleaved_lines_do_not_wedge_the_reader() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    // "garbage" makes the mock interleave non-JSON, truncated JSON, a
    // response to an id we never sent, and an unknown notification between
    // message chunks, then finish end_turn without a permission step.
    let turn = spawn_prompt(&state, &session, "garbage");

    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_thought_chunk");
    for expected in ["Hello, ", "streaming ", "world."] {
        let u = next_update(&mut rx).await;
        assert_eq!(kind(&u), "agent_message_chunk");
        assert_eq!(chunk_text(&u), expected);
    }

    let outcome = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome.stop_reason, "end_turn");

    // Reader is still routing traffic after the garbage.
    let session2 = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    assert!(session2.starts_with("sess-"));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn rename_on_engine_without_extension_is_silently_skipped() {
    // The mock engine answers -32601 for `_packetcode/sessions/rename`, the
    // same as a real engine that predates the extension. The bridge must treat
    // that as success so auto-titling never surfaces errors on old engines.
    let (state, _rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    timeout(STEP, rename_session_on(&state, &session, "My first prompt"))
        .await
        .expect("rename timed out")
        .expect("rename against an old engine should silently succeed");
    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn session_usage_query_returns_engine_values() {
    let (state, _rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    let usage = timeout(STEP, session_usage_on(&state, &session))
        .await
        .expect("usage query timed out")
        .expect("usage query failed");
    assert_eq!(usage, Some(mock_usage()));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn session_usage_is_none_on_engines_without_the_extension() {
    let (state, mut rx) = start_mock_with(&["--no-usage"]).await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    // Method-not-found maps to None (feature absent), not an error.
    let usage = timeout(STEP, session_usage_on(&state, &session))
        .await
        .expect("usage query timed out")
        .expect("usage query should not error on -32601");
    assert_eq!(usage, None);

    // Prompt results from such engines carry no usage either.
    let turn = spawn_prompt(&state, &session, "garbage");
    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_thought_chunk");
    for _ in 0..3 {
        next_update(&mut rx).await;
    }
    let outcome = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome.stop_reason, "end_turn");
    assert_eq!(outcome.usage, None);

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn capabilities_of_engine_without_vendor_block_stay_permissive() {
    // The default mock advertises no agentCapabilities._packetcode, like an
    // engine predating capability negotiation. Nothing may be reported as
    // "advertised" (the call-time -32601 fallbacks still decide), and every
    // permission mode must stay on offer so the picker does not shrink.
    let (state, _rx) = start_mock().await;
    let caps = capabilities_of(&state).await;

    assert!(!caps.packetcode.advertised);
    assert!(!caps.packetcode.sessions_list);
    assert!(!caps.packetcode.sessions_rename);
    assert!(!caps.packetcode.sessions_usage);
    assert!(!caps.packetcode.models_list);
    assert_eq!(caps.packetcode.permission_modes, PERMISSION_MODES.to_vec());
    assert_eq!(caps.packetcode.default_permission_mode, None);
    assert!(!caps.load_session);
    assert_eq!(caps.protocol_version, 1);

    // Stopping the engine drops them back to the same conservative state.
    stop_on(&state).await.unwrap();
    assert_eq!(capabilities_of(&state).await, Default::default());
}

#[tokio::test]
async fn restricted_capabilities_are_surfaced_from_the_handshake() {
    // --restricted-caps advertises a trimmed permission-mode list and a mix of
    // extension flags, the shape a real engine sends under an operator
    // ceiling. The bridge must retain the initialize result rather than
    // discarding it, so the UI never offers a mode session/new would reject.
    let (state, _rx) = start_mock_with(&["--restricted-caps"]).await;
    let caps = capabilities_of(&state).await;

    assert!(caps.packetcode.advertised);
    assert!(caps.packetcode.sessions_list);
    assert!(!caps.packetcode.sessions_rename);
    assert!(caps.packetcode.sessions_usage);
    assert!(!caps.packetcode.models_list);
    assert_eq!(
        caps.packetcode.permission_modes,
        vec!["ask".to_string(), "read-only".to_string()]
    );
    assert_eq!(
        caps.packetcode.default_permission_mode.as_deref(),
        Some("read-only")
    );
    assert!(caps.load_session);

    // The advertised flags agree with what the engine actually serves: usage
    // is on, and rename is one of the methods that still answers -32601.
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    let usage = timeout(STEP, session_usage_on(&state, &session))
        .await
        .expect("usage query timed out")
        .expect("usage query failed");
    assert_eq!(usage, Some(mock_usage()));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn restricted_capabilities_reflect_a_disabled_usage_extension() {
    // Flags compose: --restricted-caps with --no-usage must advertise
    // sessionsUsage false AND answer -32601, so the frontend can skip the
    // query instead of learning from the error.
    let (state, _rx) = start_mock_with(&["--restricted-caps", "--no-usage"]).await;
    let caps = capabilities_of(&state).await;
    assert!(caps.packetcode.advertised);
    assert!(!caps.packetcode.sessions_usage);

    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    let usage = timeout(STEP, session_usage_on(&state, &session))
        .await
        .expect("usage query timed out")
        .expect("usage query should not error on -32601");
    assert_eq!(usage, None);

    stop_on(&state).await.unwrap();
}

/// Names of the servers a session actually runs, for readable assertions.
fn names(servers: &[McpServerStatus]) -> Vec<&str> {
    servers.iter().map(|s| s.name.as_str()).collect()
}

async fn fleet_of(state: &EngineState, session: &str) -> Vec<McpServerStatus> {
    timeout(STEP, list_mcp_servers_on(state, Some(session)))
        .await
        .expect("mcp list timed out")
        .expect("mcp list failed")
}

/// The disclosure surface: the configured servers are readable with NO session
/// id, so the app can show the user what would start — name AND command —
/// before anything has been spawned. That query is the whole reason consent
/// can be asked for in advance rather than announced after the fact.
#[tokio::test]
async fn configured_mcp_servers_are_readable_before_any_session_exists() {
    let (state, _rx) = start_mock_with(&["--mcp", "--mcp-defaults"]).await;
    let caps = capabilities_of(&state).await;
    assert!(caps.packetcode.mcp_list);
    assert!(caps.packetcode.mcp_defaults);

    let configured = timeout(STEP, list_mcp_servers_on(&state, None))
        .await
        .expect("mcp list timed out")
        .expect("mcp list failed");
    assert_eq!(names(&configured), vec!["github", "broken", "muted"]);
    // The command is the load-bearing disclosure: it is the local subprocess
    // the user is being asked to authorize.
    assert_eq!(configured[0].command, "gh-mcp");
    assert_eq!(configured[2].status, "disabled");

    stop_on(&state).await.unwrap();
}

/// With consent, session/new and session/load omit mcpServers and the session
/// runs the engine's own fleet — reported live, with tool counts and the
/// failure a configuration-only view cannot know about.
#[tokio::test]
async fn consented_sessions_inherit_the_engines_mcp_fleet() {
    let (state, _rx) = start_mock_with(&["--mcp", "--mcp-defaults"]).await;
    let session = new_session_on(&state, ".", None, None, None, true)
        .await
        .unwrap();

    let live = fleet_of(&state, &session).await;
    assert_eq!(names(&live), vec!["github", "broken", "muted"]);
    let github = live.iter().find(|s| s.name == "github").unwrap();
    assert_eq!(github.status, "running");
    assert_eq!(github.tool_count, 7);
    assert_eq!(github.source, "agent");
    let broken = live.iter().find(|s| s.name == "broken").unwrap();
    assert_eq!(broken.status, "failed");
    assert_eq!(broken.error, "exec: not found");

    // Resuming must not silently drop the fleet.
    load_session_on(&state, &session, ".", true).await.unwrap();
    assert_eq!(names(&fleet_of(&state, &session).await).len(), 3);

    stop_on(&state).await.unwrap();
}

/// The default, and the state the app stays in until the user says otherwise:
/// mcpServers travels as an explicit `[]`, so not one configured server is
/// started. The engine has a fleet on offer and the session still runs none.
#[tokio::test]
async fn sessions_without_consent_start_no_mcp_servers() {
    let (state, _rx) = start_mock_with(&["--mcp", "--mcp-defaults"]).await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    assert!(fleet_of(&state, &session).await.is_empty());

    load_session_on(&state, &session, ".", false).await.unwrap();
    assert!(fleet_of(&state, &session).await.is_empty());

    // The engine's configured list is still readable — that is what makes the
    // choice reversible: the app can show what is on offer while running none.
    let configured = timeout(STEP, list_mcp_servers_on(&state, None))
        .await
        .expect("mcp list timed out")
        .expect("mcp list failed");
    assert_eq!(configured.len(), 3);

    stop_on(&state).await.unwrap();
}

/// Consent alone is not enough. An engine that never advertised `mcpDefaults`
/// treats a missing mcpServers as invalid-params (the mock answers -32602),
/// so the bridge must intersect the user's choice with the capability and keep
/// sending `[]` — an opted-in user on an old engine gets a working session
/// with no MCP, not a session/new that fails outright.
#[tokio::test]
async fn consent_cannot_omit_mcp_servers_on_an_engine_that_never_promised_it() {
    let (state, _rx) = start_mock_with(&["--mcp"]).await;
    let caps = capabilities_of(&state).await;
    assert!(caps.packetcode.mcp_list);
    assert!(!caps.packetcode.mcp_defaults);

    let session = new_session_on(&state, ".", None, None, None, true)
        .await
        .expect("session/new must not fail because the user opted in");
    assert!(fleet_of(&state, &session).await.is_empty());

    load_session_on(&state, &session, ".", true)
        .await
        .expect("session/load must not fail because the user opted in");

    stop_on(&state).await.unwrap();
}

/// Engines predating `_packetcode/mcp/list` answer method-not-found; that is
/// "nothing to show", not an error — the chip and the consent prompt simply
/// never appear.
#[tokio::test]
async fn mcp_list_is_empty_on_engines_without_the_extension() {
    let (state, _rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    assert!(timeout(STEP, list_mcp_servers_on(&state, None))
        .await
        .expect("mcp list timed out")
        .expect("method-not-found must not surface as an error")
        .is_empty());
    assert!(fleet_of(&state, &session).await.is_empty());

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn engine_death_fails_pending_prompt_promptly() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();

    let turn = spawn_prompt(&state, &session, "slow demo");
    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_thought_chunk");

    // Kill the engine out from under the in-flight prompt. The prompt must
    // fail promptly (reader EOF fails pending requests) instead of sitting
    // out the one-hour prompt timeout.
    stop_on(&state).await.unwrap();
    let result = timeout(STEP, turn)
        .await
        .expect("prompt hung after engine death")
        .expect("prompt task panicked");
    let err = result.expect_err("prompt should fail when the engine dies");
    assert!(
        err.contains("engine closed"),
        "unexpected error after engine death: {err}"
    );
}

#[tokio::test]
async fn concurrent_sessions_stream_independently_and_cancel_is_scoped() {
    // The premise the GUI's concurrent-sessions model rests on: one connection
    // carries two live turns at once, and cancelling one must not disturb the
    // other — including the other's UNANSWERED permission request, which the
    // user may still be on their way back to answer.
    let (state, mut rx) = start_mock().await;
    let a = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    let b = new_session_on(&state, ".", None, None, None, false)
        .await
        .unwrap();
    assert_ne!(a, b);

    let turn_a = spawn_prompt(&state, &a, "slow demo");
    let turn_b = spawn_prompt(&state, &b, "slow demo");

    // Both turns progress interleaved on the one transport until each blocks
    // on its own permission request.
    let mut perm_a: Option<Value> = None;
    let mut perm_b: Option<Value> = None;
    while perm_a.is_none() || perm_b.is_none() {
        if let Event::Permission(payload) = next_event(&mut rx).await {
            let session = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if session == a {
                perm_a = Some(payload);
            } else if session == b {
                perm_b = Some(payload);
            } else {
                panic!("permission for an unknown session {session}");
            }
        }
    }
    let id_a = permission_request_id(&perm_a.expect("permission for session a"));
    let id_b = permission_request_id(&perm_b.expect("permission for session b"));
    assert_ne!(id_a, id_b);

    // Cancel A only.
    timeout(STEP, cancel_on(&state, &a))
        .await
        .expect("cancel deadlocked")
        .expect("cancel failed");
    let outcome_a = timeout(STEP, turn_a).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome_a.stop_reason, "cancelled");
    // A's request was answered "cancelled" on our side; a late reply fails.
    let err = permission_reply_on(&state, &id_a, "allow_once")
        .await
        .expect_err("late reply to the cancelled session should fail");
    assert!(err.contains("no pending permission request"), "got: {err}");

    // B was never touched: its request is still pending and still answerable,
    // and answering it carries the turn to completion.
    timeout(STEP, permission_reply_on(&state, &id_b, "allow_once"))
        .await
        .expect("reply to the untouched session deadlocked")
        .expect("reply to the untouched session was dropped by the cancel");
    let outcome_b = timeout(STEP, turn_b).await.unwrap().unwrap().unwrap();
    assert_eq!(outcome_b.stop_reason, "end_turn");
    assert_eq!(outcome_b.usage, Some(mock_usage()));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn composer_affordances_query_engine_catalogs() {
    let (state, _rx) = start_mock().await;

    let commands = timeout(STEP, list_commands_on(&state, "/proj/gui"))
        .await
        .expect("commands/list timed out")
        .expect("commands/list should succeed");
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].name, "audit");
    assert_eq!(commands[0].source, "user");
    // A command with no $ARGUMENTS placeholder carries no hint.
    assert_eq!(commands[0].argument_hint, None);
    assert_eq!(commands[1].name, "deploy");
    assert_eq!(commands[1].argument_hint.as_deref(), Some("[arguments]"));

    let files = timeout(STEP, search_files_on(&state, "/proj/gui", "compo"))
        .await
        .expect("project/files timed out")
        .expect("project/files should succeed");
    assert_eq!(files, vec!["src/App.tsx", "src/components/Composer.tsx"]);

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn composer_affordances_are_empty_on_engines_without_the_extensions() {
    // Method-not-found means "this engine is older", not an error: the / and @
    // menus must simply have nothing to offer so the composer can drop the
    // promises from its placeholder.
    let (state, _rx) = start_mock_with(&["--no-affordances"]).await;

    let commands = timeout(STEP, list_commands_on(&state, "/proj/gui"))
        .await
        .expect("commands/list timed out")
        .expect("commands/list should not error on -32601");
    assert!(commands.is_empty(), "expected no commands, got {commands:?}");

    let files = timeout(STEP, search_files_on(&state, "/proj/gui", "compo"))
        .await
        .expect("project/files timed out")
        .expect("project/files should not error on -32601");
    assert!(files.is_empty(), "expected no files, got {files:?}");

    stop_on(&state).await.unwrap();
}
