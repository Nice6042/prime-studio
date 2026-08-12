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
      async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "active-root", sessionId: "session-root", cwd: "C:\\work\\project", lifecycle: "live", activity: "idle", isSessionActive: true, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1, sessionActions: {} }] } }; },
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
  let eventListener: ((event: unknown) => void) | undefined;
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
    subscribe(listener: (event: unknown) => void) { eventListener = listener; return () => { eventListener = undefined; }; },
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: [] }; }, close() {} },
    attach: async () => connection,
  });
  const first = await bridge.attach("root");
  assert.equal(first.cursor.sequence, 4);
  upstreamSequence = 5;
  eventListener?.({ type: "message_update" });
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

test("each published snapshot advances exactly one Studio revision even without an upstream event", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const connection = { async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "generation-1", sequence: 9 } }; }, async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; }, async getResourceSnapshot() { return {}; }, async getSessionStats() { return { tokens: {}, cost: 0 }; }, async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {} };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: [] }; }, close() {} },
    attach: async () => connection,
  });
  const first = await bridge.attach("root");
  const second = await bridge.snapshot("root");
  const third = await bridge.snapshot("root");
  assert.deepEqual([first.cursor.sequence, second.cursor.sequence, third.cursor.sequence], [9, 10, 11]);
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
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { return { type: "response", command: "list", success: true, data: [] }; }, close() {} },
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
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "supervisor-generation", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true }] } }; }, close() {} },
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
    async request(command: { type: string }) { return { type: "response", command: command.type, success: true, data: { sessions: [{ activeSessionId: "root", isSessionActive: true }] } }; }, close() {},
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
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello", socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "g", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request(command: { type: string }) { calls.push(`global:${command.type}`); return { type: "response", command: command.type, success: true, data: [] }; }, close() {} },
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
    "global:list", "global:create", "global:rename", "detach", "queue", "stats", "deleteSavedSession:C:\\safe\\session.jsonl", "setModel:openai,gpt-test", "setThinkingLevel:high", "compact:undefined", "fork:entry-1,undefined",
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
    async getInitialSnapshot() { return { state, startedAtMs: 1_000, messages: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }], children: [], lastEventCursor: { generation: "generation-1", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { return []; }, async getQueue() { return {}; },
    async getSessionContext() { return {}; },
    async getResourceSnapshot() { return resourceResult; },
    async getSessionStats() { return statsResult; },
    async getToolDefinition() { return undefined; }, async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  };
  const bridge = new PrimeDaemonBridge({
    identity: { packageName: "prime-agent", packageVersion: "0.7.1", packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900", entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b", protocolName: "prime-agent.daemon", protocolVersion: 7, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    client: { async connect() {}, async waitForHello() { return { type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1", supervisorGeneration: "generation-1", clientId: "c", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"] }; }, async request() { throw new Error("not used"); }, close() {} },
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
        resident = { activeSessionId: "resident-active", sessionId: "resident-chat", sessionName: command.name, cwd: "C:\\work\\resident", isSessionActive: true };
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
