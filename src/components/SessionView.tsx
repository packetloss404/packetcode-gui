// A window onto one slot of the session store. The view owns nothing but the
// composer's local text: mounting it attaches the slot (once), and unmounting
// it leaves the session running.

import { useCallback, useEffect, useRef } from "react";
import type { ModelOption, PermissionMode } from "../acp/types";
import { projectName } from "../project/projects";
import { useSessions } from "../session/SessionsProvider";
import { getEntry, resolveKey, type SessionTarget } from "../session/store";
import { Composer } from "./Composer";
import { TimelineItemView } from "./TimelineItemView";

export function SessionView(props: {
  cwd: string;
  target: SessionTarget;
  models: ModelOption[];
  modelChoice: ModelOption | null;
  onModelChoice: (m: ModelOption) => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (m: PermissionMode) => void;
}) {
  const { state, open, send, stop, answerPermission } = useSessions();
  // Latest picker choices, readable without retriggering session creation:
  // changing a picker must never tear down or re-create a live session — the
  // choices only apply to the next session opened.
  const choiceRef = useRef<ModelOption | null>(props.modelChoice);
  choiceRef.current = props.modelChoice;
  const modeRef = useRef<PermissionMode | null>(props.permissionMode);
  modeRef.current = props.permissionMode;

  const key = resolveKey(state, props.target);
  const entry = getEntry(state, key);
  const { cwd, target } = props;

  useEffect(() => {
    // Idempotent per slot: re-entering a session already in the store does not
    // re-issue session/load, which would replay its transcript a second time.
    open(key, target, cwd, choiceRef.current, modeRef.current);
  }, [open, key, target, cwd]);

  const onSend = useCallback((text: string) => send(key, text), [send, key]);
  const onStop = useCallback(() => stop(key), [stop, key]);
  const onPermission = useCallback(
    (requestId: string | number, optionId: string) =>
      answerPermission(key, requestId, optionId),
    [answerPermission, key],
  );

  const shownCwd =
    props.target.kind === "load" && props.target.workingDir
      ? props.target.workingDir
      : props.cwd;

  return (
    <section className="content">
      <header className="session-head">
        <h1>Session</h1>
        <span className="chip" title={shownCwd}>
          {projectName(shownCwd)}
        </span>
      </header>
      <div className="chat">
        <div className="flow selectable">
          {(entry?.timeline ?? []).map((item) => (
            <TimelineItemView
              key={item.id}
              item={item}
              onPermission={onPermission}
            />
          ))}
          {entry?.error ? (
            <div className="thought">engine error: {entry.error}</div>
          ) : null}
        </div>
      </div>
      <Composer
        busy={entry?.busy ?? false}
        onSend={onSend}
        onStop={onStop}
        models={props.models}
        sessionModel={entry?.model ?? null}
        modelChoice={props.modelChoice}
        onModelChoice={props.onModelChoice}
        projectDir={shownCwd}
        sessionPermissionMode={entry?.permissionMode ?? null}
        permissionMode={props.permissionMode}
        onPermissionMode={props.onPermissionMode}
        usage={entry?.usage ?? null}
      />
    </section>
  );
}
