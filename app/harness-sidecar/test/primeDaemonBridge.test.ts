import assert from "node:assert/strict";
import test from "node:test";

test("runtime closure is descriptor-bound and detects post-verification mutation", async (context) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { lockVerifiedRuntimeClosure } = await import("../src/runtimeClosure.js");
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-closure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  const path = join(root, "dist", "index.js");
  const bytes = Buffer.from("export const value = 1;\n");
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(Buffer.from(`dist/index.js\0${bytes.length}\0`)).update(bytes).digest("hex");
  const lock = await lockVerifiedRuntimeClosure(root, { files: 1, digest: `sha256:${digest}` });
  context.after(() => lock.close());
  await lock.verify();
  try { await writeFile(path, "export const value = 2;\n"); } catch { return; }
  await assert.rejects(lock.verify(), /changed/);
});

test("verified daemon hello is required before production operations", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const calls: string[] = [];
  const bridge = new PrimeDaemonBridge({
    identity: {
      packageName: "prime-agent",
      packageVersion: "0.7.1",
      packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
      entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "protocol-7-schema-13-816309b1cd50",
      capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
    },
    client: {
      async connect() { calls.push("connect"); },
      async waitForHello() {
        return {
          type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 },
          schemaRevision: 12, schemaId: "old", appVersion: "0.7.1", supervisorGeneration: "generation-1",
          clientId: "client-1", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"],
        };
      },
      async request() { calls.push("request"); return { type: "response", command: "list", success: true, data: [] }; },
      close() { calls.push("close"); },
    },
    attach: async () => { throw new Error("must not attach"); },
  });

  await assert.rejects(bridge.bootstrap(), /schema/i);
  assert.deepEqual(calls, ["connect", "close"]);
});

test("bootstrap and prompt use real daemon state with generation and cursor binding", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let prompt = "";
  const state = {
    activeSessionId: "active-root", cwd: "C:\\work\\project", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: ["high"], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "session-root", leafId: "entry-1",
    autoCompactionEnabled: true, messageCount: 1, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [],
    activeToolNames: ["ipython"], contextUsage: { tokens: 21 }, model: { provider: "openai", id: "gpt-test", name: "GPT Test" },
  };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [{ role: "user", content: "hello", timestamp: 1 }], children: [], lastEventCursor: { generation: "generation-1", sequence: 4 } }; },
    async getState() { return state; },
    async getMessages() { return [{ role: "user", content: "hello", timestamp: 1 }]; },
    async getQueue() { return { steering: [], followUp: [] }; },
    async getResourceSnapshot() { return { contextFiles: [], skills: [], prompts: [], extensions: [], themes: [], diagnostics: { skills: [], prompts: [], extensions: [], themes: [] } }; },
    async getSessionStats() { return { tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, total: 20 }, cost: 0.01 }; },
    async getToolDefinition(name: string) { return { name, label: "IPython", description: "", parameters: {} }; },
    async prompt(text: string) { prompt = text; },
    async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: {
      packageName: "prime-agent", packageVersion: "0.7.1",
      packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
      entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
      protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13,
      schemaId: "protocol-7-schema-13-816309b1cd50",
      capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
    },
    client: {
      async connect() {},
      async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "client-1", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "active-root", sessionId: "session-root", cwd: "C:\\work\\project", lifecycle: "live", activity: "idle", isSessionActive: true, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1, sessionActions: {}, workerState: "ready" }] } }; },
      close() {},
    },
    attach: async () => connection,
  });

  const boot = await bridge.bootstrap();
  assert.equal(boot.type, "bootstrap_result");
  assert.equal(boot.type === "bootstrap_result" ? boot.sessions[0]?.cursor.sequence : -1, 4);
  const result = await bridge.handle({ type: "session_command", sessionId: "active-root", commandId: "command-1", expectedCursor: { runtimeGeneration: "generation-1", sequence: 4 }, kind: "prompt", text: "do work" });
  assert.equal(prompt, "do work");
  assert.equal(result.type, "command_result");
  assert.equal(result.type === "command_result" ? result.snapshot.cursor.sequence : -1, 5);
  const replay = await bridge.handle({ type: "session_command", sessionId: "active-root", commandId: "command-1", expectedCursor: { runtimeGeneration: "generation-1", sequence: 4 }, kind: "prompt", text: "do work" });
  assert.equal(replay.type === "command_result" ? replay.outcome : "", "reconciled");
});

test("a daemon event dirties the published projection and blocks stale mutation admission", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let upstreamSequence = 4;
  const eventListeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => eventListeners.forEach((listener) => listener(event));
  let prompts = 0;
  const state = {
    activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null,
    autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [],
  };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return { steering: [], followUp: [] }; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() { prompts += 1; }, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
    subscribe(listener: (event: unknown) => void) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });
  const first = await bridge.attach("root");
  assert.equal(first.cursor.sequence, 4);
  upstreamSequence = 5;
  emit({ type: "message_update" });
  const operation = await bridge.executeOperation("root", {
    operationId: "operation-stale", action: "harness.session.prompt",
    payload: { sessionId: "root", text: "must not run" }, expectedCursor: first.cursor,
    idempotencyKey: "operation-stale-key",
  });
  assert.equal(operation.status, "rejected");
  const result = await bridge.handle({ type: "session_command", sessionId: "root", commandId: "command-stale", expectedCursor: first.cursor, kind: "prompt", text: "must not run" });
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.code : "", "stale_cursor");
  assert.equal(prompts, 0);
  const refreshed = await bridge.snapshot("root");
  assert.equal(refreshed.cursor.sequence, 5);
});

