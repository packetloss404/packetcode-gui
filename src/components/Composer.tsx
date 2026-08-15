import { useState } from "react";

export function Composer(props: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const t = text.trim();
    if (!t || props.busy) return;
    setText("");
    props.onSend(t);
  };

  return (
    <div className="composer-zone">
      <div className="composer">
        <div className="context-strip">
          <span className="context-chip">packetcode-gui</span>
          <span className="context-chip">Local</span>
          <span className="context-chip mono">main</span>
        </div>
        <div className="input-card">
          <textarea
            placeholder="Do anything — / for commands, @ for files"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-row">
            <button className="mode-chip">Ask</button>
            {props.busy ? (
              <button className="btn" onClick={props.onStop}>
                Stop
              </button>
            ) : null}
            <div className="composer-right">
              <span className="model-label">
                <b>engine default</b>
              </span>
              <button
                className="send-btn"
                onClick={submit}
                disabled={props.busy || !text.trim()}
                aria-label="Send"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
