// Agent output is untrusted. react-markdown does not render raw HTML by
// default — keep it that way (no rehype-raw).

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown(props: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
    </div>
  );
}
