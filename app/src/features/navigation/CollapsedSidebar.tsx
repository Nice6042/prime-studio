import { useId, useState, type ReactNode } from "react";

import { NavigationIcon } from "./ProjectSidebar";
import { controlBinding } from "../conversation/controlBinding";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { WorkspaceFooter } from "./WorkspaceFooter";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";

type ExecuteOperation = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

const RAIL_ACTIONS = ["expand", "new-chat", "search", "settings", "workspace"] as const;
type RailActionId = typeof RAIL_ACTIONS[number];

function RailAction({ actionId, label, description, controlId, action, active, unavailableReason, onFocus, onExecute, children }: {
  readonly actionId: Exclude<RailActionId, "workspace">;
  readonly label: string;
  readonly description: string;
  readonly controlId: string;
  readonly action: StudioOperation;
  readonly active: boolean;
  readonly unavailableReason?: string;
  readonly onFocus: () => void;
  readonly onExecute: ExecuteOperation;
  readonly children: ReactNode;
}) {
  const tooltipId = useId();
  const tooltip = unavailableReason ? `${label} unavailable: ${unavailableReason}` : description;
  return <span className="rail-action">
    <button
      type="button"
      {...controlBinding(controlId, action.action)}
      data-rail-action={actionId}
      aria-label={label}
      aria-describedby={tooltipId}
      aria-disabled={unavailableReason ? "true" : undefined}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      onClick={() => { if (!unavailableReason) void onExecute(action); }}
    >{children}</button>
    <span id={tooltipId} role="tooltip" className="rail-tooltip">{tooltip}</span>
  </span>;
}

export function CollapsedSidebar({ selectedProjectId, newChatDisabledReason, workspace, workspaceMenuOpen, onExecute }: {
  readonly selectedProjectId: string;
  readonly newChatDisabledReason?: string;
  readonly workspace: WorkspaceIdentityProjection;
  readonly workspaceMenuOpen: boolean;
  readonly onExecute: ExecuteOperation;
}) {
  const [activeAction, setActiveAction] = useState<RailActionId>("expand");
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const actions = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-rail-action]'));
    if (actions.length === 0) return;
    event.preventDefault();
    const current = actions.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? actions.length - 1
        : event.key === "ArrowDown" || event.key === "ArrowRight" ? (current + 1 + actions.length) % actions.length
          : (current - 1 + actions.length) % actions.length;
    const target = actions[next];
    const targetId = target?.dataset.railAction as RailActionId | undefined;
    if (targetId) setActiveAction(targetId);
    target?.focus();
  };

  return <div className="collapsed-sidebar" role="toolbar" aria-label="Collapsed navigation" aria-orientation="vertical" onKeyDown={onKeyDown}>
    <RailAction actionId="expand" label="Expand sidebar" description="Expand sidebar (Ctrl+B)" controlId="rail-expand" action={{ action: "layout.sidebar.toggle", payload: {} }} active={activeAction === "expand"} onFocus={() => setActiveAction("expand")} onExecute={onExecute}><NavigationIcon kind="menu" /></RailAction>
    <RailAction actionId="new-chat" label="New chat" description="New chat (Ctrl+N)" controlId="rail-new-chat" action={{ action: "catalog.chat.create", payload: { projectId: selectedProjectId } }} active={activeAction === "new-chat"} unavailableReason={newChatDisabledReason} onFocus={() => setActiveAction("new-chat")} onExecute={onExecute}><NavigationIcon kind="add" /></RailAction>
    <RailAction actionId="search" label="Search" description="Search (Ctrl+K)" controlId="rail-search" action={{ action: "palette.open", payload: {} }} active={activeAction === "search"} onFocus={() => setActiveAction("search")} onExecute={onExecute}><NavigationIcon kind="search" /></RailAction>
    <span className="rail-spacer" aria-hidden="true" />
    <RailAction actionId="settings" label="Settings" description="Settings (Ctrl+,)" controlId="rail-settings" action={{ action: "route.settings.open", payload: {} }} active={activeAction === "settings"} onFocus={() => setActiveAction("settings")} onExecute={onExecute}><NavigationIcon kind="settings" /></RailAction>
    <WorkspaceFooter
      identity={workspace}
      variant="rail"
      open={workspaceMenuOpen}
      onExecute={onExecute}
      railActionId="workspace"
      triggerTabIndex={activeAction === "workspace" ? 0 : -1}
      onTriggerFocus={() => setActiveAction("workspace")}
    />
  </div>;
}
