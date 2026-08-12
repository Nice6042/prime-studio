import { useEffect, useReducer, useRef, useState } from "react";

import { createControlBinding, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import { activityAttentionForChat, type AttentionEvidence, type AttentionState } from "../../attention/attentionLedger";
import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { ActivityFeed } from "./ActivityFeed";
import { type HarnessInspectorAdapter, type HarnessPanelDetails, unavailableHarnessInspectorAdapter } from "./adapter";
import { ChatUsage } from "./ChatUsage";
import { ChildDetail } from "./ChildDetail";
import { HarnessOverview } from "./HarnessOverview";
import { InspectorTabs } from "./InspectorTabs";
import { HarnessIcon } from "./HarnessIcon";
import { createInspectorState, reduceInspector, type InspectorRoute } from "./inspectorStore";
import { useMonotonicNow } from "./monotonicClock";
import "./harness.css";

const storageKey = (chatId: string) => `prime-studio-harness-inspector-v1:${chatId}`;

function adapterIsUnavailable(adapter: HarnessInspectorAdapter): boolean {
  return adapter.availability.status === "unavailable";
}

function restoreRoute(chatId: string | null): InspectorRoute {
  if (!chatId || typeof localStorage === "undefined") return { kind: "overview" };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(chatId)) ?? "null") as unknown;
    if (!value || typeof value !== "object" || !("kind" in value)) return { kind: "overview" };
    if (value.kind === "overview" || value.kind === "usage" || value.kind === "activity") return { kind: value.kind };
    if (value.kind === "child" && "childId" in value && typeof value.childId === "string" && "tab" in value && (value.tab === "chat" || value.tab === "activity" || value.tab === "files")) return { kind: "child", childId: value.childId, tab: value.tab };
  } catch { /* Corrupt renderer preference is ignored. */ }
  return { kind: "overview" };
}

function outcomeMessage(outcome: StudioOperationOutcome): { kind: "status" | "alert"; text: string } {
  if (outcome.status === "accepted") return { kind: "status", text: "Harness accepted the action." };
  if (outcome.status === "queued") return { kind: "status", text: outcome.position === null ? "Action queued." : `Action queued at position ${outcome.position}.` };
  if (outcome.status === "updated") return { kind: "status", text: "Harness view updated." };
  if (outcome.status === "cancelled") return { kind: "status", text: "Action cancelled." };
  if (outcome.status === "unavailable") return { kind: "alert", text: outcome.reason };
  if (outcome.status === "rejected") return { kind: "alert", text: outcome.reason };
  return { kind: "alert", text: outcome.reason };
}

