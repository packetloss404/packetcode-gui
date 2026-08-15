import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelOption,
  PermissionMode,
  SessionUsage,
  SlashCommand,
} from "../acp/types";
import { listCommands, searchFiles } from "../acp/client";
import { projectName } from "../project/projects";
import { McpChip, type McpPanelProps } from "./McpDisclosure";

const optionKey = (m: ModelOption) => `${m.provider}/${m.model}`;

/** Rows the autocomplete popover will show at once. File results are already
 * capped by the bridge; this bounds the command list too. */
const MAX_MENU_ITEMS = 20;

/** How long the composer waits after a keystroke before asking the engine for
 * file matches. Long enough that a fast typist makes one round trip per word,
 * short enough that the menu still feels live. */
const FILE_QUERY_DEBOUNCE_MS = 120;

/** What the caret is currently sitting inside, if anything completable.
 * `start`/`end` bracket the token to be replaced, including its sigil. */
export type CompletionTrigger = {
  kind: "command" | "file";
  query: string;
  start: number;
  end: number;
};

/** Finds the completable token ending at the caret.
 *
 * "/" only triggers at the very start of the input — a command invocation is
 * the whole prompt, and this keeps "and/or" or a pasted path from opening the
 * menu mid-sentence. "@" triggers anywhere it follows whitespace or the start
 * of input, so an email address or a decorator does not. Both stop at the
 * first space, so once the token is complete the menu closes on its own. */
export function detectTrigger(
  text: string,
  caret: number,
): CompletionTrigger | null {
  const before = text.slice(0, caret);
  const command = /^\/([A-Za-z0-9_-]*)$/.exec(before);
  if (command) {
    return { kind: "command", query: command[1], start: 0, end: caret };
  }
  const file = /(?:^|\s)@(\S*)$/.exec(before);
  if (file) {
    return {
      kind: "file",
      query: file[1],
      start: caret - file[1].length - 1,
      end: caret,
    };
  }
  return null;
}

/** Ranks commands for a "/" query the way the engine ranks files: name
 * prefixes first, then anything matching name or description, each tier
 * lexical. An empty query keeps the engine's order. */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return commands.slice(0, MAX_MENU_ITEMS);
  const prefix: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(c);
    else if (
      name.includes(needle) ||
      c.description.toLowerCase().includes(needle)
    )
      rest.push(c);
  }
  const byName = (a: SlashCommand, b: SlashCommand) =>
    a.name.localeCompare(b.name);
  prefix.sort(byName);
  rest.sort(byName);
  return [...prefix, ...rest].slice(0, MAX_MENU_ITEMS);
}

/** The placeholder must not promise an affordance this engine cannot serve:
 * an engine predating the extensions answers method-not-found, which the
 * bridge maps to an empty list, and an engine with no command files has
 * nothing to offer either. Both degrade to the bare prompt. */
export function composerPlaceholder(
  hasCommands: boolean,
  hasFiles: boolean,
): string {
  if (hasCommands && hasFiles) return "Do anything — / for commands, @ for files";
  if (hasCommands) return "Do anything — / for commands";
  if (hasFiles) return "Do anything — @ for files";
  return "Do anything";
}

/** One popover row. `value` is spliced into the buffer; `label` and `desc`
 * are display only. */
type MenuItem = { value: string; label: string; hint?: string; desc?: string };

/** "src/components/Composer.tsx" -> { label: "Composer.tsx", desc: "src/components" },
 * so identically-named files in different folders stay distinguishable. */
