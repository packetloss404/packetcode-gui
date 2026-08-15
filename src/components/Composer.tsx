import { useEffect, useState } from "react";
import type { ModelOption } from "../acp/types";

const optionKey = (m: ModelOption) => `${m.provider}/${m.model}`;

export function Composer(props: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Catalog from _packetcode/models/list; empty on older engines. */
  models: ModelOption[];
  /** Override the ACTIVE session was created with; null = engine default. */
  sessionModel: ModelOption | null;
  /** Pending choice for the NEXT session; null = engine default. */
  modelChoice: ModelOption | null;
  onModelChoice: (m: ModelOption) => void;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.busy) return;
    setText("");
    props.onSend(t);
  };

  // The label reflects what the active session actually runs on: its
  // explicit override, else the engine's default catalog entry.
  const active =
    props.sessionModel ?? props.models.find((m) => m.default) ?? null;
  // The checkmark reflects what the next session will use.
  const pending = props.modelChoice ?? props.models.find((m) => m.default) ?? null;
  const hasCatalog = props.models.length > 0;

  const choose = (m: ModelOption) => {
    props.onModelChoice(m);
    setPickerOpen(false);
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
              <div className="model-picker">
                <button
                  className="model-btn"
                  disabled={!hasCatalog}
                  onClick={() => setPickerOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                >
                  <span className="model-label">
                    {active ? (
                      <>
                        <span className="model-provider">{active.provider}</span>{" "}
                        <b>{active.model}</b>
                      </>
                    ) : (
                      <b>engine default</b>
                    )}
                  </span>
                  {hasCatalog ? <span className="model-caret">▾</span> : null}
                </button>
                {pickerOpen && hasCatalog ? (
                  <>
                    <div
                      className="model-backdrop"
                      onClick={() => setPickerOpen(false)}
                    />
                    <div className="model-pop" role="listbox">
                      <div className="model-pop-hint">
                        Applies to new sessions
                      </div>
                      {props.models.map((m) => {
                        const selected =
                          pending !== null && optionKey(m) === optionKey(pending);
                        return (
                          <button
                            key={optionKey(m)}
                            className={
                              selected ? "model-opt selected" : "model-opt"
                            }
                            role="option"
                            aria-selected={selected}
                            onClick={() => choose(m)}
                          >
                            <span className="model-opt-provider">
                              {m.provider}
                            </span>
                            <span className="model-opt-model">{m.model}</span>
                            {selected ? (
                              <span className="model-opt-check">✓</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}
              </div>
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
