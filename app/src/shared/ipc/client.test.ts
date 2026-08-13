import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  eventCallback: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import { attachHarnessSession, bootstrapHarness, decodeBootProjection, decodeHarnessInspectorDetails, decodeHarnessProjectionEvent, decodeRootSessionProjection, executeHarnessStudioOperation, loadHarnessChildPage, loadHarnessInspector, pageHarnessConversationHistory, refreshHarnessSession, refreshHarnessSubscriptionsNow, registerHarnessSessionProjection, retryHarnessWorker, sendHarnessCommand, subscribeHarnessEvents } from "./client";

const unavailable = {
  compatibility: {
    status: "unavailable",
    reason: "security_verification_failed",
  },
  runtime: null,
  sessions: [],
};
const readyCapabilities = ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] as const;
const verifiedRuntime = {
  packageName: "prime-agent",
  packageVersion: "0.7.1",
  packageDigest: `sha256:${"a".repeat(64)}`,
  entrypointDigest: `sha256:${"b".repeat(64)}`,
  protocolName: "prime-agent-daemon",
  protocolVersion: 7,
  schemaRevision: 13,
  schemaId: "prime-agent.schema.json",
  capabilities: readyCapabilities,
} as const;

const session = {
  sessionId: "root",
  accountId: "account",
  provider: "openai-codex",
  projectId: "project",
  chatId: "chat",
  cursor: { runtimeGeneration: "generation", sequence: 1 },
  state: "idle",
  freshness: "live",
  parentMessages: [],
  children: [],
  queue: [],
  tools: [],
  resources: [],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
  },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId: "root", cursor: { runtimeGeneration: "generation", sequence: 1 }, reason: "event_chronology_unavailable" },
};

function sessionAt(cursor: { runtimeGeneration: string; sequence: number }, patch: Record<string, unknown> = {}) {
  return { ...session, ...patch, cursor, performance: { ...session.performance, cursor: { ...cursor } } };
}

