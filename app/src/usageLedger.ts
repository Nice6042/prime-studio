/** The current on-disk/event-contract version for usage observations. */
export const USAGE_LEDGER_VERSION = 1 as const;

/** Where a numeric usage value came from. `unavailable` deliberately has no value. */
export type UsageProvenance = "measured" | "provider-reported" | "estimated" | "unavailable";
export type KnownUsageProvenance = Exclude<UsageProvenance, "unavailable">;

export interface UsageMeasurement {
  readonly value: number | null;
  readonly provenance: UsageProvenance;
}

export type UsageAttemptRelationship = "root" | "retry" | "fallback";
export type UsageLineageStatus = "resolved" | "unresolved";

export interface UsageEvent {
  readonly ledgerVersion: typeof USAGE_LEDGER_VERSION;
  readonly projectId: string;
  readonly workflowId: string;
  /** Stable id for one chargeable observation; revisions replace, rather than add to, it. */
  readonly eventId: string;
  readonly version: number;
  readonly agentId: string;
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly predecessorAttemptId: string | null;
  readonly relationship: UsageAttemptRelationship;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly toolTimeMs: UsageMeasurement;
  readonly tokens: {
    readonly input: UsageMeasurement;
    readonly cached: UsageMeasurement;
    readonly output: UsageMeasurement;
    readonly reasoning: UsageMeasurement;
  };
  readonly cost: UsageMeasurement;
  readonly retries: number;
  readonly cancelled: boolean;
  readonly fallback: boolean;
  readonly terminal: "completed" | "failed" | "cancelled" | null;
}

export interface ReconciledUsageEvents {
  readonly ledgerVersion: typeof USAGE_LEDGER_VERSION;
  readonly events: readonly UsageEvent[];
  readonly lineage: readonly UsageAttemptLineage[];
}

export interface UsageAttemptLineage {
  readonly projectId: string;
  readonly workflowId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly predecessorAttemptId: string | null;
  readonly relationship: UsageAttemptRelationship;
  readonly status: UsageLineageStatus;
  /** The first absent attempt that prevents traversal to the declared root. */
  readonly unresolvedPredecessorAttemptId: string | null;
}

export interface KnownProvenanceContribution {
  readonly value: number;
  readonly eventCount: number;
}

export interface UnavailableProvenanceContribution {
  readonly eventCount: number;
}

/**
 * `total` is null when at least one canonical event is unavailable. Use
 * `knownTotal` only when a caller explicitly wants the observed subtotal.
 */
export interface UsageMeasurementAggregate {
  readonly total: number | null;
  readonly knownTotal: number;
  readonly byProvenance: {
    readonly measured: KnownProvenanceContribution;
    readonly "provider-reported": KnownProvenanceContribution;
    readonly estimated: KnownProvenanceContribution;
    readonly unavailable: UnavailableProvenanceContribution;
  };
}

export interface UsageTotals {
  readonly toolTimeMs: UsageMeasurementAggregate;
  readonly tokens: {
    readonly input: UsageMeasurementAggregate;
    readonly cached: UsageMeasurementAggregate;
    readonly output: UsageMeasurementAggregate;
    readonly reasoning: UsageMeasurementAggregate;
  };
  readonly cost: UsageMeasurementAggregate;
}

export interface UsageAttemptAggregate {
  readonly projectId: string;
  readonly workflowId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly predecessorAttemptId: string | null;
  readonly relationship: UsageAttemptRelationship;
  readonly lineageStatus: UsageLineageStatus;
  readonly unresolvedPredecessorAttemptId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  /** Canonical events retain individual timing and measurement provenance. */
  readonly events: readonly UsageEvent[];
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  /** A count reported by multiple events is a snapshot, so this is the maximum. */
  readonly retries: number;
  readonly cancelled: boolean;
  readonly fallback: boolean;
  readonly terminal: UsageEvent["terminal"];
  readonly totals: UsageTotals;
}

