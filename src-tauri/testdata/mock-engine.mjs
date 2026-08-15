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
//   contains "abandon" -> raises the permission request and then ends the turn
//                         WITHOUT waiting for an answer, the way a real turn
//                         aborted by an agent-side context cancel or an
//                         internal error leaves the client holding a request
//                         that will never be answered
//   anything else      -> full happy-path sequence with permission gate

import readline from "node:readline";
import fs from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  process.stdout.write(
    JSON.stringify({ schema_version: 1, status: "ok", version: "0.1.0" }) + "\n"
  );
  process.exit(0);
}

if (args[0] !== "acp") {
  process.stderr.write(
    "usage: mock-engine.mjs <doctor --json | acp> [--no-usage] [--no-affordances] " +
      "[--restricted-caps] [--shutdown-marker=PATH] [--ignore-stdin-close]\n"
  );
  process.exit(2);
}

// --shutdown-marker=PATH writes PATH when stdin closes, before exiting. The
// real engine only releases sessions (Runtime.Close, and the MCP children
// those sessions spawned) once its stdin scanner returns — see
// internal/acp/server.go `Serve`/`shutdown`. The marker is how a test tells a
// graceful stop, which lets that code run, from a kill, which does not.
const shutdownMarker = (args.find((a) => a.startsWith("--shutdown-marker=")) ?? "")
  .slice("--shutdown-marker=".length);
// --ignore-stdin-close simulates an engine wedged in its own shutdown: stdin
// EOF is observed and then ignored, so the client's graceful stop has to time
// out and escalate to killing the process.
const ignoreStdinClose = args.includes("--ignore-stdin-close");

// --no-usage simulates an engine predating the _packetcode/sessions/usage
// extension: the method answers -32601 and prompt results stay bare.
const noUsage = args.includes("--no-usage");
// --no-affordances simulates an engine predating _packetcode/commands/list
// and _packetcode/project/files: both answer -32601, so the composer's / and
// @ menus have nothing to offer.
const noAffordances = args.includes("--no-affordances");
// Static catalog and file list served by those extensions. The file list is
// returned unfiltered on purpose — the engine owns ranking, the client just
// displays what it is handed.
const slashCommands = [
  { name: "audit", description: "Security-review the diff", source: "user" },
  {
    name: "deploy",
    description: "Ship to an environment",
    source: "project",
    argumentHint: "[arguments]",
  },
];
const projectFiles = ["src/App.tsx", "src/components/Composer.tsx"];
// --restricted-caps simulates a current engine started under a permission
// ceiling and with some extensions switched off: initialize carries an
// agentCapabilities._packetcode block advertising a trimmed mode list and a
// mix of extension flags. Without the flag the mock advertises no vendor
// block at all, exactly like an engine predating capability negotiation.
const restrictedCaps = args.includes("--restricted-caps");
// Static usage served by the extension and attached to end_turn prompt
// results, mirroring the real engine's enrichment.
const sessionUsage = {
  contextTokens: 41234,
  totalInput: 82000,
  totalOutput: 12000,
  costUsd: 1.84,
};

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sendRaw = (line) => process.stdout.write(line + "\n");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The real engine uses STRING ids for agent->client requests
// ("packetcode-permission-N", internal/acp/server.go); match that framing so
// tests certify what production actually sends.
let nextServerId = 0;
const serverRequestId = () => `packetcode-permission-${++nextServerId}`;
let sessionCounter = 0;
/** id -> resolve(fn) for agent->client requests awaiting a response */
const awaitingResponse = new Map();
/** sessionId -> in-flight prompt state. The real engine runs one turn per
 * session but many sessions at once (internal/acp/server.go keeps per-session
 * state and an `active` flag), so cancel must be scoped by session id. */
const inflight = new Map();

function update(sessionId, upd) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: upd },
  });
}

function requestPermission(sessionId, toolCallId) {
  const id = serverRequestId();
  return new Promise((resolve) => {
    awaitingResponse.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId },
        // Option ids match the real server: allow_once / reject_once.
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
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
  inflight.set(sessionId, state);

  const finish = (stopReason) => {
    inflight.delete(sessionId);
    const result = { stopReason };
    // Match the real engine: only successful turns carry usage enrichment.
    if (!noUsage && stopReason === "end_turn") {
      result._packetcode = { usage: sessionUsage };
    }
    send({ jsonrpc: "2.0", id, result });
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

  if (text.includes("abandon")) {
    // Raise the request, then end the turn without ever answering it. The
    // client must reap the orphaned waiter when the prompt resolves.
    requestPermission(sessionId, "call-1");
    if (await step()) return finish("cancelled");
    return finish("end_turn");
  }

  const answer = await Promise.race([
    requestPermission(sessionId, "call-1"),
    cancelPromise,
  ]);
  if (state.cancelled) return finish("cancelled");

  const outcome = answer?.outcome;
  if (outcome?.outcome === "selected" && outcome?.optionId === "allow_once") {
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
          agentCapabilities: restrictedCaps
            ? {
                loadSession: true,
                promptCapabilities: { image: false, audio: false },
                _packetcode: {
                  sessionsList: true,
                  sessionsRename: false,
                  sessionsUsage: !noUsage,
                  modelsList: false,
                  // Operator ceiling of "ask": nothing more permissive is
                  // offered, and session/new would reject it with -32602.
                  permissionModes: ["ask", "read-only"],
                  defaultPermissionMode: "read-only",
                  // A field this client has never heard of; must be ignored.
                  futureExtension: { enabled: true },
                },
              }
            : { loadSession: false },
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
    case "_packetcode/sessions/usage":
      if (noUsage) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        break;
      }
      if (typeof params?.sessionId !== "string" || !params.sessionId.trim()) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "sessionId is required" },
        });
        break;
      }
      send({ jsonrpc: "2.0", id, result: sessionUsage });
      break;
    case "session/cancel": {
      // Notification: cancel this session's in-flight prompt, if any. Other
      // sessions' turns keep running.
      const state = inflight.get(params?.sessionId);
      if (state) {
        state.cancelled = true;
        state.fireCancel(undefined);
      }
      break;
    }
    case "_packetcode/commands/list":
      if (noAffordances) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { commands: slashCommands } });
      break;
    case "_packetcode/project/files":
      if (noAffordances) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        break;
      }
      if (typeof params?.cwd !== "string" || !params.cwd.trim()) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "cwd is required" },
        });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { files: projectFiles } });
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
rl.on("close", () => {
  if (ignoreStdinClose) {
    // Stay alive (and stay silent) until something kills us. The interval is
    // only here to keep node's event loop from draining.
    setInterval(() => {}, 1000);
    return;
  }
  if (shutdownMarker) {
    try {
      fs.writeFileSync(shutdownMarker, "shutdown\n");
    } catch {
      // A test that cannot observe the marker will fail on its own.
    }
  }
  process.exit(0);
});
