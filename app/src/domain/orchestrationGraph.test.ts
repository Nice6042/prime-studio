import { describe, expect, it } from "vitest";

import {
  GraphValidationError,
  applyEvent,
  childTasks,
  createExplicitDag,
  createLeadSpecialistsGraph,
  createSingleAgentGraph,
  dispatchableTasks,
  readyTasks,
  restoreGraph,
  serializeGraph,
  type GraphState,
} from "./orchestrationGraph";

function graphWithEveryRecordType(): GraphState {
  let graph = createExplicitDag({
    maxParallelism: 2,
    agents: [
      { id: "author", label: "Author" },
      { id: "worker", label: "Worker" },
      { id: "reviewer", label: "Reviewer" },
      { id: "backup", label: "Backup" },
    ],
    tasks: [
      { id: "ship", title: "Ship", ownerAgentId: "author", reviewRequired: true },
      { id: "cancel-me", title: "Cancel me", ownerAgentId: "author" },
    ],
  });
  graph = applyEvent(graph, {
    type: "handoff.recorded",
    taskId: "ship",
    fromAgentId: "author",
    toAgentId: "worker",
    message: "Implement",
    at: 1,
  });
  graph = applyEvent(graph, {
    type: "work.started",
    taskId: "ship",
    attemptId: "work-1",
    agentId: "worker",
    at: 2,
  });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "work-1", outcome: "succeeded", at: 3 });
  graph = applyEvent(graph, {
    type: "review.started",
    taskId: "ship",
    attemptId: "review-1",
    agentId: "reviewer",
    reviewsAttemptId: "work-1",
    at: 4,
  });
  graph = applyEvent(graph, { type: "review.completed", attemptId: "review-1", approved: false, at: 5 });
  graph = applyEvent(graph, {
    type: "retry.started",
    taskId: "ship",
    attemptId: "retry-1",
    agentId: "worker",
    retryOfAttemptId: "review-1",
    at: 6,
  });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "retry-1", outcome: "failed", at: 7 });
  graph = applyEvent(graph, {
    type: "fallback.started",
    taskId: "ship",
    attemptId: "fallback-1",
    agentId: "backup",
    fallbackOfAttemptId: "retry-1",
    reason: "retry exhausted",
    at: 8,
  });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "fallback-1", outcome: "succeeded", at: 9 });
  graph = applyEvent(graph, {
    type: "review.started",
    taskId: "ship",
    attemptId: "review-2",
    agentId: "reviewer",
    reviewsAttemptId: "fallback-1",
    at: 10,
  });
  graph = applyEvent(graph, { type: "review.completed", attemptId: "review-2", approved: true, at: 11 });
  return applyEvent(graph, { type: "task.cancelled", taskId: "cancel-me", reason: "not needed", at: 12 });
}

function graphAwaitingReviewAfterRetry(): GraphState {
  let graph = createExplicitDag({
    maxParallelism: 2,
    agents: [
      { id: "author", label: "Author" },
      { id: "reviewer", label: "Reviewer" },
    ],
    tasks: [{ id: "publish", title: "Publish", ownerAgentId: "author", reviewRequired: true }],
  });
  graph = applyEvent(graph, {
    type: "work.started",
    taskId: "publish",
    attemptId: "work-1",
    agentId: "author",
    at: 1,
  });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "work-1", outcome: "succeeded", at: 2 });
  graph = applyEvent(graph, {
    type: "review.started",
    taskId: "publish",
    attemptId: "review-1",
    agentId: "reviewer",
    reviewsAttemptId: "work-1",
    at: 3,
  });
  graph = applyEvent(graph, { type: "review.completed", attemptId: "review-1", approved: false, at: 4 });
  graph = applyEvent(graph, {
    type: "retry.started",
    taskId: "publish",
    attemptId: "retry-1",
    agentId: "author",
    retryOfAttemptId: "review-1",
    at: 5,
  });
  return applyEvent(graph, { type: "work.completed", attemptId: "retry-1", outcome: "succeeded", at: 6 });
}

function graphWithApprovedRetryReview(): GraphState {
  let graph = graphAwaitingReviewAfterRetry();
  graph = applyEvent(graph, {
    type: "review.started",
    taskId: "publish",
    attemptId: "review-2",
    agentId: "reviewer",
    reviewsAttemptId: "retry-1",
    at: 7,
  });
  return applyEvent(graph, { type: "review.completed", attemptId: "review-2", approved: true, at: 8 });
}

function legacyV1RetrySnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    maxParallelism: 1,
    agents: [{ id: "author", label: "Author" }],
    tasks: [
      {
        id: "ship",
        title: "Ship",
        ownerAgentId: "author",
        dependsOn: [],
        priority: 0,
        reviewRequired: false,
        status: "running",
      },
    ],
    attempts: [
      {
        id: "work-1",
        taskId: "ship",
        agentId: "author",
        kind: "work",
        status: "failed",
        startedAt: 1,
        completedAt: 2,
      },
      {
        id: "retry-1",
        taskId: "ship",
        agentId: "author",
        kind: "retry",
        status: "running",
        startedAt: 3,
        previousAttemptId: "work-1",
      },
    ],
    records: [
      {
        sequence: 1,
        event: { type: "work.started", taskId: "ship", attemptId: "work-1", agentId: "author", at: 1 },
      },
      { sequence: 2, event: { type: "work.completed", attemptId: "work-1", outcome: "failed", at: 2 } },
      {
        sequence: 3,
        event: {
          type: "retry.started",
          taskId: "ship",
          attemptId: "retry-1",
          agentId: "author",
          retryOfAttemptId: "work-1",
          at: 3,
        },
      },
    ],
  };
}

