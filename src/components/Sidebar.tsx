import { useEffect, useMemo, useState } from "react";
import { listSessions, renameSession } from "../acp/client";
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
  /** Bumped by the shell when the persisted list may have changed (turn
   * completed, session created/renamed); triggers a refetch. */
  refreshNonce: number;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  /** Tell the shell the list changed (e.g. after an inline rename). */
  onSessionsChanged: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Inline rename state: the row being edited and its draft text.
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    listSessions()
      .then((list) => {
        if (!disposed) {
          setSessions(list);
          setError(null);
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [props.activeSessionId, props.refreshNonce]);

  const commitRename = async () => {
    if (!editing) return;
    const { id, draft } = editing;
    setEditing(null);
    const name = draft.trim();
    const previous = sessions.find((s) => s.sessionId === id)?.name ?? "";
    if (!name || name === previous) return;
    try {
      await renameSession(id, name);
    } catch {
      // Cosmetic failure (engine too old, session gone); the refetch below
      // shows whatever the engine actually has.
    }
    props.onSessionsChanged();
  };

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
            if (editing && editing.id === s.sessionId) {
              return (
                <div
                  key={s.sessionId}
                  className={active ? "session-row active" : "session-row"}
                >
                  <span className={active ? "status-dot running" : "status-dot idle"} />
                  <input
                    className="session-rename"
                    aria-label="Rename session"
                    autoFocus
                    value={editing.draft}
                    onChange={(e) =>
                      setEditing({ id: s.sessionId, draft: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      else if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                  />
                </div>
              );
            }
            return (
              <button
                key={s.sessionId}
                className={active ? "session-row active" : "session-row"}
                title={`${s.provider} · ${s.model} · ${s.messageCount} messages — double-click or F2 to rename`}
                onClick={() => props.onSelectSession(s)}
                onDoubleClick={() =>
                  setEditing({ id: s.sessionId, draft: s.name })
                }
                onKeyDown={(e) => {
                  if (e.key === "F2") {
                    e.preventDefault();
                    setEditing({ id: s.sessionId, draft: s.name });
                  }
                }}
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
