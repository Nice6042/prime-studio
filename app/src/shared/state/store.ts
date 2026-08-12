import type { HarnessCompatibility } from "../ipc/harness.generated";
import { reconcileAttentionSnapshot, type AttentionSnapshot, type AttentionState } from "../../attention/attentionLedger";
import type { BootProjection, RootSessionProjection } from "../../entities/harness/types";
import {
  createInitialProjectChatState,
  transitionProjectChatState,
  type ProjectChatCommand,
  type ProjectChatState,
} from "../../domain/projectChats";
import { normalizeChats, type ChatEntities, type StudioChat } from "../../entities/chats/chatStore";
import { initialNavigationState, type NavigationState } from "../../entities/navigation/navigationStore";
import { normalizeSessions, type SessionEntities } from "../../entities/sessions/sessionStore";
import {
  appendDisplayVersion,
  createConversationDisplay,
  reconcileParentDisplay,
  selectDisplayVersion,
  type ConversationDisplay,
  type DisplayMessageKind,
} from "../../features/conversation/conversationDisplay";

export interface AsyncState {
  readonly generation: number;
  readonly status: "loading" | "resolved";
  readonly value?: unknown;
}

export interface StudioAppState {
  readonly compatibility: HarnessCompatibility;
  readonly projectCatalog: ProjectChatState;
  readonly catalogRevision: number | null;
  readonly chats: ChatEntities;
  readonly sessions: SessionEntities;
  readonly navigation: NavigationState;
  readonly defaultAccountId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly attachments: Readonly<Record<string, readonly DraftAttachment[]>>;
  readonly conversationDisplay: Readonly<Record<string, ConversationDisplay>>;
  readonly async: Readonly<Record<string, AsyncState>>;
  readonly attention: AttentionState;
}

export interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
}

function studioChatIdForSession(catalog: ProjectChatState, session: RootSessionProjection): string | null {
  const matches = catalog.projects.flatMap((project) => project.chats).filter((chat) =>
    !chat.archived
    && chat.binding?.sessionId === session.sessionId
    && chat.binding.accountId === session.accountId
    && (chat.binding.agentId === null || chat.binding.agentId === session.chatId)
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

function reconcileSessionDisplays(
  current: Readonly<Record<string, ConversationDisplay>>,
  catalog: ProjectChatState,
  sessions: SessionEntities,
): Readonly<Record<string, ConversationDisplay>> {
  return Object.freeze(Object.values(sessions).reduce<Record<string, ConversationDisplay>>((display, session) => {
    const studioChatId = studioChatIdForSession(catalog, session);
    if (studioChatId) display[studioChatId] = reconcileParentDisplay(current[studioChatId] ?? createConversationDisplay(), session.parentMessages);
    return display;
  }, { ...current }));
}

export type StudioIntent =
  | Readonly<{ type: "chat/open"; chatId: string }>
  | Readonly<{ type: "chat/create"; chat: StudioChat }>
  | Readonly<{ type: "project-chat/command"; command: ProjectChatCommand }>
  | Readonly<{ type: "draft/change"; chatId: string; draft: string }>
  | Readonly<{ type: "attachments/change"; chatId: string; attachments: readonly DraftAttachment[] }>
  | Readonly<{ type: "conversation/version-appended"; chatId: string; messageId: string; kind: DisplayMessageKind; text: string }>
  | Readonly<{ type: "conversation/version-selected"; chatId: string; messageId: string; kind: DisplayMessageKind; version: number }>
  | Readonly<{ type: "harness/bootstrap-loaded"; projection: BootProjection }>
  | Readonly<{ type: "harness/session-projected"; session: RootSessionProjection }>
  | Readonly<{ type: "project-catalog/loaded"; snapshot: Readonly<{ revision: number; state: ProjectChatState }> }>
  | Readonly<{ type: "account/default-selected"; accountId: string | null }>
  | Readonly<{ type: "attention/loaded"; snapshot: AttentionSnapshot }>
  | Readonly<{ type: "attention/unavailable"; reason: string }>
  | Readonly<{ type: "route/settings"; section?: string }>
  | Readonly<{ type: "route/workspace" }>
  | Readonly<{ type: "async/started"; key: string; generation: number }>
  | Readonly<{ type: "async/resolved"; key: string; generation: number; value: unknown }>;

export function initialStudioState(input: {
  chats?: readonly StudioChat[];
  sessions?: readonly RootSessionProjection[];
  compatibility?: HarnessCompatibility;
  projectCatalog?: ProjectChatState;
} = {}): StudioAppState {
  const projectCatalog = input.projectCatalog ?? createInitialProjectChatState();
  const catalogChats = projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({
    id: chat.id,
    projectId: project.id,
    accountId: chat.binding?.accountId ?? null,
    title: chat.title,
  })));
  const selectedProject = projectCatalog.projects.find(
    (project) => project.id === projectCatalog.selectedProjectId && !project.archived,
  );
  const selectedChatId = selectedProject?.chats.some(
    (chat) => chat.id === selectedProject.selectedChatId && !chat.archived,
  ) ? selectedProject.selectedChatId : null;
  const sessions = normalizeSessions(input.sessions ?? []);
  const conversationDisplay = reconcileSessionDisplays({}, projectCatalog, sessions);
  return {
    compatibility: input.compatibility ?? { status: "unavailable", reason: "security_verification_failed" },
    projectCatalog,
    catalogRevision: input.projectCatalog ? 0 : null,
    chats: normalizeChats(input.projectCatalog ? catalogChats : (input.chats ?? catalogChats)),
    sessions,
    navigation: selectedChatId
      ? { route: "workspace", settingsSection: null, selectedChatId }
      : initialNavigationState,
    defaultAccountId: null,
    drafts: Object.freeze({}),
    attachments: Object.freeze({}),
    conversationDisplay,
    async: Object.freeze({}),
    attention: { status: "loading" },
  };
}

