import { describe, expect, it } from "vitest";

import {
  activityAttentionForChat,
  deriveUnreadChatIds,
  reconcileAttentionSnapshot,
  type AttentionSnapshot,
} from "./attentionLedger";
import { createInitialProjectChatState, transitionProjectChatState } from "../domain/projectChats";
import type { RootSessionProjection } from "../entities/harness/types";

function catalog() {
  let state = createInitialProjectChatState();
  for (const [chatId, sessionId] of [["chat-a", "session-a"], ["chat-b", "session-b"]] as const) {
    const created = transitionProjectChatState(state, { type: "chat.create", projectId: "project:personal", chatId, title: chatId });
    if (created.status !== "applied") throw new Error("fixture create failed");
    const bound = transitionProjectChatState(created.state, {
      type: "chat.bind-prime-session", projectId: "project:personal", chatId,
      binding: { kind: "prime-session", accountId: null, sessionId, sessionFile: `${sessionId}.jsonl`, agentId: sessionId },
    });
    if (bound.status !== "applied") throw new Error("fixture bind failed");
    state = bound.state;
  }
  const selected = transitionProjectChatState(state, { type: "selection.select-chat", projectId: "project:personal", chatId: "chat-a" });
  if (selected.status !== "applied") throw new Error("fixture selection failed");
  return selected.state;
}

const session = (sessionId: string, sequence: number, runtimeGeneration = "generation-1"): RootSessionProjection => ({
  sessionId, accountId: null, projectId: "daemon-project", chatId: sessionId,
  cursor: { runtimeGeneration, sequence }, state: "idle", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
});

describe("attention ledger projection", () => {
  it("marks only an inactive bound chat unread when its admitted cursor advances", () => {
    const snapshot: AttentionSnapshot = {
      revision: 4,
      records: [{ chatId: "chat-b", chatSeen: { runtimeGeneration: "generation-1", sequence: 3 }, activitySeen: null }],
    };
    const attention = reconcileAttentionSnapshot(snapshot);
    const unread = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": session("session-b", 4) }, "chat-a", attention);
    expect([...unread]).toEqual(["chat-b"]);
  });

  it("does not leak stale, unbound, active, or prior-generation cursor state across chats", () => {
    const attention = reconcileAttentionSnapshot({
      revision: 5,
      records: [
        { chatId: "chat-a", chatSeen: null, activitySeen: null },
        { chatId: "chat-b", chatSeen: { runtimeGeneration: "old-generation", sequence: 999 }, activitySeen: null },
        { chatId: "chat-unknown", chatSeen: null, activitySeen: null },
      ],
    });
    const unread = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": session("session-b", 1, "new-generation") }, "chat-a", attention);
    expect([...unread]).toEqual(["chat-b"]);
    const generationBaseline = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": session("session-b", 0, "another-generation") }, "chat-a", attention);
    expect([...generationBaseline]).toEqual([]);
  });

  it("exposes Activity unseen only from an exact authoritative event cursor", () => {
    const attention = reconcileAttentionSnapshot({ revision: 2, records: [{ chatId: "chat-b", chatSeen: null, activitySeen: { runtimeGeneration: "generation-1", sequence: 6 } }] });
    expect(activityAttentionForChat("chat-b", session("session-b", 7), attention)).toEqual({ status: "unseen", throughSequence: 7 });
    expect(activityAttentionForChat("chat-b", null, attention)).toEqual({ status: "unavailable", reason: "Activity cursor evidence is unavailable for this chat." });
    expect(activityAttentionForChat("chat-b", session("session-b", 1, "generation-2"), attention)).toEqual({ status: "unseen", throughSequence: 1 });
  });

  it("fails closed when the durable snapshot is unavailable", () => {
    expect(deriveUnreadChatIds(catalog(), { "session-b": session("session-b", 4) }, "chat-a", { status: "unavailable", reason: "denied" })).toEqual(new Set());
    expect(activityAttentionForChat("chat-b", session("session-b", 4), { status: "unavailable", reason: "denied" })).toEqual({ status: "unavailable", reason: "denied" });
  });
});
