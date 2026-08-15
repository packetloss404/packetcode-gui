// Thin frontend client over the Tauri engine bridge. The Rust side owns the
// packetcode subprocess; this module owns subscribe/invoke plumbing.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EngineProbe,
  PermissionRequest,
  SessionNotification,
  SessionSummary,
  StopReason,
} from "./types";

export function probeEngine(): Promise<EngineProbe> {
  return invoke<EngineProbe>("engine_probe");
}

export function startEngine(): Promise<void> {
  return invoke("engine_start");
}

export function newSession(cwd: string): Promise<string> {
  return invoke<string>("engine_new_session", { cwd });
}

export function prompt(sessionId: string, text: string): Promise<StopReason> {
  return invoke<StopReason>("engine_prompt", { sessionId, text });
}

export function cancel(sessionId: string): Promise<void> {
  return invoke("engine_cancel", { sessionId });
}

export function listSessions(): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("engine_list_sessions");
}

export function replyPermission(
  requestId: number,
  optionId: string,
): Promise<void> {
  return invoke("engine_permission_reply", { requestId, optionId });
}

export function onSessionUpdate(
  handler: (n: SessionNotification) => void,
): Promise<UnlistenFn> {
  return listen<SessionNotification>("acp:update", (e) => handler(e.payload));
}

export function onPermissionRequest(
  handler: (r: PermissionRequest) => void,
): Promise<UnlistenFn> {
  return listen<PermissionRequest>("acp:permission_request", (e) =>
    handler(e.payload),
  );
}
