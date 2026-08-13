import type { QueueItem } from "../../shared/ipc/harness.generated";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import { HarnessIcon } from "./HarnessIcon";

function RemoveIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="m4 4 8 8" />
    <path d="m12 4-8 8" />
  </svg>;
}

export function QueueSection({ sessionId, queue, enabled, pendingKey, onAction }: {
  readonly sessionId: string;
  readonly queue: readonly QueueItem[];
  readonly enabled: boolean;
  readonly pendingKey: string | null;
  readonly onAction: (operation: StudioOperation, key: string) => void;
}) {
  return <details className="harness-disclosure"><summary data-control-id="harness-queue-disclosure" data-studio-action="surface.accordion.toggle"><span className="disclosure-icon"><HarnessIcon kind="queue" /></span><span>Queue</span><small>{queue.length ? `${queue.length} pending` : "Empty"}</small></summary>
    <div className="harness-disclosure-body">
      {queue.length ? queue.map((item) => {
        const run = createControlBinding(`harness.queue.run-now:${item.id}`, "harness.queue.run-now");
        const remove = createControlBinding(`harness.queue.remove:${item.id}`, "harness.queue.remove");
        const pending = pendingKey === `queue:${item.id}`;
        return <div className="harness-control-row" key={item.id}><span title={item.label}>{item.label}</span><button type="button" data-control-id={run.controlId} disabled={!enabled || pending} onClick={() => onAction({ action: "harness.queue.run-now", payload: { sessionId, queueItemId: item.id } }, `queue:${item.id}`)} aria-label={`Run ${item.label} now`}>{pending ? "Running\u2026" : "Run now"}</button><button type="button" data-control-id={remove.controlId} className="icon-action danger" disabled={!enabled || pending} onClick={() => onAction({ action: "harness.queue.remove", payload: { sessionId, queueItemId: item.id } }, `queue:${item.id}`)} aria-label={`Remove ${item.label}`}><RemoveIcon /></button></div>;
      }) : <p>Queue is empty.</p>}
    </div>
  </details>;
}
