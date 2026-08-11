import type { InspectorRoute } from "./inspectorStore";

export function InspectorTabs({ route, onSelect }: {
  readonly route: InspectorRoute;
  readonly onSelect: (route: "overview" | "usage" | "activity") => void;
}) {
  const active = route.kind === "child" ? "overview" : route.kind;
  return <div className="harness-tabs" role="tablist" aria-label="Harness views">
    {(["overview", "usage", "activity"] as const).map((tab) => <button
      type="button"
      role="tab"
      aria-selected={active === tab}
      key={tab}
      onClick={() => onSelect(tab)}
    >{tab[0]?.toLocaleUpperCase()}{tab.slice(1)}</button>)}
  </div>;
}
