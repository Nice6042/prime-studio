import type { StudioActionId, StudioOperation } from "../../contracts/studioOperations";

export type StudioCommandId =
  | "chat.new"
  | "project.new"
  | "archived.open"
  | "palette.open"
  | "settings.open"
  | "settings.usage"
  | "sidebar.toggle"
  | "inspector.toggle"
  | "editor.open"
  | "editor.close"
  | "history.undo"
  | "history.redo"
  | "window.minimize"
  | "window.maximize"
  | "window.close"
  | "help.prime-agent"
  | "help.support";

export type CommandPlacementSurface = "title-menu" | "title-action" | "window-control" | "palette" | "sidebar" | "rail";
export type TitleMenuName = "File" | "Edit" | "View" | "Window" | "Help";

interface CommandPlacementBase {
  readonly id: string;
  readonly surface: CommandPlacementSurface;
  readonly label?: string;
  readonly hint?: string;
}

export type CommandPlacement =
  | (CommandPlacementBase & Readonly<{ surface: "title-menu"; menu: TitleMenuName }>)
  | (CommandPlacementBase & Readonly<{ surface: Exclude<CommandPlacementSurface, "title-menu"> }>);

export interface CommandAvailabilityContext {
  readonly admissionConnected: boolean;
  /** A consumer may project negotiated/local capability loss without changing command metadata. */
  readonly disabledActions?: Readonly<Partial<Record<StudioActionId, string>>>;
}

