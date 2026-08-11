import type { HarnessCompatibility } from "../ipc/harness.generated";
import type { RootSessionProjection } from "../../entities/harness/types";
import { normalizeChats, type ChatEntities, type StudioChat } from "../../entities/chats/chatStore";
import { initialNavigationState, type NavigationState } from "../../entities/navigation/navigationStore";
import { normalizeSessions, type SessionEntities } from "../../entities/sessions/sessionStore";

export interface AsyncState {
  readonly generation: number;
  readonly status: "loading" | "resolved";
  readonly value?: unknown;
}

export interface StudioAppState {
  readonly compatibility: HarnessCompatibility;
  readonly chats: ChatEntities;
  readonly sessions: SessionEntities;
  readonly navigation: NavigationState;
  readonly defaultAccountId: string | null;
  readonly async: Readonly<Record<string, AsyncState>>;
}

export type StudioIntent =
  | Readonly<{ type: "chat/open"; chatId: string }>
  | Readonly<{ type: "chat/create"; chat: StudioChat }>
  | Readonly<{ type: "account/default-selected"; accountId: string | null }>
  | Readonly<{ type: "route/settings"; section?: string }>
  | Readonly<{ type: "route/workspace" }>
  | Readonly<{ type: "async/started"; key: string; generation: number }>
  | Readonly<{ type: "async/resolved"; key: string; generation: number; value: unknown }>;

export function initialStudioState(input: {
  chats?: readonly StudioChat[];
  sessions?: readonly RootSessionProjection[];
  compatibility?: HarnessCompatibility;
} = {}): StudioAppState {
  return {
    compatibility: input.compatibility ?? { status: "unavailable", reason: "security_verification_failed" },
    chats: normalizeChats(input.chats ?? []),
    sessions: normalizeSessions(input.sessions ?? []),
    navigation: initialNavigationState,
    defaultAccountId: null,
    async: Object.freeze({}),
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
    case "account/default-selected":
      return state.defaultAccountId === intent.accountId ? state : { ...state, defaultAccountId: intent.accountId };
    case "route/settings":
      return { ...state, navigation: { route: "settings", settingsSection: intent.section ?? null, selectedChatId: null } };
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
