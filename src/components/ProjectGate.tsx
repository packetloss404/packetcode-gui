// First-run / no-project state: shown in place of the session view until a
// project directory is chosen. Creating a session without a meaningful cwd
// is a footgun, so the composer renders disabled underneath the prompt.
//
// The permission-mode picker is live here even though the prompt is not, and
// the engine's real ceiling is threaded in rather than stubbed. Both halves
// matter: picking a project creates its first session immediately, so this is
// the ONLY screen on which that session's mode can still be chosen — and a
// picker that offered all five modes (bypass included) under an operator
// ceiling would be the one place in the app that advertises a mode session/new
// would reject with -32602.

import type { PermissionMode } from "../acp/types";
import { projectName } from "../project/projects";
import { Composer } from "./Composer";

export function ProjectGate(props: {
  recentProjects: string[];
  onOpenProject: () => void;
  onSelectProject: (dir: string) => void;
  /** Mode the next session will be created with; null = engine default. */
  permissionMode: PermissionMode | null;
  onPermissionMode: (m: PermissionMode) => void;
  /** Modes the engine will accept; null = it did not say, so offer all. */
  allowedPermissionModes: string[] | null;
  /** Mode a session with no override runs under; null = not advertised. */
  engineDefaultMode: string | null;
}) {
  return (
    <section className="content">
      <header className="session-head">
        <h1>Session</h1>
        <span className="chip">no project</span>
      </header>
      <div className="project-gate">
        <div className="project-gate-inner">
          <h2>Open a project to get started</h2>
          <p>
            Sessions run inside a project folder. Pick one and every new
            session will start there.
          </p>
          <button className="btn primary" onClick={props.onOpenProject}>
            Open project…
          </button>
          {props.recentProjects.length > 0 ? (
            <div className="project-gate-recent">
              <div className="section-label">Recent</div>
              {props.recentProjects.slice(0, 5).map((dir) => (
                <button
                  key={dir}
                  className="project-gate-row"
                  title={dir}
                  onClick={() => props.onSelectProject(dir)}
                >
                  <span className="project-gate-name">{projectName(dir)}</span>
                  <span className="project-gate-path">{dir}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <Composer
        disabled
        busy={false}
        onSend={() => undefined}
        onStop={() => undefined}
        models={[]}
        sessionModel={null}
        modelChoice={null}
        onModelChoice={() => undefined}
        projectDir={null}
        sessionPermissionMode={null}
        permissionMode={props.permissionMode}
        onPermissionMode={props.onPermissionMode}
        allowedPermissionModes={props.allowedPermissionModes}
        engineDefaultMode={props.engineDefaultMode}
        usage={null}
      />
    </section>
  );
}
