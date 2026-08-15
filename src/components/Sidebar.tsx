import { useEffect, useMemo, useState } from "react";
import { listSessions } from "../acp/client";
import type { SessionSummary } from "../acp/types";

function projectName(workingDir: string): string {
  if (!workingDir) return "other";
  const parts = workingDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "other";
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function Sidebar(props: {
  engineVersion: string;
  activeSessionId: string | null;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    listSessions()
      .then((list) => {
        if (!disposed) setSessions(list);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [props.activeSessionId]);

  const projects = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const key = projectName(s.workingDir);
      const bucket = groups.get(key);
      if (bucket) bucket.push(s);
      else groups.set(key, [s]);
    }
    return [...groups.entries()];
  }, [sessions]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/favicon.png" alt="" />
        <b>packetcode</b>
      </div>
      <nav className="nav">
        <button className="nav-item" onClick={props.onNewSession}>
          + New session
        </button>
        <button className="nav-item">Agents</button>
        <button className="nav-item">Workflows</button>
        <button className="nav-item">Computers</button>
      </nav>
      <div className="section-label">Projects</div>
      {projects.length === 0 && !error ? (
        <div className="session-row">no sessions yet</div>
      ) : null}
      {error ? <div className="session-row">history unavailable</div> : null}
      {projects.map(([name, list]) => (
        <div key={name}>
          <div className="project-row">{name}</div>
          {list.slice(0, 8).map((s) => {
            const active = s.sessionId === props.activeSessionId;
            return (
              <button
                key={s.sessionId}
                className={active ? "session-row active" : "session-row"}
                title={`${s.provider} · ${s.model} · ${s.messageCount} messages`}
                onClick={() => props.onSelectSession(s)}
              >
                <span className={active ? "status-dot running" : "status-dot idle"} />
                <span className="session-name">{s.name || "untitled"}</span>
                <span className="session-time">{relativeTime(s.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className="sidebar-foot">
        <span>packetcode {props.engineVersion}</span>
      </div>
    </aside>
  );
}