export interface UsageAggregate {
  readonly ledgerVersion: typeof USAGE_LEDGER_VERSION;
  readonly events: readonly UsageEvent[];
  readonly lineage: readonly UsageAttemptLineage[];
  readonly totals: UsageTotals;
  readonly attempts: readonly UsageAttemptAggregate[];
}

export interface UsageScopeAggregate {
  readonly events: readonly UsageEvent[];
  readonly lineage: readonly UsageAttemptLineage[];
  readonly totals: UsageTotals;
}

export type ProjectUsageAggregate = UsageScopeAggregate & {
  readonly projectId: string;
};

export type WorkflowUsageAggregate = UsageScopeAggregate & {
  readonly projectId: string;
  readonly workflowId: string;
};

export type AgentUsageAggregate = UsageScopeAggregate & {
  readonly projectId: string;
  readonly workflowId: string;
  readonly agentId: string;
};

const eventKey = ({ projectId, workflowId, agentId, attemptId, eventId }: UsageEvent): string =>
  JSON.stringify([projectId, workflowId, agentId, attemptId, eventId]);

const attemptKey = ({
  projectId,
  workflowId,
  agentId,
  attemptId,
}: Pick<UsageEvent, "projectId" | "workflowId" | "agentId" | "attemptId">): string =>
  JSON.stringify([projectId, workflowId, agentId, attemptId]);

const relatedAttemptKey = (event: UsageEvent, attemptId: string): string =>
  JSON.stringify([event.projectId, event.workflowId, event.agentId, attemptId]);

const eventFingerprint = (event: UsageEvent): string =>
  JSON.stringify([
    event.ledgerVersion,
    event.projectId,
    event.workflowId,
    event.eventId,
    event.version,
    event.agentId,
    event.attemptId,
    event.rootAttemptId,
    event.predecessorAttemptId,
    event.relationship,
    event.provider,
    event.model,
    event.role,
    event.startedAtMs,
    event.endedAtMs,
    [event.toolTimeMs.value, event.toolTimeMs.provenance],
    [event.tokens.input.value, event.tokens.input.provenance],
    [event.tokens.cached.value, event.tokens.cached.provenance],
    [event.tokens.output.value, event.tokens.output.provenance],
    [event.tokens.reasoning.value, event.tokens.reasoning.provenance],
    [event.cost.value, event.cost.provenance],
    event.retries,
    event.cancelled,
    event.fallback,
    event.terminal,
  ]);

const compareEvents = (left: UsageEvent, right: UsageEvent): number => {
  for (const [a, b] of [
    [left.projectId, right.projectId],
    [left.workflowId, right.workflowId],
    [left.agentId, right.agentId],
    [left.attemptId, right.attemptId],
    [left.eventId, right.eventId],
  ] as const) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
};

const PROVENANCES: readonly UsageProvenance[] = [
  "measured",
  "provider-reported",
  "estimated",
  "unavailable",
];

const isUsageProvenance = (provenance: unknown): provenance is UsageProvenance =>
  typeof provenance === "string" && PROVENANCES.includes(provenance as UsageProvenance);

const isKnownProvenance = (provenance: unknown): provenance is KnownUsageProvenance =>
  isUsageProvenance(provenance) && provenance !== "unavailable";

type MutableKnownProvenanceContribution = {
  value: number;
  eventCount: number;
};

type MutableUnavailableProvenanceContribution = {
  eventCount: number;
};

type MutableUsageMeasurementAggregate = {
  knownTotal: number;
  byProvenance: {
    measured: MutableKnownProvenanceContribution;
    "provider-reported": MutableKnownProvenanceContribution;
    estimated: MutableKnownProvenanceContribution;
    unavailable: MutableUnavailableProvenanceContribution;
  };
};

type MutableUsageTotals = {
  toolTimeMs: MutableUsageMeasurementAggregate;
  tokens: {
    input: MutableUsageMeasurementAggregate;
    cached: MutableUsageMeasurementAggregate;
    output: MutableUsageMeasurementAggregate;
    reasoning: MutableUsageMeasurementAggregate;
  };
  cost: MutableUsageMeasurementAggregate;
};