const attemptHistoryPermutations = [
  ["work-1", "review-1", "retry-1"],
  ["work-1", "retry-1", "review-1"],
  ["review-1", "work-1", "retry-1"],
  ["review-1", "retry-1", "work-1"],
  ["retry-1", "work-1", "review-1"],
  ["retry-1", "review-1", "work-1"],
] as const;

function coherentlyReorderedRetrySnapshot(attemptOrder: readonly string[]): string {
  const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
    attempts: Array<{ id: string }>;
    records: Array<{ sequence: number; event: { type: string; attemptId?: string } }>;
  };
  const attemptsById = new Map(snapshot.attempts.map((attempt) => [attempt.id, attempt]));
  const recordsByAttemptId = new Map<string, typeof snapshot.records>();
  for (const record of snapshot.records) {
    const attemptId = record.event.attemptId;
    if (attemptId !== undefined) {
      recordsByAttemptId.set(attemptId, [...(recordsByAttemptId.get(attemptId) ?? []), record]);
    }
  }

  snapshot.attempts = attemptOrder.map((attemptId) => attemptsById.get(attemptId) as { id: string });
  snapshot.records = attemptOrder
    .flatMap((attemptId) => recordsByAttemptId.get(attemptId) ?? [])
    .map((record, index) => ({ ...record, sequence: index + 1 }));
  return JSON.stringify(snapshot);
}

function graphWithTwoFailedTasksAndRetry(): GraphState {
  let graph = createExplicitDag({
    maxParallelism: 2,
    agents: [{ id: "agent", label: "Agent" }],
    tasks: [
      { id: "a", title: "A", ownerAgentId: "agent" },
      { id: "b", title: "B", ownerAgentId: "agent" },
    ],
  });
  graph = applyEvent(graph, { type: "work.started", taskId: "a", attemptId: "work-a", agentId: "agent", at: 1 });
  graph = applyEvent(graph, { type: "work.started", taskId: "b", attemptId: "work-b", agentId: "agent", at: 2 });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "work-a", outcome: "failed", at: 3 });
  graph = applyEvent(graph, { type: "work.completed", attemptId: "work-b", outcome: "failed", at: 4 });
  return applyEvent(graph, {
    type: "retry.started",
    taskId: "a",
    attemptId: "retry-a",
    agentId: "agent",
    retryOfAttemptId: "work-a",
    at: 5,
  });
}

function permuteObjectFieldOrder(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => permuteObjectFieldOrder(item, seed + index + 1));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const offset = entries.length === 0 ? 0 : seed % entries.length;
  const rotated = [...entries.slice(offset), ...entries.slice(0, offset)];
  if (seed % 2 === 0) {
    rotated.reverse();
  }
  return Object.fromEntries(
    rotated.map(([key, item], index) => [key, permuteObjectFieldOrder(item, seed + index + 1)]),
  );
}

