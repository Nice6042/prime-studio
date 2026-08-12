import {
  PERSONAL_PROJECT_ID,
  PROJECT_CHAT_SCHEMA_VERSION,
  type FolderProject,
  type Project,
  type ProjectChat,
  type PrimeChatBinding,
  type ProjectChatCommand,
  type ProjectChatSelection,
  type ProjectChatState,
  type ProjectChatTransitionResult,
  type ProjectChatRejectionReason,
  type ProjectChatUnchangedReason,
} from "./contract";
import { snapshotUntrusted } from "./strictSnapshot";
import { serializeProjectChatState } from "./serialization";
import {
  isPrimeSessionFile,
  isProjectChatId,
  isProjectChatLabel,
} from "./validation";

export function createInitialProjectChatState(): ProjectChatState {
  return {
    schemaVersion: PROJECT_CHAT_SCHEMA_VERSION,
    selectedProjectId: PERSONAL_PROJECT_ID,
    projects: [
      {
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        name: "Personal",
        root: { kind: "studio-managed-empty" },
        pinned: false,
        archived: false,
        selectedChatId: null,
        chats: [],
      },
    ],
  };
}

function validFolderPath(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0");
}

function decodePrimeChatBinding(value: unknown): PrimeChatBinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const binding = value as Record<string, unknown>;
  if (
    !hasExactCommandKeys(binding, ["kind", "accountId", "sessionId", "sessionFile", "agentId"]) ||
    binding.kind !== "prime-session" ||
    (binding.accountId !== null && !isProjectChatId(binding.accountId)) ||
    !isProjectChatId(binding.sessionId) ||
    !isPrimeSessionFile(binding.sessionFile) ||
    (binding.agentId !== null && !isProjectChatId(binding.agentId))
  ) {
    return undefined;
  }
  return {
    kind: "prime-session",
    accountId: binding.accountId,
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
    agentId: binding.agentId,
  } as PrimeChatBinding;
}

function primeBindingEqual(left: PrimeChatBinding, right: PrimeChatBinding): boolean {
  return left.kind === right.kind &&
    left.accountId === right.accountId &&
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.agentId === right.agentId;
}

function hasExactCommandKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every(
      (key): key is string => typeof key === "string" && keys.includes(key),
    )
  );
}

function decodeProjectChatCommand(value: unknown): ProjectChatCommand | undefined {
  try {
    const snapshot = snapshotUntrusted(value);
    if (snapshot.status === "rejected") return undefined;
    if (
      typeof snapshot.value !== "object" ||
      snapshot.value === null ||
      Array.isArray(snapshot.value)
    ) {
      return undefined;
    }
    const command = snapshot.value as Record<string, unknown>;
    if (typeof command.type !== "string") return undefined;

    switch (command.type) {
      case "project.create":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "name", "folderPath"]) &&
          typeof command.projectId === "string" &&
          typeof command.name === "string" &&
          typeof command.folderPath === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            name: command.name,
            folderPath: command.folderPath,
          };
        }
        return undefined;

      case "chat.create":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId", "title"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string" &&
          typeof command.title === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
            title: command.title,
          };
        }
        return undefined;

      case "chat.bind-prime-session": {
        if (
          !hasExactCommandKeys(command, ["type", "projectId", "chatId", "binding"]) ||
          typeof command.projectId !== "string" ||
          typeof command.chatId !== "string"
        ) {
          return undefined;
        }
        const binding = decodePrimeChatBinding(command.binding);
        return binding
          ? { type: command.type, projectId: command.projectId, chatId: command.chatId, binding }
          : undefined;
      }

      case "project.rename":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "name"]) &&
          typeof command.projectId === "string" &&
          typeof command.name === "string"
        ) {
          return { type: command.type, projectId: command.projectId, name: command.name };
        }
        return undefined;

      case "project.archive":
      case "project.restore":
      case "selection.select-project":
        if (
          hasExactCommandKeys(command, ["type", "projectId"]) &&
          typeof command.projectId === "string"
        ) {
          return { type: command.type, projectId: command.projectId };
        }
        return undefined;

      case "project.set-pinned":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "pinned"]) &&
          typeof command.projectId === "string" &&
          typeof command.pinned === "boolean"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            pinned: command.pinned,
          };
        }
        return undefined;

      case "chat.rename":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId", "title"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string" &&
          typeof command.title === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
            title: command.title,
          };
        }
        return undefined;

      case "chat.archive":
      case "chat.restore":
      case "selection.select-chat":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
          };
        }
        return undefined;

      case "chat.set-pinned":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId", "pinned"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string" &&
          typeof command.pinned === "boolean"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
            pinned: command.pinned,
          };
        }
        return undefined;

      case "chat.duplicate":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId", "newChatId", "title"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string" &&
          typeof command.newChatId === "string" &&
          typeof command.title === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
            newChatId: command.newChatId,
            title: command.title,
          };
        }
        return undefined;

      case "chat.move":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId", "targetProjectId"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string" &&
          typeof command.targetProjectId === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
            targetProjectId: command.targetProjectId,
          };
        }
        return undefined;

      case "chat.delete":
        if (
          hasExactCommandKeys(command, ["type", "projectId", "chatId"]) &&
          typeof command.projectId === "string" &&
          typeof command.chatId === "string"
        ) {
          return {
            type: command.type,
            projectId: command.projectId,
            chatId: command.chatId,
          };
        }
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function projectById(state: ProjectChatState, projectId: string): Project | undefined {
  return state.projects.find((project) => project.id === projectId);
}

