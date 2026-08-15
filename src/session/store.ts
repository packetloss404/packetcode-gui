// Multi-session store. Every session the user has opened lives here, keyed by
// a stable slot key, so the state of a session survives switching away from it
// — a turn started in session A keeps streaming into A's entry while B is on
// screen. Nothing in this module touches React or Tauri: the reducer is a pure
// function of (state, action) and can be exercised directly.
//
// Two invariants worth stating up front, because the rest of the app leans on
// them:
//
//   * ACP notifications carry only a sessionId, so `byId` is the routing index
//     from sessionId to slot key. It is populated the moment a slot's session
//     id is known (immediately for a resumed session, on session/new's reply
//     for a fresh one) — never later, or replay updates would be dropped.
//   * A slot is opened exactly once (see SessionsProvider.open). Re-entering a
//     resident session must not re-issue session/load: the engine happily
//     re-loads an idle session, but it replays the whole transcript into the
//     existing timeline, duplicating history.

import type {
  ModelOption,
  PermissionMode,
  PermissionRequest,
  PlanEntry,
  SessionUpdate,
  SessionUsage,
  ToolCallStatus,
  ToolKind,
} from "../acp/types";

/** What a view should attach to: a fresh session, or a persisted one resumed
 * via ACP session/load (which replays its transcript). The nonce makes each
 * "+ New session" click a distinct target, so a fresh session is created (with
 * the current model choice) instead of reusing the old one. */
export type SessionTarget =
  | { kind: "new"; nonce: number }
  | { kind: "load"; sessionId: string; workingDir: string };

export type TimelineItem =
  | { kind: "user"; id: string; text: string; messageId?: string }
  | { kind: "agent_text"; id: string; text: string; messageId?: string }
  | { kind: "agent_thought"; id: string; text: string; messageId?: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      output: string;
    }
  | { kind: "permission"; id: string; request: PermissionRequest; resolved?: string };

/** Sidebar dot state, derived (never stored — see statusOf). */
export type SessionStatus = "running" | "attention" | "idle";

/** Slot key. `new:<nonce>` for a session this app created, `load:<sessionId>`
 * for one resumed from disk. A fresh session keeps its `new:` key for life;
 * `byId` is what makes it findable by session id afterwards. */
export type SessionKey = string;

export interface SessionEntry {
  key: SessionKey;
  /** How the slot was opened. A fresh slot has no session id until the engine
   * answers session/new; a resumed slot knows its id from the start. */
  origin: "new" | "load";
  /** Directory the session runs in. */
  cwd: string;
  sessionId: string | null;
  /** True once session/new or session/load succeeded: only then may the slot
   * be prompted. A failed load must not leave a promptable session pointing at
   * context the user never saw. */
  ready: boolean;
  /** Provider/model this session was created with; null = engine default. */
  model: ModelOption | null;
  /** Permission mode this session was created with; null = engine default. */
  permissionMode: PermissionMode | null;
  timeline: TimelineItem[];
  plan: PlanEntry[];
  busy: boolean;
  error: string | null;
  /** Latest token/cost usage; null until known (fresh session with no turns
   * yet, or an engine without the usage extension). */
  usage: SessionUsage | null;
}

export interface StoreState {
  entries: Record<SessionKey, SessionEntry>;
  /** sessionId -> owning slot key. The fan-out index for ACP events. */
  byId: Record<string, SessionKey>;
  /** Bumped whenever the engine's persisted session list may have changed (a
   * session was created, a turn completed). The shell watches it to refresh
   * the sidebar — which is why turn completion needs no callback plumbing back
   * through views that may no longer be mounted. */
  listRevision: number;
}

export type Action =
  | {
      type: "open";
      key: SessionKey;
      origin: "new" | "load";
      cwd: string;
      /** Known up front for a resumed session, null for a fresh one. */
      sessionId: string | null;
    }
  | {
      type: "session_ready";
      key: SessionKey;
      sessionId: string;
      model: ModelOption | null;
      permissionMode: PermissionMode | null;
    }
  | { type: "open_failed"; key: SessionKey; message: string }
  | { type: "user_prompt"; key: SessionKey; text: string }
  | { type: "acp_update"; sessionId: string; update: SessionUpdate }
  | { type: "permission_request"; request: PermissionRequest }
  | {
      type: "permission_resolved";
      key: SessionKey;
      requestId: string | number;
      optionId: string;
    }
  | { type: "turn_done"; key: SessionKey }
  | { type: "usage"; key: SessionKey; usage: SessionUsage }
  | { type: "error"; key: SessionKey; message: string };

