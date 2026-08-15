#!/usr/bin/env node
// Mock packetcode engine for integration tests. No dependencies.
//
//   node mock-engine.mjs doctor --json   -> prints a doctor report and exits
//   node mock-engine.mjs acp             -> speaks ACP v1 (NDJSON JSON-RPC 2.0)
//                                           on stdin/stdout
//
// On session/prompt it streams a deterministic scripted sequence of
// session/update notifications, raises a session/request_permission request
// and waits for the client's answer, and handles session/cancel by finishing
// the in-flight prompt with stopReason "cancelled".
//
// Prompt text selects a scenario:
//   contains "slow"    -> longer inter-step delays (gives the client room to
//                         cancel mid-stream deterministically)
//   contains "garbage" -> interleaves malformed / unknown lines between
//                         chunks, then ends end_turn (no permission step)
//   anything else      -> full happy-path sequence with permission gate

import readline from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  process.stdout.write(
    JSON.stringify({ schema_version: 1, status: "ok", version: "0.1.0" }) + "\n"
  );
  process.exit(0);
}

if (args[0] !== "acp") {
  process.stderr.write("usage: mock-engine.mjs <doctor --json | acp>\n");
  process.exit(2);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sendRaw = (line) => process.stdout.write(line + "\n");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextServerId = 1000; // ids for agent->client requests
let sessionCounter = 0;
/** id -> resolve(fn) for agent->client requests awaiting a response */
const awaitingResponse = new Map();
/** the single in-flight prompt, or null */
let inflight = null;

function update(sessionId, upd) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: upd },
  });
}

function requestPermission(sessionId, toolCallId) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    awaitingResponse.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });
}

async function handlePrompt(id, params) {
  const sessionId = params?.sessionId ?? "unknown";
  const text = (params?.prompt ?? [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("");

  const state = { cancelled: false, fireCancel: null };
  const cancelPromise = new Promise((r) => {
    state.fireCancel = r;
  });
  inflight = { state };

  const finish = (stopReason) => {
    inflight = null;
    send({ jsonrpc: "2.0", id, result: { stopReason } });
  };

  const D = text.includes("slow") ? 40 : 10;
  // Await one step delay; returns true if the prompt was cancelled meanwhile.
  const step = async () => {
    await Promise.race([delay(D), cancelPromise]);
    return state.cancelled;
  };

  const garbage = text.includes("garbage");

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Thinking about the task." },
  });

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello, " },
  });

  if (garbage) {
    // Lines the client reader must survive without wedging.
    sendRaw("this is not json at all");
    sendRaw('{"jsonrpc":"2.0"'); // truncated JSON
    send({ jsonrpc: "2.0", id: 424242, result: {} }); // response to unknown id
    send({ jsonrpc: "2.0", method: "mock/unknown_notification", params: { x: 1 } });
    send({ jsonrpc: "2.0" }); // valid JSON, meaningless frame
  }

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "streaming " },
  });

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "world." },
  });

  if (garbage) {
    // Short scenario: prove ordinary completion after malformed lines.
    if (await step()) return finish("cancelled");
    return finish("end_turn");
  }

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "Inspect the request", priority: "high", status: "completed" },
      { content: "Run the demo tool", priority: "medium", status: "in_progress" },
    ],
  });

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Demo tool",
    kind: "execute",
    status: "pending",
  });

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "in_progress",
  });

  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "demo tool output" } },
    ],
  });

  if (await step()) return finish("cancelled");
  const answer = await Promise.race([
    requestPermission(sessionId, "call-1"),
    cancelPromise,
  ]);
  if (state.cancelled) return finish("cancelled");

  const outcome = answer?.outcome;
  if (outcome?.outcome === "selected" && outcome?.optionId === "allow") {
    if (await step()) return finish("cancelled");
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Permission granted, continuing." },
    });
    if (await step()) return finish("cancelled");
    return finish("end_turn");
  }

  // Rejected (or a cancelled outcome without session/cancel): fail the tool.
  if (await step()) return finish("cancelled");
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "failed",
  });
  if (await step()) return finish("cancelled");
  return finish("end_turn");
}

function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // clients must not be able to wedge the mock either
  }

  const { id, method, params } = msg;

  if (method === undefined) {
    // A response to one of our agent->client requests.
    const resolve = awaitingResponse.get(id);
    if (resolve) {
      awaitingResponse.delete(id);
      resolve(msg.error ? { error: msg.error } : msg.result);
    }
    // Unknown/late responses (e.g. permission replies after cancel): ignored.
    return;
  }

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          agentInfo: { name: "mock", version: "0.1.0" },
        },
      });
      break;
    case "session/new":
      sessionCounter += 1;
      send({ jsonrpc: "2.0", id, result: { sessionId: `sess-${sessionCounter}` } });
      break;
    case "session/prompt":
      handlePrompt(id, params);
      break;
    case "session/cancel":
      // Notification: cancel the in-flight prompt, if any.
      if (inflight) {
        inflight.state.cancelled = true;
        inflight.state.fireCancel(undefined);
      }
      break;
    default:
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
      break;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", handleLine);
rl.on("close", () => process.exit(0));
