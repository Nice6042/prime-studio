import type { ChildAgentSummary } from "../../shared/ipc/harness.generated";

export function ChildDetail({ child, tab, onBack, onTab }: {
  readonly child: ChildAgentSummary;
  readonly tab: "chat" | "activity" | "files";
  readonly onBack: () => void;
  readonly onTab: (tab: "chat" | "activity" | "files") => void;
}) {
  return <div className="child-detail">
    <button className="harness-back" type="button" onClick={onBack}>Back to agents</button>
    <header><span className="harness-agent-dot" data-status={child.status} aria-hidden="true" /><div><h2>{child.task}</h2><p>{child.status}</p></div></header>
    <dl className="child-facts">
      <div><dt>Provider</dt><dd>{child.provider ?? "Unavailable"}</dd></div>
      <div><dt>Model</dt><dd>{child.model ?? "Unavailable"}</dd></div>
      <div><dt>Progress</dt><dd>{child.progress === null ? "Unavailable" : `${Math.round(child.progress * 100)}%`}</dd></div>
    </dl>
    <div className="child-tabs" role="tablist" aria-label="Child details">
      {(["chat", "activity", "files"] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} key={item} onClick={() => onTab(item)}>{item[0]?.toLocaleUpperCase()}{item.slice(1)}</button>)}
    </div>
    <section className="child-panel" aria-label={`${tab} for ${child.task}`}>
      {tab === "chat" && <p>Child transcript is not available until the verified child paging capability is connected.</p>}
      {tab === "activity" && <p>Child activity paging is not connected yet.</p>}
      {tab === "files" && <p>No verified child file references are available.</p>}
    </section>
    {(child.status === "running" || child.status === "queued") && <button className="child-stop" type="button" disabled title="Stop-child admission is not connected yet.">Stop child</button>}
  </div>;
}