type MutableAttemptAggregate = {
  projectId: string;
  workflowId: string;
  agentId: string;
  attemptId: string;
  rootAttemptId: string;
  predecessorAttemptId: string | null;
  relationship: UsageAttemptRelationship;
  lineageStatus: UsageLineageStatus;
  unresolvedPredecessorAttemptId: string | null;
  provider: string;
  model: string;
  role: string;
  events: UsageEvent[];
  startedAtMs: number;
  endedAtMs: number | null;
  hasOpenEvent: boolean;
  retries: number;
  cancelled: boolean;
  fallback: boolean;
  totals: MutableUsageTotals;
  terminal: UsageEvent["terminal"];
};

const emptyMeasurementAggregate = (): MutableUsageMeasurementAggregate => ({
  knownTotal: 0,
  byProvenance: {
    measured: { value: 0, eventCount: 0 },
    "provider-reported": { value: 0, eventCount: 0 },
    estimated: { value: 0, eventCount: 0 },
    unavailable: { eventCount: 0 },
  },
});

const emptyTotals = (): MutableUsageTotals => ({
  toolTimeMs: emptyMeasurementAggregate(),
  tokens: {
    input: emptyMeasurementAggregate(),
    cached: emptyMeasurementAggregate(),
    output: emptyMeasurementAggregate(),
    reasoning: emptyMeasurementAggregate(),
  },
  cost: emptyMeasurementAggregate(),
});

function checkedSum(left: number, right: number, label: string, requireSafeInteger: boolean): number {
  const sum = left + right;
  if (!Number.isFinite(sum) || (requireSafeInteger && !Number.isSafeInteger(sum))) {
    throw new Error(`${label} aggregate overflow.`);
  }
  return sum;
}

function addMeasurement(
  total: MutableUsageMeasurementAggregate,
  measurement: UsageMeasurement,
  label: string,
  requireSafeInteger = false,
): void {
  if (measurement.provenance === "unavailable") {
    total.byProvenance.unavailable.eventCount += 1;
    return;
  }

  const contribution = total.byProvenance[measurement.provenance];
  const value = measurement.value as number;
  contribution.value = checkedSum(contribution.value, value, label, requireSafeInteger);
  contribution.eventCount += 1;
  total.knownTotal = checkedSum(total.knownTotal, value, label, requireSafeInteger);
}

function addEvent(totals: MutableUsageTotals, event: UsageEvent): void {
  addMeasurement(totals.toolTimeMs, event.toolTimeMs, "tool time");
  addMeasurement(totals.tokens.input, event.tokens.input, "input tokens", true);
  addMeasurement(totals.tokens.cached, event.tokens.cached, "cached tokens", true);
  addMeasurement(totals.tokens.output, event.tokens.output, "output tokens", true);
  addMeasurement(totals.tokens.reasoning, event.tokens.reasoning, "reasoning tokens", true);
  addMeasurement(totals.cost, event.cost, "cost");
}

function finishMeasurement(total: MutableUsageMeasurementAggregate): UsageMeasurementAggregate {
  return {
    total: total.byProvenance.unavailable.eventCount === 0 ? total.knownTotal : null,
    knownTotal: total.knownTotal,
    byProvenance: total.byProvenance,
  };
}

function finishTotals(totals: MutableUsageTotals): UsageTotals {
  return {
    toolTimeMs: finishMeasurement(totals.toolTimeMs),
    tokens: {
      input: finishMeasurement(totals.tokens.input),
      cached: finishMeasurement(totals.tokens.cached),
      output: finishMeasurement(totals.tokens.output),
      reasoning: finishMeasurement(totals.tokens.reasoning),
    },
    cost: finishMeasurement(totals.cost),
  };
}