test("extension prompts project only verified dialog events and respond exactly once within their session cursor", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let upstreamSequence = 4;
  const listeners = new Set<(event: unknown) => void>();
  const responses: Array<Readonly<{ requestId: string; response: unknown }>> = [];
  let failResponse = false;
  const state = { activeSessionId: "root-a", cwd: "C:\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat-a", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = (sessionId: string) => ({
    async getInitialSnapshot() { return { state: { ...state, activeSessionId: sessionId, sessionId: `chat-${sessionId}` }, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {} }; }, async getSessionContext() { return {}; }, async getModelCatalog() { return { models: [] }; }, async getToolDefinition() { return undefined; },
    async respondToExtensionUiRequest(requestId: string, response: unknown) { responses.push({ requestId, response }); if (failResponse) throw new Error("response outcome lost"); },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "extension_ui", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: ["root-a", "root-b"].map((activeSessionId) => ({ activeSessionId, isSessionActive: true, workerState: "ready" })) } }; }, close() {} },
    attach: async (_client, sessionId) => connection(sessionId),
  });
  await bridge.attach("root-a");
  upstreamSequence = 5;
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "notification-1", method: "notify", payload: { title: "Background notice", message: "Do not render as a prompt." } } });
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "request-1", method: "select", payload: { title: "Choose a branch", options: ["main", "release"] } } });
  const current = await bridge.snapshot("root-a");
  const details = await bridge.inspector("root-a");
  assert.deepEqual((details as unknown as { extensionUi: unknown }).extensionUi, { status: "available", requests: [{ id: "request-1", method: "select", title: "Choose a branch", options: ["main", "release"], cursor: current.cursor }] });
  assert.equal(current.parentMessages.length, 0, "extension UI must not enter the parent transcript");

  const stale = await bridge.executeOperation("root-a", { operationId: "stale", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "request-1", response: { value: "main" } }, expectedCursor: { ...current.cursor, sequence: current.cursor.sequence - 1 }, idempotencyKey: "stale" });
  const crossed = await bridge.executeOperation("root-b", { operationId: "crossed", action: "harness.extension.respond", payload: { sessionId: "root-b", requestId: "request-1", response: { value: "main" } }, expectedCursor: (await bridge.attach("root-b")).cursor, idempotencyKey: "crossed" });
  assert.equal(stale.status, "rejected");
  assert.equal(crossed.status, "rejected");
  assert.equal(responses.length, 0);

  const accepted = await bridge.executeOperation("root-a", { operationId: "respond-1", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "request-1", response: { value: "release" } }, expectedCursor: current.cursor, idempotencyKey: "respond-1" });
  const replay = await bridge.executeOperation("root-a", { operationId: "respond-2", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "request-1", response: { cancelled: true } }, expectedCursor: current.cursor, idempotencyKey: "respond-2" });
  assert.equal(accepted.status, "updated");
  assert.equal(replay.status, "rejected");
  assert.deepEqual(responses, [{ requestId: "request-1", response: { value: "release" } }]);

  upstreamSequence = 6;
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "request-2", method: "confirm", payload: { title: "Continue?", message: "Proceed?" } } });
  const next = await bridge.snapshot("root-a");
  failResponse = true;
  const unknown = await bridge.executeOperation("root-a", { operationId: "respond-unknown", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "request-2", response: { confirmed: true } }, expectedCursor: next.cursor, idempotencyKey: "respond-unknown" });
  const unknownReplay = await bridge.executeOperation("root-a", { operationId: "respond-unknown-replay", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "request-2", response: { cancelled: true } }, expectedCursor: next.cursor, idempotencyKey: "respond-unknown-replay" });
  assert.equal(unknown.status, "unknown_outcome");
  assert.equal(unknownReplay.status, "rejected");
  assert.equal(responses.filter((item) => item.requestId === "request-2").length, 1);

  upstreamSequence = 7;
  failResponse = false;
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "editor-timeout", method: "editor", payload: { title: "Instructions", prefill: "Review this.", timeout: 30_000 } } });
  const editorSnapshot = await bridge.snapshot("root-a");
  assert.deepEqual((await bridge.inspector("root-a")).extensionUi, { status: "available", requests: [{ id: "editor-timeout", method: "editor", title: "Instructions", prefill: "Review this.", cursor: editorSnapshot.cursor }] });
  const editorCancelled = await bridge.executeOperation("root-a", { operationId: "cancel-editor", action: "harness.extension.respond", payload: { sessionId: "root-a", requestId: "editor-timeout", response: { cancelled: true } }, expectedCursor: editorSnapshot.cursor, idempotencyKey: "cancel-editor" });
  assert.equal(editorCancelled.status, "updated");

  upstreamSequence = 8;
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "invalid-input", method: "input", payload: { title: "Name", placeholder: null } } });
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "invalid-timeout", method: "confirm", payload: { title: "Continue?", message: "Proceed?", timeout: null } } });
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "invalid-editor-null-timeout", method: "editor", payload: { title: "Instructions", timeout: null } } });
  for (const listener of listeners) listener({ type: "extension_ui_request", request: { id: "invalid-editor-string-timeout", method: "editor", payload: { title: "Instructions", timeout: "soon" } } });
  await bridge.snapshot("root-a");
  assert.deepEqual((await bridge.inspector("root-a")).extensionUi, { status: "unavailable", reason: "The Harness emitted extension UI evidence that Studio could not verify safely." });
});

test("extension consumed identity capacity fails closed without evicting replay evidence", async () => {
  const { addConsumedExtensionRequestIds } = await import("../src/primeDaemonBridge.js");
  const ledger = new Set(Array.from({ length: 4_096 }, (_, index) => `request-${index}`));
  assert.equal(addConsumedExtensionRequestIds(ledger, ["request-0"]), true, "an existing replay identity remains recognized at capacity");
  assert.equal(addConsumedExtensionRequestIds(ledger, ["request-overflow"]), false);
  assert.equal(ledger.size, 4_096);
  assert.equal(ledger.has("request-0"), true);
  assert.equal(ledger.has("request-overflow"), false);
});

test("projects parent turn performance from admitted events using a monotonic clock without child leakage or double counting", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let upstreamSequence = 4;
  let now = 0;
  let queueGate: Promise<void> | null = null;
  let markQueueReached: (() => void) | null = null;
  const eventListeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => eventListeners.forEach((listener) => listener(event));
  const state = {
    activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null,
    autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [],
  };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { markQueueReached?.(); if (queueGate) await queueGate; return {}; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
    subscribe(listener: (event: unknown) => void) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
    monotonicNow: () => now,
  });

  const initial = await bridge.attach("root");
  assert.deepEqual(initial.performance, { status: "unavailable", sessionId: "root", cursor: initial.cursor, reason: "event_chronology_unavailable" });
  const sessionEvent = (event: unknown) => ({ type: "session_event", event });
  now = 100; emit(sessionEvent({ type: "agent_start" }));
  now = 101; emit(sessionEvent({ type: "turn_start" }));
  now = 110; emit(sessionEvent({ type: "message_start", message: { role: "user", content: "Prompt" } }));
  now = 111; emit(sessionEvent({ type: "message_end", message: { role: "user", content: "Prompt" } }));
  now = 140; emit(sessionEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
  now = 150; emit(sessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }] }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }] } } }));
  now = 250; emit(sessionEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 } } }));
  now = 260; emit(sessionEvent({ type: "message_start", message: { role: "toolResult", toolCallId: "tool-1", content: [] } }));
  now = 261; emit(sessionEvent({ type: "message_end", message: { role: "toolResult", toolCallId: "tool-1", content: [] } }));
  now = 270; emit(sessionEvent({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [{ role: "toolResult", content: [] }] }));
  now = 280; emit(sessionEvent({ type: "turn_start" }));
  now = 285; emit(sessionEvent({ type: "rlm_child_update", child: { id: "private" } }));
  now = 290; emit(sessionEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
  now = 300; emit(sessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: { role: "assistant", content: [{ type: "text", text: "Hello" }] } } }));
  now = 400; emit(sessionEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input: 10, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 50 } } }));
  now = 410; emit(sessionEvent({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }));
  now = 420; emit(sessionEvent({ type: "agent_end", messages: [] }));
  upstreamSequence = 10;

  const completed = await bridge.snapshot("root");
  assert.deepEqual(completed.performance, {
    status: "available", sessionId: "root", cursor: completed.cursor,
    firstTokenLatencyMs: 50, outputTokens: 50, generationDurationMs: 200, tokensPerSecond: 250,
  });

  now = 500; emit(sessionEvent({ type: "agent_start" }));
  now = 510; emit(sessionEvent({ type: "turn_start" }));
  now = 520; emit(sessionEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
  let releaseQueue!: () => void;
  queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queueReached = new Promise<void>((resolve) => { markQueueReached = resolve; });
  const racingSnapshot = bridge.snapshot("root");
  await queueReached;
  now = 560; emit(sessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Later" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Later", partial: { role: "assistant", content: [{ type: "text", text: "Later" }] } } }));
  now = 660; emit(sessionEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Later" }], usage: { input: 1, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 21 } } }));
  now = 670; emit(sessionEvent({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }));
  now = 680; emit(sessionEvent({ type: "agent_end", messages: [] }));
  queueGate = null;
  markQueueReached = null;
  releaseQueue();
  const atomicallyBound = await racingSnapshot;
  assert.deepEqual(atomicallyBound.performance, { status: "unavailable", sessionId: "root", cursor: atomicallyBound.cursor, reason: "event_chronology_incomplete" });
  const next = await bridge.snapshot("root");
  assert.equal(next.performance.status, "available");

  emit({ type: "connection_status", status: "reconnecting" });
  const afterReconnect = await bridge.snapshot("root");
  assert.deepEqual(afterReconnect.performance, { status: "unavailable", sessionId: "root", cursor: afterReconnect.cursor, reason: "generation_changed" });
});

