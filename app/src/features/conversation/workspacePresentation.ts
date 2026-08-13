export type WorkspaceOperationState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "pending"; label: string }>
  | Readonly<{ phase: "success"; message: string }>
  | Readonly<{ phase: "error"; message: string }>
  | Readonly<{ phase: "disabled"; reason: string }>;

export interface WorkspaceChatSummary { readonly id: string; readonly title: string }
export interface ActiveWorkspaceChat extends WorkspaceChatSummary { readonly pinned: boolean }
export type ComposerModelId = "luna" | "sol" | "terra" | string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ComposerRuntimeChoice<T extends string = string> {
  readonly id: T;
  readonly label: string;
  readonly shortLabel?: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}
export interface ConversationVersion { readonly text: string }
export interface EditedFileSummary { readonly path: string; readonly additions: number; readonly deletions: number }
export interface ConversationTurnPresentation {
  readonly userVersions?: readonly ConversationVersion[];
  readonly selectedUserVersion?: number;
  readonly assistantVersions?: readonly ConversationVersion[];
  readonly selectedAssistantVersion?: number;
  readonly workedFor?: string;
  readonly workSteps?: readonly string[];
  readonly editedFiles?: readonly EditedFileSummary[];
}
