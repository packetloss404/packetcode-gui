// Types mirroring packetcode's ACP v1 server surface
// (packetcode/internal/acp/server.go). Keep additive; the engine may be newer
// than this client, so parse defensively.

export type ToolKind = "read" | "search" | "edit" | "execute" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type StopReason = "end_turn" | "cancelled";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface PlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

export interface ToolCallContent {
  type: string;
  content?: TextBlock;
}

export type SessionUpdate =
  // user_message_chunk arrives only while a session/load replays its stored
  // transcript; live prompts are echoed locally, not by the engine.
  | { sessionUpdate: "user_message_chunk"; content: TextBlock; messageId?: string }
  | { sessionUpdate: "agent_message_chunk"; content: TextBlock; messageId?: string }
  | { sessionUpdate: "agent_thought_chunk"; content: TextBlock; messageId?: string }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: ToolKind;
      status: ToolCallStatus;
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      rawOutput?: unknown;
    };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  /** Raw JSON-RPC id of the agent's request — the real engine uses strings
   * ("packetcode-permission-1"); mocks may use numbers. Echo it back as-is. */
  requestId: string | number;
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    rawInput?: unknown;
  };
  options: PermissionOption[];
}

export interface SessionSummary {
  sessionId: string;
  name: string;
  updatedAt: string;
  provider: string;
  model: string;
  workingDir: string;
  messageCount: number;
  costUsd: number;
}

// Per-session permission mode, mirroring the engine's `_packetcode`
// permissionMode vocabulary (initialize advertises it under
// agentCapabilities._packetcode.permissionModes).
export type PermissionMode =
  | "ask"
  | "accept-edits"
  | "auto"
  | "read-only"
  | "bypass";

// Per-session token/cost usage from `_packetcode/sessions/usage`, also
// attached to successful prompt outcomes by newer engines. contextTokens is
// the live context-window occupancy; totalInput/totalOutput are cumulative.
export interface SessionUsage {
  contextTokens: number;
  totalInput: number;
  totalOutput: number;
  costUsd: number;
}

// Outcome of one prompt turn from the Rust bridge. `usage` is present only
// when the engine enriched the result; older engines omit it.
export interface PromptOutcome {
  stopReason: StopReason;
  usage?: SessionUsage | null;
}

// One selectable provider/model pair from `_packetcode/models/list`.
// `default` marks the pair the engine uses when session/new carries no
// override.
export interface ModelOption {
  provider: string;
  model: string;
  default: boolean;
}

// One invocable slash command from `_packetcode/commands/list`. `source` says
// where it came from; today's engine reports only markdown commands under
// ~/.packetcode/commands ("user") and <cwd>/.packetcode/commands ("project"),
// since its built-in slash commands are TUI affordances with no ACP
// equivalent. `argumentHint` is a short usage tail such as "[arguments]" and
// is absent for commands that take none.
export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
  argumentHint?: string;
}

// One MCP server from `_packetcode/mcp/list`. Queried with a session id it
// describes that session's LIVE fleet (what actually started); without one,
// the engine's CONFIGURED servers — the `[mcp.<name>]` blocks in the user's
// config.toml that a session would start if it inherited them. `command` is
// the disclosure that matters: it names the local subprocess.
export interface McpServerStatus {
  name: string;
  /** "running", "failed", "disabled", or "configured". */
  status: string;
  toolCount: number;
  /** "agent" for the engine's own configuration, "client" for servers an ACP
   * client supplied. This app never supplies any of its own. */
  source: string;
  command: string;
  error: string;
}

export interface EngineProbe {
  found: boolean;
  path?: string;
  version?: string;
  status?: string;
  minimumVersion: string;
  compatible: boolean;
  installSupported: boolean;
  detail?: string;
}

// What the engine advertised in its ACP `initialize` handshake, retained by
// the Rust bridge and served by the `engine_capabilities` command. Reading
// these instead of catching -32601/-32602 at call time is what keeps the UI
// from offering something the engine will reject.
export interface PacketcodeCapabilities {
  /** Whether the engine sent an `agentCapabilities._packetcode` block at all.
   * False means "the engine did not say" — an older packetcode, or another
   * ACP agent entirely — and the booleans below carry no information. */
  advertised: boolean;
  sessionsList: boolean;
  sessionsRename: boolean;
  sessionsUsage: boolean;
  modelsList: boolean;
  /** Gates the configured-server half of `_packetcode/mcp/list` — the query
   * with no session id, which is the disclosure surface. */
  mcpList: boolean;
  /** A wire-behaviour promise, not a feature toggle: this engine reads an
   * OMITTED `mcpServers` on session/new as "use your own configured servers".
   * Unlike every other flag here, false is never "the engine did not say" —
   * an engine that has not promised this REJECTS the omission, so it must be
   * read strictly (see canInheritMcp). */
  mcpDefaults: boolean;
  /** Modes `session/new` accepts, trimmed by the engine to the operator's
   * permission ceiling. Never empty: engines that advertise nothing yield the
   * full five-mode vocabulary, so the picker behaves as it always did. */
  permissionModes: string[];
  /** Mode a session with no override resolves to; null when not advertised —
   * the UI must say "engine default" rather than guess a name. */
  defaultPermissionMode: string | null;
}

export interface EngineCapabilities {
  protocolVersion: number;
  /** Spec capability: whether `session/load` may be used to resume. */
  loadSession: boolean;
  packetcode: PacketcodeCapabilities;
}