test("fails turn performance closed for malformed chronology, regressing clocks, and generation changes", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let generation = "generation-1";
  let upstreamSequence = 1;
  let now = 10;
  const eventListeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => eventListeners.forEach((listener) => listener(event));
  const state = { activeSessionId: "root", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat", activeToolNames: [] };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation, sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {}, subscribe(listener: (event: unknown) => void) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: generation, clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection, monotonicNow: () => now,
  });
  await bridge.attach("root");
  emit({ type: "session_event", event: { type: "agent_start" } });
  now = 9;
  emit({ type: "session_event", event: { type: "message_start", message: { role: "assistant", content: [] } } });
  now = 20; emit({ type: "session_event", event: { type: "agent_end" } });
  upstreamSequence = 2;
  const invalid = await bridge.snapshot("root");
  assert.equal(invalid.performance.status, "unavailable");
  assert.equal(invalid.performance.status === "unavailable" ? invalid.performance.reason : "", "event_chronology_invalid");

  generation = "generation-2";
  upstreamSequence = 1;
  const replaced = await bridge.snapshot("root");
  assert.deepEqual(replaced.performance, { status: "unavailable", sessionId: "root", cursor: replaced.cursor, reason: "generation_changed" });

  now = 30; emit({ type: "session_event", event: { type: "agent_start" } });
  now = 31; emit({ type: "session_event", event: { type: "agent_start" } });
  now = 32; emit({ type: "session_event", event: { type: "agent_end", messages: [] } });
  upstreamSequence = 2;
  const duplicateStart = await bridge.snapshot("root");
  assert.equal(duplicateStart.performance.status === "unavailable" ? duplicateStart.performance.reason : "", "event_chronology_invalid");

  emit({ type: "connection_status", status: "reconnecting" });
  now = 40; emit({ type: "session_event", event: { type: "agent_start" } });
  now = 41; emit({ type: "session_event", event: { type: "future_chronology_event" } });
  now = 42; emit({ type: "session_event", event: { type: "agent_end", messages: [] } });
  upstreamSequence = 3;
  const unknownEvent = await bridge.snapshot("root");
  assert.equal(unknownEvent.performance.status === "unavailable" ? unknownEvent.performance.reason : "", "event_chronology_invalid");
});

test("each published snapshot advances exactly one Studio revision even without an upstream event", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = { async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: 9 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });
  const first = await bridge.attach("root");
  const second = await bridge.snapshot("root");
  const third = await bridge.snapshot("root");
  assert.deepEqual([first.cursor.sequence, second.cursor.sequence, third.cursor.sequence], [9, 10, 11]);
});

test("parent history pages are bounded, parent-only, and cursor-bound to one exact snapshot", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let upstreamSequence = 7;
  const messages = [
    ...Array.from({ length: 405 }, (_, index) => ({ channel: "parent", role: "user", id: `entry-${index}`, content: `message ${index}`, timestamp: index })),
    { channel: "child", role: "user", id: "private-child", content: "never project", timestamp: 999 },
  ];
  const state = { activeSessionId: "root-a", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat-a", activeToolNames: [] };
  const connection = (sessionId: string) => ({
    async getInitialSnapshot() { return { state: { ...state, activeSessionId: sessionId, sessionId: `chat-${sessionId}` }, messages, streamingMessage: { channel: "parent", role: "assistant", id: "streaming-parent", content: "in flight", timestamp: 1_000 }, children: [], lastEventCursor: { generation: "generation-1", sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return messages; }, async getQueue() { return {}; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: ["root-a", "root-b"].map((activeSessionId) => ({ activeSessionId, isSessionActive: true, workerState: "ready" })) } }; }, close() {} },
    attach: async (_client, sessionId) => connection(sessionId),
  });

  const snapshot = await bridge.attach("root-a");
  assert.equal(snapshot.parentMessages[0]?.id, "entry-106");
  assert.equal(snapshot.parentMessages.at(-1)?.id, "streaming-parent");
  assert.equal(snapshot.parentMessages.some((message) => message.id === "private-child"), false);
  const firstOmitted = await bridge.handle({ type: "conversation_history_page", sessionId: "root-a", expectedCursor: snapshot.cursor, before: null } as never);
  assert.equal(firstOmitted.type, "conversation_history_page_result");
  if (firstOmitted.type !== "conversation_history_page_result") return;
  assert.equal(firstOmitted.page.totalMessages, 406);
  assert.equal(firstOmitted.page.messages.length, 100);
  assert.equal(firstOmitted.page.messages[0]?.id, "entry-6");
  assert.equal(firstOmitted.page.messages[99]?.id, "entry-105");
  assert.equal(firstOmitted.page.messages.at(-1)?.id, "entry-105");
  assert.equal(firstOmitted.page.omittedBefore, 6);
  assert.equal(firstOmitted.page.omittedAfter, 300);
  assert.match(firstOmitted.page.olderCursor ?? "", /^[!-~]{1,128}$/u);
  assert.equal(firstOmitted.page.messages.some((message) => message.id === "private-child"), false);

  const older = await bridge.handle({ type: "conversation_history_page", sessionId: "root-a", expectedCursor: snapshot.cursor, before: firstOmitted.page.olderCursor } as never);
  assert.equal(older.type === "conversation_history_page_result" ? older.page.messages[0]?.id : "", "entry-0");
  assert.equal(older.type === "conversation_history_page_result" ? older.page.omittedBefore : -1, 0);
  assert.equal(older.type === "conversation_history_page_result" ? older.page.omittedAfter : -1, 400);

  const crossed = await bridge.handle({ type: "conversation_history_page", sessionId: "root-b", expectedCursor: snapshot.cursor, before: firstOmitted.page.olderCursor } as never);
  assert.equal(crossed.type === "error" ? crossed.code : "", "invalid_history_cursor");
  upstreamSequence += 1;
  const stale = await bridge.handle({ type: "conversation_history_page", sessionId: "root-a", expectedCursor: snapshot.cursor, before: firstOmitted.page.olderCursor } as never);
  assert.equal(stale.type === "error" ? stale.code : "", "stale_cursor");
});

test("parent history is explicitly unavailable without an atomic bounded source window", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat", activeToolNames: [] };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => ({ async getInitialSnapshot() { return { state, children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} }),
  });
  const snapshot = await bridge.attach("root");
  const result = await bridge.handle({ type: "conversation_history_page", sessionId: "root", expectedCursor: snapshot.cursor, before: null } as never);
  assert.equal(result.type === "error" ? result.code : "", "history_unavailable");
});

test("parent history fails explicitly when the next row cannot fit instead of issuing a zero-progress cursor", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const hugeBlocks = Array.from({ length: 9 }, () => ({ type: "text", text: "x".repeat(131_072) }));
  const messages = [
    { channel: "parent", role: "assistant", id: "oversized-row", content: hugeBlocks, timestamp: 0 },
    ...Array.from({ length: 300 }, (_, index) => ({ channel: "parent", role: "user", id: `resident-${index}`, content: `resident ${index}`, timestamp: index + 1 })),
  ];
  const state = { activeSessionId: "root", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat", activeToolNames: [] };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => ({ async getInitialSnapshot() { return { state, messages, children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; }, async getState() { return state; }, async getMessages() { return messages; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} }),
  });
  const snapshot = await bridge.attach("root");
  const result = await bridge.handle({ type: "conversation_history_page", sessionId: "root", expectedCursor: snapshot.cursor, before: null } as never);
  assert.equal(result.type === "error" ? result.code : "", "history_unavailable");
});

