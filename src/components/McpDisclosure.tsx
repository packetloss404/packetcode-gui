// The two halves of MCP disclosure.
//
//   McpConsentDialog — the first-run moment. It lists the servers by name AND
//     command BEFORE any session inherits them, because "inherit" means this
//     app starts those executables. Nothing runs until the user answers, and
//     the answer is remembered per machine.
//
//   McpChip — the standing, click-to-expand read-out in the composer's context
//     strip. Not a tooltip: a tooltip is invisible until you happen to hover
//     the right five pixels, which is not disclosure for a set of subprocesses.
//     The panel is also where the choice is reversed, in both directions.

import { useState } from "react";
import type { McpServerStatus } from "../acp/types";
import { describeServer, mcpChip, startableServers } from "../mcp/consent";

/** One server row: name, what it is doing, and the command behind it. */
function ServerRow(props: { server: McpServerStatus }) {
  const s = props.server;
  const tone =
    s.status === "running"
      ? "ok"
      : s.status === "failed"
        ? "bad"
        : s.status === "disabled"
          ? "muted"
          : "idle";
  return (
    <li className="mcp-row">
      <span className="mcp-row-head">
        <span className={`mcp-dot tone-${tone}`} />
        <span className="mcp-row-name">{s.name}</span>
        <span className="mcp-row-detail">{describeServer(s)}</span>
      </span>
      {s.command ? <code className="mcp-row-cmd">{s.command}</code> : null}
    </li>
  );
}

/** First-run consent. Rendered over the shell, before the app has ever asked
 * an engine to start these servers. */
export function McpConsentDialog(props: {
  configured: McpServerStatus[];
  onDecide: (consent: "granted" | "denied") => void;
}) {
  const startable = startableServers(props.configured);
  const disabled = props.configured.filter((s) => s.status === "disabled");
  return (
    <div className="mcp-consent-backdrop">
      <div className="mcp-consent" role="dialog" aria-modal="true">
        <h2>Run this machine&rsquo;s MCP servers?</h2>
        <p>
          Your packetcode <code>config.toml</code> configures{" "}
          {startable.length === 1 ? "an MCP server" : `${startable.length} MCP servers`}.
          Turning this on lets each new session start{" "}
          {startable.length === 1 ? "it" : "them"} — local programs run on this
          machine with your account — and use their tools. Until you decide,
          sessions run with no MCP servers at all.
        </p>
        <ul className="mcp-list selectable">
          {startable.map((s) => (
            <ServerRow key={s.name} server={s} />
          ))}
        </ul>
        {disabled.length > 0 ? (
          <p className="mcp-note">
            {disabled.length === 1
              ? "1 more server is disabled in your config and will not start."
              : `${disabled.length} more servers are disabled in your config and will not start.`}
          </p>
        ) : null}
        <p className="mcp-note">
          Either way you can change this later from the MCP chip above the
          composer. Changes apply to new sessions.
        </p>
        <div className="mcp-consent-actions">
          <button className="btn" onClick={() => props.onDecide("denied")}>
            Not now
          </button>
          <button className="btn primary" onClick={() => props.onDecide("granted")}>
            Start these servers
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the chip needs to know. Null in the composer's props hides it
 * entirely, which is the state for engines without the extension. */
export interface McpPanelProps {
  /** The engine's configured servers — what WOULD start. */
  configured: McpServerStatus[];
  /** This session's live fleet — what DID start. Empty for a session that
   * runs none, including one opened before the user opted in. */
  live: McpServerStatus[];
  /** Whether THIS session was opened with consent. */
  sessionInherits: boolean;
  /** Whether NEW sessions will inherit. Differs from `sessionInherits` right
   * after the user flips the switch, which the panel says out loud. */
  inherit: boolean;
  onInherit: (on: boolean) => void;
  /** Re-reads this session's live fleet. */
  onRefresh: () => void;
}

export function McpChip(props: McpPanelProps) {
  const [open, setOpen] = useState(false);
  const chip = mcpChip(props.live, props.configured, props.sessionInherits);
  if (chip === null) return null;

  // The fleet is otherwise only re-read when a turn ends, so opening the
  // panel — the moment the user actually looks — is worth one round trip.
  const toggle = () => {
    if (!open) props.onRefresh();
    setOpen((o) => !o);
  };

  const showingLive = props.sessionInherits && props.live.length > 0;
  const rows = showingLive ? props.live : props.configured;

  return (
    <span className="mcp-picker">
      <button
        className={`context-chip mcp-chip tone-${chip.tone}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {chip.label}
        <span className="mode-caret">▾</span>
      </button>
      {open ? (
        <>
          <div className="model-backdrop" onClick={() => setOpen(false)} />
          <div className="model-pop mcp-pop" role="dialog">
            <div className="model-pop-hint">
              {showingLive
                ? "MCP servers in this session — status as of the last completed turn"
                : "MCP servers configured on this machine — none running in this session"}
            </div>
            <ul className="mcp-list selectable">
              {rows.map((s) => (
                <ServerRow key={s.name} server={s} />
              ))}
            </ul>
            <div className="mcp-pop-foot">
              {props.inherit ? (
                <>
                  <span className="mcp-note">
                    {props.sessionInherits
                      ? "New sessions start these servers."
                      : "New sessions will start these servers; this one was opened without them."}
                  </span>
                  <button className="btn" onClick={() => props.onInherit(false)}>
                    Stop running them
                  </button>
                </>
              ) : (
                <>
                  <span className="mcp-note">
                    Sessions currently run with no MCP servers.
                  </span>
                  <button
                    className="btn primary"
                    onClick={() => props.onInherit(true)}
                  >
                    Start them in new sessions
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
