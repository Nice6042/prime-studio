export type InspectorRoute =
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "child"; childId: string; tab: "chat" | "activity" | "files" }>
  | Readonly<{ kind: "usage" }>
  | Readonly<{ kind: "activity" }>;

export interface InspectorState {
  readonly route: InspectorRoute;
  readonly notice: string | null;
}

export type InspectorIntent =
  | Readonly<{ type: "route/open"; route: "overview" | "usage" | "activity" }>
  | Readonly<{ type: "child/open"; childId: string }>
  | Readonly<{ type: "child/tab"; tab: "chat" | "activity" | "files" }>
  | Readonly<{ type: "children/reconciled"; childIds: readonly string[] }>;

export function createInspectorState(): InspectorState {
  return { route: { kind: "overview" }, notice: null };
}

export function reduceInspector(state: InspectorState, intent: InspectorIntent): InspectorState {
  switch (intent.type) {
    case "route/open":
      return { route: { kind: intent.route }, notice: null };
    case "child/open":
      return { route: { kind: "child", childId: intent.childId, tab: "chat" }, notice: null };
    case "child/tab":
      return state.route.kind === "child" ? { ...state, route: { ...state.route, tab: intent.tab } } : state;
    case "children/reconciled":
      return state.route.kind === "child" && !intent.childIds.includes(state.route.childId)
        ? { route: { kind: "overview" }, notice: "The selected child is no longer available." }
        : state;
  }
}
