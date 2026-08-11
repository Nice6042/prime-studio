import type { QueueItem } from "../../shared/ipc/harness.generated";

export function QueueSection({ queue, enabled }: { readonly queue: readonly QueueItem[]; readonly enabled: boolean }) {
  return <details className="harness-disclosure"><summary>Queue <span>{queue.length}</span></summary>
    {queue.length ? queue.map((item) => <div className="harness-fact-row" key={item.id}><span>{item.label}</span><span>{item.state}</span></div>) : <p>Queue is empty.</p>}
    <button type="button" disabled title={enabled ? "Run-now admission is not connected yet." : "Queue management is unavailable."}>Run now</button>
  </details>;
}
