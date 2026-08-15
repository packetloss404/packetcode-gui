// Reading the engine's advertised capabilities. The rule these helpers encode:
// an engine that advertised NOTHING must keep behaving exactly as it did
// before capability negotiation existed, because the bridge's call-time
// method-not-found fallbacks are still in place for it. Only an engine that
// did advertise gets taken at its word and has UI hidden.

import type { EngineCapabilities } from "./types";

/** The `_packetcode` vendor extensions the engine can gate. */
export type PacketcodeExtension =
  | "sessionsList"
  | "sessionsRename"
  | "sessionsUsage"
  | "modelsList"
  | "mcpList";

/** Whether `extension` may be used. Unknown capabilities (the read failed) and
 * unadvertising engines answer true: their -32601 fallback still decides, and
 * hiding the feature would regress engines that quietly support it. */
export function supports(
  caps: EngineCapabilities | null,
  extension: PacketcodeExtension,
): boolean {
  if (caps === null || !caps.packetcode.advertised) return true;
  return caps.packetcode[extension];
}

/** Whether this engine may be asked to run its OWN configured MCP servers.
 *
 * The one capability read strictly, and the exception to the rule above: every
 * other flag has a call-time -32601 fallback, so assuming support costs an
 * error message. This one has no fallback in either direction. Asking is done
 * by OMITTING `mcpServers` from session/new, and an engine that never promised
 * `mcpDefaults` answers invalid-params — failing the whole session, not just a
 * feature. An unadvertising engine therefore means "no", never "try it". */
export function canInheritMcp(caps: EngineCapabilities | null): boolean {
  return caps !== null && caps.packetcode.advertised && caps.packetcode.mcpDefaults;
}

/** Permission modes `session/new` will accept, or null when capabilities are
 * unknown (offer everything). The Rust side already substitutes the full
 * vocabulary for engines that advertise no list. */
export function allowedPermissionModes(
  caps: EngineCapabilities | null,
): string[] | null {
  return caps === null ? null : caps.packetcode.permissionModes;
}

/** Mode a session with no override runs under, when the engine says so.
 * Null means unknown — callers must label it "engine default", not "ask". */
export function engineDefaultPermissionMode(
  caps: EngineCapabilities | null,
): string | null {
  return caps?.packetcode.defaultPermissionMode ?? null;
}
