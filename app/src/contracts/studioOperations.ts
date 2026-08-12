/**
 * Closed action boundary for the Prime Studio product surface.
 *
 * Every interactive control binds to one action in this map. The action's
 * authority determines which executor may handle it; an unsupported action is
 * still dispatched and must return an explicit unavailable outcome.
 */

import type { HarnessCapability } from "../shared/ipc/harness.generated";
import type { AttentionEvidence } from "../attention/attentionLedger";

type EmptyPayload = Readonly<Record<string, never>>;
type IdentifierPayload<K extends string> = Readonly<Record<K, string>>;

export interface StudioActionPayloadMap {
  "window.minimize": EmptyPayload;
  "window.maximize-toggle": EmptyPayload;
  "window.close": EmptyPayload;
  "layout.sidebar.toggle": EmptyPayload;
  "layout.sidebar.resize": Readonly<{ width: number }>;
  "layout.sidebar.reset": EmptyPayload;
  "layout.inspector.toggle": EmptyPayload;
  "layout.inspector.resize": Readonly<{ width: number }>;
  "layout.inspector.reset": EmptyPayload;
  "layout.editor.toggle": EmptyPayload;
  "layout.editor.resize": Readonly<{ width: number }>;
  "layout.editor.close": EmptyPayload;
  "overlay.topmost.close": EmptyPayload;
  "surface.popover.toggle": Readonly<{ popoverId: string | null }>;
  "surface.accordion.toggle": Readonly<{ accordionId: string }>;
  "route.workspace.open": EmptyPayload;
  "route.settings.open": Readonly<{ section?: string }>;
  "route.settings.back": EmptyPayload;
  "route.archived.open": EmptyPayload;
  "route.external-docs.open": Readonly<{ document: "prime-agent" | "licenses" | "support" }>;

  "catalog.project.create": Readonly<{ title: string; folderPath?: string }>;
  "catalog.project.restore": IdentifierPayload<"projectId">;
  "catalog.project.toggle": IdentifierPayload<"projectId">;
  "catalog.chat.create": IdentifierPayload<"projectId">;
  "catalog.chat.select": Readonly<{ projectId: string; chatId: string }>;
  "catalog.chat.rename": Readonly<{ chatId: string; title: string }>;
  "catalog.chat.duplicate": IdentifierPayload<"chatId">;
  "catalog.chat.move": Readonly<{ chatId: string; projectId: string }>;
  "catalog.chat.pin-toggle": IdentifierPayload<"chatId">;
  "catalog.chat.archive": IdentifierPayload<"chatId">;
  "catalog.chat.restore": IdentifierPayload<"chatId">;
  "catalog.chat.delete": IdentifierPayload<"chatId">;
  "catalog.chat.unread-clear": IdentifierPayload<"chatId">;
  "workspace.switch": IdentifierPayload<"workspaceId">;
  "workspace.sign-out": IdentifierPayload<"workspaceId">;

  "conversation.user-edit.start": Readonly<{ chatId: string; messageId: string }>;
  "conversation.user-edit.cancel": Readonly<{ chatId: string; messageId: string }>;
  "conversation.user-version.create": Readonly<{ chatId: string; messageId: string; text: string }>;
  "conversation.user-version.select": Readonly<{ chatId: string; messageId: string; version: number }>;
  "conversation.assistant-version.select": Readonly<{ chatId: string; messageId: string; version: number }>;
  "conversation.response.regenerate": Readonly<{ sessionId: string; messageId: string }>;
  "conversation.branch.create": Readonly<{ sessionId: string; messageId: string }>;
  "conversation.response.copy": Readonly<{ messageId: string; text: string }>;
  "conversation.canvas.open": Readonly<{ chatId: string; messageId: string; content: string }>;
  "conversation.files.review": Readonly<{ sessionId: string; activityId: string | null }>;
  "conversation.files.undo": Readonly<{ sessionId: string; patchId: string }>;
  "conversation.work-details.toggle": Readonly<{ turnId: string }>;
  "conversation.suggestion.fill": Readonly<{ chatId: string; text: string }>;
  "conversation.archive-fork": IdentifierPayload<"chatId">;
  "conversation.history.page": Readonly<{ chatId: string; before: string | null }>;

