import { describe, expect, it } from "vitest";

import {
  aggregateUsageByAgent,
  aggregateUsageByProject,
  aggregateUsageByWorkflow,
  aggregateUsageEvents,
  reconcileUsageEvents,
  type UsageEvent,
  USAGE_LEDGER_VERSION,
} from "./usageLedger";

const measurement = (value: number | null, provenance: UsageEvent["cost"]["provenance"] = "measured") =>
  ({ value, provenance }) as const;

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  ledgerVersion: USAGE_LEDGER_VERSION,
  projectId: "project-a",
  workflowId: "workflow-a",
  eventId: "usage-1",
  version: 1,
  agentId: "planner",
  attemptId: "attempt-1",
  rootAttemptId: "attempt-1",
  predecessorAttemptId: null,
  relationship: "root",
  provider: "openai-codex",
  model: "gpt-5",
  role: "primary",
  startedAtMs: 1_000,
  endedAtMs: null,
  toolTimeMs: measurement(125),
  tokens: {
    input: measurement(100),
    cached: measurement(20),
    output: measurement(30),
    reasoning: measurement(40),
  },
  cost: measurement(0.0125, "provider-reported"),
  retries: 0,
  cancelled: false,
  fallback: false,
  terminal: null,
  ...overrides,
});

const attemptId = (index: number): string => `attempt-${String(index).padStart(5, "0")}`;

const resolvedRetryLineage = (length: number): UsageEvent[] => {
  const rootAttemptId = attemptId(length - 1);
  return Array.from({ length }, (_, logicalIndex) => {
    const currentIndex = length - logicalIndex - 1;
    const currentAttemptId = attemptId(currentIndex);
    return event({
      eventId: `usage-${currentAttemptId}`,
      attemptId: currentAttemptId,
      rootAttemptId,
      predecessorAttemptId: logicalIndex === 0 ? null : attemptId(currentIndex + 1),
      relationship: logicalIndex === 0 ? "root" : "retry",
      startedAtMs: logicalIndex,
    });
  });
};

const cyclicRetryLineage = (length: number): UsageEvent[] =>
  Array.from({ length }, (_, index) => {
    const currentAttemptId = attemptId(index);
    return event({
      eventId: `usage-${currentAttemptId}`,
      attemptId: currentAttemptId,
      rootAttemptId: "declared-root",
      predecessorAttemptId: attemptId((index + 1) % length),
      relationship: "retry",
      startedAtMs: index,
    });
  });

const unresolvedRetryLineage = (length: number): UsageEvent[] =>
  Array.from({ length }, (_, index) => {
    const currentAttemptId = attemptId(index);
    return event({
      eventId: `usage-${currentAttemptId}`,
      attemptId: currentAttemptId,
      rootAttemptId: "missing-root",
      predecessorAttemptId: index === length - 1 ? "missing-root" : attemptId(index + 1),
      relationship: "retry",
      startedAtMs: index,
    });
  });

