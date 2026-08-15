import type { TimelineItem } from "../session/store";
import { Markdown } from "./Markdown";

export function TimelineItemView(props: {
  item: TimelineItem;
  onPermission: (requestId: string | number, optionId: string) => void;
}) {
  const { item } = props;

  switch (item.kind) {
    case "user":
      return <div className="user-msg">{item.text}</div>;
    case "agent_thought":
      return <p className="thought">{item.text}</p>;
    case "agent_text":
      return (
        <div className="turn">
          <Markdown text={item.text} />
        </div>
      );
    case "tool":
      return (
        <div className="tool-card">
          <div className="tool-card-head">
            <span className="tool-kind">{item.toolKind}</span>
            <span className="tool-title">{item.title}</span>
            <span className={`tool-status ${item.status}`}>{item.status}</span>
          </div>
          {item.output ? <pre className="tool-output">{item.output}</pre> : null}
        </div>
      );
    case "permission":
      return (
        <div className="approval">
          <div className="approval-label">Permission required</div>
          <div className="approval-target">{item.request.toolCall.title}</div>
          {item.resolved ? (
            <div className="thought">answered: {item.resolved}</div>
          ) : (
            <div className="approval-actions">
              {item.request.options.map((o) => (
                <button
                  key={o.optionId}
                  className={o.optionId.startsWith("allow") ? "btn primary" : "btn"}
                  onClick={() =>
                    props.onPermission(item.request.requestId, o.optionId)
                  }
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      );
  }
}
