// Multi-session store. Every session the user has opened lives here, keyed by
// a stable slot key, so the state of a session survives switching away from it
// — a turn started in session A keeps streaming into A's entry while B is on
// screen. Nothing in this module touches React or Tauri: the reducer is a pure
// function of (state, action) and can be exercised directly.
//
// Three invariants worth stating up front, because the rest of the app leans
// on them:
//
//   * ACP notifications carry only a sessionId, so `byId` is the routing index
//     from sessionId to slot key. It is populated the moment a slot's session
//     id is known (immediately for a resumed session, on session/new's reply
//     for a fresh one) — never later, or replay updates would be dropped.
//   * A slot is opened exactly once (see SessionsProvider.open). Re-entering a
//     resident session must not re-issue session/load: the engine happily
//     re-loads an idle session, but it replays the whole transcript into the
//     existing timeline, duplicating history.
//   * EVERY routing decision is made in here, including the decision to answer
//     a permission request the user will never see. A caller that read `byId`
//     itself would be reading a snapshot: an `open` dispatched in the same
//     commit is not visible until React re-renders, so a legitimate request
//     arriving in that window would be judged unroutable and rejected. The
//     reducer sees every dispatch that preceded it, so it cannot make that
//     mistake — it records the rejection as a pending EFFECT
//     (`pendingRejects`) that the provider performs and then acknowledges.
//   * Residency is BOUNDED, not permanent. Every resident session costs the
//     engine a provider registry, a tool registry, a backup manager, its whole
//     transcript, and one child process per configured MCP server — so
//     clicking through fifty history rows used to pin fifty live runtimes for
//     the engine's lifetime. planEviction below decides who goes;
//     SessionsProvider does the closing. What eviction must never break is the
//     property that made permanence safe in the first place: a session that is
//     running, or that is sitting on an unanswered permission request, stays
//     reachable. Everything else is recoverable — re-selecting an evicted
//     session simply loads it again into a fresh slot.

import type {
  McpServerStatus,
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
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      /** Option id it was answered with, "cancelled" once the turn ended
       * without an answer, or undefined while it is still open. */
      resolved?: string;
      /** True when this app answered on the user's behalf rather than the
       * user answering it. Rendered differently: a refusal nobody asked for
       * has to look like one. */
      auto?: boolean;
    };

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
  /** Monotonic stamp of when this slot was last the visible one. Only ever
   * compared, never displayed — it is the recency order eviction works from,
   * and a slot is stamped on open so a session the user just created is never
   * the coldest thing in the store. */
  viewSeq: number;
  /** Whether this session was opened asking the engine for its own configured
   * MCP servers. Fixed at open: flipping the setting later cannot retrofit a
   * fleet onto a running session, and the chip must not pretend otherwise. */
  mcpInherited: boolean;
  /** This session's live MCP fleet from `_packetcode/mcp/list`. Empty for a
   * session that inherited none, and for engines without the extension.
   *
   * Deliberately per-slot rather than a global cache keyed by session id: it
   * is a property of a live runtime, so it must die with the slot. A session
   * the engine has evicted has no fleet, and stale entries in a longer-lived
   * cache would outlive the processes they describe. */
  mcpServers: McpServerStatus[];
}

/** A permission reply the reducer decided on but cannot perform: reducers are
 * pure, so the engine call is left to the provider, which replies once per
 * `token` and then dispatches `rejects_flushed`. */
export interface PendingReject {
  token: string;
  requestId: string | number;
  optionId: string;
}

/** Something that happened without the user asking, that no timeline could
 * carry on its own — today, a permission request this app answered (or failed
 * to answer) for a session it does not hold. Surfaced as a dismissible toast:
 * a tool call refused on the user's behalf must never be silent. */
export interface Notice {
  id: string;
  /** `auto_rejected`: the engine's own rejection option was sent.
   *  `unanswerable`: no option could be classified as a rejection, so nothing
   *  was sent and the engine's turn may still be blocked. */
  kind: "auto_rejected" | "unanswerable";
  sessionId: string;
  /** Title of the tool call the engine wanted permission for. */
  title: string;
}

