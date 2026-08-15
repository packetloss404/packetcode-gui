// Thin frontend client over the Tauri engine bridge. The Rust side owns the
// packetcode subprocess; this module owns subscribe/invoke plumbing.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EngineCapabilities,
  EngineProbe,
  ModelOption,
  PermissionMode,
  PermissionRequest,
  PromptOutcome,
  SessionNotification,
  SessionSummary,
  SessionUsage,
  SlashCommand,
} from "./types";

export function probeEngine(): Promise<EngineProbe> {
  return invoke<EngineProbe>("engine_probe");
}

export function startEngine(): Promise<void> {
  return invoke("engine_start");
}

/** What the running engine advertised in its ACP `initialize` handshake.
 * Always resolves once the engine has started: an engine that advertised
 * nothing yields conservative defaults rather than an error. */
export function engineCapabilities(): Promise<EngineCapabilities> {
  return invoke<EngineCapabilities>("engine_capabilities");
}

export function newSession(
  cwd: string,
  provider?: string,
  model?: string,
  permissionMode?: PermissionMode,
): Promise<string> {
  return invoke<string>("engine_new_session", {
    cwd,
    provider: provider ?? null,
    model: model ?? null,
    permissionMode: permissionMode ?? null,
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

/** Retitle a persisted session via `_packetcode/sessions/rename`. Engines
 * that predate the extension are silently skipped by the bridge, so this
 * resolves successfully without renaming on old engines. */
export function renameSession(sessionId: string, name: string): Promise<void> {
  return invoke("engine_rename_session", { sessionId, name });
}

export function listModels(): Promise<ModelOption[]> {
  return invoke<ModelOption[]>("engine_list_models");
}

/** Slash commands available in `cwd` via `_packetcode/commands/list`. Engines
 * that predate the extension answer method-not-found, which the bridge maps to
 * an empty list — so an empty result means "no / menu", not "no commands yet". */
export function listCommands(cwd: string): Promise<SlashCommand[]> {
  return invoke<SlashCommand[]>("engine_list_commands", { cwd });
}

/** Project files matching `query` via `_packetcode/project/files`, ranked
 * best-match first and capped by the bridge. Same degradation as
 * listCommands: an empty list on engines without the extension. */
export function searchFiles(cwd: string, query: string): Promise<string[]> {
  return invoke<string[]>("engine_search_files", { cwd, query });
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
