import {
  calculateNextRun,
  captureTimeZoneData,
  decodeSerializedState,
  IntlTimeZoneAdapter,
  SchedulerDomain,
  schedulerTestOnly,
  type CurrentPolicy,
  type GrantSnapshot,
  type NextRunInput,
  type ScheduleInput,
  type SchedulerDurableAuthority,
  type SchedulerResult,
  type TaskDefinition,
} from "./scheduler";
import * as schedulerModule from "./scheduler";
import { describe, expect, test } from "vitest";

function value<T>(result: SchedulerResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorCode<T>(result: SchedulerResult<T>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed result");
  return result.error.code;
}

const testTimeZoneData = {
  source: "iana",
  version: "2024a-test-fixture",
  fingerprint: `sha256:${"a".repeat(64)}`,
  provenance: "prime-studio scheduler deterministic test fixture",
} as const;
const testTimeZoneAdapter = new IntlTimeZoneAdapter(testTimeZoneData);
const createTestDurableAuthority = (
  options: Parameters<NonNullable<typeof schedulerTestOnly>["createDurableAuthority"]>[0] = {},
): SchedulerDurableAuthority => {
  if (!schedulerTestOnly) throw new Error("scheduler test harness is unavailable outside test mode");
  return schedulerTestOnly.createDurableAuthority(options);
};
const testDurableAuthority = createTestDurableAuthority();
const utcTimeZoneData = value(captureTimeZoneData("UTC", testTimeZoneAdapter));
const newYorkTimeZoneData = value(captureTimeZoneData("America/New_York", testTimeZoneAdapter));

const nextRun = (input: NextRunInput) => calculateNextRun(input, testTimeZoneAdapter);
const decodeState = (input: unknown) => decodeSerializedState(input, testTimeZoneAdapter, testDurableAuthority);
const scheduler = (currentPolicy: CurrentPolicy) => SchedulerDomain.create(
  currentPolicy,
  testTimeZoneAdapter,
  testDurableAuthority,
);

const generousBudget = {
  maxInputTokens: 100_000,
  maxOutputTokens: 100_000,
  maxCacheReadTokens: 100_000,
  maxCacheWriteTokens: 100_000,
  maxTotalTokens: 400_000,
};

const policy = (epoch = 1, overrides: Partial<CurrentPolicy> = {}): CurrentPolicy => ({
  policyVersion: epoch,
  epoch,
  revokedGrantIds: [],
  concurrency: { global: 16, perProject: 8, perAgent: 4 },
  usage: {
    allowedRequests: [{ provider: "anthropic", model: "claude-test" }],
    perRun: generousBudget,
    aggregate: generousBudget,
  },
  ...overrides,
});

const grant = (epoch = 1): GrantSnapshot => ({
  grantId: "grant-1",
  policyVersion: epoch,
  epoch,
  issuedAtMs: 1_700_000_000_000,
  expiresAtMs: null,
  scope: {
    projectId: "project-1",
    chatId: "chat-1",
    agentId: "agent-1",
    capabilities: ["schedule.run"],
  },
});

const task = (revision = 1): TaskDefinition => ({
  id: "task-1",
  revision,
  owner: {
    projectId: "project-1",
    chatId: "chat-1",
    agentId: "agent-1",
  },
  instructions: "Run the deterministic scheduled task.",
  request: {
    provider: "anthropic",
    model: "claude-test",
  },
  execution: {
    kind: "worktree",
    rootId: "worktree-1",
  },
});

const baseInput = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  id: "schedule-1",
  task: task(),
  recurrence: {
    kind: "daily",
    startLocal: { year: 2024, month: 1, day: 1, hour: 9, minute: 0, second: 0 },
    everyDays: 1,
  },
  timezone: "UTC",
  timezoneData: utcTimeZoneData,
  recurrenceNormalizationVersion: 1,
  dstGapPolicy: "skip",
  dstFoldPolicy: "earlier",
  missedRunPolicy: { kind: "latest-only" },
  grant: grant(),
  retry: {
    maxAttempts: 2,
    backoffMs: 100,
    multiplier: 2,
    maxBackoffMs: 1_000,
  },
  concurrency: {
    perSchedule: 1,
  },
  claimLeaseMs: 500,
  createdAtMs: Date.UTC(2024, 0, 1, 0, 0, 0),
  enabled: true,
  ...overrides,
});

function prepared(input = baseInput()) {
  const domain = scheduler(policy());
  const schedule = value(domain.registerSchedule(input));
  const leader = value(domain.acquireLeader("scheduler-a", input.createdAtMs, 1_000));
  return { domain, schedule, leader };
}

function due(input = baseInput(), nowMs = Date.UTC(2024, 0, 2, 12, 0, 0)) {
  const preparedState = prepared(input);
  const leader = value(preparedState.domain.acquireLeader("scheduler-a", nowMs, 1_000));
  const materialized = value(preparedState.domain.materializeDue(input.id, leader, nowMs));
  return { ...preparedState, leader, materialized, nowMs };
}

function claimDue(input = baseInput(), nowMs = Date.UTC(2024, 0, 2, 12, 0, 0)) {
  const state = due(input, nowMs);
  const occurrence = state.materialized.created[0];
  if (!occurrence) throw new Error("expected a due occurrence");
  const claimed = value(state.domain.claimOccurrence(occurrence.key, state.leader, nowMs));
  return { ...state, occurrence, claimed };
}

describe("pure schedule calculation", () => {
  test("refuses to treat ambient Intl timezone rules as versioned authority", () => {
    expect(errorCode(captureTimeZoneData("UTC", new IntlTimeZoneAdapter()))).toBe("timezone_data_unavailable");
  });

  test("accepts only explicit strong timezone version, fingerprint, and provenance evidence", () => {
    expect(value(captureTimeZoneData("UTC", testTimeZoneAdapter))).toEqual(testTimeZoneData);
    expect(errorCode(captureTimeZoneData("UTC", new IntlTimeZoneAdapter({
      ...testTimeZoneData,
      fingerprint: "intl-v1-deadbeef",
    } as never)))).toBe("timezone_data_unavailable");
    expect(errorCode(captureTimeZoneData("UTC", new IntlTimeZoneAdapter({
      ...testTimeZoneData,
      provenance: "",
    } as never)))).toBe("timezone_data_unavailable");
    expect(errorCode(captureTimeZoneData("UTC", new IntlTimeZoneAdapter({
      ...testTimeZoneData,
      version: " ",
    } as never)))).toBe("timezone_data_unavailable");
  });

  test("rejects unknown next-run fields instead of accepting an open input shape", () => {
    const result = nextRun({
      recurrence: { kind: "one-shot", atMs: Date.UTC(2024, 0, 1, 1, 0, 0) },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: Date.UTC(2024, 0, 1, 0, 0, 0),
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
      unexpected: true,
    } as never);

    expect(errorCode(result)).toBe("decode_error");
  });

  test("fails closed when the pinned time-zone runtime fingerprint is unavailable", () => {
    const captured = value(captureTimeZoneData("UTC", testTimeZoneAdapter));
    const result = nextRun({
      recurrence: { kind: "one-shot", atMs: Date.UTC(2024, 0, 1, 1, 0, 0) },
      timezone: "UTC",
      timezoneData: { ...captured, fingerprint: `sha256:${"b".repeat(64)}` },
      afterMs: Date.UTC(2024, 0, 1, 0, 0, 0),
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
    });

    expect(errorCode(result)).toBe("timezone_data_unavailable");
  });

  test("preserves the configured local time for every weekly weekday", () => {
    const result = nextRun({
      recurrence: {
        kind: "weekly",
        startLocal: { year: 2024, month: 1, day: 1, hour: 9, minute: 45, second: 30 },
        everyWeeks: 1,
        weekdays: [1, 3],
      },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: Date.UTC(2024, 0, 1, 9, 45, 30),
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
    });

    expect(value(result)).toBe(Date.UTC(2024, 0, 3, 9, 45, 30));
  });

  test("calculates a one-shot instant strictly after the supplied clock", () => {
    const atMs = Date.UTC(2024, 5, 1, 12, 0, 0);
    const result = nextRun({
      recurrence: { kind: "one-shot", atMs },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: atMs - 1,
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
    });

    expect(value(result)).toBe(atMs);
    expect(value(nextRun({
      recurrence: { kind: "one-shot", atMs },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: atMs,
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
    }))).toBeNull();
  });

  test("skips a nonexistent spring-forward local time with the explicit gap policy", () => {
    const result = nextRun({
      recurrence: {
        kind: "daily",
        startLocal: { year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0 },
        everyDays: 1,
      },
      timezone: "America/New_York",
      timezoneData: newYorkTimeZoneData,
      afterMs: Date.UTC(2024, 2, 9, 0, 0, 0),
      dstGapPolicy: "skip",
      dstFoldPolicy: "earlier",
    });

    expect(value(result)).toBe(Date.UTC(2024, 2, 11, 6, 30, 0));
  });

  test("shifts a nonexistent spring-forward local time forward only when requested", () => {
    const result = nextRun({
      recurrence: {
        kind: "daily",
        startLocal: { year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0 },
        everyDays: 1,
      },
      timezone: "America/New_York",
      timezoneData: newYorkTimeZoneData,
      afterMs: Date.UTC(2024, 2, 9, 0, 0, 0),
      dstGapPolicy: "shift-forward",
      dstFoldPolicy: "earlier",
    });

    expect(value(result)).toBe(Date.UTC(2024, 2, 10, 7, 30, 0));
  });

  test("chooses the requested side of an autumn fold", () => {
    const input = {
      recurrence: {
        kind: "daily" as const,
        startLocal: { year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0 },
        everyDays: 1,
      },
      timezone: "America/New_York",
      timezoneData: newYorkTimeZoneData,
      afterMs: Date.UTC(2024, 10, 2, 0, 0, 0),
      dstGapPolicy: "reject" as const,
    };

    const earlier = nextRun({ ...input, dstFoldPolicy: "earlier" });
    const later = nextRun({ ...input, dstFoldPolicy: "later" });
    expect(value(earlier)).toBe(Date.UTC(2024, 10, 3, 5, 30, 0));
    expect(value(later)).toBe(Date.UTC(2024, 10, 3, 6, 30, 0));
  });

  test("rejects invalid recurrences, time zones, and unsafe integer instants", () => {
    expect(errorCode(nextRun({
      recurrence: {
        kind: "daily",
        startLocal: { year: 2024, month: 1, day: 1, hour: 9, minute: 0, second: 0 },
        everyDays: 0,
      },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: 0,
      dstGapPolicy: "skip",
      dstFoldPolicy: "earlier",
    }))).toBe("invalid_recurrence");
    expect(errorCode(nextRun({
      recurrence: {
        kind: "weekly",
        startLocal: { year: 2024, month: 1, day: 1, hour: 9, minute: 0, second: 0 },
        everyWeeks: 1,
        weekdays: [],
      },
      timezone: "Not/AZone",
      timezoneData: utcTimeZoneData,
      afterMs: 0,
      dstGapPolicy: "skip",
      dstFoldPolicy: "earlier",
    }))).toBe("invalid_timezone");
    expect(errorCode(nextRun({
      recurrence: { kind: "one-shot", atMs: Number.MAX_SAFE_INTEGER + 1 },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: 0,
      dstGapPolicy: "skip",
      dstFoldPolicy: "earlier",
    }))).toBe("unsafe_integer");
  });

  test("returns a checked error when recurrence date arithmetic overflows", () => {
    const result = nextRun({
      recurrence: {
        kind: "daily",
        startLocal: { year: 2024, month: 1, day: 1, hour: 9, minute: 0, second: 0 },
        everyDays: Number.MAX_SAFE_INTEGER,
      },
      timezone: "UTC",
      timezoneData: utcTimeZoneData,
      afterMs: Date.UTC(2024, 0, 1, 9, 0, 0),
      dstGapPolicy: "reject",
      dstFoldPolicy: "earlier",
    });

    expect(errorCode(result)).toBe("unsafe_integer");
  });
});

