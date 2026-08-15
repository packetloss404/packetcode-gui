import type { ReactNode } from "react";

/// Full-screen engine gate chrome, shared by every pre-shell state
/// (probing / missing / incompatible / error).
export function Gate(props: {
  title: string;
  body: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="gate">
      <div className="inner">
        <img src="/favicon.png" alt="" />
        <h2>{props.title}</h2>
        <p>{props.body}</p>
        {props.children}
        {props.detail ? (
          <div className="detail selectable">{props.detail}</div>
        ) : null}
      </div>
    </div>
  );
}
