import { useEffect, useReducer } from "react";

import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { ActivityFeed } from "./ActivityFeed";
import { ChatUsage } from "./ChatUsage";
import { ChildDetail } from "./ChildDetail";
import { HarnessOverview } from "./HarnessOverview";
import { InspectorTabs } from "./InspectorTabs";
import { createInspectorState, reduceInspector } from "./inspectorStore";
import "./harness.css";

export function HarnessInspector({ chatId, session, compatibility, onOpenAccountUsage, routeRequest }: {
  readonly chatId: string | null;
  readonly session: RootSessionProjection | null;
  readonly compatibility: HarnessCompatibility;
  readonly onOpenAccountUsage?: () => void;
  readonly routeRequest?: Readonly<{ id: number; route: "overview" | "usage" | "activity" }>;
}) {
  const [state, dispatch] = useReducer(reduceInspector, undefined, createInspectorState);
  useEffect(() => {
    dispatch({ type: "children/reconciled", childIds: session?.children.map((child) => child.id) ?? [] });
  }, [session?.children]);
  useEffect(() => {
    dispatch({ type: "route/open", route: "overview" });
  }, [chatId]);
  useEffect(() => {
    if (routeRequest) dispatch({ type: "route/open", route: routeRequest.route });
  }, [routeRequest]);

  const selectedChildId = state.route.kind === "child" ? state.route.childId : null;
  const child = selectedChildId ? session?.children.find((candidate) => candidate.id === selectedChildId) : null;
  return <div className="harness-inspector">
    <div className="harness-inspector-header"><div><span>Prime</span><strong>Harness</strong></div><span className="harness-compatibility">{compatibility.status.replace("_", " ")}</span></div>
    <InspectorTabs route={state.route} onSelect={(route) => dispatch({ type: "route/open", route })} />
    {state.notice && <p className="harness-notice" role="status">{state.notice}</p>}
    <div className="harness-inspector-content" role="region" aria-label="Harness inspector content">
      {!session && <div className="harness-no-session"><strong>Harness unavailable</strong><p>No Harness session is attached to this chat.</p></div>}
      {session && state.route.kind === "overview" && <HarnessOverview session={session} compatibility={compatibility} onOpenChild={(childId) => dispatch({ type: "child/open", childId })} />}
      {session && state.route.kind === "usage" && <ChatUsage usage={session.usage} onOpenAccountUsage={onOpenAccountUsage} />}
      {session && state.route.kind === "activity" && <ActivityFeed messages={session.parentMessages} />}
      {session && state.route.kind === "child" && child && <ChildDetail child={child} tab={state.route.tab} onBack={() => dispatch({ type: "route/open", route: "overview" })} onTab={(tab) => dispatch({ type: "child/tab", tab })} />}
    </div>
  </div>;
}