function validateMeasurement(measurement: UsageMeasurement, label: string, requireSafeInteger = false): void {
  if (!measurement || typeof measurement !== "object") {
    throw new Error(`${label} must be a usage measurement.`);
  }

  if (!isUsageProvenance(measurement.provenance)) {
    throw new Error(`${label} has an unrecognized provenance.`);
  }

  if (measurement.provenance === "unavailable") {
    if (measurement.value !== null) throw new Error(`${label} is unavailable and cannot have a value.`);
    return;
  }

  if (
    !isKnownProvenance(measurement.provenance) ||
    typeof measurement.value !== "number" ||
    !Number.isFinite(measurement.value) ||
    Object.is(measurement.value, -0) ||
    measurement.value < 0
  ) {
    throw new Error(`${label} must be a finite, non-negative value.`);
  }
  if (requireSafeInteger && !Number.isSafeInteger(measurement.value)) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function validateEvent(event: UsageEvent): void {
  if (!event || typeof event !== "object") throw new Error("Usage event must be an object.");
  if (event.ledgerVersion !== USAGE_LEDGER_VERSION) {
    throw new Error(`Unsupported usage ledger version ${String(event.ledgerVersion)}.`);
  }

  for (const [label, value] of [
    ["project id", event.projectId],
    ["workflow id", event.workflowId],
    ["event id", event.eventId],
    ["agent id", event.agentId],
    ["attempt id", event.attemptId],
    ["root attempt id", event.rootAttemptId],
    ["provider", event.provider],
    ["model", event.model],
    ["role", event.role],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
  }

  if (
    event.predecessorAttemptId !== null &&
    (typeof event.predecessorAttemptId !== "string" || event.predecessorAttemptId.trim().length === 0)
  ) {
    throw new Error("Predecessor attempt id must be null or a non-empty string.");
  }
  if (event.relationship !== "root" && event.relationship !== "retry" && event.relationship !== "fallback") {
    throw new Error("Attempt relationship is invalid.");
  }
  if (event.relationship === "root") {
    if (event.rootAttemptId !== event.attemptId || event.predecessorAttemptId !== null) {
      throw new Error("A root attempt must identify itself and have no predecessor.");
    }
  } else {
    if (event.predecessorAttemptId === null) {
      throw new Error("A linked attempt requires a predecessor attempt id.");
    }
    if (event.predecessorAttemptId === event.attemptId || event.rootAttemptId === event.attemptId) {
      throw new Error("A linked attempt must be distinct from its predecessor and root attempt.");
    }
  }
  if (event.fallback !== (event.relationship === "fallback")) {
    throw new Error("Fallback flag must match the fallback relationship.");
  }

  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    throw new Error("Event version must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(event.startedAtMs) || event.startedAtMs < 0) {
    throw new Error("Start time must be a non-negative epoch millisecond.");
  }
  if (
    event.endedAtMs !== null &&
    (!Number.isSafeInteger(event.endedAtMs) || event.endedAtMs < event.startedAtMs)
  ) {
    throw new Error("End time must be an epoch millisecond no earlier than the start time.");
  }
  if (!Number.isSafeInteger(event.retries) || event.retries < 0) {
    throw new Error("Retries must be a non-negative safe integer.");
  }
  if (typeof event.cancelled !== "boolean" || typeof event.fallback !== "boolean") {
    throw new Error("Cancelled and fallback must be boolean flags.");
  }
  if (event.terminal !== null && event.terminal !== "completed" && event.terminal !== "failed" && event.terminal !== "cancelled") {
    throw new Error("Terminal state is invalid.");
  }
  if (event.terminal !== null) {
    if (event.endedAtMs === null) throw new Error("A terminal record requires an end time.");
    if ((event.terminal === "cancelled") !== event.cancelled) {
      throw new Error("A terminal record has a conflicting cancelled state.");
    }
  }
  if (event.cancelled && event.terminal !== "cancelled") {
    throw new Error("A cancelled event must have a cancelled terminal state.");
  }
  if (!event.tokens || typeof event.tokens !== "object") throw new Error("Tokens must be a measurement bundle.");
  validateMeasurement(event.toolTimeMs, "tool time");
  validateMeasurement(event.tokens.input, "input tokens", true);
  validateMeasurement(event.tokens.cached, "cached tokens", true);
  validateMeasurement(event.tokens.output, "output tokens", true);
  validateMeasurement(event.tokens.reasoning, "reasoning tokens", true);
  validateMeasurement(event.cost, "cost");
}

function reconcileAttemptLineage(events: readonly UsageEvent[]): readonly UsageAttemptLineage[] {
  const attempts = new Map<string, UsageEvent>();
  for (const event of events) {
    const key = attemptKey(event);
    if (!attempts.has(key)) attempts.set(key, event);
  }

  type Resolution = Pick<UsageAttemptLineage, "status" | "unresolvedPredecessorAttemptId">;
  const resolutions = new Map<string, Resolution>();

  for (const startKey of attempts.keys()) {
    if (resolutions.has(startKey)) continue;

    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    let currentKey = startKey;
    let resolution: Resolution | undefined;

    for (let step = 0; step < attempts.size; step += 1) {
      const cached = resolutions.get(currentKey);
      if (cached) {
        resolution = cached;
        break;
      }

      const current = attempts.get(currentKey) as UsageEvent;
      pathIndexes.set(currentKey, path.length);
      path.push(currentKey);
      if (current.predecessorAttemptId === null) {
        resolution = { status: "resolved", unresolvedPredecessorAttemptId: null };
        break;
      }

      const predecessorKey = relatedAttemptKey(current, current.predecessorAttemptId);
      const predecessor = attempts.get(predecessorKey);
      if (predecessor && predecessor.rootAttemptId !== current.rootAttemptId) {
        throw new Error(
          `Attempt lineage root mismatch in ${current.projectId}/${current.workflowId}/${current.agentId}: ` +
            `${current.attemptId} declares ${current.rootAttemptId}, but predecessor ${predecessor.attemptId} ` +
            `declares ${predecessor.rootAttemptId}.`,
        );
      }

      const cycleStart = pathIndexes.get(predecessorKey);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart).map((cycleKey) => attempts.get(cycleKey) as UsageEvent);
        const firstIndex = cycle.reduce(
          (smallest, candidate, index) =>
            candidate.attemptId < cycle[smallest].attemptId ? index : smallest,
          0,
        );
        const ordered = [...cycle.slice(firstIndex), ...cycle.slice(0, firstIndex)];
        const attemptIds = [...ordered.map(({ attemptId }) => attemptId), ordered[0].attemptId];
        throw new Error(
          `Cyclic attempt lineage in ${current.projectId}/${current.workflowId}/${current.agentId}: ${attemptIds.join(" -> ")}.`,
        );
      }
      if (!predecessor) {
        resolution = {
          status: "unresolved",
          unresolvedPredecessorAttemptId: current.predecessorAttemptId,
        };
        break;
      }
      currentKey = predecessorKey;
    }

    if (resolution === undefined) {
      throw new Error("Attempt lineage traversal exceeded the number of canonical attempts.");
    }
    for (const key of path) resolutions.set(key, resolution);
  }

  return [...attempts.entries()].map(([key, event]) => ({
    projectId: event.projectId,
    workflowId: event.workflowId,
    agentId: event.agentId,
    attemptId: event.attemptId,
    rootAttemptId: event.rootAttemptId,
    predecessorAttemptId: event.predecessorAttemptId,
    relationship: event.relationship,
    ...resolutions.get(key)!,
  }));
}

