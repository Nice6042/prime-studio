import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { decideCompatibility } from "./compatibility.js";
import type { FakeRootSessionSnapshot, ParentHistoryPage, ParentMessage, ScenarioRequest, ScenarioResponse, TurnPerformanceProjection, WorkerRecoveryProjection } from "./fakeDaemonScenario.js";
import { discoverRuntime, type RuntimeIdentity } from "./runtimeDiscovery.js";
import { loadReviewedPrimeAdapter } from "./reviewedPrimeAdapter.js";
import { parseStudioHarnessOperation, StudioHarnessOperationDispatcher, type StudioHarnessOperationOutcome } from "./studioHarnessOperations.js";
import { sanitizeActivityCommand, sanitizeDiagnostic } from "./redaction.js";
import type { RuntimeClosureLock } from "./runtimeClosure.js";
import { lockVerifiedRuntimeClosure } from "./runtimeClosure.js";

interface DaemonHelloLike {
  readonly type: "daemon_hello";
  readonly socketPath: string;
  readonly protocol: Readonly<{ name: string; version: number }>;
  readonly schemaRevision?: number;
  readonly schemaId?: string;
  readonly appVersion?: string;
  readonly supervisorGeneration?: string;
  readonly clientId: string;
  readonly serverCapabilities: readonly string[];
  readonly runtime?: Readonly<{ buildId?: string; executablePath?: string; entrypointPath?: string; launcherPath?: string }>;
}

export interface DaemonClientPort {
  readonly hello?: DaemonHelloLike;
  connect(timeoutMs?: number): Promise<void>;
  waitForHello(timeoutMs?: number): Promise<DaemonHelloLike>;
  request(command: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export type DaemonConnectionPort = Readonly<Record<string, unknown>> & {
  getInitialSnapshot(): Promise<unknown>;
  getState(): Promise<unknown>;
  getMessages(): Promise<unknown[]>;
  getQueue(): Promise<unknown>;
  getResourceSnapshot(): Promise<unknown>;
  getSessionStats(): Promise<unknown>;
  getToolDefinition(name: string): Promise<unknown>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  importFromJsonl?(inputPath: string, cwdOverride?: string): Promise<unknown>;
  fork?(entryId: string, options?: { position?: "before" | "at" }): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
  respondToExtensionUiRequest?(requestId: string, response: Readonly<{ value: string } | { confirmed: boolean } | { cancelled: true }>): Promise<void>;
};

export interface PrimeDaemonBridgePorts {
  readonly identity: RuntimeIdentity;
  readonly client: DaemonClientPort;
  readonly attach: (client: DaemonClientPort, activeSessionId: string) => Promise<DaemonConnectionPort>;
  readonly expectedSocketPath?: string;
  readonly expectedDaemonEntrypoint?: string;
  readonly runtimeClosure?: RuntimeClosureLock;
  readonly monotonicNow?: () => number;
}

export interface PrimeHarnessInspectorDetails {
  readonly binding: Readonly<{
    parentSessionId: string;
    cursor: Readonly<{ runtimeGeneration: string; sequence: number }>;
  }>;
  readonly observedAtMs: number;
  readonly startedAtMs: number | null;
  readonly context: Readonly<{ usedTokens: number; capacityTokens: number; turns?: number; samples?: readonly number[] }> | null;
  readonly turnUsage?: Readonly<{
    totalTurns: number;
    omittedTurns: number;
    rows: readonly Readonly<{
      turn: number; occurredAtMs: number; input: number; output: number;
      cacheRead: number; cacheWrite: number; totalTokens: number;
    }>[];
  }>;
  readonly contributions: readonly Readonly<{ id: string; label: string; tokens: number }>[];
  readonly notices: readonly Readonly<{ id: string; kind: "info" | "warning" | "error"; title: string; detail: string; retryable: boolean; dismissible: boolean }>[];
  readonly activity: readonly Readonly<{
    id: string; occurredAtMs: number; group: string; kind: "agent" | "tool" | "file" | "system"; title: string; detail: string; childId?: string; filePath?: string;
    tool?: Readonly<{ command: string; redacted: boolean; status: "pending" | "running" | "blocked" | "succeeded" | "failed"; durationMs: number | null; files: readonly string[] }>;
  }>[];
  /** candidatePath is broker-private input and is stripped before details reach the renderer. */
  readonly outputs: readonly Readonly<{ id: string; label: string; candidatePath: string; kind: string }>[];
  readonly sources: readonly Readonly<{ id: string; label: string; detail: string; kind: string; candidatePath?: string }>[];
  readonly children: Readonly<Record<string, Readonly<{
    binding: Readonly<{ parentSessionId: string; childId: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> }>;
    status: "queued" | "running" | "done" | "error" | "cancelled" | null;
    elapsedMs: number | null;
    provider: string | null;
    model: string | null;
    task: string | null;
    summary: string | null;
    context: Readonly<{ usedTokens: number | null; capacityTokens: number | null }> | null;
    tokenUsage: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }> | null;
    transcript: readonly Readonly<{ id: string; actor: string; occurredAtMs: number; text: string }>[];
    activity: readonly Readonly<{ id: string; occurredAtMs: number; label: string }>[];
    files: readonly Readonly<{ id: string; path: string; change: "added" | "modified" | "deleted" | "read" }>[];
    error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
  }>>>;
  readonly composer: Readonly<{
    models: readonly Readonly<{ id: string; label: string; shortLabel: string; enabled: true }>[];
    selectedModel: string | null;
    thinkingLevels: readonly ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];
    selectedThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    supportedCommands: readonly ("model" | "effort" | "compact" | "fork" | "export")[];
  }>;
  readonly extensionUi:
    | Readonly<{ status: "unavailable"; reason: string }>
    | Readonly<{ status: "available"; requests: readonly PrimeHarnessExtensionRequest[] }>;
}

export type PrimeHarnessExtensionRequest =
  | Readonly<{ id: string; method: "confirm"; title: string; message: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> }>
  | Readonly<{ id: string; method: "select"; title: string; options: readonly string[]; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> }>
  | Readonly<{ id: string; method: "input"; title: string; placeholder: string | null; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> }>
  | Readonly<{ id: string; method: "editor"; title: string; prefill: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> }>;

type PendingExtensionRequest =
  | { readonly id: string; readonly method: "confirm"; readonly title: string; readonly message: string; readonly fingerprint: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> | null }
  | { readonly id: string; readonly method: "select"; readonly title: string; readonly options: readonly string[]; readonly fingerprint: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> | null }
  | { readonly id: string; readonly method: "input"; readonly title: string; readonly placeholder: string | null; readonly fingerprint: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> | null }
  | { readonly id: string; readonly method: "editor"; readonly title: string; readonly prefill: string; readonly fingerprint: string; cursor: Readonly<{ runtimeGeneration: string; sequence: number }> | null };

export type PrimeHarnessChildPage =
  | Readonly<{ status: "unavailable"; tab: "chat" | "activity" | "files"; reason: string }>
  | Readonly<{
      status: "available"; tab: "chat";
      items: readonly Readonly<{ id: string; actor: string; occurredAtMs: number; text: string }>[];
      previousCursor: string | null; omittedItems: number;
    }>
  | Readonly<{
      status: "available"; tab: "activity";
      items: readonly Readonly<{ id: string; occurredAtMs: number; label: string }>[];
      previousCursor: string | null; omittedItems: number;
    }>
  | Readonly<{
      status: "available"; tab: "files";
      items: readonly Readonly<{ id: string; path: string; change: "added" | "modified" | "deleted" | "read" }>[];
      previousCursor: string | null; omittedItems: number;
    }>;

interface ChildPageCursorBinding {
  readonly rootSessionId: string;
  readonly childId: string;
  readonly tab: "chat" | "activity" | "files";
  readonly runtimeGeneration: string;
  readonly sequence: number;
  readonly upstreamGeneration: string;
  readonly upstreamSequence: number;
  readonly childSessionId: string;
  readonly snapshotDigest: string;
  readonly windowEnd: number;
}

interface BoundConnection {
  connection: DaemonConnectionPort;
  sequence: number;
  initialized: boolean;
  publishedUpstreamSequence: number | null;
  publishedUpstreamGeneration: string | null;
  studioGeneration: string | null;
  eventRevision: bigint;
  dirty: boolean;
  lastSnapshot: FakeRootSessionSnapshot | null;
  performance: TurnPerformanceState;
  unsubscribe?: () => void;
  readonly extensionRequests: Map<string, PendingExtensionRequest>;
  readonly consumedExtensionRequestIds: Set<string>;
  extensionUiUnavailableReason: string | null;
}

type TurnPerformanceReason = Extract<TurnPerformanceProjection, { status: "unavailable" }>["reason"];
interface TurnPerformanceSegment { role: "assistant" | "user" | "toolResult"; firstOutputAtMs: number | null }
interface TurnPerformanceTurn {
  startedAtMs: number;
  firstOutputAtMs: number | null;
  generationDurationMs: number;
  outputTokens: number;
  invalid: boolean;
  cycleOpen: boolean;
  activeSegment: TurnPerformanceSegment | null;
  segmentCount: number;
}
interface TurnPerformanceEvidence {
  generation: string;
  firstTokenLatencyMs: number;
  outputTokens: number;
  generationDurationMs: number;
  tokensPerSecond: number;
}
interface TurnPerformanceState {
  reason: TurnPerformanceReason;
  turn: TurnPerformanceTurn | null;
  evidence: TurnPerformanceEvidence | null;
  lastObservedAtMs: number | null;
}

interface WorkerRecoveryObservation {
  readonly projection: WorkerRecoveryProjection;
}

interface ParentHistoryCursorRecord {
  readonly sessionId: string;
  readonly runtimeGeneration: string;
  readonly snapshotSequence: number;
  readonly sourceDigest: string;
  readonly beforeExclusive: number;
}

interface DaemonSnapshotBarrier {
  readonly connection: DaemonConnectionPort;
  readonly source: Record<string, unknown>;
  readonly eventRevision: bigint;
  close(): Promise<void>;
}

class DaemonGenerationChangedError extends Error {}

const REQUIRED_SERVER_CAPABILITIES = Object.freeze([
  "attach_snapshot", "event_sequence", "session_input_admission", "model_catalog",
]);
const KNOWN_SERVER_CAPABILITIES = new Set([
  "attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot",
  "client_owned_sessions", "delete_rlm_subagent", "heartbeat_catalog", "heartbeat_management",
  "model_catalog", "side_question_transcript", "transient_bash", "session_input_admission",
  "prompt_admission_cancellation",
]);

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value: unknown, maximum = 131_072, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || [...value].length > maximum) throw new TypeError("daemon value is invalid");
  return value;
}
function safeInteger(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("daemon integer is invalid");
  return value as number;
}
function optionalSafeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return safeInteger(value);
}

function evidenceInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function childModelFacts(rawModel: unknown, catalog: unknown): Readonly<{ provider: string | null; model: string | null; capacityTokens: number | null }> {
  if (typeof rawModel !== "string" || rawModel.length === 0 || [...rawModel].length > 200) {
    return Object.freeze({ provider: null, model: null, capacityTokens: null });
  }
  const separator = rawModel.indexOf("/");
  const provider = separator > 0 ? rawModel.slice(0, separator) : null;
  const model = separator > 0 ? rawModel.slice(separator + 1) : rawModel;
  const candidates = plain(catalog) && Array.isArray(catalog.models)
    ? catalog.models.filter((candidate) => plain(candidate) && typeof candidate.provider === "string" && typeof candidate.id === "string" && `${candidate.provider}/${candidate.id}` === rawModel)
    : [];
  const capacityTokens = candidates.length === 1 && plain(candidates[0]) ? evidenceInteger(candidates[0].contextWindow) : null;
  return Object.freeze({ provider, model, capacityTokens: capacityTokens && capacityTokens > 0 ? capacityTokens : null });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeExtensionRequest(event: unknown): PendingExtensionRequest | null {
  if (!plain(event) || event.type !== "extension_ui_request" || !plain(event.request)) return null;
  const request = event.request;
  if (!exactKeys(request, ["id", "method", "payload"]) || !plain(request.payload)) throw new TypeError("extension UI request envelope is invalid");
  const id = boundedString(request.id, 128);
  const method = boundedString(request.method, 32);
  const payload = request.payload;
  const withoutTimeout = Object.hasOwn(payload, "timeout") ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "timeout")) : payload;
  if (Object.hasOwn(payload, "timeout") && (!Number.isSafeInteger(payload.timeout) || (payload.timeout as number) < 0)) throw new TypeError("extension UI timeout is invalid");
  let projected: Record<string, unknown> & { id: string; method: "confirm" | "select" | "input" | "editor"; title: string };
  if (method === "confirm" && exactKeys(withoutTimeout, ["title", "message"])) {
    projected = { id, method, title: boundedString(withoutTimeout.title, 200), message: boundedString(withoutTimeout.message, 8_192, true) };
  } else if (method === "select" && exactKeys(withoutTimeout, ["title", "options"]) && Array.isArray(withoutTimeout.options)) {
    if (withoutTimeout.options.length === 0 || withoutTimeout.options.length > 64) throw new TypeError("extension UI select options are invalid");
    const options = withoutTimeout.options.map((option) => boundedString(option, 200));
    if (new Set(options).size !== options.length) throw new TypeError("extension UI select options are invalid");
    projected = { id, method, title: boundedString(withoutTimeout.title, 200), options: Object.freeze(options) };
  } else if (method === "input" && (exactKeys(withoutTimeout, ["title"]) || exactKeys(withoutTimeout, ["title", "placeholder"]))) {
    projected = { id, method, title: boundedString(withoutTimeout.title, 200), placeholder: withoutTimeout.placeholder === undefined ? null : boundedString(withoutTimeout.placeholder, 500, true) };
  } else if (method === "editor" && (exactKeys(withoutTimeout, ["title"]) || exactKeys(withoutTimeout, ["title", "prefill"]))) {
    projected = { id, method, title: boundedString(withoutTimeout.title, 200), prefill: withoutTimeout.prefill === undefined ? "" : boundedString(withoutTimeout.prefill, 32_768, true) };
  } else if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method)) {
    return null;
  } else {
    throw new TypeError("extension UI request method or payload is unsupported");
  }
  const fingerprint = JSON.stringify(projected);
  return { ...projected, fingerprint, cursor: null } as PendingExtensionRequest;
}

