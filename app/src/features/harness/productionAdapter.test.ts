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
});
