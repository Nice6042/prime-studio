import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BootProjection, HarnessProjectionEvent, RootSessionProjection } from "../../entities/harness/types";
import type { ChildAgentSummary, ContextSource, CurrentChatUsage, HarnessCapability, HarnessCompatibility, HarnessCursor, HarnessUnavailableReason, MessageBlock, ParentHistoryPage, ParentMessage, QueueItem, RuntimeIdentity, ToolDefinition, HarnessStudioAction, TurnPerformanceProjection, WorkerRecoveryProjection } from "./harness.generated";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";

const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();

const CAPABILITIES = new Set<HarnessCapability>(["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog", "extension_ui", "chunked_snapshot", "prompt_admission_cancellation", "queue_management", "resource_snapshot", "delete_child", "heartbeat_catalog", "heartbeat_management", "side_question_transcript", "transient_bash"]);
const MANDATORY_CAPABILITIES: readonly HarnessCapability[] = ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"];
const REASONS = new Set<HarnessUnavailableReason>(["not_installed", "runtime_identity_mismatch", "unsupported_protocol", "unsupported_schema", "missing_mandatory_capability", "transport_unavailable", "security_verification_failed"]);

export class HarnessProjectionError extends Error {
  constructor() {
    super("Harness projection unavailable.");
    this.name = "HarnessProjectionError";
  }
}

function fail(): never {
  throw new HarnessProjectionError();
}

function preflight(value: unknown, depth = 0, budget = { nodes: 0 }, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (depth > 256 || ++budget.nodes > 100_000 || seen.has(value)) fail();
  seen.add(value);
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) fail();
    preflight(descriptor.value, depth + 1, budget, seen);
  }
}

function detach(value: unknown): unknown {
  preflight(value);
  let detached: unknown;
  try {
    detached = structuredClone(value);
  } catch {
    return fail();
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(detached);
  } catch {
    return fail();
  }
  if (encoder.encode(encoded).byteLength > MAX_TRANSPORT_BYTES) fail();
  return detached;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
  return value as Record<string, unknown>;
}

function recordWithOptional(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value);
  if (required.some((key) => !actual.includes(key)) || actual.some((key) => !required.includes(key) && !optional.includes(key))) fail();
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[!-~]{1,128}$/u.test(value)) fail();
  return value;
}

function bounded(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") fail();
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) fail();
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      fail();
    }
    length += 1;
  }
  if ((!allowEmpty && length === 0) || length > maximum) fail();
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE) fail();
  return value as number;
}

function finiteBounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail();
  return value;
}

function u16(value: unknown): number {
  const parsed = safeInteger(value);
  if (parsed > 65_535) fail();
  return parsed;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function oneOf<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) fail();
  return value as T;
}

function unique<T>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) fail();
  return values;
}

function cursor(value: unknown): HarnessCursor {
  const source = record(value, ["runtimeGeneration", "sequence"]);
  return {
    runtimeGeneration: id(source.runtimeGeneration),
    sequence: safeInteger(source.sequence),
  };
}

function capabilityList(value: unknown): HarnessCapability[] {
  return unique(array(value, 128).map((item) => oneOf(item, CAPABILITIES))) as HarnessCapability[];
}

function runtime(value: unknown): RuntimeIdentity {
  const source = record(value, ["packageName", "packageVersion", "packageDigest", "entrypointDigest", "protocolName", "protocolVersion", "schemaRevision", "schemaId", "capabilities"]);
  if (source.packageName !== "prime-agent") fail();
  const digest = (candidate: unknown) => {
    if (typeof candidate !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate)) fail();
    return candidate;
  };
  return {
    packageName: "prime-agent",
    packageVersion: bounded(source.packageVersion, 64),
    packageDigest: digest(source.packageDigest),
    entrypointDigest: digest(source.entrypointDigest),
    protocolName: bounded(source.protocolName, 64),
    protocolVersion: u16(source.protocolVersion),
    schemaRevision: u16(source.schemaRevision),
    schemaId: bounded(source.schemaId, 128),
    capabilities: capabilityList(source.capabilities),
  };
}

function compatibility(value: unknown): HarnessCompatibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const status = (value as { status?: unknown }).status;
  if (status === "ready") {
    const source = record(value, ["status", "profile", "capabilities"]);
    const capabilities = capabilityList(source.capabilities);
    if (MANDATORY_CAPABILITIES.some((capability) => !capabilities.includes(capability))) fail();
    return { status, profile: id(source.profile), capabilities };
  }
  if (status === "degraded") {
    const source = record(value, ["status", "profile", "capabilities", "unavailable"]);
    const unavailable = array(source.unavailable, 128).map((item) => {
      const feature = record(item, ["capability", "reason"]);
      return {
        capability: oneOf(feature.capability, CAPABILITIES),
        reason: oneOf(feature.reason, REASONS),
      };
    });
    const capabilities = capabilityList(source.capabilities);
    if (MANDATORY_CAPABILITIES.some((capability) => !capabilities.includes(capability))) fail();
    const unavailableCapabilities = unavailable.map((item) => item.capability);
    unique(unavailableCapabilities);
    if (unavailableCapabilities.some((capability) => capabilities.includes(capability))) fail();
    return { status, profile: id(source.profile), capabilities, unavailable };
  }
  if (status === "read_only") {
    const source = record(value, ["status", "reason", "runtime"]);
    return {
      status,
      reason: oneOf(source.reason, REASONS),
      runtime: source.runtime === null ? null : runtime(source.runtime),
    };
  }
  if (status === "unavailable") {
    const source = record(value, ["status", "reason"]);
    return { status, reason: oneOf(source.reason, REASONS) };
  }
  return fail();
}

function block(value: unknown): MessageBlock {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "text") {
    const source = record(value, ["kind", "text"]);
    return { kind, text: bounded(source.text, 131_072, true) };
  }
  if (kind === "thinking") {
    const source = record(value, ["kind", "text", "redacted"]);
    return {
      kind,
      text: bounded(source.text, 131_072, true),
      redacted: boolean(source.redacted),
    };
  }
  if (kind === "tool_call") {
    const source = record(value, ["kind", "toolCallId", "toolId", "status"]);
    return {
      kind,
      toolCallId: id(source.toolCallId),
      toolId: id(source.toolId),
      status: oneOf(source.status, new Set(["pending", "running", "blocked", "succeeded", "failed"] as const)),
    };
  }
  return fail();
}

