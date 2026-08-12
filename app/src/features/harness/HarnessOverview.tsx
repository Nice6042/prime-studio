import type { RootSessionProjection } from "../../entities/harness/types";
import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { compactTokenCount, contextPercent, type HarnessPanelDetails } from "./adapter";
import { AgentRow } from "./AgentRow";
import { ContextSection, OutputSourceSections } from "./ContextSection";
import { QueueSection } from "./QueueSection";
import { ToolsSection } from "./ToolsSection";

function formatElapsed(startedAtMs: number | null | undefined, observedAtMs: number): string {
  if (startedAtMs === null || startedAtMs === undefined) return "—";
  const total = Math.max(0, Math.floor((observedAtMs - startedAtMs) / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function HarnessOverview({ session, compatibility, details, nowMs, pendingKey, hiddenNoticeIds, onOpenChild, onOpenActivity, onAction }: {
  readonly session: RootSessionProjection;
  readonly compatibility: HarnessCompatibility;
  readonly details: HarnessPanelDetails | null;
  readonly nowMs: number;
  readonly pendingKey: string | null;
  readonly hiddenNoticeIds: ReadonlySet<string>;
  readonly onOpenChild: (childId: string) => void;
  readonly onOpenActivity: () => void;
  readonly onAction: (operation: StudioOperation, key: string) => void;
}) {
  const active = session.children.filter((child) => child.status === "queued" || child.status === "running");
  const done = session.children.filter((child) => !active.includes(child));
  const controlsEnabled = (compatibility.status === "ready" || compatibility.status === "degraded") && session.freshness === "live";
  const queueEnabled = controlsEnabled && compatibility.capabilities.includes("queue_management");
  const percent = contextPercent(details?.context ?? null);
  const observedAtMs = nowMs;
  const totalTokens = details?.context?.usedTokens ?? session.usage.totalTokens;
  const compactBinding = createControlBinding("harness.session.compact", "harness.session.compact");
  const activeViewAll = createControlBinding("harness.tab.select:active-view-all", "harness.tab.select");
  const doneViewAll = createControlBinding("harness.tab.select:done-view-all", "harness.tab.select");
  return <div className="harness-overview">
    {details?.notices.filter((notice) => !hiddenNoticeIds.has(notice.id)).map((notice) => { const retry = createControlBinding(`harness.overload.retry:${notice.id}`, "harness.overload.retry"); const dismiss = createControlBinding(`harness.overload.dismiss:${notice.id}`, "harness.overload.dismiss"); return <section className="harness-runtime-notice" data-kind={notice.kind} key={notice.id} role={notice.kind === "error" ? "alert" : "status"}><div><strong>{notice.title}</strong><p>{notice.detail}</p></div><div className="harness-notice-actions">{notice.retryable && <button type="button" data-control-id={retry.controlId} disabled={pendingKey === `notice:${notice.id}`} onClick={() => onAction({ action: "harness.overload.retry", payload: { sessionId: session.sessionId, errorId: notice.id } }, `notice:${notice.id}`)}>{pendingKey === `notice:${notice.id}` ? "Retrying…" : "Retry"}</button>}{notice.dismissible && <button type="button" data-control-id={dismiss.controlId} onClick={() => onAction({ action: "harness.overload.dismiss", payload: { chatId: session.chatId, errorId: notice.id } }, `dismiss:${notice.id}`)}>Dismiss</button>}</div></section>; })}
    <section className="harness-main-agent" aria-label="Main agent">
      <span className="harness-agent-dot" data-status={session.state === "working" ? "running" : session.state} aria-hidden="true" />
      <strong>Main agent</strong><span>{session.state}</span><time>{formatElapsed(details?.startedAtMs, observedAtMs)}</time>
    </section>
    <section className="harness-chat-card" aria-label="This chat">
      <div className="harness-card-heading"><strong>This chat</strong><button type="button" data-control-id={compactBinding.controlId} disabled={!controlsEnabled || pendingKey === "compact"} onClick={() => onAction({ action: "harness.session.compact", payload: { sessionId: session.sessionId } }, "compact")} aria-label="Compact context">{pendingKey === "compact" ? "Compacting…" : "Compact"}</button></div>
      <div className="harness-chat-stats">
        <div><span>Context</span><strong>{percent === null ? "Unavailable" : `${percent}%`}</strong><span className="harness-progress" aria-hidden="true"><i style={{ inlineSize: `${percent ?? 0}%` }} /></span></div>
        <div><span>Tokens</span><strong>{compactTokenCount(totalTokens)}</strong></div>
        <div><span>Turns</span><strong>{details?.context?.turns ?? "—"}</strong></div>
      </div>
    </section>
    <section className="harness-agent-group" aria-labelledby="active-agents-title">
      <div className="harness-group-heading"><h2 id="active-agents-title">Active · {active.length}</h2><button type="button" data-control-id={activeViewAll.controlId} onClick={onOpenActivity}>View all</button></div>
      {active.map((child) => <AgentRow key={child.id} child={child} details={details?.children[child.id]} observedAtMs={observedAtMs} onOpen={() => onOpenChild(child.id)} />)}
      {active.length === 0 && <p className="harness-empty">No child agents are active.</p>}
    </section>
    <section className="harness-agent-group" aria-labelledby="done-agents-title">
      <div className="harness-group-heading"><h2 id="done-agents-title">Done · {done.length}</h2><button type="button" data-control-id={doneViewAll.controlId} onClick={onOpenActivity}>View all</button></div>
      {done.map((child) => <AgentRow key={child.id} child={child} details={details?.children[child.id]} observedAtMs={observedAtMs} onOpen={() => onOpenChild(child.id)} />)}
      {done.length === 0 && <p className="harness-empty">No child agents have finished.</p>}
    </section>
    <div className="harness-operational">
      <QueueSection sessionId={session.sessionId} queue={session.queue} enabled={queueEnabled} pendingKey={pendingKey} onAction={onAction} />
      <ToolsSection sessionId={session.sessionId} tools={session.tools} enabled={controlsEnabled} pendingKey={pendingKey} onAction={onAction} />
      <ContextSection sessionId={session.sessionId} resources={session.resources} onAction={onAction} />
      <OutputSourceSections details={details} sessionId={session.sessionId} onAction={onAction} />
    </div>
  </div>;
}
