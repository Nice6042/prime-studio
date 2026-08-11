export const PROJECT_CHAT_SCHEMA_VERSION = 2 as const;
export const PERSONAL_PROJECT_ID = "project:personal" as const;

export type ProjectId = string;
export type ChatId = string;

export interface PrimeChatBinding {
  readonly kind: "prime-session";
  readonly accountId: string | null;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly agentId: string | null;
}

export interface ProjectChat {
  readonly id: ChatId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly binding: PrimeChatBinding | null;
}

interface ProjectBase {
  readonly id: ProjectId;
  readonly name: string;
  readonly pinned: boolean;
  readonly selectedChatId: ChatId | null;
  readonly chats: readonly ProjectChat[];
}

export interface PersonalProject extends ProjectBase {
  readonly id: typeof PERSONAL_PROJECT_ID;
  readonly kind: "personal";
  readonly name: "Personal";
  readonly root: Readonly<{ kind: "studio-managed-empty" }>;
  readonly archived: false;
}

export interface FolderProject extends ProjectBase {
  readonly kind: "folder";
  readonly root: Readonly<{ kind: "folder"; path: string }>;
  readonly archived: boolean;
}

export type Project = PersonalProject | FolderProject;

export interface ProjectChatState {
  readonly schemaVersion: typeof PROJECT_CHAT_SCHEMA_VERSION;
  readonly selectedProjectId: ProjectId;
  readonly projects: readonly Project[];
}

export type ProjectChatCommand =
  | Readonly<{
      type: "project.create";
      projectId: ProjectId;
      name: string;
      folderPath: string;
    }>
  | Readonly<{
      type: "chat.create";
      projectId: ProjectId;
      chatId: ChatId;
      title: string;
    }>
  | Readonly<{
      type: "chat.bind-prime-session";
      projectId: ProjectId;
      chatId: ChatId;
      binding: PrimeChatBinding;
    }>
  | Readonly<{
      type: "project.rename";
      projectId: ProjectId;
      name: string;
    }>
  | Readonly<{
      type: "project.archive" | "project.restore";
      projectId: ProjectId;
    }>
  | Readonly<{
      type: "project.set-pinned";
      projectId: ProjectId;
      pinned: boolean;
    }>
  | Readonly<{
      type: "chat.rename";
      projectId: ProjectId;
      chatId: ChatId;
      title: string;
    }>
  | Readonly<{
      type: "chat.archive" | "chat.restore";
      projectId: ProjectId;
      chatId: ChatId;
    }>
  | Readonly<{
      type: "chat.set-pinned";
      projectId: ProjectId;
      chatId: ChatId;
      pinned: boolean;
    }>
  | Readonly<{
      type: "chat.duplicate";
      projectId: ProjectId;
      chatId: ChatId;
      newChatId: ChatId;
      title: string;
    }>
  | Readonly<{
      type: "chat.move";
      projectId: ProjectId;
      chatId: ChatId;
      targetProjectId: ProjectId;
    }>
  | Readonly<{
      type: "chat.delete";
      projectId: ProjectId;
      chatId: ChatId;
    }>
  | Readonly<{
      type: "selection.select-project";
      projectId: ProjectId;
    }>
  | Readonly<{
      type: "selection.select-chat";
      projectId: ProjectId;
      chatId: ChatId;
    }>;

export type ProjectChatRejectionReason =
  | "invalid-command"
  | "invalid-id"
  | "invalid-name"
  | "invalid-folder-path"
  | "invalid-binding"
  | "duplicate-project-id"
  | "duplicate-chat-id"
  | "project-not-found"
  | "project-archived"
  | "chat-not-found"
  | "chat-project-mismatch"
  | "chat-archived"
  | "chat-already-bound"
  | "state-limit-exceeded"
  | "personal-project-immutable";

export type ProjectChatUnchangedReason =
  | "already-selected"
  | "same-name"
  | "already-archived"
  | "already-restored"
  | "already-pinned"
  | "already-unpinned"
  | "same-binding";

export type ProjectChatSelection =
  | Readonly<{
      status: "resolved";
      projectId: ProjectId;
      chatId: ChatId | null;
    }>
  | Readonly<{ status: "unavailable" }>;

export type ProjectChatTransitionResult =
  | Readonly<{
      status: "applied";
      state: ProjectChatState;
      selection: ProjectChatSelection;
    }>
  | Readonly<{
      status: "unchanged";
      state: ProjectChatState;
      reason: ProjectChatUnchangedReason;
      selection: ProjectChatSelection;
    }>
  | Readonly<{
      status: "rejected";
      state: ProjectChatState;
      reason: ProjectChatRejectionReason;
      selection: ProjectChatSelection;
    }>;