export function HarnessInspector({ chatId, session, compatibility, adapter = unavailableHarnessInspectorAdapter, onExecute, onOpenAccountUsage, onCollapse, routeRequest, attention = { status: "loading" } }: {
  readonly chatId: string | null;
  readonly session: RootSessionProjection | null;
  readonly compatibility: HarnessCompatibility;
  readonly adapter?: HarnessInspectorAdapter;
  readonly onExecute?: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly onOpenAccountUsage?: () => void;
  readonly onCollapse?: () => void;
  readonly routeRequest?: Readonly<{ id: number; route: "overview" | "usage" | "activity" }>;
  readonly attention?: AttentionState;
}) {
  const sessionScope = session ? JSON.stringify([chatId, session.chatId, session.sessionId, session.cursor.runtimeGeneration]) : null;
  const requestIdentity = session ? JSON.stringify([sessionScope, session.cursor.sequence]) : null;
  const [state, dispatch] = useReducer(reduceInspector, chatId, (id) => createInspectorState(restoreRoute(id)));
  const [detailsSnapshot, setDetailsSnapshot] = useState<Readonly<{ scope: string; value: HarnessPanelDetails }> | null>(null);
  const [activityEvidenceSnapshot, setActivityEvidenceSnapshot] = useState<Readonly<{ scope: string; value: AttentionEvidence | null | undefined }> | null>(null);
  const [loadPhase, setLoadPhase] = useState<"idle" | "loading" | "ready" | "unavailable" | "error">("idle");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const [hiddenNoticeIds, setHiddenNoticeIds] = useState<ReadonlySet<string>>(new Set());
  const childReturnFocus = useRef<HTMLElement | null>(null);
  const activitySeenAttempt = useRef<string | null>(null);
  const requestEpoch = useRef(0);
  const currentRequestIdentity = useRef<string | null>(requestIdentity);
  const availabilityStatus = useRef(adapter.availability.status);
  const detailsLoadsInFlight = useRef<Set<number>>(new Set());
  if (currentRequestIdentity.current !== requestIdentity) {
    currentRequestIdentity.current = requestIdentity;
    requestEpoch.current += 1;
  }
  const details = detailsSnapshot?.scope === sessionScope ? detailsSnapshot.value : null;
  const activityEvidence = activityEvidenceSnapshot?.scope === sessionScope ? activityEvidenceSnapshot.value : undefined;
  const currentDetails = useRef(details);
  const currentLoadPhase = useRef(loadPhase);
  currentDetails.current = details;
  currentLoadPhase.current = loadPhase;
  const now = useMonotonicNow(sessionScope, details?.observedAtMs);
  const activityAttention = chatId ? activityAttentionForChat(chatId, activityEvidence, attention) : { status: "unavailable" as const, reason: "Activity content evidence is unavailable for this chat." };

  const loadDetails = async (mode: "foreground" | "background" = "foreground") => {
    const effectiveMode = mode === "background" && currentDetails.current !== null && currentLoadPhase.current !== "unavailable" ? "background" : "foreground";
    const requestedSession = session;
    const requestedScope = sessionScope;
    const requestedIdentity = requestIdentity;
    if (!requestedSession || !requestedScope || !requestedIdentity) {
      setDetailsSnapshot(null);
      setActivityEvidenceSnapshot(null);
      setLoadPhase("idle");
      return;
    }

    const availability = adapter.availability;
    if (availability.status === "unavailable") {
      if (availabilityStatus.current !== "unavailable") requestEpoch.current += 1;
      availabilityStatus.current = "unavailable";
      setDetailsSnapshot(null);
      setActivityEvidenceSnapshot(null);
      setLoadPhase("unavailable");
      return;
    }
    if (availabilityStatus.current === "unavailable") requestEpoch.current += 1;
    availabilityStatus.current = "available";

    const epoch = requestEpoch.current;
    if (detailsLoadsInFlight.current.has(epoch)) return;
    detailsLoadsInFlight.current.add(epoch);
    if (effectiveMode === "foreground") {
      if (details === null) setLoadPhase("loading");
      setActivityEvidenceSnapshot(null);
    }
    try {
      const nextDetails = await adapter.load(requestedSession.sessionId);
      if (currentRequestIdentity.current !== requestedIdentity || requestEpoch.current !== epoch || adapterIsUnavailable(adapter)) return;
      const nextActivityEvidence = adapter.loadActivityEvidence ? await adapter.loadActivityEvidence(requestedSession.sessionId) : undefined;
      if (currentRequestIdentity.current !== requestedIdentity || requestEpoch.current !== epoch || adapterIsUnavailable(adapter)) return;
      setDetailsSnapshot({ scope: requestedScope, value: nextDetails });
      setActivityEvidenceSnapshot({ scope: requestedScope, value: nextActivityEvidence });
      setLoadPhase("ready");
    } catch (error) {
      if (currentRequestIdentity.current !== requestedIdentity || requestEpoch.current !== epoch) return;
      setLoadPhase("error");
      setFeedback({ kind: "alert", text: error instanceof Error ? error.message : "Harness details could not be loaded." });
    } finally {
      detailsLoadsInFlight.current.delete(epoch);
    }
  };

  useEffect(() => { void loadDetails(); }, [requestIdentity, adapter]);
  useEffect(() => {
    if (!session || session.state !== "idle" || session.freshness !== "live") return;
    const timer = window.setInterval(() => { void loadDetails("background"); }, 5_000);
    return () => window.clearInterval(timer);
  }, [adapter, requestIdentity, session?.state, session?.freshness]);
  useEffect(() => {
    dispatch({ type: "children/reconciled", childIds: session?.children.map((child) => child.id) ?? [] });
  }, [session?.children]);
  useEffect(() => {
    const route = restoreRoute(chatId);
    if (route.kind === "child") dispatch({ type: "child/open", childId: route.childId });
    else dispatch({ type: "route/open", route: route.kind });
  }, [chatId]);
  useEffect(() => {
    if (routeRequest) dispatch({ type: "route/open", route: routeRequest.route });
  }, [routeRequest]);
  useEffect(() => {
    if (chatId && typeof localStorage !== "undefined") localStorage.setItem(storageKey(chatId), JSON.stringify(state.route));
  }, [chatId, state.route]);

  const runAction = async (operation: StudioOperation, key: string, quiet = false) => {
    if (pendingKey) return;
    setPendingKey(key);
    if (!quiet) setFeedback(null);
    try {
      const outcome = await (onExecute ?? adapter.execute)(operation);
      const next = outcomeMessage(outcome);
      if (!quiet || next.kind === "alert") setFeedback(next);
      if (outcome.status !== "unavailable" && outcome.status !== "rejected" && outcome.status !== "unknown_outcome") {
        if (operation.action === "harness.overload.dismiss") setHiddenNoticeIds((current) => new Set([...current, operation.payload.errorId]));
        if (operation.action !== "activity.command.copy" && operation.action !== "harness.tab.select" && !operation.action.endsWith("open") && !operation.action.endsWith("toggle") && operation.action !== "harness.child.tab-select" && operation.action !== "harness.child.back") await loadDetails();
      }
    } catch (error) {
      setFeedback({ kind: "alert", text: error instanceof Error ? error.message : "Harness action failed." });
    } finally {
      setPendingKey(null);
    }
  };

  useEffect(() => {
    if (state.route.kind !== "activity" || !chatId || activityAttention.status !== "unseen" || pendingKey) return;
    const key = `${chatId}:${activityAttention.evidence.runtimeGeneration}:${activityAttention.evidence.marker}:${activityAttention.evidence.occurredAtMs}`;
    if (activitySeenAttempt.current === key) return;
    activitySeenAttempt.current = key;
    void runAction({ action: "activity.seen.mark", payload: { chatId, evidence: activityAttention.evidence } }, `activity-seen:${key}`, true);
  }, [activityAttention, chatId, pendingKey, state.route.kind]);

  const selectTopRoute = (route: "overview" | "usage" | "activity") => {
    dispatch({ type: "route/open", route });
    if (chatId) void runAction({ action: "harness.tab.select", payload: { chatId, tab: route === "overview" ? "harness" : route } }, `tab:${route}`, true);
  };
  const openChild = (childId: string) => {
    childReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dispatch({ type: "child/open", childId });
    if (session) void runAction({ action: "harness.child.open", payload: { sessionId: session.sessionId, childId } }, `child:${childId}`, true);
  };
  const backFromChild = () => {
    dispatch({ type: "route/open", route: "overview" });
    if (session) void runAction({ action: "harness.child.back", payload: { sessionId: session.sessionId } }, "child:back", true);
    requestAnimationFrame(() => childReturnFocus.current?.focus());
  };

  const selectedChildId = state.route.kind === "child" ? state.route.childId : null;
  const child = selectedChildId ? session?.children.find((candidate) => candidate.id === selectedChildId) : null;
  const collapse = createControlBinding("layout.inspector.toggle:harness", "layout.inspector.toggle");
  return <div className="harness-inspector" data-load-phase={loadPhase}>
    {state.route.kind !== "child" && <><div className="harness-inspector-header"><div><strong>Harness</strong>{compatibility.status !== "ready" && <span className="harness-compatibility">{compatibility.status.replace("_", " ")}</span>}</div><button type="button" data-control-id={collapse.controlId} className="harness-collapse" aria-label="Collapse inspector" disabled={!onCollapse} title={onCollapse ? undefined : "Inspector layout control is unavailable in this host."} onClick={onCollapse}><HarnessIcon kind="collapse" /></button></div><InspectorTabs route={state.route} onSelect={selectTopRoute} activityAttention={activityAttention} /></>}
    {state.notice && <p className="harness-notice" role="status">{state.notice}</p>}
    {feedback && <p className="harness-operation-feedback" role={feedback.kind}>{feedback.text}</p>}
    {session && adapter.workerRecovery?.status === "unavailable" && <p className="harness-recovery-unavailable" role="status" aria-label="Silent worker recovery unavailable"><strong>Silent worker recovery unavailable.</strong> {adapter.workerRecovery.reason}</p>}
    <div className="harness-inspector-content" role="region" aria-label="Harness inspector content">
      {!session && <div className="harness-no-session"><strong>Harness unavailable</strong><p>No Harness session is attached to this chat.</p></div>}
      {session && loadPhase === "loading" && <div className="harness-loading" role="status" aria-label="Loading Harness details"><span /><span /><span /></div>}
      {session && loadPhase === "unavailable" && <p className="harness-detail-unavailable" role="status">{adapter.availability.status === "unavailable" ? adapter.availability.reason : "Harness details are unavailable."}</p>}
      {session && state.route.kind === "overview" && <HarnessOverview session={session} compatibility={compatibility} details={details} nowMs={now} pendingKey={pendingKey} hiddenNoticeIds={hiddenNoticeIds} onOpenChild={openChild} onOpenActivity={() => selectTopRoute("activity")} onAction={runAction} />}
      {session && state.route.kind === "usage" && <ChatUsage usage={session.usage} details={details} nowMs={now} refreshing={pendingKey === "usage-refresh"} onRefresh={() => void runAction({ action: "usage.current.refresh", payload: { sessionId: session.sessionId } }, "usage-refresh")} onOpenAccountUsage={onOpenAccountUsage ? () => { void runAction({ action: "usage.account.open", payload: {} }, "usage-account", true); onOpenAccountUsage(); } : undefined} />}
      {session && state.route.kind === "activity" && <>{activityAttention?.status === "unavailable" && <p className="activity-evidence-note" role="status">{activityAttention.reason}</p>}<ActivityFeed sessionId={session.sessionId} details={details} filter={state.activityFilter} expandedId={state.expandedActivityId} onFilter={(filter) => { dispatch({ type: "activity/filter", filter }); if (chatId) void runAction({ action: "activity.filter.select", payload: { chatId, filter: filter === "agent" ? "agents" : filter === "tool" ? "tools" : filter === "file" ? "files" : "all" } }, `activity-filter:${filter}`, true); }} onToggle={(activityId) => { dispatch({ type: "activity/toggle", activityId }); if (chatId) void runAction({ action: "activity.row.toggle", payload: { chatId, activityId } }, `activity-row:${activityId}`, true); }} onOpenChild={openChild} onAction={runAction} /></>}
      {session && state.route.kind === "child" && child && <ChildDetail sessionId={session.sessionId} child={child} details={details?.children[child.id] ?? null} observedAtMs={now} tab={state.route.tab} pendingKey={pendingKey} onBack={backFromChild} onTab={(tab) => dispatch({ type: "child/tab", tab })} onAction={runAction} />}
    </div>
  </div>;
}
