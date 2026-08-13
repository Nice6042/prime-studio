import { useId, useState, type ReactNode } from "react";

import { NavigationIcon } from "./ProjectSidebar";
import { controlBinding } from "../conversation/controlBinding";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { commandPlacements, studioCommand, type StudioCommandId } from "../../entities/commands/commandRegistry";
import { WorkspaceFooter } from "./WorkspaceFooter";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";

type ExecuteOperation = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

const RAIL_ACTIONS = ["expand", "new-chat", "search", "settings", "workspace"] as const;
type RailActionId = typeof RAIL_ACTIONS[number];

function RailAction({ actionId, commandId, active, unavailableReason, onFocus, onCommand, children }: {
  readonly actionId: Exclude<RailActionId, "workspace">;
  readonly commandId: StudioCommandId;
  readonly active: boolean;
  readonly unavailableReason?: string;
  readonly onFocus: () => void;
  readonly onCommand: (id: StudioCommandId) => void;
  readonly children: ReactNode;
}) {
  const placement = commandPlacements("rail").find((candidate) => candidate.commandId === commandId);
  if (!placement) throw new Error(`Missing rail placement for ${commandId}.`);
  const command = studioCommand(commandId);
  const label = placement.label ?? command.label;
  const description = `${label}${command.shortcuts[0] ? ` (${placement.hint ?? command.shortcuts[0]})` : ""}`;
  const tooltipId = useId();
  const tooltip = unavailableReason ? `${label} unavailable: ${unavailableReason}` : description;
  return <span className="rail-action">
    <button
      type="button"
      {...controlBinding(placement.id, command.action)}
      data-rail-action={actionId}
      aria-label={label}
      aria-describedby={tooltipId}
      aria-disabled={unavailableReason ? "true" : undefined}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      onClick={() => { if (!unavailableReason) onCommand(command.id); }}
    >{children}</button>
    <span id={tooltipId} role="tooltip" className="rail-tooltip">{tooltip}</span>
  </span>;
}

export function CollapsedSidebar({ newChatDisabledReason, workspace, workspaceMenuOpen, onCommand, onExecuteWorkspaceOperation }: {
  readonly newChatDisabledReason?: string;
  readonly workspace: WorkspaceIdentityProjection;
  readonly workspaceMenuOpen: boolean;
  readonly onCommand: (id: StudioCommandId) => void;
  readonly onExecuteWorkspaceOperation: ExecuteOperation;
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
    <RailAction actionId="expand" commandId="sidebar.toggle" active={activeAction === "expand"} onFocus={() => setActiveAction("expand")} onCommand={onCommand}><NavigationIcon kind="menu" /></RailAction>
    <RailAction actionId="new-chat" commandId="chat.new" active={activeAction === "new-chat"} unavailableReason={newChatDisabledReason} onFocus={() => setActiveAction("new-chat")} onCommand={onCommand}><NavigationIcon kind="add" /></RailAction>
    <RailAction actionId="search" commandId="palette.open" active={activeAction === "search"} onFocus={() => setActiveAction("search")} onCommand={onCommand}><NavigationIcon kind="search" /></RailAction>
    <span className="rail-spacer" aria-hidden="true" />
    <RailAction actionId="settings" commandId="settings.open" active={activeAction === "settings"} onFocus={() => setActiveAction("settings")} onCommand={onCommand}><NavigationIcon kind="settings" /></RailAction>
    <WorkspaceFooter
      identity={workspace}
      variant="rail"
      open={workspaceMenuOpen}
      onExecute={onExecuteWorkspaceOperation}
      railActionId="workspace"
      triggerTabIndex={activeAction === "workspace" ? 0 : -1}
      onTriggerFocus={() => setActiveAction("workspace")}
    />
  </div>;
}
