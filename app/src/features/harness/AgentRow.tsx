import { createControlBinding } from "../../contracts/studioOperations";
import type { ChildAgentSummary } from "../../shared/ipc/harness.generated";
import type { HarnessChildDetails } from "./adapter";

function elapsed(startedAtMs: number | null | undefined, observedAtMs: number): string {
  if (startedAtMs === null || startedAtMs === undefined) return "—";
  const seconds = Math.max(0, Math.floor((observedAtMs - startedAtMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AgentRow({ child, details, observedAtMs, onOpen }: {
  readonly child: ChildAgentSummary;
  readonly details?: HarnessChildDetails;
  readonly observedAtMs: number;
  readonly onOpen: () => void;
}) {
  const binding = createControlBinding(`harness.child.open:${child.id}`, "harness.child.open");
  const detail = details?.summary || [child.provider, child.model].filter(Boolean).join(" · ") || "Provider and model unavailable";
  const progress = child.progress === null ? null : Math.round(child.progress * 100);
  return <button className="harness-agent-row" type="button" data-control-id={binding.controlId} onClick={onOpen} aria-label={`${child.task}, ${child.status}`}>
    <span className="harness-agent-icon" data-status={child.status} aria-hidden="true"><span className="harness-agent-dot" data-status={child.status} /></span>
    <span className="harness-agent-copy"><span><strong>{child.task}</strong><time>{elapsed(details?.startedAtMs, observedAtMs)}</time></span><small>{detail}</small>{progress !== null && <span className="harness-progress" aria-label={`${progress}% complete`}><i style={{ inlineSize: `${progress}%` }} /></span>}</span>
  </button>;
}
