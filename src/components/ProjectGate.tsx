// First-run / no-project state: shown in place of the session view until a
// project directory is chosen. Creating a session without a meaningful cwd
// is a footgun, so the composer renders disabled underneath the prompt.

import { projectName } from "../project/projects";
import { Composer } from "./Composer";

export function ProjectGate(props: {
  recentProjects: string[];
  onOpenProject: () => void;
  onSelectProject: (dir: string) => void;
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
        permissionMode={null}
        onPermissionMode={() => undefined}
      />
    </section>
  );
}
