import type { NavigationState } from "../entities/navigation/navigationStore";

export function workspaceRoute(selectedChatId: string | null): NavigationState {
  return { route: "workspace", settingsSection: null, selectedChatId };
}

export function settingsRoute(section: string | null = null): NavigationState {
  return { route: "settings", settingsSection: section, selectedChatId: null };
}
