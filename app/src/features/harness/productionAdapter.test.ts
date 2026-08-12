import { describe, expect, it, vi } from "vitest";

import { createStudioStore, initialStudioState } from "../../shared/state/store";
import type { RootSessionProjection } from "../../entities/harness/types";
import { createProductionHarnessInspectorAdapter } from "./productionAdapter";

const session: RootSessionProjection = {
  sessionId: "daemon-active-1", accountId: null, projectId: "daemon-project-hash", chatId: "daemon-session-1",
  cursor: { runtimeGeneration: "generation-1", sequence: 7 }, state: "idle", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
};

function boundStore() {
  return createStudioStore(initialStudioState({
    sessions: [session],
    compatibility: { status: "ready", profile: "profile", capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] },
    projectCatalog: {
      schemaVersion: 2, selectedProjectId: "studio-project-1", projects: [{
        id: "studio-project-1", kind: "folder", name: "Workspace", root: { kind: "folder", path: "C:\\work" },
        pinned: false, archived: false, selectedChatId: "studio-chat-1", chats: [{
          id: "studio-chat-1", projectId: "studio-project-1", title: "New chat", pinned: false, archived: false,
          binding: { kind: "prime-session", accountId: null, sessionId: "daemon-active-1", sessionFile: "daemon-session-1.jsonl", agentId: "daemon-session-1" },
        }],
      }],
    },
  }));
}