describe("scheduler ownership, admission, and leases", () => {
  test("persists project/chat/agent ownership, provider/model request, and an immutable grant snapshot", () => {
    const input = baseInput();
    const domain = scheduler(policy());
    const schedule = value(domain.registerSchedule(input));

    expect(schedule.task.owner).toEqual(input.task.owner);
    expect(schedule.task.request).toEqual({ provider: "anthropic", model: "claude-test" });
    expect(schedule.grantSnapshot).toEqual(input.grant);
    expect(Object.isFrozen(schedule.grantSnapshot)).toBe(true);
    expect(Object.isFrozen(schedule.grantSnapshot.scope)).toBe(true);

    input.grant.scope.projectId = "mutated-after-registration";
    expect(domain.getSchedule(input.id)?.grantSnapshot.scope.projectId).toBe("project-1");
  });

  test("persists the recurrence normalization version with time-zone and DST policy evidence", () => {
    const input = {
      ...baseInput(),
      recurrenceNormalizationVersion: 1,
    } as ScheduleInput & { recurrenceNormalizationVersion: number };
    const schedule = value(scheduler(policy()).registerSchedule(input));

    expect((schedule as unknown as Record<string, unknown>).recurrenceNormalizationVersion).toBe(1);
    expect(errorCode(scheduler(policy()).registerSchedule({
      ...baseInput(),
      recurrenceNormalizationVersion: 2,
    }))).toBe("invalid_input");
  });

  test("requires an explicit enabled state instead of silently defaulting it", () => {
    const input = { ...baseInput() } as Partial<ScheduleInput>;
    delete input.enabled;

    expect(errorCode(scheduler(policy()).registerSchedule(input as ScheduleInput))).toBe("invalid_input");
  });

  test("rejects legacy missed-run aliases that would invent an implicit catch-up limit", () => {
    const input = {
      ...baseInput(),
      missedRunPolicy: "run-all",
    } as unknown as ScheduleInput;

    expect(errorCode(scheduler(policy()).registerSchedule(input))).toBe("invalid_input");
  });

  test("rejects a grant snapshot whose project scope does not own the scheduled task", () => {
    const input = baseInput({
      grant: {
        ...grant(),
        scope: { ...grant().scope, projectId: "project-other" },
      },
    });
    expect(errorCode(scheduler(policy()).registerSchedule(input))).toBe("invalid_input");
  });

  test("defaults scheduled execution to denied unless the grant has schedule.run", () => {
    const input = baseInput({
      grant: {
        ...grant(),
        scope: { ...grant().scope, capabilities: ["chat.read"] },
      },
    });

    expect(errorCode(scheduler(policy()).registerSchedule(input))).toBe("capability_denied");
  });

  test("never accepts a policy rollback or removal of a recorded revocation", () => {
    const domain = scheduler(policy());
    expect(errorCode(domain.updatePolicy(policy(1, {
      concurrency: { global: 1, perProject: 1, perAgent: 1 },
    })))).toBe("policy_regression");
    value(domain.updatePolicy(policy(2, { revokedGrantIds: ["grant-1"] })));

    expect(errorCode(domain.updatePolicy(policy(1, { revokedGrantIds: ["grant-1"] })))).toBe("policy_regression");
    expect(errorCode(domain.updatePolicy(policy(3, { revokedGrantIds: [] })))).toBe("policy_regression");
    expect(domain.snapshot().policy.revokedGrantIds).toEqual(["grant-1"]);
  });

  test("claims an occurrence once and rejects a duplicate claim", () => {
    const state = claimDue();
    const duplicate = state.domain.claimOccurrence(state.occurrence.key, state.leader, state.nowMs);

    expect(errorCode(duplicate)).toBe("occurrence_not_claimable");
    expect(state.domain.getOccurrence(state.occurrence.key)?.attemptCount).toBe(1);
    expect(state.claimed.run.owner).toEqual(task().owner);
    expect(state.claimed.run.request).toEqual(task().request);
  });

  test("rejects an open leader-lease shape at the admission boundary", () => {
    const state = prepared();
    const nowMs = Date.UTC(2024, 0, 2, 12, 0, 0);
    const leader = value(state.domain.acquireLeader("scheduler-a", nowMs, 1_000));

    expect(errorCode(state.domain.materializeDue(state.schedule.id, { ...leader, unexpected: true } as never, nowMs))).toBe(
      "decode_error",
    );
  });

  test("rejects a stale leader fencing epoch after expiry and replacement", () => {
    const state = due();
    const replacement = value(state.domain.acquireLeader("scheduler-b", state.nowMs + 1_001, 1_000));
    expect(replacement.fencingEpoch).toBeGreaterThan(state.leader.fencingEpoch);

    expect(errorCode(state.domain.claimOccurrence(
      state.materialized.created[0].key,
      state.leader,
      state.nowMs + 1_001,
    ))).toBe("stale_fencing_epoch");
    expect(errorCode(state.domain.heartbeatLeader(state.leader, state.nowMs + 1_001))).toBe("lease_expired");
  });

  test("enforces the policy global cap across schedules even when their local caps are higher", () => {
    const firstInput = baseInput({
      id: "schedule-a",
      concurrency: { perSchedule: 4 },
    });
    const secondInput = baseInput({
      id: "schedule-b",
      concurrency: { perSchedule: 4 },
    });
    const domain = scheduler(policy(1, {
      concurrency: { global: 1, perProject: 8, perAgent: 8 },
    }));
    value(domain.registerSchedule(firstInput));
    value(domain.registerSchedule(secondInput));
    const nowMs = Date.UTC(2024, 0, 2, 12, 0, 0);
    const leader = value(domain.acquireLeader("scheduler-a", nowMs, 1_000));
    const firstDue = value(domain.materializeDue(firstInput.id, leader, nowMs));
    const secondDue = value(domain.materializeDue(secondInput.id, leader, nowMs));
    value(domain.claimOccurrence(firstDue.created[0].key, leader, nowMs));

    const capped = domain.claimOccurrence(secondDue.created[0].key, leader, nowMs);
    expect(errorCode(capped)).toBe("guardrail_exhausted");
    expect(domain.getOccurrence(secondDue.created[0].key)?.status).toBe("guardrail_exhausted");
  });

  test("enforces authoritative project and agent caps across different schedules", () => {
    const ownedInput = (id: string, projectId: string, agentId: string): ScheduleInput => {
      const owner = { projectId, chatId: `chat-${id}`, agentId };
      return baseInput({
        id,
        task: { ...task(), id: `task-${id}`, owner },
        grant: {
          ...grant(),
          grantId: `grant-${id}`,
          scope: { ...owner, capabilities: ["schedule.run"] },
        },
        concurrency: { perSchedule: 4 },
      });
    };
    const claimFirstThenSecond = (currentPolicy: CurrentPolicy, first: ScheduleInput, second: ScheduleInput) => {
      const domain = scheduler(currentPolicy);
      value(domain.registerSchedule(first));
      value(domain.registerSchedule(second));
      const nowMs = Date.UTC(2024, 0, 2, 12, 0, 0);
      const leader = value(domain.acquireLeader("scheduler-a", nowMs, 1_000));
      const firstOccurrence = value(domain.materializeDue(first.id, leader, nowMs)).created[0];
      const secondOccurrence = value(domain.materializeDue(second.id, leader, nowMs)).created[0];
      value(domain.claimOccurrence(firstOccurrence.key, leader, nowMs));
      return domain.claimOccurrence(secondOccurrence.key, leader, nowMs);
    };

    expect(errorCode(claimFirstThenSecond(
      policy(1, { concurrency: { global: 8, perProject: 1, perAgent: 8 } }),
      ownedInput("project-a", "project-shared", "agent-a"),
      ownedInput("project-b", "project-shared", "agent-b"),
    ))).toBe("guardrail_exhausted");
    expect(errorCode(claimFirstThenSecond(
      policy(1, { concurrency: { global: 8, perProject: 8, perAgent: 1 } }),
      ownedInput("agent-a", "project-a", "agent-shared"),
      ownedInput("agent-b", "project-b", "agent-shared"),
    ))).toBe("guardrail_exhausted");
  });

  test("revocation immediately blocks an unconsumed old-generation lease", () => {
    const state = claimDue();
    value(state.domain.updatePolicy(policy(2)));

    const committed = state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs);
    expect(errorCode(committed)).toBe("grant_revoked");
    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("blocked-before-action");
    expect(state.domain.getRun(state.claimed.run.id)?.status).toBe("blocked-before-action");
    expect(state.domain.getRun(state.claimed.run.id)?.lease).toBeUndefined();
    expect(decodeState(state.domain.serialize()).ok).toBe(true);
  });
});

