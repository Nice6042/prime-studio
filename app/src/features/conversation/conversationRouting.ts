import type { StudioOperation } from "../../contracts/studioOperations";
import type { SlashCommand } from "./composerModel";

export type SlashRoute =
  | Readonly<{ kind: "model-picker" | "effort-picker" | "new-chat" | "usage" }>
  | Readonly<{ kind: "operation"; operation: StudioOperation }>;

export function routeSlashCommand(command: SlashCommand["id"], context: {
  readonly chatId: string;
  readonly sessionId: string | null;
  readonly messageId: string | null;
}): SlashRoute | null {
  if (command === "model") return { kind: "model-picker" };
  if (command === "effort") return { kind: "effort-picker" };
  if (command === "new") return { kind: "new-chat" };
  if (command === "usage") return { kind: "usage" };
  if (!context.sessionId) return null;
  if (command === "compact") return { kind: "operation", operation: { action: "harness.session.compact", payload: { sessionId: context.sessionId } } };
  if (command === "export") return { kind: "operation", operation: { action: "harness.session.export", payload: { sessionId: context.sessionId, format: "html" } } };
  if (command === "fork" && context.messageId) return { kind: "operation", operation: { action: "conversation.branch.create", payload: { sessionId: context.sessionId, messageId: context.messageId } } };
  return null;
}
