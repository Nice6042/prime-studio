import type { ToolDefinition } from "../../shared/ipc/harness.generated";

export function ToolsSection({ tools }: { readonly tools: readonly ToolDefinition[] }) {
  return <details className="harness-disclosure"><summary>Tools <span>{tools.length}</span></summary>
    {tools.length ? tools.map((tool) => <div className="harness-fact-row" key={tool.id}><span>{tool.label}</span><span>{tool.enabled ? "Enabled" : "Disabled"}</span></div>) : <p>Tool catalog unavailable.</p>}
  </details>;
}
