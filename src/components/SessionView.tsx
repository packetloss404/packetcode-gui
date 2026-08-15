import { useEffect } from "react";
import { useSession } from "../session/useSession";
import { Composer } from "./Composer";
import { TimelineItemView } from "./TimelineItemView";

export function SessionView(props: {
  cwd: string;
  onSessionReady: (id: string) => void;
}) {
  const { state, send, stop, answerPermission } = useSession(props.cwd);
  const { onSessionReady } = props;

  useEffect(() => {
    if (state.sessionId) onSessionReady(state.sessionId);
  }, [state.sessionId, onSessionReady]);

  return (
    <section className="content">
      <header className="session-head">
        <h1>Session</h1>
        <span className="chip">{props.cwd}</span>
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
      <Composer busy={state.busy} onSend={send} onStop={stop} />
    </section>
  );
}