export interface StoreState {
  entries: Record<SessionKey, SessionEntry>;
  /** sessionId -> owning slot key. The fan-out index for ACP events. */
  byId: Record<string, SessionKey>;
  /** Rejections the reducer decided on, waiting for the provider to send
   * them. Drained by `rejects_flushed`. */
  pendingRejects: PendingReject[];
  /** Undismissed notices, oldest first. */
  notices: Notice[];
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
      /** Whether this session asked to inherit the engine's MCP servers. */
      inheritMcp: boolean;
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
  | { type: "error"; key: SessionKey; message: string }
  /** session/cancel itself could not be delivered — see the case below for
   * why that is the one failure allowed to close open approval cards. */
  | { type: "cancel_failed"; key: SessionKey; message: string }
  | { type: "rejects_flushed"; tokens: string[] }
  | { type: "dismiss_notice"; id: string }
  /** This slot is now the visible one: restamp its recency. */
  | { type: "touch"; key: SessionKey }
  /** Drop these slots entirely. The engine-side `session/close` is the
   * provider's job; the reducer only forgets. */
  | { type: "evict"; keys: SessionKey[] }
  | { type: "mcp_servers"; key: SessionKey; servers: McpServerStatus[] };

let nextId = 0;
const genId = () => `t${nextId++}`;
let nextViewSeq = 0;
const stampView = () => ++nextViewSeq;

export const initialStore: StoreState = {
  entries: {},
  byId: {},
  pendingRejects: [],
  notices: [],
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

/** Slot holding `sessionId` even when it is no longer in the routing index.
 * `open_failed` drops the `byId` entry (nothing may stream into a dead slot)
 * while keeping the slot itself on screen, so a late permission request for
 * that session still has a timeline to be reported in. */
function findBySessionId(state: StoreState, sessionId: string): SessionKey | null {
  for (const key of Object.keys(state.entries)) {
    const entry = getEntry(state, key);
    if (entry !== null && entry.sessionId === sessionId) return key;
  }
  return null;
}

/** Option to answer an unroutable permission request with: the explicit
 * rejection if the engine offered one, else nothing. Never an "allow": a
 * request no view will ever show must not be granted on the user's behalf.
 *
 * Defensive about shape — a newer engine may omit `kind`, and a throw on this
 * path would leave the engine blocked forever, the exact failure the
 * auto-reject exists to prevent. Never guesses positionally either: options
 * this client cannot classify get no answer at all rather than a coin flip
 * that might be an ALLOW. */
function rejectionOption(request: PermissionRequest): string | null {
  const reject = (request.options ?? []).find(
    (o) =>
      (typeof o?.kind === "string" && o.kind.startsWith("reject")) ||
      (typeof o?.optionId === "string" && o.optionId.startsWith("reject")),
  );
  return reject ? reject.optionId : null;
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

/** Whether the session still owes the engine something: a turn in flight, or
 * an approval card the engine is blocked on. One rule behind BOTH the composer
 * (Stop stays reachable, Send stays disabled) and the sidebar dot, so the two
 * cannot disagree — `busy` alone goes false on a failed prompt while an
 * unanswered card still blocks the engine's callClient, and hiding Stop there
 * removes the only affordance that frees it. */
export function isEngaged(entry: SessionEntry): boolean {
  return statusOf(entry) !== "idle";
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

/** How many IDLE sessions stay resident. Running and attention sessions are
 * additional and never counted against it — they are not spare capacity, they
 * are work in progress.
 *
 * Five is chosen for the shape of the problem rather than a measurement: the
 * cost being bounded is per-session engine state (registries, a backup
 * manager, a whole transcript, one child process per configured MCP server),
 * and the benefit being preserved is that switching back to something you were
 * just working in is instant. A working set of five covers the "flip between a
 * couple of related sessions" pattern with room to spare, while a browse
 * through fifty history rows settles at six live runtimes instead of fifty.
 * Overshooting the limit is cheap and re-loading is cheap, so there is no
 * reason to tune this finely. */
export const MAX_IDLE_RESIDENT = 5;

/** Which slots should be evicted now, given `activeKey` is the visible one.
 * Pure, so the policy can be reasoned about (and tested) without a store.
 *
 * Never returned, in order of how badly it would hurt:
 *
 *   * A session with an unanswered permission request. Its turn is blocked
 *     inside the engine waiting for an answer only this app can give, and the
 *     approval card lives in the timeline eviction would throw away.
 *   * A running session. Its updates would land in `byId` with nowhere to go.
 *   * The visible slot, whatever its state.
 *   * A slot whose open is still in flight (not ready, no error yet): dropping
 *     it would strand the session/new or session/load it is waiting on, which
 *     is precisely the leak this whole change exists to stop.
 */
export function planEviction(
  state: StoreState,
  activeKey: SessionKey | null,
  maxIdle: number = MAX_IDLE_RESIDENT,
): SessionEntry[] {
  const idle: SessionEntry[] = [];
  for (const key of Object.keys(state.entries)) {
    const entry = getEntry(state, key);
    if (entry && statusOf(entry) === "idle") idle.push(entry);
  }
  // Most recently viewed first. The visible slot was just touched, so it heads
  // the list and can never be evicted by its own activation.
  idle.sort((a, b) => b.viewSeq - a.viewSeq);
  return idle
    .slice(Math.max(0, maxIdle))
    .filter((entry) => entry.key !== activeKey && (entry.ready || entry.error !== null));
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
        viewSeq: stampView(),
        mcpInherited: action.inheritMcp,
        mcpServers: [],
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
    case "touch":
      return patch(state, action.key, (entry) => ({
        ...entry,
        viewSeq: stampView(),
      }));
    case "evict": {
      const entries = { ...state.entries };
      const byId = { ...state.byId };
      let dropped = false;
      for (const key of action.keys) {
        const entry = getEntry(state, key);
        if (!entry) continue;
        dropped = true;
        delete entries[key];
        // Only unmap ids this slot still owns: a slot that failed to load has
        // already had its routing row deleted, and the id may since have been
        // claimed by a fresh slot that must keep receiving updates.
        if (entry.sessionId !== null && byId[entry.sessionId] === key) {
          delete byId[entry.sessionId];
        }
      }
      // No listRevision bump: eviction changes nothing the engine persisted,
      // so the sidebar's history rows are exactly as they were.
      return dropped ? { ...state, entries, byId } : state;
    }
    case "mcp_servers":
      return patch(state, action.key, (entry) => ({
        ...entry,
        mcpServers: action.servers,
      }));
    case "error":
      // Deliberately does NOT settle open approval cards. An error here is a
      // failed prompt or a failed permission reply — the engine never heard
      // about it, so its callClient is still waiting on the very card that
      // would be greyed out. The card stays live (answer it, or Stop the
      // session) and `isEngaged` keeps Stop on screen to make that possible.
      return patch(state, action.key, (entry) => ({
        ...entry,
        busy: false,
        error: action.message,
      }));
    case "cancel_failed":
      // session/cancel could not even be delivered (engine gone). Nothing will
      // ever answer the open cards, so this is the one failure path where
      // settling them is the truth rather than a guess.
      return patch(state, action.key, (entry) =>
        settle({ ...entry, busy: false, error: action.message }),
      );
    case "rejects_flushed": {
      if (action.tokens.length === 0) return state;
      const sent = new Set(action.tokens);
      const remaining = state.pendingRejects.filter((r) => !sent.has(r.token));
      if (remaining.length === state.pendingRejects.length) return state;
      return { ...state, pendingRejects: remaining };
    }
    case "dismiss_notice": {
      const remaining = state.notices.filter((n) => n.id !== action.id);
      if (remaining.length === state.notices.length) return state;
      return { ...state, notices: remaining };
    }
    case "permission_request": {
      // Routed by session id, not by "the visible view": the request may well
      // belong to a session the user has switched away from. Deciding it here
      // rather than in the event handler is what makes the routing index
      // current — see the note at the top of this file.
      const request = action.request;
      const key: SessionKey | undefined = state.byId[request.sessionId];
      if (key !== undefined) {
        return patch(state, key, (entry) => ({
          ...entry,
          timeline: [
            ...entry.timeline,
            { kind: "permission", id: genId(), request },
          ],
        }));
      }
      // No slot owns this session, so no card would ever be shown and the
      // engine's turn would block forever on callClient. Answer it with the
      // engine's own rejection — and make that answer visible, because a tool
      // call refused on the user's behalf is exactly what must not happen
      // silently: in the timeline of the orphaned slot when there is one, and
      // as a notice either way (the user is, by definition, looking
      // elsewhere).
      const optionId = rejectionOption(request);
      const notice: Notice = {
        id: genId(),
        kind: optionId === null ? "unanswerable" : "auto_rejected",
        sessionId: request.sessionId,
        title: request.toolCall.title,
      };
      const queued: StoreState =
        optionId === null
          ? state
          : {
              ...state,
              pendingRejects: [
                ...state.pendingRejects,
                { token: notice.id, requestId: request.requestId, optionId },
              ],
            };
      const orphan = findBySessionId(queued, request.sessionId);
      const withCard =
        orphan === null
          ? queued
          : patch(queued, orphan, (entry) => ({
              ...entry,
              timeline: [
                ...entry.timeline,
                {
                  kind: "permission",
                  id: genId(),
                  request,
                  resolved: optionId ?? "unanswered",
                  auto: true,
                },
              ],
            }));
      return { ...withCard, notices: [...withCard.notices, notice] };
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

/** Close out approval cards that can no longer be answered, so a finished
 * session does not sit amber in the sidebar forever.
 *
 * Only ever reached from a state where "cancelled" is TRUE rather than merely
 * convenient: `turn_done` (the engine ended the turn, so it either got its
 * answer or the bridge answered "cancelled" for it during session/cancel) and
 * `cancel_failed` (the engine is unreachable, so nothing is listening). Every
 * other failure leaves the card open — greying it out would claim the request
 * is dead while the engine is still blocked on it, and would take the Stop
 * button away with it. */
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