describe("orchestration graph construction", () => {
  it("creates a pending one-task graph owned by its only agent", () => {
    const graph = createSingleAgentGraph({
      agent: { id: "solo", label: "Solo" },
      task: { id: "ship", title: "Ship", ownerAgentId: "solo" },
    });

    expect(graph.maxParallelism).toBe(1);
    expect(graph.agents).toEqual([{ id: "solo", label: "Solo" }]);
    expect(graph.tasks).toEqual([
      {
        id: "ship",
        title: "Ship",
        ownerAgentId: "solo",
        dependsOn: [],
        priority: 0,
        reviewRequired: false,
        status: "pending",
      },
    ]);
    expect(graph.attempts).toEqual([]);
    expect(graph.records).toEqual([]);
  });

  it("attributes every specialist directly to the lead", () => {
    const graph = createLeadSpecialistsGraph({
      lead: { id: "lead", label: "Lead" },
      specialists: [
        { id: "writer", label: "Writer" },
        { id: "reviewer", label: "Reviewer" },
      ],
      tasks: [
        { id: "draft", title: "Draft", ownerAgentId: "writer" },
        { id: "review", title: "Review", ownerAgentId: "reviewer", dependsOn: ["draft"] },
      ],
      maxParallelism: 2,
    });

    expect(graph.agents).toEqual([
      { id: "lead", label: "Lead" },
      { id: "writer", label: "Writer", parentAgentId: "lead" },
      { id: "reviewer", label: "Reviewer", parentAgentId: "lead" },
    ]);
    expect(graph.maxParallelism).toBe(2);
  });

  it("preserves explicit DAG dependencies and task-parent attribution", () => {
    const graph = createExplicitDag({
      maxParallelism: 3,
      agents: [{ id: "lead", label: "Lead" }],
      tasks: [
        { id: "plan", title: "Plan", ownerAgentId: "lead" },
        {
          id: "deliver",
          title: "Deliver",
          ownerAgentId: "lead",
          parentTaskId: "plan",
          dependsOn: ["plan"],
          priority: 5,
          reviewRequired: true,
        },
      ],
    });

    expect(graph.tasks[1]).toEqual({
      id: "deliver",
      title: "Deliver",
      ownerAgentId: "lead",
      parentTaskId: "plan",
      dependsOn: ["plan"],
      priority: 5,
      reviewRequired: true,
      status: "pending",
    });
  });

  it("rejects dependency cycles", () => {
    expect(() =>
      createExplicitDag({
        maxParallelism: 1,
        agents: [{ id: "agent", label: "Agent" }],
        tasks: [
          { id: "a", title: "A", ownerAgentId: "agent", dependsOn: ["b"] },
          { id: "b", title: "B", ownerAgentId: "agent", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects orphaned task and agent parents", () => {
    expect(() =>
      createExplicitDag({
        maxParallelism: 1,
        agents: [{ id: "agent", label: "Agent" }],
        tasks: [{ id: "child", title: "Child", ownerAgentId: "agent", parentTaskId: "missing" }],
      }),
    ).toThrow(/parent task/i);

    expect(() =>
      createExplicitDag({
        maxParallelism: 1,
        agents: [{ id: "agent", label: "Agent", parentAgentId: "missing" }],
        tasks: [{ id: "task", title: "Task", ownerAgentId: "agent" }],
      }),
    ).toThrow(/parent agent/i);
  });
});

describe("orchestration graph lifecycle", () => {
  it("orders ready tasks by priority then id and respects remaining capacity", () => {
    const graph = createExplicitDag({
      maxParallelism: 2,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "b", title: "B", ownerAgentId: "agent", priority: 1 },
        { id: "a", title: "A", ownerAgentId: "agent", priority: 1 },
        { id: "blocked", title: "Blocked", ownerAgentId: "agent", dependsOn: ["a"] },
      ],
    });

    expect(readyTasks(graph).map((task) => task.id)).toEqual(["a", "b"]);
    expect(dispatchableTasks(graph).map((task) => task.id)).toEqual(["a", "b"]);

    const running = applyEvent(graph, {
      type: "work.started",
      taskId: "a",
      attemptId: "work-a",
      agentId: "agent",
      at: 1,
    });

    expect(dispatchableTasks(running).map((task) => task.id)).toEqual(["b"]);
  });

  it("unblocks a dependency only after its work succeeds", () => {
    const graph = createExplicitDag({
      maxParallelism: 2,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "first", title: "First", ownerAgentId: "agent" },
        { id: "second", title: "Second", ownerAgentId: "agent", dependsOn: ["first"] },
      ],
    });

    const running = applyEvent(graph, {
      type: "work.started",
      taskId: "first",
      attemptId: "work-first",
      agentId: "agent",
      at: 1,
    });
    const complete = applyEvent(running, {
      type: "work.completed",
      attemptId: "work-first",
      outcome: "succeeded",
      at: 2,
    });

    expect(readyTasks(complete).map((task) => task.id)).toEqual(["second"]);
  });

  it("records a handoff and changes a pending task owner", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [
        { id: "lead", label: "Lead" },
        { id: "writer", label: "Writer", parentAgentId: "lead" },
      ],
      tasks: [{ id: "draft", title: "Draft", ownerAgentId: "lead" }],
    });

    const next = applyEvent(graph, {
      type: "handoff.recorded",
      taskId: "draft",
      fromAgentId: "lead",
      toAgentId: "writer",
      at: 7,
      message: "Take it",
    });

    expect(graph.tasks[0]?.ownerAgentId).toBe("lead");
    expect(next.tasks[0]?.ownerAgentId).toBe("writer");
    expect(next.records[next.records.length - 1]?.event).toMatchObject({
      type: "handoff.recorded",
      fromAgentId: "lead",
      toAgentId: "writer",
      message: "Take it",
    });
  });

  it("cancels a parent and every descendant, including running attempts", () => {
    const graph = createExplicitDag({
      maxParallelism: 2,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "parent", title: "Parent", ownerAgentId: "agent" },
        { id: "child", title: "Child", ownerAgentId: "agent", parentTaskId: "parent" },
      ],
    });
    const withChildRunning = applyEvent(graph, {
      type: "work.started",
      taskId: "child",
      attemptId: "work-child",
      agentId: "agent",
      at: 8,
    });

    const cancelled = applyEvent(withChildRunning, {
      type: "task.cancelled",
      taskId: "parent",
      at: 9,
      reason: "stop",
    });

    expect(childTasks(cancelled, "parent").map((task) => task.id)).toEqual(["child"]);
    expect(graph.tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
    expect(cancelled.tasks.map((task) => task.status)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled.attempts).toMatchObject([{ id: "work-child", status: "cancelled", completedAt: 9 }]);
    expect(cancelled.records[cancelled.records.length - 1]?.event).toMatchObject({
      type: "task.cancelled",
      affectedTaskIds: ["child", "parent"],
    });
  });

  it("propagates cancellation through descendants and transitive dependants only", () => {
    const graph = createExplicitDag({
      maxParallelism: 2,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "source", title: "Source", ownerAgentId: "agent" },
        { id: "child", title: "Child", ownerAgentId: "agent", parentTaskId: "source" },
        { id: "dependant", title: "Dependant", ownerAgentId: "agent", dependsOn: ["source"] },
        { id: "downstream", title: "Downstream", ownerAgentId: "agent", dependsOn: ["child"] },
        { id: "dependant-child", title: "Dependant child", ownerAgentId: "agent", parentTaskId: "dependant" },
        { id: "unrelated", title: "Unrelated", ownerAgentId: "agent" },
      ],
    });

    const cancelled = applyEvent(graph, {
      type: "task.cancelled",
      taskId: "source",
      reason: "upstream stopped",
      at: 1,
    });

    expect(cancelled.tasks.filter((task) => task.status === "cancelled").map((task) => task.id)).toEqual([
      "source",
      "child",
      "dependant",
      "downstream",
      "dependant-child",
    ]);
    expect(cancelled.tasks.find((task) => task.id === "unrelated")?.status).toBe("pending");
    expect(cancelled.records[cancelled.records.length - 1]?.event).toMatchObject({
      type: "task.cancelled",
      affectedTaskIds: ["child", "dependant", "dependant-child", "downstream", "source"],
    });
  });

  it("does not propagate cancellation from one child to its sibling", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "parent", title: "Parent", ownerAgentId: "agent" },
        { id: "left", title: "Left", ownerAgentId: "agent", parentTaskId: "parent" },
        { id: "right", title: "Right", ownerAgentId: "agent", parentTaskId: "parent" },
      ],
    });

    const cancelled = applyEvent(graph, { type: "task.cancelled", taskId: "left", reason: "stop left", at: 1 });

    expect(cancelled.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "parent", status: "pending" },
      { id: "left", status: "cancelled" },
      { id: "right", status: "pending" },
    ]);
  });
});

