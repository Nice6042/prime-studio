import { NavigationIcon } from "./ProjectSidebar";

export function CollapsedSidebar({ onExpand, onNewChat, onOpenSettings, newChatDisabledReason }: {
  readonly onExpand: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly newChatDisabledReason?: string;
}) {
  return <div className="collapsed-sidebar" aria-label="Collapsed navigation">
    <button type="button" aria-label="Expand sidebar" onClick={onExpand}>P</button>
    <button
      type="button"
      aria-label="New chat"
      onClick={onNewChat}
      disabled={Boolean(newChatDisabledReason)}
      title={newChatDisabledReason}
    ><NavigationIcon kind="add" /></button>
    <span />
    <button type="button" aria-label="Settings" onClick={onOpenSettings}><NavigationIcon kind="settings" /></button>
  </div>;
}
