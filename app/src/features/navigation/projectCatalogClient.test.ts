import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { applyProjectCatalogCommand, createResidentForCatalogChat, loadProjectCatalog } from "./projectCatalogClient";

describe("project catalog client", () => {
  beforeEach(() => invoke.mockReset());

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
      },
    });
    const result = await createResidentForCatalogChat(1, "project:personal", "studio-chat-1");
    expect(result.catalog.state.projects[0]?.id).toBe("project:personal");
    expect(result.session.projectId).toBe("daemon-project-1");
    expect(invoke).toHaveBeenCalledWith("harness_create_resident_chat", { request: { expectedRevision: 1, projectId: "project:personal", chatId: "studio-chat-1" } });
  });
});
