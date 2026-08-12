import type { ContextSource } from "../../shared/ipc/harness.generated";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { HarnessPanelDetails } from "./adapter";

export function ContextSection({ sessionId, resources, onAction }: { readonly sessionId: string; readonly resources: readonly ContextSource[]; readonly onAction: (operation: StudioOperation, key: string) => void }) {
  return <details className="harness-disclosure"><summary><span className="disclosure-icon" aria-hidden="true">◎</span><span>Context</span><small>{resources.length} sources</small></summary>
    <div className="harness-disclosure-body">{resources.length ? resources.map((resource) => { const binding = createControlBinding(`harness.context-source.open:${resource.id}`, "harness.context-source.open"); return <button type="button" data-control-id={binding.controlId} className="harness-resource-button" key={resource.id} disabled={resource.availability !== "available"} onClick={() => onAction({ action: "harness.context-source.open", payload: { sessionId, sourceId: resource.id } }, `source:${resource.id}`)}><strong>{resource.label}</strong><small>{resource.kind} · {resource.availability}</small></button>; }) : <p>Context sources unavailable.</p>}</div>
  </details>;
}

export function OutputSourceSections({ details, onOpen }: {
  readonly details: HarnessPanelDetails | null;
  readonly onOpen: (outputId: string) => void;
}) {
  return <>
    <details className="harness-disclosure"><summary><span className="disclosure-icon" aria-hidden="true">↗</span><span>Outputs</span><small>{details?.outputs.length ?? "—"}</small></summary><div className="harness-disclosure-body">{details?.outputs.length ? details.outputs.map((output) => { const binding = createControlBinding(`editor.artifact.open:${output.id}`, "editor.artifact.open"); return <button className="harness-resource-button" data-control-id={binding.controlId} type="button" key={output.id} onClick={() => onOpen(output.id)}><span>{output.label}</span><small>{output.path}</small></button>; }) : <p>Verified outputs unavailable.</p>}</div></details>
    <details className="harness-disclosure"><summary><span className="disclosure-icon" aria-hidden="true">◫</span><span>Sources</span><small>{details?.sources.length ?? "—"}</small></summary><div className="harness-disclosure-body">{details?.sources.length ? details.sources.map((source) => <div className="harness-source-row" key={source.id}><strong>{source.label}</strong><small>{source.detail}</small></div>) : <p>Verified sources unavailable.</p>}</div></details>
  </>;
}
