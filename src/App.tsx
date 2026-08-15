import { useCallback, useEffect, useState } from "react";
import { listModels, probeEngine, startEngine } from "./acp/client";
import type { EngineProbe, ModelOption } from "./acp/types";
import { Gate } from "./components/Gate";
import { InstallGate } from "./components/InstallGate";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";

type Phase =
  | { name: "probing" }
  | { name: "missing"; probe: EngineProbe }
  | { name: "incompatible"; probe: EngineProbe }
  | { name: "ready"; probe: EngineProbe }
  | { name: "error"; message: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: "probing" });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const onSessionReady = useCallback((id: string) => setActiveSessionId(id), []);
  // Provider/model catalog from the engine, and the user's picker choice.
  // The choice applies to the NEXT session; running sessions keep theirs.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState<ModelOption | null>(null);
  const onModelChoice = useCallback((m: ModelOption) => setModelChoice(m), []);

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

  return (
    <div className="shell">
      <Sidebar
        engineVersion={phase.probe.version ?? ""}
        activeSessionId={activeSessionId}
      />
      <SessionView
        cwd={"."}
        onSessionReady={onSessionReady}
        models={models}
        modelChoice={modelChoice}
        onModelChoice={onModelChoice}
      />
    </div>
  );
}
