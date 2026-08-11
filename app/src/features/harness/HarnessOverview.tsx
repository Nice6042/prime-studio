import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { AgentRow } from "./AgentRow";
import { ContextSection } from "./ContextSection";
import { QueueSection } from "./QueueSection";
import { ToolsSection } from "./ToolsSection";

export function HarnessOverview({ session, compatibility, onOpenChild }: {
  readonly session: RootSessionProjection;
  readonly compatibility: HarnessCompatibility;
  readonly onOpenChild: (childId: string) => void;
}) {
  const active = session.children.filter((child) => child.status === "queued" || child.status === "running");
  const done = session.children.filter((child) => !active.includes(child));
  const queueEnabled = (compatibility.status === "ready" || compatibility.status === "degraded") && compatibility.capabilities.includes("queue_management");
  return <div className="harness-overview">
    <section className="harness-hero" aria-label="Main agent">
      <div><span className="harness-kicker">Main agent</span><strong>{session.state}</strong></div>
      <span className="harness-freshness" data-freshness={session.freshness}>{session.freshness}</span>
    </section>
    <section className="harness-section" aria-labelledby="agents-title">
      <div className="harness-section-heading"><h2 id="agents-title">Agents</h2><span>{session.children.length} agents</span></div>
      {active.length > 0 && <><h3>Active</h3>{active.map((child) => <AgentRow key={child.id} child={child} onOpen={() => onOpenChild(child.id)} />)}</>}
      {done.length > 0 && <><h3>Done</h3>{done.map((child) => <AgentRow key={child.id} child={child} onOpen={() => onOpenChild(child.id)} />)}</>}
      {session.children.length === 0 && <p className="harness-empty">No child agents in this chat.</p>}
    </section>
    <div className="harness-operational">
      <QueueSection queue={session.queue} enabled={queueEnabled} />
      <ToolsSection tools={session.tools} />
      <ContextSection resources={session.resources} />
    </div>
  </div>;
}