export function reduceStudio(state: StudioAppState, intent: StudioIntent): StudioAppState {
  switch (intent.type) {
    case "chat/open": {
      if (!state.chats[intent.chatId] || state.navigation.selectedChatId === intent.chatId && state.navigation.route === "workspace") return state;
      return { ...state, navigation: { route: "workspace", settingsSection: null, selectedChatId: intent.chatId } };
    }
    case "chat/create": {
      if (state.chats[intent.chat.id]) return state;
      const chat = Object.freeze({ ...intent.chat });
      return {
        ...state,
        chats: Object.freeze({ ...state.chats, [chat.id]: chat }),
        navigation: { route: "workspace", settingsSection: null, selectedChatId: chat.id },
      };
    }
    case "project-chat/command": {
      const result = transitionProjectChatState(state.projectCatalog, intent.command);
      if (result.status !== "applied") return state;
      const chats = normalizeChats(result.state.projects.flatMap((project) => project.chats.map((chat) => ({
        id: chat.id,
        projectId: project.id,
        accountId: chat.binding?.accountId ?? state.chats[chat.id]?.accountId ?? null,
        title: chat.title,
      }))));
      const selectedChatId = result.selection.status === "resolved" ? result.selection.chatId : null;
      const drafts = Object.freeze(Object.fromEntries(Object.entries(state.drafts).filter(([chatId]) => Boolean(chats[chatId]))));
      const attachments = Object.freeze(Object.fromEntries(Object.entries(state.attachments).filter(([chatId]) => Boolean(chats[chatId]))));
      const conversationDisplay = Object.freeze(Object.fromEntries(Object.entries(state.conversationDisplay).filter(([chatId]) => Boolean(chats[chatId]))));
      return {
        ...state,
        projectCatalog: result.state,
        chats,
        drafts,
        attachments,
        conversationDisplay,
        navigation: { route: "workspace", settingsSection: null, selectedChatId },
      };
    }
    case "draft/change": {
      if (!state.chats[intent.chatId]) return state;
      const draft = Array.from(intent.draft).slice(0, 64 * 1024).join("");
      if (state.drafts[intent.chatId] === draft) return state;
      return { ...state, drafts: Object.freeze({ ...state.drafts, [intent.chatId]: draft }) };
    }
    case "attachments/change": {
      if (!state.chats[intent.chatId] || intent.attachments.length > 8) return state;
      if (intent.attachments.some((attachment) =>
        !attachment.id || attachment.id.length > 1024 ||
        !attachment.name || Array.from(attachment.name).length > 255 ||
        !attachment.mediaType || attachment.mediaType.length > 255 ||
        !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 20 * 1024 * 1024
      )) return state;
      const total = intent.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
      if (total > 50 * 1024 * 1024 || new Set(intent.attachments.map((attachment) => attachment.id)).size !== intent.attachments.length) return state;
      const attachments = Object.freeze(intent.attachments.map((attachment) => Object.freeze({ ...attachment })));
      return { ...state, attachments: Object.freeze({ ...state.attachments, [intent.chatId]: attachments }) };
    }
    case "conversation/version-appended": {
      if (!state.chats[intent.chatId]) return state;
      const current = state.conversationDisplay[intent.chatId] ?? createConversationDisplay();
      const next = appendDisplayVersion(current, intent.messageId, intent.kind, intent.text);
      if (next === current) return state;
      return { ...state, conversationDisplay: Object.freeze({ ...state.conversationDisplay, [intent.chatId]: next }) };
    }
    case "conversation/version-selected": {
      const current = state.conversationDisplay[intent.chatId];
      if (!current) return state;
      const next = selectDisplayVersion(current, intent.messageId, intent.kind, intent.version);
      if (next === current) return state;
      return { ...state, conversationDisplay: Object.freeze({ ...state.conversationDisplay, [intent.chatId]: next }) };
    }
    case "harness/bootstrap-loaded": {
      const sessions = normalizeSessions(intent.projection.sessions);
      return {
        ...state,
        compatibility: intent.projection.compatibility,
        sessions,
        conversationDisplay: reconcileSessionDisplays(state.conversationDisplay, state.projectCatalog, sessions),
      };
    }
    case "harness/session-projected": {
      const studioChatId = studioChatIdForSession(state.projectCatalog, intent.session);
      if (!studioChatId) return state;
      const display = reconcileParentDisplay(state.conversationDisplay[studioChatId] ?? createConversationDisplay(), intent.session.parentMessages);
      return {
        ...state,
        sessions: Object.freeze({ ...state.sessions, [intent.session.sessionId]: intent.session }),
        conversationDisplay: Object.freeze({ ...state.conversationDisplay, [studioChatId]: display }),
      };
    }
    case "project-catalog/loaded": {
      const projectCatalog = intent.snapshot.state;
      const chats = normalizeChats(projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({
        id: chat.id,
        projectId: project.id,
        accountId: chat.binding?.accountId ?? state.chats[chat.id]?.accountId ?? null,
        title: chat.title,
      }))));
      const selectedProject = projectCatalog.projects.find((project) => project.id === projectCatalog.selectedProjectId && !project.archived);
      const selectedChatId = selectedProject?.chats.some((chat) => chat.id === selectedProject.selectedChatId && !chat.archived)
        ? selectedProject.selectedChatId
        : null;
      return {
        ...state,
        projectCatalog,
        catalogRevision: intent.snapshot.revision,
        chats,
        conversationDisplay: reconcileSessionDisplays(state.conversationDisplay, projectCatalog, state.sessions),
        navigation: { route: "workspace", settingsSection: null, selectedChatId },
      };
    }
    case "account/default-selected":
      return state.defaultAccountId === intent.accountId ? state : { ...state, defaultAccountId: intent.accountId };
    case "attention/loaded":
      if (state.attention.status === "available" && state.attention.revision >= intent.snapshot.revision) return state;
      return { ...state, attention: reconcileAttentionSnapshot(intent.snapshot) };
    case "attention/unavailable":
      return { ...state, attention: { status: "unavailable", reason: intent.reason } };
    case "route/settings":
      return { ...state, navigation: { route: "settings", settingsSection: intent.section ?? null, selectedChatId: state.navigation.selectedChatId } };
    case "route/workspace":
      return state.navigation.route === "workspace" ? state : { ...state, navigation: { ...state.navigation, route: "workspace", settingsSection: null } };
    case "async/started": {
      const current = state.async[intent.key];
      if (current && current.generation >= intent.generation) return state;
      return { ...state, async: Object.freeze({ ...state.async, [intent.key]: { generation: intent.generation, status: "loading" } }) };
    }
    case "async/resolved": {
      const current = state.async[intent.key];
      if (!current || current.generation !== intent.generation || current.status !== "loading") return state;
      return { ...state, async: Object.freeze({ ...state.async, [intent.key]: { generation: intent.generation, status: "resolved", value: intent.value } }) };
    }
  }
}

export interface StudioStore {
  getSnapshot(): StudioAppState;
  subscribe(listener: () => void): () => void;
  dispatch(intent: StudioIntent): void;
}

export function createStudioStore(initial: StudioAppState): StudioStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      const next = reduceStudio(state, intent);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
