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
//      that one is rejected rather than left blocking the engine — but never
//      silently, and never on this side of the reducer. The reducer decides
//      (it is the only reader of `byId` that cannot be stale) and records the
//      reply in `pendingRejects`; the effect below performs it, exactly once
//      per token, and the notice it also queued tells the user a tool call was
//      refused for them.

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
  closeSession,
  listMcpServers,
  loadSession,
  newSession,
  prompt,
  replyPermission,
  sessionUsage,
} from "../acp/client";
import type { ModelOption, PermissionMode, PromptOutcome } from "../acp/types";
import { attachRouter, routerReady } from "./router";
import {
  getEntry,
  initialStore,
  isEngaged,
  planEviction,
  reduce,
  type Action,
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
    /** Whether this session may start the engine's configured MCP servers.
     * Carries the user's stored consent; false is the safe default and the
     * only value used until they have answered. */
    inheritMcp: boolean,
  ) => void;
  /** Report which slot is now on screen. Also the eviction tick: residency
   * only ever grows when a session is opened or revisited, so that is the one
   * moment it needs trimming. Safe to call with a key the store does not hold
   * (a slot whose open has not landed yet) and safe to call repeatedly. */
  touch: (key: SessionKey) => void;
  send: (key: SessionKey, text: string) => void;
  /** Re-reads one session's live MCP fleet. Cheap, and the only defence
   * against a chip that still says "running" for a server that has since
   * died — see readFleet. */
  refreshMcp: (key: SessionKey) => void;
  stop: (key: SessionKey) => void;
  answerPermission: (
    key: SessionKey,
    requestId: string | number,
    optionId: string,
  ) => void;
  /** Drop a notice the user has acknowledged. */
  dismissNotice: (id: string) => void;
}

