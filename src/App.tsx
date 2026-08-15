import { useCallback, useEffect, useState } from "react";
import { probeEngine, startEngine } from "./acp/client";
import type { EngineProbe } from "./acp/types";
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

  useEffect(() => {
    (async () => {
      try {
        const probe = await probeEngine();
        if (!probe.found) {
          setPhase({ name: "missing", probe });
        } else if (!probe.compatible) {
          setPhase({ name: "incompatible", probe });
        } else {
          await startEngine();
          setPhase({ name: "ready", probe });
        }
      } catch (e) {
        setPhase({ name: "error", message: String(e) });
      }
    })();
  }, []);

  if (phase.name === "probing") {
    return (
      <div className="gate">
        <div className="inner">
          <img src="/favicon.png" alt="" />
          <h2>Packetcode</h2>
          <p>Checking for the packetcode engine…</p>
        </div>
      </div>
    );
  }

  if (phase.name === "missing") {
    return (
      <Gate
        title="packetcode not found"
        body="Packetcode Desktop drives the packetcode CLI, but no packetcode binary was found on PATH. Install it, then relaunch."
        detail={phase.probe.detail}
      />
    );
  }

  if (phase.name === "incompatible") {
    return (
      <Gate
        title="packetcode is too old"
        body={`This app needs packetcode ${phase.probe.minimumVersion} or newer (found ${phase.probe.version ?? "unknown"}). Update packetcode, then relaunch.`}
        detail={phase.probe.detail}
      />
    );
  }

  if (phase.name === "error") {
    return (
      <Gate title="Engine error" body="The packetcode engine failed to start." detail={phase.message} />
    );
  }

  return (
    <div className="shell">
      <Sidebar
        engineVersion={phase.probe.version ?? ""}
        activeSessionId={activeSessionId}
      />
      <SessionView cwd={"."} onSessionReady={onSessionReady} />
    </div>
  );
}

function Gate(props: { title: string; body: string; detail?: string }) {
  return (
    <div className="gate">
      <div className="inner">
        <img src="/favicon.png" alt="" />
        <h2>{props.title}</h2>
        <p>{props.body}</p>
        {props.detail ? <div className="detail selectable">{props.detail}</div> : null}
      </div>
    </div>
  );
}
