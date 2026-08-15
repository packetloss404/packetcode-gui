// Thin frontend client over the Tauri engine bridge. The Rust side owns the
// packetcode subprocess; this module owns subscribe/invoke plumbing.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EngineCapabilities,
  EngineProbe,
  McpServerStatus,
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

/** `inheritMcp` decides the session's MCP fleet: false sends the ACP-required
 * `mcpServers: []` ("run with none"), true omits the field, which is the only
 * way to ask a capable engine for its own configured servers — and therefore
 * the only way this app starts those local subprocesses. It carries the user's
 * stored consent; the Rust side intersects it with the engine's `mcpDefaults`
 * promise, so an opted-in user on an old engine still gets a working session. */
export function newSession(
  cwd: string,
  provider?: string,
  model?: string,
  permissionMode?: PermissionMode,
  inheritMcp = false,
): Promise<string> {
  return invoke<string>("engine_new_session", {
    cwd,
    provider: provider ?? null,
    model: model ?? null,
    permissionMode: permissionMode ?? null,
    inheritMcp,
  });
}

/** Resume a persisted session. Replay updates are emitted on `acp:update`
 * while this call is in flight — subscribe before invoking. `inheritMcp` is
 * the same consent-carrying flag as on newSession: a resumed session starts a
 * fleet of its own, so it has to be asked the same question. */
export function loadSession(
  sessionId: string,
  cwd: string,
  inheritMcp = false,
): Promise<void> {
  return invoke("engine_load_session", { sessionId, cwd, inheritMcp });
}

/** MCP servers via `_packetcode/mcp/list`. With a session id: that session's
 * live fleet (what actually started, with tool counts and failures). Without
 * one: the engine's configured servers, readable before any session exists —
 * which is exactly what the consent disclosure lists. Resolves empty on
 * engines predating the extension, so empty means "nothing to show". */
export function listMcpServers(sessionId?: string): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("engine_list_mcp_servers", {
    sessionId: sessionId ?? null,
  });
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
