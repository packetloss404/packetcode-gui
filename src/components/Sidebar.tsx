import { useEffect, useMemo, useState } from "react";
import { listSessions } from "../acp/client";
import type { SessionSummary } from "../acp/types";
import { pathKey, projectName, samePath } from "../project/projects";

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
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelectProject: (dir: string) => void;
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
        return (
          <div key={key}>
            {group.dir === "" ? (
              <div className="project-row">other</div>
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
        );
      })}
      <div className="sidebar-foot">
        <span>packetcode {props.engineVersion}</span>
      </div>
    </aside>
  );
}
