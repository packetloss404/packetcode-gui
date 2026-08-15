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
