import { useEffect, useMemo, useState } from "react";
import { listSessions, renameSession } from "../acp/client";
import type { SessionSummary } from "../acp/types";
import { isAbsolutePath, pathKey, projectName, samePath } from "../project/projects";

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

interface ProjectGroup {
  /** Absolute directory, or "" for sessions with no recorded workingDir. */
  dir: string;
  sessions: SessionSummary[];
}

export function Sidebar(props: {
  engineVersion: string;
  activeSessionId: string | null;
  activeProject: string | null;
  recentProjects: string[];
  /** Bumped by the shell when the persisted list may have changed (turn
   * completed, session created/renamed); triggers a refetch. */
  refreshNonce: number;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelectProject: (dir: string) => void;
  /** Tell the shell the list changed (e.g. after an inline rename). */
  onSessionsChanged: () => void;
  /** False when the engine advertised no `_packetcode/sessions/rename`: the
   * rename affordance is hidden rather than silently doing nothing. */
  canRenameSessions: boolean;
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

  // Recent (MRU) projects come first, even when they have no sessions yet;
  // remaining session history is grouped by its own workingDir after them.
  const projects = useMemo<ProjectGroup[]>(() => {
    const groups = new Map<string, ProjectGroup>();
    for (const dir of props.recentProjects) {
      groups.set(pathKey(dir), { dir, sessions: [] });
    }
    for (const s of sessions) {
      const key = pathKey(s.workingDir);
      const bucket = groups.get(key);
      if (bucket) bucket.sessions.push(s);
      else groups.set(key, { dir: s.workingDir, sessions: [s] });
    }
    return [...groups.values()];
  }, [sessions, props.recentProjects]);

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
        <button className="nav-item" onClick={props.onOpenProject}>
          Open project…
        </button>
        <button className="nav-item">Agents</button>
        <button className="nav-item">Workflows</button>
        <button className="nav-item">Computers</button>
      </nav>
      <div className="section-label">Projects</div>
      {projects.length === 0 && !error ? (
        <div className="session-row">no projects yet</div>
      ) : null}
      {error ? <div className="session-row">history unavailable</div> : null}
      {projects.map((group) => {
        const key = group.dir === "" ? "(none)" : pathKey(group.dir);
        const activeProject =
          group.dir !== "" &&
          props.activeProject !== null &&
          samePath(group.dir, props.activeProject);
        // Legacy summaries may carry relative dirs (old sessions created with
        // cwd "."); those must not become clickable projects — activating one
        // would poison the MRU with a non-absolute path.
        const clickable = group.dir !== "" && isAbsolutePath(group.dir);
        return (
          <div key={key}>
            {!clickable ? (
              <div className="project-row" title={group.dir || undefined}>
                {group.dir === "" ? "other" : projectName(group.dir)}
              </div>
            ) : (
              <button
                className={activeProject ? "project-row active" : "project-row"}
                title={group.dir}
                onClick={() => props.onSelectProject(group.dir)}
              >
                <span className="project-name">{projectName(group.dir)}</span>
                {activeProject ? <span className="project-mark">●</span> : null}
              </button>
            )}
            {group.sessions.slice(0, 8).map((s) => {
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
                      onBlur={() => void commitRename()}
                    />
                  </div>
                );
              }
              // Renaming the ACTIVE session is disabled: its live runtime
              // rewrites the whole session file on the next save, which can
              // both revert the name and clobber concurrent writes. Engines
              // without the rename extension hide the affordance entirely.
              const canRename = !active && props.canRenameSessions;
              return (
                <button
                  key={s.sessionId}
                  className={active ? "session-row active" : "session-row"}
                  title={`${s.provider} · ${s.model} · ${s.messageCount} messages${canRename ? " — double-click or F2 to rename" : ""}`}
                  onClick={() => props.onSelectSession(s)}
                  onDoubleClick={() => {
                    if (canRename) setEditing({ id: s.sessionId, draft: s.name });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "F2" && canRename) {
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
        );
      })}
      <div className="sidebar-foot">
        <span>packetcode {props.engineVersion}</span>
      </div>
    </aside>
  );
}