/**
 * Selects one latest revision per stable event identity. The returned order is
 * independent of arrival order, which makes callers safe to replay a stream.
 */
export function reconcileUsageEvents(events: readonly UsageEvent[]): ReconciledUsageEvents {
  const latest = new Map<string, UsageEvent>();
  const terminalByAttempt = new Map<string, NonNullable<UsageEvent["terminal"]>>();
  const relationshipByAttempt = new Map<string, string>();
  const latestTerminalByEvent = new Map<string, UsageEvent>();

  for (const event of events) {
    validateEvent(event);
    const relationKey = attemptKey(event);
    const relation = JSON.stringify([
      event.rootAttemptId,
      event.predecessorAttemptId,
      event.relationship,
      event.fallback,
      event.provider,
      event.model,
      event.role,
    ]);
    const previousRelation = relationshipByAttempt.get(relationKey);
    if (previousRelation && previousRelation !== relation) {
      throw new Error(`Conflicting attempt relationship for ${event.agentId}/${event.attemptId}.`);
    }
    relationshipByAttempt.set(relationKey, relation);
    if (event.terminal) {
      const previousTerminal = terminalByAttempt.get(relationKey);
      if (previousTerminal && previousTerminal !== event.terminal) {
        throw new Error(`Conflicting terminal records for ${event.agentId}/${event.attemptId}.`);
      }
      terminalByAttempt.set(relationKey, event.terminal);
    }
    const key = eventKey(event);
    if (event.terminal) {
      const previousTerminal = latestTerminalByEvent.get(key);
      if (!previousTerminal || event.version > previousTerminal.version) latestTerminalByEvent.set(key, event);
    }
    const previous = latest.get(key);
    if (previous?.version === event.version) {
      if (eventFingerprint(previous) !== eventFingerprint(event)) {
        throw new Error(`Conflicting revision ${event.version} for ${event.agentId}/${event.attemptId}/${event.eventId}.`);
      }
      continue;
    }
    if (!previous || event.version > previous.version) latest.set(key, event);
  }

  for (const [key, terminal] of latestTerminalByEvent) {
    const canonical = latest.get(key);
    if (canonical && canonical.version > terminal.version && canonical.terminal === null) {
      throw new Error(`A terminal event cannot reopen: ${terminal.agentId}/${terminal.attemptId}/${terminal.eventId}.`);
    }
  }

  const terminalEndByAttempt = new Map<string, number>();
  for (const event of latest.values()) {
    if (event.terminal === null) continue;
    const key = attemptKey(event);
    const terminalEnd = event.endedAtMs as number;
    terminalEndByAttempt.set(key, Math.max(terminalEndByAttempt.get(key) ?? 0, terminalEnd));
  }
  for (const event of latest.values()) {
    const terminalEnd = terminalEndByAttempt.get(attemptKey(event));
    if (
      terminalEnd !== undefined &&
      event.terminal === null &&
      (event.endedAtMs === null || event.startedAtMs > terminalEnd || event.endedAtMs > terminalEnd)
    ) {
      throw new Error(`A terminal attempt cannot reopen: ${event.agentId}/${event.attemptId}.`);
    }
  }

  const canonicalEvents = [...latest.values()].sort(compareEvents);
  const lineage = reconcileAttemptLineage(canonicalEvents);
  return { ledgerVersion: USAGE_LEDGER_VERSION, events: canonicalEvents, lineage };
}

