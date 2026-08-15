import { useCallback, useEffect, useRef } from "react";
import type { ModelOption } from "../acp/types";
import { useSession, type SessionTarget } from "../session/useSession";
import { Composer } from "./Composer";
import { TimelineItemView } from "./TimelineItemView";

export function SessionView(props: {
  cwd: string;
  target: SessionTarget;
  onSessionReady: (id: string) => void;
  models: ModelOption[];
  modelChoice: ModelOption | null;
  onModelChoice: (m: ModelOption) => void;
}) {
  // Latest picker choice, readable without retriggering session creation.
  const choiceRef = useRef<ModelOption | null>(props.modelChoice);
  choiceRef.current = props.modelChoice;
  const getModelChoice = useCallback(() => choiceRef.current, []);

  const { state, send, stop, answerPermission } = useSession(
    props.cwd,
    props.target,
    getModelChoice,
  );
  const { onSessionReady } = props;

  useEffect(() => {
    if (state.sessionId) onSessionReady(state.sessionId);
  }, [state.sessionId, onSessionReady]);

  const shownCwd =
    props.target.kind === "load" && props.target.workingDir
      ? props.target.workingDir
      : props.cwd;

  return (
    <section className="content">
      <header className="session-head">
        <h1>Session</h1>
        <span className="chip">{shownCwd}</span>
      </header>
      <div className="chat">
        <div className="flow selectable">
          {state.timeline.map((item) => (
            <TimelineItemView
              key={item.id}
              item={item}
              onPermission={answerPermission}
            />
          ))}
          {state.error ? (
            <div className="thought">engine error: {state.error}</div>
          ) : null}
        </div>
      </div>
      <Composer
        busy={state.busy}
        onSend={send}
        onStop={stop}
        models={props.models}
        sessionModel={state.model}
        modelChoice={props.modelChoice}
        onModelChoice={props.onModelChoice}
        usage={state.usage}
      />
    </section>
  );
}