  "composer.draft.change": Readonly<{ chatId: string; text: string }>;
  "composer.attachment.pick": IdentifierPayload<"chatId">;
  "composer.attachment.drop": Readonly<{ chatId: string; files: readonly File[] }>;
  "composer.attachment.remove": Readonly<{ chatId: string; attachmentId: string }>;
  "composer.kernel-variable.insert": Readonly<{ chatId: string; variableId: string }>;
  "composer.model.select": Readonly<{ chatId: string; modelId: string }>;
  "composer.thinking.select": Readonly<{ chatId: string; level: string }>;
  "composer.voice.start": EmptyPayload;
  "composer.voice.stop": EmptyPayload;
  "composer.slash.select": Readonly<{ chatId: string; commandId: string }>;
  "composer.slash.execute": Readonly<{ chatId: string; commandId: string; argument: string }>;
  "harness.session.prompt": Readonly<{ sessionId: string; text: string }>;
  "harness.session.follow-up": Readonly<{ sessionId: string; text: string }>;
  "harness.session.steer": Readonly<{ sessionId: string; text: string }>;
  "harness.session.abort": IdentifierPayload<"sessionId">;
  "harness.session.export": Readonly<{ sessionId: string; format: "html" | "jsonl" }>;

  "harness.tab.select": Readonly<{ chatId: string; tab: "harness" | "usage" | "activity" }>;
  "harness.session.compact": IdentifierPayload<"sessionId">;
  "harness.child.open": Readonly<{ sessionId: string; childId: string }>;
  "harness.child.back": IdentifierPayload<"sessionId">;
  "harness.child.tab-select": Readonly<{ sessionId: string; childId: string; tab: "chat" | "activity" | "files" }>;
  "harness.child.stop": Readonly<{ sessionId: string; childId: string }>;
  "harness.child.transcript-page": Readonly<{ sessionId: string; childId: string; before: string | null }>;
  "harness.queue.run-now": Readonly<{ sessionId: string; queueItemId: string }>;
  "harness.queue.remove": Readonly<{ sessionId: string; queueItemId: string }>;
  "harness.tool.set-enabled": Readonly<{ sessionId: string; toolId: string; enabled: boolean }>;
  "harness.context-source.open": Readonly<{ sessionId: string; sourceId: string }>;
  "harness.overload.retry": Readonly<{ sessionId: string; errorId: string }>;
  "harness.overload.dismiss": Readonly<{ chatId: string; errorId: string }>;
  "harness.extension.respond": Readonly<{ sessionId: string; requestId: string; response: unknown }>;

  "usage.current.refresh": IdentifierPayload<"sessionId">;
  "usage.account.open": EmptyPayload;
  "usage.account.range-select": Readonly<{ rangeDays: 7 | 30 | 90 }>;
  "usage.account.refresh": EmptyPayload;
  "usage.account.export-csv": Readonly<{ rangeDays: 7 | 30 | 90 }>;
  "usage.account.series-toggle": Readonly<{ series: "main" | "subagents" | "tools" }>;
  "activity.filter.select": Readonly<{ chatId: string; filter: "all" | "agents" | "tools" | "files" }>;
  "activity.row.toggle": Readonly<{ chatId: string; activityId: string }>;
  "activity.command.copy": Readonly<{ activityId: string; command: string }>;
  "activity.file.open": Readonly<{ sessionId: string; activityId: string; fileId: string }>;
  "activity.child.open": Readonly<{ sessionId: string; childId: string }>;
  "activity.seen.mark": Readonly<{ chatId: string; evidence: AttentionEvidence }>;

  "editor.artifact.open": Readonly<{ sessionId: string; artifactId: string }>;
  "editor.mode.select": Readonly<{ documentId: string; mode: "diff" | "edit" }>;
  "editor.content.change": Readonly<{ documentId: string; content: string }>;
  "editor.file.save": Readonly<{ documentId: string; expectedRevision: string; content: string }>;
  "editor.canvas.apply": Readonly<{ chatId: string; messageId: string; expectedRevision: number; content: string }>;
  "editor.conflict.reload": IdentifierPayload<"documentId">;
  "editor.conflict.save-copy": Readonly<{ documentId: string; content: string }>;

