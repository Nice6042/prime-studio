import { NavigationIcon } from "./ProjectSidebar";
import { controlBinding } from "../conversation/controlBinding";

export function CollapsedSidebar({ onExpand, onNewChat, onOpenSearch, onOpenSettings, newChatDisabledReason, workspaceInitials = "LW" }: {
  readonly onExpand: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSearch?: () => void;
  readonly onOpenSettings: () => void;
  readonly newChatDisabledReason?: string;
  readonly workspaceInitials?: string;
}) {
  return <div className="collapsed-sidebar" aria-label="Collapsed navigation">
    <button type="button" {...controlBinding("rail-expand", "layout.sidebar.toggle")} aria-label="Expand sidebar" title="Expand sidebar (Ctrl+B)" onClick={onExpand}><NavigationIcon kind="menu" /></button>
    <button
      type="button"
      {...controlBinding("rail-new-chat", "catalog.chat.create")}
      aria-label="New chat"
      onClick={onNewChat}
      disabled={Boolean(newChatDisabledReason)}
      title={newChatDisabledReason}
    ><NavigationIcon kind="add" /></button>
    {onOpenSearch && <button type="button" {...controlBinding("rail-search", "palette.open")} aria-label="Search" title="Search (Ctrl+K)" onClick={onOpenSearch}><NavigationIcon kind="search" /></button>}
    <span />
    <button type="button" {...controlBinding("rail-settings", "route.settings.open")} aria-label="Settings" title="Settings (Ctrl+,)" onClick={onOpenSettings}><NavigationIcon kind="settings" /></button>
    <span className="collapsed-workspace-avatar" title="Local workspace">{workspaceInitials.slice(0, 2)}</span>
  </div>;
}