export interface StudioCommand {
  readonly id: StudioCommandId;
  readonly label: string;
  readonly group: "Chat" | "View" | "Settings" | "Edit" | "Window" | "Help";
  readonly shortcuts: readonly string[];
  readonly keywords: readonly string[];
  readonly action: StudioActionId;
  readonly placements: readonly CommandPlacement[];
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

export type ComposerKeyboardAction = "submit" | "newline" | "ignore";
export type SendShortcut = "enter" | "ctrl-enter";

export interface ComposerShortcutContext {
  readonly sendShortcut: SendShortcut;
  readonly availability: Readonly<{ enabled: boolean; reason?: string }>;
}

export interface KeyboardShortcutPresentation {
  readonly id: StudioCommandId | "composer.submit" | "composer.newline";
  readonly label: string;
  readonly shortcuts: readonly string[];
  readonly action: StudioActionId;
  readonly availability: Readonly<{ enabled: boolean; reason?: string }>;
}

interface ComposerKeyboardCommand {
  readonly id: "composer.submit" | "composer.newline";
  readonly label: string;
  readonly action: StudioActionId;
  shortcuts(context: ComposerShortcutContext): readonly string[];
  availability(context: ComposerShortcutContext): Readonly<{ enabled: boolean; reason?: string }>;
  matches(input: ShortcutInput & Readonly<{ isComposing: boolean }>, context: ComposerShortcutContext): boolean;
  readonly result: Exclude<ComposerKeyboardAction, "ignore">;
}

const enabled = () => ({ enabled: true }) as const;
const place = <T extends CommandPlacement>(placement: T): T => placement;

const composerKeyboardCommands: readonly ComposerKeyboardCommand[] = [
  {
    id: "composer.submit", label: "Send message", action: "harness.session.prompt", result: "submit",
    shortcuts: ({ sendShortcut }) => [sendShortcut === "ctrl-enter" ? "Ctrl+Enter" : "Enter"],
    availability: ({ availability }) => availability,
    matches: (input, { sendShortcut }) => input.key === "Enter" && !input.shiftKey && !input.isComposing
      && (sendShortcut === "enter" || input.ctrlKey || input.metaKey),
  },
  {
    id: "composer.newline", label: "New line", action: "composer.draft.change", result: "newline",
    shortcuts: ({ sendShortcut }) => sendShortcut === "ctrl-enter" ? ["Enter", "Shift+Enter"] : ["Shift+Enter"],
    availability: enabled,
    matches: (input, { sendShortcut }) => input.key === "Enter"
      && (input.shiftKey || input.isComposing || (sendShortcut === "ctrl-enter" && !input.ctrlKey && !input.metaKey)),
  },
];

const commands: readonly StudioCommand[] = [
  { id: "chat.new", action: "catalog.chat.create", label: "New chat", group: "Chat", shortcuts: ["Ctrl+N"], keywords: ["create", "conversation"], placements: [place({ id: "title.file.new-chat", surface: "title-menu", menu: "File" }), place({ id: "palette.chat.new", surface: "palette" }), place({ id: "sidebar.chat.new", surface: "sidebar" }), place({ id: "rail.chat.new", surface: "rail" })], operation: ({ projectId }) => ({ action: "catalog.chat.create", payload: { projectId } }), availability: enabled },
  { id: "project.new", action: "surface.popover.toggle", label: "New project", group: "Chat", shortcuts: [], keywords: ["create", "folder", "workspace"], placements: [place({ id: "palette.project.new", surface: "palette" }), place({ id: "sidebar.project.new", surface: "sidebar" })], operation: () => ({ action: "surface.popover.toggle", payload: { popoverId: "create-project" } }), availability: enabled },
  { id: "archived.open", action: "route.archived.open", label: "Archived chats", group: "Chat", shortcuts: [], keywords: ["restore", "projects", "conversations"], placements: [place({ id: "palette.archived.open", surface: "palette" }), place({ id: "sidebar.archived.open", surface: "sidebar" })], operation: () => ({ action: "route.archived.open", payload: {} }), availability: enabled },
  { id: "palette.open", action: "palette.open", label: "Open command palette", group: "View", shortcuts: ["Ctrl+K"], keywords: ["search", "actions"], placements: [place({ id: "palette.palette.open", surface: "palette" }), place({ id: "sidebar.palette.open", surface: "sidebar", label: "Search" }), place({ id: "rail.palette.open", surface: "rail", label: "Search" }), place({ id: "title-action.palette.open", surface: "title-action" })], operation: () => ({ action: "palette.open", payload: {} }), availability: enabled },
  { id: "sidebar.toggle", action: "layout.sidebar.toggle", label: "Toggle projects", group: "View", shortcuts: ["Ctrl+B"], keywords: ["sidebar", "navigation"], placements: [place({ id: "title.view.sidebar", surface: "title-menu", menu: "View", label: "Toggle sidebar" }), place({ id: "palette.sidebar.toggle", surface: "palette" }), place({ id: "sidebar.collapse", surface: "sidebar", label: "Collapse sidebar" }), place({ id: "rail.sidebar.toggle", surface: "rail", label: "Expand sidebar" }), place({ id: "title-action.sidebar.toggle", surface: "title-action", label: "Projects" })], operation: () => ({ action: "layout.sidebar.toggle", payload: {} }), availability: enabled },
  { id: "inspector.toggle", action: "layout.inspector.toggle", label: "Toggle Harness", group: "View", shortcuts: ["Ctrl+J"], keywords: ["agents", "usage", "activity", "right panel"], placements: [place({ id: "title.view.inspector", surface: "title-menu", menu: "View" }), place({ id: "palette.inspector.toggle", surface: "palette" }), place({ id: "title-action.inspector.toggle", surface: "title-action", label: "Harness" })], operation: () => ({ action: "layout.inspector.toggle", payload: {} }), availability: enabled },
  { id: "editor.open", action: "layout.editor.toggle", label: "Open editor", group: "View", shortcuts: [], keywords: ["editor", "artifact"], placements: [place({ id: "title-action.editor.open", surface: "title-action" })], operation: () => ({ action: "layout.editor.toggle", payload: {} }), availability: enabled },
  { id: "editor.close", action: "layout.editor.close", label: "Close editor", group: "View", shortcuts: [], keywords: ["editor", "artifact"], placements: [place({ id: "title-action.editor.close", surface: "title-action" })], operation: () => ({ action: "layout.editor.close", payload: {} }), availability: enabled },
  { id: "settings.open", action: "route.settings.open", label: "Open settings", group: "Settings", shortcuts: ["Ctrl+,"], keywords: ["preferences", "configuration"], placements: [place({ id: "title.file.settings", surface: "title-menu", menu: "File", label: "Settings" }), place({ id: "palette.settings.open", surface: "palette" }), place({ id: "sidebar.settings.open", surface: "sidebar", label: "Settings" }), place({ id: "rail.settings.open", surface: "rail", label: "Settings" })], operation: () => ({ action: "route.settings.open", payload: {} }), availability: enabled },
  { id: "settings.usage", action: "usage.account.open", label: "Open account usage", group: "Settings", shortcuts: [], keywords: ["billing", "cost", "tokens"], placements: [place({ id: "palette.settings.usage", surface: "palette" })], operation: () => ({ action: "usage.account.open", payload: {} }), availability: enabled },
  { id: "history.undo", action: "history.undo", label: "Undo", group: "Edit", shortcuts: [], keywords: ["history"], placements: [place({ id: "title.edit.undo", surface: "title-menu", menu: "Edit", hint: "Ctrl+Z" })], operation: () => ({ action: "history.undo", payload: {} }), availability: enabled },
  { id: "history.redo", action: "history.redo", label: "Redo", group: "Edit", shortcuts: [], keywords: ["history"], placements: [place({ id: "title.edit.redo", surface: "title-menu", menu: "Edit", hint: "Ctrl+Y" })], operation: () => ({ action: "history.redo", payload: {} }), availability: enabled },
  { id: "window.minimize", action: "window.minimize", label: "Minimize", group: "Window", shortcuts: [], keywords: ["window"], placements: [place({ id: "title.window.minimize", surface: "title-menu", menu: "Window" }), place({ id: "window-control.minimize", surface: "window-control", label: "Minimize window" })], operation: () => ({ action: "window.minimize", payload: {} }), availability: enabled },
  { id: "window.maximize", action: "window.maximize-toggle", label: "Maximize", group: "Window", shortcuts: [], keywords: ["window", "restore"], placements: [place({ id: "title.window.maximize", surface: "title-menu", menu: "Window" }), place({ id: "window-control.maximize", surface: "window-control", label: "Maximize or restore window" })], operation: () => ({ action: "window.maximize-toggle", payload: {} }), availability: enabled },
  { id: "window.close", action: "window.close", label: "Close", group: "Window", shortcuts: [], keywords: ["window", "exit"], placements: [place({ id: "window-control.close", surface: "window-control", label: "Close window" })], operation: () => ({ action: "window.close", payload: {} }), availability: enabled },
  { id: "help.prime-agent", action: "route.external-docs.open", label: "Prime Agent documentation", group: "Help", shortcuts: [], keywords: ["docs", "help"], placements: [place({ id: "title.help.prime-agent", surface: "title-menu", menu: "Help" })], operation: () => ({ action: "route.external-docs.open", payload: { document: "prime-agent" } }), availability: enabled },
  { id: "help.support", action: "route.external-docs.open", label: "Support", group: "Help", shortcuts: [], keywords: ["help"], placements: [place({ id: "title.help.support", surface: "title-menu", menu: "Help" })], operation: () => ({ action: "route.external-docs.open", payload: { document: "support" } }), availability: enabled },
];

export function validateStudioCommands(definitions: readonly StudioCommand[]): readonly StudioCommand[] {
  const ids = new Set<string>();
  const shortcuts = new Set<string>();
  const placements = new Set<string>();
  for (const command of definitions) {
    if (ids.has(command.id)) throw new Error(`Duplicate Studio command ${command.id}.`);
    ids.add(command.id);
    for (const shortcut of command.shortcuts) {
      const normalized = shortcut.toLocaleLowerCase();
      if (shortcuts.has(normalized)) throw new Error(`Duplicate shortcut ${shortcut}.`);
      shortcuts.add(normalized);
    }
    for (const placement of command.placements) {
      if (placements.has(placement.id)) throw new Error(`Duplicate placement ${placement.id}.`);
      placements.add(placement.id);
    }
  }
  return definitions;
}

export const studioCommands = Object.freeze(validateStudioCommands(commands));

export function studioCommand(id: StudioCommandId): StudioCommand {
  const command = studioCommands.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Missing Studio command ${id}.`);
  return command;
}

export function commandPlacements<S extends CommandPlacementSurface>(surface: S): readonly (CommandPlacement & Readonly<{ surface: S; commandId: StudioCommandId }>)[] {
  return studioCommands.flatMap((command) => command.placements
    .filter((placement): placement is CommandPlacement & Readonly<{ surface: S }> => placement.surface === surface)
    .map((placement) => ({ ...placement, commandId: command.id })));
}

export function commandAvailability(command: StudioCommand, context: CommandAvailabilityContext): Readonly<{ enabled: boolean; reason?: string }> {
  const disabledReason = context.disabledActions?.[command.action];
  return disabledReason ? { enabled: false, reason: disabledReason } : command.availability(context);
}

export function operationForStudioCommand(command: StudioCommand, projectId: string): StudioOperation {
  return command.operation({ projectId });
}

export function createStudioCommandExecutor<T>(
  context: () => Readonly<{ projectId: string; availability: CommandAvailabilityContext }>,
  dispatch: (operation: StudioOperation) => Promise<T>,
) {
  return async (id: StudioCommandId): Promise<T | Readonly<{ status: "unavailable"; reason: string }>> => {
    const command = studioCommand(id);
    const current = context();
    const availability = commandAvailability(command, current.availability);
    if (!availability.enabled) return { status: "unavailable", reason: availability.reason ?? `${command.label} is unavailable.` };
    return dispatch(operationForStudioCommand(command, current.projectId));
  };
}

export function shortcutStudioCommand(input: ShortcutInput): StudioCommand | undefined {
  if (input.altKey || input.shiftKey || !(input.ctrlKey || input.metaKey)) return undefined;
  const chord = `ctrl+${input.key.toLocaleLowerCase()}`;
  return studioCommands.find((command) => command.shortcuts.some((shortcut) => shortcut.toLocaleLowerCase() === chord));
}

export function composerKeyboardShortcutAction(input: ShortcutInput & Readonly<{ isComposing: boolean }>, sendShortcut: SendShortcut = "enter"): ComposerKeyboardAction {
  const context = { sendShortcut, availability: { enabled: true } } as const;
  return composerKeyboardCommands.find((command) => command.matches(input, context))?.result ?? "ignore";
}

export function studioKeyboardShortcutGroups(context: Readonly<{
  commands: CommandAvailabilityContext;
  composer: ComposerShortcutContext;
}>): Readonly<{ application: readonly KeyboardShortcutPresentation[]; composer: readonly KeyboardShortcutPresentation[] }> {
  const application = studioCommands
    .filter((command) => command.shortcuts.length > 0)
    .map((command) => ({ id: command.id, label: command.label, shortcuts: command.shortcuts, action: command.action, availability: commandAvailability(command, context.commands) }));
  return {
    application,
    composer: composerKeyboardCommands.map((command) => ({
      id: command.id,
      label: command.label,
      shortcuts: command.shortcuts(context.composer),
      action: command.action,
      availability: command.availability(context.composer),
    })),
  };
}

export function searchStudioCommands(query: string): readonly StudioCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const paletteIds = new Set(commandPlacements("palette").map((placement) => placement.commandId));
  const candidates = studioCommands.filter((command) => paletteIds.has(command.id));
  const matching = terms.length === 0 ? candidates : candidates.filter((command) => {
    const haystack = [command.label, command.group, ...command.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return matching.slice(0, 100);
}
