import type { ToolDefinition } from "../../shared/ipc/harness.generated";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import { HarnessIcon } from "./HarnessIcon";

export function ToolsSection({ sessionId, tools, enabled, pendingKey, onAction }: {
  readonly sessionId: string;
  readonly tools: readonly ToolDefinition[];
  readonly enabled: boolean;
  readonly pendingKey: string | null;
  readonly onAction: (operation: StudioOperation, key: string) => void;
}) {
  const enabledCount = tools.filter((tool) => tool.enabled).length;
  return <details className="harness-disclosure"><summary data-control-id="harness-tools-disclosure" data-studio-action="surface.accordion.toggle"><span className="disclosure-icon"><HarnessIcon kind="tools" /></span><span>Tools</span><small>{enabledCount} enabled</small></summary>
    <div className="harness-disclosure-body">
      {tools.length ? tools.map((tool) => { const binding = createControlBinding(`harness.tool.set-enabled:${tool.id}`, "harness.tool.set-enabled"); return <div className="harness-control-row" key={tool.id}><span title={tool.label}>{tool.label}</span><button data-control-id={binding.controlId} className="harness-switch" type="button" role="switch" aria-label={tool.label} aria-checked={tool.enabled} disabled={!enabled || !tool.configurable || pendingKey === `tool:${tool.id}`} onClick={() => onAction({ action: "harness.tool.set-enabled", payload: { sessionId, toolId: tool.id, enabled: !tool.enabled } }, `tool:${tool.id}`)}><span /></button></div>; }) : <p>Tool catalog unavailable.</p>}
    </div>
  </details>;
}
