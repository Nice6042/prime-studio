export type StudioRoute = "workspace" | "settings";

export interface NavigationState {
  readonly route: StudioRoute;
  readonly settingsSection: string | null;
  readonly selectedChatId: string | null;
}

export const initialNavigationState: NavigationState = Object.freeze({
  route: "workspace",
  settingsSection: null,
  selectedChatId: null,
});