describe("Harness IPC client", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockImplementation(async (_name: string, callback: (event: { payload: unknown }) => void) => {
      mocks.eventCallback = callback;
      return () => undefined;
    });
    mocks.eventCallback = null;
  });

  it("accepts only finite performance chronology bound to the exact root snapshot", () => {
    const available = {
      ...session,
      performance: { status: "available", sessionId: "root", cursor: { ...session.cursor }, firstTokenLatencyMs: 75, outputTokens: 40, generationDurationMs: 200, tokensPerSecond: 200 },
    };
    expect(decodeRootSessionProjection(available).performance).toEqual(available.performance);

    for (const performance of [
      { ...available.performance, sessionId: "other" },
      { ...available.performance, cursor: { ...session.cursor, sequence: 2 } },
      { ...available.performance, tokensPerSecond: Number.POSITIVE_INFINITY },
      { ...available.performance, tokensPerSecond: 1_000_001 },
      { ...available.performance, generationDurationMs: 0 },
      { status: "mystery", sessionId: "root", cursor: session.cursor },
    ]) expect(() => decodeRootSessionProjection({ ...session, performance })).toThrow("Harness projection unavailable");
  });

  it("strictly decodes an exact parent history page and rejects hostile chronology", async () => {
    const page = {
      sessionId: "root",
      snapshotCursor: { runtimeGeneration: "generation", sequence: 1 },
      messages: [{ channel: "parent", kind: "user", id: "older-1", text: "Earlier", emittedAtMs: 0 }],
      totalMessages: 2,
      omittedBefore: 0,
      omittedAfter: 1,
      olderCursor: null,
      truncatedByBytes: false,
    };
    mocks.invoke.mockResolvedValueOnce(page);
    const result = await pageHarnessConversationHistory("root", session.cursor, null);
    expect(result).toEqual(page);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("harness_conversation_history_page", {
      request: { sessionId: "root", expectedCursor: session.cursor, before: null },
    });

    for (const hostile of [
      { ...page, extra: true },
      { ...page, sessionId: "crossed" },
      { ...page, snapshotCursor: { ...page.snapshotCursor, sequence: 2 } },
      { ...page, totalMessages: 99 },
      { ...page, messages: [{ channel: "child", kind: "user", id: "private", text: "no", emittedAtMs: 0 }] },
      { ...page, olderCursor: " ".repeat(2) },
    ]) {
      mocks.invoke.mockResolvedValueOnce(hostile);
      await expect(pageHarnessConversationHistory("root", session.cursor, null)).rejects.toThrow("Harness projection unavailable");
    }
  });

  it("decodes provider independently from the opaque account identity", () => {
    const projected = decodeRootSessionProjection(session);
    expect(projected.provider).toBe("openai-codex");
    expect(projected.accountId).toBe("account");
    expect(() => decodeRootSessionProjection({ ...session, provider: "provider with spaces" })).toThrow("Harness projection unavailable");
  });

  it("strictly decodes and deeply freezes an unavailable bootstrap", async () => {
    mocks.invoke.mockResolvedValue(unavailable);
    const projection = await bootstrapHarness();
    expect(projection).toEqual(unavailable);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.compatibility)).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("harness_bootstrap");
  });

  it("strictly decodes and freezes the verified runtime identity attached to bootstrap", () => {
    const projection = decodeBootProjection({
      compatibility: { status: "ready", profile: "verified", capabilities: readyCapabilities },
      runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
      sessions: [],
    });

    expect(projection.runtime).toEqual(verifiedRuntime);
    expect(Object.isFrozen(projection.runtime)).toBe(true);
    expect(Object.isFrozen(projection.runtime?.capabilities)).toBe(true);
  });

  it("binds compatibility to the verified capability set without requiring manifest ordering", () => {
    const projection = decodeBootProjection({
      compatibility: { status: "ready", profile: "verified", capabilities: [...readyCapabilities] },
      runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities].reverse() },
      sessions: [],
    });

    expect(projection.runtime?.capabilities).toEqual([...readyCapabilities].reverse());
  });

  it("rejects an unavailable bootstrap that projects an unverified runtime identity", () => {
    expect(() => decodeBootProjection({
      compatibility: { status: "unavailable", reason: "runtime_identity_mismatch" },
      runtime: { ...verifiedRuntime, entrypointDigest: `sha256:${"c".repeat(64)}` },
      sessions: [],
    })).toThrow("Harness projection unavailable");
  });

  it("accepts the complete browser fixture runtime and sessions as one atomic bootstrap", () => {
    const scenario = JSON.parse(readFileSync("harness-sidecar/test/fixtures/fake-daemon/scenario-manifest.json", "utf8")) as { runtime: unknown; sessions: Record<string, unknown>[] };
    const projected = scenario.sessions.map((candidate) => ({
      ...candidate,
      freshness: "live",
      workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
      performance: { status: "unavailable", sessionId: candidate.sessionId, cursor: { ...(candidate.cursor as Record<string, unknown>) }, reason: "event_chronology_unavailable" },
    }));
    const runtime = scenario.runtime as { capabilities: readonly string[] };

    expect(decodeBootProjection({
      compatibility: { status: "ready", profile: "prime-agent-daemon-v7-schema13-816309b1cd50", capabilities: [...runtime.capabilities] },
      runtime: { ...(scenario.runtime as Record<string, unknown>), capabilities: [...runtime.capabilities] },
      sessions: projected,
    }).runtime).toEqual(scenario.runtime);
  });

  it("rejects extras, impossible capabilities, huge strings, and accessors", () => {
    expect(() => decodeBootProjection({ ...unavailable, extra: true })).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: ["attach_snapshot", "attach_snapshot"],
        },
        runtime: { ...verifiedRuntime, capabilities: ["attach_snapshot", "attach_snapshot"] },
        sessions: [],
      }),
    ).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "x".repeat(129),
          capabilities: [],
        },
        runtime: { ...verifiedRuntime, capabilities: [] },
        sessions: [],
      }),
    ).toThrow();
    const hostile = Object.defineProperty({}, "compatibility", {
      enumerable: true,
      get: () => unavailable.compatibility,
    });
    Object.defineProperty(hostile, "runtime", { enumerable: true, value: null });
    Object.defineProperty(hostile, "sessions", { enumerable: true, value: [] });
    expect(() => decodeBootProjection(hostile)).toThrow();
  });

  it("rejects proxy inputs without invoking their getters", () => {
    let reads = 0;
    const hostile = new Proxy(unavailable, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => decodeBootProjection(hostile)).toThrow();
    expect(reads).toBe(0);
  });

  it("decodes bounded live sessions and rejects unsafe integer chronology", () => {
    expect(
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: readyCapabilities,
        },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [session],
      }).sessions,
    ).toHaveLength(1);
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: readyCapabilities,
        },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [
          {
            ...session,
            cursor: {
              ...session.cursor,
              sequence: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: readyCapabilities,
        },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [
          {
            ...session,
            usage: {
              input: 10,
              output: 20,
              cacheRead: 30,
              cacheWrite: 40,
              totalTokens: 99,
              cost: null,
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: unavailable.compatibility,
        runtime: null,
        sessions: [session],
      }),
    ).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: readyCapabilities,
        },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [
          {
            ...session,
            children: [
              {
                id: "child",
                status: "running",
                task: "task",
                provider: null,
                model: null,
                progress: null,
              },
            ],
          },
          {
            ...session,
            sessionId: "root-2",
            chatId: "chat-2",
            children: [
              {
                id: "child",
                status: "done",
                task: "task",
                provider: null,
                model: null,
                progress: 1,
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes exact projection events", () => {
    expect(
      decodeHarnessProjectionEvent({
        schemaVersion: 1,
        sequence: 1,
        type: "session_projection",
        session,
      }),
    ).toEqual({
      schemaVersion: 1,
      sequence: 1,
      type: "session_projection",
      session,
    });
    expect(() =>
      decodeHarnessProjectionEvent({
        schemaVersion: 1,
        sequence: 1,
        type: "session_projection",
        session,
        extra: true,
      }),
    ).toThrow();
  });

  it("binds typed attach and command responses to the requested session and command", async () => {
    mocks.invoke.mockResolvedValueOnce({
      ...session,
      ...sessionAt({ ...session.cursor, sequence: 2 }),
    });
    const attached = await attachHarnessSession("root");
    expect(attached.cursor.sequence).toBe(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_attach_session", {
      request: { sessionId: "root" },
    });

    const commandSession = {
      ...session,
      ...sessionAt({ ...session.cursor, sequence: 3 }),
      state: "working",
    };
    mocks.invoke.mockResolvedValueOnce({
      commandId: "command-12345678",
      outcome: "accepted",
      session: commandSession,
    });
    const result = await sendHarnessCommand({
      sessionId: "root",
      commandId: "command-12345678",
      expectedCursor: { runtimeGeneration: "generation", sequence: 2 },
      kind: "prompt",
      text: "Hello Harness",
    });
    expect(result).toEqual({
      commandId: "command-12345678",
      outcome: "accepted",
      session: commandSession,
    });
    expect(Object.isFrozen(result.session)).toBe(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_session_command", {
      request: {
        sessionId: "root",
        commandId: "command-12345678",
        expectedCursor: { runtimeGeneration: "generation", sequence: 2 },
        kind: "prompt",
        text: "Hello Harness",
      },
    });
  });

  it("binds worker retry responses to the exact observation and next cursor", async () => {
    const observationId = "worker-recovery-0123456789abcdef012345";
    const failed = {
      ...session,
      state: "failed",
      workerRecovery: { status: "retryable_failure", closureReason: "supervisor_recovery_exhausted", observationId, automaticRetryCount: 0, detail: "Supervisor recovery exhausted" },
    };
    mocks.invoke.mockResolvedValueOnce({
      compatibility: { status: "ready", profile: "profile", capabilities: [...readyCapabilities] },
      runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
      sessions: [failed],
    });
    await bootstrapHarness();
    const recovered = {
      ...session,
      ...sessionAt({ ...session.cursor, sequence: 2 }),
      workerRecovery: { status: "recovered", closureReason: "supervisor_recovery_exhausted", observationId, automaticRetryCount: 1, detail: null },
    };
    mocks.invoke.mockResolvedValueOnce({ observationId, outcome: "recovered", session: recovered });
    await expect(retryHarnessWorker(session.sessionId, observationId)).resolves.toEqual({ observationId, outcome: "recovered", session: recovered });
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_retry_worker", { request: { sessionId: session.sessionId, observationId } });
  });

  it("binds live refresh snapshots to the exact next Studio cursor", async () => {
    const refreshed = sessionAt({ ...session.cursor, sequence: 2 }, { state: "working" });
    mocks.invoke.mockResolvedValueOnce(refreshed);
    await expect(refreshHarnessSession("root", session.cursor)).resolves.toEqual(refreshed);
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_refresh_session", { request: { sessionId: "root", knownCursor: session.cursor } });
    mocks.invoke.mockResolvedValueOnce({ ...refreshed, cursor: { ...refreshed.cursor, sequence: 4 } });
    await expect(refreshHarnessSession("root", session.cursor)).rejects.toThrow("Harness projection unavailable");
    const replacement = sessionAt({ runtimeGeneration: "generation-b", sequence: 1 });
    mocks.invoke.mockResolvedValueOnce(replacement);
    await expect(refreshHarnessSession("root", session.cursor)).resolves.toEqual(replacement);
  });

  it("strictly decodes bounded inspector details from the verified broker", async () => {
    const details = {
      observedAtMs: 10,
      startedAtMs: null,
      context: { usedTokens: 2, capacityTokens: 100, turns: 1, samples: [2] },
      extensionUi: {
        status: "available",
        requests: [
          { id: "confirm-1", method: "confirm", title: "Continue?", message: "Proceed?", cursor: session.cursor },
          { id: "select-1", method: "select", title: "Branch", options: ["main", "release"], cursor: session.cursor },
          { id: "input-1", method: "input", title: "Name", placeholder: null, cursor: session.cursor },
          { id: "editor-1", method: "editor", title: "Instructions", prefill: "Review this.", cursor: session.cursor },
        ],
      },
      turnUsage: {
        totalTurns: 2,
        omittedTurns: 0,
        rows: [
          { turn: 1, occurredAtMs: 5, input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 },
          { turn: 2, occurredAtMs: 8, input: 12, output: 6, cacheRead: 3, cacheWrite: 0, totalTokens: 21 },
        ],
      },
      contributions: [{ id: "main", label: "Main agent", tokens: 2 }],
      notices: [],
      activity: [
        {
          id: "activity-1",
          occurredAtMs: 9,
          group: "Agent",
          kind: "tool",
          title: "Read",
          detail: "package.json",
          tool: {
            command: "read",
            redacted: false,
            status: "succeeded",
            durationMs: 2,
            files: [{ candidateId: "candidate-tool", label: "package.json" }],
          },
        },
      ],
      outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-output", kind: "file" }],
      sources: [
        {
          id: "source-1",
          label: "package.json",
          detail: "Workspace file",
          candidateId: "candidate-source",
          kind: "file",
        },
      ],
      children: {
        child: {
          summary: "Review",
          startedAtMs: 1,
          context: null,
          transcript: [
            {
              id: "message-1",
              actor: "assistant",
              occurredAtMs: 2,
              text: "Done",
            },
          ],
          activity: [],
          files: [],
          error: null,
        },
      },
    };
    mocks.invoke.mockResolvedValueOnce(JSON.stringify(details));
    await expect(loadHarnessInspector("root")).resolves.toEqual(details);
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_inspector", {
      request: { sessionId: "root" },
    });

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, untrusted: true }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, outputs: [{ id: "output-1", label: "Report", path: "C:\\secrets.txt", kind: "file" }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, turnUsage: { ...details.turnUsage, rows: [{ ...details.turnUsage.rows[0], totalTokens: 18 }] } }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, turnUsage: { ...details.turnUsage, rows: [...details.turnUsage.rows].reverse() } }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, extensionUi: { status: "available", requests: [{ ...details.extensionUi.requests[0], method: "approval" }] } }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    const activity = details.activity[0];
    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, activity: [{ ...activity, tool: { ...activity.tool, redacted: "yes" } }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, activity: [{ ...activity, tool: { ...activity.tool, durationMs: -1 } }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, activity: [{ ...activity, tool: { ...activity.tool, command: "show \u202Etxt.exe" } }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, activity: [activity, { ...activity }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ ...details, activity: [activity, { ...activity, id: "activity-2", tool: { ...activity.tool, files: [...activity.tool.files] } }] }));
    await expect(loadHarnessInspector("root")).rejects.toThrow("Harness projection unavailable");

    expect(() => decodeHarnessInspectorDetails({ ...details, extensionUi: { status: "available", requests: [{ ...details.extensionUi.requests[0], cursor: { ...session.cursor, sequence: 2 } }] } }, session.cursor)).toThrow("Harness projection unavailable");
  });

  it("routes closed Harness actions and validates the operation outcome", async () => {
    const operationSession = sessionAt({ ...session.cursor, sequence: 2 });
    mocks.invoke.mockResolvedValueOnce({
      compatibility: { status: "ready", profile: "profile", capabilities: [...readyCapabilities] },
      runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
      sessions: [session],
    });
    mocks.invoke.mockResolvedValueOnce({
      operationId: "operation-12345678",
      status: "queued",
      commandId: "command-12345678",
      position: 2,
      revision: null,
      reason: null,
      retryable: null,
      session: operationSession,
    });
    await bootstrapHarness();
    await expect(
      executeHarnessStudioOperation({
        sessionId: "root",
        operation: {
          operationId: "operation-12345678",
          action: "harness.session.follow-up",
          payload: { sessionId: "root", text: "Continue" },
        },
        expectedCursor: session.cursor,
      }),
    ).resolves.toEqual({
      status: "queued",
      commandId: "command-12345678",
      position: 2,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_studio_operation", {
      request: {
        sessionId: "root",
        operationId: "operation-12345678",
        action: "harness.session.follow-up",
        payloadJson: '{"sessionId":"root","text":"Continue"}',
        expectedCursor: session.cursor,
        idempotencyKey: "operation-12345678",
      },
    });

    await expect(
      executeHarnessStudioOperation({
        sessionId: "other",
        operation: {
          action: "harness.session.abort",
          payload: { sessionId: "root" },
        },
      }),
    ).rejects.toThrow("Harness projection unavailable");
  });

  it("loads a closed child page without admitting raw file paths to the renderer", async () => {
    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ status: "available", tab: "files", items: [{ id: "file-1", label: "report.md", candidateId: "candidate-1", change: "modified" }], previousCursor: "opaque-cursor", omittedItems: 2 }));
    await expect(loadHarnessChildPage("root", "child-a", "files", { runtimeGeneration: "generation-1", sequence: 7 }, null)).resolves.toEqual({ status: "available", tab: "files", items: [{ id: "file-1", label: "report.md", candidateId: "candidate-1", change: "modified" }], previousCursor: "opaque-cursor", omittedItems: 2 });
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_child_data_page", { request: { sessionId: "root", childId: "child-a", tab: "files", expectedCursor: { runtimeGeneration: "generation-1", sequence: 7 }, pageCursor: null } });
    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ status: "available", tab: "files", items: [{ id: "file-1", path: "C:\\private.txt", change: "read" }], previousCursor: null, omittedItems: 0 }));
    await expect(loadHarnessChildPage("root", "child-a", "files", { runtimeGeneration: "generation-1", sequence: 7 }, null)).rejects.toThrow("Harness projection unavailable");
  });

  it("rejects mismatched command identity and malformed session command output", async () => {
    mocks.invoke.mockResolvedValueOnce({
      commandId: "other-command-id",
      outcome: "accepted",
      session,
    });
    await expect(
      sendHarnessCommand({
        sessionId: "root",
        commandId: "command-12345678",
        expectedCursor: session.cursor,
        kind: "prompt",
        text: "Hello",
      }),
    ).rejects.toThrow("Harness projection unavailable");
    mocks.invoke.mockResolvedValueOnce({
      commandId: "command-12345678",
      outcome: "unknown",
      session,
    });
    await expect(
      sendHarnessCommand({
        sessionId: "root",
        commandId: "command-12345678",
        expectedCursor: session.cursor,
        kind: "prompt",
        text: "Hello",
      }),
    ).rejects.toThrow("Harness projection unavailable");
  });

  it("uses one listener and stops delivery after a sequence gap", async () => {
    const received: number[] = [];
    mocks.invoke.mockResolvedValue({
      compatibility: {
        status: "ready",
        profile: "profile",
        capabilities: [...readyCapabilities],
      },
      runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
      sessions: [session],
    });
    await bootstrapHarness();
    const unsubscribe = subscribeHarnessEvents((event) => received.push(event.sequence));
    await vi.waitFor(() => expect(mocks.eventCallback).not.toBeNull());
    const next = sessionAt({ ...session.cursor, sequence: 2 });
    mocks.eventCallback?.({
      payload: {
        schemaVersion: 1,
        sequence: 1,
        type: "session_projection",
        session: next,
      },
    });
    mocks.eventCallback?.({
      payload: {
        schemaVersion: 1,
        sequence: 3,
        type: "session_projection",
        session: { ...next, cursor: { ...next.cursor, sequence: 3 } },
      },
    });
    mocks.eventCallback?.({
      payload: {
        schemaVersion: 1,
        sequence: 2,
        type: "session_projection",
        session: { ...next, cursor: { ...next.cursor, sequence: 3 } },
      },
    });
    expect(received).toEqual([1]);
    unsubscribe();
  });

  it("can install the global listener after a transient registration failure", async () => {
    vi.resetModules();
    const isolatedClient = await import("./client");
    mocks.invoke.mockResolvedValue(unavailable);
    await isolatedClient.bootstrapHarness();
    mocks.listen.mockRejectedValueOnce(new Error("transient"));
    const unsubscribeFirst = isolatedClient.subscribeHarnessEvents(() => undefined);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
    await isolatedClient.bootstrapHarness();
    const unsubscribeSecond = isolatedClient.subscribeHarnessEvents(() => undefined);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
    expect(mocks.eventCallback).not.toBeNull();
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("polls a newly registered resident and advances from the direct command cursor", async () => {
    const refreshCursors: number[] = [];
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "harness_bootstrap") return {
        compatibility: { status: "ready", profile: "profile", capabilities: [...readyCapabilities] },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [],
      };
      if (command === "harness_refresh_session") {
        const request = args?.request as { knownCursor: { sequence: number } };
        refreshCursors.push(request.knownCursor.sequence);
        return sessionAt({ ...session.cursor, sequence: request.knownCursor.sequence + 1 });
      }
      if (command === "harness_session_command") return {
        commandId: "command-12345678",
        outcome: "accepted",
        session: sessionAt({ ...session.cursor, sequence: 3 }, { state: "working" }),
      };
      throw new Error(`Unexpected command: ${command}`);
    });

    await bootstrapHarness();
    registerHarnessSessionProjection(session);
    const received: number[] = [];
    const unsubscribe = subscribeHarnessEvents((event) => received.push(event.session.cursor.sequence));
    await refreshHarnessSubscriptionsNow();
    await sendHarnessCommand({
      sessionId: session.sessionId,
      commandId: "command-12345678",
      expectedCursor: { ...session.cursor, sequence: 2 },
      kind: "prompt",
      text: "Keep polling",
    });
    await refreshHarnessSubscriptionsNow();
    unsubscribe();

    expect(refreshCursors).toEqual([1, 3]);
    expect(received).toEqual([2, 4]);
  });

  it("discards a refresh response when a direct command advances the session first", async () => {
    let resolveFirstRefresh!: (value: unknown) => void;
    const refreshCursors: number[] = [];
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "harness_bootstrap") return {
        compatibility: { status: "ready", profile: "profile", capabilities: [...readyCapabilities] },
        runtime: { ...verifiedRuntime, capabilities: [...readyCapabilities] },
        sessions: [session],
      };
      if (command === "harness_refresh_session") {
        const request = args?.request as { knownCursor: { sequence: number } };
        refreshCursors.push(request.knownCursor.sequence);
        if (request.knownCursor.sequence === 1) {
          return await new Promise((resolve) => { resolveFirstRefresh = resolve; });
        }
        return sessionAt({ ...session.cursor, sequence: request.knownCursor.sequence + 1 });
      }
      if (command === "harness_session_command") return {
        commandId: "command-12345678",
        outcome: "accepted",
        session: sessionAt({ ...session.cursor, sequence: 2 }, { state: "working" }),
      };
      throw new Error(`Unexpected command: ${command}`);
    });

    await bootstrapHarness();
    const received: number[] = [];
    const unsubscribe = subscribeHarnessEvents((event) => received.push(event.session.cursor.sequence));
    const staleRefresh = refreshHarnessSubscriptionsNow();
    await vi.waitFor(() => expect(refreshCursors).toEqual([1]));
    await sendHarnessCommand({
      sessionId: session.sessionId,
      commandId: "command-12345678",
      expectedCursor: session.cursor,
      kind: "prompt",
      text: "Advance first",
    });
    resolveFirstRefresh(sessionAt({ ...session.cursor, sequence: 2 }));
    await staleRefresh;
    await refreshHarnessSubscriptionsNow();
    unsubscribe();

    expect(refreshCursors).toEqual([1, 2]);
    expect(received).toEqual([3]);
  });
});
