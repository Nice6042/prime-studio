import { createControlBinding } from "../../contracts/studioOperations";
import type { ChildAgentSummary, HarnessCursor } from "../../shared/ipc/harness.generated";
import type { HarnessChildDetails } from "./adapter";

function elapsed(elapsedMs: number | null | undefined): string {
  if (elapsedMs === null || elapsedMs === undefined) return "—";
  const seconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AgentRow({ sessionId, cursor, child, details, onOpen }: {
  readonly sessionId: string;
  readonly cursor: HarnessCursor;
  readonly child: ChildAgentSummary;
  readonly details?: HarnessChildDetails;
  readonly onOpen: () => void;
}) {
  const binding = createControlBinding(`harness.child.open:${child.id}`, "harness.child.open");
  const exact = details?.binding.parentSessionId === sessionId
    && details.binding.childId === child.id
    && details.binding.cursor.runtimeGeneration === cursor.runtimeGeneration
    && details.binding.cursor.sequence === cursor.sequence ? details : undefined;
  const detail = exact?.summary || [exact?.provider, exact?.model].filter(Boolean).join(" · ") || "Provider and model unavailable";
  const progress = child.progress === null ? null : Math.round(child.progress * 100);
  return <button className="harness-agent-row" type="button" data-control-id={binding.controlId} onClick={onOpen} aria-label={`${child.task}, ${child.status}`}>
    <span className="harness-agent-icon" data-status={child.status} aria-hidden="true"><span className="harness-agent-dot" data-status={child.status} /></span>
    <span className="harness-agent-copy"><span><strong>{child.task}</strong><time>{elapsed(exact?.elapsedMs)}</time></span><small>{detail}</small>{progress !== null && <span className="harness-progress" aria-label={`${progress}% complete`}><i style={{ inlineSize: `${progress}%` }} /></span>}</span>
  </button>;
}