function projectPendingExtensionRequest(request: PendingExtensionRequest): PrimeHarnessExtensionRequest | null {
  if (!request.cursor) return null;
  const { fingerprint: _fingerprint, cursor, ...fields } = request;
  return Object.freeze({ ...fields, cursor }) as PrimeHarnessExtensionRequest;
}

const MAX_PERFORMANCE_DURATION_MS = 86_400_000;
const MAX_TOKENS_PER_SECOND = 1_000_000;
const MAX_PERFORMANCE_SEGMENTS = 256;
const PASSIVE_SESSION_EVENTS = new Set([
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "ipython_sent_agent_message", "session_action_update", "compaction_start", "session_info_changed",
  "thinking_level_changed", "service_tier_changed", "compaction_end", "auto_retry_start", "auto_retry_end",
  "auth_stale", "rlm_child_update", "recap_update", "goal_update", "bash_start", "bash_output", "bash_end",
  "refine_complete", "refine_failed",
]);
const ASSISTANT_MESSAGE_EVENT_TYPES = new Set([
  "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
]);

function initialTurnPerformance(reason: TurnPerformanceReason = "event_chronology_unavailable"): TurnPerformanceState {
  return { reason, turn: null, evidence: null, lastObservedAtMs: null };
}

function eventIsChild(event: Record<string, unknown>, message?: Record<string, unknown>): boolean {
  return event.channel === "child" || message?.channel === "child" || event.parentSessionId !== undefined || message?.parentSessionId !== undefined;
}

function validAssistantContent(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.content) || message.content.length > 1_024) return false;
  return message.content.every((raw) => plain(raw) && (
    (raw.type === "text" && typeof raw.text === "string")
    || (raw.type === "thinking" && typeof raw.thinking === "string")
    || (raw.type === "toolCall" && typeof raw.id === "string" && typeof raw.name === "string" && plain(raw.arguments))
  ));
}

function messageHasOutput(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content) && message.content.some((raw) => plain(raw) && (
    (raw.type === "text" && typeof raw.text === "string" && raw.text.length > 0)
    || (raw.type === "thinking" && typeof raw.thinking === "string" && raw.thinking.length > 0)
    || (raw.type === "toolCall" && typeof raw.name === "string" && raw.name.length > 0)
  ));
}

function validAssistantUpdate(raw: Record<string, unknown>): boolean {
  const event = plain(raw.assistantMessageEvent) ? raw.assistantMessageEvent : null;
  if (!event || typeof event.type !== "string" || !ASSISTANT_MESSAGE_EVENT_TYPES.has(event.type)
    || !Number.isSafeInteger(event.contentIndex) || (event.contentIndex as number) < 0 || !plain(event.partial)
    || event.partial.role !== "assistant" || !validAssistantContent(event.partial)) return false;
  if (event.type.endsWith("_delta") && typeof event.delta !== "string") return false;
  if ((event.type === "text_end" || event.type === "thinking_end") && typeof event.content !== "string") return false;
  if (event.type === "toolcall_end" && (!plain(event.toolCall) || event.toolCall.type !== "toolCall")) return false;
  return true;
}

function invalidateTurnPerformance(state: TurnPerformanceState): void {
  state.reason = "event_chronology_invalid";
  state.evidence = null;
  if (state.turn) state.turn.invalid = true;
}

function cloneTurnPerformance(state: TurnPerformanceState): TurnPerformanceState {
  return {
    reason: state.reason,
    lastObservedAtMs: state.lastObservedAtMs,
    evidence: state.evidence ? { ...state.evidence } : null,
    turn: state.turn ? {
      ...state.turn,
      activeSegment: state.turn.activeSegment ? { ...state.turn.activeSegment } : null,
    } : null,
  };
}

function observeTurnPerformance(state: TurnPerformanceState, envelope: unknown, observedAtMs: number, generation: string | null): void {
  // DaemonConnectionPort subscribers receive the adapter's admitted event
  // envelope, not its nested wire event. Ignore other adapter notifications;
  // only a malformed session_event can invalidate the active chronology.
  if (!plain(envelope) || typeof envelope.type !== "string") return;
  if (["session_resynced", "session_replaced", "closed"].includes(envelope.type)
    || (envelope.type === "connection_status" && envelope.status === "reconnecting")) {
    Object.assign(state, initialTurnPerformance("generation_changed"));
    return;
  }
  if (envelope.type !== "session_event") return;
  if (!plain(envelope.event) || typeof envelope.event.type !== "string") {
    invalidateTurnPerformance(state);
    return;
  }
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0 || observedAtMs > Number.MAX_SAFE_INTEGER) {
    invalidateTurnPerformance(state);
    return;
  }
  if (state.lastObservedAtMs !== null && observedAtMs < state.lastObservedAtMs) {
    invalidateTurnPerformance(state);
    return;
  }
  const rawEvent = envelope.event;
  const eventType = rawEvent.type as string;
  const message = plain(rawEvent.message) ? rawEvent.message : undefined;
  if (eventIsChild(rawEvent, message)) {
    invalidateTurnPerformance(state);
    return;
  }
  state.lastObservedAtMs = observedAtMs;
  if (rawEvent.type === "agent_start") {
    if (state.turn) {
      invalidateTurnPerformance(state);
      return;
    }
    state.turn = { startedAtMs: observedAtMs, firstOutputAtMs: null, generationDurationMs: 0, outputTokens: 0, invalid: generation === null, cycleOpen: false, activeSegment: null, segmentCount: 0 };
    state.evidence = null;
    state.reason = generation === null ? "event_chronology_invalid" : "event_chronology_incomplete";
    return;
  }
  const turn = state.turn;
  if (!turn) {
    if (["message_start", "message_update", "message_end", "agent_end"].includes(eventType)) invalidateTurnPerformance(state);
    else if (!PASSIVE_SESSION_EVENTS.has(eventType)) invalidateTurnPerformance(state);
    return;
  }
  if (rawEvent.type === "turn_start") {
    if (turn.cycleOpen || turn.activeSegment) invalidateTurnPerformance(state);
    else turn.cycleOpen = true;
    return;
  }
  if (rawEvent.type === "turn_end") {
    if (!turn.cycleOpen || turn.activeSegment || !plain(rawEvent.message) || rawEvent.message.role !== "assistant" || !validAssistantContent(rawEvent.message)
      || !Array.isArray(rawEvent.toolResults) || rawEvent.toolResults.length > MAX_PERFORMANCE_SEGMENTS
      || !rawEvent.toolResults.every((item) => plain(item) && item.role === "toolResult" && Array.isArray(item.content))) {
      invalidateTurnPerformance(state);
    } else turn.cycleOpen = false;
    return;
  }
  if (rawEvent.type === "message_start" || rawEvent.type === "message_update" || rawEvent.type === "message_end") {
    if (!turn.cycleOpen || !message || !["assistant", "user", "toolResult"].includes(String(message.role))
      || (message.role === "assistant" && !validAssistantContent(message))) {
      invalidateTurnPerformance(state);
      return;
    }
    if (rawEvent.type === "message_start") {
      if (turn.activeSegment || turn.segmentCount >= MAX_PERFORMANCE_SEGMENTS) {
        invalidateTurnPerformance(state);
        return;
      }
      turn.activeSegment = { role: message.role as "assistant" | "user" | "toolResult", firstOutputAtMs: null };
      turn.segmentCount += 1;
    } else if (!turn.activeSegment) {
      invalidateTurnPerformance(state);
      return;
    }
    const segment = turn.activeSegment!;
    if (segment.role !== message.role || (rawEvent.type === "message_update" && segment.role !== "assistant")) {
      invalidateTurnPerformance(state);
      return;
    }
    if (rawEvent.type === "message_update") {
      if (!validAssistantUpdate(rawEvent)) {
        invalidateTurnPerformance(state);
        return;
      }
    }
    const assistantEventType = plain(rawEvent.assistantMessageEvent) && typeof rawEvent.assistantMessageEvent.type === "string"
      ? rawEvent.assistantMessageEvent.type : null;
    const streamedToolCall = assistantEventType === "toolcall_start" || assistantEventType === "toolcall_delta" || assistantEventType === "toolcall_end";
    if (segment.role === "assistant" && (messageHasOutput(message) || streamedToolCall) && segment.firstOutputAtMs === null) {
      segment.firstOutputAtMs = observedAtMs;
      turn.firstOutputAtMs ??= observedAtMs;
    }
    if (rawEvent.type === "message_end") {
      if (segment.role !== "assistant") {
        turn.activeSegment = null;
        return;
      }
      if (!plain(message.usage) || !Number.isSafeInteger(message.usage.output) || (message.usage.output as number) < 0 || segment.firstOutputAtMs === null) {
        invalidateTurnPerformance(state);
        return;
      }
      const duration = observedAtMs - segment.firstOutputAtMs;
      if (duration <= 0 || duration > MAX_PERFORMANCE_DURATION_MS) {
        invalidateTurnPerformance(state);
        return;
      }
      const output = message.usage.output as number;
      const nextOutput = turn.outputTokens + output;
      const nextDuration = turn.generationDurationMs + duration;
      if (!Number.isSafeInteger(nextOutput) || nextDuration > MAX_PERFORMANCE_DURATION_MS) {
        invalidateTurnPerformance(state);
        return;
      }
      turn.outputTokens = nextOutput;
      turn.generationDurationMs = nextDuration;
      turn.activeSegment = null;
    }
    return;
  }
  if (rawEvent.type !== "agent_end") {
    if (!PASSIVE_SESSION_EVENTS.has(eventType)) invalidateTurnPerformance(state);
    return;
  }
  if (turn.invalid || turn.cycleOpen || turn.activeSegment || generation === null || turn.firstOutputAtMs === null || turn.outputTokens <= 0 || turn.generationDurationMs <= 0) {
    state.reason = turn.invalid ? "event_chronology_invalid" : "event_chronology_incomplete";
    state.evidence = null;
    state.turn = null;
    return;
  }
  const firstTokenLatencyMs = turn.firstOutputAtMs - turn.startedAtMs;
  const tokensPerSecond = turn.outputTokens * 1_000 / turn.generationDurationMs;
  if (firstTokenLatencyMs < 0 || firstTokenLatencyMs > MAX_PERFORMANCE_DURATION_MS || !Number.isFinite(tokensPerSecond) || tokensPerSecond < 0 || tokensPerSecond > MAX_TOKENS_PER_SECOND) {
    state.reason = "event_chronology_invalid";
    state.evidence = null;
  } else {
    state.evidence = { generation, firstTokenLatencyMs, outputTokens: turn.outputTokens, generationDurationMs: turn.generationDurationMs, tokensPerSecond };
  }
  state.turn = null;
}

function bindTurnPerformance(state: TurnPerformanceState, sessionId: string, cursor: Readonly<{ runtimeGeneration: string; sequence: number }>, generationChanged: boolean): TurnPerformanceProjection {
  if (generationChanged) Object.assign(state, initialTurnPerformance("generation_changed"));
  const evidence = state.evidence;
  if (!evidence || evidence.generation !== cursor.runtimeGeneration) {
    const reason = evidence ? "generation_changed" : state.reason;
    return Object.freeze({ status: "unavailable", sessionId, cursor: Object.freeze({ ...cursor }), reason });
  }
  return Object.freeze({ status: "available", sessionId, cursor: Object.freeze({ ...cursor }), firstTokenLatencyMs: evidence.firstTokenLatencyMs, outputTokens: evidence.outputTokens, generationDurationMs: evidence.generationDurationMs, tokensPerSecond: evidence.tokensPerSecond });
}