test("mutation admission uses a fresh daemon attach barrier rather than the connection snapshot cache", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let upstreamSequence = 4;
  let attachCalls = 0;
  let prompts = 0;
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = () => ({
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "event-generation-1", sequence: upstreamSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() { prompts += 1; }, async steer() {}, async followUp() {}, async abort() {}, async dispose() {}, subscribe() { return () => {}; },
  });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => { attachCalls += 1; return connection(); },
  });
  const first = await bridge.attach("root");
  assert.equal(first.cursor.runtimeGeneration, "event-generation-1");
  upstreamSequence = 5;
  const result = await bridge.executeOperation("root", { operationId: "barrier-operation", action: "harness.session.prompt", payload: { sessionId: "root", text: "must not run" }, expectedCursor: first.cursor, idempotencyKey: "barrier-key" });
  assert.equal(result.status, "rejected");
  assert.equal(prompts, 0);
  assert.ok(attachCalls >= 2);
});

test("refresh reports a generation transition and bootstrap publishes the replacement baseline", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let eventGeneration = "event-generation-1";
  let upstreamSequence = 4;
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = () => ({ async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: eventGeneration, sequence: upstreamSequence } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection(),
  });
  const first = await bridge.attach("root");
  eventGeneration = "event-generation-2";
  upstreamSequence = 1;
  const refresh = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: first.cursor });
  assert.deepEqual(refresh, { type: "error", code: "generation_changed", message: "Daemon session generation changed; rebootstrap is required" });
  const boot = await bridge.bootstrap();
  assert.equal(boot.type === "bootstrap_result" ? boot.sessions[0]?.cursor.runtimeGeneration : "", "event-generation-2");
  assert.equal(boot.type === "bootstrap_result" ? boot.sessions[0]?.cursor.sequence : -1, 1);
});

test("generation recovery revalidates the live daemon hello before rebootstrap", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let eventGeneration = "event-generation-1";
  let upstreamSequence = 4;
  const validHello = (supervisorGeneration: string) => ({ type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration, clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] });
  let liveHello = validHello("supervisor-1");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = () => ({ async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: eventGeneration, sequence: upstreamSequence } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} });
  const client = {
    get hello() { return liveHello; }, async connect() {}, async waitForHello() { return liveHello; },
    async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client, attach: async () => connection(),
  });
  const first = await bridge.attach("root");
  eventGeneration = "event-generation-2";
  upstreamSequence = 1;
  liveHello = validHello("supervisor-2");
  const refresh = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: first.cursor });
  assert.equal(refresh.type === "error" ? refresh.code : "", "generation_changed");
  liveHello = { ...validHello("supervisor-2"), schemaRevision: 99 };
  await assert.rejects(() => bridge.bootstrap(), /schema mismatch/u);
});

test("worker recovery is armed only by an observed healthy-to-recovering transition", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let workerState: "ready" | "recovering" | "failed" = "ready";
  let workerPid = 4100;
  let retryCalls = 0;
  let attachCalls = 0;
  let extensionResponses = 0;
  const extensionListeners = new Set<(event: unknown) => void>();
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = () => ({
    async getInitialSnapshot() {
      if (workerState !== "ready") throw new Error(`Session worker is ${workerState}`);
      return { state, messages: [], children: [], lastEventCursor: { generation: "event-generation-1", sequence: 7 } };
    },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async getSessionContext() { return {}; }, async getModelCatalog() { return { models: [] }; },
    async respondToExtensionUiRequest() { extensionResponses += 1; },
    subscribe(listener: (event: unknown) => void) { extensionListeners.add(listener); return () => { extensionListeners.delete(listener); }; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: {
      async connect() {},
      async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "extension_ui", "session_input_admission", "model_catalog"] }; },
      async request(command: { type: string }) {
        if (command.type === "retry_worker") {
          retryCalls += 1;
          workerState = "ready";
          workerPid = 4200;
          return { type: "response", command: "retry_worker", success: true, data: {} };
        }
        return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", sessionId: "chat", cwd: "C:\\work", lifecycle: "live", activity: "idle", isSessionActive: true, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 0, sessionActions: {}, workerState, workerPid }] } };
      },
      close() {},
    },
    attach: async () => { attachCalls += 1; return connection(); },
  });

  const healthy = await bridge.attach("root");
  assert.deepEqual(healthy.workerRecovery, { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null });
  for (const listener of extensionListeners) listener({ type: "extension_ui_request", request: { id: "recovery-stale", method: "confirm", payload: { title: "Continue?", message: "Proceed?" } } });
  const promptSnapshot = await bridge.snapshot("root");
  assert.equal((await bridge.inspector("root")).extensionUi.status, "available");

  workerState = "recovering";
  const recovering = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: promptSnapshot.cursor });
  assert.equal(recovering.type, "snapshot_result");
  const recoveringSnapshot = recovering.type === "snapshot_result" ? recovering.snapshot : healthy;
  assert.equal(recoveringSnapshot.state, "failed");
  assert.equal(recoveringSnapshot.workerRecovery.status, "recovering");
  assert.equal(recoveringSnapshot.workerRecovery.closureReason, "unexpected_worker_disconnect");
  assert.match(recoveringSnapshot.workerRecovery.observationId ?? "", /^worker-recovery-[a-f0-9]{24}$/u);
  workerState = "ready";
  const staleExtension = await bridge.executeOperation("root", { operationId: "recovery-stale-op", action: "harness.extension.respond", payload: { sessionId: "root", requestId: "recovery-stale", response: { confirmed: true } }, expectedCursor: recoveringSnapshot.cursor, idempotencyKey: "recovery-stale-op" });
  assert.equal(staleExtension.status, "rejected");
  assert.equal(extensionResponses, 0);

  workerState = "failed";
  const failed = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: recoveringSnapshot.cursor });
  assert.equal(failed.type, "snapshot_result");
  const failedSnapshot = failed.type === "snapshot_result" ? failed.snapshot : recoveringSnapshot;
  assert.equal(failedSnapshot.workerRecovery.status, "retryable_failure");
  const observationId = failedSnapshot.workerRecovery.observationId!;

  const retried = await bridge.handle({ type: "retry_worker", sessionId: "root", observationId });
  assert.equal(retried.type, "worker_retry_result");
  assert.equal(retried.type === "worker_retry_result" ? retried.outcome : "", "recovered");
  assert.equal(retried.type === "worker_retry_result" ? retried.snapshot.workerRecovery.status : "", "recovered");
  assert.equal(retried.type === "worker_retry_result" ? retried.snapshot.workerRecovery.automaticRetryCount : 0, 1);
  assert.equal(retryCalls, 1);
  assert.equal(attachCalls, 6, "the stale-response barrier and recovered worker each use a fresh verified attachment");

  const replay = await bridge.handle({ type: "retry_worker", sessionId: "root", observationId });
  assert.equal(replay.type, "error");
  assert.equal(replay.type === "error" ? replay.code : "", "worker_retry_not_admitted");
  assert.equal(retryCalls, 1);
});

test("worker recovery fails closed when the sidecar did not observe the closure transition", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let retryCalls = 0;
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: {
      async connect() {},
      async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async request(command: { type: string }) {
        if (command.type === "retry_worker") retryCalls += 1;
        return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "failed", workerPid: 4100 }] } };
      },
      close() {},
    },
    attach: async () => { throw new Error("Session worker is failed"); },
  });

  await assert.rejects(bridge.attach("root"), /worker recovery identity is unavailable/u);
  const result = await bridge.handle({ type: "retry_worker", sessionId: "root", observationId: "worker-recovery-aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.code : "", "worker_retry_not_admitted");
  assert.equal(retryCalls, 0);
});

