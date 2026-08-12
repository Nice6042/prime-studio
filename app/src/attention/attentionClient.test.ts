import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { loadAttentionSnapshot, markAttentionSeen } from "./attentionClient";

describe("attention native client", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("strictly decodes a bounded cursor snapshot", async () => {
    mocks.invoke.mockResolvedValue({ revision: 3, records: [{ chatId: "chat-a", chatSeen: { runtimeGeneration: "g1", sequence: 2 }, activitySeen: null }] });
    await expect(loadAttentionSnapshot()).resolves.toEqual({ revision: 3, records: [{ chatId: "chat-a", chatSeen: { runtimeGeneration: "g1", sequence: 2 }, activitySeen: null }] });
  });

  it("sends an exact revision, channel, chat and authoritative cursor", async () => {
    mocks.invoke.mockResolvedValue({ revision: 4, records: [] });
    await markAttentionSeen(3, "chat-a", "activity", { runtimeGeneration: "g1", sequence: 9 });
    expect(mocks.invoke).toHaveBeenCalledWith("attention_mark_seen", { request: { expectedRevision: 3, chatId: "chat-a", channel: "activity", cursor: { runtimeGeneration: "g1", sequence: 9 } } });
  });

  it("rejects malformed native snapshots instead of inventing read state", async () => {
    mocks.invoke.mockResolvedValue({ revision: 0, records: [{ chatId: "chat-a", chatSeen: false, activitySeen: null }] });
    await expect(loadAttentionSnapshot()).rejects.toThrow("Attention ledger unavailable");
  });
});
