export const SECTIONS = [
  { id: "accounts", label: "Accounts" },
  { id: "agent", label: "Prime agent" },
  { id: "kernel", label: "Kernel" },
  { id: "defaults", label: "Defaults" },
  { id: "tools", label: "Connected tools" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
] as const;

export type SettingsSection = (typeof SECTIONS)[number]["id"];

export const isSection = (value: unknown): value is SettingsSection =>
  SECTIONS.some((section) => section.id === value);