function message(value: unknown): ParentMessage {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "assistant") {
    const source = record(value, ["channel", "kind", "id", "blocks", "streaming", "emittedAtMs"]);
    if (source.channel !== "parent") fail();
    return {
      channel: "parent",
      kind,
      id: id(source.id),
      blocks: array(source.blocks, 1024).map(block),
      streaming: boolean(source.streaming),
      emittedAtMs: safeInteger(source.emittedAtMs),
    };
  }
  if (kind === "user" || kind === "notice") {
    const source = record(value, ["channel", "kind", "id", "text", "emittedAtMs"]);
    if (source.channel !== "parent") fail();
    return {
      channel: "parent",
      kind,
      id: id(source.id),
      text: bounded(source.text, 131_072, true),
      emittedAtMs: safeInteger(source.emittedAtMs),
    };
  }
  return fail();
}

function child(value: unknown): ChildAgentSummary {
  const source = record(value, ["id", "status", "task", "provider", "model", "progress"]);
  const nullableLabel = (candidate: unknown) => (candidate === null ? null : bounded(candidate, 200));
  const progress = source.progress === null ? null : source.progress;
  if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)) fail();
  return {
    id: id(source.id),
    status: oneOf(source.status, new Set(["queued", "running", "done", "error", "cancelled", "unknown"] as const)),
    task: bounded(source.task, 200),
    provider: nullableLabel(source.provider),
    model: nullableLabel(source.model),
    progress: progress as number | null,
  };
}

function queueItem(value: unknown): QueueItem {
  const source = record(value, ["id", "label", "state"]);
  return {
    id: id(source.id),
    label: bounded(source.label, 200),
    state: oneOf(source.state, new Set(["queued", "admitted", "running", "cancelled"] as const)),
  };
}

function tool(value: unknown): ToolDefinition {
  const source = record(value, ["id", "label", "enabled", "configurable"]);
  return {
    id: id(source.id),
    label: bounded(source.label, 200),
    enabled: boolean(source.enabled),
    configurable: boolean(source.configurable),
  };
}

function resource(value: unknown): ContextSource {
  const source = record(value, ["id", "label", "kind", "availability"]);
  return {
    id: id(source.id),
    label: bounded(source.label, 200),
    kind: id(source.kind),
    availability: oneOf(source.availability, new Set(["available", "unavailable"] as const)),
  };
}

function usage(value: unknown): CurrentChatUsage {
  const source = record(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]);
  const cost = source.cost;
  if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 1e15)) fail();
  const input = safeInteger(source.input);
  const output = safeInteger(source.output);
  const cacheRead = safeInteger(source.cacheRead);
  const cacheWrite = safeInteger(source.cacheWrite);
  const totalTokens = safeInteger(source.totalTokens);
  const categoryTotal = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(categoryTotal) || categoryTotal !== totalTokens) fail();
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: cost as number | null,
  };
}

function workerRecovery(value: unknown): WorkerRecoveryProjection {
  const source = record(value, ["status", "closureReason", "observationId", "automaticRetryCount", "detail"]);
  const status = oneOf(source.status, new Set(["starting", "ready", "recovering", "retryable_failure", "retrying", "recovered", "terminal_failure"] as const));
  const closureReason = source.closureReason === null ? null : oneOf(source.closureReason, new Set(["unexpected_worker_disconnect", "supervisor_recovery_exhausted"] as const));
  const observationId = source.observationId === null ? null : id(source.observationId);
  const automaticRetryCount = safeInteger(source.automaticRetryCount);
  const detail = source.detail === null ? null : bounded(source.detail, 200);
  if (automaticRetryCount > 1) fail();
  if (status === "starting" && (closureReason !== null || observationId !== null || automaticRetryCount !== 0)) fail();
  if (status === "ready" && (closureReason !== null || observationId !== null || automaticRetryCount !== 0 || detail !== null)) fail();
  if ((status === "recovering" || status === "retryable_failure") && (closureReason === null || observationId === null || automaticRetryCount !== 0)) fail();
  if ((status === "retrying" || status === "recovered") && (closureReason === null || observationId === null || automaticRetryCount !== 1)) fail();
  if (status === "terminal_failure" && closureReason === null) fail();
  return { status, closureReason, observationId, automaticRetryCount: automaticRetryCount as 0 | 1, detail };
}

function turnPerformance(value: unknown, sessionId: string, snapshotCursor: HarnessCursor): TurnPerformanceProjection {
  const status = value && typeof value === "object" && !Array.isArray(value) ? (value as { status?: unknown }).status : undefined;
  if (status === "available") {
    const source = record(value, ["status", "sessionId", "cursor", "firstTokenLatencyMs", "outputTokens", "generationDurationMs", "tokensPerSecond"]);
    const boundCursor = cursor(source.cursor);
    const projection: TurnPerformanceProjection = {
      status,
      sessionId: id(source.sessionId),
      cursor: boundCursor,
      firstTokenLatencyMs: finiteBounded(source.firstTokenLatencyMs, 0, 86_400_000),
      outputTokens: safeInteger(source.outputTokens),
      generationDurationMs: finiteBounded(source.generationDurationMs, 1, 86_400_000),
      tokensPerSecond: finiteBounded(source.tokensPerSecond, 0, 1_000_000),
    };
    if (projection.sessionId !== sessionId || projection.cursor.runtimeGeneration !== snapshotCursor.runtimeGeneration || projection.cursor.sequence !== snapshotCursor.sequence || projection.outputTokens === 0) fail();
    return projection;
  }
  const source = record(value, ["status", "sessionId", "cursor", "reason"]);
  if (source.status !== "unavailable") fail();
  const boundCursor = cursor(source.cursor);
  const projection: TurnPerformanceProjection = {
    status: "unavailable",
    sessionId: id(source.sessionId),
    cursor: boundCursor,
    reason: oneOf(source.reason, new Set(["event_chronology_unavailable", "event_chronology_incomplete", "event_chronology_invalid", "generation_changed"] as const)),
  };
  if (projection.sessionId !== sessionId || projection.cursor.runtimeGeneration !== snapshotCursor.runtimeGeneration || projection.cursor.sequence !== snapshotCursor.sequence) fail();
  return projection;
}

