import { lstat, readFile } from "node:fs/promises";

import { decideCompatibility, type Compatibility } from "./compatibility.js";
import { parseClosedJson } from "./framing.js";
import type { RuntimeIdentity } from "./runtimeDiscovery.js";

const MAX_SCENARIO_BYTES = 4 * 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type ParentMessage =
  | { readonly channel: "parent"; readonly kind: "user" | "notice"; readonly id: string; readonly text: string; readonly emittedAtMs: number }
  | { readonly channel: "parent"; readonly kind: "assistant"; readonly id: string; readonly blocks: readonly Record<string, unknown>[]; readonly streaming: boolean; readonly emittedAtMs: number };

export interface FakeRootSessionSnapshot {
  readonly sessionId: string;
  readonly accountId: string | null;
  readonly projectId: string;
  readonly chatId: string;
  readonly cursor: Readonly<{ runtimeGeneration: string; sequence: number }>;
  readonly state: "idle" | "working" | "blocked" | "failed" | "disconnected" | "stopped";
  readonly parentMessages: readonly ParentMessage[];
  readonly children: readonly Readonly<Record<string, unknown>>[];
  readonly queue: readonly Readonly<Record<string, unknown>>[];
  readonly tools: readonly Readonly<Record<string, unknown>>[];
  readonly resources: readonly Readonly<Record<string, unknown>>[];
  readonly usage: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number | null }>;
}

export interface FakeDaemonScenario {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly runtime: RuntimeIdentity;
  readonly sessions: readonly FakeRootSessionSnapshot[];
}

type ScenarioRequest = Readonly<{ type: "discover_runtime" | "bootstrap" }>;
export type ScenarioResponse =
  | Readonly<{ type: "discover_runtime_result"; runtime: RuntimeIdentity; compatibility: Compatibility }>
  | Readonly<{ type: "bootstrap_result"; compatibility: Compatibility; sessions: readonly FakeRootSessionSnapshot[] }>
  | Readonly<{ type: "error"; code: string; message: string }>;

function invalid(): never {
  throw new TypeError("fake daemon scenario is invalid");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[!-~]{1,128}$/u.test(value)) invalid();
  return value;
}

function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || [...value].length > maximum) invalid();
  return value;
}

function integer(value: unknown, maximum = MAX_SAFE): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function nullableLabel(value: unknown): string | null {
  return value === null ? null : text(value, 200);
}

function runtime(value: unknown): RuntimeIdentity {
  const source = record(value, ["packageName", "packageVersion", "packageDigest", "entrypointDigest", "protocolName", "protocolVersion", "schemaRevision", "schemaId", "capabilities"]);
  if (source.packageName !== "prime-agent") invalid();
  const digest = (candidate: unknown) => {
    if (typeof candidate !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate)) invalid();
    return candidate;
  };
  const capabilities = array(source.capabilities, 128).map((item) => id(item));
  if (new Set(capabilities).size !== capabilities.length) invalid();
  return {
    packageName: "prime-agent",
    packageVersion: text(source.packageVersion, 64),
    packageDigest: digest(source.packageDigest),
    entrypointDigest: digest(source.entrypointDigest),
    protocolName: text(source.protocolName, 64),
    protocolVersion: integer(source.protocolVersion, 65_535),
    schemaRevision: integer(source.schemaRevision, 65_535),
    schemaId: text(source.schemaId, 128),
    capabilities,
  };
}

function block(value: unknown): Record<string, unknown> {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "text") {
    const source = record(value, ["kind", "text"]);
    return { kind, text: text(source.text, 131_072, true) };
  }
  if (kind === "thinking") {
    const source = record(value, ["kind", "text", "redacted"]);
    return { kind, text: text(source.text, 131_072, true), redacted: boolean(source.redacted) };
  }
  if (kind === "tool_call") {
    const source = record(value, ["kind", "toolCallId", "toolId", "status"]);
    return { kind, toolCallId: id(source.toolCallId), toolId: id(source.toolId), status: oneOf(source.status, ["pending", "running", "blocked", "succeeded", "failed"] as const) };
  }
  return invalid();
}

function message(value: unknown): ParentMessage {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "user" || kind === "notice") {
    const source = record(value, ["channel", "kind", "id", "text", "emittedAtMs"]);
    if (source.channel !== "parent") invalid();
    return { channel: "parent", kind, id: id(source.id), text: text(source.text, 131_072, true), emittedAtMs: integer(source.emittedAtMs) };
  }
  if (kind === "assistant") {
    const source = record(value, ["channel", "kind", "id", "blocks", "streaming", "emittedAtMs"]);
    if (source.channel !== "parent") invalid();
    return { channel: "parent", kind, id: id(source.id), blocks: array(source.blocks, 1024).map(block), streaming: boolean(source.streaming), emittedAtMs: integer(source.emittedAtMs) };
  }
  return invalid();
}

