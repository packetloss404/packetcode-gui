import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { listModels, probeEngine, startEngine } from "./acp/client";
import type {
  EngineProbe,
  ModelOption,
  PermissionMode,
  SessionSummary,
} from "./acp/types";
import { Gate } from "./components/Gate";
import { InstallGate } from "./components/InstallGate";
import { ProjectGate } from "./components/ProjectGate";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import {
  loadActiveProject,
  loadRecentProjects,
  rememberProject,
  samePath,
} from "./project/projects";
import type { SessionTarget } from "./session/useSession";

type Phase =
  | { name: "probing" }
  | { name: "missing"; probe: EngineProbe }
  | { name: "incompatible"; probe: EngineProbe }
  | { name: "ready"; probe: EngineProbe }
  | { name: "error"; message: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: "probing" });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [target, setTarget] = useState<SessionTarget>({ kind: "new", nonce: 0 });
  // Bumped whenever the persisted session list may have changed (session
  // created, turn completed, session renamed) so the sidebar refetches live.
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarRefresh((n) => n + 1), []);
  const onSessionReady = useCallback((id: string) => {
    setActiveSessionId(id);
    setSidebarRefresh((n) => n + 1);
  }, []);
  // Selected project directory (absolute path). New sessions are created in
  // it; loaded sessions prefer their own recorded workingDir. Restored from
  // localStorage so relaunching lands back in the last project.
  const [projectDir, setProjectDir] = useState<string | null>(loadActiveProject);
  const [recentProjects, setRecentProjects] = useState<string[]>(loadRecentProjects);

  // Switching (or re-picking) a project starts a fresh target, exactly like
  // "+ New session": the next session is created in the new directory.
  const activateProject = useCallback((dir: string) => {
    setProjectDir(dir);
    setRecentProjects((recent) => rememberProject(dir, recent));
    setActiveSessionId(null);
    setTarget({ kind: "new", nonce: Date.now() });
  }, []);

  const onOpenProject = useCallback(() => {
    // Native directory picker via the dialog plugin; resolves null on cancel.
    void open({ directory: true, multiple: false, title: "Open project" }).then(
      (dir) => {
        if (typeof dir === "string" && dir.length > 0) activateProject(dir);
      },
    );
  }, [activateProject]);

  const onSelectProject = useCallback(
    (dir: string) => {
      // Re-clicking the active project must not tear down a running session.
      if (projectDir !== null && samePath(projectDir, dir)) return;
      activateProject(dir);
    },
    [activateProject, projectDir],
  );
  // Provider/model catalog from the engine, and the user's picker choice.
  // The choice applies to the NEXT session; running sessions keep theirs.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState<ModelOption | null>(null);
  const onModelChoice = useCallback((m: ModelOption) => setModelChoice(m), []);
  // Permission mode for the NEXT session; null = engine default ("ask").
  // Running sessions keep the policy they were created with.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(
    null,
  );
  const onPermissionMode = useCallback(
    (m: PermissionMode) => setPermissionMode(m),
    [],
  );

  const onSelectSession = useCallback((s: SessionSummary) => {
    setActiveSessionId(s.sessionId);
    // Keep the previous target object when re-selecting the same session:
    // a new object would re-run the session effect without remounting the
    // view, replaying history into an unreset timeline.
    setTarget((prev) =>
      prev.kind === "load" && prev.sessionId === s.sessionId
        ? prev
        : { kind: "load", sessionId: s.sessionId, workingDir: s.workingDir },
    );
  }, []);

  const onNewSession = useCallback(() => {
    setActiveSessionId(null);
    // Every click is a fresh target: a new session is created on remount,
    // picking up the current model choice.
    setTarget({ kind: "new", nonce: Date.now() });
  }, []);

  const probe = useCallback(async () => {
    try {
      const result = await probeEngine();
      if (!result.found) {
        setPhase({ name: "missing", probe: result });
      } else if (!result.compatible) {
        setPhase({ name: "incompatible", probe: result });
      } else {
        await startEngine();
        setPhase({ name: "ready", probe: result });
        try {
          setModels(await listModels());
        } catch {
          // Older engines have no catalog; the picker just stays inert.
          setModels([]);
        }
      }
    } catch (e) {
      setPhase({ name: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  if (phase.name === "probing") {
    return <Gate title="Packetcode" body="Checking for the packetcode engine…" />;
  }

  if (phase.name === "missing") {
    return (
      <InstallGate
        title="packetcode not found"
        body="Packetcode Desktop drives the packetcode CLI, and no packetcode binary was found on PATH or in the default install location."
        actionLabel="Install packetcode"
        installSupported={phase.probe.installSupported}
        detail={phase.probe.detail}
        onInstalled={probe}
      />
    );
  }

  if (phase.name === "incompatible") {
    return (
      <InstallGate
        title="packetcode is too old"
        body={`This app needs packetcode ${phase.probe.minimumVersion} or newer (found ${phase.probe.version ?? "unknown"}). The install script upgrades in place.`}
        actionLabel="Update packetcode"
        installSupported={phase.probe.installSupported}
        detail={phase.probe.detail}
        onInstalled={probe}
      />
    );
  }

  if (phase.name === "error") {
    return (
      <Gate
        title="Engine error"
        body="The packetcode engine failed to start."
        detail={phase.message}
      />
    );
  }

  // Remount the session view when the target changes so its timeline resets
  // before a resume replay (or a fresh session) fills it.
  const viewKey =
    target.kind === "load" ? `load:${target.sessionId}` : `new:${target.nonce}`;

  // A load target brings its own recorded workingDir; anything else runs in
  // the selected project. No directory at all means there is nothing safe to
  // create a session in, so the project gate renders instead.
  const sessionCwd =
    target.kind === "load" && target.workingDir
      ? target.workingDir
      : projectDir;

  return (
    <div className="shell">
      <Sidebar
        engineVersion={phase.probe.version ?? ""}
        activeSessionId={activeSessionId}
        activeProject={projectDir}
        recentProjects={recentProjects}
        refreshNonce={sidebarRefresh}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onOpenProject={onOpenProject}
        onSelectProject={onSelectProject}
        onSessionsChanged={bumpSidebar}
      />
      {sessionCwd === null ? (
        <ProjectGate
          recentProjects={recentProjects}
          onOpenProject={onOpenProject}
          onSelectProject={onSelectProject}
        />
      ) : (
        <SessionView
          key={viewKey}
          cwd={sessionCwd}
          target={target}
          onSessionReady={onSessionReady}
          onTurnComplete={bumpSidebar}
          models={models}
          modelChoice={modelChoice}
          onModelChoice={onModelChoice}
          permissionMode={permissionMode}
          onPermissionMode={onPermissionMode}
        />
      )}
    </div>
  );
}
