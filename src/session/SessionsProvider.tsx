// Owner of every live session. Sits above the whole shell, so it outlives any
// individual view: a turn started in one session keeps running — and keeps
// filling its timeline — while the user works in another.
//
// The three rules that make concurrency safe:
//
//   1. One event tap (see router.ts), fanned out by sessionId in the reducer.
//   2. Load-once per slot, gated by a ref (below) rather than by reducer
//      state, because two effects in the same commit would both see the old
//      state and both issue session/load — which replays the transcript twice.
//   3. Nothing is cancelled on switch. A background session that stops for a
//      permission request stays answerable: it shows amber in the sidebar and
//      its approval card is right there when the user returns. The only
//      unanswerable request is one for a session this app does not hold, and
//      that one is rejected immediately rather than left blocking the engine.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  cancel as acpCancel,
  loadSession,
  newSession,
  prompt,
  replyPermission,
  sessionUsage,
} from "../acp/client";
import type {
  ModelOption,
  PermissionMode,
  PermissionRequest,
  PromptOutcome,
} from "../acp/types";
import { attachRouter, routerReady } from "./router";
import {
  getEntry,
  initialStore,
  reduce,
  type SessionKey,
  type SessionTarget,
  type StoreState,
} from "./store";

export interface SessionsApi {
  state: StoreState;
  /** Attach a slot to the engine. Idempotent per key — the second call for a
   * resident session is a no-op, which is what keeps re-entering a loaded
   * session from replaying its history again. */
  open: (
    key: SessionKey,
    target: SessionTarget,
    cwd: string,
    model: ModelOption | null,
    permissionMode: PermissionMode | null,
  ) => void;
  send: (key: SessionKey, text: string) => void;
  stop: (key: SessionKey) => void;
  answerPermission: (
    key: SessionKey,
    requestId: string | number,
    optionId: string,
  ) => void;
}

const SessionsContext = createContext<SessionsApi | null>(null);

/** Option to answer an unroutable permission request with: the explicit
 * rejection if the engine offered one, else the last option (the engine lists
 * rejection last). Never an "allow": an unattributable request must not be
 * granted on the user's behalf. */
function rejectionOption(request: PermissionRequest): string | null {
  const reject = request.options.find(
    (o) => o.kind.startsWith("reject") || o.optionId.startsWith("reject"),
  );
  if (reject) return reject.optionId;
  const last = request.options[request.options.length - 1];
  return last ? last.optionId : null;
}

