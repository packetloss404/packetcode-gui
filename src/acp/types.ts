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
  | { sessionUpdate: "agent_message_chunk"; content: TextBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: TextBlock }
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
  requestId: number;
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

export interface EngineProbe {
  found: boolean;
  path?: string;
  version?: string;
  status?: string;
  minimumVersion: string;
  compatible: boolean;
  detail?: string;
}