let nextId = 0;
const genId = () => `t${nextId++}`;

export const initialStore: StoreState = {
  entries: {},
  byId: {},
  listRevision: 0,
};

export function targetKey(target: SessionTarget): SessionKey {
  return target.kind === "load"
    ? `load:${target.sessionId}`
    : `new:${target.nonce}`;
}

/** Slot a target refers to. A session created in this app is already resident
 * under its `new:` key, so selecting it in the sidebar (a `load` target) must
 * resolve to that slot instead of opening a second one. */
export function resolveKey(state: StoreState, target: SessionTarget): SessionKey {
  if (target.kind === "load") {
    const existing: SessionKey | undefined = state.byId[target.sessionId];
    if (existing !== undefined) return existing;
  }
  return targetKey(target);
}

/** Entry lookup that tells the truth about misses (the project does not run
 * with noUncheckedIndexedAccess). */
export function getEntry(
  state: StoreState,
  key: SessionKey | null,
): SessionEntry | null {
  if (key === null) return null;
  const entry: SessionEntry | undefined = state.entries[key];
  return entry ?? null;
}

/** Sidebar dot state. A session waiting on the user outranks a running one:
 * amber means "this one cannot progress until you answer", which is the only
 * state that needs the user to go back to it. */
export function statusOf(entry: SessionEntry): SessionStatus {
  const waiting = entry.timeline.some(
    (item) => item.kind === "permission" && item.resolved === undefined,
  );
  if (waiting) return "attention";
  return entry.busy ? "running" : "idle";
}

/** Status of every RESIDENT session, keyed by session id. Sessions absent from
 * the map have no runtime in this app (history rows in the sidebar). */
export function statusById(
  state: StoreState,
): Record<string, SessionStatus | undefined> {
  const out: Record<string, SessionStatus | undefined> = {};
  for (const key of Object.keys(state.entries)) {
    const entry = getEntry(state, key);
    if (entry && entry.sessionId !== null) out[entry.sessionId] = statusOf(entry);
  }
  return out;
}

function patch(
  state: StoreState,
  key: SessionKey,
  update: (entry: SessionEntry) => SessionEntry,
): StoreState {
  const entry = getEntry(state, key);
  if (!entry) return state;
  return { ...state, entries: { ...state.entries, [key]: update(entry) } };
}

export function reduce(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "open": {
      // Opening replaces whatever sat in the slot. The load-once gate lives in
      // the provider (a ref, checked synchronously), so reaching this case
      // always means "start this slot from scratch" — including the retry
      // after a failed load, which must replay into an empty timeline.
      const entry: SessionEntry = {
        key: action.key,
        origin: action.origin,
        cwd: action.cwd,
        sessionId: action.sessionId,
        ready: false,
        model: null,
        permissionMode: null,
        timeline: [],
        plan: [],
        busy: false,
        error: null,
        usage: null,
      };
      return {
        ...state,
        entries: { ...state.entries, [action.key]: entry },
        byId:
          action.sessionId === null
            ? state.byId
            : { ...state.byId, [action.sessionId]: action.key },
      };
    }
    case "session_ready": {
      const next = patch(state, action.key, (entry) => ({
        ...entry,
        sessionId: action.sessionId,
        ready: true,
        model: action.model,
        permissionMode: action.permissionMode,
        error: null,
      }));
      if (next === state) return state;
      return {
        ...next,
        byId: { ...next.byId, [action.sessionId]: action.key },
        // A fresh session is persisted by the engine on creation, and a resume
        // touches nothing — bumping for both is harmless and keeps the sidebar
        // honest without a second code path.
        listRevision: next.listRevision + 1,
      };
    }
    case "open_failed": {
      const entry = getEntry(state, action.key);
      if (!entry) return state;
      const byId = { ...state.byId };
      // Drop the routing entry: there is no runtime behind this id now, and a
      // later selection must be free to retry the load from scratch.
      if (entry.sessionId !== null) delete byId[entry.sessionId];
      return {
        ...state,
        byId,
        entries: {
          ...state.entries,
          [action.key]: { ...entry, ready: false, busy: false, error: action.message },
        },
      };
    }
    case "user_prompt":
      return patch(state, action.key, (entry) => ({
        ...entry,
        busy: true,
        error: null,
        timeline: [
          ...entry.timeline,
          { kind: "user", id: genId(), text: action.text },
        ],
      }));
    case "turn_done": {
      const next = patch(state, action.key, (entry) => settle({ ...entry, busy: false }));
      if (next === state) return state;
      return { ...next, listRevision: next.listRevision + 1 };
    }
    case "usage":
      return patch(state, action.key, (entry) => ({ ...entry, usage: action.usage }));
    case "error":
      return patch(state, action.key, (entry) =>
        settle({ ...entry, busy: false, error: action.message }),
      );
    case "permission_request": {
      // Routed by session id, not by "the visible view": the request may well
      // belong to a session the user has switched away from.
      const key: SessionKey | undefined = state.byId[action.request.sessionId];
      if (key === undefined) return state;
      return patch(state, key, (entry) => ({
        ...entry,
        timeline: [
          ...entry.timeline,
          { kind: "permission", id: genId(), request: action.request },
        ],
      }));
    }
    case "permission_resolved":
      return patch(state, action.key, (entry) => ({
        ...entry,
        timeline: entry.timeline.map((item) =>
          item.kind === "permission" && item.request.requestId === action.requestId
            ? { ...item, resolved: action.optionId }
            : item,
        ),
      }));
    case "acp_update": {
      const key: SessionKey | undefined = state.byId[action.sessionId];
      // Updates for a session this app does not hold (never opened, or dropped
      // after a failed load) are inert rather than fatal.
      if (key === undefined) return state;
      return patch(state, key, (entry) => applyUpdate(entry, action.update));
    }
  }
}

