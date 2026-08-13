export type InspectorRoute =
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "child"; childId: string; tab: "chat" | "activity" | "files" }>
  | Readonly<{ kind: "usage" }>
  | Readonly<{ kind: "activity" }>;

export interface InspectorState {
  readonly route: InspectorRoute;
  readonly notice: string | null;
  readonly activityFilter: "all" | "agent" | "tool" | "file";
  readonly expandedActivityId: string | null;
}

export type InspectorIntent =
  | Readonly<{ type: "route/open"; route: "overview" | "usage" | "activity" }>
  | Readonly<{ type: "child/open"; childId: string }>
  | Readonly<{ type: "child/tab"; tab: "chat" | "activity" | "files" }>
  | Readonly<{ type: "activity/filter"; filter: InspectorState["activityFilter"] }>
  | Readonly<{ type: "activity/toggle"; activityId: string }>
  | Readonly<{ type: "children/reconciled"; childIds: readonly string[] }>;

export function createInspectorState(route: InspectorRoute = { kind: "overview" }): InspectorState {
  return { route, notice: null, activityFilter: "all", expandedActivityId: null };
}

export function reduceInspector(state: InspectorState, intent: InspectorIntent): InspectorState {
  switch (intent.type) {
    case "route/open":
      return { ...state, route: { kind: intent.route }, notice: null };
    case "child/open":
      return { ...state, route: { kind: "child", childId: intent.childId, tab: "chat" }, notice: null };
    case "child/tab":
      return state.route.kind === "child" ? { ...state, route: { ...state.route, tab: intent.tab } } : state;
    case "activity/filter":
      return { ...state, activityFilter: intent.filter, expandedActivityId: null };
    case "activity/toggle":
      return { ...state, expandedActivityId: state.expandedActivityId === intent.activityId ? null : intent.activityId };
    case "children/reconciled":
      return state.route.kind === "child" && !intent.childIds.includes(state.route.childId)
        ? { ...state, route: { kind: "overview" }, notice: "The selected child is no longer available." }
        : state;
  }
}
