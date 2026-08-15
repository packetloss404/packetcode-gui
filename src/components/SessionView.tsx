// A window onto one slot of the session store. The view owns nothing but the
// composer's local text: mounting it attaches the slot (once), and unmounting
// it leaves the session running.

import { useCallback, useEffect, useRef } from "react";
import type { McpServerStatus, ModelOption, PermissionMode } from "../acp/types";
import { projectName } from "../project/projects";
import { useSessions } from "../session/SessionsProvider";
import { getEntry, isEngaged, resolveKey, type SessionTarget } from "../session/store";
import { Composer } from "./Composer";
import { TimelineItemView } from "./TimelineItemView";

export function SessionView(props: {
  cwd: string;
  target: SessionTarget;
  models: ModelOption[];
  modelChoice: ModelOption | null;
  onModelChoice: (m: ModelOption) => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (m: PermissionMode) => void;
  /** Modes the engine will accept; null = it did not say, so offer all. */
  allowedPermissionModes: string[] | null;
  /** Mode a session with no override runs under; null = not advertised. */
  engineDefaultMode: string | null;
  /** False only when the engine advertised no usage extension. */
  usageAvailable: boolean;
  /** The engine's configured MCP servers; empty hides the MCP chip entirely
   * (no engine support, or nothing configured). */
  mcpConfigured: McpServerStatus[];
  /** Whether NEW sessions inherit those servers — the user's stored consent,
   * already intersected with what the engine can do. */
  mcpInherit: boolean;
  onMcpInherit: (on: boolean) => void;
}) {
  const { state, open, send, stop, answerPermission, refreshMcp } = useSessions();
  // Latest picker choices, readable without retriggering session creation:
  // changing a picker must never tear down or re-create a live session — the
  // choices only apply to the next session opened.
  const choiceRef = useRef<ModelOption | null>(props.modelChoice);
  choiceRef.current = props.modelChoice;
  const modeRef = useRef<PermissionMode | null>(props.permissionMode);
  modeRef.current = props.permissionMode;
  // Same rule for MCP consent: flipping it must not tear down a live session,
  // so the session keeps the fleet it was opened with and the change lands on
  // the next one — like the model and permission-mode pickers.
  const mcpRef = useRef<boolean>(props.mcpInherit);
  mcpRef.current = props.mcpInherit;

  const key = resolveKey(state, props.target);
  const entry = getEntry(state, key);
  const { cwd, target } = props;

  useEffect(() => {
    // Idempotent per slot: re-entering a session already in the store does not
    // re-issue session/load, which would replay its transcript a second time.
    open(key, target, cwd, choiceRef.current, modeRef.current, mcpRef.current);
  }, [open, key, target, cwd]);

  const onSend = useCallback((text: string) => send(key, text), [send, key]);
  const onStop = useCallback(() => stop(key), [stop, key]);
  const onPermission = useCallback(
    (requestId: string | number, optionId: string) =>
      answerPermission(key, requestId, optionId),
    [answerPermission, key],
  );

  // "Busy" for the composer means "this session owes the engine something":
  // a turn in flight, OR an approval card the engine is blocked on. Driving it
  // from the same derived rule as the sidebar dot is what keeps Stop on screen
  // after a failed prompt — busy alone goes false there, and Stop is the only
  // affordance that unblocks the engine's callClient, which has no timeout.
  const engaged = entry !== null && isEngaged(entry);

  const shownCwd =
    props.target.kind === "load" && props.target.workingDir
      ? props.target.workingDir
      : props.cwd;

  return (
    <section className="content">
      <header className="session-head">
        <h1>Session</h1>
        <span className="chip" title={shownCwd}>
          {projectName(shownCwd)}
        </span>
      </header>
      <div className="chat">
        <div className="flow selectable">
          {(entry?.timeline ?? []).map((item) => (
            <TimelineItemView
              key={item.id}
              item={item}
              onPermission={onPermission}
            />
          ))}
          {entry?.error ? (
            <div className="thought">engine error: {entry.error}</div>
          ) : null}
          {entry?.error && !entry.ready ? (
            // The open gate reopened on failure, but re-selecting the same row
            // yields the same target object and never re-runs the attach
            // effect — without this the session is a permanent dead end.
            <div>
              <button
                className="btn"
                onClick={() =>
                  open(
                    key,
                    target,
                    cwd,
                    choiceRef.current,
                    modeRef.current,
                    mcpRef.current,
                  )
                }
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <Composer
        busy={engaged}
        onSend={onSend}
        onStop={onStop}
        models={props.models}
        sessionModel={entry?.model ?? null}
        modelChoice={props.modelChoice}
        onModelChoice={props.onModelChoice}
        projectDir={shownCwd}
        sessionPermissionMode={entry?.permissionMode ?? null}
        permissionMode={props.permissionMode}
        onPermissionMode={props.onPermissionMode}
        allowedPermissionModes={props.allowedPermissionModes}
        engineDefaultMode={props.engineDefaultMode}
        usage={entry?.usage ?? null}
        mcp={
          props.mcpConfigured.length === 0
            ? null
            : {
                configured: props.mcpConfigured,
                live: entry?.mcpServers ?? [],
                sessionInherits: entry?.mcpInherited ?? false,
                inherit: props.mcpInherit,
                onInherit: props.onMcpInherit,
                onRefresh: () => refreshMcp(key),
              }
        }
      />
    </section>
  );
}
