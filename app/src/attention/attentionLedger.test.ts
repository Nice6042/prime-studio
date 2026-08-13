import { describe, expect, it } from "vitest";

import {
  activityAttentionForChat,
  chatAttentionEvidence,
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
  sessionId, accountId: null, provider: "openai-codex", projectId: "daemon-project", chatId: sessionId,
  cursor: { runtimeGeneration, sequence }, state: "idle", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId, cursor: { runtimeGeneration, sequence }, reason: "event_chronology_unavailable" },
});

const completed = (id: string, emittedAtMs: number, streaming = false) => ({
  channel: "parent" as const,
  kind: "assistant" as const,
  id,
  blocks: [{ kind: "text" as const, text: id }],
  streaming,
  emittedAtMs,
});

describe("attention ledger projection", () => {
  it("does not mark an inactive chat unread when only the poll cursor advances", () => {
    const snapshot: AttentionSnapshot = {
      revision: 4,
      records: [{ chatId: "chat-b", chatSeen: { runtimeGeneration: "generation-1", marker: "answer-1", occurredAtMs: 100 }, activitySeen: null }],
    };
    const attention = reconcileAttentionSnapshot(snapshot);
    const unchanged = { ...session("session-b", 4), parentMessages: [completed("answer-1", 100)] };
    const unread = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": unchanged }, "chat-a", attention);
    expect([...unread]).toEqual([]);

    const advancedPoll = { ...unchanged, cursor: { runtimeGeneration: "generation-1", sequence: 99 } };
    expect([...deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 10), "session-b": advancedPoll }, "chat-a", attention)]).toEqual([]);
  });

  it("marks only a real inactive assistant completion unread", () => {
    const attention = reconcileAttentionSnapshot({
      revision: 4,
      records: [{ chatId: "chat-b", chatSeen: { runtimeGeneration: "generation-1", marker: "answer-1", occurredAtMs: 100 }, activitySeen: null }],
    });
    const updated = { ...session("session-b", 4), parentMessages: [completed("answer-1", 100), completed("answer-2", 200)] };
    const unread = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": updated }, "chat-a", attention);
    expect([...unread]).toEqual(["chat-b"]);

    const streaming = { ...updated, parentMessages: [completed("answer-1", 100), completed("answer-2", 200, true)] };
    expect(chatAttentionEvidence(streaming)).toEqual({ runtimeGeneration: "generation-1", marker: "answer-1", occurredAtMs: 100 });
  });

  it("does not leak stale, unbound, active, or prior-generation cursor state across chats", () => {
    const attention = reconcileAttentionSnapshot({
      revision: 5,
      records: [
        { chatId: "chat-a", chatSeen: null, activitySeen: null },
        { chatId: "chat-b", chatSeen: { runtimeGeneration: "old-generation", marker: "answer-old", occurredAtMs: 999 }, activitySeen: null },
        { chatId: "chat-unknown", chatSeen: null, activitySeen: null },
      ],
    });
    const newGeneration = { ...session("session-b", 1, "new-generation"), parentMessages: [completed("answer-new", 1)] };
    const unread = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": newGeneration }, "chat-a", attention);
    expect([...unread]).toEqual(["chat-b"]);
    const generationBaseline = deriveUnreadChatIds(catalog(), { "session-a": session("session-a", 9), "session-b": session("session-b", 0, "another-generation") }, "chat-a", attention);
    expect([...generationBaseline]).toEqual([]);
  });

  it("exposes Activity unseen only when native content evidence changes", () => {
    const evidence = { runtimeGeneration: "generation-1", marker: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", occurredAtMs: 200 };
    const attention = reconcileAttentionSnapshot({ revision: 2, records: [{ chatId: "chat-b", chatSeen: null, activitySeen: evidence }] });
    expect(activityAttentionForChat("chat-b", evidence, attention)).toEqual({ status: "seen", evidence });
    const changed = { ...evidence, marker: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    expect(activityAttentionForChat("chat-b", changed, attention)).toEqual({ status: "unseen", evidence: changed });
    expect(activityAttentionForChat("chat-b", undefined, attention)).toEqual({ status: "unavailable", reason: "Activity content evidence is unavailable for this chat." });
    expect(activityAttentionForChat("chat-b", null, attention)).toEqual({ status: "seen", evidence: null });
  });

  it("fails closed when the durable snapshot is unavailable", () => {
    expect(deriveUnreadChatIds(catalog(), { "session-b": session("session-b", 4) }, "chat-a", { status: "unavailable", reason: "denied" })).toEqual(new Set());
    expect(activityAttentionForChat("chat-b", null, { status: "unavailable", reason: "denied" })).toEqual({ status: "unavailable", reason: "denied" });
  });
});