test("worker recovery identity is retired when the verified supervisor generation changes", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let supervisorGeneration = "supervisor-generation-1";
  let workerState: "ready" | "recovering" | "failed" = "ready";
  let retryCalls = 0;
  const state = { activeSessionId: "root", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat", activeToolNames: [] };
  const connection = () => ({
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "event-generation", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  });
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: {
      async connect() {},
      get hello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration, clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration, clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async request(command: { type: string }) { if (command.type === "retry_worker") retryCalls += 1; return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState }] } }; },
      close() {},
    },
    attach: async () => connection(),
  });
  const healthy = await bridge.attach("root");
  workerState = "recovering";
  const recovering = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: healthy.cursor });
  const observed = recovering.type === "snapshot_result" ? recovering.snapshot : healthy;
  workerState = "failed";
  const failed = await bridge.handle({ type: "refresh_session", sessionId: "root", knownCursor: observed.cursor });
  const observationId = failed.type === "snapshot_result" ? failed.snapshot.workerRecovery.observationId! : "missing";
  supervisorGeneration = "supervisor-generation-2";
  const replay = await bridge.handle({ type: "retry_worker", sessionId: "root", observationId });
  assert.equal(replay.type, "error");
  assert.equal(retryCalls, 0);
});

test("starting workers are projected without retry and absent lifecycle state fails closed", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let includeState = true;
  const state = { activeSessionId: "root", cwd: "C:\\work", isStreaming: false, isCompacting: false, isBashRunning: false, sessionId: "chat", activeToolNames: [] };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, ...(includeState ? { workerState: "starting" } : {}) }] } }; }, close() {} },
    attach: async () => ({ async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "event-generation", sequence: 1 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} }),
  });
  const starting = await bridge.attach("root");
  assert.equal(starting.workerRecovery.status, "starting");
  includeState = false;
  await assert.rejects(() => bridge.snapshot("root"), /state is unavailable/u);
});

test("full operation catalog is closed and unsupported upstream operations are explicit", async () => {
  const { STUDIO_HARNESS_ACTIONS, StudioHarnessOperationDispatcher, dispatchStudioHarnessOperation } = await import("../src/studioHarnessOperations.js");
  assert.ok(STUDIO_HARNESS_ACTIONS.includes("harness.session.prompt"));
  assert.ok(STUDIO_HARNESS_ACTIONS.includes("harness.session.export"));
  assert.ok(STUDIO_HARNESS_ACTIONS.includes("harness.child.transcript-page"));
  assert.equal((await dispatchStudioHarnessOperation({ connection: {}, currentCursor: { runtimeGeneration: "generation-1", sequence: 9 } }, {
    operationId: "op-123456789012", action: "harness.queue.run-now", payload: { sessionId: "s", queueItemId: "q" },
    expectedCursor: { runtimeGeneration: "generation-1", sequence: 9 }, idempotencyKey: "queue-1",
  })).status, "unavailable");

  let selected = "";
  const dispatched = await dispatchStudioHarnessOperation({
    connection: { async setModel(provider: string, modelId: string) { selected = `${provider}/${modelId}`; return { provider, id: modelId }; } },
    currentCursor: { runtimeGeneration: "generation-1", sequence: 9 },
  }, {
    operationId: "op-123456789013", action: "composer.model.select", payload: { chatId: "chat", modelId: "openai/gpt-test" },
    expectedCursor: { runtimeGeneration: "generation-1", sequence: 9 }, idempotencyKey: "model-change-1",
  });
  assert.equal(selected, "openai/gpt-test");
  assert.equal(dispatched.status, "updated");

  const conflict = await dispatchStudioHarnessOperation({
    connection: { async setModel() { throw new Error("must not run"); } },
    currentCursor: { runtimeGeneration: "generation-1", sequence: 10 },
  }, {
    operationId: "op-123456789014", action: "composer.model.select", payload: { chatId: "chat", modelId: "openai/gpt-test" },
    expectedCursor: { runtimeGeneration: "generation-1", sequence: 9 }, idempotencyKey: "model-change-2",
  });
  assert.equal(conflict.status, "rejected");

  let prompts = 0;
  const dispatcher = new StudioHarnessOperationDispatcher();
  const operation = {
    operationId: "op-123456789015", action: "harness.session.prompt" as const,
    payload: { sessionId: "active-root", text: "one" },
    expectedCursor: { runtimeGeneration: "generation-1", sequence: 9 }, idempotencyKey: "prompt-1",
  };
  const port = { connection: { async prompt() { prompts += 1; } }, currentCursor: { runtimeGeneration: "generation-1", sequence: 9 } };
  assert.equal((await dispatcher.dispatch(port, operation)).status, "accepted");
  assert.equal((await dispatcher.dispatch(port, operation)).status, "accepted");
  assert.equal(prompts, 1);
  assert.equal((await dispatcher.dispatch(port, { ...operation, payload: { ...operation.payload, text: "two" } })).status, "rejected");
  assert.equal((await dispatchStudioHarnessOperation(port, { ...operation, operationId: "op-123456789016", idempotencyKey: "prompt-2", payload: { ...operation.payload, extra: true } })).status, "rejected");

  let uncertainCalls = 0;
  const uncertain = { ...operation, operationId: "op-123456789017", idempotencyKey: "prompt-3" };
  const uncertainPort = { connection: { async prompt() { uncertainCalls += 1; throw new Error("connection lost"); } }, currentCursor: operation.expectedCursor };
  assert.equal((await dispatcher.dispatch(uncertainPort, uncertain)).status, "unknown_outcome");
  assert.equal((await dispatcher.dispatch(uncertainPort, uncertain)).status, "unknown_outcome");
  assert.equal(uncertainCalls, 1);
});