function snapshot(value: unknown): FakeRootSessionSnapshot {
  const source = record(value, ["sessionId", "accountId", "projectId", "chatId", "cursor", "state", "parentMessages", "children", "queue", "tools", "resources", "usage"]);
  const cursorSource = record(source.cursor, ["runtimeGeneration", "sequence"]);
  const usageSource = record(source.usage, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]);
  const input = integer(usageSource.input);
  const output = integer(usageSource.output);
  const cacheRead = integer(usageSource.cacheRead);
  const cacheWrite = integer(usageSource.cacheWrite);
  const totalTokens = integer(usageSource.totalTokens);
  if (input + output + cacheRead + cacheWrite !== totalTokens) invalid();
  const cost = usageSource.cost;
  if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 1e15)) invalid();
  const children = array(source.children, 256).map((value) => {
    const child = record(value, ["id", "status", "task", "provider", "model", "progress"]);
    const progress = child.progress;
    if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)) invalid();
    return { id: id(child.id), status: oneOf(child.status, ["queued", "running", "done", "error", "cancelled", "unknown"] as const), task: text(child.task, 200), provider: nullableLabel(child.provider), model: nullableLabel(child.model), progress };
  });
  const queue = array(source.queue, 256).map((value) => {
    const item = record(value, ["id", "label", "state"]);
    return { id: id(item.id), label: text(item.label, 200), state: oneOf(item.state, ["queued", "admitted", "running", "cancelled"] as const) };
  });
  const tools = array(source.tools, 512).map((value) => {
    const item = record(value, ["id", "label", "enabled", "configurable"]);
    return { id: id(item.id), label: text(item.label, 200), enabled: boolean(item.enabled), configurable: boolean(item.configurable) };
  });
  const resources = array(source.resources, 512).map((value) => {
    const item = record(value, ["id", "label", "kind", "availability"]);
    return { id: id(item.id), label: text(item.label, 200), kind: id(item.kind), availability: oneOf(item.availability, ["available", "unavailable"] as const) };
  });
  const sessionId = id(source.sessionId);
  const childIds = children.map((child) => child.id);
  if (childIds.includes(sessionId) || new Set(childIds).size !== childIds.length) invalid();
  return {
    sessionId,
    accountId: source.accountId === null ? null : id(source.accountId),
    projectId: id(source.projectId),
    chatId: id(source.chatId),
    cursor: { runtimeGeneration: id(cursorSource.runtimeGeneration), sequence: integer(cursorSource.sequence) },
    state: oneOf(source.state, ["idle", "working", "blocked", "failed", "disconnected", "stopped"] as const),
    parentMessages: array(source.parentMessages, 300).map(message), children, queue, tools, resources,
    usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: cost as number | null },
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

export async function loadFakeDaemonScenario(path: string): Promise<FakeDaemonScenario> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SCENARIO_BYTES) invalid();
  const bytes = await readFile(path);
  if (bytes.length > MAX_SCENARIO_BYTES) invalid();
  const source = record(parseClosedJson(bytes.toString("utf8")), ["schemaVersion", "name", "runtime", "sessions"]);
  if (source.schemaVersion !== 1) invalid();
  const sessions = array(source.sessions, 256).map(snapshot);
  const rootIds = sessions.map((session) => session.sessionId);
  if (new Set(rootIds).size !== rootIds.length) invalid();
  const childIds = sessions.flatMap((session) => session.children.map((child) => id(child.id)));
  if (new Set(childIds).size !== childIds.length || childIds.some((id) => rootIds.includes(id))) invalid();
  const result: FakeDaemonScenario = { schemaVersion: 1, name: id(source.name), runtime: runtime(source.runtime), sessions };
  if (!(["ready", "degraded"] as const).includes(decideCompatibility(result.runtime).status as "ready" | "degraded")) invalid();
  return deepFreeze(result);
}

export function replyToFakeDaemonRequest(scenario: FakeDaemonScenario, request: ScenarioRequest): ScenarioResponse {
  const compatibility = decideCompatibility(scenario.runtime);
  if (request.type === "discover_runtime") return deepFreeze({ type: "discover_runtime_result", runtime: scenario.runtime, compatibility });
  if (request.type === "bootstrap") return deepFreeze({ type: "bootstrap_result", compatibility, sessions: scenario.sessions });
  return deepFreeze({ type: "error", code: "unsupported_command", message: "Fake daemon command is not implemented" });
}
