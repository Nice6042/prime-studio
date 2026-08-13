import assert from "node:assert/strict";
import test from "node:test";

import { PrimeDaemonBridge, type DaemonConnectionPort } from "../src/primeDaemonBridge.js";
import type { RuntimeIdentity } from "../src/runtimeDiscovery.js";

const identity: RuntimeIdentity = {
  packageName: "prime-agent",
  packageVersion: "0.7.1",
  packageDigest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
  entrypointDigest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
  protocolName: "prime-agent.daemon",
  protocolVersion: 7,
  schemaRevision: 13,
  schemaId: "protocol-7-schema-13-816309b1cd50",
  capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
};

test("Prime bridge publishes the exact reconciled cancellation snapshot and replays it without a second cancel", async () => {
  let upstreamSequence = 4;
  let cancellations = 0;
  let children = [
    { id: "child-a", activeSessionId: "child-session-a", label: "Exact task", status: "running" },
    { id: "child-a-copy", activeSessionId: "child-session-copy", label: "Similar task", status: "running" },
  ];
  const state = {
    activeSessionId: "root-a", cwd: "C:\\work", isStreaming: false, isCompacting: false,
    isBashRunning: false, sessionId: "chat-a", activeToolNames: [], model: { provider: "openai", id: "gpt-test" },
  };
  const connection = (): DaemonConnectionPort => ({
    async getInitialSnapshot() {
      return { state, messages: [], children: children.map((item) => ({ ...item })), lastEventCursor: { generation: "generation-1", sequence: upstreamSequence } };
    },
    async getState() { return state; },
    async getMessages() { return []; },
    async getQueue() { return { steering: [], followUp: [] }; },
    async getResourceSnapshot() { return {}; },
    async getSessionStats() { return { tokens: {}, cost: 0 }; },
    async getToolDefinition() { return undefined; },
    async cancelRlmChild(childId: string) {
      cancellations += 1;
      assert.equal(childId, "child-a");
      children = children.filter((candidate) => candidate.id !== childId);
      upstreamSequence += 1;
    },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
  } as DaemonConnectionPort);
  const bridge = new PrimeDaemonBridge({
    identity,
    client: {
      async connect() {},
      async waitForHello() {
        return {
          type: "daemon_hello" as const, socketPath: "fake", protocol: { name: "prime-agent.daemon", version: 7 },
          schemaRevision: 13, schemaId: "protocol-7-schema-13-816309b1cd50", appVersion: "0.7.1",
          supervisorGeneration: "generation-1", clientId: "client", serverCapabilities: ["attach_snapshot", "event_sequence", "session_input_admission", "model_catalog"],
        };
      },
      async request(command: Readonly<Record<string, unknown>>) {
        assert.equal(command.type, "list");
        return { type: "response", command: "list", success: true, data: { sessions: [{ activeSessionId: "root-a", isSessionActive: true, workerState: "ready" }] } };
      },
      close() {},
    },
    attach: async () => connection(),
  });

  const initial = await bridge.attach("root-a");
  const operation = {
    operationId: "cancel-child-a",
    action: "harness.child.stop" as const,
    payload: { sessionId: "root-a", childId: "child-a" },
    expectedCursor: initial.cursor,
    idempotencyKey: "cancel-child-a",
  };
  const first = await bridge.executeOperation("root-a", operation);
  assert.equal(first.status, "updated");
  if (first.status !== "updated") return;
  const projected = first.data as typeof initial;
  assert.deepEqual(projected.children.map((candidate) => candidate.id), ["child-a-copy"]);
  assert.equal(projected.cursor.runtimeGeneration, initial.cursor.runtimeGeneration);
  assert.equal(projected.cursor.sequence, initial.cursor.sequence + 1);

  const replay = await bridge.executeOperation("root-a", operation);
  assert.equal(replay, first);
  assert.equal(cancellations, 1);
  await bridge.close();
});
