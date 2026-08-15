// Things the app did on the user's behalf, in a place the user will see them
// whatever session is on screen.
//
// The only thing this app ever decides by itself is a permission request for a
// session it does not hold: no view could show the card, and leaving it
// unanswered blocks the engine's turn forever. Rejecting is the right call —
// doing it silently is not, because from the user's side a tool call simply
// failed for no stated reason. Hence a toast, dismissible and never
// self-clearing: the record of a refusal should outlive the moment it happened.

import type { Notice } from "../session/store";

/** Enough of a session id to recognise it in the sidebar without wrapping the
 * toast; the full id is in the title attribute. */
function shortId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

function body(notice: Notice): string {
  return notice.kind === "auto_rejected"
    ? "No session in this window owns it, so the request was declined for you and the tool call did not run."
    : "No session in this window owns it, and its options could not be read, so nothing was sent — that turn may still be waiting on the engine.";
}

export function Notices(props: {
  notices: Notice[];
  onDismiss: (id: string) => void;
}) {
  if (props.notices.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {props.notices.map((notice) => (
        <div className="notice" key={notice.id}>
          <div className="notice-head">
            <span className="notice-label">
              {notice.kind === "auto_rejected"
                ? "Permission declined automatically"
                : "Permission left unanswered"}
            </span>
            <button
              className="notice-dismiss"
              aria-label="Dismiss"
              onClick={() => props.onDismiss(notice.id)}
            >
              ✕
            </button>
          </div>
          <div className="notice-target">{notice.title}</div>
          <div className="notice-body">{body(notice)}</div>
          <div className="notice-session" title={notice.sessionId}>
            session {shortId(notice.sessionId)}
          </div>
        </div>
      ))}
    </div>
  );
}
