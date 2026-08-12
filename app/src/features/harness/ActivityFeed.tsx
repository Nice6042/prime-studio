import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { HarnessActivityItem, HarnessPanelDetails } from "./adapter";
import type { InspectorState } from "./inspectorStore";

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function dateGroup(value: number, observedAtMs: number): Readonly<{ id: string; label: string; order: number }> {
  if (!Number.isFinite(value) || !Number.isFinite(observedAtMs)) return { id: "unknown", label: "Time unavailable", order: Number.MAX_SAFE_INTEGER };
  const current = new Date(observedAtMs);
  const candidate = new Date(value);
  const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const candidateDay = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate()).getTime();
  const day = Math.round((currentDay - candidateDay) / 86_400_000);
  if (day === 0) return { id: "today", label: "Today", order: 0 };
  if (day === 1) return { id: "yesterday", label: "Yesterday", order: 1 };
  return { id: `date-${candidateDay}`, label: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: candidate.getFullYear() === current.getFullYear() ? undefined : "numeric" }).format(candidate), order: Math.max(2, day) };
}

function ToolDetail({ item, sessionId, onAction }: { readonly item: HarnessActivityItem; readonly sessionId: string; readonly onAction: (operation: StudioOperation, key: string) => void }) {
  if (!item.tool) return null;
  const copy = createControlBinding(`activity.command.copy:${item.id}`, "activity.command.copy");
  return <div className="activity-tool-detail"><div className="activity-detail-row"><span>Command</span><code title={item.tool.command}>{item.tool.command}</code><button type="button" data-control-id={copy.controlId} className="icon-action" aria-label="Copy command" onClick={() => onAction({ action: "activity.command.copy", payload: { activityId: item.id, command: item.tool!.command } }, `copy:${item.id}`)}>Copy</button></div><div className="activity-detail-row"><span>Status</span><strong data-status={item.tool.status}>{item.tool.status}</strong><span>Duration</span><b>{item.tool.durationMs === null ? "Unavailable" : `${item.tool.durationMs} ms`}</b></div>{item.tool.files.length > 0 && <div className="activity-files"><span>Affected files</span>{item.tool.files.map((file) => { const open = createControlBinding(`activity.file.open:${item.id}:${file.candidateId}`, "activity.file.open"); return <button type="button" data-control-id={open.controlId} key={file.candidateId} aria-label={`Open ${file.label}`} onClick={() => onAction({ action: "activity.file.open", payload: { sessionId, activityId: item.id, fileId: file.candidateId } }, `file:${file.candidateId}`)}>{file.label}</button>; })}</div>}</div>;
}

export function ActivityFeed({ sessionId, details, filter, expandedId, onFilter, onToggle, onOpenChild, onAction }: {
  readonly sessionId: string;
  readonly details: HarnessPanelDetails | null;
  readonly filter: InspectorState["activityFilter"];
  readonly expandedId: string | null;
  readonly onFilter: (filter: InspectorState["activityFilter"]) => void;
  readonly onToggle: (id: string) => void;
  readonly onOpenChild: (childId: string) => void;
  readonly onAction: (operation: StudioOperation, key: string) => void;
}) {
  const filters = [["all", "All"], ["agent", "Agents"], ["tool", "Tools"], ["file", "Files"]] as const;
  const visible = [...(details?.activity ?? []).filter((item) => filter === "all" || item.kind === filter)].sort((left, right) => right.occurredAtMs - left.occurredAtMs);
  const groups = [...new Map(visible.map((item) => { const group = dateGroup(item.occurredAtMs, details!.observedAtMs); return [group.id, group] as const; })).values()].sort((left, right) => left.order - right.order);
  const seenEvidenceMissing = visible.some((item) => item.seen === undefined);
  return <div className="activity-feed">
    <div className="activity-filters" aria-label="Activity filters">{filters.map(([id, label]) => { const binding = createControlBinding(`activity.filter.select:${id}`, "activity.filter.select"); return <button type="button" data-control-id={binding.controlId} key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>{label}</button>; })}</div>
    {seenEvidenceMissing && <p className="activity-evidence-note">Seen status is unavailable for this activity.</p>}
    {groups.map((group) => <section className="activity-group" key={group.id} aria-labelledby={`activity-${group.id}`}><h2 id={`activity-${group.id}`}>{group.label}</h2>{visible.filter((item) => dateGroup(item.occurredAtMs, details!.observedAtMs).id === group.id).map((item) => {
      const rowAction: "activity.row.toggle" | "activity.child.open" | "activity.file.open" = item.childId ? "activity.child.open" : item.artifactCandidateId ? "activity.file.open" : "activity.row.toggle";
      const binding = createControlBinding(`activity.row:${item.id}`, rowAction);
      return <article className="activity-item" data-seen={item.seen === undefined ? "unknown" : String(item.seen)} key={item.id}><button type="button" data-control-id={binding.controlId} className="activity-row" aria-expanded={Boolean(item.tool) ? expandedId === item.id : undefined} onClick={() => item.childId ? onOpenChild(item.childId) : item.artifactCandidateId ? onAction({ action: "activity.file.open", payload: { sessionId, activityId: item.id, fileId: item.artifactCandidateId } }, `file:${item.artifactCandidateId}`) : onToggle(item.id)}><time>{timeLabel(item.occurredAtMs)}</time><span className="activity-kind" data-kind={item.kind} aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{(item.seen === false || item.childId) && <span className="activity-row-meta">{item.seen === false && <span className="activity-new">New</span>}{item.childId && <span className="activity-view">View subagent</span>}</span>}</button>{expandedId === item.id && <ToolDetail item={item} sessionId={sessionId} onAction={onAction} />}</article>;
    })}</section>)}
    {details === null ? <p className="harness-empty">Activity evidence is unavailable for this chat.</p> : visible.length === 0 && <p className="harness-empty">No activity matches this filter.</p>}
  </div>;
}
