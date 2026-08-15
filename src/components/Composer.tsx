import { useEffect, useState } from "react";
import type { ModelOption, PermissionMode } from "../acp/types";
import { projectName } from "../project/projects";

const optionKey = (m: ModelOption) => `${m.provider}/${m.model}`;

/** The five per-session permission modes, in escalation order. Tones map to
 * the semantic accents in tokens.css. */
const PERMISSION_MODES: Array<{
  id: PermissionMode;
  label: string;
  desc: string;
  tone: "green" | "amber" | "blue" | "red";
}> = [
  {
    id: "read-only",
    label: "Read-only",
    desc: "Read and search only; edits and shell denied",
    tone: "green",
  },
  {
    id: "ask",
    label: "Ask",
    desc: "Prompts before edits, shell, and MCP",
    tone: "amber",
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    desc: "File edits run; shell and MCP prompt",
    tone: "amber",
  },
  {
    id: "auto",
    label: "Auto",
    desc: "Edits and shell run; MCP prompts",
    tone: "blue",
  },
  {
    id: "bypass",
    label: "Bypass",
    desc: "Every tool runs without prompting",
    tone: "red",
  },
];

const modeInfo = (id: PermissionMode) =>
  PERMISSION_MODES.find((m) => m.id === id) ?? PERMISSION_MODES[1];

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
  /** Directory this session runs in; null when no project is open yet. */
  projectDir: string | null;
  /** Blocks input entirely (no project selected). */
  disabled?: boolean;
  /** Mode the ACTIVE session was created with; null = engine default (ask). */
  sessionPermissionMode: PermissionMode | null;
  /** Pending mode for the NEXT session; null = engine default (ask). */
  permissionMode: PermissionMode | null;
  onPermissionMode: (m: PermissionMode) => void;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const disabled = props.disabled ?? false;

  useEffect(() => {
    if (!pickerOpen && !modeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickerOpen(false);
        setModeOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, modeOpen]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.busy || disabled) return;
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

  // The chip reflects the mode the active session actually runs under; the
  // checkmark reflects what the next session will use. Engine default is ask.
  const activeMode = modeInfo(props.sessionPermissionMode ?? "ask");
  const pendingMode = props.permissionMode ?? "ask";

  const chooseMode = (m: PermissionMode) => {
    props.onPermissionMode(m);
    setModeOpen(false);
  };

  return (
    <div className="composer-zone">
      <div className="composer">
        <div className="context-strip">
          {props.projectDir !== null ? (
            <span className="context-chip" title={props.projectDir}>
              {projectName(props.projectDir)}
            </span>
          ) : (
            <span className="context-chip">no project</span>
          )}
          <span className="context-chip">Local</span>
        </div>
        <div className="input-card">
          <textarea
            placeholder={
              disabled
                ? "Open a project to start a session"
                : "Do anything — / for commands, @ for files"
            }
            disabled={disabled}
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
            <div className="mode-picker">
              <button
                className={`mode-chip tone-${activeMode.tone}`}
                onClick={() => setModeOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
              >
                {activeMode.label}
                <span className="mode-caret">▾</span>
              </button>
              {modeOpen ? (
                <>
                  <div
                    className="model-backdrop"
                    onClick={() => setModeOpen(false)}
                  />
                  <div className="model-pop mode-pop" role="listbox">
                    <div className="model-pop-hint">
                      Permission mode — applies to new sessions
                    </div>
                    {PERMISSION_MODES.map((m) => {
                      const selected = m.id === pendingMode;
                      return (
                        <button
                          key={m.id}
                          className={
                            selected
                              ? `mode-opt selected tone-${m.tone}`
                              : `mode-opt tone-${m.tone}`
                          }
                          role="option"
                          aria-selected={selected}
                          onClick={() => chooseMode(m.id)}
                        >
                          <span className={`mode-dot tone-${m.tone}`} />
                          <span className="mode-opt-body">
                            <span className="mode-opt-label">{m.label}</span>
                            <span className="mode-opt-desc">{m.desc}</span>
                            {m.id === "bypass" ? (
                              <span className="mode-opt-warning">
                                No approval prompts at all — only for
                                workspaces you fully trust.
                              </span>
                            ) : null}
                          </span>
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
                disabled={props.busy || disabled || !text.trim()}
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