function chatOwner(state: ProjectChatState, chatId: string): Project | undefined {
  return state.projects.find((project) =>
    project.chats.some((chat) => chat.id === chatId),
  );
}

export function resolveProjectChatSelection(
  state: ProjectChatState,
): ProjectChatSelection {
  const selected = projectById(state, state.selectedProjectId);
  const project =
    selected && !selected.archived
      ? selected
      : projectById(state, PERSONAL_PROJECT_ID) ??
        state.projects.find((candidate) => !candidate.archived);

  if (!project || project.archived) return { status: "unavailable" };

  const remembered = project.chats.find(
    (chat) => chat.id === project.selectedChatId && !chat.archived,
  );
  const chat = remembered ?? project.chats.find((candidate) => !candidate.archived);
  return {
    status: "resolved",
    projectId: project.id,
    chatId: chat?.id ?? null,
  };
}

function applied(
  previousState: ProjectChatState,
  candidateState: ProjectChatState,
): ProjectChatTransitionResult {
  if (serializeProjectChatState(candidateState).status === "rejected") {
    return rejected(previousState, "state-limit-exceeded");
  }
  return {
    status: "applied",
    state: candidateState,
    selection: resolveProjectChatSelection(candidateState),
  };
}

function unchanged(
  state: ProjectChatState,
  reason: ProjectChatUnchangedReason,
): ProjectChatTransitionResult {
  return {
    status: "unchanged",
    state,
    reason,
    selection: resolveProjectChatSelection(state),
  };
}

function chatInProject(
  state: ProjectChatState,
  projectId: string,
  chatId: string,
):
  | Readonly<{ status: "found"; project: Project; chat: ProjectChat }>
  | Readonly<{ status: "rejected"; reason: ProjectChatRejectionReason }> {
  const project = projectById(state, projectId);
  if (!project) return { status: "rejected", reason: "project-not-found" };
  const chat = project.chats.find((candidate) => candidate.id === chatId);
  if (chat) return { status: "found", project, chat };
  return {
    status: "rejected",
    reason: chatOwner(state, chatId) ? "chat-project-mismatch" : "chat-not-found",
  };
}

function replacementChatAfterArchive(
  project: Project,
  archivedChatId: string,
): string | null {
  if (project.selectedChatId !== archivedChatId) return project.selectedChatId;
  const archivedIndex = project.chats.findIndex((chat) => chat.id === archivedChatId);
  const after = project.chats
    .slice(archivedIndex + 1)
    .find((chat) => !chat.archived && chat.id !== archivedChatId);
  if (after) return after.id;
  const before = project.chats
    .slice(0, archivedIndex)
    .reverse()
    .find((chat) => !chat.archived && chat.id !== archivedChatId);
  return before?.id ?? null;
}

function rejected(
  state: ProjectChatState,
  reason: ProjectChatRejectionReason,
): ProjectChatTransitionResult {
  return {
    status: "rejected",
    state,
    reason,
    selection: resolveProjectChatSelection(state),
  };
}

function replaceProject(
  state: ProjectChatState,
  replacement: Project,
  selectedProjectId = state.selectedProjectId,
): ProjectChatState {
  return {
    ...state,
    selectedProjectId,
    projects: state.projects.map((project) =>
      project.id === replacement.id ? replacement : project,
    ),
  };
}

