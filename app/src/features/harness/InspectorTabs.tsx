import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
import type { ActivityAttention } from "../../attention/attentionLedger";
import type { InspectorRoute } from "./inspectorStore";

export function InspectorTabs({ route, onSelect, activityAttention, onOverviewButton }: {
  readonly route: InspectorRoute;
  readonly onSelect: (route: "overview" | "usage" | "activity") => void;
  readonly activityAttention?: ActivityAttention;
  readonly onOverviewButton?: (button: HTMLButtonElement | null) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = ["overview", "usage", "activity"] as const;
  const active = route.kind === "child" ? "overview" : route.kind;

  useLayoutEffect(() => {
    if (active !== "overview") return;
    const focused = document.activeElement;
    if (focused === document.body || focused === null || (focused instanceof HTMLElement && !focused.isConnected)) {
      refs.current[0]?.focus();
    }
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : delta ? (index + delta + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onSelect(tabs[next]!);
  };
  return <div className="harness-tabs" role="tablist" aria-label="Harness views">
    {tabs.map((tab, index) => { const binding = createControlBinding(`harness.tab.select:${tab}`, "harness.tab.select"); return <button
      type="button"
      data-control-id={binding.controlId}
      role="tab"
      aria-selected={active === tab}
      tabIndex={active === tab ? 0 : -1}
      ref={(node) => { refs.current[index] = node; if (index === 0) onOverviewButton?.(node); }}
      key={tab}
      aria-label={tab === "activity" && activityAttention?.status === "unseen" ? "Activity, unseen" : undefined}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => onKeyDown(event, index)}
    >{tab === "overview" ? "Harness" : `${tab[0]?.toLocaleUpperCase()}${tab.slice(1)}`}{tab === "activity" && activityAttention?.status === "unseen" && <span className="activity-unseen-dot" aria-hidden="true" />}</button>; })}
  </div>;
}
