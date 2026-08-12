import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { decideCompatibility } from "./compatibility.js";
import type { FakeRootSessionSnapshot, ParentMessage, ScenarioRequest, ScenarioResponse } from "./fakeDaemonScenario.js";
import { discoverRuntime, type RuntimeIdentity } from "./runtimeDiscovery.js";
import { loadReviewedPrimeAdapter } from "./reviewedPrimeAdapter.js";
import { parseStudioHarnessOperation, StudioHarnessOperationDispatcher, type StudioHarnessOperationOutcome } from "./studioHarnessOperations.js";
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
  subscribe?(listener: (event: unknown) => void): () => void;
};

export interface PrimeDaemonBridgePorts {
  readonly identity: RuntimeIdentity;
  readonly client: DaemonClientPort;
  readonly attach: (client: DaemonClientPort, activeSessionId: string) => Promise<DaemonConnectionPort>;
  readonly expectedSocketPath?: string;
  readonly expectedDaemonEntrypoint?: string;
  readonly runtimeClosure?: RuntimeClosureLock;
}

export interface PrimeHarnessInspectorDetails {
  readonly observedAtMs: number;
  readonly startedAtMs: number | null;
  readonly context: Readonly<{ usedTokens: number; capacityTokens: number; turns?: number; samples?: readonly number[] }> | null;
  readonly contributions: readonly Readonly<{ id: string; label: string; tokens: number }>[];
  readonly notices: readonly Readonly<{ id: string; kind: "info" | "warning" | "error"; title: string; detail: string; retryable: boolean; dismissible: boolean }>[];
  readonly activity: readonly Readonly<{
    id: string; occurredAtMs: number; group: string; kind: "agent" | "tool" | "file" | "system"; title: string; detail: string; childId?: string; filePath?: string;
    tool?: Readonly<{ command: string; status: "pending" | "running" | "blocked" | "succeeded" | "failed"; durationMs: number | null; files: readonly string[] }>;
  }>[];
  /** candidatePath is broker-private input and is stripped before details reach the renderer. */
  readonly outputs: readonly Readonly<{ id: string; label: string; candidatePath: string; kind: string }>[];
  readonly sources: readonly Readonly<{ id: string; label: string; detail: string; kind: string; candidatePath?: string }>[];
  readonly children: Readonly<Record<string, Readonly<{
    summary: string; startedAtMs: number | null; context: PrimeHarnessInspectorDetails["context"];
    transcript: readonly Readonly<{ id: string; actor: string; occurredAtMs: number; text: string }>[];
    activity: readonly Readonly<{ id: string; occurredAtMs: number; label: string }>[];
    files: readonly Readonly<{ id: string; path: string; change: "added" | "modified" | "deleted" | "read" }>[];
    error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
  }>>>;
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
  unsubscribe?: () => void;
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
function messageId(message: unknown, index: number): string {
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

function projectId(cwd: string): string { return stableId("project", cwd.toLocaleLowerCase("en-US")); }
function residentMarker(creationId: string, fingerprint: string, name: string): Readonly<{ prefix: string; marker: string }> {
  const prefix = `prime-studio:${createHash("sha256").update(creationId).digest("hex").slice(0, 24)}:`;
  const fingerprintTag = `${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}:`;
  return Object.freeze({ prefix, marker: prefix + fingerprintTag + [...name].slice(0, 200 - prefix.length - fingerprintTag.length).join("") });
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
  readonly #connections = new Map<string, BoundConnection>();
  readonly #commands = new Map<string, Readonly<{ fingerprint: string; response: Extract<ScenarioResponse, { type: "command_result" }> }>>();
  readonly #creations = new Map<string, Readonly<{ fingerprint: string; response: Extract<ScenarioResponse, { type: "resident_created" }> }>>();
  readonly #operationDispatchers = new Map<string, StudioHarnessOperationDispatcher>();
  #hello: DaemonHelloLike | null = null;

  constructor(ports: PrimeDaemonBridgePorts) {
    this.#identity = ports.identity;
    this.#client = ports.client;
    this.#attachPort = ports.attach;
    this.#expectedSocketPath = ports.expectedSocketPath;
    this.#expectedDaemonEntrypoint = ports.expectedDaemonEntrypoint;
    this.#runtimeClosure = ports.runtimeClosure;
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

  async inspector(activeSessionId: string): Promise<PrimeHarnessInspectorDetails> {
    const [initialRaw, contextRaw, statsRaw, resourcesRaw] = await Promise.all([
      this.#call(activeSessionId, "getInitialSnapshot"),
      this.#call(activeSessionId, "getSessionContext"),
      this.#call(activeSessionId, "getSessionStats"),
      this.#call(activeSessionId, "getResourceSnapshot"),
    ]);
    const initial = plain(initialRaw) ? initialRaw : {};
    const context = plain(contextRaw) ? contextRaw : {};
    const stats = plain(statsRaw) ? statsRaw : {};
    const contextUsage = plain(stats.contextUsage) ? stats.contextUsage : plain((plain(initial.state) ? initial.state : {}).contextUsage) ? (initial.state as Record<string, unknown>).contextUsage as Record<string, unknown> : {};
    const usedTokens = safeInteger(contextUsage.tokens ?? (plain(stats.tokens) ? stats.tokens.total : 0));
    const capacityTokens = safeInteger(contextUsage.contextWindow ?? contextUsage.capacityTokens);
    const messages = Array.isArray(initial.messages) ? initial.messages : Array.isArray(context.messages) ? context.messages : [];
    const activity: Array<PrimeHarnessInspectorDetails["activity"][number]> = [];
    const toolCalls = new Map<string, Readonly<{ command: string; files: readonly string[] }>>();
    for (const raw of messages) {
      if (!plain(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
      for (const block of raw.content) {
        if (!plain(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
        const input = plain(block.arguments) ? block.arguments : plain(block.input) ? block.input : {};
        const command = [input.command, input.cmd, block.name].find((value) => typeof value === "string") as string | undefined;
        const candidateFiles = [input.path, input.filePath, input.filename].filter((value): value is string => typeof value === "string");
        toolCalls.set(block.id, { command: boundedString(command ?? String(block.name ?? "Tool"), 32_768, true), files: candidateFiles.slice(0, 128).map((file) => boundedString(file, 4096)) });
      }
    }
    for (const [index, raw] of messages.entries()) {
      if (!plain(raw)) continue;
      const occurredAtMs = safeInteger(raw.timestamp);
      if (raw.role === "toolResult") {
        const detail = contentText(raw.content);
        const call = typeof raw.toolCallId === "string" ? toolCalls.get(raw.toolCallId) : undefined;
        const title = typeof raw.toolName === "string" ? boundedString(raw.toolName, 200) : "Tool";
        activity.push({
          id: messageId(raw, index), occurredAtMs, group: "Tools", kind: "tool", title, detail,
          tool: {
            command: call?.command ?? title,
            status: raw.isError === true || raw.error === true ? "failed" : "succeeded",
            durationMs: typeof raw.durationMs === "number" ? safeInteger(raw.durationMs) : null,
            files: call?.files ?? [],
          },
        });
      }
    }
    const resources = plain(resourcesRaw) ? resourcesRaw : {};
    const outputs: Array<PrimeHarnessInspectorDetails["outputs"][number]> = [];
    const sources: Array<PrimeHarnessInspectorDetails["sources"][number]> = [];
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
        const transcript: Array<{ id: string; actor: string; occurredAtMs: number; text: string }> = [];
        let error: { code: string; message: string; retryable: boolean } | null = raw.status === "error"
          ? { code: "child_failed", message: typeof raw.error === "string" ? boundedString(raw.error, 200) : "Child agent failed.", retryable: false }
          : null;
        if (typeof raw.activeSessionId === "string") {
          try {
            const watcher = await this.#call(activeSessionId, "watchSession", raw.activeSessionId);
            if (plain(watcher) && typeof watcher.getMessages === "function" && typeof watcher.close === "function") {
              try {
                const childMessages = await (watcher.getMessages as () => Promise<unknown[]>).call(watcher);
                for (const [index, message] of childMessages.slice(-300).entries()) {
                  if (!plain(message)) continue;
                  transcript.push({ id: messageId(message, index), actor: typeof message.role === "string" ? message.role : "system", occurredAtMs: safeInteger(message.timestamp), text: contentText(message.content) });
                }
              } finally {
                await (watcher.close as () => Promise<void>).call(watcher);
              }
            }
          } catch {
            error ??= { code: "child_transcript_unavailable", message: "Child transcript is unavailable from the installed Harness.", retryable: true };
          }
        }
        children[childId] = Object.freeze({
          summary: typeof raw.recap === "string" ? boundedString(raw.recap, 200) : typeof raw.label === "string" ? boundedString(raw.label, 200) : "Subagent",
          startedAtMs: null,
          context: typeof raw.tokenCount === "number" ? { usedTokens: safeInteger(raw.tokenCount), capacityTokens: 0 } : null,
          transcript, activity: [], files: [], error,
        });
      }
    }
    return Object.freeze({
      observedAtMs: Date.now(), startedAtMs: null,
      context: capacityTokens > 0 || usedTokens > 0 ? { usedTokens, capacityTokens, turns: messages.length } : null,
      contributions: Object.freeze(Object.entries(children).flatMap(([id, child]) => child.context ? [{ id, label: child.summary, tokens: child.context.usedTokens }] : [])),
      notices: Object.freeze([]), activity: Object.freeze(activity.slice(-300)), outputs: Object.freeze(outputs),
      sources: Object.freeze(sources.slice(0, 512)), children: Object.freeze(children),
    });
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
        await Promise.all([...this.#connections.entries()].map(async ([activeSessionId, bound]) => {
          bound.unsubscribe?.();
          await bound.connection.dispose();
          bound.connection = await this.#attachPort(this.#client, activeSessionId);
          delete bound.unsubscribe;
          const unsubscribe = bound.connection.subscribe?.(() => {
            bound.eventRevision += 1n;
            bound.dirty = true;
          });
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

  async snapshot(activeSessionId: string, minimumSequence = 0, allowGenerationChange = true): Promise<FakeRootSessionSnapshot> {
    const hello = await this.negotiate();
    const bound = await this.#bound(activeSessionId);
    const barrier = await this.#openBarrier(activeSessionId, bound);
    const publicationEventRevision = barrier.eventRevision;
    const initial = barrier.source;
    await barrier.close();
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
    const completedToolCalls = new Set(rawMessages.flatMap((raw) => plain(raw) && raw.role === "toolResult" && typeof raw.toolCallId === "string" ? [raw.toolCallId] : []));
    const upstreamMessageIds = sessionTreeMessageIds(source.sessionTree);
    const messages: ParentMessage[] = [];
    for (const [index, raw] of [...rawMessages, ...(streaming ? [streaming] : [])].slice(-300).entries()) {
      if (!plain(raw)) continue;
      const signature = JSON.stringify(raw).slice(0, 16_384);
      const id = upstreamMessageIds.get(signature)?.shift() ?? messageId(raw, index);
      const emittedAtMs = safeInteger(raw.timestamp);
      if (raw.role === "user") messages.push({ channel: "parent", kind: "user", id, text: contentText(raw.content), emittedAtMs });
      else if (raw.role === "assistant") messages.push({ channel: "parent", kind: "assistant", id, blocks: messageBlocks(raw, completedToolCalls, raw === streaming), streaming: raw === streaming, emittedAtMs });
      else messages.push({ channel: "parent", kind: "notice", id, text: contentText(raw.content), emittedAtMs });
    }
    const children = Array.isArray(source.children) ? source.children.slice(0, 256).flatMap((raw) => {
      if (!plain(raw) || typeof raw.id !== "string") return [];
      const status = ["queued", "running", "done", "error", "cancelled"].includes(String(raw.status)) ? raw.status as "queued" | "running" | "done" | "error" | "cancelled" : "unknown" as const;
      const model = typeof raw.model === "string" ? boundedString(raw.model, 200) : null;
      const separator = model?.indexOf("/") ?? -1;
      return [{ id: boundedString(raw.id, 128), status, task: boundedString(raw.label ?? raw.recap ?? "Subagent", 200), provider: separator > 0 ? model!.slice(0, separator) : null, model: separator > 0 ? model!.slice(separator + 1) : model, progress: status === "done" ? 1 : null }];
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
    const snapshot = Object.freeze({
      sessionId: activeSessionId, accountId: null, projectId: projectId(cwd), chatId,
      cursor: { runtimeGeneration: observedCursor.generation, sequence: nextSequence }, state: rootState(state),
      parentMessages: messages, children, queue, tools, resources: resources.slice(0, 512),
      usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: typeof stats.cost === "number" && Number.isFinite(stats.cost) && stats.cost >= 0 ? stats.cost : null },
    });
    bound.sequence = nextSequence;
    bound.initialized = true;
    bound.publishedUpstreamSequence = observedCursor.sequence;
    bound.publishedUpstreamGeneration = observedCursor.generation;
    bound.studioGeneration = observedCursor.generation;
    bound.dirty = bound.eventRevision !== publicationEventRevision;
    return snapshot;
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
      eventRevision: 0n, dirty: false,
    };
    if (connection.subscribe) {
      bound.unsubscribe = connection.subscribe(() => {
        bound.eventRevision += 1n;
        bound.dirty = true;
      });
    }
    this.#connections.set(activeSessionId, bound);
    return bound;
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
