// Session stream state: reduces ACP session/update notifications into a
// renderable timeline. One hook instance per open session.

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  cancel as acpCancel,
  loadSession,
  newSession,
  onPermissionRequest,
  onSessionUpdate,
  prompt,
  replyPermission,
} from "../acp/client";
import type {
  ModelOption,
  PermissionRequest,
  PlanEntry,
  SessionUpdate,
  ToolCallStatus,
  ToolKind,
} from "../acp/types";

/** What this view should attach to: a fresh session, or a persisted one
 * resumed via ACP session/load (which replays its transcript). The nonce
 * makes each "+ New session" click a distinct target, so a fresh session is
 * created (with the current model choice) instead of reusing the old one. */
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

export interface SessionState {
  sessionId: string | null;
  /** Provider/model this session was created with; null = engine default. */
  model: ModelOption | null;
  timeline: TimelineItem[];
  plan: PlanEntry[];
  busy: boolean;
  error: string | null;
}

type Action =
  | { type: "session_ready"; sessionId: string; model: ModelOption | null }
  | { type: "user_prompt"; text: string }
  | { type: "acp_update"; update: SessionUpdate }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string | number; optionId: string }
  | { type: "turn_done" }
  | { type: "error"; message: string };

let nextId = 0;
const genId = () => `t${nextId++}`;

const initial: SessionState = {
  sessionId: null,
  model: null,
  timeline: [],
  plan: [],
  busy: false,
  error: null,
};

function reduce(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "session_ready":
      return { ...state, sessionId: action.sessionId, model: action.model };
    case "user_prompt":
      return {
        ...state,
        busy: true,
        timeline: [...state.timeline, { kind: "user", id: genId(), text: action.text }],
      };
    case "turn_done":
      return { ...state, busy: false };
    case "error":
      return { ...state, busy: false, error: action.message };
    case "permission_request":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: "permission", id: genId(), request: action.request },
        ],
      };
    case "permission_resolved":
      return {
        ...state,
        timeline: state.timeline.map((item) =>
          item.kind === "permission" && item.request.requestId === action.requestId
            ? { ...item, resolved: action.optionId }
            : item,
        ),
      };
    case "acp_update":
      return applyUpdate(state, action.update);
  }
}

function applyUpdate(state: SessionState, update: SessionUpdate): SessionState {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // Only emitted during session/load replay; live prompts are echoed
      // locally by the user_prompt action.
      return appendText(state, "user", update.content.text, update.messageId);
    case "agent_message_chunk":
      return appendText(state, "agent_text", update.content.text, update.messageId);
    case "agent_thought_chunk":
      return appendText(state, "agent_thought", update.content.text, update.messageId);
    case "plan":
      return { ...state, plan: update.entries };
    case "tool_call":
      return {
        ...state,
        timeline: [
          ...state.timeline,
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
        ...state,
        timeline: state.timeline.map((item) =>
          item.kind === "tool" && item.toolCallId === update.toolCallId
            ? {
                ...item,
                status: update.status ?? item.status,
                output: chunk ? item.output + chunk : item.output,
              }
            : item,
        ),
      };
    }
  }
}

function appendText(
  state: SessionState,
  kind: "user" | "agent_text" | "agent_thought",
  text: string,
  messageId?: string,
): SessionState {
  const last = state.timeline[state.timeline.length - 1];
  // Merge only chunks of the same message: replayed turns carry distinct
  // messageIds so two adjacent stored messages stay separate bubbles.
  if (last && last.kind === kind && last.messageId === messageId) {
    return {
      ...state,
      timeline: [
        ...state.timeline.slice(0, -1),
        { ...last, text: last.text + text },
      ],
    };
  }
  return {
    ...state,
    timeline: [...state.timeline, { kind, id: genId(), text, messageId }],
  };
}

export function useSession(
  cwd: string,
  target: SessionTarget,
  // Read once per session creation. A stable getter (not a value) so that
  // changing the picker never tears down the running session — the choice
  // only applies to the next session this hook creates.
  getModelChoice?: () => ModelOption | null,
) {
  const [state, dispatch] = useReducer(reduce, initial);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;
  const busyRef = useRef(false);
  busyRef.current = state.busy;

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    // In load mode the sessionId is known before the request returns, and
    // replay updates arrive while session/load is still in flight — filter on
    // the known id so they are not dropped.
    const knownId = target.kind === "load" ? target.sessionId : null;
    const matches = (sessionId: string) =>
      sessionId === (sessionRef.current ?? knownId);

    (async () => {
      try {
        // Subscribe before touching the engine: session/load replays history
        // during the request and events without a listener are lost.
        unsubs.push(
          await onSessionUpdate((n) => {
            if (!disposed && matches(n.sessionId)) {
              dispatch({ type: "acp_update", update: n.update });
            }
          }),
        );
        unsubs.push(
          await onPermissionRequest((r) => {
            if (!disposed && matches(r.sessionId)) {
              dispatch({ type: "permission_request", request: r });
            }
          }),
        );
        if (disposed) return;
        if (target.kind === "load") {
          // session_ready only after the load succeeds: a failed load must
          // not leave a promptable session pointing at unseen context.
          // Resumed sessions keep the provider/model they were created with;
          // the picker's pending choice applies only to fresh sessions.
          await loadSession(target.sessionId, target.workingDir || cwd);
          if (disposed) return;
          dispatch({ type: "session_ready", sessionId: target.sessionId, model: null });
        } else {
          const choice = getModelChoice?.() ?? null;
          const id = await newSession(cwd, choice?.provider, choice?.model);
          if (disposed) return;
          dispatch({ type: "session_ready", sessionId: id, model: choice });
        }
      } catch (e) {
        if (!disposed) dispatch({ type: "error", message: String(e) });
      }
    })();

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      // Switching away mid-turn must not strand the old session: an
      // unanswered permission request blocks the engine's turn forever and
      // every later session/load of it returns busy. engine_cancel also
      // answers outstanding permission requests with "cancelled".
      if (busyRef.current && sessionRef.current) {
        void acpCancel(sessionRef.current);
      }
    };
  }, [cwd, target, getModelChoice]);

  const send = useCallback(async (text: string) => {
    const id = sessionRef.current;
    if (!id) return;
    dispatch({ type: "user_prompt", text });
    try {
      await prompt(id, text);
    } catch (e) {
      dispatch({ type: "error", message: String(e) });
      return;
    }
    dispatch({ type: "turn_done" });
  }, []);

  const stop = useCallback(() => {
    const id = sessionRef.current;
    if (id) void acpCancel(id);
  }, []);

  const answerPermission = useCallback(
    async (requestId: string | number, optionId: string) => {
      await replyPermission(requestId, optionId);
      dispatch({ type: "permission_resolved", requestId, optionId });
    },
    [],
  );

  return { state, send, stop, answerPermission };
}