function session(value: unknown): RootSessionProjection {
  const source = record(value, ["sessionId", "accountId", "projectId", "chatId", "cursor", "state", "freshness", "parentMessages", "children", "queue", "tools", "resources", "usage", "workerRecovery", "performance"]);
  const sessionId = id(source.sessionId);
  const snapshotCursor = cursor(source.cursor);
  const children = array(source.children, 256).map(child);
  const childIds = new Set<string>();
  for (const item of children) {
    if (item.id === sessionId || childIds.has(item.id)) fail();
    childIds.add(item.id);
  }
  return {
    sessionId,
    accountId: source.accountId === null ? null : id(source.accountId),
    projectId: id(source.projectId),
    chatId: id(source.chatId),
    cursor: snapshotCursor,
    state: oneOf(source.state, new Set(["idle", "working", "blocked", "failed", "disconnected", "stopped"] as const)),
    freshness: oneOf(source.freshness, new Set(["live", "stale", "disconnected", "unknown_outcome"] as const)),
    parentMessages: array(source.parentMessages, 300).map(message),
    children,
    queue: array(source.queue, 256).map(queueItem),
    tools: array(source.tools, 512).map(tool),
    resources: array(source.resources, 512).map(resource),
    usage: usage(source.usage),
    workerRecovery: workerRecovery(source.workerRecovery),
    performance: turnPerformance(source.performance, sessionId, snapshotCursor),
  };
}

