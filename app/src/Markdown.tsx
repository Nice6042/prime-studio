import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

function Pre(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = ref.current?.innerText ?? "";
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="codeblock">
      <button className="copy-btn" onClick={copy} title="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

const components: Components = {
  pre: Pre,
  a: ({ children, ...rest }) => (
    <a {...rest} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

/** Fence long enough that nothing inside `code` can terminate it early. */
function fenceFor(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Highlighted standalone source — reuses the markdown pipeline, no extra deps. */
export function CodeBlock({ code, lang = "" }: { code: string; lang?: string }) {
  const fence = fenceFor(code);
  return <Markdown>{`${fence}${lang}\n${code}\n${fence}`}</Markdown>;
}
