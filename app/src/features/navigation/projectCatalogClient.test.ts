import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { loadProjectCatalog } from "./projectCatalogClient";

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
});
