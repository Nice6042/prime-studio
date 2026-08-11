import type { ParentMessage } from "../../shared/ipc/harness.generated";

export function ActivityFeed({ messages }: { readonly messages: readonly ParentMessage[] }) {
  const items: Array<{ id: string; kind: string; label: string; status: string | null }> = [];
  for (const message of messages) {
    if (message.kind !== "assistant") continue;
    message.blocks.forEach((block, index) => {
      if (block.kind === "thinking") items.push({ id: `${message.id}:thinking:${index}`, kind: "Reasoning", label: block.redacted ? "Redacted reasoning" : block.text, status: null });
      if (block.kind === "tool_call") items.push({ id: `${message.id}:tool:${block.toolCallId}`, kind: "Tool", label: block.toolId, status: block.status });
    });
  }
  const retained = items.slice(-200);
  return <div className="activity-feed">
    <div className="activity-heading"><span>Activity</span><strong>Current chat</strong></div>
    {retained.length === 0 && <p className="harness-empty">No reasoning or tool activity is available.</p>}
    {retained.map((item) => <article className="activity-row" key={item.id}>
      <span>{item.kind}</span><p>{item.label}</p>{item.status && <strong>{item.status}</strong>}
    </article>)}
  </div>;
}