describe("orchestration graph attempts", () => {
  it("requires an independent reviewer before review-gated work succeeds", () => {
    const graph = createExplicitDag({
      maxParallelism: 2,
      agents: [
        { id: "author", label: "Author" },
        { id: "reviewer", label: "Reviewer" },
      ],
      tasks: [{ id: "publish", title: "Publish", ownerAgentId: "author", reviewRequired: true }],
    });
    const worked = applyEvent(graph, {
      type: "work.started",
      taskId: "publish",
      attemptId: "work-1",
      agentId: "author",
      at: 1,
    });
    const awaitingReview = applyEvent(worked, {
      type: "work.completed",
      attemptId: "work-1",
      outcome: "succeeded",
      at: 2,
    });

    expect(awaitingReview.tasks[0]?.status).toBe("awaiting-review");
    expect(() =>
      applyEvent(awaitingReview, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-same-agent",
        agentId: "author",
        reviewsAttemptId: "work-1",
        at: 3,
      }),
    ).toThrow(/different agent/i);

    const reviewing = applyEvent(awaitingReview, {
      type: "review.started",
      taskId: "publish",
      attemptId: "review-1",
      agentId: "reviewer",
      reviewsAttemptId: "work-1",
      at: 3,
    });
    const approved = applyEvent(reviewing, {
      type: "review.completed",
      attemptId: "review-1",
      approved: true,
      at: 4,
    });

    expect(approved.tasks[0]?.status).toBe("succeeded");
    expect(approved.attempts).toMatchObject([
      { id: "work-1", kind: "work", status: "succeeded" },
      { id: "review-1", kind: "review", agentId: "reviewer", reviewsAttemptId: "work-1", status: "succeeded" },
    ]);
  });

  it("retains failed attempts before retry and records a fallback explicitly", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [
        { id: "author", label: "Author" },
        { id: "backup", label: "Backup" },
      ],
      tasks: [{ id: "ship", title: "Ship", ownerAgentId: "author" }],
    });
    const failedWork = applyEvent(
      applyEvent(graph, {
        type: "work.started",
        taskId: "ship",
        attemptId: "work-1",
        agentId: "author",
        at: 1,
      }),
      { type: "work.completed", attemptId: "work-1", outcome: "failed", at: 2 },
    );
    const retried = applyEvent(failedWork, {
      type: "retry.started",
      taskId: "ship",
      attemptId: "retry-1",
      agentId: "author",
      retryOfAttemptId: "work-1",
      at: 3,
    });
    const failedRetry = applyEvent(retried, {
      type: "work.completed",
      attemptId: "retry-1",
      outcome: "failed",
      at: 4,
    });
    const fallback = applyEvent(failedRetry, {
      type: "fallback.started",
      taskId: "ship",
      attemptId: "fallback-1",
      agentId: "backup",
      fallbackOfAttemptId: "retry-1",
      reason: "primary exhausted",
      at: 5,
    });

    expect(fallback.attempts).toMatchObject([
      { id: "work-1", kind: "work", status: "failed" },
      { id: "retry-1", kind: "retry", previousAttemptId: "work-1", status: "failed" },
      {
        id: "fallback-1",
        kind: "fallback",
        agentId: "backup",
        previousAttemptId: "retry-1",
        status: "running",
      },
    ]);
    expect(fallback.records[fallback.records.length - 1]?.event).toMatchObject({
      type: "fallback.started",
      fallbackOfAttemptId: "retry-1",
      reason: "primary exhausted",
    });
  });

  it("rejects fallback attempts without a failed attempt on the same task", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [
        { id: "author", label: "Author" },
        { id: "backup", label: "Backup" },
      ],
      tasks: [{ id: "ship", title: "Ship", ownerAgentId: "author" }],
    });

    expect(() =>
      applyEvent(graph, {
        type: "fallback.started",
        taskId: "ship",
        attemptId: "fallback-1",
        agentId: "backup",
        fallbackOfAttemptId: "missing",
        reason: "primary exhausted",
        at: 1,
      }),
    ).toThrow(/failed attempt/i);
  });

  it("rejects reviewing a stale successful attempt after newer retry work", () => {
    let graph = createExplicitDag({
      maxParallelism: 2,
      agents: [
        { id: "author", label: "Author" },
        { id: "reviewer", label: "Reviewer" },
      ],
      tasks: [{ id: "publish", title: "Publish", ownerAgentId: "author", reviewRequired: true }],
    });
    graph = applyEvent(graph, {
      type: "work.started",
      taskId: "publish",
      attemptId: "work-1",
      agentId: "author",
      at: 1,
    });
    graph = applyEvent(graph, { type: "work.completed", attemptId: "work-1", outcome: "succeeded", at: 2 });
    graph = applyEvent(graph, {
      type: "review.started",
      taskId: "publish",
      attemptId: "review-1",
      agentId: "reviewer",
      reviewsAttemptId: "work-1",
      at: 3,
    });
    graph = applyEvent(graph, { type: "review.completed", attemptId: "review-1", approved: false, at: 4 });
    graph = applyEvent(graph, {
      type: "retry.started",
      taskId: "publish",
      attemptId: "retry-1",
      agentId: "author",
      retryOfAttemptId: "review-1",
      at: 5,
    });
    graph = applyEvent(graph, { type: "work.completed", attemptId: "retry-1", outcome: "succeeded", at: 6 });

    expect(() =>
      applyEvent(graph, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-stale",
        agentId: "reviewer",
        reviewsAttemptId: "work-1",
        at: 7,
      }),
    ).toThrow(/current work attempt/i);

    expect(
      applyEvent(graph, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-current",
        agentId: "reviewer",
        reviewsAttemptId: "retry-1",
        at: 7,
      }).attempts,
    ).toMatchObject([{ id: "work-1" }, { id: "review-1" }, { id: "retry-1" }, { id: "review-current" }]);
  });

  it("assigns monotonic work generations and explicit supersession across a rejected review and retry", () => {
    expect(graphAwaitingReviewAfterRetry().attempts).toMatchObject([
      { id: "work-1", kind: "work", generation: 1 },
      { id: "review-1", kind: "review", generation: 1, reviewsAttemptId: "work-1" },
      {
        id: "retry-1",
        kind: "retry",
        generation: 2,
        previousAttemptId: "review-1",
        supersedesAttemptId: "work-1",
      },
    ]);
  });

  it("rejects restarting from a stale failure after newer work has failed", () => {
    let graph = createExplicitDag({
      maxParallelism: 1,
      agents: [
        { id: "author", label: "Author" },
        { id: "backup", label: "Backup" },
      ],
      tasks: [{ id: "ship", title: "Ship", ownerAgentId: "author" }],
    });
    graph = applyEvent(graph, {
      type: "work.started",
      taskId: "ship",
      attemptId: "work-1",
      agentId: "author",
      at: 1,
    });
    graph = applyEvent(graph, { type: "work.completed", attemptId: "work-1", outcome: "failed", at: 2 });
    graph = applyEvent(graph, {
      type: "retry.started",
      taskId: "ship",
      attemptId: "retry-1",
      agentId: "author",
      retryOfAttemptId: "work-1",
      at: 3,
    });
    graph = applyEvent(graph, { type: "work.completed", attemptId: "retry-1", outcome: "failed", at: 4 });

    expect(() =>
      applyEvent(graph, {
        type: "fallback.started",
        taskId: "ship",
        attemptId: "fallback-stale",
        agentId: "backup",
        fallbackOfAttemptId: "work-1",
        reason: "stale failure",
        at: 5,
      }),
    ).toThrow(/current work attempt/i);
  });
});