/**
 * Aggregates canonical events only. Revisions never add spend: every event is
 * reconciled before its measurements reach either total.
 */
export function aggregateUsageEvents(events: readonly UsageEvent[]): UsageAggregate {
  const reconciled = reconcileUsageEvents(events);
  const totals = emptyTotals();
  const attempts = new Map<string, MutableAttemptAggregate>();
  const lineageByAttempt = new Map(
    reconciled.lineage.map((lineage) => [
      JSON.stringify([lineage.projectId, lineage.workflowId, lineage.agentId, lineage.attemptId]),
      lineage,
    ]),
  );

  for (const event of reconciled.events) {
    addEvent(totals, event);
    const key = attemptKey(event);
    let attempt = attempts.get(key);
    if (!attempt) {
      const lineage = lineageByAttempt.get(key) as UsageAttemptLineage;
      attempt = {
        projectId: event.projectId,
        workflowId: event.workflowId,
        agentId: event.agentId,
        attemptId: event.attemptId,
        rootAttemptId: event.rootAttemptId,
        predecessorAttemptId: event.predecessorAttemptId,
        relationship: event.relationship,
        lineageStatus: lineage.status,
        unresolvedPredecessorAttemptId: lineage.unresolvedPredecessorAttemptId,
        provider: event.provider,
        model: event.model,
        role: event.role,
        events: [],
        startedAtMs: event.startedAtMs,
        endedAtMs: event.endedAtMs,
        hasOpenEvent: event.endedAtMs === null,
        retries: event.retries,
        cancelled: event.cancelled,
        fallback: event.fallback,
        terminal: event.terminal,
        totals: emptyTotals(),
      };
      attempts.set(key, attempt);
    }

    attempt.events.push(event);
    attempt.startedAtMs = Math.min(attempt.startedAtMs, event.startedAtMs);
    attempt.hasOpenEvent ||= event.endedAtMs === null;
    if (event.endedAtMs !== null && (attempt.endedAtMs === null || event.endedAtMs > attempt.endedAtMs)) {
      attempt.endedAtMs = event.endedAtMs;
    }
    attempt.retries = Math.max(attempt.retries, event.retries);
    attempt.cancelled ||= event.cancelled;
    attempt.fallback ||= event.fallback;
    attempt.terminal ??= event.terminal;
    addEvent(attempt.totals, event);
  }

  const orderedAttempts = [...attempts.values()]
    .sort((left, right) => {
      if (left.projectId < right.projectId) return -1;
      if (left.projectId > right.projectId) return 1;
      if (left.workflowId < right.workflowId) return -1;
      if (left.workflowId > right.workflowId) return 1;
      if (left.agentId < right.agentId) return -1;
      if (left.agentId > right.agentId) return 1;
      if (left.attemptId < right.attemptId) return -1;
      if (left.attemptId > right.attemptId) return 1;
      return 0;
    })
    .map(({ totals: attemptTotals, hasOpenEvent, ...attempt }) => ({
      ...attempt,
      endedAtMs: hasOpenEvent ? null : attempt.endedAtMs,
      totals: finishTotals(attemptTotals),
    }));

  return {
    ledgerVersion: USAGE_LEDGER_VERSION,
    events: reconciled.events,
    lineage: reconciled.lineage,
    totals: finishTotals(totals),
    attempts: orderedAttempts,
  };
}

