// Consent for running the engine's own MCP servers, and the rules that decide
// what the UI says about them. Pure and storage-only: nothing here talks to
// the engine.
//
// Why consent exists at all. The engine's `[mcp.<name>]` blocks are commands —
// arbitrary local executables. The TUI starts them because the user launched
// the TUI from a shell in that config's world; the desktop app has no such
// moment. Asking for them is done by OMITTING `mcpServers` from session/new,
// which would otherwise turn "open the app" into "spawn every configured
// subprocess", with the only evidence being a chip that appears after they are
// already running. So the app defaults to `[]` (start none), discloses the
// exact commands first, and only omits the field once the user has said yes.
//
// The answer is stored per machine, in localStorage alongside the recent
// project list — the same scope as the rest of this app's preferences, and the
// right scope for a decision about THIS machine's config.toml.

import type { McpServerStatus } from "../acp/types";

const CONSENT_KEY = "packetcode.mcpInherit";

/** "granted" runs the engine's configured servers in new sessions; "denied"
 * runs none. `null` is the first-run state — treated as "denied" everywhere
 * behaviour is concerned, and it is what makes the disclosure appear. */
export type McpConsent = "granted" | "denied" | null;

export function loadMcpConsent(): McpConsent {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw === "granted" || raw === "denied" ? raw : null;
  } catch {
    // Privacy-mode / quota failures: undecided, so the app asks again next
    // launch rather than silently starting subprocesses.
    return null;
  }
}

export function saveMcpConsent(consent: "granted" | "denied"): void {
  try {
    localStorage.setItem(CONSENT_KEY, consent);
  } catch {
    // Persistence is best-effort; the in-memory answer still holds for this
    // run, and the user is asked again next launch.
  }
}

/** Servers that would actually start. A `[mcp.<name>]` block with
 * `enabled = false` is reported as "disabled": the engine lists it, and never
 * runs it. Consent is about processes, so a disabled-only configuration is
 * nothing to consent to. */
export function startableServers(configured: McpServerStatus[]): McpServerStatus[] {
  return configured.filter((s) => s.status !== "disabled");
}

/** Whether to show the first-run disclosure: the user has not answered, and
 * there is at least one server whose command would actually be run. */
export function needsMcpConsent(
  consent: McpConsent,
  configured: McpServerStatus[],
): boolean {
  return consent === null && startableServers(configured).length > 0;
}

/** What the composer's MCP chip shows, or null for no chip at all.
 *
 * `live` is the session's own fleet (empty for a session that runs none),
 * `configured` the engine's servers, `sessionInherits` whether THIS session
 * was opened with consent — a session created before the user opted in keeps
 * running with none, and the chip must not claim otherwise.
 *
 * Tones:
 *   "off"      — nothing running, but something could be. The reversibility
 *                affordance: this is where the user turns it on.
 *   "degraded" — a configured server FAILED to start. Deliberately not
 *                "fewer running than configured": the engine reports servers
 *                the user disabled on purpose, and painting those amber calls
 *                the user's own configuration a malfunction.
 *   "normal"   — the fleet is doing what it was asked to.
 *
 * Null when there is nothing to say: no engine support, no configured
 * servers, or a configuration whose every server is disabled — in which case
 * the user has already decided, and an "MCP off" chip would nag about a
 * choice they made in config.toml.
 */
export function mcpChip(
  live: McpServerStatus[],
  configured: McpServerStatus[],
  sessionInherits: boolean,
): { label: string; tone: "normal" | "degraded" | "off" } | null {
  const running = live.filter((s) => s.status === "running");
  const failed = live.filter((s) => s.status === "failed");
  if (sessionInherits && (running.length > 0 || failed.length > 0)) {
    return {
      label: `${running.length} MCP`,
      tone: failed.length > 0 ? "degraded" : "normal",
    };
  }
  if (startableServers(configured).length > 0) {
    return { label: "MCP off", tone: "off" };
  }
  return null;
}

/** One line of detail per server for the panel: tool count when it is up, the
 * failure when it is not. */
export function describeServer(server: McpServerStatus): string {
  if (server.status === "running") {
    return server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`;
  }
  if (server.error) return server.error;
  if (server.status === "disabled") return "disabled in config.toml";
  return "not started";
}
