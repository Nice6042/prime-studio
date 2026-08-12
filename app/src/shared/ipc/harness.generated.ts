// Generated from harness-v1.schema.json; SHA-256: fac30bce3715b0c80eef0ce1f60ae8168bbed3a9076657f6b9f479043daee623
// Do not edit by hand. Run npm run generate:harness-contract.

export const STUDIO_HARNESS_PROTOCOL = 1 as const;
export const HARNESS_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const HARNESS_TRANSCRIPT_PAGE_MAX_ROWS = 300;

export type HarnessCapability =
  | "attach_snapshot"
  | "event_sequence"
  | "resident_sessions"
  | "session_input_admission"
  | "model_catalog"
  | "extension_ui"
  | "chunked_snapshot"
  | "prompt_admission_cancellation"
  | "queue_management"
  | "resource_snapshot"
  | "delete_child"
  | "heartbeat_catalog"
  | "heartbeat_management"
  | "side_question_transcript"
  | "transient_bash";

export type HarnessUnavailableReason =
  | "not_installed"
  | "runtime_identity_mismatch"
  | "unsupported_protocol"
  | "unsupported_schema"
  | "missing_mandatory_capability"
  | "transport_unavailable"
  | "security_verification_failed";

export interface RuntimeIdentity {
  packageName: "prime-agent";
  packageVersion: string;
  packageDigest: string;
  entrypointDigest: string;
  protocolName: string;
  protocolVersion: number;
  schemaRevision: number;
  schemaId: string;
  capabilities: readonly HarnessCapability[];
}

export interface UnavailableFeature {
  capability: HarnessCapability;
  reason: HarnessUnavailableReason;
}

export type HarnessCompatibility =
  | { status: "ready"; profile: string; capabilities: readonly HarnessCapability[] }
  | { status: "degraded"; profile: string; capabilities: readonly HarnessCapability[]; unavailable: readonly UnavailableFeature[] }
  | { status: "read_only"; reason: HarnessUnavailableReason; runtime: RuntimeIdentity | null }
  | { status: "unavailable"; reason: HarnessUnavailableReason };

export interface HarnessCursor {
  runtimeGeneration: string;
  sequence: number;
}

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; redacted: boolean }
  | { kind: "tool_call"; toolCallId: string; toolId: string; status: "pending" | "running" | "blocked" | "succeeded" | "failed" };

export type ParentMessage =
  | { channel: "parent"; kind: "user"; id: string; text: string; emittedAtMs: number }
  | { channel: "parent"; kind: "assistant"; id: string; blocks: readonly MessageBlock[]; streaming: boolean; emittedAtMs: number }
  | { channel: "parent"; kind: "notice"; id: string; text: string; emittedAtMs: number };

export interface ChildAgentSummary {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "unknown";
  task: string;
  provider: string | null;
  model: string | null;
  progress: number | null;
}

export interface QueueItem { id: string; label: string; state: "queued" | "admitted" | "running" | "cancelled" }
export interface ToolDefinition { id: string; label: string; enabled: boolean; configurable: boolean }
export interface ContextSource { id: string; label: string; kind: string; availability: "available" | "unavailable" }

export interface CurrentChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
}

export interface RootSessionSnapshot {
  sessionId: string;
  accountId: string | null;
  projectId: string;
  chatId: string;
  cursor: HarnessCursor;
  state: "idle" | "working" | "blocked" | "failed" | "disconnected" | "stopped";
  parentMessages: readonly ParentMessage[];
  children: readonly ChildAgentSummary[];
  queue: readonly QueueItem[];
  tools: readonly ToolDefinition[];
  resources: readonly ContextSource[];
  usage: CurrentChatUsage;
}

export type HarnessStudioAction =
  | "conversation.user-version.create" | "conversation.response.regenerate" | "conversation.branch.create" | "conversation.files.review" | "conversation.archive-fork" | "conversation.history.page"
  | "composer.model.select" | "composer.thinking.select" | "composer.slash.execute"
  | "harness.session.prompt" | "harness.session.follow-up" | "harness.session.steer" | "harness.session.abort" | "harness.session.export" | "harness.session.compact"
  | "harness.child.stop" | "harness.child.transcript-page" | "harness.queue.run-now" | "harness.queue.remove" | "harness.tool.set-enabled" | "harness.context-source.open"
  | "harness.overload.retry" | "harness.extension.respond" | "usage.current.refresh" | "activity.file.open" | "editor.artifact.open" | "settings.harness-policy.set" | "settings.tool.set-enabled";

export type StudioRequest =
  | { type: "discover_runtime" }
  | { type: "bootstrap" }
  | { type: "attach_session"; sessionId: string }
  | { type: "session_command"; sessionId: string; commandId: string; expectedCursor: HarnessCursor; kind: "prompt" | "steer" | "follow_up" | "abort"; text: string }
  | { type: "inspector"; sessionId: string }
  | { type: "refresh_session"; sessionId: string; knownCursor: HarnessCursor }
  | { type: "studio_operation"; sessionId: string; operationId: string; action: HarnessStudioAction; payloadJson: string; expectedCursor: HarnessCursor | null; idempotencyKey: string | null };

export type StudioResponse =
  | { type: "discover_runtime_result"; runtime: RuntimeIdentity | null; compatibility: HarnessCompatibility }
  | { type: "bootstrap_result"; compatibility: HarnessCompatibility; sessions: readonly RootSessionSnapshot[] }
  | { type: "snapshot_result"; snapshot: RootSessionSnapshot }
  | { type: "command_result"; commandId: string; outcome: "accepted" | "queued" | "reconciled"; snapshot: RootSessionSnapshot }
  | { type: "inspector_result"; detailsJson: string }
  | { type: "studio_operation_result"; operationId: string; status: "accepted" | "queued" | "updated" | "cancelled" | "unavailable" | "rejected" | "unknown_outcome"; commandId: string | null; position: number | null; revision: string | null; reason: string | null; retryable: boolean | null; snapshot: RootSessionSnapshot | null }
  | { type: "error"; code: string; message: string };

export type HarnessEvent =
  | { type: "snapshot"; snapshot: RootSessionSnapshot }
  | { type: "session_state"; sessionId: string; cursor: HarnessCursor; state: RootSessionSnapshot["state"] };

export type StudioPayload = StudioRequest | StudioResponse | HarnessEvent;

export interface StudioEnvelope<TPayload extends StudioPayload = StudioPayload> {
  studioProtocol: typeof STUDIO_HARNESS_PROTOCOL;
  requestId: string;
  payload: TPayload;
}
