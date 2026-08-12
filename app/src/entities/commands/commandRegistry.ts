export type StudioCommandId =
  | "chat.new"
  | "palette.open"
  | "settings.open"
  | "settings.usage"
  | "sidebar.toggle"
  | "inspector.toggle";

export interface CommandAvailabilityContext {
  readonly admissionConnected: boolean;
}

export interface StudioCommand {
  readonly id: StudioCommandId;
  readonly label: string;
  readonly group: "Chat" | "View" | "Settings";
  readonly shortcuts: readonly string[];
  readonly keywords: readonly string[];
  readonly action: StudioActionId;
  availability(context: CommandAvailabilityContext): Readonly<{ enabled: boolean; reason?: string }>;
}

const enabled = () => ({ enabled: true }) as const;

export const studioCommands: readonly StudioCommand[] = Object.freeze([
  { id: "chat.new", action: "catalog.chat.create", label: "New chat", group: "Chat", shortcuts: ["Ctrl+N"], keywords: ["create", "conversation"], availability: enabled },
  { id: "palette.open", action: "palette.open", label: "Open command palette", group: "View", shortcuts: ["Ctrl+K"], keywords: ["search", "actions"], availability: enabled },
  { id: "sidebar.toggle", action: "layout.sidebar.toggle", label: "Toggle projects", group: "View", shortcuts: ["Ctrl+B"], keywords: ["sidebar", "navigation"], availability: enabled },
  { id: "inspector.toggle", action: "layout.inspector.toggle", label: "Toggle Harness", group: "View", shortcuts: ["Ctrl+J"], keywords: ["agents", "usage", "activity", "right panel"], availability: enabled },
  { id: "settings.open", action: "route.settings.open", label: "Open settings", group: "Settings", shortcuts: ["Ctrl+,"], keywords: ["preferences", "configuration"], availability: enabled },
  { id: "settings.usage", action: "usage.account.open", label: "Open account usage", group: "Settings", shortcuts: [], keywords: ["billing", "cost", "tokens"], availability: enabled },
]);

export function searchStudioCommands(query: string): readonly StudioCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const commands = terms.length === 0 ? studioCommands : studioCommands.filter((command) => {
    const haystack = [command.label, command.group, ...command.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return commands.slice(0, 100);
}
import type { StudioActionId } from "../../contracts/studioOperations";
