import { describe, expect, it, vi } from "vitest";

import { createStudioStore, initialStudioState } from "../../shared/state/store";
import type { RootSessionProjection } from "../../entities/harness/types";
import { createProductionHarnessInspectorAdapter } from "./productionAdapter";

const session: RootSessionProjection = {
  sessionId: "daemon-active-1", accountId: null, projectId: "daemon-project-hash", chatId: "daemon-session-1",
  cursor: { runtimeGeneration: "generation-1", sequence: 7 }, state: "idle", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
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

  it("projects silent-worker recovery as unavailable because the native bridge has no closure identity", () => {
    const adapter = createProductionHarnessInspectorAdapter(boundStore(), { load: vi.fn(), execute: vi.fn() });

    expect(adapter.workerRecovery).toEqual({
      status: "unavailable",
      reason: "Prime Studio cannot safely retry a silent worker because the native Harness bridge does not expose a verified closure reason and retry identity.",
    });
    expect(adapter.settings?.harnessPolicy).not.toBe(true);
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
});