type MutableScopeAggregate<T> = {
  identity: T;
  events: UsageEvent[];
  totals: MutableUsageTotals;
};

function aggregateByScope<T extends object>(
  events: readonly UsageEvent[],
  identityFor: (event: UsageEvent) => T,
  keyFor: (event: UsageEvent) => string,
): readonly (T & UsageScopeAggregate)[] {
  const reconciled = reconcileUsageEvents(events);
  const groups = new Map<string, MutableScopeAggregate<T>>();

  for (const event of reconciled.events) {
    const key = keyFor(event);
    let group = groups.get(key);
    if (!group) {
      group = { identity: identityFor(event), events: [], totals: emptyTotals() };
      groups.set(key, group);
    }
    group.events.push(event);
    addEvent(group.totals, event);
  }

  return [...groups.values()].map(({ identity, events: canonicalEvents, totals }) => {
    const scopedAttempts = new Set(canonicalEvents.map(attemptKey));
    return {
      ...identity,
      events: canonicalEvents,
      lineage: reconciled.lineage.filter((lineage) => scopedAttempts.has(attemptKey(lineage))),
      totals: finishTotals(totals),
    };
  });
}

export function aggregateUsageByProject(events: readonly UsageEvent[]): readonly ProjectUsageAggregate[] {
  return aggregateByScope(
    events,
    ({ projectId }) => ({ projectId }),
    ({ projectId }) => JSON.stringify([projectId]),
  );
}

export function aggregateUsageByWorkflow(events: readonly UsageEvent[]): readonly WorkflowUsageAggregate[] {
  return aggregateByScope(
    events,
    ({ projectId, workflowId }) => ({ projectId, workflowId }),
    ({ projectId, workflowId }) => JSON.stringify([projectId, workflowId]),
  );
}

export function aggregateUsageByAgent(events: readonly UsageEvent[]): readonly AgentUsageAggregate[] {
  return aggregateByScope(
    events,
    ({ projectId, workflowId, agentId }) => ({ projectId, workflowId, agentId }),
    ({ projectId, workflowId, agentId }) => JSON.stringify([projectId, workflowId, agentId]),
  );
}