describe("materialization, missed-run policy, retry, and usage", () => {
  test("compresses a catch-up storm to one latest occurrence plus a skipped span", () => {
    const nowMs = Date.UTC(2024, 0, 10, 12, 0, 0);
    const state = due(baseInput(), nowMs);

    expect(state.materialized.created).toHaveLength(1);
    expect(state.materialized.created[0].scheduledInstantMs).toBe(Date.UTC(2024, 0, 10, 9, 0, 0));
    expect(state.materialized.skippedSpans).toEqual([
      {
        scheduleId: "schedule-1",
        taskRevision: 1,
        startMs: Date.UTC(2024, 0, 1, 9, 0, 0),
        endMs: Date.UTC(2024, 0, 9, 9, 0, 0),
        count: 9,
        reason: "missed-catch-up-compressed",
      },
    ]);
    expect(state.domain.getSchedule("schedule-1")?.nextRunAtMs).toBe(Date.UTC(2024, 0, 11, 9, 0, 0));
  });

  test("supports an explicit skip-all missed-run policy without creating a dispatchable row", () => {
    const input = baseInput({ missedRunPolicy: { kind: "skip" } });
    const state = due(input, Date.UTC(2024, 0, 4, 12, 0, 0));

    expect(state.materialized.created).toHaveLength(0);
    expect(state.materialized.skippedSpans[0]).toMatchObject({ count: 4, reason: "missed-policy-skip" });
  });

  test("retries a retryable failure with deterministic exponential backoff and then terminates", () => {
    const state = claimDue();
    const committed = value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.startRun(state.claimed.run.id, state.claimed.run.lease!.leaseId, state.nowMs));
    const failed = value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "failed", retryable: true, reason: "transient" },
      state.nowMs + 10,
    ));

    expect(committed.fencingEpoch).toBe(state.leader.fencingEpoch);
    expect(committed.usageBudget).toEqual(policy().usage.perRun);
    expect(failed.status).toBe("failed");
    expect(state.domain.getOccurrence(state.occurrence.key)).toMatchObject({
      status: "retry_wait",
      nextRetryAtMs: state.nowMs + 110,
      attemptCount: 1,
    });

    expect(errorCode(state.domain.claimOccurrence(state.occurrence.key, state.leader, state.nowMs + 109))).toBe(
      "retry_not_due",
    );
    const retry = value(state.domain.claimOccurrence(state.occurrence.key, state.leader, state.nowMs + 110));
    value(state.domain.commitDispatch(retry.run.id, state.leader, state.nowMs + 110));
    value(state.domain.startRun(retry.run.id, retry.run.lease!.leaseId, state.nowMs + 110));
    value(state.domain.completeRun(
      retry.run.id,
      retry.run.lease!.leaseId,
      { outcome: "failed", retryable: true, reason: "still-transient" },
      state.nowMs + 120,
    ));
    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("failed");
  });

  test("links visible per-run usage observations without inventing missing metrics", () => {
    const state = claimDue();
    const observation = value(state.domain.recordUsage(state.claimed.run.id, {
      observationId: "usage-1",
      observedAtMs: state.nowMs + 1,
      provider: "anthropic",
      model: "claude-test",
      inputTokens: 120,
      outputTokens: 30,
      source: "reported",
    }));

    expect(observation.outputTokens).toBe(30);
    expect(observation.cacheReadTokens).toBeUndefined();
    expect(state.domain.getRun(state.claimed.run.id)?.usageObservationIds).toEqual(["usage-1"]);
    expect(state.domain.getUsage("usage-1")).toEqual(observation);
    expect(errorCode(state.domain.recordUsage(state.claimed.run.id, {
      observationId: "usage-unsafe",
      observedAtMs: state.nowMs,
      provider: "anthropic",
      model: "claude-test",
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      source: "reported",
    }))).toBe("unsafe_integer");
  });

  test("binds usage to the run request and enforces per-run and aggregate policy budgets", () => {
    const constrainedBudget = {
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCacheReadTokens: 1_000,
      maxCacheWriteTokens: 1_000,
      maxTotalTokens: 100,
    };
    const aggregateBudget = { ...constrainedBudget, maxTotalTokens: 150 };
    const domain = scheduler(policy(1, {
      usage: {
        allowedRequests: [{ provider: "anthropic", model: "claude-test" }],
        perRun: constrainedBudget,
        aggregate: aggregateBudget,
      },
    }));
    const first = baseInput({ id: "usage-a", concurrency: { perSchedule: 2 } });
    const second = baseInput({ id: "usage-b", concurrency: { perSchedule: 2 } });
    const third = baseInput({ id: "usage-c", concurrency: { perSchedule: 2 } });
    const raced = baseInput({ id: "usage-race", concurrency: { perSchedule: 2 } });
    value(domain.registerSchedule(first));
    value(domain.registerSchedule(second));
    value(domain.registerSchedule(third));
    value(domain.registerSchedule(raced));
    const nowMs = Date.UTC(2024, 0, 2, 12, 0, 0);
    const leader = value(domain.acquireLeader("scheduler-a", nowMs, 1_000));
    const firstOccurrence = value(domain.materializeDue(first.id, leader, nowMs)).created[0];
    const secondOccurrence = value(domain.materializeDue(second.id, leader, nowMs)).created[0];
    const racedOccurrence = value(domain.materializeDue(raced.id, leader, nowMs)).created[0];
    const firstRun = value(domain.claimOccurrence(firstOccurrence.key, leader, nowMs)).run;
    const secondRun = value(domain.claimOccurrence(secondOccurrence.key, leader, nowMs)).run;
    const racedRun = value(domain.claimOccurrence(racedOccurrence.key, leader, nowMs)).run;

    expect(errorCode(domain.recordUsage(firstRun.id, {
      observationId: "wrong-request",
      observedAtMs: nowMs,
      provider: "openai",
      model: "claude-test",
      inputTokens: 1,
      source: "reported",
    }))).toBe("request_not_allowed");
    value(domain.recordUsage(firstRun.id, {
      observationId: "first-80",
      observedAtMs: nowMs,
      provider: "anthropic",
      model: "claude-test",
      inputTokens: 80,
      source: "reported",
    }));
    expect(errorCode(domain.recordUsage(firstRun.id, {
      observationId: "first-over-run",
      observedAtMs: nowMs,
      provider: "anthropic",
      model: "claude-test",
      outputTokens: 21,
      source: "reported",
    }))).toBe("usage_budget_exhausted");
    value(domain.recordUsage(secondRun.id, {
      observationId: "second-70",
      observedAtMs: nowMs,
      provider: "anthropic",
      model: "claude-test",
      outputTokens: 70,
      source: "reported",
    }));
    const thirdOccurrence = value(domain.materializeDue(third.id, leader, nowMs)).created[0];
    expect(errorCode(domain.claimOccurrence(thirdOccurrence.key, leader, nowMs))).toBe("usage_budget_exhausted");
    expect(domain.getOccurrence(thirdOccurrence.key)?.status).toBe("guardrail_exhausted");
    expect(errorCode(domain.commitDispatch(racedRun.id, leader, nowMs))).toBe("usage_budget_exhausted");
    expect(domain.getOccurrence(racedOccurrence.key)?.status).toBe("guardrail_exhausted");
    expect(domain.getRun(racedRun.id)?.lease).toBeUndefined();
    expect(decodeState(domain.serialize()).ok).toBe(true);
    expect(errorCode(domain.recordUsage(secondRun.id, {
      observationId: "aggregate-over",
      observedAtMs: nowMs,
      provider: "anthropic",
      model: "claude-test",
      outputTokens: 1,
      source: "reported",
    }))).toBe("usage_budget_exhausted");
    expect(domain.getRun(firstRun.id)?.usageObservationIds).toEqual(["first-80"]);
    expect(domain.getRun(secondRun.id)?.usageObservationIds).toEqual(["second-70"]);
  });

  test("reserves aggregate usage budget across concurrent dispatches", () => {
    const perRun = { ...generousBudget, maxTotalTokens: 100 };
    const aggregate = { ...generousBudget, maxTotalTokens: 150 };
    const domain = scheduler(policy(1, {
      usage: {
        allowedRequests: [{ provider: "anthropic", model: "claude-test" }],
        perRun,
        aggregate,
      },
    }));
    const first = baseInput({ id: "reserve-a", concurrency: { perSchedule: 2 } });
    const second = baseInput({ id: "reserve-b", concurrency: { perSchedule: 2 } });
    value(domain.registerSchedule(first));
    value(domain.registerSchedule(second));
    const nowMs = Date.UTC(2024, 0, 2, 12, 0, 0);
    const leader = value(domain.acquireLeader("scheduler-a", nowMs, 1_000));
    const firstOccurrence = value(domain.materializeDue(first.id, leader, nowMs)).created[0];
    const secondOccurrence = value(domain.materializeDue(second.id, leader, nowMs)).created[0];
    const firstRun = value(domain.claimOccurrence(firstOccurrence.key, leader, nowMs)).run;
    const secondRun = value(domain.claimOccurrence(secondOccurrence.key, leader, nowMs)).run;

    const firstTicket = value(domain.commitDispatch(firstRun.id, leader, nowMs));
    const secondTicket = value(domain.commitDispatch(secondRun.id, leader, nowMs));
    expect(firstTicket.usageBudget.maxTotalTokens).toBe(100);
    expect(secondTicket.usageBudget.maxTotalTokens).toBe(50);
    expect(secondTicket.aggregateRemaining.maxTotalTokens).toBe(0);
  });

  test("rejects a task request outside the policy provider/model allowlist", () => {
    const input = baseInput({ task: { ...task(), request: { provider: "openai", model: "gpt-test" } } });
    expect(errorCode(scheduler(policy()).registerSchedule(input))).toBe("request_not_allowed");
  });

  test("rejects unbounded provider and model identifiers before admission", () => {
    const input = baseInput({ task: { ...task(), request: { provider: "p".repeat(65), model: "m".repeat(257) } } });
    expect(errorCode(scheduler(policy()).registerSchedule(input))).toBe("invalid_input");
  });

  test("does not accept a successful completion before dispatch commitment", () => {
    const state = claimDue();

    expect(errorCode(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      state.nowMs,
    ))).toBe(
      "dispatch_not_claimed",
    );
    expect(state.domain.getRun(state.claimed.run.id)?.status).toBe("claimed");
  });
});