describe("usage ledger reconciliation", () => {
  it("keeps identical event identities separate across projects and workflows and exposes scoped totals", () => {
    const projectAWorkflowA = event({ cost: measurement(1) });
    const projectAWorkflowB = {
      ...projectAWorkflowA,
      workflowId: "workflow-b",
    } as UsageEvent;
    const projectBWorkflowA = {
      ...projectAWorkflowA,
      projectId: "project-b",
    } as UsageEvent;
    const events = [projectBWorkflowA, projectAWorkflowB, projectAWorkflowA];

    expect(aggregateUsageEvents(events).events).toHaveLength(3);
    expect(
      aggregateUsageByProject(events).map(({ projectId, totals }) => [projectId, totals.cost.knownTotal]),
    ).toEqual([
      ["project-a", 2],
      ["project-b", 1],
    ]);
    expect(
      aggregateUsageByWorkflow(events).map(({ projectId, workflowId, totals }) => [
        projectId,
        workflowId,
        totals.cost.knownTotal,
      ]),
    ).toEqual([
      ["project-a", "workflow-a", 1],
      ["project-a", "workflow-b", 1],
      ["project-b", "workflow-a", 1],
    ]);
    expect(
      aggregateUsageByAgent(events).map(({ projectId, workflowId, agentId, totals }) => [
        projectId,
        workflowId,
        agentId,
        totals.cost.knownTotal,
      ]),
    ).toEqual([
      ["project-a", "workflow-a", "planner", 1],
      ["project-a", "workflow-b", "planner", 1],
      ["project-b", "workflow-a", "planner", 1],
    ]);
  });

  it("retains charged failed-primary usage and a successful fallback as distinct linked attempts", () => {
    const primary = event({
      eventId: "primary-usage",
      endedAtMs: 1_300,
      cost: measurement(0.1, "provider-reported"),
      terminal: "failed",
    });
    const fallback = event({
      eventId: "fallback-usage",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-1",
      relationship: "fallback",
      provider: "anthropic",
      model: "claude-sonnet",
      startedAtMs: 1_400,
      endedAtMs: 1_700,
      cost: measurement(0.2, "provider-reported"),
      fallback: true,
      terminal: "completed",
    });

    expect(aggregateUsageEvents([fallback, primary]).attempts).toMatchObject([
      {
        attemptId: "attempt-1",
        provider: "openai-codex",
        model: "gpt-5",
        role: "primary",
        rootAttemptId: "attempt-1",
        predecessorAttemptId: null,
        relationship: "root",
        terminal: "failed",
        totals: { cost: { knownTotal: 0.1 } },
      },
      {
        attemptId: "attempt-2",
        provider: "anthropic",
        model: "claude-sonnet",
        role: "primary",
        rootAttemptId: "attempt-1",
        predecessorAttemptId: "attempt-1",
        relationship: "fallback",
        terminal: "completed",
        totals: { cost: { knownTotal: 0.2 } },
      },
    ]);
  });

  it("rejects fallback metadata unless it names a distinct linked attempt", () => {
    const sameAttempt = event({
      predecessorAttemptId: "attempt-1",
      relationship: "fallback",
      fallback: true,
    });
    const missingPredecessor = event({
      attemptId: "attempt-2",
      predecessorAttemptId: null,
      relationship: "fallback",
      fallback: true,
    });
    const disguisedRoot = event({ fallback: true });

    expect(() => reconcileUsageEvents([sameAttempt])).toThrow(/distinct.*attempt/i);
    expect(() => reconcileUsageEvents([missingPredecessor])).toThrow(/predecessor/i);
    expect(() => reconcileUsageEvents([disguisedRoot])).toThrow(/fallback.*relationship/i);
  });

  it("rejects a different event that reopens an already terminal attempt", () => {
    const terminal = event({
      eventId: "terminal",
      endedAtMs: 1_300,
      terminal: "completed",
    });
    const reopened = event({
      eventId: "later-open-event",
      startedAtMs: 1_400,
      endedAtMs: null,
      terminal: null,
    });

    expect(() => reconcileUsageEvents([terminal, reopened])).toThrow(/terminal attempt.*reopen/i);
    expect(() => reconcileUsageEvents([reopened, terminal])).toThrow(/terminal attempt.*reopen/i);
  });

  it("rejects conflicting relationship metadata within one attempt", () => {
    const root = event({ eventId: "root-observation" });
    const conflicting = event({
      eventId: "retry-observation",
      rootAttemptId: "attempt-0",
      predecessorAttemptId: "attempt-0",
      relationship: "retry",
    });

    expect(() => reconcileUsageEvents([root, conflicting])).toThrow(/conflicting attempt relationship/i);
    expect(() => reconcileUsageEvents([conflicting, root])).toThrow(/conflicting attempt relationship/i);
  });

  it("rejects the same two-attempt lineage cycle deterministically in all six input permutations", () => {
    const root = event({ eventId: "root" });
    const attempt2 = event({
      eventId: "attempt-2",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-3",
      relationship: "fallback",
      fallback: true,
    });
    const attempt3 = event({
      eventId: "attempt-3",
      attemptId: "attempt-3",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-2",
      relationship: "retry",
    });
    const orders = [
      [root, attempt2, attempt3],
      [root, attempt3, attempt2],
      [attempt2, root, attempt3],
      [attempt2, attempt3, root],
      [attempt3, root, attempt2],
      [attempt3, attempt2, root],
    ];

    const results = orders.map((ordered) => {
      try {
        reconcileUsageEvents(ordered);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : "non-error thrown";
      }
    });

    expect(results).toEqual(
      Array(6).fill(
        "Cyclic attempt lineage in project-a/workflow-a/planner: attempt-2 -> attempt-3 -> attempt-2.",
      ),
    );
  });

  it("rejects longer cycles plus local and traversed root inconsistencies", () => {
    const root = event({ eventId: "root" });
    const attempt2 = event({
      eventId: "attempt-2",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-3",
      relationship: "retry",
    });
    const attempt3 = event({
      eventId: "attempt-3",
      attemptId: "attempt-3",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-4",
      relationship: "retry",
    });
    const attempt4 = event({
      eventId: "attempt-4",
      attemptId: "attempt-4",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-2",
      relationship: "retry",
    });

    expect(() => reconcileUsageEvents([attempt4, root, attempt2, attempt3])).toThrow(
      "Cyclic attempt lineage in project-a/workflow-a/planner: attempt-2 -> attempt-3 -> attempt-4 -> attempt-2.",
    );
    expect(() => reconcileUsageEvents([event({ rootAttemptId: "attempt-0" })])).toThrow(
      /root attempt must identify itself/i,
    );
    expect(() =>
      reconcileUsageEvents([
        event({
          attemptId: "attempt-2",
          rootAttemptId: "attempt-1",
          predecessorAttemptId: "attempt-2",
          relationship: "retry",
        }),
      ]),
    ).toThrow(/linked attempt must be distinct from its predecessor/i);
    expect(() =>
      reconcileUsageEvents([
        event({
          attemptId: "attempt-2",
          rootAttemptId: "attempt-2",
          predecessorAttemptId: "attempt-1",
          relationship: "retry",
        }),
      ]),
    ).toThrow(/linked attempt must be distinct from.*root attempt/i);

    const otherRoot = event({
      eventId: "other-root",
      attemptId: "attempt-4",
      rootAttemptId: "attempt-4",
    });
    const mismatchedPredecessor = event({
      eventId: "mismatched-predecessor",
      attemptId: "attempt-3",
      rootAttemptId: "attempt-4",
      predecessorAttemptId: "attempt-4",
      relationship: "retry",
    });
    expect(() => reconcileUsageEvents([mismatchedPredecessor, attempt2, root, otherRoot])).toThrow(
      "Attempt lineage root mismatch in project-a/workflow-a/planner: attempt-2 declares attempt-1, but predecessor attempt-3 declares attempt-4.",
    );
  });

  it(
    "resolves a valid 20,000-attempt retry lineage in worst-case canonical traversal order",
    () => {
      const lineage = reconcileUsageEvents(resolvedRetryLineage(20_000)).lineage;

      expect(lineage).toHaveLength(20_000);
      expect(lineage[0]).toMatchObject({
        attemptId: "attempt-00000",
        status: "resolved",
        unresolvedPredecessorAttemptId: null,
      });
      expect(lineage[19_999]).toMatchObject({
        attemptId: "attempt-19999",
        relationship: "root",
        status: "resolved",
      });
    },
    30_000,
  );

  it(
    "reports a deep cycle deterministically regardless of adversarial input order",
    () => {
      const events = cyclicRetryLineage(12_000);
      const captureError = (ordered: readonly UsageEvent[]): string => {
        try {
          reconcileUsageEvents(ordered);
          return "accepted";
        } catch (error) {
          return error instanceof Error ? error.message : "non-error thrown";
        }
      };

      const forward = captureError(events);
      const reversed = captureError([...events].reverse());

      expect(reversed).toBe(forward);
      expect(forward).toMatch(
        /^Cyclic attempt lineage in project-a\/workflow-a\/planner: attempt-00000 -> attempt-00001/,
      );
      expect(forward.endsWith("attempt-00000.")).toBe(true);
    },
    30_000,
  );

  it(
    "propagates the first missing predecessor through a deep lineage independent of input order",
    () => {
      const events = unresolvedRetryLineage(12_000);
      const summarize = (ordered: readonly UsageEvent[]) =>
        reconcileUsageEvents(ordered).lineage.map(
          ({ attemptId: id, status, unresolvedPredecessorAttemptId }) => [
            id,
            status,
            unresolvedPredecessorAttemptId,
          ],
        );

      const forward = summarize(events);
      const reversed = summarize([...events].reverse());

      expect(reversed).toEqual(forward);
      expect(forward).toHaveLength(12_000);
      expect(forward[0]).toEqual(["attempt-00000", "unresolved", "missing-root"]);
      expect(forward[11_999]).toEqual(["attempt-11999", "unresolved", "missing-root"]);
    },
    30_000,
  );

  it("marks incomplete lineage unresolved, then deterministically resolves or rejects when the predecessor arrives", () => {
    const root = event({ eventId: "root" });
    const attempt2 = event({
      eventId: "attempt-2",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-3",
      relationship: "retry",
    });
    const completingAttempt3 = event({
      eventId: "attempt-3",
      attemptId: "attempt-3",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-1",
      relationship: "retry",
    });
    const cyclingAttempt3 = {
      ...completingAttempt3,
      predecessorAttemptId: "attempt-2",
    } as UsageEvent;

    expect(reconcileUsageEvents([attempt2]).lineage).toEqual([
      {
        projectId: "project-a",
        workflowId: "workflow-a",
        agentId: "planner",
        attemptId: "attempt-2",
        rootAttemptId: "attempt-1",
        predecessorAttemptId: "attempt-3",
        relationship: "retry",
        status: "unresolved",
        unresolvedPredecessorAttemptId: "attempt-3",
      },
    ]);
    expect(aggregateUsageEvents([attempt2]).attempts).toMatchObject([
      {
        attemptId: "attempt-2",
        lineageStatus: "unresolved",
        unresolvedPredecessorAttemptId: "attempt-3",
      },
    ]);
    expect(aggregateUsageByProject([attempt2])[0]?.lineage).toMatchObject([
      {
        attemptId: "attempt-2",
        status: "unresolved",
        unresolvedPredecessorAttemptId: "attempt-3",
      },
    ]);
    expect(
      reconcileUsageEvents([attempt2, completingAttempt3]).lineage.map(
        ({ attemptId, status, unresolvedPredecessorAttemptId }) => [
          attemptId,
          status,
          unresolvedPredecessorAttemptId,
        ],
      ),
    ).toEqual([
      ["attempt-2", "unresolved", "attempt-1"],
      ["attempt-3", "unresolved", "attempt-1"],
    ]);

    const expectedResolvedLineage = [
      ["attempt-1", "resolved", null],
      ["attempt-2", "resolved", null],
      ["attempt-3", "resolved", null],
    ];
    const summarizeAggregateLineage = (ordered: readonly UsageEvent[]) =>
      aggregateUsageEvents(ordered).attempts.map(
        ({ attemptId, lineageStatus, unresolvedPredecessorAttemptId }) => [
          attemptId,
          lineageStatus,
          unresolvedPredecessorAttemptId,
        ],
      );

    expect(summarizeAggregateLineage([attempt2, completingAttempt3, root])).toEqual(
      expectedResolvedLineage,
    );
    expect(summarizeAggregateLineage([root, attempt2, completingAttempt3])).toEqual(
      expectedResolvedLineage,
    );
    expect(summarizeAggregateLineage([completingAttempt3, root, attempt2])).toEqual(
      expectedResolvedLineage,
    );

    const invalidOrders = [
      [root, attempt2, cyclingAttempt3],
      [root, cyclingAttempt3, attempt2],
      [attempt2, root, cyclingAttempt3],
      [attempt2, cyclingAttempt3, root],
      [cyclingAttempt3, root, attempt2],
      [cyclingAttempt3, attempt2, root],
    ];
    const invalidResults = invalidOrders.map((ordered) => {
      try {
        aggregateUsageEvents(ordered);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : "non-error thrown";
      }
    });
    expect(invalidResults).toEqual(
      Array(6).fill(
        "Cyclic attempt lineage in project-a/workflow-a/planner: attempt-2 -> attempt-3 -> attempt-2.",
      ),
    );
  });

  it("keeps only the latest revision while retaining the complete event attribution", () => {
    const first = event();
    const latest = event({
      version: 2,
      endedAtMs: 1_300,
      cost: measurement(0.015, "measured"),
      retries: 1,
      terminal: "completed",
    });

    const reconciled = reconcileUsageEvents([latest, first]);

    expect(reconciled.events).toEqual([latest]);
  });

  it("rejects a negative token measurement instead of treating it as usage", () => {
    const original = event();
    const negative = event({
      tokens: { ...original.tokens, input: measurement(-1) },
    });

    expect(() => reconcileUsageEvents([negative])).toThrow(/non-negative/i);
  });

  it("rejects fractional and unsafe-integer token observations", () => {
    const original = event();
    const fractional = event({
      tokens: { ...original.tokens, input: measurement(1.5) },
    });
    const unsafe = event({
      tokens: { ...original.tokens, output: measurement(Number.MAX_SAFE_INTEGER + 1) },
    });

    expect(() => reconcileUsageEvents([fractional])).toThrow(/safe integer/i);
    expect(() => reconcileUsageEvents([unsafe])).toThrow(/safe integer/i);
  });

  it("rejects cost and token aggregates that overflow their finite numeric domains", () => {
    const hugeCostA = event({ eventId: "cost-a", cost: measurement(Number.MAX_VALUE) });
    const hugeCostB = event({ eventId: "cost-b", cost: measurement(Number.MAX_VALUE) });
    const original = event();
    const maxTokens = event({
      eventId: "tokens-a",
      tokens: { ...original.tokens, input: measurement(Number.MAX_SAFE_INTEGER) },
    });
    const oneMoreToken = event({
      eventId: "tokens-b",
      tokens: { ...original.tokens, input: measurement(1) },
    });

    expect(() => aggregateUsageEvents([hugeCostA, hugeCostB])).toThrow(/cost.*overflow/i);
    expect(() => aggregateUsageEvents([maxTokens, oneMoreToken])).toThrow(/input tokens.*overflow/i);
  });

  it("rejects conflicting terminal states for the same attempt regardless of arrival order", () => {
    const completed = event({
      eventId: "completion",
      endedAtMs: 1_300,
      terminal: "completed",
    });
    const cancelled = event({
      eventId: "cancellation",
      endedAtMs: 1_250,
      cancelled: true,
      terminal: "cancelled",
    });

    expect(() => reconcileUsageEvents([completed, cancelled])).toThrow(/conflicting terminal/i);
    expect(() => reconcileUsageEvents([cancelled, completed])).toThrow(/conflicting terminal/i);
  });

  it("rejects terminal records that have no end time or contradict their cancellation state", () => {
    expect(() => reconcileUsageEvents([event({ terminal: "completed" })])).toThrow(/terminal.*end/i);
    expect(() =>
      reconcileUsageEvents([event({ endedAtMs: 1_300, cancelled: true, terminal: "completed" })]),
    ).toThrow(/cancelled/i);
    expect(() =>
      reconcileUsageEvents([event({ endedAtMs: 1_300, cancelled: false, terminal: "cancelled" })]),
    ).toThrow(/cancelled/i);
  });

  it("does not count a superseded revision and retains every provenance in its aggregate", () => {
    const superseded = event({
      version: 1,
      toolTimeMs: measurement(500),
      tokens: {
        input: measurement(900),
        cached: measurement(800),
        output: measurement(700),
        reasoning: measurement(600),
      },
      cost: measurement(9),
    });
    const latest = event({
      version: 2,
      endedAtMs: 1_300,
      toolTimeMs: measurement(20),
      tokens: {
        input: measurement(10, "measured"),
        cached: measurement(2, "provider-reported"),
        output: measurement(5, "estimated"),
        reasoning: measurement(null, "unavailable"),
      },
      cost: measurement(0.1, "provider-reported"),
      terminal: "failed",
    });
    const fallback = event({
      eventId: "fallback-usage",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      predecessorAttemptId: "attempt-1",
      relationship: "fallback",
      provider: "anthropic",
      model: "claude-sonnet",
      role: "tool",
      startedAtMs: 1_400,
      endedAtMs: 1_500,
      toolTimeMs: measurement(5, "estimated"),
      tokens: {
        input: measurement(null, "unavailable"),
        cached: measurement(4, "provider-reported"),
        output: measurement(6, "measured"),
        reasoning: measurement(7, "estimated"),
      },
      cost: measurement(null, "unavailable"),
      retries: 2,
      fallback: true,
      terminal: "completed",
    });

    const aggregate = aggregateUsageEvents([superseded, latest, fallback]);

    expect(aggregate.events).toEqual([latest, fallback]);
    expect(aggregate.totals.toolTimeMs).toEqual({
      total: 25,
      knownTotal: 25,
      byProvenance: {
        measured: { value: 20, eventCount: 1 },
        "provider-reported": { value: 0, eventCount: 0 },
        estimated: { value: 5, eventCount: 1 },
        unavailable: { eventCount: 0 },
      },
    });
    expect(aggregate.totals.tokens.input).toEqual({
      total: null,
      knownTotal: 10,
      byProvenance: {
        measured: { value: 10, eventCount: 1 },
        "provider-reported": { value: 0, eventCount: 0 },
        estimated: { value: 0, eventCount: 0 },
        unavailable: { eventCount: 1 },
      },
    });
    expect(aggregate.totals.tokens.cached).toEqual({
      total: 6,
      knownTotal: 6,
      byProvenance: {
        measured: { value: 0, eventCount: 0 },
        "provider-reported": { value: 6, eventCount: 2 },
        estimated: { value: 0, eventCount: 0 },
        unavailable: { eventCount: 0 },
      },
    });
    expect(aggregate.totals.tokens.output).toEqual({
      total: 11,
      knownTotal: 11,
      byProvenance: {
        measured: { value: 6, eventCount: 1 },
        "provider-reported": { value: 0, eventCount: 0 },
        estimated: { value: 5, eventCount: 1 },
        unavailable: { eventCount: 0 },
      },
    });
    expect(aggregate.totals.tokens.reasoning).toEqual({
      total: null,
      knownTotal: 7,
      byProvenance: {
        measured: { value: 0, eventCount: 0 },
        "provider-reported": { value: 0, eventCount: 0 },
        estimated: { value: 7, eventCount: 1 },
        unavailable: { eventCount: 1 },
      },
    });
    expect(aggregate.totals.cost).toEqual({
      total: null,
      knownTotal: 0.1,
      byProvenance: {
        measured: { value: 0, eventCount: 0 },
        "provider-reported": { value: 0.1, eventCount: 1 },
        estimated: { value: 0, eventCount: 0 },
        unavailable: { eventCount: 1 },
      },
    });
    expect(aggregate.attempts).toMatchObject([
      {
        agentId: "planner",
        attemptId: "attempt-1",
        rootAttemptId: "attempt-1",
        predecessorAttemptId: null,
        relationship: "root",
        startedAtMs: 1_000,
        endedAtMs: 1_300,
        retries: 0,
        cancelled: false,
        fallback: false,
        terminal: "failed",
      },
      {
        agentId: "planner",
        attemptId: "attempt-2",
        rootAttemptId: "attempt-1",
        predecessorAttemptId: "attempt-1",
        relationship: "fallback",
        startedAtMs: 1_400,
        endedAtMs: 1_500,
        retries: 2,
        cancelled: false,
        fallback: true,
        terminal: "completed",
      },
    ]);
  });

  it("deduplicates an identical delivery but rejects two different payloads for one event version", () => {
    const original = event();
    const duplicate = {
      ...original,
      toolTimeMs: { ...original.toolTimeMs },
      tokens: {
        input: { ...original.tokens.input },
        cached: { ...original.tokens.cached },
        output: { ...original.tokens.output },
        reasoning: { ...original.tokens.reasoning },
      },
      cost: { ...original.cost },
    };
    const conflicting = event({
      tokens: { ...original.tokens, input: measurement(101) },
    });

    expect(reconcileUsageEvents([original, duplicate])).toEqual(reconcileUsageEvents([duplicate, original]));
    expect(() => reconcileUsageEvents([original, conflicting])).toThrow(/conflicting revision/i);
  });

  it("rejects malformed identity, timing, status, and provenance before reconciliation", () => {
    const invalidEvents: UsageEvent[] = [
      event({ agentId: " " }),
      { ...event(), ledgerVersion: 2 } as unknown as UsageEvent,
      event({ version: 1.5 }),
      event({ endedAtMs: 999 }),
      event({ retries: -1 }),
      event({ cancelled: true }),
      event({ cost: measurement(1, "unavailable") }),
      {
        ...event(),
        cost: { value: 1, provenance: "guessed" as UsageEvent["cost"]["provenance"] },
      },
    ];

    for (const invalid of invalidEvents) {
      expect(() => reconcileUsageEvents([invalid])).toThrow();
    }
  });

  it("rejects a later revision that reopens an already terminal event", () => {
    const closed = event({
      version: 1,
      endedAtMs: 1_300,
      terminal: "completed",
    });
    const reopened = event({
      version: 2,
      endedAtMs: null,
      terminal: null,
    });

    expect(() => reconcileUsageEvents([closed, reopened])).toThrow(/terminal.*reopen/i);
    expect(() => reconcileUsageEvents([reopened, closed])).toThrow(/terminal.*reopen/i);
  });

  it("preserves a valid epoch-zero end time when rolling up an attempt", () => {
    const zeroLength = event({
      startedAtMs: 0,
      endedAtMs: 0,
      terminal: "completed",
    });

    expect(aggregateUsageEvents([zeroLength]).attempts[0]?.endedAtMs).toBe(0);
  });

  it("keeps an attempt end time unavailable while any canonical event remains open", () => {
    const ended = event({
      eventId: "ended-event",
      endedAtMs: 1_200,
    });
    const open = event({
      eventId: "open-event",
      startedAtMs: 1_100,
      endedAtMs: null,
    });

    expect(aggregateUsageEvents([ended, open]).attempts[0]?.endedAtMs).toBeNull();
    expect(aggregateUsageEvents([open, ended]).attempts[0]?.endedAtMs).toBeNull();
  });
});
