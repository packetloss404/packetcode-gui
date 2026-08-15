// Engine-unusable gate with a repair action: offers the official install
// script (the documented README one-liner) with live output. Also used for
// the too-old engine case — the same script performs upgrades.

import { useEffect, useRef, useState } from "react";
import { installEngine, onInstallOutput } from "../acp/client";
import { Gate } from "./Gate";

export function InstallGate(props: {
  title: string;
  body: string;
  actionLabel: string;
  installSupported: boolean;
  detail?: string;
  onInstalled: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onInstallOutput((line) =>
      setLog((prev) => [...prev.slice(-199), line]),
    ).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      mounted.current = false;
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const install = async () => {
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      await installEngine();
      await props.onInstalled();
      // Still mounted means the re-probe still landed on a gate: surface
      // that instead of stranding the user on a success message.
      if (mounted.current) {
        setError(
          "Install finished, but the engine is still not usable — see the log above and the diagnostic below.",
        );
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Gate title={props.title} body={props.body} detail={props.detail}>
      {props.installSupported ? (
        <>
          {busy ? (
            <p>Installing…</p>
          ) : (
            <button className="btn primary" onClick={install}>
              {error ? "Retry" : props.actionLabel}
            </button>
          )}
          {log.length > 0 ? (
            <pre className="tool-output install-log selectable" ref={logRef}>
              {log.join("\n")}
            </pre>
          ) : null}
          {error ? <div className="detail selectable">{error}</div> : null}
        </>
      ) : (
        <p>
          Run the packetcode install script for your platform and make sure the
          binary is on PATH (or set PACKETCODE_GUI_ENGINE), then relaunch.
        </p>
      )}
    </Gate>
  );
}
