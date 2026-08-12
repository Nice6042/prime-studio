import type { ParentMessage } from "../../shared/ipc/harness.generated";
import type { ConversationTurnPresentation } from "./workspacePresentation";

export type DisplayMessageKind = "user" | "assistant";

export interface MessageDisplayVersions {
  readonly kind: DisplayMessageKind;
  readonly versions: readonly Readonly<{ text: string }>[];
  readonly selected: number;
}

export interface ConversationDisplay {
  readonly messages: Readonly<Record<string, MessageDisplayVersions>>;
}

export function createConversationDisplay(): ConversationDisplay {
  return Object.freeze({ messages: Object.freeze({}) });
}

function freezeVersion(kind: DisplayMessageKind, versions: readonly Readonly<{ text: string }>[], selected: number): MessageDisplayVersions {
  return Object.freeze({ kind, versions: Object.freeze(versions.map((version) => Object.freeze({ text: version.text }))), selected });
}

function sourceVersion(message: ParentMessage): Readonly<{ kind: DisplayMessageKind; text: string }> | null {
  if (message.kind === "user") return { kind: "user", text: message.text };
  if (message.kind !== "assistant" || message.streaming) return null;
  return { kind: "assistant", text: message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n") };
}

export function appendDisplayVersion(
  state: ConversationDisplay,
  messageId: string,
  kind: DisplayMessageKind,
  text: string,
): ConversationDisplay {
  const bounded = Array.from(text).slice(0, 128 * 1024).join("");
  const current = state.messages[messageId];
  if (!messageId || !bounded || current?.kind !== undefined && current.kind !== kind) return state;
  const versions = current?.versions ?? [];
  const existing = versions.findIndex((version) => version.text === bounded);
  if (existing >= 0) return state;
  const next = freezeVersion(kind, [...versions, { text: bounded }], versions.length);
  return Object.freeze({ messages: Object.freeze({ ...state.messages, [messageId]: next }) });
}

export function selectDisplayVersion(
  state: ConversationDisplay,
  messageId: string,
  kind: DisplayMessageKind,
  selected: number,
): ConversationDisplay {
  const current = state.messages[messageId];
  if (!current || current.kind !== kind || !Number.isSafeInteger(selected) || selected < 0 || selected >= current.versions.length || selected === current.selected) return state;
  return Object.freeze({ messages: Object.freeze({ ...state.messages, [messageId]: freezeVersion(kind, current.versions, selected) }) });
}

export function reconcileParentDisplay(state: ConversationDisplay, messages: readonly ParentMessage[]): ConversationDisplay {
  let next = state;
  for (const message of messages) {
    const version = sourceVersion(message);
    if (version) next = appendDisplayVersion(next, message.id, version.kind, version.text);
  }
  return next;
}

export function projectConversationPresentations(state: ConversationDisplay): Readonly<Record<string, ConversationTurnPresentation>> {
  return Object.freeze(Object.fromEntries(Object.entries(state.messages).map(([messageId, message]) => [
    messageId,
    message.kind === "user"
      ? Object.freeze({ userVersions: message.versions, selectedUserVersion: message.selected })
      : Object.freeze({ assistantVersions: message.versions, selectedAssistantVersion: message.selected }),
  ])));
}
