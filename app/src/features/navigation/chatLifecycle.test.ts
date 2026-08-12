import { describe, expect, it } from "vitest";

import type { ProjectChat } from "../../domain/projectChats";
import type { RootSessionProjection } from "../../entities/harness/types";
import { projectChatLifecycle } from "./chatLifecycle";

const unbound: ProjectChat = {
  id: "chat-a", projectId: "project-a", title: "A", pinned: false, archived: false, binding: null,
};
const bound: ProjectChat = {
  ...unbound,
  binding: { kind: "prime-session", accountId: "account-a", sessionId: "session-a", sessionFile: "a.jsonl", agentId: "agent-a" },
};
const session = (overrides: Partial<RootSessionProjection> = {}): RootSessionProjection => ({
  sessionId: "session-a", accountId: "account-a", projectId: "project-a", chatId: "agent-a",
  cursor: { runtimeGeneration: "generation-a", sequence: 4 }, state: "idle", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  ...overrides,
});

describe("authoritative chat lifecycle", () => {
  it("keeps a durable chat with no Harness binding idle without starting a provider", () => {
    expect(projectChatLifecycle(unbound, {})).toEqual({
      status: "idle", label: "Idle", detail: "No Harness session has been started for this chat.",
    });
  });

  it.each([
    [{ state: "idle", freshness: "live" }, "live", "Live"],
    [{ state: "working", freshness: "live" }, "working", "Working"],
    [{ state: "blocked", freshness: "live" }, "working", "Working"],
    [{ state: "failed", freshness: "live" }, "error", "Error"],
    [{ state: "stopped", freshness: "live" }, "error", "Error"],
    [{ state: "disconnected", freshness: "live" }, "error", "Error"],
    [{ state: "idle", freshness: "disconnected" }, "error", "Error"],
    [{ state: "idle", freshness: "stale" }, "unavailable", "Unavailable"],
    [{ state: "working", freshness: "unknown_outcome" }, "unavailable", "Unavailable"],
  ] as const)("maps admitted %o evidence to %s", (evidence, status, label) => {
    expect(projectChatLifecycle(bound, { "session-a": session(evidence) })).toMatchObject({ status, label });
  });

  it.each([
    ["starting", "idle", "working", "Worker is starting"],
    ["recovering", "failed", "working", "recovering this chat"],
    ["retryable_failure", "failed", "working", "safe retry"],
    ["retrying", "failed", "working", "retrying this chat"],
    ["terminal_failure", "working", "error", "recovery failed"],
    ["recovered", "idle", "live", "connected and ready"],
  ] as const)("gives worker recovery %s precedence over root state %s", (recoveryStatus, state, status, detail) => {
    const recovery = {
      ...session().workerRecovery,
      status: recoveryStatus,
      observationId: recoveryStatus === "starting" ? null : "observation-a",
      automaticRetryCount: recoveryStatus === "retrying" || recoveryStatus === "recovered" || recoveryStatus === "terminal_failure" ? 1 as const : 0 as const,
      closureReason: recoveryStatus === "starting" ? null : "supervisor_recovery_exhausted" as const,
    };
    expect(projectChatLifecycle(bound, { "session-a": session({ state, workerRecovery: recovery }) })).toMatchObject({ status, detail: expect.stringContaining(detail) });
  });

  it("fails closed for missing or identity-mismatched bound evidence", () => {
    expect(projectChatLifecycle(bound, {})).toMatchObject({ status: "unavailable" });
    expect(projectChatLifecycle(bound, { "session-a": session({ accountId: "account-b" }) })).toMatchObject({ status: "unavailable" });
    expect(projectChatLifecycle(bound, { "session-a": session({ chatId: "agent-b" }) })).toMatchObject({ status: "unavailable" });
  });

  it("drops an old binding instead of borrowing lifecycle from a newly admitted generation or session", () => {
    const rebound = { ...bound, binding: { ...bound.binding!, sessionId: "session-b" } };
    expect(projectChatLifecycle(rebound, { "session-a": session({ cursor: { runtimeGeneration: "generation-b", sequence: 1 }, state: "working" }) })).toMatchObject({ status: "unavailable" });
    expect(projectChatLifecycle(bound, { "session-a": session({ cursor: { runtimeGeneration: "generation-b", sequence: 1 }, state: "idle" }) })).toMatchObject({ status: "live" });
  });
});