describe("production Harness inspector adapter", () => {
  it("loads by authoritative daemon root identity and dispatches returned projections", async () => {
    const store = boundStore();
    const load = vi.fn(async () => ({ observedAtMs: 1, startedAtMs: null, context: null, contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {} }));
    const next = { ...session, cursor: { ...session.cursor, sequence: 8 }, state: "working" as const };
    const execute = vi.fn(async () => ({ outcome: { status: "accepted" as const, commandId: "command-1" }, session: next }));
    const adapter = createProductionHarnessInspectorAdapter(store, { load, execute });

    await adapter.load("daemon-active-1");
    expect(load).toHaveBeenCalledWith("daemon-active-1");
    await expect(adapter.execute({ action: "composer.model.select", payload: { chatId: "studio-chat-1", modelId: "openai/gpt-test" } })).resolves.toEqual({ status: "accepted", commandId: "command-1" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "daemon-active-1", expectedCursor: session.cursor }));
    expect(store.getSnapshot().sessions["daemon-active-1"]?.cursor.sequence).toBe(8);
  });

  it("loads composer choices only from the admitted session inspector projection", async () => {
    const store = boundStore();
    const composer = {
      models: [{ id: "openai/gpt-test", label: "GPT Test", shortLabel: "GPT Test", enabled: true }],
      selectedModel: "openai/gpt-test",
      thinkingLevels: ["low", "high"] as const,
      selectedThinking: "high" as const,
      supportedCommands: ["model", "effort", "compact", "fork", "export"] as const,
    };
    const load = vi.fn(async () => ({ observedAtMs: 1, startedAtMs: null, context: null, contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {}, composer }));
    const adapter = createProductionHarnessInspectorAdapter(store, { load, execute: vi.fn() });

    await expect(adapter.loadComposer!(session.sessionId)).resolves.toEqual(composer);
    await expect(adapter.loadComposer!("unbound-session")).rejects.toThrow("not admitted");
    expect(load).toHaveBeenCalledOnce();
  });

  it("rejects unbound, substituted, and ambiguous catalog identities without IPC", async () => {
    const store = boundStore();
    const execute = vi.fn();
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute });
    await expect(adapter.execute({ action: "composer.model.select", payload: { chatId: "missing-chat", modelId: "openai/gpt-test" } })).resolves.toMatchObject({ status: "rejected" });
    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: "substituted", text: "no" } })).resolves.toMatchObject({ status: "rejected" });
    await expect(adapter.load("substituted")).rejects.toThrow("not admitted");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports unavailable until the native broker publishes a ready compatibility profile", () => {
    const store = createStudioStore(initialStudioState());
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute: vi.fn() });
    expect(adapter.availability).toEqual({ status: "unavailable", reason: "The verified Prime Harness broker is not live." });
  });

  it("keeps the verified degraded capability subset available", async () => {
    const store = boundStore();
    store.dispatch({
      type: "harness/bootstrap-loaded",
      projection: {
        compatibility: {
          status: "degraded",
          profile: "profile",
          capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
          unavailable: [{ capability: "extension_ui", reason: "missing_mandatory_capability" }],
        },
        sessions: [session],
      },
    });
    const execute = vi.fn(async () => ({ outcome: { status: "accepted" as const, commandId: "command-1" }, session: null }));
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute });

    expect(adapter.availability).toEqual({ status: "available" });
    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "continue" } }))
      .resolves.toEqual({ status: "accepted", commandId: "command-1" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("admits exactly one native retry for the authoritative failed observation", async () => {
    const store = boundStore();
    const observationId = "worker-recovery-0123456789abcdef012345";
    store.dispatch({ type: "harness/session-projected", session: {
      ...session,
      state: "failed",
      workerRecovery: { status: "retryable_failure", closureReason: "supervisor_recovery_exhausted", observationId, automaticRetryCount: 0, detail: "Supervisor recovery exhausted" },
    } });
    const recovered: RootSessionProjection = {
      ...session,
      cursor: { ...session.cursor, sequence: 8 },
      workerRecovery: { status: "recovered", closureReason: "supervisor_recovery_exhausted", observationId, automaticRetryCount: 1, detail: null },
    };
    const retryWorker = vi.fn(async () => ({ observationId, outcome: "recovered" as const, session: recovered }));
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute: vi.fn(), retryWorker });
    expect(adapter.workerRecovery?.status).toBe("available");
    if (adapter.workerRecovery?.status !== "available") throw new Error("fixture recovery unavailable");

    await expect(adapter.workerRecovery.retry(session.sessionId, observationId)).resolves.toEqual({ outcome: "recovered", session: recovered });
    expect(store.getSnapshot().sessions[session.sessionId]?.workerRecovery.status).toBe("recovered");
    await expect(adapter.workerRecovery.retry(session.sessionId, observationId)).rejects.toThrow("not bound");
    expect(retryWorker).toHaveBeenCalledOnce();
  });

  it.each(["disconnected", "unknown_outcome"] as const)("does not dispatch or retry a %s session", async (freshness) => {
    const store = boundStore();
    store.dispatch({ type: "harness/session-projected", session: { ...session, freshness } });
    const execute = vi.fn();
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute });

    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "do not replay" } }))
      .resolves.toMatchObject({ status: "rejected", retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks a worker whose runtime state is disconnected even when broker freshness is still live", async () => {
    const store = boundStore();
    store.dispatch({ type: "harness/session-projected", session: { ...session, state: "disconnected", freshness: "live" } });
    const execute = vi.fn();
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute });

    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "do not replay" } }))
      .resolves.toMatchObject({ status: "rejected", retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["failed", "stopped"] as const)("blocks terminal runtime state %s even while broker freshness is live", async (state) => {
    const store = boundStore();
    store.dispatch({ type: "harness/session-projected", session: { ...session, state, freshness: "live" } });
    const execute = vi.fn();
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute });

    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "do not replay" } }))
      .resolves.toMatchObject({ status: "rejected", retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("surfaces a closed transport after exactly one dispatch and never retries it", async () => {
    const execute = vi.fn(async () => { throw new Error("Daemon worker client closed"); });
    const adapter = createProductionHarnessInspectorAdapter(boundStore(), { load: vi.fn(), execute });

    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "one attempt" } }))
      .rejects.toThrow("Daemon worker client closed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not turn a runtime-generation change into an automatic mutation replay", async () => {
    const execute = vi.fn(async () => ({
      outcome: { status: "rejected" as const, reason: "Session changed; refresh before retrying the operation.", retryable: true },
      session: null,
    }));
    const adapter = createProductionHarnessInspectorAdapter(boundStore(), { load: vi.fn(), execute });

    await expect(adapter.execute({ action: "harness.session.prompt", payload: { sessionId: session.sessionId, text: "one attempt" } }))
      .resolves.toEqual({ status: "rejected", reason: "Session changed; refresh before retrying the operation.", retryable: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("passes only an opaque candidate ID for an admitted root session", async () => {
    const store = boundStore();
    const openArtifact = vi.fn(async () => ({ kind: "unsupported" as const, reason: "fixture" }));
    const adapter = createProductionHarnessInspectorAdapter(store, { load: vi.fn(), execute: vi.fn(), openArtifact });
    await expect(adapter.openArtifact!(session.sessionId, "candidate-opaque")).resolves.toEqual({ kind: "unsupported", reason: "fixture" });
    expect(openArtifact).toHaveBeenCalledWith(session.sessionId, "candidate-opaque");
    await expect(adapter.openArtifact!("cross-session", "candidate-opaque")).resolves.toMatchObject({ kind: "unsupported" });
    expect(openArtifact).toHaveBeenCalledTimes(1);
  });
});