test("production bridge exposes every verified daemon operation without provider calls", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const calls: string[] = [];
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: ["low", "high"], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [], model: { provider: "openai", id: "gpt-test", name: "GPT Test" } };
  const base = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "g", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { calls.push("messages"); return []; },
    async getQueue() { calls.push("queue"); return { steering: [], followUp: [] }; },
    async getResourceSnapshot() { return { contextFiles: [], skills: [], prompts: [], extensions: [], themes: [], diagnostics: { skills: [], prompts: [], extensions: [], themes: [] } }; },
    async getSessionStats() { calls.push("stats"); return { tokens: {}, cost: 0 }; }, async getToolDefinition(name: string) { calls.push(`tool:${name}`); return undefined; },
    async getModelCatalog() { calls.push("models"); return { models: [{ provider: "openai", id: "gpt-test", name: "GPT Test" }] }; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() { calls.push("detach"); },
  };
  const connection = new Proxy(base as Record<string, unknown>, { get(target, key) {
    if (key === "then" || key === "subscribe") return undefined;
    if (key in target) return target[key as string];
    return async (...args: unknown[]) => { calls.push(`${String(key)}:${args.map(String).join(",")}`); return { ok: true }; };
  } }) as never;
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "g", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { calls.push(`global:${command.type}`); return { type: "response", command: command.type, success: true, data: command.type === "list" ? { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } : [] }; }, close() {} },
    attach: async () => connection,
  });
  await bridge.catalog(); await bridge.createResident({ name: "New", cwd: "C:\\work" }); await bridge.rename("root", "Renamed");
  await bridge.attach("root"); await bridge.deleteSavedSession("root", "C:\\safe\\session.jsonl");
  await bridge.setModel("root", "openai", "gpt-test"); await bridge.setThinking("root", "high"); await bridge.compact("root"); await bridge.fork("root", "entry-1");
  await bridge.messages("root"); await bridge.stats("root"); await bridge.tree("root"); await bridge.children("root"); await bridge.queue("root");
  await bridge.clearQueue("root"); await bridge.abortAndClearQueue("root");
  await bridge.schedules("root"); await bridge.addSchedule("root", "in 5m", "Continue"); await bridge.cancelSchedule("root", "job-1");
  await bridge.heartbeats("root"); await bridge.getHeartbeat("root"); await bridge.setHeartbeat("root", "every 5m", "Check", "follow_up");
  await bridge.updateHeartbeat("root", "pause"); await bridge.manageHeartbeat("root", "child", "job-2", "resume");
  await bridge.toolDefinition("root", "ipython"); await bridge.resources("root"); await bridge.models("root"); await bridge.commands("root");
  const details = await bridge.inspector("root");
  const composer = (details as unknown as { composer?: unknown }).composer;
  assert.deepEqual(composer, {
    models: [{ id: "openai/gpt-test", label: "GPT Test", shortLabel: "GPT Test", enabled: true }],
    selectedModel: "openai/gpt-test",
    thinkingLevels: ["low", "high"],
    selectedThinking: "high",
    supportedCommands: ["model", "effort", "compact", "fork", "export"],
  });
  const statsBeforeSessionReplayCheck = calls.filter((call) => call === "stats").length;
  const sharedIdentity = { operationId: "cross-session-operation", action: "usage.current.refresh" as const, expectedCursor: null, idempotencyKey: "cross-session-key" };
  assert.equal((await bridge.executeOperation("root", { ...sharedIdentity, payload: { sessionId: "root" } })).status, "updated");
  assert.equal((await bridge.executeOperation("other", { ...sharedIdentity, payload: { sessionId: "other" } })).status, "updated");
  assert.equal(calls.filter((call) => call === "stats").length, statsBeforeSessionReplayCheck + 2);
  await bridge.importJsonl("root", "C:\\safe\\input.jsonl"); await bridge.exportSession("root", "jsonl"); await bridge.exportSession("root", "html", "C:\\safe\\out.html");
  assert.equal((await bridge.clone("root")).status, "unsupported_upstream");
  await bridge.detach("root");
  assert.deepEqual(calls, [
    "global:list", "global:create", "global:rename", "global:list", "detach", "queue", "stats", "deleteSavedSession:C:\\safe\\session.jsonl", "setModel:openai,gpt-test", "setThinkingLevel:high", "compact:undefined", "fork:entry-1,undefined",
    "messages", "stats", "getSessionTree:", "queue", "clearQueue:", "abortAndClearQueue:", "listCronJobs:[object Object]", "addCronJob:in 5m,Continue", "cancelCronJob:job-1",
    "listHeartbeats:", "getHeartbeat:", "setHeartbeat:every 5m,Check,follow_up", "updateHeartbeat:pause", "manageHeartbeat:child,job-2,resume", "tool:ipython", "models", "getCommands:", "getSessionContext:", "stats", "models", "stats", "stats",
    "importFromJsonl:C:\\safe\\input.jsonl,undefined", "exportToJsonl:undefined", "exportToHtml:C:\\safe\\out.html", "detach",
  ]);
});

test("inspector projects only explicit daemon context and output evidence", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = {
    activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null,
    autoCompactionEnabled: true, messageCount: 2, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [],
  };
  let statsResult: Record<string, unknown> = { contextUsage: { tokens: 25, capacityTokens: 100, turns: 1, samples: [5, 15, 25] }, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
  let resourceResult: Record<string, unknown> = { outputs: [{ name: "Report", path: "C:\\work\\report.md", kind: "markdown" }, { name: "Unbound" }] };
  const connection = {
    async getInitialSnapshot() { return { state, startedAtMs: 1_000, messages: [{ role: "user", content: "one", timestamp: 1 }, { role: "assistant", content: [], timestamp: 2, stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }], children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; },
    async getSessionContext() { return {}; },
    async getModelCatalog() { return { models: [] }; },
    async getResourceSnapshot() { return resourceResult; },
    async getSessionStats() { return statsResult; },
    async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });
  // Bind the verified connection through the public attach path before inspecting it.
  await bridge.attach("root");
  const details = await bridge.inspector("root");
  assert.equal(details.startedAtMs, 1_000);
  assert.deepEqual(details.context, { usedTokens: 25, capacityTokens: 100, turns: 1, samples: [5, 15, 25] });
  assert.equal(details.outputs.length, 1);
  assert.equal(details.outputs[0]?.candidatePath, "C:\\work\\report.md");

  statsResult = { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
  resourceResult = {};
  const unavailable = await bridge.inspector("root");
  assert.equal(unavailable.context, null);
  assert.deepEqual(unavailable.outputs, []);
});

test("inspector never hydrates a child transcript through the parent projection", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let childWatchCalls = 0;
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [{ id: "child-a", activeSessionId: "child-session-a", label: "Private task" }], lastEventCursor: { generation: "generation-1", sequence: 4 } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getSessionContext() { return {}; }, async getModelCatalog() { return { models: [] }; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {} }; }, async getToolDefinition() { return undefined; },
    async watchSession() { childWatchCalls += 1; throw new Error("parent inspector must not watch child"); },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });
  await bridge.attach("root");
  const details = await bridge.inspector("root");
  assert.equal(childWatchCalls, 0);
  assert.deepEqual(details.children["child-a"]?.transcript, []);
});

test("child pages are bounded and opaque cursors reject cross-child, malformed, and stale reuse", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let rootSequence = 4;
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const childMessages = Array.from({ length: 205 }, (_, index) => ({ role: index % 2 === 0 ? "assistant" : "user", content: `private-${index}`, timestamp: index + 1 }));
  const watcher = { async getMessages() { return childMessages; }, async close() {} };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [{ id: "child-a", activeSessionId: "child-session-a" }, { id: "child-b", activeSessionId: "child-session-b" }], lastEventCursor: { generation: "generation-1", sequence: rootSequence } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {} }; }, async getToolDefinition() { return undefined; }, async watchSession() { return watcher; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });
  const snapshot = await bridge.attach("root");
  const first = await bridge.childPage("root", "child-a", "chat", snapshot.cursor, null);
  assert.equal(first.status, "available");
  assert.equal(first.status === "available" ? first.items.length : -1, 100);
  assert.equal(first.status === "available" && first.tab === "chat" ? first.items[0]?.text : "", "private-105");
  assert.ok(first.status === "available" && first.previousCursor);
  const cursor = first.status === "available" ? first.previousCursor : null;
  await assert.rejects(() => bridge.childPage("root", "child-b", "chat", snapshot.cursor, cursor), /cross-child/i);
  await assert.rejects(() => bridge.childPage("root", "child-a", "chat", snapshot.cursor, "not-a-minted-cursor"), /malformed|unknown/i);
  rootSequence = 5;
  await assert.rejects(() => bridge.childPage("root", "child-a", "chat", snapshot.cursor, cursor), /stale/i);
});

test("child page reports explicit unavailable when the verified daemon cannot watch the child", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = { async getInitialSnapshot() { return { state, messages: [], children: [{ id: "child-a", activeSessionId: "child-session-a" }], lastEventCursor: { generation: "generation-1", sequence: 4 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {} }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} };
  const bridge = new PrimeDaemonBridge({ identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] }, client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} }, attach: async () => connection });
  const snapshot = await bridge.attach("root");
  await assert.doesNotReject(async () => {
    assert.deepEqual(await bridge.childPage("root", "child-a", "chat", snapshot.cursor, null), { status: "unavailable", tab: "chat", reason: "The installed Harness does not expose child session paging." });
  });
});

