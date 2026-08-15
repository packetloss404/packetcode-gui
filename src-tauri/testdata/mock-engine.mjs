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
      "[--restricted-caps] [--shutdown-marker=PATH] [--ignore-stdin-close] "  +
      "[--no-close] [--mcp] [--mcp-defaults]\n"
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
// --no-close simulates an engine predating the spec's session/close: the
// method answers -32601 and initialize advertises no sessionCapabilities.close,
// so a client evicting a session must degrade instead of failing.
const noClose = args.includes("--no-close");
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
// --mcp serves the _packetcode/mcp/list extension (and advertises mcpList);
// without it the method answers -32601 like an engine predating it.
const withMCP = args.includes("--mcp");
// --mcp-defaults advertises mcpDefaults: the promise that an OMITTED
// mcpServers on session/new and session/load means "use the agent's own
// configured servers". Kept separate from --mcp so a test can drive an engine
// that exposes the list but still REQUIRES the field — where a client that
// omitted it would break every session, which is why the omission is refused
// with -32602 below unless this flag is on.
const withMCPDefaults = args.includes("--mcp-defaults");
// The agent's configured [mcp.<name>] blocks, as the sessionId-less query
// reports them: this is the disclosure surface, readable before any session
// exists. "muted" stands for a server the operator deliberately switched off.
const configuredMCP = [
  { name: "github", status: "configured", toolCount: 0, source: "agent", command: "gh-mcp", error: "" },
  { name: "broken", status: "configured", toolCount: 0, source: "agent", command: "nope", error: "" },
  { name: "muted", status: "disabled", toolCount: 0, source: "agent", command: "muted-mcp", error: "" },
];
// What those servers look like once a session has actually started them: one
// running with tools, one that failed, one still deliberately disabled.
const inheritedMCP = [
  { name: "github", status: "running", toolCount: 7, source: "agent", command: "gh-mcp", error: "" },
  { name: "broken", status: "failed", toolCount: 0, source: "agent", command: "nope", error: "exec: not found" },
  { name: "muted", status: "disabled", toolCount: 0, source: "agent", command: "muted-mcp", error: "" },
];
// sessionId -> that session's live fleet. Populated from what session/new and
// session/load actually carried, so a test reads the consequence of the wire
// shape (which servers run) instead of the frame itself.
const sessionFleets = new Map();

// Applies the three-way mcpServers contract to one session request. Returns
// an error object to reply with, or null once the session's fleet is recorded.
function recordFleet(sessionId, params) {
  const supplied = params?.mcpServers;
  if (supplied === undefined) {
    if (!withMCPDefaults) {
      // Exactly what an engine predating the contract does: the field is
      // mandatory, so a client that omits it breaks the whole session.
      return { code: -32602, message: "mcpServers is required" };
    }
    sessionFleets.set(sessionId, inheritedMCP);
    return null;
  }
  if (!Array.isArray(supplied)) {
    return { code: -32602, message: "mcpServers must be an array" };
  }
  // An explicit list is the client's own fleet; [] means "no MCP servers".
  sessionFleets.set(
    sessionId,
    supplied.map((server) => ({
      name: String(server?.name ?? ""),
      status: "running",
      toolCount: 1,
      source: "client",
      command: String(server?.command ?? ""),
      error: "",
    }))
  );
  return null;
}
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
/** Sessions the client released with session/close. The real engine deletes
 * the entry outright, so prompting one afterwards is -32602; tracking them
 * here is how a test can prove the close actually took effect rather than
 * being answered and ignored. */
const closedSessions = new Set();

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
    case "initialize": {
      const agentCapabilities = restrictedCaps
            ? {
                loadSession: true,
                promptCapabilities: { image: false, audio: false },
                // Spec shape: "{}" means supported, an absent field means not.
                sessionCapabilities: noClose ? {} : { close: {} },
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
            : {
                loadSession: false,
                sessionCapabilities: noClose ? {} : { close: {} },
              };
      if (withMCP || withMCPDefaults) {
        agentCapabilities._packetcode = {
          ...(agentCapabilities._packetcode ?? {}),
          mcpList: withMCP,
          mcpDefaults: withMCPDefaults,
        };
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities,
          agentInfo: { name: "mock", version: "0.1.0" },
        },
      });
      break;
    }
    case "session/new": {
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      const error = recordFleet(sessionId, params);
      if (error) {
        send({ jsonrpc: "2.0", id, error });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      break;
    }
    case "session/load": {
      const sessionId = String(params?.sessionId ?? "");
      const error = recordFleet(sessionId, params);
      if (error) {
        send({ jsonrpc: "2.0", id, error });
        break;
      }
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    }
    case "_packetcode/mcp/list": {
      if (!withMCP) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        break;
      }
      const sessionId = params?.sessionId;
      if (typeof sessionId === "string" && sessionId.trim()) {
        const fleet = sessionFleets.get(sessionId.trim());
        if (fleet === undefined) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `unknown session ${sessionId}` },
          });
          break;
        }
        send({ jsonrpc: "2.0", id, result: { servers: fleet } });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { servers: configuredMCP } });
      break;
    }
    case "session/prompt":
      if (closedSessions.has(params?.sessionId)) {
        // The real engine deletes the entry on close, so the id is unknown.
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "unknown sessionId" },
        });
        break;
      }
      handlePrompt(id, params);
      break;
    case "session/close": {
      if (noClose) {
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
      // Matches the real engine: a busy session is cancelled rather than
      // rejected, and an unknown one is idempotent success.
      const running = inflight.get(params.sessionId);
      if (running) {
        running.cancelled = true;
        running.fireCancel(undefined);
      }
      closedSessions.add(params.sessionId);
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    }
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