const MAX_TURN_USAGE_ROWS = 300;
const MAX_CONSUMED_EXTENSION_REQUEST_IDS = 4_096;

export function addConsumedExtensionRequestIds(ledger: Set<string>, requestIds: Iterable<string>): boolean {
  for (const requestId of requestIds) {
    if (ledger.has(requestId)) continue;
    if (ledger.size >= MAX_CONSUMED_EXTENSION_REQUEST_IDS) return false;
    ledger.add(requestId);
  }
  return true;
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new TypeError("daemon token usage is invalid");
  return total;
}

function projectTurnUsage(
  messages: readonly unknown[],
  statsTokens: Record<string, unknown>,
): PrimeHarnessInspectorDetails["turnUsage"] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const rows: Array<NonNullable<PrimeHarnessInspectorDetails["turnUsage"]>["rows"][number]> = [];
  let previousOccurredAtMs = 0;
  for (const raw of messages) {
    if (!plain(raw) || raw.role !== "assistant") continue;
    const rawUsage = raw.usage;
    if (!plain(rawUsage)) throw new TypeError("daemon assistant usage is invalid");
    const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
    if (!usageFields.every((field) => Object.hasOwn(rawUsage, field)) || !Object.hasOwn(raw, "timestamp")) {
      throw new TypeError("daemon assistant usage is incomplete");
    }
    const input = safeInteger(rawUsage.input);
    const output = safeInteger(rawUsage.output);
    const cacheRead = safeInteger(rawUsage.cacheRead);
    const cacheWrite = safeInteger(rawUsage.cacheWrite);
    const categoryTotal = checkedAdd(checkedAdd(input, output), checkedAdd(cacheRead, cacheWrite));
    const totalTokens = safeInteger(rawUsage.totalTokens);
    if (totalTokens !== categoryTotal) throw new TypeError("daemon assistant usage total is invalid");
    const occurredAtMs = safeInteger(raw.timestamp);
    if (occurredAtMs < previousOccurredAtMs) return undefined;
    previousOccurredAtMs = occurredAtMs;
    totals.input = checkedAdd(totals.input, input);
    totals.output = checkedAdd(totals.output, output);
    totals.cacheRead = checkedAdd(totals.cacheRead, cacheRead);
    totals.cacheWrite = checkedAdd(totals.cacheWrite, cacheWrite);
    rows.push(Object.freeze({
      turn: rows.length + 1, occurredAtMs, input, output, cacheRead, cacheWrite, totalTokens,
    }));
  }
  const reported = {
    input: safeInteger(statsTokens.input), output: safeInteger(statsTokens.output),
    cacheRead: safeInteger(statsTokens.cacheRead), cacheWrite: safeInteger(statsTokens.cacheWrite),
  };
  if (Object.keys(reported).some((key) => totals[key as keyof typeof totals] !== reported[key as keyof typeof reported])) return undefined;
  const reportedTotal = checkedAdd(checkedAdd(reported.input, reported.output), checkedAdd(reported.cacheRead, reported.cacheWrite));
  if (statsTokens.total !== undefined && safeInteger(statsTokens.total) !== reportedTotal) return undefined;
  const retained = rows.slice(-MAX_TURN_USAGE_ROWS);
  return Object.freeze({
    totalTurns: rows.length,
    omittedTurns: rows.length - retained.length,
    rows: Object.freeze(retained),
  });
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
type ProjectedThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function composerProjection(
  connection: DaemonConnectionPort,
  initial: Record<string, unknown>,
  catalogRaw: unknown,
): PrimeHarnessInspectorDetails["composer"] {
  const state = plain(initial.state) ? initial.state : {};
  const catalog = plain(catalogRaw) && Array.isArray(catalogRaw.models) ? catalogRaw.models : [];
  const seen = new Set<string>();
  const models = catalog.slice(0, 512).flatMap((raw) => {
    if (!plain(raw) || typeof raw.id !== "string" || typeof raw.provider !== "string") return [];
    const provider = boundedString(raw.provider, 128);
    const modelId = boundedString(raw.id, 96);
    const id = `${provider}/${modelId}`;
    if (id.length > 128 || !/^[\w./:@+-]+$/u.test(id) || seen.has(id)) return [];
    seen.add(id);
    const label = typeof raw.name === "string" ? boundedString(raw.name, 200) : modelId;
    return [{ id, label, shortLabel: label, enabled: true as const }];
  });
  const current = plain(state.model) ? state.model : {};
  const selectedModel = typeof current.provider === "string" && typeof current.id === "string"
    ? `${boundedString(current.provider, 128)}/${boundedString(current.id, 200)}`
    : null;
  const levels = Array.isArray(state.availableThinkingLevels)
    ? state.availableThinkingLevels.slice(0, 32).filter((value): value is ProjectedThinkingLevel => typeof value === "string" && THINKING_LEVELS.has(value as ProjectedThinkingLevel))
    : [];
  const thinkingLevels = [...new Set(levels)];
  const selectedThinking = typeof state.thinkingLevel === "string" && THINKING_LEVELS.has(state.thinkingLevel as ProjectedThinkingLevel)
    ? state.thinkingLevel as ProjectedThinkingLevel
    : null;
  const supportedCommands: Array<"model" | "effort" | "compact" | "fork" | "export"> = [];
  if (models.length > 0 && typeof connection.setModel === "function") supportedCommands.push("model");
  if (thinkingLevels.length > 0 && typeof connection.setThinkingLevel === "function") supportedCommands.push("effort");
  if (typeof connection.compact === "function") supportedCommands.push("compact");
  if (typeof connection.fork === "function") supportedCommands.push("fork");
  if (typeof connection.exportToHtml === "function") supportedCommands.push("export");
  return Object.freeze({
    models: Object.freeze(models), selectedModel,
    thinkingLevels: Object.freeze(thinkingLevels), selectedThinking,
    supportedCommands: Object.freeze(supportedCommands),
  });
}
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function responseData(value: unknown, command: string): unknown {
  if (!plain(value) || value.type !== "response" || value.command !== command || value.success !== true) {
    throw new Error(`daemon ${command} request failed`);
  }
  return value.data;
}
function sessionCatalogRows(data: unknown): unknown[] {
  const rows = Array.isArray(data) ? data : plain(data) && Array.isArray(data.sessions) ? data.sessions : null;
  if (!rows || rows.length > 256) throw new Error("daemon session catalog is invalid");
  return rows;
}
function contentText(value: unknown): string {
  if (typeof value === "string") return boundedString(value, 131_072, true);
  if (!Array.isArray(value)) return "";
  return boundedString(value.map((block) => plain(block) && block.type === "text" && typeof block.text === "string" ? block.text : "").join(""), 131_072, true);
}
function childPageText(value: unknown): string {
  return [...contentText(value)].slice(0, 1_024).join("");
}
function messageId(message: unknown, index: number): string {
  if (plain(message) && typeof message.id === "string" && /^[!-~]{1,128}$/u.test(message.id)) return message.id;
  return stableId("message", `${index}:${JSON.stringify(message).slice(0, 16_384)}`);
}
function sessionTreeMessageIds(value: unknown): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  const visit = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!plain(node)) continue;
      const entry = plain(node.entry) ? node.entry : null;
      if (entry?.type === "message" && typeof entry.id === "string" && plain(entry.message)) {
        const signature = JSON.stringify(entry.message).slice(0, 16_384);
        const queue = ids.get(signature) ?? [];
        queue.push(boundedString(entry.id, 128));
        ids.set(signature, queue);
      }
      visit(node.children);
    }
  };
  if (plain(value)) visit(value.tree);
  return ids;
}
function messageBlocks(message: Record<string, unknown>, completedToolCalls: ReadonlySet<string>, streaming: boolean): Extract<ParentMessage, { kind: "assistant" }>["blocks"] {
  const content = message.content;
  if (typeof content === "string") return [{ kind: "text", text: boundedString(content, 131_072, true) }];
  if (!Array.isArray(content)) return [];
  const blocks: Array<Extract<ParentMessage, { kind: "assistant" }>["blocks"][number]> = [];
  for (const raw of content.slice(0, 1024)) {
    if (!plain(raw)) continue;
    if (raw.type === "text" && typeof raw.text === "string") blocks.push({ kind: "text", text: boundedString(raw.text, 131_072, true) });
    else if (raw.type === "thinking" && typeof raw.thinking === "string") {
      blocks.push({ kind: "thinking", text: boundedString(raw.thinking, 131_072, true), redacted: raw.redacted === true });
    } else if (raw.type === "toolCall" && typeof raw.id === "string" && typeof raw.name === "string") {
      blocks.push({
        kind: "tool_call", toolCallId: boundedString(raw.id, 128), toolId: boundedString(raw.name, 128),
        status: completedToolCalls.has(raw.id) ? "succeeded" : streaming ? "running" : "pending",
      });
    }
  }
  return blocks;
}

function projectAtomicParentMessages(
  rawMessages: readonly unknown[],
  streaming: Record<string, unknown> | null,
  sessionTree: unknown,
): ParentMessage[] {
  const parentRows = [...rawMessages, ...(streaming ? [streaming] : [])]
    .filter((raw): raw is Record<string, unknown> => plain(raw) && (raw.channel === undefined || raw.channel === "parent"));
  const completedToolCalls = new Set(parentRows.flatMap((raw) => raw.role === "toolResult" && typeof raw.toolCallId === "string" ? [raw.toolCallId] : []));
  const upstreamMessageIds = sessionTreeMessageIds(sessionTree);
  return parentRows.map((raw, index): ParentMessage => {
    const signature = JSON.stringify(raw).slice(0, 16_384);
    const id = upstreamMessageIds.get(signature)?.shift() ?? messageId(raw, index);
    const emittedAtMs = safeInteger(raw.timestamp);
    if (raw.role === "user") return { channel: "parent", kind: "user", id, text: contentText(raw.content), emittedAtMs };
    if (raw.role === "assistant") return { channel: "parent", kind: "assistant", id, blocks: messageBlocks(raw, completedToolCalls, raw === streaming), streaming: raw === streaming, emittedAtMs };
    return { channel: "parent", kind: "notice", id, text: contentText(raw.content), emittedAtMs };
  });
}

function projectId(cwd: string): string { return stableId("project", cwd.toLocaleLowerCase("en-US")); }
function residentMarker(creationId: string, fingerprint: string, name: string): Readonly<{ prefix: string; marker: string }> {
  const prefix = `prime-studio:${createHash("sha256").update(creationId).digest("hex").slice(0, 24)}:`;
  const fingerprintTag = `${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}:`;
  return Object.freeze({ prefix, marker: prefix + fingerprintTag + [...name].slice(0, 200 - prefix.length - fingerprintTag.length).join("") });
}
function residentBranchMarkers(creationId: string, fingerprint: string): Readonly<{ prefix: string; pending: string; committed: string }> {
  const prefix = `prime-studio-branch:${createHash("sha256").update(creationId).digest("hex").slice(0, 24)}:`;
  const fingerprintTag = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  return Object.freeze({ prefix, pending: `${prefix}${fingerprintTag}:pending`, committed: `${prefix}${fingerprintTag}:committed` });
}
function treeContainsEntry(value: unknown, entryId: string): boolean {
  if (!plain(value)) return false;
  const visit = (nodes: unknown): boolean => Array.isArray(nodes) && nodes.some((node) => plain(node) && (plain(node.entry) && node.entry.id === entryId || visit(node.children)));
  return visit(value.tree);
}
function rootState(state: Record<string, unknown>): FakeRootSessionSnapshot["state"] {
  if (state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true) return "working";
  return "idle";
}

export class PrimeDaemonBridge {
  readonly #identity: RuntimeIdentity;
  readonly #client: DaemonClientPort;
  readonly #attachPort: PrimeDaemonBridgePorts["attach"];
  readonly #expectedSocketPath: string | undefined;
  readonly #expectedDaemonEntrypoint: string | undefined;
  readonly #runtimeClosure: RuntimeClosureLock | undefined;
  readonly #monotonicNow: () => number;
  readonly #connections = new Map<string, BoundConnection>();
  readonly #commands = new Map<string, Readonly<{ fingerprint: string; response: Extract<ScenarioResponse, { type: "command_result" }> }>>();
  readonly #creations = new Map<string, Readonly<{ fingerprint: string; response: Extract<ScenarioResponse, { type: "resident_created" }> }>>();
  readonly #operationDispatchers = new Map<string, StudioHarnessOperationDispatcher>();
  readonly #workerRecovery = new Map<string, WorkerRecoveryObservation>();
  readonly #childPageCursors = new Map<string, ChildPageCursorBinding>();
  #childPageCursorSequence = 0;
  readonly #parentHistoryCursors = new Map<string, ParentHistoryCursorRecord>();
  readonly #parentHistorySecret = randomBytes(32);
  #workerRecoverySequence = 0;
  #hello: DaemonHelloLike | null = null;

