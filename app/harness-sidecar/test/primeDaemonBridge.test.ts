import assert from "node:assert/strict";
import test from "node:test";

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
});

test("production bridge exposes every verified daemon operation without provider calls", async () => {
  const { PrimeDaemonBridge } = await import("../src/primeDaemonBridge.js");
  const calls: string[] = [];
  const state = { activeSessionId: "root", cwd: "C:\\work", thinkingLevel: "high", serviceTier: "auto", availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all", sessionId: "chat", leafId: null, autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, compactionCount: 0, goal: {}, scopedModels: [], activeToolNames: [] };
  const base = {
    async getInitialSnapshot() { return { state, messages: [], children: [], lastEventCursor: { generation: "g", sequence: 1 } }; },
    async getState() { return state; }, async getMessages() { calls.push("messages"); return []; },
    async getQueue() { calls.push("queue"); return { steering: [], followUp: [] }; },
    async getResourceSnapshot() { return { contextFiles: [], skills: [], prompts: [], extensions: [], themes: [], diagnostics: { skills: [], prompts: [], extensions: [], themes: [] } }; },
    async getSessionStats() { calls.push("stats"); return { tokens: {}, cost: 0 }; }, async getToolDefinition(name: string) { calls.push(`tool:${name}`); return undefined; },
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
  assert.deepEqual(Object.keys(details).sort(), ["activity", "children", "context", "contributions", "notices", "observedAtMs", "outputs", "sources", "startedAtMs"]);
  await bridge.importJsonl("root", "C:\\safe\\input.jsonl"); await bridge.exportSession("root", "jsonl"); await bridge.exportSession("root", "html", "C:\\safe\\out.html");
  assert.equal((await bridge.clone("root")).status, "unsupported_upstream");
  await bridge.detach("root");
  assert.deepEqual(calls, [
    "global:list", "global:create", "global:rename", "queue", "stats", "deleteSavedSession:C:\\safe\\session.jsonl", "setModel:openai,gpt-test", "setThinkingLevel:high", "compact:undefined", "fork:entry-1,undefined",
    "messages", "stats", "getSessionTree:", "queue", "clearQueue:", "abortAndClearQueue:", "listCronJobs:[object Object]", "addCronJob:in 5m,Continue", "cancelCronJob:job-1",
    "listHeartbeats:", "getHeartbeat:", "setHeartbeat:every 5m,Check,follow_up", "updateHeartbeat:pause", "manageHeartbeat:child,job-2,resume", "tool:ipython", "getModelCatalog:", "getCommands:", "getSessionContext:", "stats",
    "importFromJsonl:C:\\safe\\input.jsonl,undefined", "exportToJsonl:undefined", "exportToHtml:C:\\safe\\out.html", "detach",
  ]);
});
