import { useEffect, useState } from "react";
import type { ModelOption, PermissionMode, SessionUsage } from "../acp/types";
import { projectName } from "../project/projects";

const optionKey = (m: ModelOption) => `${m.provider}/${m.model}`;

/** Compact token count: 820 -> "820", 41234 -> "41.2k", 1200000 -> "1.2M".
 * The M threshold sits just below 1M so 999,950+ rounds to "1M", not "1000k". */
function fmtTokens(n: number): string {
  const scaled = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(1);
    return text + suffix;
  };
  if (n >= 999_950) return scaled(n / 1_000_000, "M");
  if (n >= 1000) return scaled(n / 1000, "k");
  return String(n);
}

/** "$1.84"; sub-cent spend keeps a third digit, and anything below a tenth of
 * a cent shows as "<$0.001" rather than a misleading zero. */
function fmtCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0005) return `$${usd.toFixed(3)}`;
  return "<$0.001";
}

/** `ctx 41.2k tok · in 82k · out 12k · $1.84`, omitting unknown/zero
 * segments; null when there is nothing to show. */
export function usageStatusline(usage: SessionUsage | null): string | null {
  if (!usage) return null;
  const segments: string[] = [];
  if (usage.contextTokens > 0) segments.push(`ctx ${fmtTokens(usage.contextTokens)} tok`);
  if (usage.totalInput > 0) segments.push(`in ${fmtTokens(usage.totalInput)}`);
  if (usage.totalOutput > 0) segments.push(`out ${fmtTokens(usage.totalOutput)}`);
  if (usage.costUsd > 0) segments.push(fmtCost(usage.costUsd));
  return segments.length > 0 ? segments.join(" · ") : null;
}

/** The permission-mode vocabulary this client can render, in escalation
 * order. Which of these are actually OFFERED is decided by the engine's
 * advertised list; tones map to the semantic accents in tokens.css. */
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

/** Renderable metadata for an engine-advertised mode id, or null when the
 * engine named something this client has no wording for. */
const knownMode = (id: string | null) =>
  PERMISSION_MODES.find((m) => m.id === id) ?? null;

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
  /** Mode the ACTIVE session was created with; null = the engine's default. */
  sessionPermissionMode: PermissionMode | null;
  /** Pending mode for the NEXT session; null = the engine's default. */
  permissionMode: PermissionMode | null;
  onPermissionMode: (m: PermissionMode) => void;
  /** Modes `session/new` accepts, from the initialize handshake. Anything
   * outside this set fails -32602, so it must not be offered. Null means the
   * engine did not say and all known modes stay available. */
  allowedPermissionModes: string[] | null;
  /** Mode a session with no override resolves to; null when not advertised —
   * the chip then says "engine default" instead of naming a mode. */
  engineDefaultMode: string | null;
  /** Token/cost usage for the ACTIVE session; null hides the statusline. */
  usage: SessionUsage | null;
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

  // Only advertised modes are offered — requesting a mode above the engine's
  // ceiling fails -32602. An engine that named only modes this client cannot
  // render falls back to the full list rather than an empty menu.
  const allowed = props.allowedPermissionModes;
  const offered =
    allowed === null
      ? PERMISSION_MODES
      : PERMISSION_MODES.filter((m) => allowed.includes(m.id));
  const modes = offered.length > 0 ? offered : PERMISSION_MODES;
  const restricted = modes.length < PERMISSION_MODES.length;

  // The chip reflects the mode the active session actually runs under: its
  // explicit override, else the engine's advertised default. When the engine
  // advertises no default there is nothing honest to name, so the chip says
  // "engine default" rather than claiming "Ask".
  const engineDefault = knownMode(props.engineDefaultMode);
  const activeMode =
    props.sessionPermissionMode !== null
      ? modeInfo(props.sessionPermissionMode)
      : engineDefault;
  // The checkmark reflects what the next session will use.
  const pendingMode = props.permissionMode ?? engineDefault?.id ?? null;

  const chooseMode = (m: PermissionMode) => {
    props.onPermissionMode(m);
    setModeOpen(false);
  };

  const statusline = usageStatusline(props.usage);

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
                className={
                  activeMode ? `mode-chip tone-${activeMode.tone}` : "mode-chip"
                }
                onClick={() => setModeOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
              >
                {activeMode ? activeMode.label : "Engine default"}
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
                      {restricted ? " · limited by the engine" : ""}
                    </div>
                    {modes.map((m) => {
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
                            {engineDefault !== null && m.id === engineDefault.id ? (
                              <span className="mode-opt-default">
                                engine default
                              </span>
                            ) : null}
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
              {/* No catalog means the engine has no models/list extension (or
                  advertised none): a disabled chip would just be noise, so the
                  picker is hidden entirely. */}
              {hasCatalog ? (
                <div className="model-picker">
                  <button
                    className="model-btn"
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
                    <span className="model-caret">▾</span>
                  </button>
                  {pickerOpen ? (
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
              ) : null}
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
      {statusline ? (
        <div className="statusline">
          <span>{statusline}</span>
        </div>
      ) : null}
    </div>
  );
}