/** Close out approval cards that can no longer be answered. A permission
 * request blocks its turn, so once the turn has ended — normally, cancelled,
 * or because the engine died — any card still open is dead: the bridge already
 * answered it "cancelled", or nothing is listening. Settling them is what
 * keeps a finished session from sitting amber in the sidebar forever. */
function settle(entry: SessionEntry): SessionEntry {
  if (!entry.timeline.some((i) => i.kind === "permission" && i.resolved === undefined)) {
    return entry;
  }
  return {
    ...entry,
    timeline: entry.timeline.map((item) =>
      item.kind === "permission" && item.resolved === undefined
        ? { ...item, resolved: "cancelled" }
        : item,
    ),
  };
}

function applyUpdate(entry: SessionEntry, update: SessionUpdate): SessionEntry {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // Only emitted during session/load replay; live prompts are echoed
      // locally by the user_prompt action.
      return appendText(entry, "user", update.content.text, update.messageId);
    case "agent_message_chunk":
      return appendText(entry, "agent_text", update.content.text, update.messageId);
    case "agent_thought_chunk":
      return appendText(entry, "agent_thought", update.content.text, update.messageId);
    case "plan":
      return { ...entry, plan: update.entries };
    case "tool_call":
      return {
        ...entry,
        timeline: [
          ...entry.timeline,
          {
            kind: "tool",
            id: genId(),
            toolCallId: update.toolCallId,
            title: update.title,
            toolKind: update.kind,
            status: update.status,
            output: "",
          },
        ],
      };
    case "tool_call_update": {
      const chunk = (update.content ?? [])
        .map((c) => c.content?.text ?? "")
        .join("");
      return {
        ...entry,
        timeline: entry.timeline.map((item) =>
          item.kind === "tool" && item.toolCallId === update.toolCallId
            ? {
                ...item,
                status: update.status ?? item.status,
                // The engine sends the CUMULATIVE output preview on every
                // tool_call_update (already tail-trimmed to its own cap), so
                // this replaces rather than appends. Appending made a k-chunk
                // tool cost the sum of every prefix — tens of MB for a chatty
                // one — and the store now outlives the view that showed it.
                output: chunk ? chunk : item.output,
              }
            : item,
        ),
      };
    }
  }
}

function appendText(
  entry: SessionEntry,
  kind: "user" | "agent_text" | "agent_thought",
  text: string,
  messageId?: string,
): SessionEntry {
  const last = entry.timeline[entry.timeline.length - 1];
  // Merge only chunks of the same message: replayed turns carry distinct
  // messageIds so two adjacent stored messages stay separate bubbles.
  if (last && last.kind === kind && last.messageId === messageId) {
    return {
      ...entry,
      timeline: [
        ...entry.timeline.slice(0, -1),
        { ...last, text: last.text + text },
      ],
    };
  }
  return {
    ...entry,
    timeline: [...entry.timeline, { kind, id: genId(), text, messageId }],
  };
}