export function decodeRootSessionProjection(value: unknown): RootSessionProjection {
  return deepFreeze(session(detach(value)));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

export function decodeBootProjection(value: unknown): BootProjection {
  const source = record(detach(value), ["compatibility", "sessions"]);
  const decodedCompatibility = compatibility(source.compatibility);
  const sessions = array(source.sessions, 256).map(session);
  if ((decodedCompatibility.status === "unavailable" || decodedCompatibility.status === "read_only") && sessions.length !== 0) fail();
  const rootIds = new Set(sessions.map((item) => item.sessionId));
  if (rootIds.size !== sessions.length) fail();
  const childOwners = new Set<string>();
  for (const item of sessions) {
    for (const child of item.children) {
      if (rootIds.has(child.id) || childOwners.has(child.id)) fail();
      childOwners.add(child.id);
    }
  }
  return deepFreeze({ compatibility: decodedCompatibility, sessions });
}

export function decodeHarnessProjectionEvent(value: unknown): HarnessProjectionEvent {
  const source = record(detach(value), ["schemaVersion", "sequence", "type", "session"]);
  if (source.schemaVersion !== 1 || source.type !== "session_projection") fail();
  return deepFreeze({
    schemaVersion: 1,
    sequence: safeInteger(source.sequence),
    type: "session_projection",
    session: session(source.session),
  });
}

export async function bootstrapHarness(): Promise<BootProjection> {
  const projection = decodeBootProjection(await invoke("harness_bootstrap"));
  lastSequence = 0;
  eventStreamClosed = false;
  sessionCursors.clear();
  retiredGenerations.clear();
  childOwners.clear();
  sessionChildren.clear();
  for (const session of projection.sessions) registerHarnessSessionProjection(session);
  return projection;
}

export interface HarnessSessionCommandRequest {
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedCursor: HarnessCursor;
  readonly kind: "prompt" | "steer" | "follow_up" | "abort";
  readonly text: string;
}

export interface HarnessSessionCommandResult {
  readonly commandId: string;
  readonly outcome: "accepted" | "queued" | "reconciled";
  readonly session: RootSessionProjection;
}

export function decodeHarnessSessionProjection(value: unknown): RootSessionProjection {
  return deepFreeze(session(detach(value)));
}

export async function attachHarnessSession(sessionId: string): Promise<RootSessionProjection> {
  const exactSessionId = id(sessionId);
  const projection = decodeHarnessSessionProjection(
    await invoke("harness_attach_session", {
      request: { sessionId: exactSessionId },
    }),
  );
  if (projection.sessionId !== exactSessionId) fail();
  return registerHarnessSessionProjection(projection);
}

export async function refreshHarnessSession(sessionId: string, knownCursor: HarnessCursor): Promise<RootSessionProjection> {
  const exactSessionId = id(sessionId);
  const exactCursor = cursor(knownCursor);
  const projection = session(detach(await invoke("harness_refresh_session", { request: { sessionId: exactSessionId, knownCursor: exactCursor } })));
  if (
    projection.sessionId !== exactSessionId
    || (projection.cursor.runtimeGeneration === exactCursor.runtimeGeneration
      && projection.cursor.sequence !== exactCursor.sequence + 1)
  ) fail();
  return deepFreeze(projection);
}

function parentHistoryPage(value: unknown): ParentHistoryPage {
  const source = record(detach(value), ["sessionId", "snapshotCursor", "messages", "totalMessages", "omittedBefore", "omittedAfter", "olderCursor", "truncatedByBytes"]);
  const messages = array(source.messages, 100).map(message);
  const totalMessages = safeInteger(source.totalMessages);
  const omittedBefore = safeInteger(source.omittedBefore);
  const omittedAfter = safeInteger(source.omittedAfter);
  if (totalMessages > 4_096 || omittedBefore + messages.length + omittedAfter !== totalMessages) fail();
  if (new Set(messages.map((entry) => entry.id)).size !== messages.length) fail();
  return deepFreeze({
    sessionId: id(source.sessionId),
    snapshotCursor: cursor(source.snapshotCursor),
    messages,
    totalMessages,
    omittedBefore,
    omittedAfter,
    olderCursor: source.olderCursor === null ? null : id(source.olderCursor),
    truncatedByBytes: boolean(source.truncatedByBytes),
  });
}

export async function pageHarnessConversationHistory(
  sessionId: string,
  expectedCursor: HarnessCursor,
  before: string | null,
): Promise<ParentHistoryPage> {
  const exactSessionId = id(sessionId);
  const exactCursor = cursor(expectedCursor);
  const exactBefore = before === null ? null : id(before);
  const page = parentHistoryPage(await invoke("harness_conversation_history_page", {
    request: { sessionId: exactSessionId, expectedCursor: exactCursor, before: exactBefore },
  }));
  if (
    page.sessionId !== exactSessionId
    || page.snapshotCursor.runtimeGeneration !== exactCursor.runtimeGeneration
    || page.snapshotCursor.sequence !== exactCursor.sequence
  ) fail();
  return page;
}

function commandRequest(value: HarnessSessionCommandRequest): HarnessSessionCommandRequest {
  const source = record(detach(value), ["sessionId", "commandId", "expectedCursor", "kind", "text"]);
  const kind = oneOf(source.kind, new Set(["prompt", "steer", "follow_up", "abort"] as const));
  const text = bounded(source.text, 131_072, true);
  if ((kind === "abort") !== (text.length === 0) || (kind !== "abort" && text.trim().length === 0)) fail();
  return deepFreeze({
    sessionId: id(source.sessionId),
    commandId: id(source.commandId),
    expectedCursor: cursor(source.expectedCursor),
    kind,
    text,
  });
}

export async function sendHarnessCommand(request: HarnessSessionCommandRequest): Promise<HarnessSessionCommandResult> {
  const exact = commandRequest(request);
  const source = record(detach(await invoke("harness_session_command", { request: exact })), ["commandId", "outcome", "session"]);
  const commandId = id(source.commandId);
  const projected = session(source.session);
  if (commandId !== exact.commandId || projected.sessionId !== exact.sessionId || projected.cursor.runtimeGeneration !== exact.expectedCursor.runtimeGeneration || projected.cursor.sequence !== exact.expectedCursor.sequence + 1) fail();
  const admitted = advanceHarnessSessionProjection(projected, exact.expectedCursor);
  return deepFreeze({
    commandId,
    outcome: oneOf(source.outcome, new Set(["accepted", "queued", "reconciled"] as const)),
    session: admitted,
  });
}

export interface HarnessWorkerRetryResult {
  readonly observationId: string;
  readonly outcome: "recovered" | "terminal_failure";
  readonly session: RootSessionProjection;
}

export async function retryHarnessWorker(sessionId: string, observationId: string): Promise<HarnessWorkerRetryResult> {
  const exactSessionId = id(sessionId);
  const exactObservationId = id(observationId);
  const previous = sessionCursors.get(exactSessionId);
  if (!previous) fail();
  const source = record(detach(await invoke("harness_retry_worker", {
    request: { sessionId: exactSessionId, observationId: exactObservationId },
  })), ["observationId", "outcome", "session"]);
  const projected = session(source.session);
  if (
    id(source.observationId) !== exactObservationId
    || projected.sessionId !== exactSessionId
    || projected.workerRecovery.observationId !== exactObservationId
    || projected.workerRecovery.automaticRetryCount !== 1
  ) fail();
  const outcome = oneOf(source.outcome, new Set(["recovered", "terminal_failure"] as const));
  if ((outcome === "recovered") !== (projected.workerRecovery.status === "recovered")) fail();
  if (outcome === "terminal_failure" && projected.workerRecovery.status !== "terminal_failure") fail();
  const admitted = advanceHarnessSessionProjection(projected, previous);
  return deepFreeze({ observationId: exactObservationId, outcome, session: admitted });
}

export interface HarnessInspectorDetails {
  readonly observedAtMs: number;
  readonly startedAtMs: number | null;
  readonly context: Readonly<{
    usedTokens: number;
    capacityTokens: number;
    turns?: number;
    samples?: readonly number[];
  }> | null;
  readonly turnUsage?: Readonly<{
    totalTurns: number;
    omittedTurns: number;
    rows: readonly Readonly<{
      turn: number;
      occurredAtMs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    }>[];
  }>;
  readonly contributions: readonly Readonly<{
    id: string;
    label: string;
    tokens: number;
  }>[];
  readonly notices: readonly Readonly<{
    id: string;
    kind: "info" | "warning" | "error";
    title: string;
    detail: string;
    retryable: boolean;
    dismissible: boolean;
  }>[];
  readonly activity: readonly Readonly<{
    id: string;
    occurredAtMs: number;
    group: string;
    kind: "agent" | "tool" | "file" | "system";
    title: string;
    detail: string;
    childId?: string;
    artifactCandidateId?: string;
    tool?: Readonly<{
      command: string;
      status: "pending" | "running" | "blocked" | "succeeded" | "failed";
      durationMs: number | null;
      files: readonly Readonly<{ candidateId: string; label: string }>[];
    }>;
  }>[];
  readonly outputs: readonly Readonly<{
    id: string;
    label: string;
    candidateId?: string;
    kind: string;
  }>[];
  readonly sources: readonly Readonly<{
    id: string;
    label: string;
    detail: string;
    candidateId?: string;
    kind: string;
  }>[];
  readonly children: Readonly<
    Record<
      string,
      Readonly<{
        summary: string;
        startedAtMs: number | null;
        context: Readonly<{
          usedTokens: number;
          capacityTokens: number;
          turns?: number;
          samples?: readonly number[];
        }> | null;
        transcript: readonly Readonly<{
          id: string;
          actor: string;
          occurredAtMs: number;
          text: string;
        }>[];
        activity: readonly Readonly<{
          id: string;
          occurredAtMs: number;
          label: string;
        }>[];
        files: readonly Readonly<{
          id: string;
          label: string;
          candidateId: string;
          change: "added" | "modified" | "deleted" | "read";
        }>[];
        error: Readonly<{
          code: string;
          message: string;
          retryable: boolean;
        }> | null;
      }>
    >
  >;
  readonly extensionUi:
    | Readonly<{ status: "unavailable"; reason: string }>
    | Readonly<{ status: "available"; requests: readonly HarnessExtensionUiRequest[] }>;
}

export type HarnessExtensionUiRequest =
  | Readonly<{ id: string; method: "confirm"; title: string; message: string; cursor: RootSessionProjection["cursor"] }>
  | Readonly<{ id: string; method: "select"; title: string; options: readonly string[]; cursor: RootSessionProjection["cursor"] }>
  | Readonly<{ id: string; method: "input"; title: string; placeholder: string | null; cursor: RootSessionProjection["cursor"] }>
  | Readonly<{ id: string; method: "editor"; title: string; prefill: string; cursor: RootSessionProjection["cursor"] }>;

function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function inspectorContext(value: unknown): HarnessInspectorDetails["context"] {
  if (value === null) return null;
  const source = recordWithOptional(value, ["usedTokens", "capacityTokens"], ["turns", "samples"]);
  const result: {
    usedTokens: number;
    capacityTokens: number;
    turns?: number;
    samples?: readonly number[];
  } = {
    usedTokens: safeInteger(source.usedTokens),
    capacityTokens: safeInteger(source.capacityTokens),
  };
  if (source.turns !== undefined) result.turns = safeInteger(source.turns);
  if (source.samples !== undefined) result.samples = array(source.samples, 1_024).map(safeInteger);
  return result;
}

function decodeExtensionUi(value: unknown, expectedCursor?: RootSessionProjection["cursor"]): HarnessInspectorDetails["extensionUi"] {
  const source = recordWithOptional(value, ["status"], ["reason", "requests"]);
  if (source.status === "unavailable") {
    if (source.requests !== undefined || source.reason === undefined) fail();
    return { status: "unavailable", reason: bounded(source.reason, 200) };
  }
  if (source.status !== "available" || source.reason !== undefined || source.requests === undefined) fail();
  const seen = new Set<string>();
  const requests = array(source.requests, 16).map((entry): HarnessExtensionUiRequest => {
    const base = recordWithOptional(entry, ["id", "method", "title", "cursor"], ["message", "options", "placeholder", "prefill"]);
    const requestId = id(base.id);
    if (seen.has(requestId)) fail();
    seen.add(requestId);
    const method = oneOf(base.method, new Set(["confirm", "select", "input", "editor"] as const));
    const title = bounded(base.title, 200);
    const rawCursor = record(base.cursor, ["runtimeGeneration", "sequence"]);
    const requestCursor = { runtimeGeneration: id(rawCursor.runtimeGeneration), sequence: safeInteger(rawCursor.sequence) };
    if (expectedCursor && (requestCursor.runtimeGeneration !== expectedCursor.runtimeGeneration || requestCursor.sequence !== expectedCursor.sequence)) fail();
    if (method === "confirm") {
      if (base.message === undefined || base.options !== undefined || base.placeholder !== undefined || base.prefill !== undefined) fail();
      return { id: requestId, method, title, message: bounded(base.message, 8_192, true), cursor: requestCursor };
    }
    if (method === "select") {
      if (base.options === undefined || base.message !== undefined || base.placeholder !== undefined || base.prefill !== undefined) fail();
      const options = array(base.options, 64).map((option) => bounded(option, 200));
      if (options.length === 0 || new Set(options).size !== options.length) fail();
      return { id: requestId, method, title, options, cursor: requestCursor };
    }
    if (method === "input") {
      if (base.placeholder === undefined || base.message !== undefined || base.options !== undefined || base.prefill !== undefined) fail();
      return { id: requestId, method, title, placeholder: base.placeholder === null ? null : bounded(base.placeholder, 500, true), cursor: requestCursor };
    }
    if (base.prefill === undefined || base.message !== undefined || base.options !== undefined || base.placeholder !== undefined) fail();
    return { id: requestId, method, title, prefill: bounded(base.prefill, 32_768, true), cursor: requestCursor };
  });
  return { status: "available", requests };
}

export function decodeHarnessInspectorDetails(value: unknown, expectedCursor?: RootSessionProjection["cursor"]): HarnessInspectorDetails {
  const source = recordWithOptional(detach(value), ["observedAtMs", "startedAtMs", "context", "contributions", "notices", "activity", "outputs", "sources", "children", "extensionUi"], ["turnUsage"]);
  const childrenSource = source.children;
  if (!childrenSource || typeof childrenSource !== "object" || Array.isArray(childrenSource) || Object.getPrototypeOf(childrenSource) !== Object.prototype) fail();
  const childrenEntries = Object.entries(childrenSource);
  if (childrenEntries.length > 256) fail();
  const children: Record<string, HarnessInspectorDetails["children"][string]> = {};
  for (const [childId, value] of childrenEntries) {
    id(childId);
    const child = record(value, ["summary", "startedAtMs", "context", "transcript", "activity", "files", "error"]);
    const error =
      child.error === null
        ? null
        : (() => {
            const item = record(child.error, ["code", "message", "retryable"]);
            return {
              code: id(item.code),
              message: bounded(item.message, 8_192, true),
              retryable: boolean(item.retryable),
            };
          })();
    children[childId] = {
      summary: bounded(child.summary, 8_192, true),
      startedAtMs: nullableSafeInteger(child.startedAtMs),
      context: inspectorContext(child.context),
      transcript: array(child.transcript, 4_096).map((entry) => {
        const item = record(entry, ["id", "actor", "occurredAtMs", "text"]);
        return {
          id: id(item.id),
          actor: bounded(item.actor, 128),
          occurredAtMs: safeInteger(item.occurredAtMs),
          text: bounded(item.text, 131_072, true),
        };
      }),
      activity: array(child.activity, 4_096).map((entry) => {
        const item = record(entry, ["id", "occurredAtMs", "label"]);
        return {
          id: id(item.id),
          occurredAtMs: safeInteger(item.occurredAtMs),
          label: bounded(item.label, 8_192, true),
        };
      }),
      files: array(child.files, 4_096).map((entry) => {
        const item = record(entry, ["id", "label", "candidateId", "change"]);
        return {
          id: id(item.id),
          label: bounded(item.label, 8_192),
          candidateId: id(item.candidateId),
          change: oneOf(item.change, new Set(["added", "modified", "deleted", "read"] as const)),
        };
      }),
      error,
    };
  }
  let turnUsage: HarnessInspectorDetails["turnUsage"];
  if (source.turnUsage !== undefined) {
    const series = record(source.turnUsage, ["totalTurns", "omittedTurns", "rows"]);
    const totalTurns = safeInteger(series.totalTurns);
    const omittedTurns = safeInteger(series.omittedTurns);
    const rows = array(series.rows, 300).map((entry) => {
      const row = record(entry, ["turn", "occurredAtMs", "input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
      const projected = {
        turn: safeInteger(row.turn), occurredAtMs: safeInteger(row.occurredAtMs),
        input: safeInteger(row.input), output: safeInteger(row.output),
        cacheRead: safeInteger(row.cacheRead), cacheWrite: safeInteger(row.cacheWrite),
        totalTokens: safeInteger(row.totalTokens),
      };
      if (projected.totalTokens !== projected.input + projected.output + projected.cacheRead + projected.cacheWrite) fail();
      return projected;
    });
    if (totalTurns !== omittedTurns + rows.length) fail();
    let previousOccurredAtMs = 0;
    for (const [index, row] of rows.entries()) {
      if (row.turn !== omittedTurns + index + 1 || row.occurredAtMs < previousOccurredAtMs) fail();
      previousOccurredAtMs = row.occurredAtMs;
    }
    turnUsage = { totalTurns, omittedTurns, rows };
  }
  const result: HarnessInspectorDetails = {
    observedAtMs: safeInteger(source.observedAtMs),
    startedAtMs: nullableSafeInteger(source.startedAtMs),
    context: inspectorContext(source.context),
    extensionUi: decodeExtensionUi(source.extensionUi, expectedCursor),
    contributions: array(source.contributions, 1_024).map((entry) => {
      const item = record(entry, ["id", "label", "tokens"]);
      return {
        id: id(item.id),
        label: bounded(item.label, 8_192),
        tokens: safeInteger(item.tokens),
      };
    }),
    notices: array(source.notices, 1_024).map((entry) => {
      const item = record(entry, ["id", "kind", "title", "detail", "retryable", "dismissible"]);
      return {
        id: id(item.id),
        kind: oneOf(item.kind, new Set(["info", "warning", "error"] as const)),
        title: bounded(item.title, 8_192),
        detail: bounded(item.detail, 32_768, true),
        retryable: boolean(item.retryable),
        dismissible: boolean(item.dismissible),
      };
    }),
    activity: array(source.activity, 4_096).map((entry) => {
      const item = recordWithOptional(entry, ["id", "occurredAtMs", "group", "kind", "title", "detail"], ["childId", "artifactCandidateId", "tool"]);
      const activity: HarnessInspectorDetails["activity"][number] & {
        childId?: string;
        artifactCandidateId?: string;
        tool?: HarnessInspectorDetails["activity"][number]["tool"];
      } = {
        id: id(item.id),
        occurredAtMs: safeInteger(item.occurredAtMs),
        group: bounded(item.group, 256),
        kind: oneOf(item.kind, new Set(["agent", "tool", "file", "system"] as const)),
        title: bounded(item.title, 8_192),
        detail: bounded(item.detail, 32_768, true),
      };
      if (item.childId !== undefined) activity.childId = id(item.childId);
      if (item.artifactCandidateId !== undefined) activity.artifactCandidateId = id(item.artifactCandidateId);
      if (item.tool !== undefined) {
        const tool = record(item.tool, ["command", "status", "durationMs", "files"]);
        activity.tool = {
          command: bounded(tool.command, 32_768, true),
          status: oneOf(tool.status, new Set(["pending", "running", "blocked", "succeeded", "failed"] as const)),
          durationMs: nullableSafeInteger(tool.durationMs),
          files: array(tool.files, 1_024).map((file) => {
            const candidate = record(file, ["candidateId", "label"]);
            return { candidateId: id(candidate.candidateId), label: bounded(candidate.label, 8_192) };
          }),
        };
      }
      return activity;
    }),
    outputs: array(source.outputs, 1_024).map((entry) => {
      const item = recordWithOptional(entry, ["id", "label", "kind"], ["candidateId"]);
      return {
        id: id(item.id),
        label: bounded(item.label, 8_192),
        kind: bounded(item.kind, 128),
        ...(item.candidateId === undefined ? {} : { candidateId: id(item.candidateId) }),
      };
    }),
    sources: array(source.sources, 1_024).map((entry) => {
      const item = recordWithOptional(entry, ["id", "label", "detail", "kind"], ["candidateId"]);
      return {
        id: id(item.id),
        label: bounded(item.label, 8_192),
        detail: bounded(item.detail, 32_768, true),
        kind: bounded(item.kind, 128),
        ...(item.candidateId === undefined ? {} : { candidateId: id(item.candidateId) }),
      };
    }),
    children,
    ...(turnUsage ? { turnUsage } : {}),
  };
  return deepFreeze(result);
}

export async function loadHarnessInspector(sessionId: string): Promise<HarnessInspectorDetails> {
  const exactSessionId = id(sessionId);
  const detailsJson = bounded(
    await invoke("harness_inspector", {
      request: { sessionId: exactSessionId },
    }),
    131_072,
    true,
  );
  try {
    // The native broker already binds every request cursor to this inspector
    // response's admitted session cursor. The renderer rechecks it against the
    // displayed projection before rendering; do not couple decoding to the
    // process-global live cursor ledger, which may have advanced concurrently.
    return decodeHarnessInspectorDetails(JSON.parse(detailsJson));
  } catch (error) {
    if (error instanceof HarnessProjectionError) throw error;
    return fail();
  }
}

export type HarnessChildDataPage =
  | Readonly<{ status: "unavailable"; tab: "chat" | "activity" | "files"; reason: string }>
  | Readonly<{ status: "available"; tab: "chat"; items: readonly Readonly<{ id: string; actor: string; occurredAtMs: number; text: string }>[]; previousCursor: string | null; omittedItems: number }>
  | Readonly<{ status: "available"; tab: "activity"; items: readonly Readonly<{ id: string; occurredAtMs: number; label: string }>[]; previousCursor: string | null; omittedItems: number }>
  | Readonly<{ status: "available"; tab: "files"; items: readonly Readonly<{ id: string; label: string; candidateId: string; change: "added" | "modified" | "deleted" | "read" }>[]; previousCursor: string | null; omittedItems: number }>;

function decodeHarnessChildDataPage(value: unknown): HarnessChildDataPage {
  const base = recordWithOptional(value, ["status", "tab"], ["reason", "items", "previousCursor", "omittedItems"]);
  const tab = oneOf(base.tab, new Set(["chat", "activity", "files"] as const));
  if (base.status === "unavailable") {
    const source = record(base, ["status", "tab", "reason"]);
    return deepFreeze({ status: "unavailable", tab, reason: bounded(source.reason, 200) });
  }
  const source = record(base, ["status", "tab", "items", "previousCursor", "omittedItems"]);
  if (source.status !== "available") return fail();
  const previousCursor = source.previousCursor === null ? null : id(source.previousCursor);
  const omittedItems = safeInteger(source.omittedItems);
  if (tab === "chat") return deepFreeze({ status: "available", tab, previousCursor, omittedItems, items: array(source.items, 100).map((row) => { const item = record(row, ["id", "actor", "occurredAtMs", "text"]); return { id: id(item.id), actor: bounded(item.actor, 64), occurredAtMs: safeInteger(item.occurredAtMs), text: bounded(item.text, 131_072, true) }; }) });
  if (tab === "activity") return deepFreeze({ status: "available", tab, previousCursor, omittedItems, items: array(source.items, 100).map((row) => { const item = record(row, ["id", "occurredAtMs", "label"]); return { id: id(item.id), occurredAtMs: safeInteger(item.occurredAtMs), label: bounded(item.label, 8_192) }; }) });
  return deepFreeze({ status: "available", tab, previousCursor, omittedItems, items: array(source.items, 100).map((row) => { const item = record(row, ["id", "label", "candidateId", "change"]); return { id: id(item.id), label: bounded(item.label, 8_192), candidateId: id(item.candidateId), change: oneOf(item.change, new Set(["added", "modified", "deleted", "read"] as const)) }; }) });
}

export async function loadHarnessChildPage(sessionId: string, childId: string, tab: "chat" | "activity" | "files", expectedCursor: HarnessCursor, pageCursor: string | null): Promise<HarnessChildDataPage> {
  const pageJson = bounded(await invoke("harness_child_data_page", { request: { sessionId: id(sessionId), childId: id(childId), tab, expectedCursor: cursor(expectedCursor), pageCursor: pageCursor === null ? null : id(pageCursor) } }), 131_072, true);
  try { return decodeHarnessChildDataPage(JSON.parse(pageJson)); } catch (error) { if (error instanceof HarnessProjectionError) throw error; return fail(); }
}

export type HarnessStudioOperation = Extract<StudioOperation, { action: HarnessStudioAction }>;

export interface HarnessStudioOperationRequest {
  readonly sessionId: string;
  readonly operation: HarnessStudioOperation;
  readonly expectedCursor?: HarnessCursor | null;
  readonly idempotencyKey?: string | null;
}

export async function executeHarnessStudioOperation(
  request: HarnessStudioOperationRequest,
  onProjection?: (session: RootSessionProjection) => void,
): Promise<StudioOperationOutcome> {
  const sessionId = id(request.sessionId);
  const operationId = id(request.operation.operationId ?? crypto.randomUUID());
  const payload = detach(request.operation.payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail();
  if ("sessionId" in payload && payload.sessionId !== sessionId) fail();
  const payloadJson = bounded(JSON.stringify(payload), 131_072, true);
  const expectedCursor = request.expectedCursor == null ? null : cursor(request.expectedCursor);
  const idempotencyKey = request.idempotencyKey == null ? operationId : id(request.idempotencyKey);
  const response = record(
    detach(
      await invoke("harness_studio_operation", {
        request: {
          sessionId,
          operationId,
          action: request.operation.action,
          payloadJson,
          expectedCursor,
          idempotencyKey,
        },
      }),
    ),
    ["operationId", "status", "commandId", "position", "revision", "reason", "retryable", "session"],
  );
  if (id(response.operationId) !== operationId) fail();
  const status = oneOf(response.status, new Set(["accepted", "queued", "updated", "cancelled", "unavailable", "rejected", "unknown_outcome"] as const));
  const commandId = response.commandId === null ? null : id(response.commandId);
  const position = response.position === null ? null : safeInteger(response.position);
  const revision = response.revision === null ? null : bounded(response.revision, 128);
  const reason = response.reason === null ? null : bounded(response.reason, 8_192);
  const retryable = response.retryable === null ? null : boolean(response.retryable);
  const successful = ["accepted", "queued", "updated", "cancelled"].includes(status);
  if (successful !== (response.session !== null)) fail();
  if (response.session !== null) {
    const projected = session(response.session);
    if (projected.sessionId !== sessionId) fail();
    if (expectedCursor && (projected.cursor.runtimeGeneration !== expectedCursor.runtimeGeneration || projected.cursor.sequence !== expectedCursor.sequence + 1)) fail();
    const admitted = expectedCursor
      ? advanceHarnessSessionProjection(projected, expectedCursor)
      : registerHarnessSessionProjection(projected);
    onProjection?.(admitted);
  }
  if (status === "accepted" && commandId) return deepFreeze({ status, commandId });
  if (status === "queued" && commandId) return deepFreeze({ status, commandId, position });
  if (status === "updated" && revision !== null) return deepFreeze({ status, revision });
  if (status === "cancelled") return deepFreeze({ status, commandId });
  if (status === "unavailable" && reason !== null) return deepFreeze({ status, reason });
  if (status === "rejected" && reason !== null && retryable !== null) return deepFreeze({ status, reason, retryable });
  if (status === "unknown_outcome" && reason !== null) return deepFreeze({ status, operationId, reason });
  return fail();
}

type Listener = (event: HarnessProjectionEvent) => void;
const listeners = new Set<Listener>();
let unlisten: Promise<UnlistenFn> | null = null;
let lastSequence = 0;
let eventStreamClosed = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshRunning = false;
const sessionCursors = new Map<string, HarnessCursor>();
const retiredGenerations = new Map<string, Set<string>>();
const childOwners = new Map<string, string>();
const sessionChildren = new Map<string, Set<string>>();

function sameCursor(left: HarnessCursor, right: HarnessCursor): boolean {
  return left.runtimeGeneration === right.runtimeGeneration && left.sequence === right.sequence;
}

function installSessionProjection(projected: RootSessionProjection): RootSessionProjection {
  const sessionId = projected.sessionId;
  const nextChildren = new Set(projected.children.map((child) => child.id));
  for (const child of nextChildren) {
    const owner = childOwners.get(child);
    if (owner && owner !== sessionId) fail();
  }
  for (const child of sessionChildren.get(sessionId) ?? []) {
    if (!nextChildren.has(child) && childOwners.get(child) === sessionId) childOwners.delete(child);
  }
  for (const child of nextChildren) childOwners.set(child, sessionId);
  sessionChildren.set(sessionId, nextChildren);
  sessionCursors.set(sessionId, projected.cursor);
  return deepFreeze(projected);
}

/** Register an authoritative attach/create/bootstrap baseline for bounded live refresh. */
export function registerHarnessSessionProjection(value: unknown): RootSessionProjection {
  const projected = session(detach(value));
  const current = sessionCursors.get(projected.sessionId);
  const retired = retiredGenerations.get(projected.sessionId);
  if (retired?.has(projected.cursor.runtimeGeneration)) fail();
  if (current && !sameCursor(current, projected.cursor)) {
    if (current.runtimeGeneration === projected.cursor.runtimeGeneration) {
      if (projected.cursor.sequence < current.sequence) fail();
    } else {
      const generations = retired ?? new Set<string>();
      generations.add(current.runtimeGeneration);
      retiredGenerations.set(projected.sessionId, generations);
    }
  }
  return installSessionProjection(projected);
}

function advanceHarnessSessionProjection(
  projected: RootSessionProjection,
  expectedCursor: HarnessCursor,
): RootSessionProjection {
  const current = sessionCursors.get(projected.sessionId);
  if (!current) {
    if (
      projected.cursor.runtimeGeneration !== expectedCursor.runtimeGeneration
      || projected.cursor.sequence !== expectedCursor.sequence + 1
    ) return fail();
    return installSessionProjection(projected);
  }
  if (!sameCursor(current, expectedCursor)) {
    if (current && sameCursor(current, projected.cursor)) return deepFreeze(projected);
    return fail();
  }
  if (
    projected.cursor.runtimeGeneration !== expectedCursor.runtimeGeneration
    || projected.cursor.sequence !== expectedCursor.sequence + 1
  ) return fail();
  return installSessionProjection(projected);
}

function acceptSessionCursor(event: HarnessProjectionEvent): boolean {
  const { sessionId, cursor: next } = event.session;
  const retired = retiredGenerations.get(sessionId);
  if (retired?.has(next.runtimeGeneration)) return false;
  const current = sessionCursors.get(sessionId);
  if (!current) return false;
  if (current.runtimeGeneration === next.runtimeGeneration) {
    if (next.sequence !== current.sequence + 1) return false;
  } else {
    const generations = retired ?? new Set<string>();
    generations.add(current.runtimeGeneration);
    retiredGenerations.set(sessionId, generations);
  }
  const nextChildren = new Set(event.session.children.map((child) => child.id));
  for (const child of nextChildren) {
    const owner = childOwners.get(child);
    if (owner && owner !== sessionId) return false;
  }
  for (const child of sessionChildren.get(sessionId) ?? []) {
    if (!nextChildren.has(child) && childOwners.get(child) === sessionId) childOwners.delete(child);
  }
  for (const child of nextChildren) childOwners.set(child, sessionId);
  sessionChildren.set(sessionId, nextChildren);
  sessionCursors.set(sessionId, next);
  return true;
}

async function ensureListener(): Promise<void> {
  if (unlisten) return;
  unlisten = listen<unknown>("prime://harness-projection", ({ payload }) => {
    if (eventStreamClosed) return;
    let event: HarnessProjectionEvent;
    try {
      event = decodeHarnessProjectionEvent(payload);
    } catch {
      eventStreamClosed = true;
      return;
    }
    if (event.sequence !== lastSequence + 1 || !acceptSessionCursor(event)) {
      eventStreamClosed = true;
      return;
    }
    lastSequence = event.sequence;
    for (const listener of listeners) listener(event);
  });
  await unlisten;
  refreshTimer ??= setInterval(() => { void refreshHarnessSubscriptionsNow(); }, 1_000);
}

/** Run one bounded refresh pass. Exported so resident registration and race behavior are testable. */
export async function refreshHarnessSubscriptionsNow(): Promise<void> {
  if (refreshRunning || eventStreamClosed || listeners.size === 0) return;
  refreshRunning = true;
  try {
    for (const [sessionId, knownCursor] of [...sessionCursors]) {
      if (eventStreamClosed || listeners.size === 0) break;
      try {
        const projected = await refreshHarnessSession(sessionId, knownCursor);
        const current = sessionCursors.get(sessionId);
        // A command or event won the race. Its newer authoritative cursor must not
        // be rolled back or turn an otherwise healthy stream into a terminal error.
        if (!current || !sameCursor(current, knownCursor)) continue;
        const event: HarnessProjectionEvent = { schemaVersion: 1, sequence: lastSequence + 1, type: "session_projection", session: projected };
        if (!acceptSessionCursor(event)) { eventStreamClosed = true; break; }
        lastSequence = event.sequence;
        for (const listener of listeners) listener(deepFreeze(event));
      } catch { /* Retain the last truthful projection and retry on the next bounded interval. */ }
    }
  } finally {
    refreshRunning = false;
  }
}

export function subscribeHarnessEvents(listener: Listener): () => void {
  listeners.add(listener);
  void ensureListener().catch(() => {
    eventStreamClosed = true;
    unlisten = null;
  });
  return () => {
    listeners.delete(listener);
  };
}

/** @deprecated Legacy session RPC remains isolated until verified Harness activation. */
export const legacyHarnessBridgeIsUnavailable = true as const;
