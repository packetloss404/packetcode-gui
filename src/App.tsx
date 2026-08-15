import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  allowedPermissionModes,
  canInheritMcp,
  engineDefaultPermissionMode,
  supports,
} from "./acp/capabilities";
import {
  engineCapabilities,
  listMcpServers,
  listModels,
  probeEngine,
  startEngine,
} from "./acp/client";
import type {
  EngineCapabilities,
  EngineProbe,
  McpServerStatus,
  ModelOption,
  PermissionMode,
  SessionSummary,
} from "./acp/types";
import { Gate } from "./components/Gate";
import { InstallGate } from "./components/InstallGate";
import { Notices } from "./components/Notices";
import { McpConsentDialog } from "./components/McpDisclosure";
import { ProjectGate } from "./components/ProjectGate";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import {
  loadMcpConsent,
  needsMcpConsent,
  saveMcpConsent,
  type McpConsent,
} from "./mcp/consent";
import {
  loadActiveProject,
  loadRecentProjects,
  rememberProject,
  samePath,
} from "./project/projects";
import { SessionsProvider, useSessions } from "./session/SessionsProvider";
import { getEntry, resolveKey, statusById, type SessionTarget } from "./session/store";

type Phase =
  | { name: "probing" }
  | { name: "missing"; probe: EngineProbe }
  | { name: "incompatible"; probe: EngineProbe }
  | { name: "ready"; probe: EngineProbe }
  | { name: "error"; message: string };

/** The store sits above the shell so it outlives every view: switching
 * sessions unmounts a SessionView, and the session it was showing must keep
 * streaming into the store. */
export default function App() {
  return (
    <SessionsProvider>
      <Shell />
    </SessionsProvider>
  );
}