  "settings.search.change": Readonly<{ query: string }>;
  "settings.section.select": IdentifierPayload<"sectionId">;
  "settings.preference.set": Readonly<{ key: string; value: boolean | number | string }>;
  "settings.preference.reset": IdentifierPayload<"key">;
  "settings.harness-policy.set": Readonly<{ key: string; value: boolean | number | string }>;
  "settings.model-default.set": Readonly<{ accountId: string; modelId: string; thinking: string }>;
  "settings.tool.set-enabled": Readonly<{ toolId: string; enabled: boolean }>;
  "settings.updates.check": EmptyPayload;
  "account.add": EmptyPayload;
  "account.use": IdentifierPayload<"accountId">;
  "account.set-default": Readonly<{ accountId: string | null }>;
  "account.remove": IdentifierPayload<"accountId">;
  "account.sign-out": IdentifierPayload<"accountId">;

  "palette.open": EmptyPayload;
  "palette.close": EmptyPayload;
  "palette.query.change": Readonly<{ query: string }>;
  "palette.result.execute": Readonly<{ resultId: string }>;
  "clipboard.cut": EmptyPayload;
  "clipboard.copy-selection": EmptyPayload;
  "clipboard.paste": EmptyPayload;
  "history.undo": EmptyPayload;
  "history.redo": EmptyPayload;
  "toast.dismiss": IdentifierPayload<"toastId">;
}

export type StudioActionId = keyof StudioActionPayloadMap;

export type StudioOperation = {
  [K in StudioActionId]: Readonly<{
    operationId?: string;
    action: K;
    payload: StudioActionPayloadMap[K];
  }>
}[StudioActionId];

export type StudioOperationOutcome =
  | Readonly<{ status: "accepted"; commandId: string }>
  | Readonly<{ status: "queued"; commandId: string; position: number | null }>
  | Readonly<{ status: "updated"; revision: string | number }>
  | Readonly<{ status: "cancelled"; commandId: string | null }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "rejected"; reason: string; retryable: boolean }>
  | Readonly<{ status: "unknown_outcome"; operationId: string; reason: string }>;

export type StudioActionAuthority =
  | Readonly<{ kind: "harness"; capability: HarnessCapability | "core_session" }>
  | Readonly<{ kind: "studio_durable"; store: "project_catalog" | "chat_display" | "settings" | "account_ledger" | "usage_ledger" }>
  | Readonly<{ kind: "renderer"; persistence: "none" | "layout_preferences" | "drafts" }>
  | Readonly<{ kind: "native"; boundary: "window" | "clipboard" | "dialog" | "external_url" | "file_write" }>
  | Readonly<{ kind: "unsupported"; reason: string }>;

export interface StudioActionDescriptor {
  readonly owner: StudioActionAuthority;
  readonly outcomes: readonly StudioOperationOutcome["status"][];
}

const H = (capability: HarnessCapability | "core_session"): StudioActionDescriptor => ({ owner: { kind: "harness", capability }, outcomes: ["accepted", "queued", "updated", "cancelled", "unavailable", "rejected", "unknown_outcome"] });
const D = (store: Extract<StudioActionAuthority, { kind: "studio_durable" }>["store"]): StudioActionDescriptor => ({ owner: { kind: "studio_durable", store }, outcomes: ["updated", "unavailable", "rejected"] });
const R = (persistence: Extract<StudioActionAuthority, { kind: "renderer" }>["persistence"] = "none"): StudioActionDescriptor => ({ owner: { kind: "renderer", persistence }, outcomes: ["updated", "unavailable", "rejected"] });
const N = (boundary: Extract<StudioActionAuthority, { kind: "native" }>["boundary"]): StudioActionDescriptor => ({ owner: { kind: "native", boundary }, outcomes: ["updated", "cancelled", "unavailable", "rejected"] });
const U = (reason: string): StudioActionDescriptor => ({ owner: { kind: "unsupported", reason }, outcomes: ["unavailable"] });

