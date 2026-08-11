import type { ChildAgentSummary } from "../../shared/ipc/harness.generated";

export function AgentRow({ child, onOpen }: { readonly child: ChildAgentSummary; readonly onOpen: () => void }) {
  const detail = [child.provider, child.model].filter(Boolean).join(" · ");
  return <button className="harness-agent-row" type="button" onClick={onOpen} aria-label={`${child.task}, ${child.status}`}>
    <span className="harness-agent-dot" data-status={child.status} aria-hidden="true" />
    <span><strong>{child.task}</strong><small>{detail || "Provider and model unavailable"}</small></span>
    <span className="harness-agent-state">{child.status}</span>
  </button>;
}
