import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  BootProjection,
  HarnessProjectionEvent,
  RootSessionProjection,
} from "../../entities/harness/types";
import type {
  ChildAgentSummary,
  ContextSource,
  CurrentChatUsage,
  HarnessCapability,
  HarnessCompatibility,
  HarnessCursor,
  HarnessUnavailableReason,
  MessageBlock,
  ParentMessage,
  QueueItem,
  RuntimeIdentity,
  ToolDefinition,
} from "./harness.generated";

const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();

const CAPABILITIES = new Set<HarnessCapability>([
  "attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission",
  "model_catalog", "extension_ui", "chunked_snapshot", "prompt_admission_cancellation",
  "queue_management", "resource_snapshot", "delete_child", "heartbeat_catalog",
  "heartbeat_management", "side_question_transcript", "transient_bash",
]);
const MANDATORY_CAPABILITIES: readonly HarnessCapability[] = [
  "attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog",
];
const REASONS = new Set<HarnessUnavailableReason>([
  "not_installed", "runtime_identity_mismatch", "unsupported_protocol", "unsupported_schema",
  "missing_mandatory_capability", "transport_unavailable", "security_verification_failed",
]);

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
  return { runtimeGeneration: id(source.runtimeGeneration), sequence: safeInteger(source.sequence) };
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
      return { capability: oneOf(feature.capability, CAPABILITIES), reason: oneOf(feature.reason, REASONS) };
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
    return { status, reason: oneOf(source.reason, REASONS), runtime: source.runtime === null ? null : runtime(source.runtime) };
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
    return { kind, text: bounded(source.text, 131_072, true), redacted: boolean(source.redacted) };
  }
  if (kind === "tool_call") {
    const source = record(value, ["kind", "toolCallId", "toolId", "status"]);
    return { kind, toolCallId: id(source.toolCallId), toolId: id(source.toolId), status: oneOf(source.status, new Set(["pending", "running", "blocked", "succeeded", "failed"] as const)) };
  }
  return fail();
}

function message(value: unknown): ParentMessage {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "assistant") {
    const source = record(value, ["channel", "kind", "id", "blocks", "streaming", "emittedAtMs"]);
    if (source.channel !== "parent") fail();
    return { channel: "parent", kind, id: id(source.id), blocks: array(source.blocks, 1024).map(block), streaming: boolean(source.streaming), emittedAtMs: safeInteger(source.emittedAtMs) };
  }
  if (kind === "user" || kind === "notice") {
    const source = record(value, ["channel", "kind", "id", "text", "emittedAtMs"]);
    if (source.channel !== "parent") fail();
    return { channel: "parent", kind, id: id(source.id), text: bounded(source.text, 131_072, true), emittedAtMs: safeInteger(source.emittedAtMs) };
  }
  return fail();
}

function child(value: unknown): ChildAgentSummary {
  const source = record(value, ["id", "status", "task", "provider", "model", "progress"]);
  const nullableLabel = (candidate: unknown) => candidate === null ? null : bounded(candidate, 200);
  const progress = source.progress === null ? null : source.progress;
  if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)) fail();
  return { id: id(source.id), status: oneOf(source.status, new Set(["queued", "running", "done", "error", "cancelled", "unknown"] as const)), task: bounded(source.task, 200), provider: nullableLabel(source.provider), model: nullableLabel(source.model), progress: progress as number | null };
}

function queueItem(value: unknown): QueueItem {
  const source = record(value, ["id", "label", "state"]);
  return { id: id(source.id), label: bounded(source.label, 200), state: oneOf(source.state, new Set(["queued", "admitted", "running", "cancelled"] as const)) };
}

function tool(value: unknown): ToolDefinition {
  const source = record(value, ["id", "label", "enabled", "configurable"]);
  return { id: id(source.id), label: bounded(source.label, 200), enabled: boolean(source.enabled), configurable: boolean(source.configurable) };
}

