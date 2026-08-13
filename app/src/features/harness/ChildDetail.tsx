import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { createControlBinding, type StudioOperation } from "../../contracts/studioOperations";
import type { ChildAgentSummary, HarnessCursor } from "../../shared/ipc/harness.generated";
import { compactTokenCount, contextPercent, type HarnessChildDetails } from "./adapter";
import type { HarnessChildDataPage } from "../../shared/ipc/client";
import { HarnessIcon } from "./HarnessIcon";

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function elapsed(startedAtMs: number | null, observedAtMs: number): string {
  if (startedAtMs === null) return "—";
  const total = Math.max(0, Math.floor((observedAtMs - startedAtMs) / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function ChildDetail({ sessionId, displayedCursor, child, details, observedAtMs, tab, pendingKey, onBack, onBackButton, onTab, onAction, onLoadPage }: {
  readonly sessionId: string;
  readonly displayedCursor: HarnessCursor;
  readonly child: ChildAgentSummary;
  readonly details: HarnessChildDetails | null;
  readonly observedAtMs: number;
  readonly tab: "chat" | "activity" | "files";
  readonly pendingKey: string | null;
  readonly onBack: () => void;
  readonly onBackButton?: (button: HTMLButtonElement | null) => void;
  readonly onTab: (tab: "chat" | "activity" | "files") => void;
  readonly onAction: (operation: StudioOperation, key: string) => void;
  readonly onLoadPage?: (sessionId: string, childId: string, tab: "chat" | "activity" | "files", displayedCursor: HarnessCursor, pageCursor: string | null) => Promise<HarnessChildDataPage>;
}) {
  const tabs = ["chat", "activity", "files"] as const;
  const composerDescriptionId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const percent = contextPercent(details?.context ?? null);
  const pageScope = JSON.stringify([sessionId, child.id, displayedCursor.runtimeGeneration, displayedCursor.sequence]);
  const [pageState, setPageState] = useState<Readonly<{ scope: string; pages: Partial<Record<typeof tab, HarnessChildDataPage>> }>>({ scope: pageScope, pages: {} });
  const pages = pageState.scope === pageScope ? pageState.pages : {};
  const [pagePhase, setPagePhase] = useState<"loading" | "paging" | "ready" | "error">("loading");
  const requestEpoch = useRef(0);
  const pageRequestInFlight = useRef<string | null>(null);
  const loadPage = async (pageCursor: string | null) => {
    const requestKey = `${pageScope}:${tab}:${pageCursor ?? "latest"}`;
    if (pageRequestInFlight.current === requestKey) return;
    pageRequestInFlight.current = requestKey;
    const epoch = ++requestEpoch.current;
    if (!onLoadPage) { setPageState({ scope: pageScope, pages: { [tab]: { status: "unavailable", tab, reason: "The installed Harness does not expose child paging." } } }); setPagePhase("ready"); pageRequestInFlight.current = null; return; }
    setPagePhase(pageCursor === null ? "loading" : "paging");
    try {
      const next = await onLoadPage(sessionId, child.id, tab, displayedCursor, pageCursor);
      if (requestEpoch.current !== epoch) return;
      setPageState((current) => {
        const scopedPages = current.scope === pageScope ? current.pages : {};
        const prior = scopedPages[tab];
        if (pageCursor !== null && prior?.status === "available" && next.status === "available" && prior.tab === next.tab) return { scope: pageScope, pages: { ...scopedPages, [tab]: { ...next, items: [...next.items, ...prior.items] } } };
        return { scope: pageScope, pages: { ...scopedPages, [tab]: next } };
      });
      setPagePhase("ready");
    } catch { if (requestEpoch.current === epoch) setPagePhase("error"); }
    finally { if (pageRequestInFlight.current === requestKey) pageRequestInFlight.current = null; }
  };
  useEffect(() => { setPageState({ scope: pageScope, pages: {} }); void loadPage(null); return () => { requestEpoch.current += 1; }; }, [sessionId, child.id, displayedCursor.runtimeGeneration, displayedCursor.sequence, tab, onLoadPage]);
  const page = pages[tab];
  const back = createControlBinding(`harness.child.back:${child.id}`, "harness.child.back");
  const crumb = createControlBinding(`harness.child.back:${child.id}:crumb`, "harness.child.back");
  const close = createControlBinding(`harness.child.back:${child.id}:close`, "harness.child.back");
  const stop = createControlBinding(`harness.child.stop:${child.id}`, "harness.child.stop");
  const retry = createControlBinding(`harness.overload.retry:${child.id}`, "harness.overload.retry");
  const selectTab = (next: typeof tabs[number]) => {
    onTab(next);
    void onAction({ action: "harness.child.tab-select", payload: { sessionId, childId: child.id, tab: next } }, `child-tab:${child.id}:${next}`);
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : delta ? (index + delta + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
    selectTab(tabs[next]!);
  };
  return <div className="child-detail">
    <header className="child-detail-nav"><button ref={onBackButton} type="button" data-control-id={back.controlId} aria-label="Back to Harness" onClick={onBack}><HarnessIcon kind="back" /></button><button type="button" data-control-id={crumb.controlId} onClick={onBack}>Harness</button><span>/</span><strong>{child.task}</strong><button type="button" data-control-id={close.controlId} aria-label="Close child detail" onClick={onBack}><HarnessIcon kind="close" /></button></header>
    <div className="child-detail-scroll">
      <section className="child-status-card"><span className="harness-agent-dot" data-status={child.status} aria-hidden="true" /><div><h2>{child.task}</h2><p>{child.status}</p></div><div><strong>{elapsed(details?.startedAtMs ?? null, observedAtMs)}</strong><span>Elapsed</span></div></section>
      <div className="child-facts"><div><span>Provider</span><strong>{child.provider ?? "Unavailable"}</strong></div><div><span>Model</span><strong>{child.model ?? "Unavailable"}</strong></div></div>
      <section className="child-summary"><span>Task summary</span><p>{details?.summary ?? "Verified child task details are unavailable."}</p></section>
      <section className="child-context"><div><span>Context utilization</span><strong>{percent === null ? "Unavailable" : `${percent}%`}</strong></div><span className="harness-progress"><i style={{ inlineSize: `${percent ?? 0}%` }} /></span><small>{details?.context ? `${compactTokenCount(details.context.usedTokens)} / ${compactTokenCount(details.context.capacityTokens)} tokens` : "Context totals unavailable"}</small></section>
      {details?.error && <section className="child-error" role="alert"><strong>{details.error.code}</strong><p>{details.error.message}</p>{details.error.code === "server_is_overloaded" ? <button type="button" data-control-id={retry.controlId} onClick={() => onAction({ action: "harness.overload.retry", payload: { sessionId, errorId: details.error!.code } }, `child-retry:${child.id}`)}>Retry task</button> : details.error.retryable ? <button type="button" disabled title="The runtime did not provide a retry admission handle.">Retry task</button> : null}</section>}
      <div className="child-tabs" role="tablist" aria-label="Child details">{tabs.map((item, index) => { const binding = createControlBinding(`harness.child.tab-select:${child.id}:${item}`, "harness.child.tab-select"); return <button type="button" data-control-id={binding.controlId} role="tab" aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} ref={(node) => { tabRefs.current[index] = node; }} key={item} onClick={() => selectTab(item)} onKeyDown={(event) => onTabKey(event, index)}>{item[0]?.toLocaleUpperCase()}{item.slice(1)}</button>; })}</div>
      <section className="child-panel" role="tabpanel" aria-label={`${tab} for ${child.task}`}>
        {pagePhase === "loading" && <p role="status">Loading child {tab}…</p>}
        {pagePhase === "error" && <p role="alert">Child {tab} could not be loaded.</p>}
        {page?.status === "unavailable" && <p role="status" aria-label={`Child ${tab} unavailable`}>{page.reason}</p>}
        {page?.status === "available" && page.previousCursor && <button type="button" disabled={pagePhase === "paging"} onClick={() => void loadPage(page.previousCursor)} aria-label={`Load older child ${tab}`}>{pagePhase === "paging" ? "Loading older…" : "Load older"}</button>}
        {page?.status === "available" && page.omittedItems > 0 && <small>{page.omittedItems} older items are not loaded.</small>}
        {page?.status === "available" && page.tab === "chat" && (page.items.length ? <div className="child-transcript">{page.items.map((entry) => <article key={entry.id}><span className="child-entry-dot" aria-hidden="true" /><div><header><strong>{entry.actor}</strong><time>{timeLabel(entry.occurredAtMs)}</time></header><p>{entry.text}</p></div></article>)}</div> : <p>No verified child transcript entries are available.</p>)}
        {page?.status === "available" && page.tab === "activity" && (page.items.length ? <ol className="child-activity">{page.items.map((entry) => <li key={entry.id}><time>{timeLabel(entry.occurredAtMs)}</time><span>{entry.label}</span></li>)}</ol> : <p>No verified child activity is available.</p>)}
        {page?.status === "available" && page.tab === "files" && (page.items.length ? <div className="child-files">{page.items.map((file) => { const open = createControlBinding(`editor.artifact.open:${file.id}`, "editor.artifact.open"); return <button type="button" data-control-id={open.controlId} key={file.id} aria-label={`Open ${file.label}`} onClick={() => onAction({ action: "editor.artifact.open", payload: { sessionId, artifactId: file.candidateId } }, `file:${file.candidateId}`)}><span>{file.label}</span><small>{file.change}</small></button>; })}</div> : <p>No files touched yet.</p>)}
      </section>
    </div>
    <footer className="child-detail-footer"><div className="child-composer-lock"><div className="child-composer-field"><HarnessIcon kind="lock" size={14} /><textarea aria-label="Child message" aria-describedby={composerDescriptionId} readOnly rows={1} value="Child tasks are managed by the harness" /></div><p id={composerDescriptionId}>Read-only in Prime Studio. The verified Harness owns child task input.</p></div>{(child.status === "running" || child.status === "queued") && <button type="button" data-control-id={stop.controlId} className="child-stop" disabled={pendingKey === `child-stop:${child.id}`} onClick={() => onAction({ action: "harness.child.stop", payload: { sessionId, childId: child.id } }, `child-stop:${child.id}`)}>{pendingKey === `child-stop:${child.id}` ? "Stopping…" : "Stop task"}</button>}</footer>
  </div>;
}
