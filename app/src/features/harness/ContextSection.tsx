import type { ContextSource } from "../../shared/ipc/harness.generated";

export function ContextSection({ resources }: { readonly resources: readonly ContextSource[] }) {
  return <details className="harness-disclosure"><summary>Context <span>{resources.length}</span></summary>
    {resources.length ? resources.map((resource) => <div className="harness-fact-row" key={resource.id}><span>{resource.label}</span><span>{resource.availability}</span></div>) : <p>Context sources unavailable.</p>}
  </details>;
}