function resource(value: unknown): ContextSource {
  const source = record(value, ["id", "label", "kind", "availability"]);
  return { id: id(source.id), label: bounded(source.label, 200), kind: id(source.kind), availability: oneOf(source.availability, new Set(["available", "unavailable"] as const)) };
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
  return { input, output, cacheRead, cacheWrite, totalTokens, cost: cost as number | null };
}

function session(value: unknown): RootSessionProjection {
  const source = record(value, ["sessionId", "accountId", "projectId", "chatId", "cursor", "state", "freshness", "parentMessages", "children", "queue", "tools", "resources", "usage"]);
  const sessionId = id(source.sessionId);
  const children = array(source.children, 256).map(child);
  const childIds = new Set<string>();
  for (const item of children) {
    if (item.id === sessionId || childIds.has(item.id)) fail();
    childIds.add(item.id);
  }
  return {
    sessionId,
    accountId: source.accountId === null ? null : id(source.accountId),
    projectId: id(source.projectId), chatId: id(source.chatId), cursor: cursor(source.cursor),
    state: oneOf(source.state, new Set(["idle", "working", "blocked", "failed", "disconnected", "stopped"] as const)),
    freshness: oneOf(source.freshness, new Set(["live", "stale", "disconnected", "unknown_outcome"] as const)),
    parentMessages: array(source.parentMessages, 300).map(message), children,
    queue: array(source.queue, 256).map(queueItem), tools: array(source.tools, 512).map(tool),
    resources: array(source.resources, 512).map(resource), usage: usage(source.usage),
  };
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
  return deepFreeze({ schemaVersion: 1, sequence: safeInteger(source.sequence), type: "session_projection", session: session(source.session) });
}

export async function bootstrapHarness(): Promise<BootProjection> {
  const projection = decodeBootProjection(await invoke("harness_bootstrap"));
  lastSequence = 0;
  eventStreamClosed = false;
  sessionCursors.clear();
  retiredGenerations.clear();
  childOwners.clear();
  sessionChildren.clear();
  for (const session of projection.sessions) {
    sessionCursors.set(session.sessionId, session.cursor);
    const children = new Set(session.children.map((child) => child.id));
    sessionChildren.set(session.sessionId, children);
    for (const child of children) childOwners.set(child, session.sessionId);
  }
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
  const projection = decodeHarnessSessionProjection(await invoke("harness_attach_session", {
    request: { sessionId: exactSessionId },
  }));
  if (projection.sessionId !== exactSessionId) fail();
  return projection;
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
  if (
    commandId !== exact.commandId
    || projected.sessionId !== exact.sessionId
    || projected.cursor.runtimeGeneration !== exact.expectedCursor.runtimeGeneration
    || projected.cursor.sequence !== exact.expectedCursor.sequence + 1
  ) fail();
  return deepFreeze({
    commandId,
    outcome: oneOf(source.outcome, new Set(["accepted", "queued", "reconciled"] as const)),
    session: projected,
  });
}

type Listener = (event: HarnessProjectionEvent) => void;
const listeners = new Set<Listener>();
let unlisten: Promise<UnlistenFn> | null = null;
let lastSequence = 0;
let eventStreamClosed = false;
const sessionCursors = new Map<string, HarnessCursor>();
const retiredGenerations = new Map<string, Set<string>>();
const childOwners = new Map<string, string>();
const sessionChildren = new Map<string, Set<string>>();

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
    try { event = decodeHarnessProjectionEvent(payload); } catch { eventStreamClosed = true; return; }
    if (event.sequence !== lastSequence + 1 || !acceptSessionCursor(event)) { eventStreamClosed = true; return; }
    lastSequence = event.sequence;
    for (const listener of listeners) listener(event);
  });
  await unlisten;
}

export function subscribeHarnessEvents(listener: Listener): () => void {
  listeners.add(listener);
  void ensureListener().catch(() => {
    eventStreamClosed = true;
    unlisten = null;
  });
  return () => { listeners.delete(listener); };
}

/** @deprecated Legacy session RPC remains isolated until verified Harness activation. */
export const legacyHarnessBridgeIsUnavailable = true as const;