describe("heartbeats, crash recovery, and cancellation races", () => {
  test("atomically invalidates a claimed run when its schedule is disabled before dispatch", () => {
    const state = claimDue();
    const disabledAtMs = state.nowMs + 1;

    value(state.domain.setScheduleEnabled("schedule-1", false, disabledAtMs));

    expect(state.domain.getRun(state.claimed.run.id)).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      reason: "schedule disabled",
      terminalAtMs: disabledAtMs,
    });
    expect(state.domain.getOccurrence(state.occurrence.key)).toMatchObject({
      status: "cancelled",
      reason: "schedule disabled",
    });
    expect(state.domain.getOccurrence(state.occurrence.key)?.activeRunId).toBeUndefined();
    expect(errorCode(state.domain.commitDispatch(state.claimed.run.id, state.leader, disabledAtMs))).toBe(
      "schedule_disabled",
    );
    expect(state.domain.getRun(state.claimed.run.id)?.dispatch).toBeUndefined();
  });

  test("never dispatches a run before its persisted admission time", () => {
    const state = due();
    const occurrence = state.materialized.created[0];
    const claimed = value(state.domain.claimOccurrence(occurrence.key, state.leader, state.nowMs + 10));
    const before = state.domain.serialize();

    expect(errorCode(state.domain.commitDispatch(claimed.run.id, state.leader, state.nowMs + 9))).toBe("invalid_time");
    expect(state.domain.serialize()).toEqual(before);
    expect(state.domain.getRun(claimed.run.id)?.dispatch).toBeUndefined();
  });

  test("rejects a backdated disable without mutating scheduler state", () => {
    const state = claimDue();
    const before = state.domain.serialize();
    const admittedAtMs = state.claimed.run.admittedAtMs;

    expect(errorCode(state.domain.setScheduleEnabled("schedule-1", false, admittedAtMs - 1))).toBe("invalid_time");
    expect(state.domain.serialize()).toEqual(before);
    expect(decodeState(state.domain.serialize()).ok).toBe(true);
  });

  test("rejects a restart snapshot that disables a schedule without invalidating its claim", () => {
    const state = claimDue();
    const encoded = state.domain.serialize();
    const schedule = encoded.schedules[state.schedule.id];

    expect(errorCode(decodeState({
      ...encoded,
      schedules: {
        ...encoded.schedules,
        [schedule.id]: { ...schedule, enabled: false },
      },
    }))).toBe("decode_error");
  });

  test("rejects lease expiry overflow without partially acquiring leadership", () => {
    const domain = scheduler(policy());
    const before = domain.snapshot();

    expect(errorCode(domain.acquireLeader("scheduler-overflow", 8_640_000_000_000_000, 1))).toBe("invalid_time");
    expect(domain.snapshot()).toEqual(before);
  });

  test("rejects retry timestamp overflow without partially settling the run", () => {
    const maxTime = 8_640_000_000_000_000;
    const input = baseInput({
      recurrence: { kind: "one-shot", atMs: maxTime - 100 },
      retry: { maxAttempts: 2, backoffMs: 200, multiplier: 2, maxBackoffMs: 200 },
      claimLeaseMs: 40,
      createdAtMs: maxTime - 101,
    });
    const domain = scheduler(policy());
    value(domain.registerSchedule(input));
    const nowMs = maxTime - 100;
    const leader = value(domain.acquireLeader("scheduler-a", nowMs, 50));
    const occurrence = value(domain.materializeDue(input.id, leader, nowMs)).created[0];
    const claimed = value(domain.claimOccurrence(occurrence.key, leader, nowMs));
    const leaseId = claimed.run.lease!.leaseId;
    value(domain.commitDispatch(claimed.run.id, leader, nowMs));
    value(domain.startRun(claimed.run.id, leaseId, nowMs));
    const before = domain.snapshot();

    expect(errorCode(domain.completeRun(
      claimed.run.id,
      leaseId,
      { outcome: "failed", retryable: true, reason: "overflow" },
      nowMs + 1,
    ))).toBe("invalid_time");
    expect(domain.snapshot()).toEqual(before);
  });

  test("disabling a schedule cancels pending and retry-wait occurrences and blocks later claims", () => {
    const pending = due();
    const pendingKey = pending.materialized.created[0].key;
    value(pending.domain.setScheduleEnabled("schedule-1", false, pending.nowMs));
    expect(pending.domain.getOccurrence(pendingKey)).toMatchObject({ status: "cancelled", reason: "schedule disabled" });
    expect(errorCode(pending.domain.claimOccurrence(pendingKey, pending.leader, pending.nowMs))).toBe("schedule_disabled");

    const retrying = claimDue();
    const leaseId = retrying.claimed.run.lease!.leaseId;
    value(retrying.domain.commitDispatch(retrying.claimed.run.id, retrying.leader, retrying.nowMs));
    value(retrying.domain.startRun(retrying.claimed.run.id, leaseId, retrying.nowMs));
    value(retrying.domain.completeRun(
      retrying.claimed.run.id,
      leaseId,
      { outcome: "failed", retryable: true, reason: "retry" },
      retrying.nowMs + 1,
    ));
    value(retrying.domain.setScheduleEnabled("schedule-1", false, retrying.nowMs + 2));
    expect(retrying.domain.getOccurrence(retrying.occurrence.key)).toMatchObject({
      status: "cancelled",
      reason: "schedule disabled",
    });
    expect(retrying.domain.getOccurrence(retrying.occurrence.key)?.nextRetryAtMs).toBeUndefined();
    expect(errorCode(retrying.domain.claimOccurrence(
      retrying.occurrence.key,
      retrying.leader,
      retrying.nowMs + 101,
    ))).toBe("schedule_disabled");

    const recovering = claimDue();
    value(recovering.domain.setScheduleEnabled("schedule-1", false, recovering.nowMs));
    value(recovering.domain.recover(recovering.nowMs + 501));
    expect(recovering.domain.getOccurrence(recovering.occurrence.key)).toMatchObject({
      status: "cancelled",
      reason: "schedule disabled",
    });

    const active = claimDue();
    const activeLeaseId = active.claimed.run.lease!.leaseId;
    value(active.domain.commitDispatch(active.claimed.run.id, active.leader, active.nowMs));
    value(active.domain.startRun(active.claimed.run.id, activeLeaseId, active.nowMs));
    value(active.domain.setScheduleEnabled("schedule-1", false, active.nowMs));
    value(active.domain.completeRun(
      active.claimed.run.id,
      activeLeaseId,
      { outcome: "failed", retryable: true, reason: "retry while disabled" },
      active.nowMs + 1,
    ));
    expect(active.domain.getOccurrence(active.occurrence.key)).toMatchObject({
      status: "cancelled",
      reason: "schedule disabled",
    });
    expect(active.domain.getOccurrence(active.occurrence.key)?.nextRetryAtMs).toBeUndefined();
  });

  test("rejects start, heartbeat, and settlement after the run lease loses the current leader fence", () => {
    const input = baseInput({ claimLeaseMs: 5_000 });
    const state = claimDue(input);
    const lease = state.claimed.run.lease;
    if (!lease) throw new Error("expected a run lease");
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.acquireLeader("scheduler-b", state.nowMs + 1_001, 1_000));

    expect(errorCode(state.domain.startRun(state.claimed.run.id, lease.leaseId, state.nowMs + 1_001))).toBe(
      "stale_fencing_epoch",
    );
    expect(errorCode(state.domain.heartbeatRun(state.claimed.run.id, lease.leaseId, state.nowMs + 1_001))).toBe(
      "stale_fencing_epoch",
    );
    expect(errorCode(state.domain.completeRun(
      state.claimed.run.id,
      lease.leaseId,
      { outcome: "succeeded" },
      state.nowMs + 1_001,
    ))).toBe("stale_fencing_epoch");
  });

  test("heartbeats a claimed run and reclaims it after a pre-dispatch lease expires", () => {
    const state = claimDue();
    const lease = state.claimed.run.lease;
    if (!lease) throw new Error("expected a run lease");
    const renewed = value(state.domain.heartbeatRun(state.claimed.run.id, lease.leaseId, state.nowMs + 100));
    expect(renewed.expiresAtMs).toBe(state.nowMs + 600);

    const recovered = value(state.domain.recover(state.nowMs + 601));
    expect(recovered.reclaimedBeforeDispatch).toBe(1);
    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("pending");
    expect(state.domain.getRun(state.claimed.run.id)?.status).toBe("missed");
    expect(state.domain.getRun(state.claimed.run.id)?.lease).toBeUndefined();
    expect(decodeState(state.domain.serialize()).ok).toBe(true);
  });

  test("does not reuse a retired fence after missed recovery and same-holder restart", () => {
    const state = claimDue();
    value(state.domain.recover(state.nowMs + 1_001));
    const recovered = state.domain.serialize();

    expect(recovered.leader).toBeNull();
    expect(recovered.runs[state.claimed.run.id].lease).toBeUndefined();
    expect(recovered.nextFencingEpoch).toBe(state.leader.fencingEpoch);
    expect(errorCode(decodeState({ ...recovered, nextFencingEpoch: 0 }))).toBe("decode_error");
    expect(errorCode(decodeState({
      ...recovered,
      nextFencingEpoch: 0,
      fencingEpochHistory: [],
    }))).toBe("decode_error");

    const restarted = SchedulerDomain.fromState(recovered, testTimeZoneAdapter, testDurableAuthority);
    const replacement = value(restarted.acquireLeader("scheduler-a", state.nowMs + 1_001, 1_000));
    expect(replacement.fencingEpoch).toBeGreaterThan(state.leader.fencingEpoch);
    expect(errorCode(restarted.materializeDue("schedule-1", state.leader, state.nowMs + 1_001))).toBe(
      "stale_fencing_epoch",
    );
  });

  test("retains the fencing high-water after terminal run garbage collection", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.recover(state.nowMs + 1_001));
    const terminalFenceHistory = state.domain.serialize().fencingEpochHistory;
    const collectedCount = value(state.domain.garbageCollectTerminalHistory());
    const collected = state.domain.serialize();

    expect(collectedCount).toBe(1);
    expect(collected.occurrences).toEqual({});
    expect(collected.runs).toEqual({});
    expect(collected.usage).toEqual({});
    expect(collected.fencingEpochHistory).toEqual(terminalFenceHistory);
    const restarted = SchedulerDomain.fromState(collected, testTimeZoneAdapter, testDurableAuthority);
    const replacement = value(restarted.acquireLeader("scheduler-a", state.nowMs + 1_001, 1_000));
    expect(replacement.fencingEpoch).toBe(state.leader.fencingEpoch + 1);
  });

  test("fails closed when the durable fencing epoch is exhausted", () => {
    const authority = createTestDurableAuthority({
      initialFencingRecord: {
        fencingEpoch: Number.MAX_SAFE_INTEGER,
        leaderLeaseId: "leader-1",
        holderId: "scheduler-retired",
        issuedAtMs: Date.UTC(2024, 0, 1),
      },
    });
    const encoded = SchedulerDomain.create(policy(), testTimeZoneAdapter, authority).serialize();
    const restored = SchedulerDomain.fromState(encoded, testTimeZoneAdapter, authority);
    const before = restored.serialize();

    expect(errorCode(restored.acquireLeader("scheduler-a", Date.UTC(2024, 0, 2), 1_000))).toBe("unsafe_integer");
    expect(restored.serialize()).toEqual(before);
  });

  test("does not retry a pre-dispatch crash beyond the configured attempt ceiling", () => {
    const input = baseInput({
      retry: { maxAttempts: 1, backoffMs: 0, multiplier: 1, maxBackoffMs: 0 },
    });
    const state = claimDue(input);
    value(state.domain.recover(state.nowMs + input.claimLeaseMs + 1));

    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("missed");
    expect(errorCode(state.domain.claimOccurrence(state.occurrence.key, state.leader, state.nowMs + input.claimLeaseMs + 1))).toBe(
      "occurrence_not_claimable",
    );
  });

  test("turns a committed but unobserved dispatch into outcome_unknown on restart", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    const serialized = JSON.stringify(state.domain.serialize());
    const decoded = value(decodeState(JSON.parse(serialized)));
    const restarted = SchedulerDomain.fromState(decoded, testTimeZoneAdapter, testDurableAuthority);

    value(restarted.recover(state.nowMs + 501));
    expect(restarted.getOccurrence(state.occurrence.key)?.status).toBe("outcome_unknown");
    expect(restarted.getRun(state.claimed.run.id)?.status).toBe("outcome_unknown");
    expect(errorCode(restarted.claimOccurrence(state.occurrence.key, state.leader, state.nowMs + 501))).toBe(
      "occurrence_not_claimable",
    );
  });

  test("cancellation before dispatch wins the race and cannot be committed", () => {
    const state = claimDue();
    const cancelled = value(state.domain.cancelRun(state.claimed.run.id, state.nowMs + 1));

    expect(cancelled.status).toBe("cancelled");
    expect(errorCode(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs + 2))).toBe(
      "run_terminal",
    );
    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("cancelled");
  });

  test("records a post-dispatch cancellation request without rewriting an observed success", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.startRun(state.claimed.run.id, state.claimed.run.lease!.leaseId, state.nowMs + 1));
    const requested = value(state.domain.cancelRun(state.claimed.run.id, state.nowMs + 2));
    expect(requested.status).toBe("cancellation_requested");

    const completed = value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      state.nowMs + 3,
    ));
    expect(completed.status).toBe("succeeded");
    expect(state.domain.getOccurrence(state.occurrence.key)?.status).toBe("succeeded");
    expect(errorCode(state.domain.cancelRun(state.claimed.run.id, state.nowMs + 4))).toBe("run_terminal");
  });
});

