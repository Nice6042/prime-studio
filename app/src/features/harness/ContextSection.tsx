import type { ContextSource } from "../../shared/ipc/harness.generated";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { HarnessPanelDetails } from "./adapter";
import { HarnessIcon } from "./HarnessIcon";

export function ContextSection({ resources }: { readonly sessionId: string; readonly resources: readonly ContextSource[]; readonly onAction: (operation: StudioOperation, key: string) => void }) {
  return <details className="harness-disclosure"><summary><span className="disclosure-icon"><HarnessIcon kind="context" /></span><span>Context</span><small>{resources.length} sources</small></summary>
    <div className="harness-disclosure-body">{resources.length ? resources.map((resource) => { const binding = createControlBinding(`harness.context-source.open:${resource.id}`, "harness.context-source.open"); return <button type="button" data-control-id={binding.controlId} className="harness-resource-button" key={resource.id} disabled title="Open the matching identity-bound source below when Harness supplies one."><strong>{resource.label}</strong><small>{resource.kind} · {resource.availability}</small></button>; }) : <p>Context sources unavailable.</p>}</div>
  </details>;
}

export function OutputSourceSections({ details, onOpen }: {
  readonly details: HarnessPanelDetails | null;
  readonly onOpen: (candidateId: string) => void;
}) {
  return <>
    <details className="harness-disclosure"><summary><span className="disclosure-icon"><HarnessIcon kind="output" /></span><span>Outputs</span><small>{details?.outputs.length ?? "—"}</small></summary><div className="harness-disclosure-body">{details?.outputs.length ? details.outputs.map((output) => { const binding = createControlBinding(`editor.artifact.open:${output.id}`, "editor.artifact.open"); return <button className="harness-resource-button" data-control-id={binding.controlId} type="button" key={output.id} disabled={!output.candidateId} title={!output.candidateId ? "No identity-bound file candidate was supplied by Harness." : undefined} onClick={() => output.candidateId && onOpen(output.candidateId)}><span>{output.label}</span><small>{output.kind}{!output.candidateId ? " · unavailable" : ""}</small></button>; }) : <p>Verified outputs unavailable.</p>}</div></details>
    <details className="harness-disclosure"><summary><span className="disclosure-icon"><HarnessIcon kind="source" /></span><span>Sources</span><small>{details?.sources.length ?? "—"}</small></summary><div className="harness-disclosure-body">{details?.sources.length ? details.sources.map((source) => { const binding = createControlBinding(`harness.context-source.open:${source.id}`, "harness.context-source.open"); return <button className="harness-resource-button" data-control-id={binding.controlId} type="button" key={source.id} disabled={!source.candidateId} title={!source.candidateId ? "Harness did not provide an identity-bound file for this source." : undefined} onClick={() => source.candidateId && onOpen(source.candidateId)}><strong>{source.label}</strong><small>{source.detail}{!source.candidateId ? " · unavailable" : ""}</small></button>; }) : <p>Verified sources unavailable.</p>}</div></details>
  </>;
}
