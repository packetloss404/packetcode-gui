//! End-to-end streaming tests for the ACP bridge, driven against the mock
//! engine in `testdata/mock-engine.mjs` (spawned as `node ... acp`). These run
//! the real start/prompt/cancel/permission code paths with a test event sink
//! instead of a Tauri AppHandle; no packetcode binary is required.

use packetcode_gui_lib::engine::{
    cancel_on, new_session_on, permission_reply_on, prompt_on, start_engine, stop_on, AcpEvents,
    EngineState,
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
    let state = Arc::new(EngineState::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let mock = mock_engine_path();
    timeout(
        STEP,
        start_engine(&state, "node", &[&mock, "acp"], Arc::new(TestSink { tx })),
    )
    .await
    .expect("start_engine timed out")
    .expect("start_engine failed");
    (state, rx)
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
) -> tokio::task::JoinHandle<Result<String, String>> {
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
    let session = new_session_on(&state, ".", None, None).await.expect("session/new");
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

    let stop = timeout(STEP, turn)
        .await
        .expect("prompt did not finish")
        .expect("prompt task panicked")
        .expect("prompt failed");
    assert_eq!(stop, "end_turn");

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn permission_reject_fails_tool_and_ends_turn() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None).await.unwrap();

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

    let stop = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(stop, "end_turn");

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
    let session = new_session_on(&state, ".", None, None).await.unwrap();

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

    let stop = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(stop, "cancelled");

    // The permission request was answered "cancelled" on our side; a late
    // user reply must be rejected instead of double-answering the agent.
    let err = permission_reply_on(&state, &request_id, "allow_once")
        .await
        .expect_err("late permission reply after cancel should be rejected");
    assert!(err.contains("no pending permission request"), "got: {err}");

    // The engine and reader are still healthy: a fresh turn runs to end_turn.
    let session2 = new_session_on(&state, ".", None, None).await.unwrap();
    let turn2 = spawn_prompt(&state, &session2, "run the demo");
    expect_streamed_prefix(&mut rx, &session2).await;
    let perm2 = next_permission(&mut rx).await;
    permission_reply_on(&state, &permission_request_id(&perm2), "allow_once")
        .await
        .unwrap();
    let u = next_update(&mut rx).await;
    assert_eq!(chunk_text(&u), "Permission granted, continuing.");
    let stop2 = timeout(STEP, turn2).await.unwrap().unwrap().unwrap();
    assert_eq!(stop2, "end_turn");

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn cancel_during_streaming_chunks_yields_cancelled() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None).await.unwrap();

    let turn = spawn_prompt(&state, &session, "slow demo");

    // Cancel as soon as the first streamed chunk arrives, mid-sequence.
    let u = next_update(&mut rx).await;
    assert_eq!(kind(&u), "agent_thought_chunk");
    timeout(STEP, cancel_on(&state, &session))
        .await
        .expect("cancel deadlocked")
        .expect("cancel failed");

    let stop = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(stop, "cancelled");

    // Anything already in flight when the cancel landed is fine; the session
    // must still accept new turns afterwards.
    let session2 = new_session_on(&state, ".", None, None).await.unwrap();
    assert!(session2.starts_with("sess-"));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn malformed_and_interleaved_lines_do_not_wedge_the_reader() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None).await.unwrap();

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

    let stop = timeout(STEP, turn).await.unwrap().unwrap().unwrap();
    assert_eq!(stop, "end_turn");

    // Reader is still routing traffic after the garbage.
    let session2 = new_session_on(&state, ".", None, None).await.unwrap();
    assert!(session2.starts_with("sess-"));

    stop_on(&state).await.unwrap();
}

#[tokio::test]
async fn engine_death_fails_pending_prompt_promptly() {
    let (state, mut rx) = start_mock().await;
    let session = new_session_on(&state, ".", None, None).await.unwrap();

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