const SessionsContext = createContext<SessionsApi | null>(null);

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
  // Auto-rejects already sent, by token. Same reason as startedRef: the flush
  // effect is double-invoked under StrictMode, and replying twice to one
  // request id is at best noise on the wire.
  const rejectedRef = useRef<Set<string>>(new Set());
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
        // Same here: whether a slot owns this session is the reducer's call,
        // never a read of `stateRef` — that snapshot can predate an `open`
        // dispatched in the same commit and would auto-reject a request the
        // user was about to be shown.
        permission: (r) => dispatch({ type: "permission_request", request: r }),
      }),
    [],
  );

  // Perform the rejections the reducer decided on. Kept out of the reducer
  // (which must stay pure) and out of the event handler (which must stay
  // ignorant of routing): the queue is the hand-off between them.
  const pendingRejects = state.pendingRejects;
  useEffect(() => {
    if (pendingRejects.length === 0) return;
    for (const reject of pendingRejects) {
      if (rejectedRef.current.has(reject.token)) continue;
      rejectedRef.current.add(reject.token);
      // Best-effort: if the reply itself fails the engine stays blocked, but
      // the notice the reducer queued alongside it is already on screen, so
      // the user is not left guessing why a session went quiet.
      void replyPermission(reject.requestId, reject.optionId).catch(() => {});
    }
    dispatch({
      type: "rejects_flushed",
      tokens: pendingRejects.map((r) => r.token),
    });
  }, [pendingRejects]);
  /** Reads one session's live MCP fleet into its slot.
   *
   * Skipped entirely for a session that did not inherit: it was created with
   * an explicit `mcpServers: []`, so its fleet is empty by construction and
   * the query would be a round trip to confirm nothing. Failures are
   * swallowed and leave the last known fleet in place — including the
   * "unknown session" a query would hit if the engine has evicted this
   * session, which is a reason to stop refreshing, not to blank the panel. */
  const readFleet = useCallback(
    (key: SessionKey, sessionId: string, inherited: boolean) => {
      if (!inherited) return;
      void listMcpServers(sessionId)
        .then((servers) => dispatch({ type: "mcp_servers", key, servers }))
        .catch(() => {});
    },
    [],
  );

  const open = useCallback(
    (
      key: SessionKey,
      target: SessionTarget,
      cwd: string,
      model: ModelOption | null,
      permissionMode: PermissionMode | null,
      inheritMcp: boolean,
    ) => {
      if (startedRef.current.has(key)) return;
      startedRef.current.add(key);
      dispatch({
        type: "open",
        key,
        origin: target.kind,
        cwd,
        inheritMcp,
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
            await loadSession(
              target.sessionId,
              target.workingDir || cwd,
              inheritMcp,
            );
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
            readFleet(key, target.sessionId, inheritMcp);
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
              inheritMcp,
            );
            dispatch({
              type: "session_ready",
              key,
              sessionId: id,
              model,
              permissionMode,
            });
            readFleet(key, id, inheritMcp);
          }
        } catch (e) {
          // Reopen the gate so selecting the session again retries; the reducer
          // drops the routing entry so nothing streams into the dead slot.
          startedRef.current.delete(key);
          dispatch({ type: "open_failed", key, message: String(e) });
        }
      })();
    },
    [readFleet],
  );

  // Bounded residency. Every resident session costs the engine a runtime —
  // registries, a backup manager, the whole transcript, one child process per
  // configured MCP server — and nothing used to give one back, so browsing
  // history pinned a runtime per row for the engine's lifetime.
  //
  // Eviction is designed to be invisible. planEviction never picks a running
  // session, a session with an unanswered permission request, the visible
  // slot, or a slot whose open is still in flight; and an evicted session is
  // not lost, because re-selecting it loads it again from the engine's
  // persisted transcript into a fresh slot.
  const touch = useCallback((key: SessionKey) => {
    const touched: Action = { type: "touch", key };
    dispatch(touched);
    // Plan against the state this touch PRODUCES, not the one before it: the
    // slot the user just moved to has to be the freshest thing in the store,
    // or its own activation could choose it as a victim. reduce is pure, so
    // computing that state here costs nothing and stays in step with the
    // dispatch React has not applied yet.
    const victims = planEviction(reduce(stateRef.current, touched), key);
    if (victims.length === 0) return;
    dispatch({ type: "evict", keys: victims.map((victim) => victim.key) });
    for (const victim of victims) {
      // Reopen the load-once gate. Without this, re-selecting the session
      // would resolve to a slot the store no longer has and quietly render
      // nothing, because open() would decide it had already started.
      startedRef.current.delete(victim.key);
      turnSeqRef.current.delete(victim.key);
      // Only a slot that actually reached the engine has a runtime to release.
      // Best-effort: a close that fails costs an engine-side runtime, not
      // correctness, and the entry is gone from this app either way.
      if (victim.ready && victim.sessionId !== null) {
        void closeSession(victim.sessionId).catch(() => {});
      }
    }
  }, []);

  const send = useCallback((key: SessionKey, text: string) => {
    const entry = getEntry(stateRef.current, key);
    // `isEngaged`, not `busy`: a session sitting on an unanswered approval
    // card owes the engine a reply, and prompting it again would queue a turn
    // behind a block the user has not cleared.
    if (!entry || !entry.ready || entry.sessionId === null || isEngaged(entry)) {
      return;
    }
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
      // A fleet is a set of live subprocesses, and one of them can die in the
      // middle of a session — leaving the chip claiming "running" with the
      // tool count it had at startup. Turn completion is the refresh point
      // this app already uses (usage, sidebar), it costs one local IPC, and it
      // is exactly when the user is about to read the composer again. Between
      // turns the chip is start-time state, which the panel says outright.
      readFleet(key, id, entry.mcpInherited);
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
  }, [readFleet]);

  const refreshMcp = useCallback(
    (key: SessionKey) => {
      const entry = getEntry(stateRef.current, key);
      if (!entry || entry.sessionId === null) return;
      readFleet(key, entry.sessionId, entry.mcpInherited);
    },
    [readFleet],
  );

  const stop = useCallback((key: SessionKey) => {
    const entry = getEntry(stateRef.current, key);
    // engine_cancel also answers this session's outstanding permission
    // requests with "cancelled", so an aborted turn strands nothing.
    if (!entry || entry.sessionId === null) return;
    void acpCancel(entry.sessionId).catch((e: unknown) =>
      // The cancel never reached the engine. Nothing else will ever answer
      // this session's open cards, so this is the one path allowed to close
      // them — otherwise the slot sits amber and unusable forever.
      dispatch({ type: "cancel_failed", key, message: String(e) }),
    );
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

  const dismissNotice = useCallback(
    (id: string) => dispatch({ type: "dismiss_notice", id }),
    [],
  );

  const api = useMemo<SessionsApi>(
    () => ({ state, open, touch, send, stop, answerPermission, dismissNotice, refreshMcp }),
    [state, open, touch, send, stop, answerPermission, dismissNotice, refreshMcp],
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
