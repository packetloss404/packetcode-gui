// Thin frontend client over the Tauri engine bridge. The Rust side owns the
// packetcode subprocess; this module owns subscribe/invoke plumbing.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EngineProbe,
  ModelOption,
  PermissionRequest,
  PromptOutcome,
  SessionNotification,
  SessionSummary,
  SessionUsage,
} from "./types";

export function probeEngine(): Promise<EngineProbe> {
  return invoke<EngineProbe>("engine_probe");
}

export function startEngine(): Promise<void> {
  return invoke("engine_start");
}

export function newSession(
  cwd: string,
  provider?: string,
  model?: string,
): Promise<string> {
  return invoke<string>("engine_new_session", {
    cwd,
    provider: provider ?? null,
    model: model ?? null,
  });
}

/** Resume a persisted session. Replay updates are emitted on `acp:update`
 * while this call is in flight — subscribe before invoking. */
export function loadSession(sessionId: string, cwd: string): Promise<void> {
  return invoke("engine_load_session", { sessionId, cwd });
}

export function prompt(sessionId: string, text: string): Promise<PromptOutcome> {
  return invoke<PromptOutcome>("engine_prompt", { sessionId, text });
}

/** Usage for one session via `_packetcode/sessions/usage`. Null when the
 * engine predates the extension (method-not-found). */
export function sessionUsage(sessionId: string): Promise<SessionUsage | null> {
  return invoke<SessionUsage | null>("engine_session_usage", { sessionId });
}

export function cancel(sessionId: string): Promise<void> {
  return invoke("engine_cancel", { sessionId });
}

export function listSessions(): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("engine_list_sessions");
}

export function listModels(): Promise<ModelOption[]> {
  return invoke<ModelOption[]>("engine_list_models");
}

export function installEngine(): Promise<void> {
  return invoke("engine_install");
}

export function onInstallOutput(
  handler: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("engine:install_output", (e) => handler(e.payload));
}

export function replyPermission(
  requestId: string | number,
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