function Shell() {
  const { state: sessions, dismissNotice, touch } = useSessions();
  const [phase, setPhase] = useState<Phase>({ name: "probing" });
  // What the engine advertised at initialize. Null only if the capability
  // read itself failed, which every consumer treats as "engine said nothing".
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(
    null,
  );
  const [target, setTarget] = useState<SessionTarget>({ kind: "new", nonce: 0 });
  // Bumped when the GUI itself changed the persisted list (an inline rename).
  // Engine-side changes — session created, turn completed, including turns
  // that finish while their view is unmounted — arrive as store.listRevision,
  // so no callback has to survive a view switch.
  const [renameNonce, setRenameNonce] = useState(0);
  const bumpSidebar = useCallback(() => setRenameNonce((n) => n + 1), []);
  // Selected project directory (absolute path). New sessions are created in
  // it; loaded sessions prefer their own recorded workingDir. Restored from
  // localStorage so relaunching lands back in the last project.
  const [projectDir, setProjectDir] = useState<string | null>(loadActiveProject);
  const [recentProjects, setRecentProjects] = useState<string[]>(loadRecentProjects);

  // Switching (or re-picking) a project starts a fresh target, exactly like
  // "+ New session": the next session is created in the new directory. Any
  // session already running keeps running in the store.
  const activateProject = useCallback((dir: string) => {
    setProjectDir(dir);
    setRecentProjects((recent) => rememberProject(dir, recent));
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
      // Re-clicking the active project must not restart the visible session.
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
  // The engine's configured MCP servers, read once at startup with NO session
  // id — before anything has been started, which is what lets the app disclose
  // the commands and ask, rather than announce it after the fact. Empty
  // whenever the engine cannot serve or honour them, which hides the whole
  // feature. Not cached across restarts: config.toml is the source of truth
  // and it can change between launches.
  const [mcpConfigured, setMcpConfigured] = useState<McpServerStatus[]>([]);
  // Per-machine consent, remembered in localStorage. Undecided behaves as
  // "no": no session inherits anything until the user has actually answered.
  const [mcpConsent, setMcpConsent] = useState<McpConsent>(loadMcpConsent);
  const onMcpDecide = useCallback((consent: "granted" | "denied") => {
    saveMcpConsent(consent);
    setMcpConsent(consent);
  }, []);
  const onMcpInherit = useCallback(
    (on: boolean) => onMcpDecide(on ? "granted" : "denied"),
    [onMcpDecide],
  );

  // Permission mode for the NEXT session; null = whatever the engine
  // resolves to. Running sessions keep the policy they were created with.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(
    null,
  );
  const onPermissionMode = useCallback(
    (m: PermissionMode) => setPermissionMode(m),
    [],
  );

  const onSelectSession = useCallback((s: SessionSummary) => {
    // Keep the previous target object when re-selecting the same session so
    // the view's attach effect does not re-run.
    setTarget((prev) =>
      prev.kind === "load" && prev.sessionId === s.sessionId
        ? prev
        : { kind: "load", sessionId: s.sessionId, workingDir: s.workingDir },
    );
  }, []);

  const onNewSession = useCallback(() => {
    // Every click is a fresh target: a new slot, hence a new session created
    // with the current model choice, alongside whatever is already running.
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
        // Read the handshake capabilities BEFORE the shell renders, so the
        // pickers never briefly offer something the engine would reject.
        let caps: EngineCapabilities | null = null;
        try {
          caps = await engineCapabilities();
        } catch {
          // Treated as "the engine advertised nothing": every feature keeps
          // its call-time fallback, exactly as before capability negotiation.
        }
        setCapabilities(caps);
        setPhase({ name: "ready", probe: result });
        // Only worth asking when the engine can BOTH list its servers and
        // honour an omitted mcpServers; otherwise there is no choice to offer
        // and the chip, the dialog, and the query all stay away.
        if (canInheritMcp(caps) && supports(caps, "mcpList")) {
          try {
            setMcpConfigured(await listMcpServers());
          } catch {
            // Best-effort: a failed read just means nothing to disclose, and
            // sessions keep running with no MCP servers.
            setMcpConfigured([]);
          }
        } else {
          setMcpConfigured([]);
        }
        if (!supports(caps, "modelsList")) {
          // Advertised absent: skip the round-trip that would answer -32601.
          setModels([]);
        } else {
          try {
            setModels(await listModels());
          } catch {
            // Older engines have no catalog; the picker just stays hidden.
            setModels([]);
          }
        }
      }
    } catch (e) {
      setPhase({ name: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Running / attention / idle per resident session, for the sidebar dots.
  // Derived from the store, so a background session that stops for a
  // permission request turns amber wherever the user happens to be.
  const sessionStatus = useMemo(() => statusById(sessions), [sessions]);

  // The view is remounted per SLOT, not per target: a fresh target is a new
  // slot (so its timeline starts empty), while re-selecting a session that is
  // already resident resolves to the slot it already has — no remount, no
  // reset, and no second session/load.
  const viewKey = resolveKey(sessions, target);
  const activeEntry = getEntry(sessions, viewKey);
  // Which row the sidebar highlights. Derived rather than tracked: a fresh
  // slot has no id until session/new answers, and then it just appears.
  const activeSessionId = activeEntry?.sessionId ?? null;

  // Tell the store which slot is in front, which is also when it trims
  // residency down to the sessions worth keeping alive. Computed before the
  // gate returns below so the hook order never changes; with an empty store it
  // is a no-op. activeEntry?.key is in the dependency list because a brand-new
  // slot is dispatched by the child view's effect, one commit AFTER this one —
  // re-running once it lands is what lets the new slot count itself.
  useEffect(() => {
    touch(viewKey);
  }, [touch, viewKey, activeEntry?.key]);

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

  // A load target brings its own recorded workingDir; anything else runs in
  // the selected project. No directory at all means there is nothing safe to
  // create a session in, so the project gate renders instead.
  const sessionCwd =
    target.kind === "load" && target.workingDir
      ? target.workingDir
      : projectDir;

  return (
    <div className="shell">
      {needsMcpConsent(mcpConsent, mcpConfigured) ? (
        <McpConsentDialog configured={mcpConfigured} onDecide={onMcpDecide} />
      ) : null}
      <Sidebar
        engineVersion={phase.probe.version ?? ""}
        activeSessionId={activeSessionId}
        activeProject={projectDir}
        recentProjects={recentProjects}
        refreshNonce={renameNonce + sessions.listRevision}
        sessionStatus={sessionStatus}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onOpenProject={onOpenProject}
        onSelectProject={onSelectProject}
        onSessionsChanged={bumpSidebar}
        canRenameSessions={supports(capabilities, "sessionsRename")}
        canListSessions={supports(capabilities, "sessionsList")}
      />
      {sessionCwd === null ? (
        <ProjectGate
          recentProjects={recentProjects}
          onOpenProject={onOpenProject}
          onSelectProject={onSelectProject}
          permissionMode={permissionMode}
          onPermissionMode={onPermissionMode}
          allowedPermissionModes={allowedPermissionModes(capabilities)}
          engineDefaultMode={engineDefaultPermissionMode(capabilities)}
        />
      ) : (
        <SessionView
          key={viewKey}
          cwd={sessionCwd}
          target={target}
          models={models}
          modelChoice={modelChoice}
          onModelChoice={onModelChoice}
          permissionMode={permissionMode}
          onPermissionMode={onPermissionMode}
          allowedPermissionModes={allowedPermissionModes(capabilities)}
          engineDefaultMode={engineDefaultPermissionMode(capabilities)}
          usageAvailable={supports(capabilities, "sessionsUsage")}
          mcpConfigured={mcpConfigured}
          mcpInherit={mcpConsent === "granted"}
          onMcpInherit={onMcpInherit}
        />
      )}
      {/* Above both panes: what the app decided by itself belongs wherever the
          user is looking, not in a session they may never open. */}
      <Notices notices={sessions.notices} onDismiss={dismissNotice} />
    </div>
  );
}