function fileMenuItem(rel: string): MenuItem {
  const cut = rel.lastIndexOf("/");
  return {
    value: rel,
    label: cut === -1 ? rel : rel.slice(cut + 1),
    desc: cut === -1 ? "" : rel.slice(0, cut),
  };
}

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
  /** MCP disclosure for the ACTIVE session; null hides the chip. */
  mcp: McpPanelProps | null;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const disabled = props.disabled ?? false;

  // --- autocomplete ------------------------------------------------------
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  // Escape hides the menu without clearing the token; the next keystroke
  // brings it back.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // The unfiltered head of the project's file list. It doubles as the "@"
  // menu's initial contents and as the probe for whether this engine serves
  // file search at all, so opening the menu costs no extra round trip.
  const [fileSeed, setFileSeed] = useState<string[]>([]);
  const [fileHits, setFileHits] = useState<string[]>([]);

  const cwd = props.projectDir;

  // Ask the engine what it can offer for this project. Both calls resolve to
  // an empty list on engines without the extensions, so failures here only
  // ever mean "no menu", never a broken composer.
  useEffect(() => {
    if (cwd === null) {
      setCommands([]);
      setFileSeed([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [cmds, seed] = await Promise.all([
        listCommands(cwd).catch(() => [] as SlashCommand[]),
        searchFiles(cwd, "").catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      setCommands(cmds);
      setFileSeed(seed);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const trigger = disabled ? null : detectTrigger(text, caret);
  const triggerKind = trigger?.kind ?? null;
  const triggerQuery = trigger?.query ?? "";

  // File matching is the engine's job (it owns the ignore rules), so each
  // query is a round trip — debounced, and superseded by the next keystroke.
  useEffect(() => {
    if (triggerKind !== "file" || cwd === null) return;
    if (triggerQuery === "") {
      setFileHits(fileSeed);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchFiles(cwd, triggerQuery)
        .then((hits) => {
          if (!cancelled) setFileHits(hits);
        })
        .catch(() => {
          if (!cancelled) setFileHits([]);
        });
    }, FILE_QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [triggerKind, triggerQuery, cwd, fileSeed]);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (triggerKind === null) return [];
    if (triggerKind === "command") {
      return filterCommands(commands, triggerQuery).map((c) => ({
        value: c.name,
        label: `/${c.name}`,
        hint: c.argumentHint,
        desc: c.description,
      }));
    }
    return fileHits.slice(0, MAX_MENU_ITEMS).map(fileMenuItem);
  }, [triggerKind, triggerQuery, commands, fileHits]);

  const menuOpen = !menuDismissed && menuItems.length > 0;
  // Clamp rather than reset: as the query narrows the list, keeping the
  // cursor near where the user left it is less jarring than snapping to 0.
  const activeIndex = Math.min(menuIndex, menuItems.length - 1);

  // Keep the keyboard cursor visible: the popover scrolls past ~8 rows.
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, menuOpen]);

  /** Splices the chosen completion over the trigger token and puts the caret
   * after it. Commands keep their "/" and files keep their "@", so the
   * submitted text still reads as an invocation or a mention — the engine
   * expands a leading "/name" into the command's prompt. */
  const accept = (item: MenuItem) => {
    if (trigger === null) return;
    const sigil = trigger.kind === "command" ? "/" : "@";
    const insert = `${sigil}${item.value} `;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    const pos = trigger.start + insert.length;
    setText(next);
    setCaret(pos);
    setMenuIndex(0);
    // The DOM value updates on the next paint; move the caret after that or
    // it lands at the end of the old text.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  // One Escape handler for all three popovers, as before.
  useEffect(() => {
    if (!pickerOpen && !modeOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickerOpen(false);
        setModeOpen(false);
        setMenuDismissed(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, modeOpen, menuOpen]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.busy || disabled) return;
    setText("");
    setCaret(0);
    setMenuIndex(0);
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
          {props.mcp ? <McpChip {...props.mcp} /> : null}
        </div>
        <div className="input-card">
          <div className="ac-anchor">
            <textarea
              ref={textareaRef}
              placeholder={
                disabled
                  ? "Open a project to start a session"
                  : composerPlaceholder(
                      commands.length > 0,
                      fileSeed.length > 0,
                    )
              }
              disabled={disabled}
              value={text}
              aria-autocomplete="list"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? "composer-autocomplete" : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                // Any edit revives a menu the user escaped out of.
                setMenuDismissed(false);
              }}
              onSelect={(e) =>
                setCaret(e.currentTarget.selectionStart ?? 0)
              }
              onBlur={() => setMenuDismissed(true)}
              onKeyDown={(e) => {
                // The menu owns these keys only while it has something to
                // offer, so Enter still sends and Shift+Enter still inserts a
                // newline whenever it is closed.
                if (menuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMenuIndex((i) =>
                      menuItems.length === 0
                        ? 0
                        : (Math.min(i, menuItems.length - 1) + 1) %
                          menuItems.length,
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMenuIndex((i) =>
                      menuItems.length === 0
                        ? 0
                        : (Math.min(i, menuItems.length - 1) +
                            menuItems.length -
                            1) %
                          menuItems.length,
                    );
                    return;
                  }
                  // Shift+Enter is always a newline, menu open or not — an
                  // open completion menu must not swallow it.
                  if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                    e.preventDefault();
                    accept(menuItems[activeIndex]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMenuDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {menuOpen && trigger !== null ? (
              <div
                className="model-pop ac-pop"
                id="composer-autocomplete"
                role="listbox"
              >
                <div className="model-pop-hint">
                  {trigger.kind === "command"
                    ? "Commands — ↑↓ to move, Enter to insert"
                    : "Files — ↑↓ to move, Enter to insert"}
                </div>
                {menuItems.map((item, i) => (
                  <button
                    key={item.value}
                    ref={i === activeIndex ? activeItemRef : null}
                    className={i === activeIndex ? "ac-opt active" : "ac-opt"}
                    role="option"
                    aria-selected={i === activeIndex}
                    // Selecting must not blur the textarea, or the caret
                    // restore below has nothing to restore into.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      accept(item);
                    }}
                    onMouseEnter={() => setMenuIndex(i)}
                  >
                    <span className="ac-opt-label">{item.label}</span>
                    {item.hint ? (
                      <span className="ac-opt-hint">{item.hint}</span>
                    ) : null}
                    {item.desc ? (
                      <span className="ac-opt-desc">{item.desc}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
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
              {/* Without a catalog there is nothing to pick FROM, but the
                  session still knows what it runs ON (session/new answers with
                  it), and hiding that read-out would lose information the
                  older-engine fallback successfully produced. So: show the
                  chip whenever there is a model to name, and only make it
                  interactive when a catalog exists. */}
              {hasCatalog || active ? (
                <div className="model-picker">
                  <button
                    className="model-btn"
                    disabled={!hasCatalog}
                    onClick={() => hasCatalog && setPickerOpen((open) => !open)}
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
