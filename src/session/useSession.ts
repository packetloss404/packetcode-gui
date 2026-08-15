// Session stream state: reduces ACP session/update notifications into a
// renderable timeline. One hook instance per open session.

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  cancel as acpCancel,
  newSession,
  onPermissionRequest,
  onSessionUpdate,
  prompt,
  replyPermission,
} from "../acp/client";
import type {
  PermissionRequest,
  PlanEntry,
  SessionUpdate,
  ToolCallStatus,
  ToolKind,
} from "../acp/types";

export type TimelineItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent_text"; id: string; text: string }
  | { kind: "agent_thought"; id: string; text: string }
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
  timeline: TimelineItem[];
  plan: PlanEntry[];
  busy: boolean;
  error: string | null;
}

type Action =
  | { type: "session_ready"; sessionId: string }
  | { type: "user_prompt"; text: string }
  | { type: "acp_update"; update: SessionUpdate }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: number; optionId: string }
  | { type: "turn_done" }
  | { type: "error"; message: string };

let nextId = 0;
const genId = () => `t${nextId++}`;

const initial: SessionState = {
  sessionId: null,
  timeline: [],
  plan: [],
  busy: false,
  error: null,
};

function reduce(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "session_ready":
      return { ...state, sessionId: action.sessionId };
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
    case "agent_message_chunk":
      return appendText(state, "agent_text", update.content.text);
    case "agent_thought_chunk":
      return appendText(state, "agent_thought", update.content.text);
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
  kind: "agent_text" | "agent_thought",
  text: string,
): SessionState {
  const last = state.timeline[state.timeline.length - 1];
  if (last && last.kind === kind) {
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
    timeline: [...state.timeline, { kind, id: genId(), text }],
  };
}

export function useSession(cwd: string) {
  const [state, dispatch] = useReducer(reduce, initial);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];

    (async () => {
      try {
        const id = await newSession(cwd);
        if (disposed) return;
        dispatch({ type: "session_ready", sessionId: id });
        unsubs.push(
          await onSessionUpdate((n) => {
            if (n.sessionId === sessionRef.current) {
              dispatch({ type: "acp_update", update: n.update });
            }
          }),
        );
        unsubs.push(
          await onPermissionRequest((r) => {
            if (r.sessionId === sessionRef.current) {
              dispatch({ type: "permission_request", request: r });
            }
          }),
        );
      } catch (e) {
        dispatch({ type: "error", message: String(e) });
      }
    })();

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [cwd]);

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
    async (requestId: number, optionId: string) => {
      await replyPermission(requestId, optionId);
      dispatch({ type: "permission_resolved", requestId, optionId });
    },
    [],
  );

  return { state, send, stop, answerPermission };
}
