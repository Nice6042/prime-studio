import { useEffect, useReducer, useRef, useState } from "react";

import { createControlBinding, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import { activityAttentionForChat, type AttentionEvidence, type AttentionState } from "../../attention/attentionLedger";
import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { ActivityFeed } from "./ActivityFeed";
import { projectHarnessRuntimeStatus, type HarnessInspectorAdapter, type HarnessPanelDetails, type HarnessRuntimeStatusProjection, unavailableHarnessInspectorAdapter } from "./adapter";
import { ChatUsage } from "./ChatUsage";
import { ChildDetail } from "./ChildDetail";
import { HarnessOverview } from "./HarnessOverview";
import { InspectorTabs } from "./InspectorTabs";
import { HarnessIcon } from "./HarnessIcon";
import { ExtensionPrompt } from "./ExtensionPrompt";
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

export function HarnessInspector({ chatId, session, compatibility, adapter = unavailableHarnessInspectorAdapter, onExecute, onOpenAccountUsage, onCollapse, routeRequest, attention = { status: "loading" }, onRuntimeStatus }: {
  readonly chatId: string | null;
  readonly session: RootSessionProjection | null;
  readonly compatibility: HarnessCompatibility;
  readonly adapter?: HarnessInspectorAdapter;
  readonly onExecute?: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly onOpenAccountUsage?: () => void;
  readonly onCollapse?: () => void;
  readonly routeRequest?: Readonly<{ id: number; route: "overview" | "usage" | "activity" }>;
  readonly attention?: AttentionState;
  readonly onRuntimeStatus?: (projection: HarnessRuntimeStatusProjection) => void;
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
  const [settledExtensionSnapshot, setSettledExtensionSnapshot] = useState<Readonly<{ scope: string; ids: ReadonlySet<string> }> | null>(null);
  const extensionAttempts = useRef<Readonly<{ scope: string | null; ids: Set<string> }>>({ scope: requestIdentity, ids: new Set() });
  const childReturnFocus = useRef<HTMLElement | null>(null);
  const stableInspectorFocus = useRef<HTMLButtonElement | null>(null);
  const stableChildFocus = useRef<HTMLButtonElement | null>(null);
  const activitySeenAttempt = useRef<string | null>(null);
  const requestEpoch = useRef(0);
  const currentRequestIdentity = useRef<string | null>(requestIdentity);
  const availabilityStatus = useRef(adapter.availability.status);
  const detailsLoadsInFlight = useRef<Set<number>>(new Set());
  if (currentRequestIdentity.current !== requestIdentity) {
    currentRequestIdentity.current = requestIdentity;
    requestEpoch.current += 1;
  }
  if (extensionAttempts.current.scope !== requestIdentity) extensionAttempts.current = { scope: requestIdentity, ids: new Set() };
  const details = detailsSnapshot?.scope === sessionScope ? detailsSnapshot.value : null;
  const activityEvidence = activityEvidenceSnapshot?.scope === sessionScope ? activityEvidenceSnapshot.value : undefined;
  const currentDetails = useRef(details);
  const currentLoadPhase = useRef(loadPhase);
  currentDetails.current = details;
  currentLoadPhase.current = loadPhase;
  const now = useMonotonicNow(sessionScope, details?.observedAtMs);
  const activityAttention = chatId ? activityAttentionForChat(chatId, activityEvidence, attention) : { status: "unavailable" as const, reason: "Activity content evidence is unavailable for this chat." };
  const settledExtensionIds = settledExtensionSnapshot?.scope === requestIdentity ? settledExtensionSnapshot.ids : new Set<string>();
  const extensionRequests = details?.extensionUi.status === "available" && session
    ? details.extensionUi.requests.filter((request) => request.cursor.runtimeGeneration === session.cursor.runtimeGeneration && request.cursor.sequence === session.cursor.sequence && !settledExtensionIds.has(request.id))
    : [];

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
      onRuntimeStatus?.({ status: "unavailable", sessionId: requestedSession.sessionId, cursor: requestedSession.cursor, reason: availability.reason });
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
      onRuntimeStatus?.(projectHarnessRuntimeStatus(requestedSession, nextDetails));
    } catch (error) {
      if (currentRequestIdentity.current !== requestedIdentity || requestEpoch.current !== epoch) return;
      setLoadPhase("error");
      const reason = error instanceof Error ? error.message : "Harness details could not be loaded.";
      setFeedback({ kind: "alert", text: reason });
      onRuntimeStatus?.({ status: "unavailable", sessionId: requestedSession.sessionId, cursor: requestedSession.cursor, reason });
    } finally {
      detailsLoadsInFlight.current.delete(epoch);
    }
  };

  useEffect(() => { void loadDetails(); }, [requestIdentity, adapter]);
  useEffect(() => {
    const mountedSession = session;
    return () => {
      if (mountedSession) onRuntimeStatus?.({
        status: "unavailable",
        sessionId: mountedSession.sessionId,
        cursor: mountedSession.cursor,
        reason: "Harness inspector evidence is unavailable while its surface is not mounted.",
      });
    };
  }, [requestIdentity, onRuntimeStatus]);
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
  const respondToExtension = (requestId: string, response: Readonly<{ confirmed: boolean }> | Readonly<{ value: string }> | Readonly<{ cancelled: true }>) => {
    if (!session || !requestIdentity || settledExtensionIds.has(requestId) || extensionAttempts.current.ids.has(requestId)) return;
    extensionAttempts.current.ids.add(requestId);
    setSettledExtensionSnapshot({ scope: requestIdentity, ids: new Set([...settledExtensionIds, requestId]) });
    void runAction({ action: "harness.extension.respond", payload: { sessionId: session.sessionId, requestId, response } }, `extension:${requestId}`).then(() => {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement === null) (stableChildFocus.current ?? stableInspectorFocus.current)?.focus();
      });
    });
  };
  return <div className="harness-inspector" data-load-phase={loadPhase}>
    {state.route.kind !== "child" && <><div className="harness-inspector-header"><div><strong>Harness</strong>{compatibility.status !== "ready" && <span className="harness-compatibility">{compatibility.status.replace("_", " ")}</span>}</div><button type="button" data-control-id={collapse.controlId} className="harness-collapse" aria-label="Collapse inspector" disabled={!onCollapse} title={onCollapse ? undefined : "Inspector layout control is unavailable in this host."} onClick={onCollapse}><HarnessIcon kind="collapse" /></button></div><InspectorTabs route={state.route} onSelect={selectTopRoute} activityAttention={activityAttention} onOverviewButton={(button) => { stableInspectorFocus.current = button; }} /></>}
    {state.notice && <p className="harness-notice" role="status">{state.notice}</p>}
    {feedback && <p className="harness-operation-feedback" role={feedback.kind}>{feedback.text}</p>}
    {session && adapter.workerRecovery?.status === "unavailable" && <p className="harness-recovery-unavailable" role="status" aria-label="Silent worker recovery unavailable"><strong>Silent worker recovery unavailable.</strong> {adapter.workerRecovery.reason}</p>}
    {session?.workerRecovery.status === "starting" && <p className="harness-recovery-status" role="status"><strong>Worker starting.</strong> The verified supervisor has not reported this worker ready yet.</p>}
    {session?.workerRecovery.status === "recovering" && <p className="harness-recovery-status" role="status"><strong>Worker stopped unexpectedly.</strong> The verified supervisor is recovering this session.</p>}
    {session?.workerRecovery.status === "retryable_failure" && <p className="harness-recovery-status" role="status"><strong>Supervisor recovery exhausted.</strong> Prime Studio will make the one permitted automatic retry.</p>}
    {session?.workerRecovery.status === "retrying" && <p className="harness-recovery-status" role="status"><strong>Retrying worker.</strong> Automatic retry 1 of 1 is in progress.</p>}
    {session?.workerRecovery.status === "recovered" && <p className="harness-recovery-status" role="status"><strong>Worker recovered.</strong> Automatic retry 1 of 1 completed successfully.</p>}
    {session?.workerRecovery.status === "terminal_failure" && <p className="harness-recovery-status" role="alert"><strong>Worker recovery failed.</strong> {session.workerRecovery.detail ?? "Automatic retry is unavailable or the 1 of 1 retry did not recover the session."}</p>}
    <div className="harness-inspector-content" role="region" aria-label="Harness inspector content">
      {!session && <div className="harness-no-session"><strong>Harness unavailable</strong><p>No Harness session is attached to this chat.</p></div>}
      {session && loadPhase === "loading" && <div className="harness-loading" role="status" aria-label="Loading Harness details"><span /><span /><span /></div>}
      {session && loadPhase === "unavailable" && <p className="harness-detail-unavailable" role="status">{adapter.availability.status === "unavailable" ? adapter.availability.reason : "Harness details are unavailable."}</p>}
      {extensionRequests.length > 0 && <div className="harness-extension-list" aria-label="Extension requests">{extensionRequests.map((request, index) => <ExtensionPrompt key={`${request.id}:${request.cursor.runtimeGeneration}:${request.cursor.sequence}`} request={request} autoFocus={index === 0} disabled={pendingKey !== null} onRespond={(response) => respondToExtension(request.id, response)} />)}</div>}
      {session && state.route.kind === "overview" && <HarnessOverview session={session} compatibility={compatibility} details={details} nowMs={now} pendingKey={pendingKey} hiddenNoticeIds={hiddenNoticeIds} onOpenChild={openChild} onOpenActivity={() => selectTopRoute("activity")} onAction={runAction} />}
      {session && state.route.kind === "usage" && <ChatUsage usage={session.usage} details={details} nowMs={now} refreshing={pendingKey === "usage-refresh"} onRefresh={() => void runAction({ action: "usage.current.refresh", payload: { sessionId: session.sessionId } }, "usage-refresh")} onOpenAccountUsage={onOpenAccountUsage ? () => { void runAction({ action: "usage.account.open", payload: {} }, "usage-account", true); onOpenAccountUsage(); } : undefined} />}
      {session && state.route.kind === "activity" && <>{activityAttention?.status === "unavailable" && <p className="activity-evidence-note" role="status">{activityAttention.reason}</p>}<ActivityFeed sessionId={session.sessionId} details={details} filter={state.activityFilter} expandedId={state.expandedActivityId} onFilter={(filter) => { dispatch({ type: "activity/filter", filter }); if (chatId) void runAction({ action: "activity.filter.select", payload: { chatId, filter: filter === "agent" ? "agents" : filter === "tool" ? "tools" : filter === "file" ? "files" : "all" } }, `activity-filter:${filter}`, true); }} onToggle={(activityId) => { dispatch({ type: "activity/toggle", activityId }); if (chatId) void runAction({ action: "activity.row.toggle", payload: { chatId, activityId } }, `activity-row:${activityId}`, true); }} onOpenChild={openChild} onAction={runAction} /></>}
      {session && state.route.kind === "child" && child && <ChildDetail sessionId={session.sessionId} displayedCursor={session.cursor} child={child} details={details?.children[child.id] ?? null} observedAtMs={now} tab={state.route.tab} pendingKey={pendingKey} onBack={backFromChild} onBackButton={(button) => { stableChildFocus.current = button; }} onTab={(tab) => dispatch({ type: "child/tab", tab })} onAction={runAction} onLoadPage={adapter.loadChildPage} />}
    </div>
  </div>;
}
