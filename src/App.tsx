import { useCallback, useEffect, useState } from "react";
import { probeEngine, startEngine } from "./acp/client";
import type { EngineProbe, SessionSummary } from "./acp/types";
import { Gate } from "./components/Gate";
import { InstallGate } from "./components/InstallGate";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
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
  const [target, setTarget] = useState<SessionTarget>({ kind: "new" });
  const onSessionReady = useCallback((id: string) => setActiveSessionId(id), []);

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
    // Same-object reuse as above: already in "new" mode means keep the
    // current fresh session rather than silently creating another one.
    setTarget((prev) => (prev.kind === "new" ? prev : { kind: "new" }));
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
  const viewKey = target.kind === "load" ? `load:${target.sessionId}` : "new";

  return (
    <div className="shell">
      <Sidebar
        engineVersion={phase.probe.version ?? ""}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
      />
      <SessionView
        key={viewKey}
        cwd={"."}
        target={target}
        onSessionReady={onSessionReady}
      />
    </div>
  );
}
