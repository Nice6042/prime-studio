export type StudioSettingsSectionId =
  | "general"
  | "appearance"
  | "composer"
  | "accounts"
  | "usage"
  | "harness"
  | "models"
  | "integrations"
  | "security"
  | "shortcuts"
  | "about";

export type SettingsGroup = "Preferences" | "Usage" | "AI & models" | "Tools & integrations" | "Admin & safety";

export interface SettingsSectionDefinition {
  readonly id: StudioSettingsSectionId;
  readonly group: SettingsGroup;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export const settingsSections: readonly SettingsSectionDefinition[] = Object.freeze([
  { id: "general", group: "Preferences", label: "General", description: "Workspace, language, and file-opening defaults.", keywords: ["workspace", "editor", "language"] },
  { id: "appearance", group: "Preferences", label: "Appearance", description: "Theme, density, motion, and panel defaults.", keywords: ["dark", "light", "system", "theme"] },
  { id: "composer", group: "Preferences", label: "Composer", description: "Sending, drafts, and prompt suggestions.", keywords: ["enter", "send", "draft"] },
  { id: "accounts", group: "AI & models", label: "Accounts", description: "Provider logins and isolated Prime agent homes.", keywords: ["login", "provider", "oauth", "profile"] },
  { id: "usage", group: "Usage", label: "Usage", description: "account-wide usage and billing projections.", keywords: ["account-wide", "billing", "cost", "tokens"] },
  { id: "harness", group: "AI & models", label: "Harness", description: "Settings exposed by the verified Prime Harness runtime.", keywords: ["agents", "runtime", "retry", "context"] },
  { id: "models", group: "AI & models", label: "Models", description: "Verified provider and model availability.", keywords: ["provider", "thinking", "catalog"] },
  { id: "integrations", group: "Tools & integrations", label: "Integrations", description: "Tools, Git, environments, and connected services.", keywords: ["tools", "git", "environment", "connections"] },
  { id: "security", group: "Admin & safety", label: "Security", description: "Runtime identity, authority, storage, and diagnostics.", keywords: ["runtime identity", "permissions", "policy", "diagnostics"] },
  { id: "shortcuts", group: "Admin & safety", label: "Keyboard shortcuts", description: "Keyboard commands available in Prime Studio.", keywords: ["keyboard", "hotkeys", "commands"] },
  { id: "about", group: "Admin & safety", label: "About", description: "Version, licenses, and release status.", keywords: ["version", "licenses", "update"] },
] satisfies readonly SettingsSectionDefinition[]);

export function isStudioSettingsSection(value: unknown): value is StudioSettingsSectionId {
  return typeof value === "string" && settingsSections.some((section) => section.id === value);
}

export function searchSettingsSections(query: string): readonly SettingsSectionDefinition[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return settingsSections;
  return settingsSections.filter((section) => {
    const haystack = [section.label, section.description, ...section.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
