import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { applyChatDisplayRevision, loadChatDisplayRevisions } from "./chatDisplayClient";

describe("chat display client", () => {
  beforeEach(() => invoke.mockReset());

  it("loads and freezes a bounded exact native snapshot for fresh-store hydration", async () => {
    invoke.mockResolvedValue({ schemaVersion: 1, records: [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "persisted" }] });
    const snapshot = await loadChatDisplayRevisions();
    expect(snapshot).toEqual({ schemaVersion: 1, records: [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "persisted" }] });
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(invoke).toHaveBeenCalledWith("chat_display_load");
  });

  it("admits only an exact successor returned for the requested Studio chat and message", async () => {
    invoke.mockResolvedValue({ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "next" });
    await expect(applyChatDisplayRevision({ chatId: "chat:one", messageId: "answer:one", expectedRevision: 1, sourceContent: "original", content: "next" }))
      .resolves.toEqual({ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "next" });
    expect(invoke).toHaveBeenCalledWith("chat_display_apply", { request: { chatId: "chat:one", messageId: "answer:one", expectedRevision: 1, sourceContent: "original", content: "next" } });

    invoke.mockResolvedValue({ chatId: "chat:other", messageId: "answer:one", revision: 2, sourceContent: "original", content: "next" });
    await expect(applyChatDisplayRevision({ chatId: "chat:one", messageId: "answer:one", expectedRevision: 1, sourceContent: "original", content: "next" })).rejects.toThrow("Chat display unavailable");
  });

  it("rejects malformed oversized unsafe and accessor-hostile transport before state admission", async () => {
    invoke.mockResolvedValue({ schemaVersion: 1, records: [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "x".repeat(128 * 1024 + 1) }] });
    await expect(loadChatDisplayRevisions()).rejects.toThrow("Chat display unavailable");

    let reads = 0;
    const hostile = Object.defineProperty({}, "chatId", { enumerable: true, get: () => { reads += 1; return "chat:one"; } });
    await expect(applyChatDisplayRevision(hostile as never)).rejects.toThrow("Chat display unavailable");
    expect(reads).toBe(0);

    invoke.mockClear();
    await expect(applyChatDisplayRevision({ chatId: "chat:one", messageId: "answer:one", expectedRevision: 1, sourceContent: "original", content: "bidirectional \u202econtent" }))
      .rejects.toThrow("Chat display unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });
});