test("child Files rejects generic tool arguments instead of fabricating filesystem outcomes", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const childMessages = [
    { role: "assistant", content: [{ type: "toolCall", id: "failed-write", name: "write", arguments: { path: "C:\\work\\not-written.txt" } }], timestamp: 1 },
    { role: "toolResult", toolCallId: "failed-write", isError: true, content: "failed", timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "delete", name: "delete", arguments: { path: "C:\\work\\maybe-deleted.txt" } }], timestamp: 3 },
    { role: "assistant", content: [{ type: "toolCall", id: "unrelated", name: "export", arguments: { filename: "report.txt" } }], timestamp: 4 },
  ];
  const connection = { async getInitialSnapshot() { return { state, messages: [], children: [{ id: "child-a", activeSessionId: "child-session-a" }], lastEventCursor: { generation: "generation-1", sequence: 4 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {} }; }, async getToolDefinition() { return undefined; }, async watchSession() { return { async getMessages() { return childMessages; }, async close() {} }; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} };
  const bridge = new PrimeDaemonBridge({ identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] }, client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} }, attach: async () => connection });
  const snapshot = await bridge.attach("root");
  assert.deepEqual(await bridge.childPage("root", "child-a", "files", snapshot.cursor, null), { status: "unavailable", tab: "files", reason: "The installed Harness does not expose finalized child filesystem evidence." });
});

test("inspector projects bounded authoritative per-turn usage without recounting child context", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const messages = [
    { role: "user", content: "one", timestamp: 1_000 },
    { role: "assistant", content: [], timestamp: 1_100, stopReason: "toolUse", usage: usage(10, 5, 3, 2) },
    { role: "toolResult", toolCallId: "call-1", toolName: "ipython", content: [], timestamp: 1_200 },
    { role: "assistant", content: [], timestamp: 1_300, stopReason: "stop", usage: usage(4, 6, 1, 0) },
    { role: "user", content: "two", timestamp: 2_000 },
    // Prime has already folded child_usage_attributed evidence into this assistant usage.
    { role: "assistant", content: [], timestamp: 2_100, stopReason: "stop", usage: usage(20, 8, 4, 1) },
  ];
  const totals = usage(34, 19, 8, 3);
  const state = {
    activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null,
    autoCompactionEnabled: true, messageCount: messages.length, sessionActions: {}, compactionCount: 0,
    goal: {}, scopedModels: [], activeToolNames: [],
  };
  const connection = {
    async getInitialSnapshot() {
      return {
        state, messages,
        children: [{ id: "child-1", label: "Child", status: "done", tokenCount: 9_999, sessionDir: "C:\\work\\child" }],
        lastEventCursor: { generation: "generation-1", sequence: 1 },
      };
    },
    async getState() { return state; }, async getMessages() { return messages; }, async getQueue() { return {}; },
    async getSessionContext() { return { messages }; }, async getModelCatalog() { return { models: [] }; },
    async getResourceSnapshot() { return {}; },
    async getSessionStats() { return { tokens: { ...totals, total: totals.totalTokens }, cost: 0 }; },
    async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: Readonly<Record<string, unknown>>) { assert.equal(command.type, "list"); return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} },
    attach: async () => connection,
  });

  await bridge.attach("root");
  const details = await bridge.inspector("root");
  assert.deepEqual((details as unknown as { turnUsage?: unknown }).turnUsage, {
    totalTurns: 3,
    omittedTurns: 0,
    rows: [
      { turn: 1, occurredAtMs: 1_100, input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 },
      { turn: 2, occurredAtMs: 1_300, input: 4, output: 6, cacheRead: 1, cacheWrite: 0, totalTokens: 11 },
      { turn: 3, occurredAtMs: 2_100, input: 20, output: 8, cacheRead: 4, cacheWrite: 1, totalTokens: 33 },
    ],
  });

  for (let index = 0; index < 300; index += 1) {
    messages.push({ role: "assistant", content: [], timestamp: 3_000 + index, stopReason: "stop", usage: usage(1, 0, 0, 0) });
    totals.input += 1;
    totals.totalTokens += 1;
  }
  const bounded = (await bridge.inspector("root")).turnUsage!;
  assert.equal(bounded.totalTurns, 303);
  assert.equal(bounded.omittedTurns, 3);
  assert.equal(bounded.rows.length, 300);
  assert.equal(bounded.rows[0]?.turn, 4);
  assert.equal(bounded.rows.at(-1)?.turn, 303);
});

test("inspector withholds per-turn usage when message evidence cannot reconcile with session totals", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 1, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const messages = [{ role: "assistant", content: [], timestamp: 10, stopReason: "stop", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  let statsTokens = { input: 99, output: 2, cacheRead: 0, cacheWrite: 0, total: 101 };
  const connection = { async getInitialSnapshot() { return { state, messages, children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; }, async getState() { return state; }, async getMessages() { return messages; }, async getQueue() { return {}; }, async getSessionContext() { return { messages }; }, async getModelCatalog() { return { models: [] }; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: statsTokens, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} };
  const bridge = new PrimeDaemonBridge({ identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] }, client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: Readonly<Record<string, unknown>>) { assert.equal(command.type, "list"); return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true, workerState: "ready" }] } }; }, close() {} }, attach: async () => connection });

  await bridge.attach("root");
  const details = await bridge.inspector("root");
  assert.equal((details as unknown as { turnUsage?: unknown }).turnUsage, undefined);

  delete (messages[0]!.usage as Partial<typeof messages[0]["usage"]>).output;
  statsTokens = { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 };
  await assert.rejects(() => bridge.inspector("root"), /assistant usage is incomplete/u);
});

test("resident creation recovers a lost create response by stable creation identity", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const calls: Array<Readonly<Record<string, unknown>>> = [];
  let resident: Record<string, unknown> | null = null;
  let loseFirstCreateResponse = true;
  const state = {
    activeSessionId: "resident-active", cwd: "C:\\work\\resident", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "resident-chat", leafId: null,
    autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [],
  };
  const connection = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; },
    async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; },
    async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const ports = {
    identity: { packageName: "prime-agent" as const, packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: {
      async connect() {},
      async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async request(command: Readonly<Record<string, unknown>>) {
        calls.push(command);
        if (command.type === "list") return { type: "response", command: "list", success: true, data: { sessions: resident ? [resident] : [] } };
        assert.equal(command.type, "create");
        assert.equal(command.lifecycle, "resident");
        assert.deepEqual(command.config, { cwd: "C:\\work\\resident" });
        assert.match(String(command.name), /^prime-studio:[a-f0-9]{24}:[a-f0-9]{24}:/u);
        resident = { activeSessionId: "resident-active", sessionId: "resident-chat", sessionName: command.name, cwd: "C:\\work\\resident", isSessionActive: true, workerState: "ready" };
        if (loseFirstCreateResponse) { loseFirstCreateResponse = false; throw new Error("response lost after commit"); }
        return { type: "response", command: "create", success: true, data: resident };
      },
      close() {},
    },
    attach: async (client: unknown, activeSessionId: string) => { void client; assert.equal(activeSessionId, "resident-active"); return connection; },
  };
  const first = new PrimeDaemonBridge(ports);
  const request = { type: "create_resident" as const, creationId: "create-000000000001", name: "Design", cwd: "C:\\work\\resident" };
  await assert.rejects(() => first.handle(request), /response lost/u);

  const restarted = new PrimeDaemonBridge(ports);
  const recovered = await restarted.handle(request);
  assert.equal(recovered.type, "resident_created");
  assert.equal(recovered.type === "resident_created" ? recovered.creationId : "", request.creationId);
  assert.equal(recovered.type === "resident_created" ? recovered.snapshot.sessionId : "", "resident-active");
  assert.equal(calls.filter((command) => command.type === "create").length, 1);
  await assert.rejects(
    () => restarted.handle({ ...request, cwd: "C:\\work\\other" }),
    /reused with different input/u,
  );
  assert.equal(calls.filter((command) => command.type === "create").length, 1);
  const restartedAgain = new PrimeDaemonBridge(ports);
  await assert.rejects(
    () => restartedAgain.handle({ ...request, cwd: "C:\\work\\other" }),
    /reused with different input/u,
  );
  assert.equal(calls.filter((command) => command.type === "create").length, 1);
});