export const STUDIO_ACTIONS = Object.freeze({
  "window.minimize": N("window"), "window.maximize-toggle": N("window"), "window.close": N("window"),
  "layout.sidebar.toggle": R("layout_preferences"), "layout.sidebar.resize": R("layout_preferences"), "layout.sidebar.reset": R("layout_preferences"),
  "layout.inspector.toggle": R("layout_preferences"), "layout.inspector.resize": R("layout_preferences"), "layout.inspector.reset": R("layout_preferences"),
  "layout.editor.toggle": R("layout_preferences"), "layout.editor.resize": R("layout_preferences"), "layout.editor.close": R("layout_preferences"), "overlay.topmost.close": R(),
  "surface.popover.toggle": R(), "surface.accordion.toggle": R(),
  "route.workspace.open": R(), "route.settings.open": R(), "route.settings.back": R(), "route.archived.open": R(), "route.external-docs.open": N("external_url"),
  "catalog.project.create": D("project_catalog"), "catalog.project.restore": D("project_catalog"), "catalog.project.toggle": R("layout_preferences"), "catalog.chat.create": D("project_catalog"), "catalog.chat.select": R(),
  "catalog.chat.rename": D("project_catalog"), "catalog.chat.duplicate": D("project_catalog"), "catalog.chat.move": D("project_catalog"), "catalog.chat.pin-toggle": D("project_catalog"),
  "catalog.chat.archive": D("project_catalog"), "catalog.chat.restore": D("project_catalog"), "catalog.chat.delete": D("project_catalog"), "catalog.chat.unread-clear": D("project_catalog"),
  "workspace.switch": D("settings"), "workspace.sign-out": D("settings"),
  "conversation.user-edit.start": R(), "conversation.user-edit.cancel": R(), "conversation.user-version.create": H("resident_sessions"), "conversation.user-version.select": D("chat_display"),
  "conversation.assistant-version.select": D("chat_display"), "conversation.response.regenerate": H("session_input_admission"), "conversation.branch.create": H("resident_sessions"),
  "conversation.response.copy": N("clipboard"), "conversation.canvas.open": R(), "conversation.files.review": H("resource_snapshot"),
  "conversation.files.undo": U("Prime Harness exposes no verified reversible patch capability."), "conversation.work-details.toggle": R(), "conversation.suggestion.fill": R("drafts"),
  "conversation.archive-fork": H("resident_sessions"), "conversation.history.page": H("attach_snapshot"),
  "composer.draft.change": R("drafts"), "composer.attachment.pick": N("dialog"), "composer.attachment.drop": N("dialog"), "composer.attachment.remove": R("drafts"),
  "composer.kernel-variable.insert": U("No reviewed kernel-variable insertion capability is available."), "composer.model.select": H("model_catalog"), "composer.thinking.select": H("model_catalog"),
  "composer.voice.start": U("Voice capture has no implemented privacy and native-audio contract."), "composer.voice.stop": U("Voice capture has no implemented privacy and native-audio contract."),
  "composer.slash.select": R("drafts"), "composer.slash.execute": H("core_session"), "harness.session.prompt": H("session_input_admission"),
  "harness.session.follow-up": H("queue_management"), "harness.session.steer": H("session_input_admission"), "harness.session.abort": H("prompt_admission_cancellation"),
  "harness.session.export": N("file_write"),
  "harness.tab.select": R(), "harness.session.compact": H("core_session"), "harness.child.open": R(), "harness.child.back": R(), "harness.child.tab-select": R(),
  "harness.child.stop": H("delete_child"), "harness.child.transcript-page": H("attach_snapshot"), "harness.queue.run-now": H("queue_management"),
  "harness.queue.remove": H("queue_management"), "harness.tool.set-enabled": H("core_session"), "harness.context-source.open": H("resource_snapshot"),
  "harness.overload.retry": H("prompt_admission_cancellation"), "harness.overload.dismiss": D("chat_display"), "harness.extension.respond": H("extension_ui"),
  "usage.current.refresh": H("attach_snapshot"), "usage.account.open": R(), "usage.account.range-select": R(), "usage.account.refresh": D("usage_ledger"),
  "usage.account.export-csv": N("file_write"), "usage.account.series-toggle": R(), "activity.filter.select": R(), "activity.row.toggle": R(),
  "activity.command.copy": N("clipboard"), "activity.file.open": H("resource_snapshot"), "activity.child.open": R(), "activity.seen.mark": D("chat_display"),
  "editor.artifact.open": H("resource_snapshot"), "editor.mode.select": R(), "editor.content.change": R(), "editor.file.save": N("file_write"),
  "editor.canvas.apply": D("chat_display"), "editor.conflict.reload": N("file_write"), "editor.conflict.save-copy": N("file_write"),
  "settings.search.change": R(), "settings.section.select": R(), "settings.preference.set": D("settings"), "settings.preference.reset": D("settings"),
  "settings.harness-policy.set": H("core_session"), "settings.model-default.set": D("settings"), "settings.tool.set-enabled": H("core_session"), "settings.updates.check": U("No signed update channel is configured."),
  "account.add": D("settings"), "account.use": D("settings"), "account.set-default": D("settings"), "account.remove": D("settings"), "account.sign-out": D("settings"),
  "palette.open": R(), "palette.close": R(), "palette.query.change": R(), "palette.result.execute": R(),
  "clipboard.cut": N("clipboard"), "clipboard.copy-selection": N("clipboard"), "clipboard.paste": N("clipboard"), "history.undo": N("clipboard"), "history.redo": N("clipboard"),
  "toast.dismiss": R(),
} satisfies Readonly<Record<StudioActionId, StudioActionDescriptor>>);

