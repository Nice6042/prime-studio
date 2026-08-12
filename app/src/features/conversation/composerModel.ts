import type { HarnessCompatibility, RootSessionSnapshot } from "../../shared/ipc/harness.generated";

export const MAX_DRAFT_CODE_POINTS = 64 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type ComposerState =
  | Readonly<{ kind: "unavailable"; reason: string; draft: string }>
  | Readonly<{ kind: "read_only"; draft: "" }>
  | Readonly<{ kind: "idle"; draft: string; canSend: boolean }>
  | Readonly<{ kind: "working"; draft: string; canQueue: boolean; canSteer: boolean; canAbort: boolean }>
  | Readonly<{ kind: "submitting" | "aborting"; draft: string }>;

export interface AttachmentMetadata {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface SlashCommand {
  readonly id: "model" | "effort" | "compact" | "fork" | "new" | "usage" | "export";
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly unavailableReason?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "model", label: "/model", description: "Choose the model for this chat", enabled: true },
  { id: "effort", label: "/effort", description: "Choose the thinking level", enabled: true },
  { id: "compact", label: "/compact", description: "Compact the active Harness context", enabled: true },
  { id: "fork", label: "/fork", description: "Branch from this conversation", enabled: true },
  { id: "new", label: "/new", description: "Start a new chat", enabled: true },
  { id: "usage", label: "/usage", description: "Open current-chat usage", enabled: true },
  { id: "export", label: "/export", description: "Export this conversation", enabled: true },
];

export function boundDraft(value: string): string {
  return Array.from(value).slice(0, MAX_DRAFT_CODE_POINTS).join("");
}

export function approximateDraftTokens(value: string): number {
  return Math.min(99_999, Math.ceil(Array.from(value).length / 4));
}

export function deriveComposerState(input: {
  readonly compatibility: HarnessCompatibility;
  readonly sessionState: RootSessionSnapshot["state"] | null;
  readonly archived: boolean;
  readonly draft: string;
  readonly phase: "idle" | "submitting" | "aborting";
  readonly admissionConnected: boolean;
}): ComposerState {
  if (input.archived) return { kind: "read_only", draft: "" };
  const draft = boundDraft(input.draft);
  if (!input.admissionConnected) return { kind: "unavailable", reason: "Prompt admission is not connected.", draft };
  if (input.compatibility.status === "unavailable" || input.compatibility.status === "read_only") {
    return { kind: "unavailable", reason: "The verified Harness is unavailable.", draft };
  }
  if (!input.compatibility.capabilities.includes("session_input_admission")) {
    return { kind: "unavailable", reason: "This Harness profile does not admit prompts.", draft };
  }
  if (input.phase === "submitting") return { kind: "submitting", draft };
  if (input.phase === "aborting") return { kind: "aborting", draft };
  if (input.sessionState === "working" || input.sessionState === "blocked") {
    return {
      kind: "working",
      draft,
      canQueue: input.compatibility.capabilities.includes("queue_management"),
      canSteer: true,
      canAbort: input.compatibility.capabilities.includes("prompt_admission_cancellation"),
    };
  }
  return { kind: "idle", draft, canSend: draft.trim().length > 0 };
}

export function keyboardComposerAction(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}): "submit" | "newline" | "ignore" {
  if (event.key !== "Enter") return "ignore";
  if (event.shiftKey || event.isComposing) return "newline";
  return "submit";
}

export function filterSlashCommands(query: string): readonly SlashCommand[] {
  if (!query.startsWith("/")) return [];
  const needle = query.slice(1).trim().toLocaleLowerCase();
  return SLASH_COMMANDS.filter((command) => command.id.startsWith(needle));
}

export function acceptAttachmentMetadata(
  current: readonly AttachmentMetadata[],
  candidates: readonly AttachmentMetadata[],
): { readonly attachments: readonly AttachmentMetadata[]; readonly rejected: number } {
  const accepted = [...current];
  let total = accepted.reduce((sum, attachment) => sum + attachment.size, 0);
  let rejected = 0;
  for (const candidate of candidates) {
    if (
      accepted.length >= MAX_ATTACHMENTS || !candidate.id || candidate.id.length > 1024 ||
      !candidate.name || Array.from(candidate.name).length > 255 ||
      !candidate.mediaType || candidate.mediaType.length > 255 ||
      !Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > MAX_ATTACHMENT_BYTES ||
      total + candidate.size > MAX_TOTAL_ATTACHMENT_BYTES || accepted.some((attachment) => attachment.id === candidate.id)
    ) {
      rejected += 1;
      continue;
    }
    accepted.push(Object.freeze({ ...candidate }));
    total += candidate.size;
  }
  return { attachments: accepted, rejected };
}
