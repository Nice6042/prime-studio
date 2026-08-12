export type StudioSettingsSectionId =
  | "general"
  | "appearance"
  | "composer"
  | "archived"
  | "harness"
  | "usage"
  | "models"
  | "accounts"
  | "tools"
  | "git"
  | "environments"
  | "privacy"
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
  { id: "archived", group: "Preferences", label: "Archived chats", description: "Restore archived projects and conversations.", keywords: ["archive", "restore", "projects", "conversations"] },
  { id: "harness", group: "AI & models", label: "Harness", description: "Settings exposed by the verified Prime Harness runtime.", keywords: ["agents", "runtime", "retry", "context"] },
  { id: "usage", group: "Usage", label: "Usage", description: "Account-wide usage and billing projections.", keywords: ["account-wide", "billing", "cost", "tokens"] },
  { id: "models", group: "AI & models", label: "Models", description: "Verified provider and model availability.", keywords: ["provider", "thinking", "catalog"] },
  { id: "accounts", group: "AI & models", label: "Accounts", description: "Provider logins and isolated Prime agent homes.", keywords: ["login", "provider", "oauth", "profile"] },
  { id: "tools", group: "Tools & integrations", label: "Tools", description: "Harness tools, connections, and effect availability.", keywords: ["tool", "connections", "mcp", "computer use", "browser"] },
  { id: "git", group: "Tools & integrations", label: "Git", description: "Repository source control and review defaults.", keywords: ["repository", "source control", "diff", "commit"] },
  { id: "environments", group: "Tools & integrations", label: "Environments", description: "Execution environment and workspace defaults.", keywords: ["environment", "shell", "working directory", "windows"] },
  { id: "privacy", group: "Admin & safety", label: "Privacy & security", description: "Runtime identity, data handling, and diagnostics.", keywords: ["runtime identity", "permissions", "telemetry", "local-only", "policy", "diagnostics"] },
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
