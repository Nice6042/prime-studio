import type { QueueItem } from "../../shared/ipc/harness.generated";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";

export function QueueSection({ sessionId, queue, enabled, pendingKey, onAction }: {
  readonly sessionId: string;
  readonly queue: readonly QueueItem[];
  readonly enabled: boolean;
  readonly pendingKey: string | null;
  readonly onAction: (operation: StudioOperation, key: string) => void;
}) {
  return <details className="harness-disclosure"><summary><span className="disclosure-icon" aria-hidden="true">⌘</span><span>Queue</span><small>{queue.length ? `${queue.length} pending` : "Empty"}</small></summary>
    <div className="harness-disclosure-body">
      {queue.length ? queue.map((item) => { const run = createControlBinding(`harness.queue.run-now:${item.id}`, "harness.queue.run-now"); const remove = createControlBinding(`harness.queue.remove:${item.id}`, "harness.queue.remove"); return <div className="harness-control-row" key={item.id}><span title={item.label}>{item.label}</span><button type="button" data-control-id={run.controlId} disabled={!enabled || pendingKey === `queue:${item.id}`} onClick={() => onAction({ action: "harness.queue.run-now", payload: { sessionId, queueItemId: item.id } }, `queue:${item.id}`)} aria-label={`Run ${item.label} now`}>{pendingKey === `queue:${item.id}` ? "Running…" : "Run now"}</button><button type="button" data-control-id={remove.controlId} className="icon-action danger" disabled={!enabled || pendingKey === `queue:${item.id}`} onClick={() => onAction({ action: "harness.queue.remove", payload: { sessionId, queueItemId: item.id } }, `queue:${item.id}`)} aria-label={`Remove ${item.label}`}>×</button></div>; }) : <p>Queue is empty.</p>}
    </div>
  </details>;
}