test("resident creation rejects replay conflicts and ambiguous recovery", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const { createHash } = await import("node:crypto");
  const creationId = "create-ambiguous";
  const creationHash = createHash("sha256").update(creationId).digest("hex").slice(0, 24);
  const fingerprint = JSON.stringify({ name: "Design", cwd: "C:\\work" });
  const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  const marker = `prime-studio:${creationHash}:${fingerprintHash}:Design`;
  const rows = [
    { activeSessionId: "one", sessionId: "chat-one", sessionName: marker, cwd: "C:\\work", isSessionActive: true },
    { activeSessionId: "two", sessionId: "chat-two", sessionName: marker, cwd: "C:\\work", isSessionActive: true },
  ];
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: Readonly<Record<string, unknown>>) { assert.equal(command.type, "list"); return { type: "response", command: "list", success: true, data: { sessions: rows } }; }, close() {} },
    attach: async () => { throw new Error("ambiguous recovery must not attach"); },
  });
  await assert.rejects(() => bridge.handle({ type: "create_resident", creationId, name: "Design", cwd: "C:\\work" }), /ambiguous/u);
});

test("resident creation fails closed when the verified runtime lacks resident capability", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  let requests = 0;
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { requests += 1; return { type: "response", command: "list", success: true, data: { sessions: [] } }; }, close() {} },
    attach: async () => { throw new Error("must not attach"); },
  });
  await assert.rejects(
    () => bridge.handle({ type: "create_resident", creationId: "creation-no-capability", name: "Design", cwd: "C:\\work" }),
    /incompatible|capability/u,
  );
  assert.equal(requests, 0);
});

test("resident branch clones the source, forks the clone, and recovers only a committed marker", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const calls: string[] = [];
  let branchRow: Record<string, unknown> | null = null;
  const baseState = (activeSessionId: string, sessionId: string, sessionFile: string) => ({
    activeSessionId, cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto",
    availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId, sessionFile, leafId: "message-1",
    autoCompactionEnabled: true, messageCount: 1, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [],
  });
  const connection = (activeSessionId: string) => {
    let state = activeSessionId === "source-active"
      ? baseState(activeSessionId, "source-chat", "C:\\sessions\\source.jsonl")
      : baseState(activeSessionId, "empty-chat", "C:\\sessions\\empty.jsonl");
    return {
      async getInitialSnapshot() {
        return {
          state,
          messages: [{ role: "user", content: "Branch here", timestamp: 1 }], children: [],
          sessionTree: { tree: [{ entry: { type: "message", id: "message-1", message: { role: "user", content: "Branch here", timestamp: 1 } }, children: [] }] },
          lastEventCursor: { generation: activeSessionId === "source-active" ? "source-generation" : "branch-generation", sequence: 1 },
        };
      },
      async getState() { return state; }, async getMessages() { return [{ role: "user", content: "Branch here", timestamp: 1 }]; },
      async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; },
      async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
      async importFromJsonl(path: string, cwd: string) { calls.push(`import:${path}:${cwd}`); state = baseState(activeSessionId, "imported-chat", "C:\\sessions\\imported.jsonl"); return { cancelled: false }; },
      async fork(entryId: string, options?: { position?: "before" | "at" }) { calls.push(`fork:${entryId}:${options?.position}`); state = baseState(activeSessionId, "branch-chat", "C:\\sessions\\branch.jsonl"); return { cancelled: false }; },
    };
  };
  const connections = new Map<string, ReturnType<typeof connection>>();
  const ports = {
    identity: { packageName: "prime-agent" as const, packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: {
      async connect() {},
      async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; },
      async request(command: Readonly<Record<string, unknown>>) {
        if (command.type === "list") return { type: "response", command: "list", success: true, data: { sessions: [
          { activeSessionId: "source-active", sessionId: "source-chat", isSessionActive: true, workerState: "ready" },
          ...(branchRow ? [branchRow] : []),
        ] } };
        if (command.type === "create") {
          calls.push("create");
          branchRow = { activeSessionId: "branch-active", sessionId: "empty-chat", sessionName: command.name, cwd: "C:\\work", isSessionActive: true, workerState: "ready" };
          return { type: "response", command: "create", success: true, data: branchRow };
        }
        if (command.type === "rename") {
          calls.push("commit");
          branchRow = { ...branchRow, sessionName: command.name };
          return { type: "response", command: "rename", success: true, data: {} };
        }
        throw new Error(`unexpected ${String(command.type)}`);
      },
      close() {},
    },
    attach: async (_client: unknown, activeSessionId: string) => {
      const attached = connections.get(activeSessionId) ?? connection(activeSessionId);
      connections.set(activeSessionId, attached);
      return attached;
    },
  };
  const request = { type: "branch_resident", creationId: "studio-branch-1", sourceSessionId: "source-active", entryId: "message-1", name: "Branch of Source" } as const;
  const bridge = new PrimeDaemonBridge(ports);
  const source = await bridge.attach("source-active");
  assert.equal(source.chatId, "source-chat");
  const created = await bridge.handle(request as never) as unknown as { type: string; snapshot: { sessionId: string; chatId: string } };
  assert.equal(created.type, "resident_branched");
  assert.equal(created.snapshot.sessionId, "branch-active");
  assert.equal(created.snapshot.chatId, "branch-chat");
  assert.deepEqual(calls, ["create", "import:C:\\sessions\\source.jsonl:C:\\work", "fork:message-1:at", "commit"]);

  const restarted = new PrimeDaemonBridge(ports);
  const recovered = await restarted.handle(request as never) as unknown as { type: string };
  assert.equal(recovered.type, "resident_branched");
  assert.deepEqual(calls, ["create", "import:C:\\sessions\\source.jsonl:C:\\work", "fork:message-1:at", "commit"]);
});

test("resident branch never resumes or reports success from an incomplete marker", async () => {
  const { createHash } = await import("node:crypto");
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const creationId = "studio-branch-pending";
  const fingerprint = JSON.stringify({ sourceSessionId: "source-active", entryId: "message-1", name: "Branch" });
  const prefix = `prime-studio-branch:${createHash("sha256").update(creationId).digest("hex").slice(0, 24)}:`;
  const pending = `${prefix}${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}:pending`;
  let attaches = 0;
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: Readonly<Record<string, unknown>>) { assert.equal(command.type, "list"); return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "pending-active", sessionName: pending, isSessionActive: true }] } }; }, close() {} },
    attach: async () => { attaches += 1; throw new Error("incomplete branch must not be resumed"); },
  });
  await assert.rejects(
    () => bridge.handle({ type: "branch_resident", creationId, sourceSessionId: "source-active", entryId: "message-1", name: "Branch" } as never),
    /reconciliation/u,
  );
  assert.equal(attaches, 0);
});