describe("fail-closed serialization", () => {
  test("exposes the in-memory durable authority only through the test-mode harness", () => {
    const moduleExports = schedulerModule as unknown as {
      createSchedulerDurableAuthorityForTests?: unknown;
      schedulerTestOnly?: {
        createDurableAuthority(): SchedulerDurableAuthority;
      };
    };

    expect(moduleExports.createSchedulerDurableAuthorityForTests).toBeUndefined();
    expect(moduleExports.schedulerTestOnly?.createDurableAuthority()).toMatchObject({
      kind: "scheduler-durable-authority",
    });
  });

  test("requires an injected durable authority at production restart boundaries", () => {
    const encoded = prepared().domain.serialize();

    expect(errorCode(decodeSerializedState(encoded, testTimeZoneAdapter))).toBe("decode_error");
    expect(() => SchedulerDomain.create(policy(), testTimeZoneAdapter)).toThrow(/durable scheduler authority/i);
    expect(() => SchedulerDomain.fromState(encoded, testTimeZoneAdapter)).toThrow(/durable scheduler authority/i);
  });

  test("invalidates a pre-terminal snapshot as soon as the terminal transition succeeds", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    const preTerminal = state.domain.serialize();

    value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      state.nowMs + 1,
    ));

    expect(errorCode(decodeState(preTerminal))).toBe("decode_error");
    expect(state.domain.serialize().durableEvidence.revision).toBeGreaterThan(preTerminal.durableEvidence.revision);
  });

  test("rejects a coherent terminal-to-running rewrite at restart", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.startRun(state.claimed.run.id, state.claimed.run.lease!.leaseId, state.nowMs));
    value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      state.nowMs + 1,
    ));
    const terminal = state.domain.serialize();
    const terminalRun = terminal.runs[state.claimed.run.id];
    const terminalOccurrence = terminal.occurrences[state.occurrence.key];
    const {
      outcome: _outcome,
      terminalAtMs: _terminalAtMs,
      reason: _reason,
      retryScheduledAtMs: _retryScheduledAtMs,
      cancellationRequestedAtMs: _cancellationRequestedAtMs,
      ...nonTerminalRun
    } = terminalRun;

    expect(errorCode(decodeState({
      ...terminal,
      runs: {
        ...terminal.runs,
        [terminalRun.id]: { ...nonTerminalRun, status: "running" },
      },
      occurrences: {
        ...terminal.occurrences,
        [terminalOccurrence.key]: {
          ...terminalOccurrence,
          status: "running",
          activeRunId: terminalRun.id,
          reason: undefined,
        },
      },
    }))).toBe("decode_error");
  });

  test("invalidates a pre-revocation policy snapshot as soon as revocation succeeds", () => {
    const state = prepared();
    const preRevocation = state.domain.serialize();

    value(state.domain.updatePolicy(policy(2, { revokedGrantIds: ["grant-1"] })));

    expect(errorCode(decodeState(preRevocation))).toBe("decode_error");
    expect(state.domain.serialize().policy.revokedGrantIds).toEqual(["grant-1"]);
  });

  test("rejects a forged increase to an authenticated dispatch budget", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    const encoded = state.domain.serialize();
    const run = encoded.runs[state.claimed.run.id];
    if (!run.usageBudget) throw new Error("expected a committed usage budget");

    expect(errorCode(decodeState({
      ...encoded,
      runs: {
        ...encoded.runs,
        [run.id]: {
          ...run,
          usageBudget: {
            ...run.usageBudget,
            maxInputTokens: run.usageBudget.maxInputTokens + 1,
          },
        },
      },
    }))).toBe("decode_error");
  });

  test("rejects a self-consistent reset after terminal state is garbage-collected", () => {
    const state = claimDue();
    value(state.domain.recover(state.nowMs + 1_001));
    const terminal = state.domain.serialize();

    expect(errorCode(decodeState({
      ...terminal,
      sequence: 0,
      nextFencingEpoch: 0,
      fencingEpochHistory: [],
      leader: null,
      occurrences: {},
      runs: {},
      usage: {},
    }))).toBe("decode_error");
  });

  test("starts a new lineage at the authority's exact seeded fencing and sequence high-waters", () => {
    const initialFencingRecord = {
      fencingEpoch: 7,
      leaderLeaseId: "leader-37",
      holderId: "scheduler-retired",
      issuedAtMs: Date.UTC(2024, 0, 1),
    };
    const authority = createTestDurableAuthority({
      initialFencingRecord,
      initialSequenceHighWater: 41,
    });
    const domain = SchedulerDomain.create(policy(), testTimeZoneAdapter, authority);

    expect(domain.serialize()).toMatchObject({
      sequence: 41,
      nextFencingEpoch: 7,
      fencingEpochHistory: [initialFencingRecord],
      durableEvidence: {
        fencingEpochHighWater: 7,
        sequenceHighWater: 41,
      },
    });
    const leader = value(domain.acquireLeader("scheduler-next", initialFencingRecord.issuedAtMs + 1, 1_000));
    expect(leader).toMatchObject({ fencingEpoch: 8, leaseId: "leader-42" });
  });

  test("rejects hostile restart state advanced beyond authenticated high-waters", () => {
    const encoded = scheduler(policy()).serialize();

    expect(errorCode(decodeState({ ...encoded, sequence: 1 }))).toBe("decode_error");
    expect(errorCode(decodeState({
      ...encoded,
      sequence: 1,
      nextFencingEpoch: 1,
      fencingEpochHistory: [{
        fencingEpoch: 1,
        leaderLeaseId: "leader-1",
        holderId: "forged-scheduler",
        issuedAtMs: Date.UTC(2024, 0, 1),
      }],
    }))).toBe("decode_error");
  });

  test("persists an authenticated schedule enablement generation and rejects backdated transitions", () => {
    const state = prepared();
    const firstDisableAtMs = state.schedule.createdAtMs + 200;
    const disabled = value(state.domain.setScheduleEnabled(state.schedule.id, false, firstDisableAtMs));
    expect(disabled).toMatchObject({
      enabled: false,
      enablementGeneration: 2,
      enablementChangedAtMs: firstDisableAtMs,
    });

    expect(errorCode(state.domain.setScheduleEnabled(state.schedule.id, true, firstDisableAtMs - 1))).toBe("invalid_time");
    const reenabledAtMs = firstDisableAtMs + 200;
    const reenabled = value(state.domain.setScheduleEnabled(state.schedule.id, true, reenabledAtMs));
    expect(reenabled).toMatchObject({
      enabled: true,
      enablementGeneration: 3,
      enablementChangedAtMs: reenabledAtMs,
    });
    expect(errorCode(state.domain.setScheduleEnabled(state.schedule.id, false, reenabledAtMs - 1))).toBe("invalid_time");

    const encoded = state.domain.serialize();
    const schedule = encoded.schedules[state.schedule.id];
    expect(errorCode(decodeState({
      ...encoded,
      schedules: {
        ...encoded.schedules,
        [schedule.id]: {
          ...schedule,
          enabled: false,
          enablementGeneration: 2,
          enablementChangedAtMs: firstDisableAtMs,
        },
      },
    }))).toBe("decode_error");
  });

  test("rejects final outcomes relabeled as pending during restart", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      state.nowMs + 1,
    ));
    const encoded = state.domain.serialize();
    const occurrence = encoded.occurrences[state.occurrence.key];

    expect(errorCode(decodeState({
      ...encoded,
      occurrences: {
        ...encoded.occurrences,
        [occurrence.key]: { ...occurrence, status: "pending" },
      },
    }))).toBe("decode_error");
  });

  test("requires retry_wait to match the latest eligible failed run exactly", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "failed", retryable: true, reason: "retry me" },
      state.nowMs + 1,
    ));
    const encoded = state.domain.serialize();
    const occurrence = encoded.occurrences[state.occurrence.key];
    expect(occurrence.status).toBe("retry_wait");

    expect(errorCode(decodeState({
      ...encoded,
      occurrences: {
        ...encoded.occurrences,
        [occurrence.key]: { ...occurrence, nextRetryAtMs: occurrence.nextRetryAtMs! + 1 },
      },
    }))).toBe("decode_error");
  });

  test("allows recovered pending work only after its exact missed predecessor", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    value(state.domain.completeRun(
      state.claimed.run.id,
      state.claimed.run.lease!.leaseId,
      { outcome: "failed", retryable: false, reason: "final failure" },
      state.nowMs + 1,
    ));
    const encoded = state.domain.serialize();
    const occurrence = encoded.occurrences[state.occurrence.key];

    expect(errorCode(decodeState({
      ...encoded,
      occurrences: {
        ...encoded.occurrences,
        [occurrence.key]: { ...occurrence, status: "pending", reason: undefined },
      },
    }))).toBe("decode_error");
  });

  test.each(["claimed", "dispatch_committed", "running", "cancellation_requested"] as const)(
    "rejects %s occurrence authority when a later terminal run exists",
    (activeStatus) => {
      const state = claimDue(baseInput({
        retry: { maxAttempts: 2, backoffMs: 0, multiplier: 1, maxBackoffMs: 0 },
      }));
      value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
      value(state.domain.completeRun(
        state.claimed.run.id,
        state.claimed.run.lease!.leaseId,
        { outcome: "failed", retryable: true, reason: "retry" },
        state.nowMs + 1,
      ));
      const retry = value(state.domain.claimOccurrence(state.occurrence.key, state.leader, state.nowMs + 1));
      value(state.domain.commitDispatch(retry.run.id, state.leader, state.nowMs + 1));
      value(state.domain.completeRun(
        retry.run.id,
        retry.run.lease!.leaseId,
        { outcome: "succeeded" },
        state.nowMs + 2,
      ));
      const encoded = state.domain.serialize();
      const firstRun = encoded.runs[state.claimed.run.id];
      const occurrence = encoded.occurrences[state.occurrence.key];
      const {
        outcome: _outcome,
        terminalAtMs: _terminalAtMs,
        reason: _reason,
        retryScheduledAtMs: _retryScheduledAtMs,
        cancellationRequestedAtMs: _cancellationRequestedAtMs,
        ...activeFirstRun
      } = firstRun;
      const forgedActiveRun = activeStatus === "claimed"
        ? (() => {
            const { dispatch: _dispatch, usageBudget: _usageBudget, ...claimedRun } = activeFirstRun;
            return { ...claimedRun, status: activeStatus };
          })()
        : {
            ...activeFirstRun,
            status: activeStatus,
            ...(activeStatus === "cancellation_requested"
              ? { cancellationRequestedAtMs: firstRun.dispatch!.committedAtMs }
              : {}),
          };

      expect(errorCode(decodeState({
        ...encoded,
        runs: {
          ...encoded.runs,
          [firstRun.id]: forgedActiveRun,
        },
        occurrences: {
          ...encoded.occurrences,
          [occurrence.key]: {
            ...occurrence,
            status: activeStatus,
            activeRunId: firstRun.id,
            reason: undefined,
          },
        },
      }))).toBe("decode_error");
    },
  );

  test("rejects a claimed run backdated before its durable admission fence", () => {
    const state = claimDue();
    const encoded = state.domain.serialize();
    const run = encoded.runs[state.claimed.run.id];
    if (!run.lease) throw new Error("expected a run lease");
    const backdated = {
      ...encoded,
      runs: {
        ...encoded.runs,
        [run.id]: {
          ...run,
          admittedAtMs: run.admittedAtMs - 1,
          lease: { ...run.lease, issuedAtMs: run.lease.issuedAtMs - 1 },
        },
      },
    };

    expect(errorCode(decodeState(backdated))).toBe("decode_error");
    expect(() => SchedulerDomain.fromState(backdated as never, testTimeZoneAdapter, testDurableAuthority)).toThrow(/decode_error/);
  });

  test("rejects a dispatched run whose admission and lease are backdated together", () => {
    const state = claimDue();
    value(state.domain.commitDispatch(state.claimed.run.id, state.leader, state.nowMs));
    const encoded = state.domain.serialize();
    const run = encoded.runs[state.claimed.run.id];
    if (!run.lease) throw new Error("expected a run lease");

    expect(errorCode(decodeState({
      ...encoded,
      runs: {
        ...encoded.runs,
        [run.id]: {
          ...run,
          admittedAtMs: run.admittedAtMs - 1,
          lease: { ...run.lease, issuedAtMs: run.lease.issuedAtMs - 1 },
        },
      },
    }))).toBe("decode_error");
  });

  test("rejects a lease-removed terminal run backdated before its admission fence", () => {
    const state = claimDue();
    value(state.domain.recover(state.nowMs + 1_001));
    const encoded = state.domain.serialize();
    const run = encoded.runs[state.claimed.run.id];
    expect(run.lease).toBeUndefined();

    expect(errorCode(decodeState({
      ...encoded,
      runs: {
        ...encoded.runs,
        [run.id]: { ...run, admittedAtMs: run.admittedAtMs - 1 },
      },
    }))).toBe("decode_error");
  });

  test("rejects run lifecycle combinations that no scheduler transition can produce", () => {
    const committed = claimDue();
    value(committed.domain.commitDispatch(committed.claimed.run.id, committed.leader, committed.nowMs));
    const committedState = committed.domain.serialize();
    const committedRun = committedState.runs[committed.claimed.run.id];
    const committedOccurrence = committedState.occurrences[committed.occurrence.key];
    const relabeledCommittedState = {
      ...committedState,
      runs: {
        ...committedState.runs,
        [committedRun.id]: { ...committedRun, status: "claimed" },
      },
      occurrences: {
        ...committedState.occurrences,
        [committedOccurrence.key]: { ...committedOccurrence, status: "claimed" },
      },
    };
    expect(errorCode(decodeState(relabeledCommittedState))).toBe("decode_error");
    expect(() => SchedulerDomain.fromState(relabeledCommittedState as never, testTimeZoneAdapter, testDurableAuthority)).toThrow(/decode_error/);

    const relabeledBlockedState = {
      ...committedState,
      runs: {
        ...committedState.runs,
        [committedRun.id]: {
          ...committedRun,
          status: "blocked-before-action",
          outcome: "blocked-before-action",
          terminalAtMs: committed.nowMs,
          reason: "forged pre-action terminal",
        },
      },
      occurrences: {
        ...committedState.occurrences,
        [committedOccurrence.key]: {
          ...committedOccurrence,
          status: "blocked-before-action",
          reason: "forged pre-action terminal",
          activeRunId: undefined,
        },
      },
    };
    expect(errorCode(decodeState(relabeledBlockedState))).toBe("decode_error");

    const running = claimDue();
    value(running.domain.commitDispatch(running.claimed.run.id, running.leader, running.nowMs));
    value(running.domain.startRun(running.claimed.run.id, running.claimed.run.lease!.leaseId, running.nowMs));
    const runningState = running.domain.serialize();
    const runningRun = runningState.runs[running.claimed.run.id];
    const { dispatch: _dispatch, usageBudget: _usageBudget, ...runningWithoutDispatch } = runningRun;
    expect(errorCode(decodeState({
      ...runningState,
      runs: { ...runningState.runs, [runningRun.id]: runningWithoutDispatch },
    }))).toBe("decode_error");

    const claimed = claimDue();
    const claimedState = claimed.domain.serialize();
    const claimedRun = claimedState.runs[claimed.claimed.run.id];
    expect(errorCode(decodeState({
      ...claimedState,
      runs: {
        ...claimedState.runs,
        [claimedRun.id]: { ...claimedRun, outcome: "succeeded", terminalAtMs: claimed.nowMs },
      },
    }))).toBe("decode_error");

    const completed = claimDue();
    value(completed.domain.commitDispatch(completed.claimed.run.id, completed.leader, completed.nowMs));
    value(completed.domain.completeRun(
      completed.claimed.run.id,
      completed.claimed.run.lease!.leaseId,
      { outcome: "succeeded" },
      completed.nowMs,
    ));
    const completedState = completed.domain.serialize();
    const completedRun = completedState.runs[completed.claimed.run.id];
    const { terminalAtMs: _terminalAtMs, ...completedWithoutTerminal } = completedRun;
    expect(errorCode(decodeState({
      ...completedState,
      runs: { ...completedState.runs, [completedRun.id]: completedWithoutTerminal },
    }))).toBe("decode_error");
  });

  test("rejects lowered, raised, skipped, or over-ceiling occurrence attempt high-water", () => {
    const state = claimDue(baseInput({
      retry: { maxAttempts: 1, backoffMs: 0, multiplier: 1, maxBackoffMs: 0 },
    }));
    const encoded = state.domain.serialize();
    const run = encoded.runs[state.claimed.run.id];
    const occurrence = encoded.occurrences[state.occurrence.key];

    expect(errorCode(decodeState({
      ...encoded,
      occurrences: {
        ...encoded.occurrences,
        [occurrence.key]: { ...occurrence, attemptCount: 0 },
      },
    }))).toBe("decode_error");

    const raised = claimDue(baseInput({
      retry: { maxAttempts: 2, backoffMs: 0, multiplier: 1, maxBackoffMs: 0 },
    }));
    const raisedState = raised.domain.serialize();
    const raisedOccurrence = raisedState.occurrences[raised.occurrence.key];
    const raisedForgery = {
      ...raisedState,
      occurrences: {
        ...raisedState.occurrences,
        [raisedOccurrence.key]: { ...raisedOccurrence, attemptCount: 2 },
      },
    };
    expect(errorCode(decodeState(raisedForgery))).toBe("decode_error");
    expect(() => SchedulerDomain.fromState(raisedForgery as never, testTimeZoneAdapter, testDurableAuthority)).toThrow(/decode_error/);

    const raisedRun = raisedState.runs[raised.claimed.run.id];
    expect(errorCode(decodeState({
      ...raisedState,
      runs: {
        ...raisedState.runs,
        [raisedRun.id]: { ...raisedRun, attempt: 2 },
      },
      occurrences: {
        ...raisedState.occurrences,
        [raisedOccurrence.key]: { ...raisedOccurrence, attemptCount: 2 },
      },
    }))).toBe("decode_error");

    expect(errorCode(decodeState({
      ...encoded,
      runs: {
        ...encoded.runs,
        [run.id]: { ...run, attempt: 2 },
      },
      occurrences: {
        ...encoded.occurrences,
        [occurrence.key]: { ...occurrence, attemptCount: 2 },
      },
    }))).toBe("decode_error");

    const retryable = claimDue(baseInput({
      retry: { maxAttempts: 2, backoffMs: 0, multiplier: 1, maxBackoffMs: 0 },
    }));
    value(retryable.domain.recover(retryable.nowMs + 501));
    const retryableState = retryable.domain.serialize();
    const retryableOccurrence = retryableState.occurrences[retryable.occurrence.key];
    expect(errorCode(decodeState({
      ...retryableState,
      occurrences: {
        ...retryableState.occurrences,
        [retryableOccurrence.key]: { ...retryableOccurrence, attemptCount: 2 },
      },
    }))).toBe("decode_error");
  });

  test("rejects sequence overflow after restart without mutating scheduler state", () => {
    const authority = createTestDurableAuthority({ initialSequenceHighWater: Number.MAX_SAFE_INTEGER });
    const encoded = SchedulerDomain.create(policy(), testTimeZoneAdapter, authority).serialize();
    const restored = SchedulerDomain.fromState(encoded, testTimeZoneAdapter, authority);
    const before = restored.snapshot();

    expect(errorCode(restored.acquireLeader("scheduler-overflow", Date.UTC(2024, 0, 2), 1_000))).toBe(
      "unsafe_integer",
    );
    expect(restored.snapshot()).toEqual(before);
  });

  test("rejects a lowered serialized sequence and durable fencing high-water exactly", () => {
    const state = claimDue(baseInput({ claimLeaseMs: 5_000 }));
    const encoded = state.domain.serialize();

    expect(errorCode(decodeState({
      ...encoded,
      sequence: 0,
    }))).toBe("decode_error");

    expect(errorCode(decodeState({ ...encoded, nextFencingEpoch: 0 }))).toBe("decode_error");
    const restored = SchedulerDomain.fromState(encoded, testTimeZoneAdapter, testDurableAuthority);
    const replacement = value(restored.acquireLeader("scheduler-restarted", state.nowMs + 1_001, 1_000));
    expect(replacement.leaseId).not.toBe(state.leader.leaseId);
    expect(replacement.leaseId).not.toBe(state.claimed.run.lease!.leaseId);
    expect(replacement.fencingEpoch).toBeGreaterThan(state.leader.fencingEpoch);
  });

  test("round-trips schedules, leases, runs, retry state, usage, and grant evidence", () => {
    const state = claimDue();
    value(state.domain.recordUsage(state.claimed.run.id, {
      observationId: "usage-round-trip",
      observedAtMs: state.nowMs,
      provider: "anthropic",
      model: "claude-test",
      outputTokens: 5,
      source: "derived",
    }));
    const encoded = state.domain.serialize();
    const decoded = value(decodeState(JSON.parse(JSON.stringify(encoded))));
    const restored = SchedulerDomain.fromState(decoded, testTimeZoneAdapter, testDurableAuthority);

    expect(restored.serialize()).toEqual(encoded);
  });

  test("rejects unknown fields, malformed states, and unsafe integers instead of guessing", () => {
    const domain = prepared().domain;
    const encoded = domain.serialize() as unknown as Record<string, unknown>;

    expect(errorCode(decodeState({ ...encoded, unexpected: true }))).toBe("decode_error");
    expect(errorCode(decodeState({ ...encoded, sequence: Number.MAX_SAFE_INTEGER + 1 }))).toBe(
      "unsafe_integer",
    );
    expect(errorCode(decodeState({ ...encoded, schemaVersion: 1 }))).toBe("decode_error");
    expect(errorCode(decodeState({ ...encoded, schemaVersion: 2 }))).toBe("decode_error");
    expect(errorCode(decodeState({ ...encoded, schemaVersion: 3 }))).toBe("decode_error");
    expect(errorCode(decodeState("not-json"))).toBe("decode_error");

    expect(errorCode(decodeState({
      ...encoded,
      leader: {
        ...(encoded.leader as NonNullable<typeof encoded.leader>),
        issuedAtMs: 8_640_000_000_000_001,
        expiresAtMs: 8_640_000_000_000_002,
      },
    }))).toBe("invalid_time");
  });

  test("rejects a serialized schedule with an invalid recurrence rather than normalizing it", () => {
    const domain = prepared().domain;
    const encoded = domain.serialize();
    const schedule = encoded.schedules["schedule-1"];
    const malformed = {
      ...encoded,
      schedules: {
        ...encoded.schedules,
        "schedule-1": {
          ...schedule,
          recurrence: {
            kind: "daily",
            startLocal: schedule.recurrence.kind === "daily" ? schedule.recurrence.startLocal : undefined,
            everyDays: 0,
          },
        },
      },
    };

    expect(errorCode(decodeState(malformed))).toBe("invalid_recurrence");
  });

  test("rejects restart when pinned time-zone version, fingerprint, or provenance is unavailable", () => {
    const encoded = prepared().domain.serialize();
    const schedule = encoded.schedules["schedule-1"];

    for (const timezoneData of [
      { ...schedule.timezoneData, version: "2024b-unavailable" },
      { ...schedule.timezoneData, fingerprint: `sha256:${"b".repeat(64)}` },
      { ...schedule.timezoneData, provenance: "different runtime artifact" },
    ]) {
      expect(errorCode(decodeState({
        ...encoded,
        schedules: {
          ...encoded.schedules,
          "schedule-1": { ...schedule, timezoneData },
        },
      }))).toBe("timezone_data_unavailable");
    }
  });

  test("rejects nested unknown fields and broken cross-record references", () => {
    const domain = prepared().domain;
    const encoded = domain.serialize();
    const withUnknownGrantField = {
      ...encoded,
      schedules: {
        ...encoded.schedules,
        "schedule-1": {
          ...encoded.schedules["schedule-1"],
          grantSnapshot: { ...encoded.schedules["schedule-1"].grantSnapshot, unexpected: true },
        },
      },
    };
    expect(errorCode(decodeState(withUnknownGrantField))).toBe("decode_error");

    const withBrokenOccurrence = {
      ...encoded,
      occurrences: {
        "schedule-1:1:1704099600000": {
          key: "schedule-1:1:1704099600000",
          scheduleId: "missing-schedule",
          taskRevision: 1,
          scheduledInstantMs: 1_704_099_600_000,
          createdAtMs: 1_704_099_600_000,
          status: "pending",
          attemptCount: 0,
          runIds: [],
          grantSnapshot: encoded.schedules["schedule-1"].grantSnapshot,
        },
      },
    };
    expect(errorCode(decodeState(withBrokenOccurrence))).toBe("decode_error");
  });

  test("rejects forged snapshot authority and request data across restart boundaries", () => {
    const state = claimDue();
    const encoded = state.domain.serialize();
    const runId = state.claimed.run.id;
    const occurrenceKey = state.occurrence.key;

    expect(errorCode(decodeState({
      ...encoded,
      runs: {
        ...encoded.runs,
        [runId]: {
          ...encoded.runs[runId],
          request: { provider: "anthropic", model: "forged-model" },
        },
      },
    }))).toBe("decode_error");

    expect(errorCode(decodeState({
      ...encoded,
      occurrences: {
        ...encoded.occurrences,
        [occurrenceKey]: {
          ...encoded.occurrences[occurrenceKey],
          grantSnapshot: { ...encoded.occurrences[occurrenceKey].grantSnapshot, grantId: "forged-grant" },
        },
      },
    }))).toBe("decode_error");

    expect(errorCode(decodeState({
      ...encoded,
      policy: { ...encoded.policy, policyVersion: 0, epoch: 0 },
    }))).toBe("policy_regression");
  });
});
