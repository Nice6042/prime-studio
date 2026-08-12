import type { StudioActionId, StudioOperation } from "../../contracts/studioOperations";

export type StudioCommandId =
  | "chat.new"
  | "project.new"
  | "archived.open"
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
  /** The same typed operation is used by menus, keyboard shortcuts and palette rows. */
  operation(context: CommandOperationContext): StudioOperation;
  availability(context: CommandAvailabilityContext): Readonly<{ enabled: boolean; reason?: string }>;
}

export interface CommandOperationContext {
  readonly projectId: string;
}

export interface ShortcutInput {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

const enabled = () => ({ enabled: true }) as const;

export const studioCommands: readonly StudioCommand[] = Object.freeze<readonly StudioCommand[]>([
  { id: "chat.new", action: "catalog.chat.create", label: "New chat", group: "Chat", shortcuts: ["Ctrl+N"], keywords: ["create", "conversation"], operation: ({ projectId }) => ({ action: "catalog.chat.create", payload: { projectId } }), availability: enabled },
  { id: "project.new", action: "surface.popover.toggle", label: "New project", group: "Chat", shortcuts: [], keywords: ["create", "folder", "workspace"], operation: () => ({ action: "surface.popover.toggle", payload: { popoverId: "create-project" } }), availability: enabled },
  { id: "archived.open", action: "route.archived.open", label: "Archived chats", group: "Chat", shortcuts: [], keywords: ["restore", "projects", "conversations"], operation: () => ({ action: "route.archived.open", payload: {} }), availability: enabled },
  { id: "palette.open", action: "palette.open", label: "Open command palette", group: "View", shortcuts: ["Ctrl+K"], keywords: ["search", "actions"], operation: () => ({ action: "palette.open", payload: {} }), availability: enabled },
  { id: "sidebar.toggle", action: "layout.sidebar.toggle", label: "Toggle projects", group: "View", shortcuts: ["Ctrl+B"], keywords: ["sidebar", "navigation"], operation: () => ({ action: "layout.sidebar.toggle", payload: {} }), availability: enabled },
  { id: "inspector.toggle", action: "layout.inspector.toggle", label: "Toggle Harness", group: "View", shortcuts: ["Ctrl+J"], keywords: ["agents", "usage", "activity", "right panel"], operation: () => ({ action: "layout.inspector.toggle", payload: {} }), availability: enabled },
  { id: "settings.open", action: "route.settings.open", label: "Open settings", group: "Settings", shortcuts: ["Ctrl+,"], keywords: ["preferences", "configuration"], operation: () => ({ action: "route.settings.open", payload: {} }), availability: enabled },
  { id: "settings.usage", action: "usage.account.open", label: "Open account usage", group: "Settings", shortcuts: [], keywords: ["billing", "cost", "tokens"], operation: () => ({ action: "usage.account.open", payload: {} }), availability: enabled },
]);

export function operationForStudioCommand(command: StudioCommand, projectId: string): StudioOperation {
  return command.operation({ projectId });
}

export function shortcutStudioCommand(input: ShortcutInput): StudioCommand | undefined {
  if (input.altKey || input.shiftKey || !(input.ctrlKey || input.metaKey)) return undefined;
  const chord = `ctrl+${input.key.toLocaleLowerCase()}`;
  return studioCommands.find((command) => command.shortcuts.some((shortcut) => shortcut.toLocaleLowerCase() === chord));
}

export function searchStudioCommands(query: string): readonly StudioCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const commands = terms.length === 0 ? studioCommands : studioCommands.filter((command) => {
    const haystack = [command.label, command.group, ...command.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return commands.slice(0, 100);
}