export function SessionsProvider(props: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialStore);
  // Latest state for imperative code (event handlers, async continuations)
  // that must not close over a render's snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Load-once gate. A ref, not reducer state: it is updated synchronously, so
  // StrictMode's double-invoked effects and two views resolving to the same
  // slot in one commit still produce exactly one session/new or session/load.
  const startedRef = useRef<Set<SessionKey>>(new Set());
  // Per-slot monotonic turn counter; guards the usage fallback against a slow
  // response overwriting a newer turn's numbers.
  const turnSeqRef = useRef<Map<SessionKey, number>>(new Map());

  useEffect(
    () =>
      attachRouter({
        // Routing happens inside the reducer, which always sees current state
        // — no stale closure over byId.
        update: (n) =>
          dispatch({ type: "acp_update", sessionId: n.sessionId, update: n.update }),
        permission: (r) => {
          if (stateRef.current.byId[r.sessionId] !== undefined) {
            dispatch({ type: "permission_request", request: r });
            return;
          }
          // No slot owns this session, so no UI will ever show the card and the
          // engine's turn would block forever on callClient. Answer it.
          const option = rejectionOption(r);
          if (option !== null) void replyPermission(r.requestId, option).catch(() => {});
        },
      }),
    [],
  );

  const open = useCallback(
    (
      key: SessionKey,
      target: SessionTarget,
      cwd: string,
      model: ModelOption | null,
      permissionMode: PermissionMode | null,
    ) => {
      if (startedRef.current.has(key)) return;
      startedRef.current.add(key);
      dispatch({
        type: "open",
        key,
        origin: target.kind,
        cwd,
        // A resumed session's id is known before session/load returns, and its
        // replay updates arrive while the call is still in flight — the
        // routing index has to carry it from the start.
        sessionId: target.kind === "load" ? target.sessionId : null,
      });
      void (async () => {
        try {
          // The tap must exist before the engine is touched: session/load
          // replays into notifications, and an unlistened notification is lost.
          await routerReady;
          if (target.kind === "load") {
            await loadSession(target.sessionId, target.workingDir || cwd);
            // Resumed sessions keep the provider/model and permission mode they
            // were created with; the pickers' pending choices apply only to
            // fresh sessions.
            dispatch({
              type: "session_ready",
              key,
              sessionId: target.sessionId,
              model: null,
              permissionMode: null,
            });
            // Resumed sessions may already have spend; hydrate the statusline.
            // Best-effort: old engines answer null, failures stay quiet.
            void sessionUsage(target.sessionId)
              .then((usage) => {
                if (usage) dispatch({ type: "usage", key, usage });
              })
              .catch(() => {});
          } else {
            const id = await newSession(
              cwd,
              model?.provider,
              model?.model,
              permissionMode ?? undefined,
            );
            dispatch({
              type: "session_ready",
              key,
              sessionId: id,
              model,
              permissionMode,
            });
          }
        } catch (e) {
          // Reopen the gate so selecting the session again retries; the reducer
          // drops the routing entry so nothing streams into the dead slot.
          startedRef.current.delete(key);
          dispatch({ type: "open_failed", key, message: String(e) });
        }
      })();
    },
    [],
  );

  const send = useCallback((key: SessionKey, text: string) => {
    const entry = getEntry(stateRef.current, key);
    if (!entry || !entry.ready || entry.sessionId === null || entry.busy) return;
    const id = entry.sessionId;
    const seq = (turnSeqRef.current.get(key) ?? 0) + 1;
    turnSeqRef.current.set(key, seq);
    dispatch({ type: "user_prompt", key, text });
    // Deliberately not tied to any component's lifetime: this continuation is
    // what lets a turn finish while its view is unmounted. No GUI-side
    // auto-title either — the engine names a fresh session from its first user
    // prompt when it persists the turn.
    void (async () => {
      let outcome: PromptOutcome;
      try {
        outcome = await prompt(id, text);
      } catch (e) {
        dispatch({ type: "error", key, message: String(e) });
        return;
      }
      dispatch({ type: "turn_done", key });
      // Newer engines attach usage to the prompt result; otherwise (older
      // engine, or a cancelled turn) fall back to an explicit query. Both are
      // best-effort — the statusline just goes stale on failure.
      if (outcome.usage) {
        dispatch({ type: "usage", key, usage: outcome.usage });
        return;
      }
      try {
        const usage = await sessionUsage(id);
        if (usage && turnSeqRef.current.get(key) === seq) {
          dispatch({ type: "usage", key, usage });
        }
      } catch {
        // engine predates the extension or the read failed; keep quiet
      }
    })();
  }, []);

  const stop = useCallback((key: SessionKey) => {
    const entry = getEntry(stateRef.current, key);
    // engine_cancel also answers this session's outstanding permission
    // requests with "cancelled", so an aborted turn strands nothing.
    if (entry && entry.sessionId !== null) void acpCancel(entry.sessionId);
  }, []);

  const answerPermission = useCallback(
    (key: SessionKey, requestId: string | number, optionId: string) => {
      void replyPermission(requestId, optionId)
        .then(() => dispatch({ type: "permission_resolved", key, requestId, optionId }))
        .catch((e: unknown) =>
          dispatch({ type: "error", key, message: String(e) }),
        );
    },
    [],
  );

  const api = useMemo<SessionsApi>(
    () => ({ state, open, send, stop, answerPermission }),
    [state, open, send, stop, answerPermission],
  );

  return (
    <SessionsContext.Provider value={api}>{props.children}</SessionsContext.Provider>
  );
}

export function useSessions(): SessionsApi {
  const api = useContext(SessionsContext);
  if (api === null) throw new Error("useSessions must be used inside SessionsProvider");
  return api;
}
