import { lazy, Suspense } from "react";
import { MarkdownFallback } from "../lazyBoundaries";
import { loadMarkdown } from "../markdownLoader";
import { ToolCard } from "./ToolCard";
import type { ChildActions } from "./ToolCard";
import { childrenForCell, isVerdict, textBlocks } from "../transcript";
import type {
  ChildState,
  ContentBlock,
  ThinkingBlock,
  TimelineItem,
  ToolCallBlock,
  ToolState,
} from "../types";

const Markdown = lazy(loadMarkdown);

function Thinking({ block, live }: { block: ThinkingBlock; live: boolean }) {
  const text = block.thinking ?? "";
  return (
    <details className="thinking">
      <summary>
        <span className={live ? "shimmer" : ""}>Thinking{live ? "…" : ""}</span>
        <span className="thinking-meta">{text ? `${text.split(/\s+/).length} words` : ""}</span>
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

const textOf = (b: ContentBlock) => String((b as { text?: string }).text ?? "");

export function Message({
  item,
  tools,
  children,
  busy,
  last,
  quiet,
  actions,
}: {
  item: TimelineItem;
  tools: Record<string, ToolState>;
  children: ChildState[];
  busy: boolean;
  /** This is the final assistant message in the transcript. */
  last: boolean;
  /** Nothing has run in this session — see `isVerdict`. */
  quiet: boolean;
  actions: ChildActions;
}) {
  if (item.kind === "user") {
    return <div className="user-msg">{item.text}</div>;
  }
  if (item.kind === "notice") {
    return <div className="notice">{item.text}</div>;
  }

  const texts = textBlocks(item);
  const closing = texts[texts.length - 1];
  // A message that goes on to run a cell is a prelude to more work, whatever it
  // says; only a message that stops talking can be stating a conclusion.
  const closesTurn = last && !item.blocks.some((b) => b.type === "toolCall");

  // Consecutive cells share one group (one left rule, one block of lines) so the
  // prose above and below them stays the thing the eye lands on.
  const rendered: React.ReactNode[] = [];
  let group: React.ReactNode[] = [];
  const flush = () => {
    if (!group.length) return;
    rendered.push(
      <div className="cellgroup" key={`g${rendered.length}`}>
        {group}
      </div>,
    );
    group = [];
  };

  item.blocks.forEach((b, i) => {
    if (b.type === "toolCall") {
      const tc = b as ToolCallBlock;
      const tool = tools[tc.id];
      group.push(
        <ToolCard
          key={i}
          block={tc}
          tool={tool}
          children={tool ? childrenForCell(children, tool) : []}
          actions={actions}
        />,
      );
      return;
    }
    flush();
    if (b.type === "thinking") {
      rendered.push(<Thinking key={i} block={b as ThinkingBlock} live={item.streaming} />);
      return;
    }
    if (b.type !== "text") return;
    const text = textOf(b);
    if (!text.trim()) return;
    const live = item.streaming && b === closing;
    if (
      isVerdict(text, {
        closesTurn: closesTurn && b === closing,
        streaming: item.streaming,
        busy,
        quiet,
      })
    ) {
      rendered.push(
        <div className="verdict" key={i}>
          <span className="verdict-label">VERDICT SO FAR</span>
          <Suspense fallback={<MarkdownFallback text={text} />}>
            <Markdown>{text}</Markdown>
          </Suspense>
        </div>,
      );
      return;
    }
    rendered.push(
      <div className={`prose ${live ? "prose-live" : ""}`} key={i}>
        <Suspense fallback={<MarkdownFallback text={text} />}>
          <Markdown>{text}</Markdown>
        </Suspense>
      </div>,
    );
  });
  flush();

  return (
    <div className="assistant-msg">
      {item.blocks.length === 0 && item.streaming && <span className="dots" aria-label="thinking" />}
      {rendered}
    </div>
  );
}