  constructor(ports: PrimeDaemonBridgePorts) {
    this.#identity = ports.identity;
    this.#client = ports.client;
    this.#attachPort = ports.attach;
    this.#expectedSocketPath = ports.expectedSocketPath;
    this.#expectedDaemonEntrypoint = ports.expectedDaemonEntrypoint;
    this.#runtimeClosure = ports.runtimeClosure;
    this.#monotonicNow = ports.monotonicNow ?? (() => performance.now());
  }

  get client(): DaemonClientPort { return this.#client; }
  get generation(): string | null { return this.#hello?.supervisorGeneration ?? null; }

  async health(): Promise<Readonly<{ identity: RuntimeIdentity; hello: DaemonHelloLike }>> {
    return Object.freeze({ identity: this.#identity, hello: await this.negotiate() });
  }

  async catalog(): Promise<readonly unknown[]> {
    await this.negotiate();
    return sessionCatalogRows(responseData(await this.#client.request({ type: "list", all: true, includeClientOwned: true }, 10_000), "list"));
  }

  async createResident(options: Readonly<{ name?: string; cwd?: string; creationId?: string }> = {}): Promise<unknown> {
    await this.negotiate();
    const name = options.name === undefined ? undefined : boundedString(options.name, 200);
    const cwd = options.cwd === undefined ? undefined : boundedString(options.cwd, 4096);
    if (options.creationId !== undefined) {
      const creationId = boundedString(options.creationId, 128);
      if (name === undefined || cwd === undefined) throw new TypeError("resident creation requires a name and cwd");
      const fingerprint = JSON.stringify({ name, cwd });
      const prior = this.#creations.get(creationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("resident creation identity was reused with different input");
        return prior.response;
      }
      const { prefix, marker } = residentMarker(creationId, fingerprint, name);
      const rows = sessionCatalogRows(responseData(await this.#client.request({ type: "list", includeClientOwned: true }, 10_000), "list"));
      const matches = rows.filter((row) => plain(row) && row.isSessionActive === true && typeof row.sessionName === "string" && row.sessionName.startsWith(prefix));
      if (matches.length > 1) throw new Error("resident creation recovery is ambiguous");
      let activeSessionId: string;
      if (matches.length === 1) {
        const row = matches[0];
        if (!plain(row) || typeof row.activeSessionId !== "string") throw new Error("resident creation recovery is invalid");
        if (row.sessionName !== marker) throw new Error("resident creation identity was reused with different input");
        activeSessionId = boundedString(row.activeSessionId, 128);
      } else {
        const created = responseData(await this.#client.request({ type: "create", lifecycle: "resident", name: marker, config: { cwd } }, 30_000), "create");
        if (!plain(created) || typeof created.activeSessionId !== "string" || created.sessionName !== marker) throw new Error("daemon resident creation response is invalid");
        activeSessionId = boundedString(created.activeSessionId, 128);
      }
      const snapshot = await this.snapshot(activeSessionId);
      if (snapshot.projectId !== projectId(cwd)) throw new Error("daemon resident creation identity mismatch");
      const response = Object.freeze({ type: "resident_created" as const, creationId, snapshot });
      this.#creations.set(creationId, { fingerprint, response });
      return response;
    }
    const command: Record<string, unknown> = { type: "create", lifecycle: "resident" };
    if (name !== undefined) command.name = name;
    if (cwd !== undefined) command.config = { cwd };
    return responseData(await this.#client.request(command, 30_000), "create");
  }

  async branchResident(options: Readonly<{ creationId: string; sourceSessionId: string; entryId: string; name: string }>): Promise<Extract<ScenarioResponse, { type: "resident_branched" }>> {
    await this.negotiate();
    if (!this.#identity.capabilities.includes("resident_sessions")) throw new Error("resident branch capability is unavailable");
    const creationId = boundedString(options.creationId, 128);
    const sourceSessionId = boundedString(options.sourceSessionId, 128);
    const entryId = boundedString(options.entryId, 128);
    const name = boundedString(options.name, 200);
    const fingerprint = JSON.stringify({ sourceSessionId, entryId, name });
    const markers = residentBranchMarkers(creationId, fingerprint);
    const rows = sessionCatalogRows(responseData(await this.#client.request({ type: "list", includeClientOwned: true }, 10_000), "list"));
    const matches = rows.filter((row) => plain(row) && row.isSessionActive === true && typeof row.sessionName === "string" && row.sessionName.startsWith(markers.prefix));
    if (matches.length > 1) throw new Error("resident branch recovery is ambiguous");
    if (matches.length === 1) {
      const row = matches[0];
      if (!plain(row) || typeof row.activeSessionId !== "string" || typeof row.sessionName !== "string") throw new Error("resident branch recovery is invalid");
      if (row.sessionName === markers.pending) throw new Error("resident branch outcome requires reconciliation");
      if (row.sessionName !== markers.committed) throw new Error("resident branch identity was reused with different input");
      const snapshot = await this.snapshot(boundedString(row.activeSessionId, 128));
      if (snapshot.sessionId === sourceSessionId || !snapshot.parentMessages.some((message) => message.id === entryId)) throw new Error("resident branch recovery identity is invalid");
      return Object.freeze({ type: "resident_branched", creationId, sourceSessionId, entryId, snapshot });
    }

    const source = await this.#bound(sourceSessionId);
    const sourceSnapshot = await source.connection.getInitialSnapshot();
    if (!plain(sourceSnapshot) || !plain(sourceSnapshot.state) || !treeContainsEntry(sourceSnapshot.sessionTree, entryId)) throw new TypeError("resident branch source entry is unavailable");
    const cwd = boundedString(sourceSnapshot.state.cwd, 4096);
    const sourceFile = boundedString(sourceSnapshot.state.sessionFile, 4096);
    const sourceChatId = boundedString(sourceSnapshot.state.sessionId, 128);
    const created = responseData(await this.#client.request({ type: "create", lifecycle: "resident", name: markers.pending, config: { cwd } }, 30_000), "create");
    if (!plain(created) || typeof created.activeSessionId !== "string" || created.sessionName !== markers.pending) throw new Error("resident branch create response is invalid");
    const branchSessionId = boundedString(created.activeSessionId, 128);
    if (branchSessionId === sourceSessionId) throw new Error("resident branch reused the source active session");
    const branch = await this.#bound(branchSessionId);
    if (typeof branch.connection.importFromJsonl !== "function" || typeof branch.connection.fork !== "function") throw new Error("resident branch operations are unavailable");
    const imported = await branch.connection.importFromJsonl(sourceFile, cwd);
    if (!plain(imported) || imported.cancelled !== false) throw new Error("resident branch import was not committed");
    const forked = await branch.connection.fork(entryId, { position: "at" });
    if (!plain(forked) || forked.cancelled !== false) throw new Error("resident branch fork was not committed");
    const snapshot = await this.snapshot(branchSessionId);
    if (snapshot.chatId === sourceChatId || !snapshot.parentMessages.some((message) => message.id === entryId)) throw new Error("resident branch result identity is invalid");
    responseData(await this.#client.request({ type: "rename", activeSessionId: branchSessionId, name: markers.committed }, 10_000), "rename");
    return Object.freeze({ type: "resident_branched", creationId, sourceSessionId, entryId, snapshot });
  }

  async attach(activeSessionId: string): Promise<FakeRootSessionSnapshot> {
    return this.snapshot(activeSessionId);
  }

  async detach(activeSessionId: string): Promise<void> {
    const bound = this.#connections.get(activeSessionId);
    if (!bound) return;
    bound.unsubscribe?.();
    await bound.connection.dispose();
    this.#connections.delete(activeSessionId);
    this.#operationDispatchers.delete(activeSessionId);
  }

  async rename(activeSessionId: string, name: string): Promise<unknown> {
    await this.negotiate();
    return responseData(await this.#client.request({ type: "rename", activeSessionId: boundedString(activeSessionId, 128), name: boundedString(name, 200) }, 10_000), "rename");
  }

  async deleteSavedSession(activeSessionId: string, sessionPath: string): Promise<unknown> {
    return this.#call(activeSessionId, "deleteSavedSession", boundedString(sessionPath, 4096));
  }

  async setModel(activeSessionId: string, provider: string, modelId: string): Promise<unknown> {
    return this.#call(activeSessionId, "setModel", boundedString(provider, 128), boundedString(modelId, 200));
  }

  async setThinking(activeSessionId: string, level: string): Promise<unknown> {
    return this.#call(activeSessionId, "setThinkingLevel", boundedString(level, 64));
  }

  async compact(activeSessionId: string, instructions?: string): Promise<unknown> {
    return this.#call(activeSessionId, "compact", instructions === undefined ? undefined : boundedString(instructions, 131_072, true));
  }

  async fork(activeSessionId: string, entryId: string, position?: "before" | "at"): Promise<unknown> {
    return this.#call(activeSessionId, "fork", boundedString(entryId, 128), position === undefined ? undefined : { position });
  }

  async clone(_activeSessionId: string): Promise<Readonly<{ status: "unsupported_upstream"; reason: string }>> {
    return Object.freeze({ status: "unsupported_upstream", reason: "Installed Prime Harness exposes branching/forking but no independent session clone operation." });
  }

  async messages(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getMessages"); }
  async stats(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getSessionStats"); }
  async tree(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getSessionTree"); }
  async children(activeSessionId: string): Promise<unknown> {
    const value = await this.#call(activeSessionId, "getInitialSnapshot");
    return plain(value) && Array.isArray(value.children) ? value.children : [];
  }
  async queue(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getQueue"); }
  async clearQueue(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "clearQueue"); }
  async abortAndClearQueue(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "abortAndClearQueue"); }
  async schedules(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "listCronJobs", { includeInactive: true }); }
  async addSchedule(activeSessionId: string, schedule: string, prompt: string): Promise<unknown> {
    return this.#call(activeSessionId, "addCronJob", boundedString(schedule, 512), boundedString(prompt, 131_072));
  }
  async cancelSchedule(activeSessionId: string, jobId: string): Promise<unknown> {
    return this.#call(activeSessionId, "cancelCronJob", boundedString(jobId, 128));
  }
  async heartbeats(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "listHeartbeats"); }
  async getHeartbeat(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getHeartbeat"); }
  async setHeartbeat(activeSessionId: string, schedule: string, instruction: string, deliveryMode?: "steer" | "follow_up"): Promise<unknown> {
    return this.#call(activeSessionId, "setHeartbeat", boundedString(schedule, 512), boundedString(instruction, 131_072), deliveryMode);
  }
  async updateHeartbeat(activeSessionId: string, action: "pause" | "resume" | "clear"): Promise<unknown> {
    return this.#call(activeSessionId, "updateHeartbeat", action);
  }
  async manageHeartbeat(activeSessionId: string, targetActiveSessionId: string, jobId: string, action: "pause" | "resume" | "stop"): Promise<unknown> {
    return this.#call(activeSessionId, "manageHeartbeat", boundedString(targetActiveSessionId, 128), boundedString(jobId, 128), action);
  }
  async toolDefinition(activeSessionId: string, name: string): Promise<unknown> { return this.#call(activeSessionId, "getToolDefinition", boundedString(name, 128)); }
  async resources(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getResourceSnapshot"); }
  async models(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getModelCatalog"); }
  async commands(activeSessionId: string): Promise<unknown> { return this.#call(activeSessionId, "getCommands"); }
  async importJsonl(activeSessionId: string, inputPath: string, cwdOverride?: string): Promise<unknown> {
    return this.#call(activeSessionId, "importFromJsonl", boundedString(inputPath, 4096), cwdOverride === undefined ? undefined : boundedString(cwdOverride, 4096));
  }
  async exportSession(activeSessionId: string, format: "html" | "jsonl", outputPath?: string): Promise<unknown> {
    const path = outputPath === undefined ? undefined : boundedString(outputPath, 4096);
    return format === "html" ? this.#call(activeSessionId, "exportToHtml", path) : this.#call(activeSessionId, "exportToJsonl", path);
  }

  async inspector(activeSessionId: string, expectedCursor?: Readonly<{ runtimeGeneration: string; sequence: number }>): Promise<PrimeHarnessInspectorDetails> {
    const bound = await this.#bound(activeSessionId);
    if (!bound.initialized || !bound.studioGeneration) throw new Error("inspector cursor is unavailable");
    if (expectedCursor && (expectedCursor.runtimeGeneration !== bound.studioGeneration || expectedCursor.sequence !== bound.sequence)) throw new Error("stale inspector cursor");
    if (bound.dirty) throw new Error("stale inspector cursor");
    const inspectorEventRevision = bound.eventRevision;
    const connection = bound.connection;
    const [initialRaw, contextRaw, statsRaw, resourcesRaw, catalogRaw] = await Promise.all([
      this.#call(activeSessionId, "getInitialSnapshot"),
      this.#call(activeSessionId, "getSessionContext"),
      this.#call(activeSessionId, "getSessionStats"),
      this.#call(activeSessionId, "getResourceSnapshot"),
      this.#call(activeSessionId, "getModelCatalog"),
    ]);
    const initial = plain(initialRaw) ? initialRaw : {};
    const upstream = this.#upstreamCursor(initial, await this.negotiate());
    if (bound.dirty || bound.eventRevision !== inspectorEventRevision
      || bound.publishedUpstreamGeneration !== upstream.generation
      || bound.publishedUpstreamSequence !== upstream.sequence) throw new Error("stale inspector cursor");
    const cursor = Object.freeze({ runtimeGeneration: bound.studioGeneration, sequence: bound.sequence });
    const context = plain(contextRaw) ? contextRaw : {};
    const stats = plain(statsRaw) ? statsRaw : {};
    const statsTokens = plain(stats.tokens) ? stats.tokens : {};
    const initialState = plain(initial.state) ? initial.state : {};
    const contextUsage = plain(stats.contextUsage) ? stats.contextUsage : plain(initialState.contextUsage) ? initialState.contextUsage : null;
    const usedTokens = contextUsage ? optionalSafeInteger(contextUsage.tokens) : null;
    const capacityTokens = contextUsage ? optionalSafeInteger(contextUsage.contextWindow ?? contextUsage.capacityTokens) : null;
    const messages = Array.isArray(initial.messages) ? initial.messages : Array.isArray(context.messages) ? context.messages : [];
    const activity: Array<PrimeHarnessInspectorDetails["activity"][number]> = [];
    const toolCalls = new Map<string, Readonly<{ command: string; redacted: boolean; files: readonly string[] }>>();
    for (const raw of messages) {
      if (!plain(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
      for (const block of raw.content) {
        if (!plain(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
        const input = plain(block.arguments) ? block.arguments : plain(block.input) ? block.input : {};
        const rawCommand = [input.command, input.cmd, block.name].find((value) => typeof value === "string") as string | undefined;
        const command = sanitizeActivityCommand(rawCommand ?? String(block.name ?? "Tool"));
        const candidateFiles = [input.path, input.filePath, input.filename].filter((value): value is string => typeof value === "string");
        toolCalls.set(block.id, { ...command, files: candidateFiles.slice(0, 128).map((file) => boundedString(file, 4096)) });
      }
    }
    for (const [index, raw] of messages.entries()) {
      if (!plain(raw)) continue;
      const occurredAtMs = safeInteger(raw.timestamp);
      if (raw.role === "toolResult") {
        const detail = contentText(raw.content);
        const call = typeof raw.toolCallId === "string" ? toolCalls.get(raw.toolCallId) : undefined;
        const title = typeof raw.toolName === "string" ? boundedString(raw.toolName, 200) : "Tool";
        const projectedCommand = call ?? { ...sanitizeActivityCommand(title), files: [] };
        activity.push({
          id: stableId("activity", `${messageId(raw, index)}:${String(raw.toolCallId ?? "unbound")}:${index}`), occurredAtMs, group: "Tools", kind: "tool", title, detail,
          tool: {
            command: projectedCommand.command,
            redacted: projectedCommand.redacted,
            status: raw.isError === true || raw.error === true ? "failed" : "succeeded",
            durationMs: typeof raw.durationMs === "number" && Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : null,
            files: projectedCommand.files,
          },
        });
      }
    }
    const resources = plain(resourcesRaw) ? resourcesRaw : {};
    const outputs: Array<PrimeHarnessInspectorDetails["outputs"][number]> = [];
    const sources: Array<PrimeHarnessInspectorDetails["sources"][number]> = [];
    if (Array.isArray(resources.outputs)) {
      for (const [index, raw] of resources.outputs.slice(0, 512).entries()) {
        if (!plain(raw)) continue;
        const path = [raw.path, raw.filePath, raw.outputPath].find((value) => typeof value === "string") as string | undefined;
        if (!path) continue;
        const label = [raw.name, raw.label].find((value) => typeof value === "string") as string | undefined;
        const kind = typeof raw.kind === "string" ? raw.kind : "output";
        outputs.push({
          id: stableId("output", `${index}:${path}`), label: boundedString(label ?? "Output", 200),
          candidatePath: boundedString(path, 4096), kind: boundedString(kind, 128),
        });
      }
    }
    for (const kind of ["contextFiles", "skills", "prompts", "extensions", "themes"] as const) {
      const rows = resources[kind]; if (!Array.isArray(rows)) continue;
      for (const [index, raw] of rows.entries()) {
        if (!plain(raw)) continue;
        const path = [raw.path, raw.filePath, raw.sourcePath].find((value) => typeof value === "string") as string | undefined;
        const label = typeof raw.name === "string" ? raw.name : "Context file";
        sources.push({
          id: stableId("source", `${kind}:${index}:${label}`), label: boundedString(label, 200), detail: kind, kind,
          ...(path ? { candidatePath: boundedString(path, 4096) } : {}),
        });
      }
    }
    const children: Record<string, PrimeHarnessInspectorDetails["children"][string]> = {};
    if (Array.isArray(initial.children)) {
      for (const raw of initial.children.slice(0, 256)) {
        if (!plain(raw) || typeof raw.id !== "string") continue;
        const childId = boundedString(raw.id, 128);
        const status = ["queued", "running", "done", "error", "cancelled"].includes(String(raw.status))
          ? raw.status as "queued" | "running" | "done" | "error" | "cancelled"
          : null;
        const modelFacts = childModelFacts(raw.model, catalogRaw);
        const usedTokens = evidenceInteger(raw.tokenCount);
        const error: { code: string; message: string; retryable: boolean } | null = status === "error"
          ? { code: "child_failed", message: "Child failure details are unavailable.", retryable: false }
          : null;
        children[childId] = Object.freeze({
          binding: Object.freeze({ parentSessionId: activeSessionId, childId, cursor }),
          status,
          elapsedMs: evidenceInteger(raw.durationMs),
          provider: modelFacts.provider,
          model: modelFacts.model,
          task: typeof raw.label === "string" ? boundedString(raw.label, 200) : null,
          summary: typeof raw.recap === "string" ? boundedString(raw.recap, 200) : null,
          context: usedTokens !== null || modelFacts.capacityTokens !== null
            ? Object.freeze({ usedTokens, capacityTokens: modelFacts.capacityTokens })
            : null,
          tokenUsage: null,
          transcript: [], activity: [], files: [], error,
        });
      }
    }
    const explicitTurns = contextUsage ? optionalSafeInteger(contextUsage.turns) : null;
    const contextSamples = contextUsage && Array.isArray(contextUsage.samples) && contextUsage.samples.length > 0 && contextUsage.samples.length <= 1_000
      ? contextUsage.samples.map((sample) => safeInteger(sample)) : null;
    const sampleCapacity = capacityTokens ?? 0;
    const validSamples = contextSamples && (sampleCapacity === 0 || contextSamples.every((sample) => sample <= sampleCapacity)) ? contextSamples : null;
    const contextDetails = usedTokens !== null || capacityTokens !== null
      ? {
          usedTokens: usedTokens ?? 0, capacityTokens: capacityTokens ?? 0,
          turns: explicitTurns ?? messages.filter((message) => plain(message) && message.role === "user").length,
          ...(validSamples ? { samples: validSamples } : {}),
        }
      : null;
    const startedAtMs = optionalSafeInteger(stats.startedAtMs ?? initial.startedAtMs ?? initialState.startedAtMs);
    const turnUsage = projectTurnUsage(messages, statsTokens);
    return Object.freeze({
      binding: Object.freeze({ parentSessionId: activeSessionId, cursor }),
      observedAtMs: Date.now(), startedAtMs,
      context: contextDetails,
      ...(turnUsage ? { turnUsage } : {}),
      contributions: Object.freeze(Object.entries(children).flatMap(([id, child]) => child.context !== null && child.context.usedTokens !== null && child.task !== null
        ? [{ id, label: child.task, tokens: child.context.usedTokens }]
        : [])),
      notices: Object.freeze([]), activity: Object.freeze(activity.slice(-300)), outputs: Object.freeze(outputs),
      sources: Object.freeze(sources.slice(0, 512)), children: Object.freeze(children),
      composer: composerProjection(connection, initial, catalogRaw),
      extensionUi: bound.extensionUiUnavailableReason
        ? Object.freeze({ status: "unavailable" as const, reason: bound.extensionUiUnavailableReason })
        : typeof connection.respondToExtensionUiRequest !== "function" || !(await this.negotiate()).serverCapabilities.includes("extension_ui")
          ? Object.freeze({ status: "unavailable" as const, reason: "The verified Harness runtime does not expose extension UI requests and responses." })
          : Object.freeze({
              status: "available" as const,
              requests: Object.freeze([...bound.extensionRequests.values()].flatMap((request) => {
                const projected = projectPendingExtensionRequest(request);
                return projected ? [projected] : [];
              })),
            }),
    });
  }

  async childPage(activeSessionId: string, childId: string, tab: "chat" | "activity" | "files", expectedCursor: Readonly<{ runtimeGeneration: string; sequence: number }>, pageCursor: string | null): Promise<PrimeHarnessChildPage> {
    const boundedChildId = boundedString(childId, 128);
    const bound = await this.#bound(activeSessionId);
    if (!bound.initialized || bound.studioGeneration !== expectedCursor.runtimeGeneration || bound.sequence !== expectedCursor.sequence) throw new Error("stale child page cursor");
    const initialRaw = await this.#call(activeSessionId, "getInitialSnapshot");
    if (!plain(initialRaw)) throw new TypeError("daemon child snapshot is invalid");
    const upstream = this.#upstreamCursor(initialRaw, await this.negotiate());
    if (bound.publishedUpstreamGeneration !== upstream.generation || bound.publishedUpstreamSequence !== upstream.sequence) throw new Error("stale child page cursor");
    const children = Array.isArray(initialRaw.children) ? initialRaw.children : [];
    const matches = children.filter((value) => plain(value) && value.id === boundedChildId);
    if (matches.length !== 1 || !plain(matches[0])) throw new Error("child is not bound to this root session");
    if (tab === "files") return Object.freeze({ status: "unavailable", tab, reason: "The installed Harness does not expose finalized child filesystem evidence." });
    const childSessionId = typeof matches[0].activeSessionId === "string" ? boundedString(matches[0].activeSessionId, 128) : null;
    const watchSession = bound.connection.watchSession;
    if (!childSessionId || typeof watchSession !== "function") return Object.freeze({ status: "unavailable", tab, reason: "The installed Harness does not expose child session paging." });
    const watcher = await (watchSession as (id: string) => Promise<unknown>).call(bound.connection, childSessionId).catch(() => null);
    if (!plain(watcher) || typeof watcher.getMessages !== "function" || typeof watcher.close !== "function") return Object.freeze({ status: "unavailable", tab, reason: "The installed Harness does not expose child session paging." });
    let rawMessages: unknown;
    try { rawMessages = await (watcher.getMessages as () => Promise<unknown>).call(watcher); }
    finally { await (watcher.close as () => Promise<void>).call(watcher).catch(() => undefined); }
    if (!Array.isArray(rawMessages)) return Object.freeze({ status: "unavailable", tab, reason: "The installed Harness did not provide authoritative child page evidence." });
    const messages = rawMessages.slice(-4_096);
    const chat = messages.flatMap((message, index) => plain(message) ? [{ id: messageId(message, index), actor: typeof message.role === "string" ? boundedString(message.role, 64) : "system", occurredAtMs: safeInteger(message.timestamp), text: childPageText(message.content) }] : []);
    const activity = messages.flatMap((message, index) => {
      if (!plain(message)) return [];
      const label = message.role === "toolResult" && typeof message.toolName === "string" ? `Tool: ${boundedString(message.toolName, 200)}` : `${typeof message.role === "string" ? boundedString(message.role, 64) : "system"} message`;
      return [{ id: messageId(message, index), occurredAtMs: safeInteger(message.timestamp), label }];
    });
    const items = tab === "chat" ? chat : activity;
    const snapshotDigest = createHash("sha256").update(JSON.stringify(items)).digest("hex");
    let windowEnd = items.length;
    if (pageCursor !== null) {
      const prior = this.#childPageCursors.get(pageCursor);
      if (!prior) throw new Error("unknown or malformed child page cursor");
      if (prior.rootSessionId !== activeSessionId || prior.childId !== boundedChildId || prior.tab !== tab) throw new Error("cross-child page cursor rejected");
      if (prior.runtimeGeneration !== expectedCursor.runtimeGeneration || prior.sequence !== expectedCursor.sequence || prior.upstreamGeneration !== upstream.generation || prior.upstreamSequence !== upstream.sequence || prior.childSessionId !== childSessionId || prior.snapshotDigest !== snapshotDigest) throw new Error("stale child page cursor");
      windowEnd = prior.windowEnd;
    }
    const windowStart = Math.max(0, windowEnd - 100);
    const pageItems = Object.freeze(items.slice(windowStart, windowEnd));
    let previousCursor: string | null = null;
    if (windowStart > 0) {
      previousCursor = createHash("sha256").update(`${activeSessionId}\0${boundedChildId}\0${tab}\0${++this.#childPageCursorSequence}`).digest("base64url");
      this.#childPageCursors.set(previousCursor, Object.freeze({ rootSessionId: activeSessionId, childId: boundedChildId, tab, runtimeGeneration: expectedCursor.runtimeGeneration, sequence: expectedCursor.sequence, upstreamGeneration: upstream.generation, upstreamSequence: upstream.sequence, childSessionId, snapshotDigest, windowEnd: windowStart }));
      while (this.#childPageCursors.size > 512) this.#childPageCursors.delete(this.#childPageCursors.keys().next().value!);
    }
    return Object.freeze({ status: "available", tab, items: pageItems, previousCursor, omittedItems: rawMessages.length - messages.length + windowStart } as PrimeHarnessChildPage);
  }

  async executeOperation(activeSessionId: string, operation: unknown): Promise<StudioHarnessOperationOutcome> {
    const bound = await this.#bound(activeSessionId);
    if (bound.sequence >= Number.MAX_SAFE_INTEGER) return { status: "rejected", reason: "Session cursor is exhausted.", retryable: false };
    if (plain(operation) && plain(operation.payload) && typeof operation.payload.sessionId === "string" && operation.payload.sessionId !== activeSessionId) {
      return { status: "rejected", reason: "Operation session does not match the attached session.", retryable: false };
    }
    const parsed = parseStudioHarnessOperation(operation);
    const barrier = parsed?.expectedCursor ? await this.#mutationBarrier(activeSessionId, bound) : null;
    if (parsed?.expectedCursor && !barrier) return { status: "rejected", reason: "Session changed; refresh before retrying the operation.", retryable: true };
    const dispatcher = this.#operationDispatchers.get(activeSessionId) ?? new StudioHarnessOperationDispatcher();
    this.#operationDispatchers.set(activeSessionId, dispatcher);
    try {
      return await dispatcher.dispatch({
        connection: (barrier?.connection ?? bound.connection) as unknown as Readonly<Record<string, ((...arguments_: any[]) => Promise<unknown>) | undefined>>,
        currentCursor: { runtimeGeneration: bound.studioGeneration!, sequence: bound.sequence },
        ...(barrier ? {
          preOperationSnapshot: barrier.source,
          publishPostconditionSnapshot: (source: unknown) => this.snapshot(
            activeSessionId,
            bound.sequence + 1,
            false,
            { source, eventRevision: bound.eventRevision },
          ),
        } : {}),
        respondToExtensionUiRequest: (requestId, response) => this.#respondToExtensionUiRequest(bound, requestId, response),
      }, operation);
    } finally { await barrier?.close(); }
  }

  async negotiate(): Promise<DaemonHelloLike> {
    await this.#runtimeClosure?.verify();
    const compatibility = decideCompatibility(this.#identity);
    if (compatibility.status !== "ready" && compatibility.status !== "degraded") throw new Error("runtime identity is incompatible");
    if (!this.#hello) await this.#client.connect(5_000);
    try {
      const hello = this.#client.hello ?? await this.#client.waitForHello(5_000);
      this.#validateHello(hello);
      if (this.#hello && this.#hello.supervisorGeneration !== hello.supervisorGeneration) {
        // Recovery observations are scoped to one verified supervisor
        // generation. Never let a predecessor authorize a mutation on its
        // replacement.
        this.#workerRecovery.clear();
        await Promise.all([...this.#connections.entries()].map(async ([activeSessionId, bound]) => {
          bound.unsubscribe?.();
          await bound.connection.dispose();
          bound.connection = await this.#attachPort(this.#client, activeSessionId);
          delete bound.unsubscribe;
          bound.extensionRequests.clear();
          bound.consumedExtensionRequestIds.clear();
          bound.extensionUiUnavailableReason = null;
          Object.assign(bound.performance, initialTurnPerformance("generation_changed"));
          const unsubscribe = bound.connection.subscribe?.((event) => this.#observeConnectionEvent(bound, event));
          if (unsubscribe) bound.unsubscribe = unsubscribe;
          bound.dirty = true;
        }));
      }
      this.#hello = Object.freeze({ ...hello, serverCapabilities: Object.freeze([...hello.serverCapabilities]) });
      return this.#hello;
    } catch (error) {
      await Promise.all([...this.#connections.values()].map(async (bound) => {
        bound.unsubscribe?.();
        await bound.connection.dispose().catch(() => undefined);
      }));
      this.#connections.clear();
      this.#operationDispatchers.clear();
      this.#hello = null;
      this.#client.close();
      throw error;
    }
  }

  #validateHello(hello: DaemonHelloLike): void {
    if (hello.protocol.name !== this.#identity.protocolName || hello.protocol.version !== this.#identity.protocolVersion) throw new Error("daemon protocol mismatch");
    if (hello.schemaRevision !== this.#identity.schemaRevision || hello.schemaId !== this.#identity.schemaId) throw new Error("daemon schema mismatch");
    if (hello.appVersion !== this.#identity.packageVersion) throw new Error("daemon version mismatch");
    if (this.#expectedSocketPath && hello.socketPath.toLocaleLowerCase("en-US") !== this.#expectedSocketPath.toLocaleLowerCase("en-US")) throw new Error("daemon socket identity mismatch");
    if (this.#expectedDaemonEntrypoint) {
      const observed = hello.runtime?.entrypointPath;
      if (!observed || resolve(observed).toLocaleLowerCase("en-US") !== this.#expectedDaemonEntrypoint.toLocaleLowerCase("en-US")) throw new Error("daemon executable identity mismatch");
    }
    if (!hello.supervisorGeneration || !/^[!-~]{1,128}$/u.test(hello.supervisorGeneration)) throw new Error("daemon generation is unavailable");
    if (hello.serverCapabilities.length > 128 || new Set(hello.serverCapabilities).size !== hello.serverCapabilities.length) throw new Error("daemon capabilities are invalid");
    if (hello.serverCapabilities.some((item) => typeof item !== "string" || !KNOWN_SERVER_CAPABILITIES.has(item))) throw new Error("daemon capability is unknown");
    if (REQUIRED_SERVER_CAPABILITIES.some((item) => !hello.serverCapabilities.includes(item))) throw new Error("daemon capability is missing");
  }

  async bootstrap(): Promise<ScenarioResponse> {
    await this.negotiate();
    const rows = sessionCatalogRows(responseData(await this.#client.request({ type: "list", all: true, includeClientOwned: true }, 10_000), "list"));
    const sessions: FakeRootSessionSnapshot[] = [];
    for (const row of rows) {
      if (!plain(row) || typeof row.activeSessionId !== "string" || row.isSessionActive !== true) continue;
      sessions.push(await this.snapshot(row.activeSessionId));
    }
    return { type: "bootstrap_result", compatibility: decideCompatibility(this.#identity), sessions };
  }

  async handle(request: ScenarioRequest): Promise<ScenarioResponse> {
    if (request.type === "discover_runtime") return { type: "discover_runtime_result", runtime: this.#identity, compatibility: decideCompatibility(this.#identity) };
    if (request.type === "bootstrap") return this.bootstrap();
    if (request.type === "create_resident") {
      return await this.createResident({ creationId: request.creationId, name: request.name, cwd: request.cwd }) as Extract<ScenarioResponse, { type: "resident_created" }>;
    }
    if (request.type === "branch_resident") {
      return this.branchResident(request);
    }
    if (request.type === "retry_worker") return this.#retryWorker(request.sessionId, request.observationId);
    if (request.type === "attach_session") return { type: "snapshot_result", snapshot: await this.snapshot(request.sessionId) };
    if (request.type === "refresh_session") {
      let snapshot: FakeRootSessionSnapshot;
      try { snapshot = await this.snapshot(request.sessionId, request.knownCursor.sequence + 1, false); }
      catch (error) {
        if (error instanceof DaemonGenerationChangedError) return { type: "error", code: "generation_changed", message: "Daemon session generation changed; rebootstrap is required" };
        throw error;
      }
      if (snapshot.cursor.runtimeGeneration !== request.knownCursor.runtimeGeneration || snapshot.cursor.sequence !== request.knownCursor.sequence + 1) {
        return { type: "error", code: "cursor_gap", message: "Daemon session chronology requires a full rebootstrap" };
      }
      return { type: "snapshot_result", snapshot };
    }
    if (request.type === "conversation_history_page") return this.#pageParentHistory(request.sessionId, request.expectedCursor, request.before);
    if (request.type !== "session_command") return { type: "error", code: "unsupported_command", message: "Use the dedicated Studio operation route" };
    await this.negotiate();
    const fingerprint = JSON.stringify(request);
    const prior = this.#commands.get(request.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { type: "error", code: "command_replay_conflict", message: "Command ID was reused with different input" };
      return { ...prior.response, outcome: "reconciled" };
    }
    const bound = await this.#bound(request.sessionId);
    if (request.expectedCursor.runtimeGeneration !== bound.studioGeneration || request.expectedCursor.sequence !== bound.sequence) {
      return { type: "error", code: "stale_cursor", message: "Session cursor does not match" };
    }
    const barrier = await this.#mutationBarrier(request.sessionId, bound);
    if (!barrier) {
      return { type: "error", code: "stale_cursor", message: "Daemon session advanced; refresh before retrying" };
    }
    if ((request.kind === "abort") !== (request.text.length === 0)) return { type: "error", code: "invalid_command", message: "Session command is invalid" };
    try {
      if (request.kind === "prompt") await barrier.connection.prompt(request.text);
      else if (request.kind === "steer") await barrier.connection.steer(request.text);
      else if (request.kind === "follow_up") await barrier.connection.followUp(request.text);
      else await barrier.connection.abort();
    } finally { await barrier.close(); }
    const snapshot = await this.snapshot(request.sessionId, bound.sequence + 1);
    const response = Object.freeze({ type: "command_result" as const, commandId: request.commandId, outcome: request.kind === "follow_up" ? "queued" as const : "accepted" as const, snapshot });
    this.#commands.set(request.commandId, { fingerprint, response });
    return response;
  }

  async #pageParentHistory(
    activeSessionId: string,
    expectedCursor: Readonly<{ runtimeGeneration: string; sequence: number }>,
    before: string | null,
  ): Promise<ScenarioResponse> {
    const cursorRecord = before === null ? null : this.#parentHistoryCursors.get(before);
    if (before !== null && (!cursorRecord || cursorRecord.sessionId !== activeSessionId)) {
      return { type: "error", code: "invalid_history_cursor", message: "History cursor is not owned by this session snapshot" };
    }
    const bound = await this.#bound(activeSessionId);
    if (expectedCursor.runtimeGeneration !== bound.studioGeneration || expectedCursor.sequence !== bound.sequence) {
      return { type: "error", code: "stale_cursor", message: "Session cursor does not match" };
    }
    if (cursorRecord && (cursorRecord.runtimeGeneration !== expectedCursor.runtimeGeneration || cursorRecord.snapshotSequence !== expectedCursor.sequence)) {
      return { type: "error", code: "stale_cursor", message: "History cursor belongs to a different session snapshot" };
    }
    const barrier = await this.#mutationBarrier(activeSessionId, bound);
    if (!barrier) return { type: "error", code: "stale_cursor", message: "Daemon session advanced; refresh before paging" };
    try {
      if (!Array.isArray(barrier.source.messages)) {
        return { type: "error", code: "history_unavailable", message: "The installed Harness did not provide an atomic history snapshot" };
      }
      const rawMessages = barrier.source.messages;
      const streaming = plain(barrier.source.streamingMessage) ? barrier.source.streamingMessage : null;
      const historyMessages = [...rawMessages, ...(streaming ? [streaming] : [])];
      const sourceBytes = Buffer.byteLength(JSON.stringify(historyMessages), "utf8");
      if (historyMessages.length > 4_096 || sourceBytes > 8 * 1024 * 1024) {
        return { type: "error", code: "history_unavailable", message: "The installed Harness history exceeds the verified paging proof bounds" };
      }
      const projected = projectAtomicParentMessages(rawMessages, streaming, barrier.source.sessionTree);
      const sourceDigest = createHash("sha256").update(JSON.stringify(projected)).digest("hex");
      if (cursorRecord && cursorRecord.sourceDigest !== sourceDigest) {
        return { type: "error", code: "stale_cursor", message: "History source changed after the cursor was issued" };
      }
      // The resident snapshot already carries its bounded newest parent window. An
      // initial request therefore starts immediately before that exact window;
      // subsequent requests advance only through opaque cursors issued below.
      const residentCount = Math.min(projected.length, bound.lastSnapshot?.parentMessages.length ?? 0);
      const end = cursorRecord?.beforeExclusive ?? projected.length - residentCount;
      if (!Number.isSafeInteger(end) || end < 0 || end > projected.length) {
        return { type: "error", code: "invalid_history_cursor", message: "History cursor window is invalid" };
      }
      const selected: ParentMessage[] = [];
      let selectedBytes = 2;
      for (let index = end - 1; index >= 0 && selected.length < 100; index -= 1) {
        const candidate = projected[index]!;
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (selected.length > 0 ? 1 : 0);
        if (selectedBytes + candidateBytes > 1024 * 1024) break;
        selected.unshift(candidate);
        selectedBytes += candidateBytes;
      }
      if (end > 0 && selected.length === 0) {
        return { type: "error", code: "history_unavailable", message: "The next parent history row exceeds the verified page byte bound" };
      }
      const start = end - selected.length;
      const olderCursor = start > 0 ? `history-${createHash("sha256").update(this.#parentHistorySecret).update(JSON.stringify({ activeSessionId, expectedCursor, sourceDigest, start })).digest("hex")}` : null;
      if (olderCursor) {
        if (this.#parentHistoryCursors.size >= 1_024) this.#parentHistoryCursors.clear();
        this.#parentHistoryCursors.set(olderCursor, { sessionId: activeSessionId, runtimeGeneration: expectedCursor.runtimeGeneration, snapshotSequence: expectedCursor.sequence, sourceDigest, beforeExclusive: start });
      }
      const page: ParentHistoryPage = Object.freeze({
        sessionId: activeSessionId, snapshotCursor: { ...expectedCursor }, messages: Object.freeze(selected), totalMessages: projected.length,
        omittedBefore: start, omittedAfter: projected.length - end, olderCursor,
        truncatedByBytes: selected.length < Math.min(100, end),
      });
      return { type: "conversation_history_page_result", page };
    } finally {
      await barrier.close();
    }
  }

  async snapshot(
    activeSessionId: string,
    minimumSequence = 0,
    allowGenerationChange = true,
    prepared?: Readonly<{ source: unknown; eventRevision: bigint }>,
  ): Promise<FakeRootSessionSnapshot> {
    const hello = await this.negotiate();
    const recovery = await this.#observeWorkerRecovery(activeSessionId, hello);
    if (recovery.status !== "starting" && recovery.status !== "ready" && recovery.status !== "recovered") {
      const bound = this.#connections.get(activeSessionId);
      if (!bound?.lastSnapshot) throw new Error("worker recovery identity is unavailable");
      return this.#publishWorkerRecoverySnapshot(bound, recovery, minimumSequence);
    }
    const bound = await this.#bound(activeSessionId);
    const performanceEventRevision = bound.eventRevision;
    const performanceAtRevision = cloneTurnPerformance(bound.performance);
    const barrier = prepared ? null : await this.#openBarrier(activeSessionId, bound);
    const publicationEventRevision = prepared?.eventRevision ?? barrier!.eventRevision;
    const atomicPerformance = publicationEventRevision === performanceEventRevision
      ? performanceAtRevision
      : initialTurnPerformance("event_chronology_incomplete");
    const initial = prepared?.source ?? barrier!.source;
    await barrier?.close();
    const source = plain(initial) ? initial : {};
    const fallbackState = plain(source.state) ? source.state : await bound.connection.getState();
    const state = plain(fallbackState) ? fallbackState : {};
    const rawMessages = Array.isArray(source.messages) ? source.messages : await bound.connection.getMessages();
    const streaming = plain(source.streamingMessage) ? source.streamingMessage : null;
    const observedCursor = this.#upstreamCursor(source, hello);
    const generationChanged = bound.initialized && bound.publishedUpstreamGeneration !== observedCursor.generation;
    if (generationChanged && !allowGenerationChange) throw new DaemonGenerationChangedError();
    const nextSequence = generationChanged
      ? observedCursor.sequence
      : bound.initialized ? bound.sequence + 1 : Math.max(observedCursor.sequence, minimumSequence);
    if (!Number.isSafeInteger(nextSequence) || nextSequence > Number.MAX_SAFE_INTEGER || (bound.initialized && minimumSequence > nextSequence)) {
      throw new Error("Studio projection cursor cannot advance exactly one revision");
    }
    const messages = projectAtomicParentMessages(rawMessages, streaming, source.sessionTree).slice(-300);
    const children = Array.isArray(source.children) ? source.children.slice(0, 256).flatMap((raw) => {
      if (!plain(raw) || typeof raw.id !== "string") return [];
      const status = ["queued", "running", "done", "error", "cancelled"].includes(String(raw.status)) ? raw.status as "queued" | "running" | "done" | "error" | "cancelled" : "unknown" as const;
      const model = typeof raw.model === "string" ? boundedString(raw.model, 200) : null;
      const separator = model?.indexOf("/") ?? -1;
      return [{ id: boundedString(raw.id, 128), status, task: boundedString(typeof raw.label === "string" ? raw.label : "Unavailable", 200), provider: separator > 0 ? model!.slice(0, separator) : null, model: separator > 0 ? model!.slice(separator + 1) : model, progress: status === "done" ? 1 : null }];
    }) : [];
    const queueRaw = await bound.connection.getQueue();
    const queueObject = plain(queueRaw) ? queueRaw : {};
    const queue = ([...(Array.isArray(queueObject.steering) ? queueObject.steering : []), ...(Array.isArray(queueObject.followUp) ? queueObject.followUp : [])]).slice(0, 256).flatMap((label, index) => typeof label === "string" ? [{ id: stableId("queue", `${index}:${label}`), label: boundedString(label, 200), state: "queued" as const }] : []);
    const resourcesRaw = await bound.connection.getResourceSnapshot();
    const resourceObject = plain(resourcesRaw) ? resourcesRaw : {};
    const resources: Array<{ id: string; label: string; kind: string; availability: "available" }> = [];
    for (const kind of ["contextFiles", "skills", "prompts", "extensions", "themes"] as const) {
      const rows = resourceObject[kind];
      if (!Array.isArray(rows)) continue;
      for (const [index, raw] of rows.entries()) {
        if (!plain(raw)) continue;
        const label = [raw.name, raw.path, raw.filePath, raw.sourcePath].find((value) => typeof value === "string") as string | undefined;
        if (label) resources.push({ id: stableId("resource", `${kind}:${index}:${label}`), label: boundedString(label, 200), kind, availability: "available" });
      }
    }
    const activeTools = Array.isArray(state.activeToolNames) ? state.activeToolNames.slice(0, 512) : [];
    const tools = await Promise.all(activeTools.flatMap((name) => typeof name === "string" ? [name] : []).map(async (name) => {
      const definition = await bound.connection.getToolDefinition(name);
      const value = plain(definition) ? definition : {};
      return { id: boundedString(name, 128), label: typeof value.label === "string" ? boundedString(value.label, 200) : boundedString(name, 200), enabled: true, configurable: false };
    }));
    const statsRaw = await bound.connection.getSessionStats();
    const stats = plain(statsRaw) ? statsRaw : {};
    const tokens = plain(stats.tokens) ? stats.tokens : {};
    const input = safeInteger(tokens.input), output = safeInteger(tokens.output), cacheRead = safeInteger(tokens.cacheRead), cacheWrite = safeInteger(tokens.cacheWrite);
    const totalTokens = input + output + cacheRead + cacheWrite;
    if (!Number.isSafeInteger(totalTokens)) throw new TypeError("daemon token usage is invalid");
    const cwd = boundedString(state.cwd, 4096);
    const chatId = typeof state.sessionId === "string" ? boundedString(state.sessionId, 128) : activeSessionId;
    const currentModel = plain(state.model) ? state.model : {};
    const provider = typeof currentModel.provider === "string" ? boundedString(currentModel.provider, 128) : null;
    const cursor = { runtimeGeneration: observedCursor.generation, sequence: nextSequence };
    const snapshot = Object.freeze({
      sessionId: activeSessionId, accountId: null, provider, projectId: projectId(cwd), chatId,
      cursor, state: rootState(state),
      parentMessages: messages, children, queue, tools, resources: resources.slice(0, 512),
      usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: typeof stats.cost === "number" && Number.isFinite(stats.cost) && stats.cost >= 0 ? stats.cost : null },
      workerRecovery: recovery,
      performance: bindTurnPerformance(atomicPerformance, activeSessionId, cursor, generationChanged),
    });
    if (generationChanged) Object.assign(bound.performance, initialTurnPerformance("generation_changed"));
    bound.sequence = nextSequence;
    bound.initialized = true;
    bound.publishedUpstreamSequence = observedCursor.sequence;
    bound.publishedUpstreamGeneration = observedCursor.generation;
    bound.studioGeneration = observedCursor.generation;
    if (generationChanged) {
      bound.extensionRequests.clear();
      bound.consumedExtensionRequestIds.clear();
      bound.extensionUiUnavailableReason = null;
    } else {
      const requestCursor = Object.freeze({ runtimeGeneration: observedCursor.generation, sequence: nextSequence });
      for (const [requestId, request] of bound.extensionRequests) {
        if (request.cursor !== null && (request.cursor.runtimeGeneration !== requestCursor.runtimeGeneration || request.cursor.sequence !== requestCursor.sequence)) {
          if (!this.#consumeExtensionRequestIds(bound, [requestId])) break;
          bound.extensionRequests.delete(requestId);
        } else if (request.cursor === null) {
          request.cursor = requestCursor;
        }
      }
    }
    bound.dirty = bound.eventRevision !== publicationEventRevision;
    bound.lastSnapshot = snapshot;
    return snapshot;
  }

  async #observeWorkerRecovery(activeSessionId: string, negotiated?: DaemonHelloLike): Promise<WorkerRecoveryProjection> {
    const hello = negotiated ?? await this.negotiate();
    const rows = sessionCatalogRows(responseData(
      await this.#client.request({ type: "list", includeClientOwned: true }, 10_000),
      "list",
    ));
    const matches = rows.filter((row) => plain(row) && row.activeSessionId === activeSessionId && row.isSessionActive === true);
    if (matches.length !== 1) throw new Error("daemon worker recovery session identity is ambiguous");
    const row = matches[0]! as Record<string, unknown>;
    if (row.workerState === undefined) throw new Error("daemon worker recovery state is unavailable");
    const state = boundedString(row.workerState, 32);
    if (state !== "starting" && state !== "ready" && state !== "recovering" && state !== "failed") throw new Error("daemon worker recovery state is invalid");
    const prior = this.#workerRecovery.get(activeSessionId)?.projection;
    let projection: WorkerRecoveryProjection;
    if (state === "starting") {
      projection = { status: "starting", closureReason: null, observationId: null, automaticRetryCount: 0, detail: "The verified supervisor is starting this worker." };
    } else if (state === "ready") {
      projection = prior?.status === "retrying"
        ? { status: "recovered", closureReason: prior.closureReason, observationId: prior.observationId, automaticRetryCount: 1, detail: null }
        : { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null };
    } else if (state === "recovering") {
      if (prior?.observationId) {
        projection = { ...prior, status: prior.automaticRetryCount === 1 ? "retrying" : "recovering", detail: null };
      } else if (prior?.status === "ready" || prior?.status === "recovered") {
        const observationId = stableId("worker-recovery", `${hello.supervisorGeneration}:${activeSessionId}:${++this.#workerRecoverySequence}`);
        projection = { status: "recovering", closureReason: "unexpected_worker_disconnect", observationId, automaticRetryCount: 0, detail: null };
      } else {
        projection = { status: "terminal_failure", closureReason: "supervisor_recovery_exhausted", observationId: null, automaticRetryCount: 0, detail: "The worker failure was not observed from a healthy session; automatic retry is unsafe." };
      }
    } else if (prior?.observationId) {
      projection = prior.automaticRetryCount === 0
        ? { ...prior, status: "retryable_failure", closureReason: "supervisor_recovery_exhausted", detail: "The verified supervisor exhausted its worker recovery attempts." }
        : { ...prior, status: "terminal_failure", closureReason: "supervisor_recovery_exhausted", detail: prior.detail ?? "The one automatic worker retry did not recover the session." };
    } else {
      projection = { status: "terminal_failure", closureReason: "supervisor_recovery_exhausted", observationId: null, automaticRetryCount: 0, detail: "The worker failure was not observed from a healthy session; automatic retry is unsafe." };
    }
    this.#workerRecovery.set(activeSessionId, { projection: Object.freeze(projection) });
    return projection;
  }

  #publishWorkerRecoverySnapshot(bound: BoundConnection, recovery: WorkerRecoveryProjection, minimumSequence: number): FakeRootSessionSnapshot {
    const prior = bound.lastSnapshot;
    if (!prior || !bound.initialized || !bound.studioGeneration) throw new Error("worker recovery identity is unavailable");
    const sequence = bound.sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence > Number.MAX_SAFE_INTEGER || minimumSequence > sequence) {
      throw new Error("Studio projection cursor cannot advance exactly one revision");
    }
    const cursor = { runtimeGeneration: bound.studioGeneration, sequence };
    const snapshot = Object.freeze({
      ...prior,
      provider: null,
      cursor,
      state: "failed" as const,
      workerRecovery: Object.freeze({ ...recovery }),
      performance: bindTurnPerformance(initialTurnPerformance("generation_changed"), prior.sessionId, cursor, false),
    });
    bound.sequence = sequence;
    this.#consumeExtensionRequestIds(bound, bound.extensionRequests.keys());
    bound.extensionRequests.clear();
    bound.lastSnapshot = snapshot;
    return snapshot;
  }

  async #retryWorker(activeSessionId: string, observationId: string): Promise<ScenarioResponse> {
    if (!/^[!-~]{1,128}$/u.test(activeSessionId) || !/^[!-~]{1,128}$/u.test(observationId)) {
      return { type: "error", code: "worker_retry_not_admitted", message: "Worker retry identity is invalid" };
    }
    const recovery = await this.#observeWorkerRecovery(activeSessionId);
    const bound = this.#connections.get(activeSessionId);
    if (!bound?.lastSnapshot || recovery.status !== "retryable_failure" || recovery.observationId !== observationId || recovery.automaticRetryCount !== 0) {
      return { type: "error", code: "worker_retry_not_admitted", message: "Worker retry is not admitted for this observation" };
    }
    const retrying: WorkerRecoveryProjection = Object.freeze({ ...recovery, status: "retrying", automaticRetryCount: 1, detail: null });
    this.#workerRecovery.set(activeSessionId, { projection: retrying });
    try {
      responseData(await this.#client.request({ type: "retry_worker", activeSessionId }, 60_000), "retry_worker");
      await this.#replaceRecoveredConnection(activeSessionId, bound);
    } catch (error) {
      const terminal: WorkerRecoveryProjection = Object.freeze({
        ...retrying,
        status: "terminal_failure",
        closureReason: "supervisor_recovery_exhausted",
        detail: sanitizeDiagnostic(error).slice(0, 200) || "The verified supervisor rejected the worker retry.",
      });
      this.#workerRecovery.set(activeSessionId, { projection: terminal });
      return { type: "worker_retry_result", observationId, outcome: "terminal_failure", snapshot: this.#publishWorkerRecoverySnapshot(bound, terminal, bound.sequence + 1) };
    }
    const snapshot = await this.snapshot(activeSessionId, bound.sequence + 1);
    const outcome = snapshot.workerRecovery.status === "recovered" ? "recovered" : "terminal_failure";
    return { type: "worker_retry_result", observationId, outcome, snapshot };
  }

  async #replaceRecoveredConnection(activeSessionId: string, bound: BoundConnection): Promise<void> {
    const replacement = await this.#attachPort(this.#client, activeSessionId);
    let replacementUnsubscribe: (() => void) | undefined;
    try {
      if (replacement.subscribe) {
        replacementUnsubscribe = replacement.subscribe((event) => this.#observeConnectionEvent(bound, event));
      }
    } catch (error) {
      await replacement.dispose().catch(() => undefined);
      throw error;
    }
    const prior = bound.connection;
    bound.unsubscribe?.();
    bound.connection = replacement;
    if (replacementUnsubscribe) bound.unsubscribe = replacementUnsubscribe;
    else delete bound.unsubscribe;
    bound.dirty = false;
    Object.assign(bound.performance, initialTurnPerformance("generation_changed"));
    await prior.dispose().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#connections.values()].map((item) => item.connection.dispose().catch(() => undefined)));
    this.#connections.clear();
    this.#operationDispatchers.clear();
    this.#client.close();
    await this.#runtimeClosure?.close();
  }

  async #bound(activeSessionId: string): Promise<BoundConnection> {
    await this.negotiate();
    const prior = this.#connections.get(activeSessionId);
    if (prior) return prior;
    if (!/^[!-~]{1,128}$/u.test(activeSessionId)) throw new TypeError("active session ID is invalid");
    const connection = await this.#attachPort(this.#client, activeSessionId);
    const bound: BoundConnection = {
      connection, sequence: 0, initialized: false, publishedUpstreamSequence: null,
      publishedUpstreamGeneration: null, studioGeneration: null,
      eventRevision: 0n, dirty: false, lastSnapshot: null,
      extensionRequests: new Map(), consumedExtensionRequestIds: new Set(), extensionUiUnavailableReason: null,
      performance: initialTurnPerformance(),
    };
    if (connection.subscribe) {
      bound.unsubscribe = connection.subscribe((event) => this.#observeConnectionEvent(bound, event));
    }
    this.#connections.set(activeSessionId, bound);
    return bound;
  }

  #observeConnectionEvent(bound: BoundConnection, event: unknown): void {
    observeTurnPerformance(bound.performance, event, this.#monotonicNow(), bound.publishedUpstreamGeneration);
    bound.eventRevision += 1n;
    bound.dirty = true;
    try {
      const request = normalizeExtensionRequest(event);
      if (!request) return;
      if (bound.extensionUiUnavailableReason) return;
      const prior = bound.extensionRequests.get(request.id);
      if (prior) {
        if (prior.fingerprint !== request.fingerprint) throw new TypeError("extension UI request identity was reused with different input");
        return;
      }
      if (bound.consumedExtensionRequestIds.has(request.id)) throw new TypeError("extension UI request identity was replayed");
      if (bound.extensionRequests.size >= 16) throw new RangeError("extension UI request capacity is exhausted");
      bound.extensionRequests.set(request.id, request);
    } catch {
      bound.extensionUiUnavailableReason = "The Harness emitted extension UI evidence that Studio could not verify safely.";
      bound.extensionRequests.clear();
    }
  }

  #consumeExtensionRequestIds(bound: BoundConnection, requestIds: Iterable<string>): boolean {
    if (addConsumedExtensionRequestIds(bound.consumedExtensionRequestIds, requestIds)) return true;
    bound.extensionUiUnavailableReason = "Extension UI request identity capacity is exhausted; reattach to a new runtime generation.";
    bound.extensionRequests.clear();
    return false;
  }

  async #respondToExtensionUiRequest(bound: BoundConnection, requestId: string, rawResponse: unknown): Promise<void> {
    const request = bound.extensionRequests.get(requestId);
    if (!request || !request.cursor || request.cursor.runtimeGeneration !== bound.studioGeneration || request.cursor.sequence !== bound.sequence || bound.consumedExtensionRequestIds.has(requestId)) throw new TypeError("extension UI request is stale, unknown, or already answered");
    if (!plain(rawResponse)) throw new TypeError("extension UI response is invalid");
    let response: Readonly<{ value: string } | { confirmed: boolean } | { cancelled: true }>;
    if (exactKeys(rawResponse, ["cancelled"]) && rawResponse.cancelled === true) {
      response = Object.freeze({ cancelled: true });
    } else if (request.method === "confirm" && exactKeys(rawResponse, ["confirmed"]) && typeof rawResponse.confirmed === "boolean") {
      response = Object.freeze({ confirmed: rawResponse.confirmed });
    } else if ((request.method === "select" || request.method === "input" || request.method === "editor")
      && exactKeys(rawResponse, ["value"]) && typeof rawResponse.value === "string") {
      const maximum = request.method === "editor" ? 32_768 : request.method === "input" ? 8_192 : 200;
      const value = boundedString(rawResponse.value, maximum, request.method !== "select");
      if (request.method === "select" && !request.options.includes(value)) throw new TypeError("extension UI selection is invalid");
      response = Object.freeze({ value });
    } else {
      throw new TypeError("extension UI response does not match the pending request");
    }
    const candidate = bound.connection.respondToExtensionUiRequest;
    if (typeof candidate !== "function") throw new ReferenceError("verified extension UI response admission is unavailable");
    if (!this.#consumeExtensionRequestIds(bound, [requestId])) throw new ReferenceError(bound.extensionUiUnavailableReason!);
    bound.extensionRequests.delete(requestId);
    await candidate.call(bound.connection, requestId, response);
  }

  async #call(activeSessionId: string, method: string, ...arguments_: unknown[]): Promise<unknown> {
    const bound = await this.#bound(activeSessionId);
    const candidate = bound.connection[method];
    if (typeof candidate !== "function") throw new Error(`daemon method ${method} is unavailable`);
    return (candidate as (...values: unknown[]) => Promise<unknown>).apply(bound.connection, arguments_);
  }

  #upstreamCursor(source: Record<string, unknown>, hello: DaemonHelloLike): Readonly<{ generation: string; sequence: number }> {
    if (plain(source.lastEventCursor)) {
      return {
        generation: boundedString(source.lastEventCursor.generation, 128),
        sequence: safeInteger(source.lastEventCursor.sequence),
      };
    }
    return { generation: hello.supervisorGeneration!, sequence: safeInteger(source.lastEventSequence) };
  }

  async #openBarrier(activeSessionId: string, bound: BoundConnection): Promise<Readonly<DaemonSnapshotBarrier>> {
    const connection = await this.#attachPort(this.#client, activeSessionId);
    let unsubscribe: (() => void) | undefined;
    if (connection.subscribe) unsubscribe = connection.subscribe(() => {
      bound.eventRevision += 1n;
      bound.dirty = true;
    });
    try {
      const initial = await connection.getInitialSnapshot();
      const source = plain(initial) ? initial : {};
      const eventRevision = bound.eventRevision;
      let closed = false;
      return Object.freeze({
        connection, source, eventRevision,
        async close() {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          await connection.dispose();
        },
      });
    } catch (error) {
      unsubscribe?.();
      await connection.dispose().catch(() => undefined);
      throw error;
    }
  }

  async #mutationBarrier(activeSessionId: string, bound: BoundConnection): Promise<Readonly<DaemonSnapshotBarrier> | null> {
    if (!bound.initialized || bound.dirty || bound.publishedUpstreamSequence === null || bound.publishedUpstreamGeneration === null) return null;
    const barrier = await this.#openBarrier(activeSessionId, bound);
    const upstream = this.#upstreamCursor(barrier.source, await this.negotiate());
    if (bound.dirty || bound.eventRevision !== barrier.eventRevision
      || upstream.generation !== bound.publishedUpstreamGeneration
      || upstream.sequence !== bound.publishedUpstreamSequence) {
      await barrier.close();
      return null;
    }
    return barrier;
  }
}

function within(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function loadVerifiedPrimeDaemonBridge(packageRoot: string): Promise<PrimeDaemonBridge> {
  const identity = await discoverRuntime(packageRoot);
  const compatibility = decideCompatibility(identity);
  if (compatibility.status !== "ready" && compatibility.status !== "degraded") throw new Error("runtime identity is incompatible");
  const root = await realpath(packageRoot);
  const daemonEntrypoint = await realpath(resolve(root, "dist", "bundle", "cli.js"));
  if (!within(root, daemonEntrypoint)) throw new Error("daemon entrypoint escaped package root");
  const { lstat, readFile } = await import("node:fs/promises");
  const daemonMetadata = await lstat(daemonEntrypoint);
  if (!daemonMetadata.isFile() || daemonMetadata.isSymbolicLink() || daemonMetadata.size > 64 * 1024 * 1024) throw new Error("daemon entrypoint is untrusted");
  const daemonBytes = await readFile(daemonEntrypoint);
  const daemonDigest = `sha256:${createHash("sha256").update(daemonBytes).digest("hex")}`;
  const { DAEMON_V7_SCHEMA13_PROFILE } = await import("./profiles/daemon-v7-schema13.js");
  if (daemonDigest !== DAEMON_V7_SCHEMA13_PROFILE.daemonEntrypointDigest) throw new Error("daemon entrypoint identity mismatch");
  const runtimeClosure = await lockVerifiedRuntimeClosure(root);
  try {
    const namespace = await loadReviewedPrimeAdapter();
    const Client = namespace.DaemonClient;
    const Connection = namespace.DaemonAgentConnection;
    const socket = namespace.defaultDaemonSocketPath;
    if (typeof Client !== "function" || typeof Connection !== "function" || typeof socket !== "function") {
      throw new Error("runtime bridge exports are unavailable");
    }
    const socketPath = (socket as () => string)();
    if (typeof socketPath !== "string" || socketPath.length < 1 || socketPath.length > 4096) {
      throw new Error("daemon socket path is invalid");
    }
    const client = new (Client as new (path: string) => DaemonClientPort)(socketPath);
    return new PrimeDaemonBridge({
      identity,
      client,
      runtimeClosure,
      expectedSocketPath: socketPath,
      expectedDaemonEntrypoint: daemonEntrypoint,
      attach: async (daemonClient, activeSessionId) => (Connection as unknown as { attach(client: DaemonClientPort, session: string, options: object): Promise<DaemonConnectionPort> }).attach(daemonClient, activeSessionId, { supportsExtensionUi: true }),
    });
  } catch (error) {
    await runtimeClosure.close();
    throw error;
  }
}