describe("orchestration graph crash-resume", () => {
  it("round-trips complete state and resumes with the same deterministic result", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [
        { id: "author", label: "Author" },
        { id: "backup", label: "Backup" },
      ],
      tasks: [{ id: "ship", title: "Ship", ownerAgentId: "author" }],
    });
    const failedWork = applyEvent(
      applyEvent(graph, {
        type: "work.started",
        taskId: "ship",
        attemptId: "work-1",
        agentId: "author",
        at: 1,
      }),
      { type: "work.completed", attemptId: "work-1", outcome: "failed", at: 2 },
    );
    const beforeCrash = applyEvent(failedWork, {
      type: "fallback.started",
      taskId: "ship",
      attemptId: "fallback-1",
      agentId: "backup",
      fallbackOfAttemptId: "work-1",
      reason: "timeout",
      at: 3,
    });

    const snapshot = serializeGraph(beforeCrash);
    const restored = restoreGraph(snapshot);
    const completion = {
      type: "work.completed" as const,
      attemptId: "fallback-1",
      outcome: "succeeded" as const,
      at: 4,
    };

    expect(restored).toEqual(beforeCrash);
    expect(serializeGraph(restored)).toBe(snapshot);
    expect(applyEvent(restored, completion)).toEqual(applyEvent(beforeCrash, completion));
  });

  it("rejects unsupported schemas and malformed graph topology during restoration", () => {
    expect(() => restoreGraph('{"schemaVersion":999}')).toThrow(/schema/i);
    expect(() =>
      restoreGraph(
        JSON.stringify({
          schemaVersion: 1,
          maxParallelism: 1,
          agents: [{ id: "agent", label: "Agent" }],
          tasks: [
            {
              id: "child",
              title: "Child",
              ownerAgentId: "agent",
              parentTaskId: "missing",
              dependsOn: [],
              priority: 0,
              reviewRequired: false,
              status: "pending",
            },
          ],
          attempts: [],
          records: [],
        }),
      ),
    ).toThrow(/parent task/i);
  });

  it("serializes logically identical events identically regardless of caller property order", () => {
    const graph = createSingleAgentGraph({
      agent: { id: "solo", label: "Solo" },
      task: { id: "ship", title: "Ship", ownerAgentId: "solo" },
    });
    const conventional = applyEvent(graph, {
      type: "work.started",
      taskId: "ship",
      attemptId: "work-1",
      agentId: "solo",
      at: 1,
    });
    const reordered = applyEvent(graph, {
      at: 1,
      agentId: "solo",
      attemptId: "work-1",
      taskId: "ship",
      type: "work.started",
    });

    expect(conventional).toEqual(reordered);
    expect(serializeGraph(conventional)).toBe(serializeGraph(reordered));
  });

  it.each([
    ["work.started", "taskId", "missing-task"],
    ["work.started", "attemptId", "missing-attempt"],
    ["work.started", "agentId", "missing-agent"],
    ["work.completed", "attemptId", "missing-attempt"],
    ["handoff.recorded", "taskId", "missing-task"],
    ["handoff.recorded", "fromAgentId", "missing-agent"],
    ["handoff.recorded", "toAgentId", "missing-agent"],
    ["task.cancelled", "taskId", "missing-task"],
    ["task.cancelled", "affectedTaskIds", ["missing-task"]],
    ["review.started", "taskId", "missing-task"],
    ["review.started", "attemptId", "missing-attempt"],
    ["review.started", "agentId", "missing-agent"],
    ["review.started", "reviewsAttemptId", "missing-attempt"],
    ["review.completed", "attemptId", "missing-attempt"],
    ["retry.started", "taskId", "missing-task"],
    ["retry.started", "attemptId", "missing-attempt"],
    ["retry.started", "agentId", "missing-agent"],
    ["retry.started", "retryOfAttemptId", "missing-attempt"],
    ["fallback.started", "taskId", "missing-task"],
    ["fallback.started", "attemptId", "missing-attempt"],
    ["fallback.started", "agentId", "missing-agent"],
    ["fallback.started", "fallbackOfAttemptId", "missing-attempt"],
  ] as const)("rejects hostile snapshot reference %s.%s", (eventType, field, replacement) => {
    const snapshot = JSON.parse(serializeGraph(graphWithEveryRecordType())) as {
      records: Array<{ event: Record<string, unknown> }>;
    };
    const record = snapshot.records.find((candidate) => candidate.event.type === eventType);
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    record.event[field] = replacement;

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/unknown (task|agent|attempt).*missing/i);
  });

  it("rejects hostile snapshot records with an unknown event type", () => {
    const snapshot = JSON.parse(serializeGraph(graphWithEveryRecordType())) as {
      records: Array<{ event: Record<string, unknown> }>;
    };
    const record = snapshot.records[0];
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    record.event.type = "unknown.event";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/unsupported graph event type/i);
  });

  it.each([
    ["review-1", "retry-1", "work-1"],
    ["retry-1", "work-1", "review-1"],
    ["work-1", "retry-1", "review-1"],
  ])("rejects noncanonical attempt permutation %j during restoration", (...attemptIds) => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<{ id: string }>;
    };
    const attemptsById = new Map(snapshot.attempts.map((attempt) => [attempt.id, attempt]));
    snapshot.attempts = attemptIds.map((attemptId) => attemptsById.get(attemptId) as { id: string });

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/attempt.*order|chronolog/i);
  });

  it("rejects a reordered snapshot before stale work can be reviewed", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<{ id: string }>;
    };
    snapshot.attempts = [snapshot.attempts[1]!, snapshot.attempts[2]!, snapshot.attempts[0]!];

    expect(() => {
      const restored = restoreGraph(JSON.stringify(snapshot));
      return applyEvent(restored, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-stale",
        agentId: "reviewer",
        reviewsAttemptId: "work-1",
        at: 7,
      });
    }).toThrow(/attempt.*order|chronolog|current work attempt/i);
  });

  it("rejects stale review after records and attempts are coherently reordered and renumbered", () => {
    const restored = restoreGraph(coherentlyReorderedRetrySnapshot(["review-1", "retry-1", "work-1"]));

    expect(() =>
      applyEvent(restored, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-stale",
        agentId: "reviewer",
        reviewsAttemptId: "work-1",
        at: 7,
      }),
    ).toThrow(/current work attempt/i);
    expect(
      applyEvent(restored, {
        type: "review.started",
        taskId: "publish",
        attemptId: "review-current",
        agentId: "reviewer",
        reviewsAttemptId: "retry-1",
        at: 7,
      }).attempts,
    ).toContainEqual(expect.objectContaining({ id: "review-current", reviewsAttemptId: "retry-1" }));
  });

  it.each(attemptHistoryPermutations)(
    "keeps retry-1 authoritative across coherent attempt-history permutation %j",
    (...attemptOrder) => {
      const restored = restoreGraph(coherentlyReorderedRetrySnapshot(attemptOrder));

      expect(() =>
        applyEvent(restored, {
          type: "review.started",
          taskId: "publish",
          attemptId: "review-stale",
          agentId: "reviewer",
          reviewsAttemptId: "work-1",
          at: 7,
        }),
      ).toThrow(/current work attempt/i);
    },
  );

  it("rejects a forged work generation", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<Record<string, unknown>>;
    };
    const retry = snapshot.attempts.find((attempt) => attempt.id === "retry-1")!;
    retry.generation = 7;

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/generation/i);
  });

  it("rejects a forged review generation that does not bind to reviewed work", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<Record<string, unknown>>;
    };
    const review = snapshot.attempts.find((attempt) => attempt.id === "review-1")!;
    review.generation = 2;

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/review.*generation|generation.*review/i);
  });

  it("rejects a forged approved review rebound from current retry work to stale work", () => {
    const snapshot = JSON.parse(serializeGraph(graphWithApprovedRetryReview())) as {
      attempts: Array<Record<string, unknown>>;
      records: Array<{ event: Record<string, unknown> }>;
    };
    const approvedReview = snapshot.attempts.find((attempt) => attempt.id === "review-2")!;
    const reviewStart = snapshot.records.find(
      (record) => record.event.type === "review.started" && record.event.attemptId === "review-2",
    )!;
    approvedReview.generation = 1;
    approvedReview.reviewsAttemptId = "work-1";
    reviewStart.event.reviewsAttemptId = "work-1";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/current.*work|authoritative review|successful task/i);
  });

  it("rejects a forged active review rebound from current retry work to stale work", () => {
    let graph = graphAwaitingReviewAfterRetry();
    graph = applyEvent(graph, {
      type: "review.started",
      taskId: "publish",
      attemptId: "review-2",
      agentId: "reviewer",
      reviewsAttemptId: "retry-1",
      at: 7,
    });
    const snapshot = JSON.parse(serializeGraph(graph)) as {
      attempts: Array<Record<string, unknown>>;
      records: Array<{ event: Record<string, unknown> }>;
    };
    const activeReview = snapshot.attempts.find((attempt) => attempt.id === "review-2")!;
    const reviewStart = snapshot.records.find(
      (record) => record.event.type === "review.started" && record.event.attemptId === "review-2",
    )!;
    activeReview.generation = 1;
    activeReview.reviewsAttemptId = "work-1";
    reviewStart.event.reviewsAttemptId = "work-1";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/current.*work|authoritative review/i);
  });

  it("rejects a successful review-gated task without approval of current work", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      tasks: Array<Record<string, unknown>>;
    };
    snapshot.tasks[0]!.status = "succeeded";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/successful task|approved review|current work/i);
  });

  it("rejects missing and cross-task work predecessors", () => {
    const missingSnapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<Record<string, unknown>>;
    };
    const missingRetry = missingSnapshot.attempts.find((attempt) => attempt.id === "retry-1")!;
    missingRetry.supersedesAttemptId = "missing";

    expect(() => restoreGraph(JSON.stringify(missingSnapshot))).toThrow(/supersedes|predecessor/i);

    const crossTaskSnapshot = JSON.parse(serializeGraph(graphWithTwoFailedTasksAndRetry())) as {
      attempts: Array<Record<string, unknown>>;
    };
    const crossTaskRetry = crossTaskSnapshot.attempts.find((attempt) => attempt.id === "retry-a")!;
    crossTaskRetry.supersedesAttemptId = "work-b";

    expect(() => restoreGraph(JSON.stringify(crossTaskSnapshot))).toThrow(/same task|supersedes|predecessor/i);
  });

  it("rejects a coherently forged failure lineage that does not belong to the superseded work", () => {
    const snapshot = JSON.parse(serializeGraph(graphWithEveryRecordType())) as {
      attempts: Array<Record<string, unknown>>;
      records: Array<{ event: Record<string, unknown> }>;
    };
    const retry = snapshot.attempts.find((attempt) => attempt.id === "retry-1")!;
    const retryRecord = snapshot.records.find((record) => record.event.type === "retry.started")!;
    retry.previousAttemptId = "retry-1";
    retryRecord.event.retryOfAttemptId = "retry-1";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/failure lineage|bind/i);
  });

  it("rejects a cycle in the work supersession chain", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      attempts: Array<Record<string, unknown>>;
    };
    const work = snapshot.attempts.find((attempt) => attempt.id === "work-1")!;
    const retry = snapshot.attempts.find((attempt) => attempt.id === "retry-1")!;
    work.supersedesAttemptId = "retry-1";
    retry.supersedesAttemptId = "work-1";

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/cycle/i);
  });

  it("migrates a literal schema-v1 retry snapshot to schema v2 and round-trips it", () => {
    const migrated = restoreGraph(JSON.stringify(legacyV1RetrySnapshot()));

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.attempts).toMatchObject([
      { id: "work-1", generation: 1 },
      { id: "retry-1", generation: 2, previousAttemptId: "work-1", supersedesAttemptId: "work-1" },
    ]);
    expect(restoreGraph(serializeGraph(migrated))).toEqual(migrated);
  });

  it("migrates schema-v1 snapshots deterministically across object-field permutations", () => {
    const legacy = legacyV1RetrySnapshot();
    const canonical = serializeGraph(restoreGraph(JSON.stringify(legacy)));

    for (let seed = 0; seed < 8; seed += 1) {
      const permuted = permuteObjectFieldOrder(legacy, seed);
      expect(serializeGraph(restoreGraph(JSON.stringify(permuted)))).toBe(canonical);
    }
  });

  it("rejects a causally reordered schema-v1 retry during strict migration", () => {
    const legacy = legacyV1RetrySnapshot() as {
      attempts: Array<Record<string, unknown>>;
      records: Array<{ sequence: number; event: Record<string, unknown> }>;
    };
    legacy.attempts = [legacy.attempts[1]!, legacy.attempts[0]!];
    legacy.records = [legacy.records[2]!, legacy.records[0]!, legacy.records[1]!].map((record, index) => ({
      ...record,
      sequence: index + 1,
    }));

    expect(() => restoreGraph(JSON.stringify(legacy))).toThrow(/legacy v1 migration/i);
  });

  it("rejects a schema-v1 retry whose predecessor is missing during strict migration", () => {
    const legacy = legacyV1RetrySnapshot() as {
      attempts: Array<Record<string, unknown>>;
      records: Array<{ event: Record<string, unknown> }>;
    };
    const retry = legacy.attempts.find((attempt) => attempt.id === "retry-1")!;
    const retryRecord = legacy.records.find((record) => record.event.type === "retry.started")!;
    retry.previousAttemptId = "missing";
    retryRecord.event.retryOfAttemptId = "missing";

    expect(() => restoreGraph(JSON.stringify(legacy))).toThrow(/legacy v1 migration/i);
  });

  it("rejects schema-v1 attempts that masquerade with schema-v2 causal fields", () => {
    const legacy = legacyV1RetrySnapshot() as { attempts: Array<Record<string, unknown>> };
    legacy.attempts[0]!.generation = 1;

    expect(() => restoreGraph(JSON.stringify(legacy))).toThrow(/legacy v1 migration.*v2 causal fields/i);
  });

  it("rejects duplicate record sequence numbers", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      records: Array<{ sequence: number }>;
    };
    snapshot.records[1]!.sequence = snapshot.records[0]!.sequence;

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/sequence/i);
  });

  it("rejects duplicate attempt starts in the immutable event sequence", () => {
    const snapshot = JSON.parse(serializeGraph(graphAwaitingReviewAfterRetry())) as {
      records: Array<{ sequence: number; event: Record<string, unknown> }>;
    };
    snapshot.records[3]!.event = { ...snapshot.records[0]!.event, at: 4 };

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/attempt.*start|chronolog/i);
  });

  it("rejects a cancellation record that adds a known unrelated task", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "source", title: "Source", ownerAgentId: "agent" },
        { id: "child", title: "Child", ownerAgentId: "agent", parentTaskId: "source" },
        { id: "unrelated", title: "Unrelated", ownerAgentId: "agent" },
      ],
    });
    const cancelled = applyEvent(graph, { type: "task.cancelled", taskId: "source", reason: "stop", at: 1 });
    const snapshot = JSON.parse(serializeGraph(cancelled)) as {
      records: Array<{ event: Record<string, unknown> }>;
    };
    snapshot.records[0]!.event.affectedTaskIds = ["child", "source", "unrelated"];

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/cancellation.*affected|closure/i);
  });

  it("rejects a cancellation record that adds a known sibling", () => {
    const graph = createExplicitDag({
      maxParallelism: 1,
      agents: [{ id: "agent", label: "Agent" }],
      tasks: [
        { id: "parent", title: "Parent", ownerAgentId: "agent" },
        { id: "left", title: "Left", ownerAgentId: "agent", parentTaskId: "parent" },
        { id: "right", title: "Right", ownerAgentId: "agent", parentTaskId: "parent" },
      ],
    });
    const cancelled = applyEvent(graph, { type: "task.cancelled", taskId: "left", reason: "stop", at: 1 });
    const snapshot = JSON.parse(serializeGraph(cancelled)) as {
      records: Array<{ event: Record<string, unknown> }>;
    };
    snapshot.records[0]!.event.affectedTaskIds = ["left", "right"];

    expect(() => restoreGraph(JSON.stringify(snapshot))).toThrow(/cancellation.*affected|closure/i);
  });

  it("serializes every nested object canonically across field-order permutations", () => {
    const graph = graphWithEveryRecordType();
    const canonical = serializeGraph(graph);

    for (let seed = 0; seed < 16; seed += 1) {
      const permuted = permuteObjectFieldOrder(graph, seed) as GraphState;
      expect(permuted).toEqual(graph);
      expect(serializeGraph(permuted), `field permutation seed ${seed}`).toBe(canonical);
    }
  });
});
