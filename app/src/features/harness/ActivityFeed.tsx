import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { HarnessActivityItem, HarnessPanelDetails } from "./adapter";
import type { InspectorState } from "./inspectorStore";

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function ToolDetail({ item, sessionId, onAction }: { readonly item: HarnessActivityItem; readonly sessionId: string; readonly onAction: (operation: StudioOperation, key: string) => void }) {
  if (!item.tool) return null;
  const copy = createControlBinding(`activity.command.copy:${item.id}`, "activity.command.copy");
  return <div className="activity-tool-detail"><div className="activity-detail-row"><span>Command</span><code title={item.tool.command}>{item.tool.command}</code><button type="button" data-control-id={copy.controlId} className="icon-action" aria-label="Copy command" onClick={() => onAction({ action: "activity.command.copy", payload: { activityId: item.id, command: item.tool!.command } }, `copy:${item.id}`)}>Copy</button></div><div className="activity-detail-row"><span>Status</span><strong data-status={item.tool.status}>{item.tool.status}</strong><span>Duration</span><b>{item.tool.durationMs === null ? "Unavailable" : `${item.tool.durationMs} ms`}</b></div>{item.tool.files.length > 0 && <div className="activity-files"><span>Affected files</span>{item.tool.files.map((path) => { const open = createControlBinding(`activity.file.open:${item.id}:${path}`, "activity.file.open"); return <button type="button" data-control-id={open.controlId} key={path} aria-label={`Open ${path}`} onClick={() => onAction({ action: "activity.file.open", payload: { sessionId, activityId: item.id, fileId: path } }, `file:${path}`)}>{path}</button>; })}</div>}</div>;
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
  const visible = (details?.activity ?? []).filter((item) => filter === "all" || item.kind === filter);
  const groups = [...new Set(visible.map((item) => item.group))];
  return <div className="activity-feed"><div className="activity-filters" aria-label="Activity filters">{filters.map(([id, label]) => { const binding = createControlBinding(`activity.filter.select:${id}`, "activity.filter.select"); return <button type="button" data-control-id={binding.controlId} key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>{label}</button>; })}</div>{groups.map((group) => <section className="activity-group" key={group} aria-labelledby={`activity-${group}`}><h2 id={`activity-${group}`}>{group}</h2>{visible.filter((item) => item.group === group).map((item) => { const rowAction: "activity.row.toggle" | "activity.child.open" | "activity.file.open" = item.tool ? "activity.row.toggle" : item.childId ? "activity.child.open" : "activity.file.open"; const binding = createControlBinding(`activity.row:${item.id}`, rowAction); return <article className="activity-item" key={item.id}><button type="button" data-control-id={binding.controlId} className="activity-row" aria-expanded={Boolean(item.tool) ? expandedId === item.id : undefined} onClick={() => item.tool ? onToggle(item.id) : item.childId ? onOpenChild(item.childId) : item.filePath ? onAction({ action: "activity.file.open", payload: { sessionId, activityId: item.id, fileId: item.filePath } }, `file:${item.filePath}`) : undefined}><time>{timeLabel(item.occurredAtMs)}</time><span className="activity-kind" data-kind={item.kind} aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{item.childId && <span className="activity-view">View subagent</span>}</button>{expandedId === item.id && <ToolDetail item={item} sessionId={sessionId} onAction={onAction} />}</article>; })}</section>)}{visible.length === 0 && <p className="harness-empty">No activity matches this filter.</p>}</div>;
}
