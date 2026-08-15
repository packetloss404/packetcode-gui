// The app's single ACP event tap.
//
// Why exactly one listener pair for the whole app, installed here at module
// load rather than per view:
//
//   * Tauri delivers every `acp:update` to every registered listener, so N
//     mounted subscribers would each see all N sessions' traffic and have to
//     filter. One listener that fans out by sessionId (see the store's `byId`)
//     is both cheaper and the only place that can route to a session whose
//     view is not mounted.
//   * A per-view subscription has to unsubscribe when the view unmounts, which
//     is precisely when a background session most needs its stream — the old
//     code had to cancel the running turn on switch to stay safe.
//   * session/load replays the whole transcript *while the request is in
//     flight*; a notification with no listener is simply lost. Subscribing at
//     import time, and gating every engine call on `routerReady`, removes the
//     ordering hazard entirely (React effects run child-first, so a provider
//     that subscribed in its own effect would subscribe after its children had
//     already asked to load a session).

import { onPermissionRequest, onSessionUpdate } from "../acp/client";
import type { PermissionRequest, SessionNotification } from "../acp/types";

export interface RouterSink {
  update: (n: SessionNotification) => void;
  permission: (r: PermissionRequest) => void;
}

type Buffered =
  | { kind: "update"; n: SessionNotification }
  | { kind: "permission"; r: PermissionRequest };

let sink: RouterSink | null = null;
/** Events that arrived before the store attached. The window is the few
 * milliseconds between module load and the provider's first effect, so the cap
 * only guards against a pathological "never attached" build. */
const buffered: Buffered[] = [];
const BUFFER_LIMIT = 500;

function accept(event: Buffered): void {
  const target = sink;
  if (target === null) {
    if (buffered.length < BUFFER_LIMIT) buffered.push(event);
    return;
  }
  if (event.kind === "update") target.update(event.n);
  else target.permission(event.r);
}

/** Resolves once both listeners are registered with the Tauri event system.
 * Every engine call that can provoke notifications (session/load above all)
 * must await this first. */
export const routerReady: Promise<void> = (async () => {
  await onSessionUpdate((n) => accept({ kind: "update", n }));
  await onPermissionRequest((r) => accept({ kind: "permission", r }));
})();

// Every open() awaits the promise above, but that first awaiter arrives a tick
// later; this keeps a listen() failure from surfacing as an unhandled
// rejection in the meantime.
void routerReady.catch(() => {});

/** Point the tap at the store. The listeners themselves are never torn down —
 * they live as long as the webview — so nothing is missed between attaches. */
export function attachRouter(next: RouterSink): () => void {
  sink = next;
  const queued = buffered.splice(0, buffered.length);
  for (const event of queued) accept(event);
  return () => {
    if (sink === next) sink = null;
  };
}