export interface InteractiveControlBinding {
  readonly controlId: string;
  readonly action: StudioActionId;
  readonly disabledReason: string | null;
}

export function createControlBinding(controlId: string, action: StudioActionId, disabledReason: string | null = null): InteractiveControlBinding {
  if (!controlId.trim()) throw new Error("Interactive control requires a stable control ID.");
  if (!(action in STUDIO_ACTIONS)) throw new Error(`Interactive control ${controlId} must map to a known Studio action.`);
  if (STUDIO_ACTIONS[action].owner.kind === "unsupported" && !disabledReason?.trim()) {
    throw new Error(`Interactive control ${controlId} requires a disabled reason for unsupported action ${action}.`);
  }
  return Object.freeze({ controlId, action, disabledReason });
}

export function validateControlBindings(bindings: readonly InteractiveControlBinding[]): Readonly<{ valid: true; count: number }> {
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (!binding.controlId.trim() || !(binding.action in STUDIO_ACTIONS)) {
      throw new Error(`Interactive control ${binding.controlId || "<missing>"} must map to a known Studio action.`);
    }
    if (ids.has(binding.controlId)) throw new Error(`Duplicate interactive control ID: ${binding.controlId}.`);
    ids.add(binding.controlId);
    const descriptor = STUDIO_ACTIONS[binding.action];
    if ((descriptor.owner.kind === "unsupported" || binding.disabledReason !== null) && !binding.disabledReason?.trim()) {
      throw new Error(`Interactive control ${binding.controlId} requires a disabled reason.`);
    }
  }
  return Object.freeze({ valid: true, count: bindings.length });
}

export interface StudioOperationExecutors {
  harness(operation: StudioOperation): Promise<StudioOperationOutcome>;
  studioDurable(operation: StudioOperation): Promise<StudioOperationOutcome>;
  renderer(operation: StudioOperation): Promise<StudioOperationOutcome>;
  native(operation: StudioOperation): Promise<StudioOperationOutcome>;
  unsupported(operation: StudioOperation): Promise<StudioOperationOutcome>;
}

export async function dispatchStudioOperation(operation: StudioOperation, executors: StudioOperationExecutors): Promise<StudioOperationOutcome> {
  const descriptor = STUDIO_ACTIONS[operation.action];
  const executor = descriptor.owner.kind === "studio_durable"
    ? executors.studioDurable
    : descriptor.owner.kind === "unsupported"
      ? executors.unsupported
      : executors[descriptor.owner.kind];
  const outcome = await executor(operation);
  if (outcome === undefined || outcome === null) {
    throw new Error(`Executor for ${operation.action} returned no outcome; interactive no-ops are forbidden.`);
  }
  if (!descriptor.outcomes.includes(outcome.status)) {
    throw new Error(`Executor for ${operation.action} returned disallowed outcome ${outcome.status}.`);
  }
  return outcome;
}
