import { commandAvailability, commandPlacements, studioCommand, type CommandAvailabilityContext, type StudioCommand, type StudioCommandId } from "../../entities/commands/commandRegistry";

export interface PaletteChat { readonly id: string; readonly title: string; readonly project: string; readonly archived?: boolean }
export interface PaletteMessage { readonly id: string; readonly chatId: string; readonly project: string; readonly excerpt: string; readonly channel: "parent" | "child" }

export type PaletteResult =
  | Readonly<{ kind: "command"; id: `command:${StudioCommandId}`; group: "Actions"; title: string; detail: string; command: StudioCommand; enabled: boolean; disabledReason: string | null }>
  | Readonly<{ kind: "chat"; id: `chat:${string}`; group: "Chats"; title: string; detail: string; chatId: string; enabled: true; disabledReason: null }>
  | Readonly<{ kind: "message"; id: `message:${string}`; group: "Messages"; title: string; detail: string; chatId: string; messageId: string; enabled: true; disabledReason: null }>;

const MAX_INDEX_ITEMS = 4096;
const MAX_EXCERPT = 320;

function terms(value: string) { return value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean); }
function matches(query: readonly string[], ...fields: readonly string[]) { const haystack = fields.join(" ").toLocaleLowerCase(); return query.every((term) => haystack.includes(term)); }

export function searchPaletteIndex(query: string, context: CommandAvailabilityContext, chats: readonly PaletteChat[] = [], messages: readonly PaletteMessage[] = []): readonly PaletteResult[] {
  const queryTerms = terms(query.slice(0, 200));
  const commandRows: PaletteResult[] = commandPlacements("palette").map((placement) => studioCommand(placement.commandId)).filter((command) => queryTerms.length === 0 || matches(queryTerms, command.label, command.group, ...command.keywords)).map((command) => {
    const availability = commandAvailability(command, context);
    return { kind: "command", id: `command:${command.id}`, group: "Actions", title: command.label, detail: availability.reason ?? command.group, command, enabled: availability.enabled, disabledReason: availability.reason ?? null };
  });
  const chatRows: PaletteResult[] = chats.slice(0, MAX_INDEX_ITEMS).filter((chat) => !chat.archived && (queryTerms.length === 0 || matches(queryTerms, chat.title, chat.project))).map((chat) => ({ kind: "chat", id: `chat:${chat.id}`, group: "Chats", title: chat.title.slice(0, 160), detail: chat.project.slice(0, 160), chatId: chat.id, enabled: true, disabledReason: null }));
  const messageRows: PaletteResult[] = queryTerms.length === 0 ? [] : messages.slice(0, MAX_INDEX_ITEMS).filter((message) => message.channel === "parent" && matches(queryTerms, message.excerpt, message.project)).map((message) => ({ kind: "message", id: `message:${message.id}`, group: "Messages", title: message.excerpt.replace(/\s+/gu, " ").slice(0, MAX_EXCERPT), detail: message.project.slice(0, 160), chatId: message.chatId, messageId: message.id, enabled: true, disabledReason: null }));
  return [...commandRows, ...chatRows, ...messageRows].slice(0, MAX_INDEX_ITEMS);
}
