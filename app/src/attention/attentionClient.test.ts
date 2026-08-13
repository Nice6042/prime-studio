import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { loadActivityAttentionEvidence, loadAttentionSnapshot, markAttentionSeen } from "./attentionClient";

describe("attention native client", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("strictly decodes bounded content evidence", async () => {
    const evidence = { runtimeGeneration: "g1", marker: "answer-2", occurredAtMs: 200 };
    mocks.invoke.mockResolvedValue({ revision: 3, records: [{ chatId: "chat-a", chatSeen: evidence, activitySeen: null }] });
    await expect(loadAttentionSnapshot()).resolves.toEqual({ revision: 3, records: [{ chatId: "chat-a", chatSeen: evidence, activitySeen: null }] });
  });

  it("sends an exact revision, channel, chat and authoritative content evidence", async () => {
    mocks.invoke.mockResolvedValue({ revision: 4, records: [] });
    const evidence = { runtimeGeneration: "g1", marker: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", occurredAtMs: 900 };
    await markAttentionSeen(3, "chat-a", "activity", evidence);
    expect(mocks.invoke).toHaveBeenCalledWith("attention_mark_seen", { request: { expectedRevision: 3, chatId: "chat-a", channel: "activity", evidence } });
  });

  it("loads the broker-minted activity evidence after inspector hydration", async () => {
    const evidence = { runtimeGeneration: "g1", marker: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", occurredAtMs: 900 };
    mocks.invoke.mockResolvedValue(evidence);
    await expect(loadActivityAttentionEvidence("session-a")).resolves.toEqual(evidence);
    expect(mocks.invoke).toHaveBeenCalledWith("attention_activity_evidence", { request: { sessionId: "session-a" } });

    mocks.invoke.mockResolvedValueOnce(null);
    await expect(loadActivityAttentionEvidence("session-a")).resolves.toBeNull();
  });

  it("rejects malformed native snapshots instead of inventing read state", async () => {
    mocks.invoke.mockResolvedValue({ revision: 0, records: [{ chatId: "chat-a", chatSeen: false, activitySeen: null }] });
    await expect(loadAttentionSnapshot()).rejects.toThrow("Attention ledger unavailable");
  });
});