export function transitionProjectChatState(
  state: ProjectChatState,
  commandInput: unknown,
): ProjectChatTransitionResult {
  const command = decodeProjectChatCommand(commandInput);
  if (!command) return rejected(state, "invalid-command");
  if (!isProjectChatId(command.projectId)) return rejected(state, "invalid-id");
  if ("chatId" in command && !isProjectChatId(command.chatId)) {
    return rejected(state, "invalid-id");
  }
  if ("newChatId" in command && !isProjectChatId(command.newChatId)) {
    return rejected(state, "invalid-id");
  }
  if ("targetProjectId" in command && !isProjectChatId(command.targetProjectId)) {
    return rejected(state, "invalid-id");
  }

  switch (command.type) {
    case "project.create": {
      if (!isProjectChatLabel(command.name)) return rejected(state, "invalid-name");
      if (!validFolderPath(command.folderPath)) {
        return rejected(state, "invalid-folder-path");
      }
      if (projectById(state, command.projectId)) {
        return rejected(state, "duplicate-project-id");
      }
      const project: FolderProject = {
        id: command.projectId,
        kind: "folder",
        name: command.name,
        root: { kind: "folder", path: command.folderPath },
        pinned: false,
        archived: false,
        selectedChatId: null,
        chats: [],
      };
      return applied(state, {
        ...state,
        selectedProjectId: project.id,
        projects: [...state.projects, project],
      });
    }

    case "project.rename": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.kind === "personal") {
        return rejected(state, "personal-project-immutable");
      }
      if (!isProjectChatLabel(command.name)) return rejected(state, "invalid-name");
      if (project.name === command.name) return unchanged(state, "same-name");
      return applied(
        state,
        replaceProject(state, { ...project, name: command.name }),
      );
    }

    case "project.archive": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.kind === "personal") {
        return rejected(state, "personal-project-immutable");
      }
      if (project.archived) return unchanged(state, "already-archived");
      const selectedProjectId =
        state.selectedProjectId === project.id
          ? PERSONAL_PROJECT_ID
          : state.selectedProjectId;
      return applied(
        state,
        replaceProject(state, { ...project, archived: true }, selectedProjectId),
      );
    }

    case "project.restore": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.kind === "personal" || !project.archived) {
        return unchanged(state, "already-restored");
      }
      return applied(
        state,
        replaceProject(state, { ...project, archived: false }),
      );
    }

    case "project.set-pinned": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.pinned === command.pinned) {
        return unchanged(
          state,
          command.pinned ? "already-pinned" : "already-unpinned",
        );
      }
      return applied(
        state,
        replaceProject(state, { ...project, pinned: command.pinned }),
      );
    }

    case "chat.create": {
      if (!isProjectChatLabel(command.title)) return rejected(state, "invalid-name");
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.archived) return rejected(state, "project-archived");
      if (chatOwner(state, command.chatId)) return rejected(state, "duplicate-chat-id");
      const chat: ProjectChat = {
        id: command.chatId,
        projectId: project.id,
        title: command.title,
        pinned: false,
        archived: false,
        binding: null,
      };
      return applied(
        state,
        replaceProject(
          state,
          {
            ...project,
            selectedChatId: chat.id,
            chats: [...project.chats, chat],
          },
          project.id,
        ),
      );
    }

    case "chat.bind-prime-session": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (found.chat.binding) {
        return primeBindingEqual(found.chat.binding, command.binding)
          ? unchanged(state, "same-binding")
          : rejected(state, "chat-already-bound");
      }
      if (state.projects.some((project) => project.chats.some((chat) =>
        chat.id !== found.chat.id && chat.binding?.sessionId === command.binding.sessionId
      ))) return rejected(state, "session-already-bound");
      return applied(
        state,
        replaceProject(state, {
          ...found.project,
          chats: found.project.chats.map((chat) =>
            chat.id === found.chat.id ? { ...chat, binding: command.binding } : chat,
          ),
        }),
      );
    }

    case "chat.rename": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (!isProjectChatLabel(command.title)) return rejected(state, "invalid-name");
      if (found.chat.title === command.title) return unchanged(state, "same-name");
      return applied(
        state,
        replaceProject(state, {
          ...found.project,
          chats: found.project.chats.map((chat) =>
            chat.id === found.chat.id ? { ...chat, title: command.title } : chat,
          ),
        }),
      );
    }

    case "chat.archive": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (found.chat.archived) return unchanged(state, "already-archived");
      const selectedChatId = replacementChatAfterArchive(
        found.project,
        found.chat.id,
      );
      return applied(
        state,
        replaceProject(state, {
          ...found.project,
          selectedChatId,
          chats: found.project.chats.map((chat) =>
            chat.id === found.chat.id ? { ...chat, archived: true } : chat,
          ),
        }),
      );
    }

    case "chat.restore": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (!found.chat.archived) return unchanged(state, "already-restored");
      const hasActiveRememberedChat = found.project.chats.some(
        (chat) => chat.id === found.project.selectedChatId && !chat.archived,
      );
      return applied(
        state,
        replaceProject(state, {
          ...found.project,
          selectedChatId: hasActiveRememberedChat
            ? found.project.selectedChatId
            : found.chat.id,
          chats: found.project.chats.map((chat) =>
            chat.id === found.chat.id ? { ...chat, archived: false } : chat,
          ),
        }),
      );
    }

    case "chat.set-pinned": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (found.chat.pinned === command.pinned) {
        return unchanged(
          state,
          command.pinned ? "already-pinned" : "already-unpinned",
        );
      }
      return applied(
        state,
        replaceProject(state, {
          ...found.project,
          chats: found.project.chats.map((chat) =>
            chat.id === found.chat.id ? { ...chat, pinned: command.pinned } : chat,
          ),
        }),
      );
    }

    case "chat.duplicate": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (!isProjectChatLabel(command.title)) return rejected(state, "invalid-name");
      if (chatOwner(state, command.newChatId)) return rejected(state, "duplicate-chat-id");
      const duplicate: ProjectChat = {
        id: command.newChatId,
        projectId: found.project.id,
        title: command.title,
        pinned: false,
        archived: false,
        binding: null,
      };
      return applied(state, replaceProject(state, {
        ...found.project,
        selectedChatId: duplicate.id,
        chats: [...found.project.chats, duplicate],
      }, found.project.id));
    }

    case "chat.move": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      if (found.project.id === command.targetProjectId) return unchanged(state, "already-selected");
      const target = projectById(state, command.targetProjectId);
      if (!target) return rejected(state, "project-not-found");
      if (target.archived) return rejected(state, "project-archived");
      const moved = { ...found.chat, projectId: target.id };
      const source = {
        ...found.project,
        selectedChatId: replacementChatAfterArchive(found.project, found.chat.id),
        chats: found.project.chats.filter((chat) => chat.id !== found.chat.id),
      };
      const destination = { ...target, selectedChatId: moved.id, chats: [...target.chats, moved] };
      return applied(state, {
        ...state,
        selectedProjectId: target.id,
        projects: state.projects.map((project) => project.id === source.id ? source : project.id === destination.id ? destination : project),
      });
    }

    case "chat.delete": {
      const found = chatInProject(state, command.projectId, command.chatId);
      if (found.status === "rejected") return rejected(state, found.reason);
      return applied(state, replaceProject(state, {
        ...found.project,
        selectedChatId: replacementChatAfterArchive(found.project, found.chat.id),
        chats: found.project.chats.filter((chat) => chat.id !== found.chat.id),
      }));
    }

    case "selection.select-project": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.archived) return rejected(state, "project-archived");
      if (state.selectedProjectId === project.id) {
        return unchanged(state, "already-selected");
      }
      return applied(state, { ...state, selectedProjectId: project.id });
    }

    case "selection.select-chat": {
      const project = projectById(state, command.projectId);
      if (!project) return rejected(state, "project-not-found");
      if (project.archived) return rejected(state, "project-archived");
      const chat = project.chats.find((candidate) => candidate.id === command.chatId);
      if (!chat) {
        return rejected(
          state,
          chatOwner(state, command.chatId) ? "chat-project-mismatch" : "chat-not-found",
        );
      }
      if (chat.archived) return rejected(state, "chat-archived");
      if (
        state.selectedProjectId === project.id &&
        project.selectedChatId === chat.id
      ) {
        return unchanged(state, "already-selected");
      }
      return applied(
        state,
        replaceProject(
          state,
          { ...project, selectedChatId: chat.id },
          project.id,
        ),
      );
    }
  }

  return rejected(state, "invalid-command");
}
