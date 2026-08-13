import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const registerHarnessSessionProjection = vi.hoisted(() => vi.fn((value: unknown) => value));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../shared/ipc/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ipc/client")>();
  return { ...actual, registerHarnessSessionProjection };
});

import {
  applyProjectCatalogCommand,
  branchResidentCatalogChat,
  createResidentForCatalogChat,
  loadProjectCatalog,
} from "./projectCatalogClient";

describe("project catalog client", () => {
  beforeEach(() => {
    invoke.mockReset();
    registerHarnessSessionProjection.mockClear();
  });

  it("loads and freezes the exact native catalog snapshot", async () => {
    invoke.mockResolvedValue({
      revision: 0,
      state: {
        schemaVersion: 2,
        selectedProjectId: "project:personal",
        projects: [{ id: "project:personal", kind: "personal", name: "Personal", root: { kind: "studio-managed-empty" }, pinned: false, archived: false, selectedChatId: null, chats: [] }],
      },
    });
    const snapshot = await loadProjectCatalog();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.state.projects[0]?.name).toBe("Personal");
    expect(Object.isFrozen(snapshot.state)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("project_catalog_load");
  });

  it("rejects extras, unsafe revisions, and malformed state", async () => {
    invoke.mockResolvedValue({ revision: 0, state: {}, extra: true });
    await expect(loadProjectCatalog()).rejects.toThrow("Project catalog unavailable");
    invoke.mockResolvedValue({ revision: Number.MAX_SAFE_INTEGER + 1, state: {} });
    await expect(loadProjectCatalog()).rejects.toThrow("Project catalog unavailable");
  });

  it("rejects nested accessors without invoking them", async () => {
    let reads = 0;
    const state = Object.defineProperty({}, "schemaVersion", { enumerable: true, get: () => { reads += 1; return 2; } });
    invoke.mockResolvedValue({ revision: 0, state });
    await expect(loadProjectCatalog()).rejects.toThrow("Project catalog unavailable");
    expect(reads).toBe(0);
  });

  it("applies a closed command with exact revision compare-and-swap semantics", async () => {
    invoke.mockResolvedValue({
      revision: 1,
      state: {
        schemaVersion: 2,
        selectedProjectId: "project:personal",
        projects: [{
          id: "project:personal",
          kind: "personal",
          name: "Personal",
          root: { kind: "studio-managed-empty" },
          pinned: false,
          archived: false,
          selectedChatId: "chat:one",
          chats: [{ id: "chat:one", projectId: "project:personal", title: "New chat", pinned: false, archived: false, binding: null }],
        }],
      },
    });

    const command = { type: "chat.create", projectId: "project:personal", chatId: "chat:one", title: "New chat" } as const;
    const snapshot = await applyProjectCatalogCommand(0, command);

    expect(snapshot.revision).toBe(1);
    expect(snapshot.state.projects[0]?.selectedChatId).toBe("chat:one");
    expect(invoke).toHaveBeenCalledWith("project_catalog_apply", { expectedRevision: 0, command });
  });

  it("rejects unsafe apply revisions before native invocation", async () => {
    await expect(applyProjectCatalogCommand(-1, {
      type: "selection.select-project",
      projectId: "project:personal",
    })).rejects.toThrow("Project catalog unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects hostile command accessors before invoking native code", async () => {
    let reads = 0;
    const command = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => { reads += 1; return "selection.select-project"; },
    });

    await expect(applyProjectCatalogCommand(0, command as never)).rejects.toThrow("Project catalog unavailable");
    expect(reads).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("decodes the native resident binding transaction without conflating catalog and daemon ids", async () => {
    invoke.mockResolvedValue({
      catalog: {
        revision: 2,
        state: {
          schemaVersion: 2, selectedProjectId: "project:personal",
          projects: [{ id: "project:personal", kind: "personal", name: "Personal", root: { kind: "studio-managed-empty" }, pinned: false, archived: false, selectedChatId: "studio-chat-1", chats: [{
            id: "studio-chat-1", projectId: "project:personal", title: "New chat", pinned: false, archived: false,
            binding: { kind: "prime-session", accountId: null, sessionId: "daemon-active-1", sessionFile: "daemon-chat-1.jsonl", agentId: "daemon-chat-1" },
          }] }],
        },
      },
      session: {
        sessionId: "daemon-active-1", accountId: null, projectId: "daemon-project-1", chatId: "daemon-chat-1",
        cursor: { runtimeGeneration: "generation-1", sequence: 0 }, state: "idle", freshness: "live",
        parentMessages: [], children: [], queue: [], tools: [], resources: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
        workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
        performance: { status: "unavailable", sessionId: "daemon-active-1", cursor: { runtimeGeneration: "generation-1", sequence: 0 }, reason: "event_chronology_unavailable" },
      },
    });
    const result = await createResidentForCatalogChat(1, "project:personal", "studio-chat-1");
    expect(result.catalog.state.projects[0]?.id).toBe("project:personal");
    expect(result.session.projectId).toBe("daemon-project-1");
    expect(registerHarnessSessionProjection).toHaveBeenCalledOnce();
    expect(registerHarnessSessionProjection).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "daemon-active-1",
      chatId: "daemon-chat-1",
      cursor: { runtimeGeneration: "generation-1", sequence: 0 },
    }));
    expect(invoke).toHaveBeenCalledWith("harness_create_resident_chat", { request: { expectedRevision: 1, projectId: "project:personal", chatId: "studio-chat-1" } });
  });

  it("admits a daemon fork only when native authority returns a distinct bound Studio branch chat", async () => {
    invoke.mockResolvedValue({
      branchChatId: "studio-branch-1",
      catalog: {
        revision: 3,
        state: {
          schemaVersion: 2, selectedProjectId: "project:personal",
          projects: [{ id: "project:personal", kind: "personal", name: "Personal", root: { kind: "studio-managed-empty" }, pinned: false, archived: false, selectedChatId: "studio-branch-1", chats: [{
            id: "studio-branch-1", projectId: "project:personal", title: "Branch of New chat", pinned: false, archived: false,
            binding: { kind: "prime-session", accountId: null, sessionId: "daemon-active-branch", sessionFile: "branch.jsonl", agentId: "daemon-chat-branch" },
          }] }],
        },
      },
      session: {
        sessionId: "daemon-active-branch", accountId: null, projectId: "daemon-project-1", chatId: "daemon-chat-branch",
        cursor: { runtimeGeneration: "generation-branch", sequence: 1 }, state: "idle", freshness: "live",
        parentMessages: [{ channel: "parent", kind: "user", id: "message-1", text: "Branch here", emittedAtMs: 1 }],
        children: [], queue: [], tools: [], resources: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
        workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
        performance: { status: "unavailable", sessionId: "daemon-active-branch", cursor: { runtimeGeneration: "generation-branch", sequence: 1 }, reason: "event_chronology_unavailable" },
      },
    });

    const result = await branchResidentCatalogChat({
      expectedRevision: 2,
      projectId: "project:personal",
      sourceChatId: "studio-chat-1",
      sourceSessionId: "daemon-active-source",
      messageId: "message-1",
      expectedCursor: { runtimeGeneration: "generation-source", sequence: 7 },
    });

    expect(result.branchChatId).toBe("studio-branch-1");
    expect(result.session.sessionId).toBe("daemon-active-branch");
    expect(result.session.chatId).toBe("daemon-chat-branch");
    expect(invoke).toHaveBeenCalledWith("harness_branch_resident_chat", { request: {
      expectedRevision: 2,
      projectId: "project:personal",
      sourceChatId: "studio-chat-1",
      sourceSessionId: "daemon-active-source",
      messageId: "message-1",
      expectedCursor: { runtimeGeneration: "generation-source", sequence: 7 },
    } });
    await expect(branchResidentCatalogChat({
      expectedRevision: 2,
      projectId: "project:personal",
      sourceChatId: "studio-chat-1",
      sourceSessionId: "daemon-active-branch",
      messageId: "message-1",
      expectedCursor: { runtimeGeneration: "generation-source", sequence: 7 },
    })).rejects.toThrow("Project catalog unavailable");
  });

  it("rejects a branch response that conflates the Studio chat id with daemon identity", async () => {
    invoke.mockResolvedValue({
      branchChatId: "daemon-active-branch",
      catalog: {
        revision: 3,
        state: {
          schemaVersion: 2, selectedProjectId: "project:personal",
          projects: [{ id: "project:personal", kind: "personal", name: "Personal", root: { kind: "studio-managed-empty" }, pinned: false, archived: false, selectedChatId: "daemon-active-branch", chats: [{
            id: "daemon-active-branch", projectId: "project:personal", title: "Branch", pinned: false, archived: false,
            binding: { kind: "prime-session", accountId: null, sessionId: "daemon-active-branch", sessionFile: "branch.jsonl", agentId: "daemon-chat-branch" },
          }] }],
        },
      },
      session: {
        sessionId: "daemon-active-branch", accountId: null, projectId: "daemon-project-1", chatId: "daemon-chat-branch",
        cursor: { runtimeGeneration: "generation-branch", sequence: 1 }, state: "idle", freshness: "live",
        parentMessages: [], children: [], queue: [], tools: [], resources: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
        workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
        performance: { status: "unavailable", sessionId: "daemon-active-branch", cursor: { runtimeGeneration: "generation-branch", sequence: 1 }, reason: "event_chronology_unavailable" },
      },
    });

    await expect(branchResidentCatalogChat({
      expectedRevision: 2,
      projectId: "project:personal",
      sourceChatId: "studio-chat-1",
      sourceSessionId: "daemon-active-source",
      messageId: "message-1",
      expectedCursor: { runtimeGeneration: "generation-source", sequence: 7 },
    })).rejects.toThrow("Project catalog unavailable");
  });
});
