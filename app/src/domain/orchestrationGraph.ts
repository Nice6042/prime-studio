export const GRAPH_SCHEMA_VERSION = 2 as const;

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting-review"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface GraphAgentInput {
  readonly id: string;
  readonly label: string;
  readonly parentAgentId?: string;
}

export interface GraphAgent extends GraphAgentInput {}

export interface GraphTaskInput {
  readonly id: string;
  readonly title: string;
  readonly ownerAgentId: string;
  readonly parentTaskId?: string;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
  readonly reviewRequired?: boolean;
}

export interface GraphTask {
  readonly id: string;
  readonly title: string;
  readonly ownerAgentId: string;
  readonly parentTaskId?: string;
  readonly dependsOn: readonly string[];
  readonly priority: number;
  readonly reviewRequired: boolean;
  readonly status: TaskStatus;
}

export interface GraphInput {
  readonly maxParallelism: number;
  readonly agents: readonly GraphAgentInput[];
  readonly tasks: readonly GraphTaskInput[];
}

export type AttemptKind = "work" | "retry" | "fallback" | "review";

export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface GraphAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly kind: AttemptKind;
  readonly generation: number;
  readonly status: AttemptStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly previousAttemptId?: string;
  readonly supersedesAttemptId?: string;
  readonly reviewsAttemptId?: string;
}

export interface WorkStartedEvent {
  readonly type: "work.started";
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly at: number;
}

export interface WorkCompletedEvent {
  readonly type: "work.completed";
  readonly attemptId: string;
  readonly outcome: "succeeded" | "failed";
  readonly at: number;
}

export interface HandoffRecordedEvent {
  readonly type: "handoff.recorded";
  readonly taskId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly at: number;
  readonly message: string;
}

export interface TaskCancelledEvent {
  readonly type: "task.cancelled";
  readonly taskId: string;
  readonly at: number;
  readonly reason: string;
}

export interface ReviewStartedEvent {
  readonly type: "review.started";
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly reviewsAttemptId: string;
  readonly at: number;
}

export interface ReviewCompletedEvent {
  readonly type: "review.completed";
  readonly attemptId: string;
  readonly approved: boolean;
  readonly at: number;
}

export interface RetryStartedEvent {
  readonly type: "retry.started";
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly retryOfAttemptId: string;
  readonly at: number;
}

export interface FallbackStartedEvent {
  readonly type: "fallback.started";
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly fallbackOfAttemptId: string;
  readonly reason: string;
  readonly at: number;
}

export type GraphEvent =
  | WorkStartedEvent
  | WorkCompletedEvent
  | HandoffRecordedEvent
  | TaskCancelledEvent
  | ReviewStartedEvent
  | ReviewCompletedEvent
  | RetryStartedEvent
  | FallbackStartedEvent;

export type RecordedGraphEvent = GraphEvent | (TaskCancelledEvent & { readonly affectedTaskIds: readonly string[] });

export interface GraphRecord {
  readonly sequence: number;
  readonly event: RecordedGraphEvent;
}

export interface GraphState {
  readonly schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  readonly maxParallelism: number;
  readonly agents: readonly GraphAgent[];
  readonly tasks: readonly GraphTask[];
  readonly attempts: readonly GraphAttempt[];
  readonly records: readonly GraphRecord[];
}

interface LegacyV1GraphAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly kind: AttemptKind;
  readonly status: AttemptStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly previousAttemptId?: string;
  readonly reviewsAttemptId?: string;
}

interface LegacyV1GraphState {
  readonly maxParallelism: number;
  readonly agents: readonly GraphAgent[];
  readonly tasks: readonly GraphTask[];
  readonly attempts: readonly LegacyV1GraphAttempt[];
  readonly records: readonly GraphRecord[];
}

export interface SingleAgentGraphInput {
  readonly agent: GraphAgentInput;
  readonly task: GraphTaskInput;
  readonly maxParallelism?: number;
}

export interface LeadSpecialistsGraphInput {
  readonly lead: GraphAgentInput;
  readonly specialists: readonly GraphAgentInput[];
  readonly tasks: readonly GraphTaskInput[];
  readonly maxParallelism?: number;
}

export class GraphValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "GraphValidationError";
  }
}

export class GraphTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphTransitionError";
  }
}

export function createSingleAgentGraph(input: SingleAgentGraphInput): GraphState {
  return createExplicitDag({
    maxParallelism: input.maxParallelism ?? 1,
    agents: [copyAgent(input.agent)],
    tasks: [input.task],
  });
}

export function createLeadSpecialistsGraph(input: LeadSpecialistsGraphInput): GraphState {
  const lead = copyAgentWithoutParent(input.lead);
  const specialists = input.specialists.map((specialist) => ({
    ...copyAgentWithoutParent(specialist),
    parentAgentId: lead.id,
  }));

  return createExplicitDag({
    maxParallelism: input.maxParallelism ?? Math.max(1, specialists.length),
    agents: [lead, ...specialists],
    tasks: input.tasks,
  });
}

export function createExplicitDag(input: GraphInput): GraphState {
  const graph: GraphState = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    maxParallelism: input.maxParallelism,
    agents: input.agents.map(copyAgent),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      ownerAgentId: task.ownerAgentId,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      dependsOn: [...(task.dependsOn ?? [])],
      priority: task.priority ?? 0,
      reviewRequired: task.reviewRequired ?? false,
      status: "pending",
    })),
    attempts: [],
    records: [],
  };

  assertValidGraph(graph);
  return graph;
}

export function validateGraph(graph: GraphState): readonly string[] {
  const issues: string[] = [];
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    issues.push(`unsupported graph schema version "${String(graph.schemaVersion)}"`);
  }
  validatePositiveInteger(graph.maxParallelism, "maxParallelism", issues);
  validateUniqueIds(graph.agents, "agent", issues);
  validateUniqueIds(graph.tasks, "task", issues);

  const agentIds = new Set(graph.agents.map((agent) => agent.id));
  const taskIds = new Set(graph.tasks.map((task) => task.id));

  for (const agent of graph.agents) {
    validateNonEmpty(agent.id, "agent id", issues);
    validateNonEmpty(agent.label, `agent "${agent.id}" label`, issues);
    if (agent.parentAgentId !== undefined) {
      if (agent.parentAgentId === agent.id) {
        issues.push(`agent "${agent.id}" cannot parent itself`);
      } else if (!agentIds.has(agent.parentAgentId)) {
        issues.push(`agent "${agent.id}" references missing parent agent "${agent.parentAgentId}"`);
      }
    }
  }

  for (const task of graph.tasks) {
    validateNonEmpty(task.id, "task id", issues);
    validateNonEmpty(task.title, `task "${task.id}" title`, issues);
    if (!agentIds.has(task.ownerAgentId)) {
      issues.push(`task "${task.id}" references missing owner agent "${task.ownerAgentId}"`);
    }
    if (task.parentTaskId !== undefined) {
      if (task.parentTaskId === task.id) {
        issues.push(`task "${task.id}" cannot parent itself`);
      } else if (!taskIds.has(task.parentTaskId)) {
        issues.push(`task "${task.id}" references missing parent task "${task.parentTaskId}"`);
      }
    }
    validateFiniteNumber(task.priority, `task "${task.id}" priority`, issues);

    const dependencyIds = new Set<string>();
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        issues.push(`task "${task.id}" cannot depend on itself`);
      } else if (!taskIds.has(dependencyId)) {
        issues.push(`task "${task.id}" references missing dependency "${dependencyId}"`);
      }
      if (dependencyIds.has(dependencyId)) {
        issues.push(`task "${task.id}" lists dependency "${dependencyId}" more than once`);
      }
      dependencyIds.add(dependencyId);
    }
  }

  validateParentCycles(graph.agents, (agent) => agent.id, (agent) => agent.parentAgentId, "agent", issues);
  validateParentCycles(graph.tasks, (task) => task.id, (task) => task.parentTaskId, "task", issues);
  validateDependencyCycles(graph.tasks, issues);
  validateAttempts(graph, agentIds, taskIds, issues);
  validateRecords(graph, issues);

  return issues;
}

export function assertValidGraph(graph: GraphState): void {
  const issues = validateGraph(graph);
  if (issues.length > 0) {
    throw new GraphValidationError(issues);
  }
}

export function serializeGraph(graph: GraphState): string {
  assertValidGraph(graph);
  const serialized = JSON.stringify(canonicalizeJsonValue(graph));
  if (serialized === undefined) {
    throw new GraphValidationError(["graph state is not JSON serializable"]);
  }
  return serialized;
}

export function restoreGraph(snapshot: string): GraphState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    throw new GraphValidationError(["graph snapshot is not valid JSON"]);
  }

  const source = parseObject(parsed, "graph snapshot");
  const schemaVersion = parseFiniteNumber(readRequired(source, "schemaVersion", "graph snapshot"), "schemaVersion");
  const graph = schemaVersion === 1 ? migrateLegacyV1Graph(source) : parseGraphState(source);
  assertValidGraph(graph);
  return graph;
}

export function childTasks(graph: GraphState, parentTaskId: string): readonly GraphTask[] {
  return graph.tasks.filter((task) => task.parentTaskId === parentTaskId).sort(compareTaskIds);
}

export function readyTasks(graph: GraphState): readonly GraphTask[] {
  const tasksById = new Map(graph.tasks.map((task) => [task.id, task]));

  return graph.tasks
    .filter((task) => task.status === "pending")
    .filter((task) => dependenciesSucceeded(task, tasksById))
    .filter((task) => parentAllowsWork(task, tasksById))
    .sort(compareTasksForDispatch);
}

export function dispatchableTasks(graph: GraphState): readonly GraphTask[] {
  const capacity = Math.max(0, graph.maxParallelism - activeAttemptCount(graph));
  return readyTasks(graph).slice(0, capacity);
}

export function applyEvent(graph: GraphState, event: GraphEvent): GraphState {
  assertValidGraph(graph);
  assertFiniteTimestamp(event.at);

  switch (event.type) {
    case "work.started":
      return startWork(graph, event);
    case "work.completed":
      return completeWork(graph, event);
    case "handoff.recorded":
      return recordHandoff(graph, event);
    case "task.cancelled":
      return cancelTaskTree(graph, event);
    case "review.started":
      return startReview(graph, event);
    case "review.completed":
      return completeReview(graph, event);
    case "retry.started":
      return startRetry(graph, event);
    case "fallback.started":
      return startFallback(graph, event);
  }
}

function startWork(graph: GraphState, event: WorkStartedEvent): GraphState {
  const task = taskById(graph, event.taskId);
  assertAgentExists(graph, event.agentId);
  if (task.ownerAgentId !== event.agentId) {
    throw new GraphTransitionError(`agent "${event.agentId}" does not own task "${task.id}"`);
  }
  if (task.status !== "pending") {
    throw new GraphTransitionError(`task "${task.id}" is not pending`);
  }
  if (!readyTasks(graph).some((candidate) => candidate.id === task.id)) {
    throw new GraphTransitionError(`task "${task.id}" is not ready`);
  }
  if (activeAttemptCount(graph) >= graph.maxParallelism) {
    throw new GraphTransitionError("parallelism limit reached");
  }
  if (graph.attempts.some((attempt) => attempt.id === event.attemptId)) {
    throw new GraphTransitionError(`attempt "${event.attemptId}" already exists`);
  }

  return startWorkAttempt(graph, event, "work");
}

function completeWork(graph: GraphState, event: WorkCompletedEvent): GraphState {
  const attempt = attemptById(graph, event.attemptId);
  if (attempt.status !== "running" || attempt.kind === "review") {
    throw new GraphTransitionError(`attempt "${attempt.id}" cannot complete as work`);
  }
  const task = taskById(graph, attempt.taskId);
  const nextTaskStatus: TaskStatus =
    event.outcome === "failed" ? "failed" : task.reviewRequired ? "awaiting-review" : "succeeded";

  return appendRecord(
    {
      ...graph,
      tasks: graph.tasks.map((candidate) =>
        candidate.id === task.id ? { ...candidate, status: nextTaskStatus } : candidate,
      ),
      attempts: graph.attempts.map((candidate) =>
        candidate.id === attempt.id
          ? { ...candidate, status: event.outcome, completedAt: event.at }
          : candidate,
      ),
    },
    { ...event },
  );
}

function recordHandoff(graph: GraphState, event: HandoffRecordedEvent): GraphState {
  const task = taskById(graph, event.taskId);
  assertAgentExists(graph, event.fromAgentId);
  assertAgentExists(graph, event.toAgentId);
  if (task.status !== "pending") {
    throw new GraphTransitionError(`task "${task.id}" cannot be handed off after it starts`);
  }
  if (task.ownerAgentId !== event.fromAgentId) {
    throw new GraphTransitionError(`agent "${event.fromAgentId}" does not own task "${task.id}"`);
  }
  if (event.message.trim().length === 0) {
    throw new GraphTransitionError("handoff message must not be empty");
  }

  return appendRecord(
    {
      ...graph,
      tasks: graph.tasks.map((candidate) =>
        candidate.id === task.id ? { ...candidate, ownerAgentId: event.toAgentId } : candidate,
      ),
    },
    { ...event },
  );
}

function startReview(graph: GraphState, event: ReviewStartedEvent): GraphState {
  const task = taskById(graph, event.taskId);
  const reviewedAttempt = attemptById(graph, event.reviewsAttemptId);
  const currentAttempt = currentWorkAttempt(graph, task.id);
  assertAgentExists(graph, event.agentId);
  assertUnusedAttemptId(graph, event.attemptId);
  assertParallelismAvailable(graph);
  if (!task.reviewRequired || task.status !== "awaiting-review") {
    throw new GraphTransitionError(`task "${task.id}" is not awaiting review`);
  }
  if (reviewedAttempt.taskId !== task.id || reviewedAttempt.kind === "review" || reviewedAttempt.status !== "succeeded") {
    throw new GraphTransitionError(`review must reference a succeeded work attempt on task "${task.id}"`);
  }
  if (currentAttempt?.id !== reviewedAttempt.id) {
    throw new GraphTransitionError(`review must reference the current work attempt on task "${task.id}"`);
  }
  if (reviewedAttempt.agentId === event.agentId) {
    throw new GraphTransitionError("review must be performed by a different agent");
  }
  if (graph.attempts.some((attempt) => attempt.taskId === task.id && attempt.kind === "review" && attempt.status === "running")) {
    throw new GraphTransitionError(`task "${task.id}" already has a running review`);
  }

  return appendRecord(
    {
      ...graph,
      attempts: [
        ...graph.attempts,
        {
          id: event.attemptId,
          taskId: task.id,
          agentId: event.agentId,
          kind: "review",
          generation: reviewedAttempt.generation,
          status: "running",
          startedAt: event.at,
          reviewsAttemptId: reviewedAttempt.id,
        },
      ],
    },
    { ...event },
  );
}

function currentWorkAttempt(graph: GraphState, taskId: string): GraphAttempt | undefined {
  const workAttempts = graph.attempts.filter((attempt) => attempt.taskId === taskId && attempt.kind !== "review");
  const supersededAttemptIds = new Set(
    workAttempts.flatMap((attempt) =>
      attempt.supersedesAttemptId === undefined ? [] : [attempt.supersedesAttemptId],
    ),
  );
  return workAttempts.find((attempt) => !supersededAttemptIds.has(attempt.id));
}

function completeReview(graph: GraphState, event: ReviewCompletedEvent): GraphState {
  const attempt = attemptById(graph, event.attemptId);
  if (attempt.kind !== "review" || attempt.status !== "running") {
    throw new GraphTransitionError(`attempt "${attempt.id}" cannot complete as a review`);
  }
  const task = taskById(graph, attempt.taskId);
  if (task.status !== "awaiting-review") {
    throw new GraphTransitionError(`task "${task.id}" is not awaiting review`);
  }

  return appendRecord(
    {
      ...graph,
      tasks: graph.tasks.map((candidate) =>
        candidate.id === task.id ? { ...candidate, status: event.approved ? "succeeded" : "failed" } : candidate,
      ),
      attempts: graph.attempts.map((candidate) =>
        candidate.id === attempt.id
          ? { ...candidate, status: event.approved ? "succeeded" : "failed", completedAt: event.at }
          : candidate,
      ),
    },
    { ...event },
  );
}

function startRetry(graph: GraphState, event: RetryStartedEvent): GraphState {
  const task = taskById(graph, event.taskId);
  assertAgentExists(graph, event.agentId);
  assertUnusedAttemptId(graph, event.attemptId);
  const failedAttempt = assertFailedAttemptForTask(graph, task.id, event.retryOfAttemptId);
  const supersededAttempt = assertFailureIsOnCurrentWork(graph, task.id, failedAttempt);
  assertFailedTaskCanRestart(graph, task, event.agentId);

  return startWorkAttempt(graph, event, "retry", event.retryOfAttemptId, supersededAttempt);
}

function startFallback(graph: GraphState, event: FallbackStartedEvent): GraphState {
  const task = taskById(graph, event.taskId);
  assertAgentExists(graph, event.agentId);
  assertUnusedAttemptId(graph, event.attemptId);
  const failedAttempt = assertFailedAttemptForTask(graph, task.id, event.fallbackOfAttemptId);
  const supersededAttempt = assertFailureIsOnCurrentWork(graph, task.id, failedAttempt);
  if (event.reason.trim().length === 0) {
    throw new GraphTransitionError("fallback reason must not be empty");
  }
  assertFailedTaskCanRestart(graph, task);

  return startWorkAttempt(graph, event, "fallback", event.fallbackOfAttemptId, supersededAttempt);
}

function startWorkAttempt(
  graph: GraphState,
  event: WorkStartedEvent | RetryStartedEvent | FallbackStartedEvent,
  kind: Exclude<AttemptKind, "review">,
  previousAttemptId?: string,
  supersededAttempt?: GraphAttempt,
): GraphState {
  assertParallelismAvailable(graph);
  const attempt: GraphAttempt = {
    id: event.attemptId,
    taskId: event.taskId,
    agentId: event.agentId,
    kind,
    generation: supersededAttempt === undefined ? 1 : supersededAttempt.generation + 1,
    status: "running",
    startedAt: event.at,
    ...(previousAttemptId === undefined ? {} : { previousAttemptId }),
    ...(supersededAttempt === undefined ? {} : { supersedesAttemptId: supersededAttempt.id }),
  };

  return appendRecord(
    {
      ...graph,
      tasks: graph.tasks.map((candidate) =>
        candidate.id === event.taskId ? { ...candidate, status: "running" } : candidate,
      ),
      attempts: [...graph.attempts, attempt],
    },
    { ...event },
  );
}

function assertFailedTaskCanRestart(graph: GraphState, task: GraphTask, requiredAgentId?: string): void {
  if (task.status !== "failed") {
    throw new GraphTransitionError(`task "${task.id}" does not have a failed attempt to restart`);
  }
  if (requiredAgentId !== undefined && task.ownerAgentId !== requiredAgentId) {
    throw new GraphTransitionError(`agent "${requiredAgentId}" does not own task "${task.id}"`);
  }
  const tasksById = new Map(graph.tasks.map((candidate) => [candidate.id, candidate]));
  if (!dependenciesSucceeded(task, tasksById) || !parentAllowsWork(task, tasksById)) {
    throw new GraphTransitionError(`task "${task.id}" is not ready to restart`);
  }
}

function assertFailedAttemptForTask(graph: GraphState, taskId: string, attemptId: string): GraphAttempt {
  const attempt = graph.attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined || attempt.taskId !== taskId || attempt.status !== "failed") {
    throw new GraphTransitionError(`attempt "${attemptId}" must be a failed attempt on task "${taskId}"`);
  }
  return attempt;
}

function assertFailureIsOnCurrentWork(
  graph: GraphState,
  taskId: string,
  failedAttempt: GraphAttempt,
): GraphAttempt {
  const failedWorkAttempt =
    failedAttempt.kind === "review"
      ? failedAttempt.reviewsAttemptId === undefined
        ? undefined
        : graph.attempts.find((attempt) => attempt.id === failedAttempt.reviewsAttemptId)
      : failedAttempt;
  const currentAttempt = currentWorkAttempt(graph, taskId);
  if (failedWorkAttempt === undefined || currentAttempt?.id !== failedWorkAttempt.id) {
    throw new GraphTransitionError(`failed attempt must belong to the current work attempt on task "${taskId}"`);
  }
  return failedWorkAttempt;
}

function assertUnusedAttemptId(graph: GraphState, attemptId: string): void {
  if (graph.attempts.some((attempt) => attempt.id === attemptId)) {
    throw new GraphTransitionError(`attempt "${attemptId}" already exists`);
  }
}

function assertParallelismAvailable(graph: GraphState): void {
  if (activeAttemptCount(graph) >= graph.maxParallelism) {
    throw new GraphTransitionError("parallelism limit reached");
  }
}

function cancelTaskTree(graph: GraphState, event: TaskCancelledEvent): GraphState {
  taskById(graph, event.taskId);
  const affectedTaskIds = cancellationTaskIds(graph, event.taskId);
  const affected = new Set(affectedTaskIds);

  return appendRecord(
    {
      ...graph,
      tasks: graph.tasks.map((task) =>
        affected.has(task.id) && task.status !== "succeeded" ? { ...task, status: "cancelled" } : task,
      ),
      attempts: graph.attempts.map((attempt) =>
        affected.has(attempt.taskId) && attempt.status === "running"
          ? { ...attempt, status: "cancelled", completedAt: event.at }
          : attempt,
      ),
    },
    { ...event, affectedTaskIds },
  );
}

function appendRecord(graph: GraphState, event: RecordedGraphEvent): GraphState {
  return {
    ...graph,
    records: [...graph.records, { sequence: graph.records.length + 1, event: canonicalEvent(event) }],
  };
}

function canonicalEvent(event: RecordedGraphEvent): RecordedGraphEvent {
  switch (event.type) {
    case "work.started":
      return {
        type: event.type,
        taskId: event.taskId,
        attemptId: event.attemptId,
        agentId: event.agentId,
        at: event.at,
      };
    case "work.completed":
      return { type: event.type, attemptId: event.attemptId, outcome: event.outcome, at: event.at };
    case "handoff.recorded":
      return {
        type: event.type,
        taskId: event.taskId,
        fromAgentId: event.fromAgentId,
        toAgentId: event.toAgentId,
        at: event.at,
        message: event.message,
      };
    case "task.cancelled": {
      const cancellation: TaskCancelledEvent = {
        type: event.type,
        taskId: event.taskId,
        at: event.at,
        reason: event.reason,
      };
      return hasAffectedTaskIds(event)
        ? { ...cancellation, affectedTaskIds: [...event.affectedTaskIds] }
        : cancellation;
    }
    case "review.started":
      return {
        type: event.type,
        taskId: event.taskId,
        attemptId: event.attemptId,
        agentId: event.agentId,
        reviewsAttemptId: event.reviewsAttemptId,
        at: event.at,
      };
    case "review.completed":
      return { type: event.type, attemptId: event.attemptId, approved: event.approved, at: event.at };
    case "retry.started":
      return {
        type: event.type,
        taskId: event.taskId,
        attemptId: event.attemptId,
        agentId: event.agentId,
        retryOfAttemptId: event.retryOfAttemptId,
        at: event.at,
      };
    case "fallback.started":
      return {
        type: event.type,
        taskId: event.taskId,
        attemptId: event.attemptId,
        agentId: event.agentId,
        fallbackOfAttemptId: event.fallbackOfAttemptId,
        reason: event.reason,
        at: event.at,
      };
  }
}

function dependenciesSucceeded(task: GraphTask, tasksById: ReadonlyMap<string, GraphTask>): boolean {
  return task.dependsOn.every((dependencyId) => tasksById.get(dependencyId)?.status === "succeeded");
}

function parentAllowsWork(task: GraphTask, tasksById: ReadonlyMap<string, GraphTask>): boolean {
  if (task.parentTaskId === undefined) {
    return true;
  }
  const parent = tasksById.get(task.parentTaskId);
  return parent?.status !== "cancelled" && parent?.status !== "failed";
}

function activeAttemptCount(graph: GraphState): number {
  return graph.attempts.filter((attempt) => attempt.status === "running").length;
}

function cancellationTaskIds(graph: GraphState, rootTaskId: string): readonly string[] {
  const found = new Set<string>([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of graph.tasks) {
      if (
        !found.has(task.id) &&
        ((task.parentTaskId !== undefined && found.has(task.parentTaskId)) ||
          task.dependsOn.some((dependencyId) => found.has(dependencyId)))
      ) {
        found.add(task.id);
        changed = true;
      }
    }
  }

  return [...found].sort();
}

function taskById(graph: GraphState, taskId: string): GraphTask {
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new GraphTransitionError(`unknown task "${taskId}"`);
  }
  return task;
}

function attemptById(graph: GraphState, attemptId: string): GraphAttempt {
  const attempt = graph.attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined) {
    throw new GraphTransitionError(`unknown attempt "${attemptId}"`);
  }
  return attempt;
}

function assertAgentExists(graph: GraphState, agentId: string): void {
  if (!graph.agents.some((agent) => agent.id === agentId)) {
    throw new GraphTransitionError(`unknown agent "${agentId}"`);
  }
}

function assertFiniteTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp)) {
    throw new GraphTransitionError("event timestamp must be finite");
  }
}

function compareTaskIds(left: GraphTask, right: GraphTask): number {
  return left.id.localeCompare(right.id);
}

function compareTasksForDispatch(left: GraphTask, right: GraphTask): number {
  return right.priority - left.priority || compareTaskIds(left, right);
}

type JsonObject = Record<string, unknown>;

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const canonical = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalizeJsonValue((value as JsonObject)[key]);
  }
  return canonical;
}

function migrateLegacyV1Graph(source: JsonObject): GraphState {
  const legacy: LegacyV1GraphState = {
    maxParallelism: parseFiniteNumber(readRequired(source, "maxParallelism", "graph snapshot"), "maxParallelism"),
    agents: parseArray(readRequired(source, "agents", "graph snapshot"), "agents").map(parseGraphAgent),
    tasks: parseArray(readRequired(source, "tasks", "graph snapshot"), "tasks").map(parseGraphTask),
    attempts: parseArray(readRequired(source, "attempts", "graph snapshot"), "attempts").map(parseLegacyV1Attempt),
    records: parseArray(readRequired(source, "records", "graph snapshot"), "records").map(parseGraphRecord),
  };
  const legacyAttemptsById = new Map<string, LegacyV1GraphAttempt>();
  for (const attempt of legacy.attempts) {
    if (legacyAttemptsById.has(attempt.id)) {
      throw legacyV1MigrationError(`duplicate attempt id "${attempt.id}"`);
    }
    legacyAttemptsById.set(attempt.id, attempt);
  }
  for (const [index, record] of legacy.records.entries()) {
    if (!Number.isInteger(record.sequence) || record.sequence !== index + 1) {
      throw legacyV1MigrationError(`record at index ${index} must have sequence ${index + 1}`);
    }
  }

  const migratedAttempts: GraphAttempt[] = [];
  const migratedAttemptsById = new Map<string, GraphAttempt>();
  const replayStatuses = new Map<string, AttemptStatus>();
  const replayCompletedAt = new Map<string, number>();
  const currentWorkByTask = new Map<string, GraphAttempt>();

  const legacyAttemptForStart = (
    attemptId: string,
    taskId: string,
    agentId: string,
    expectedKind: AttemptKind,
    startedAt: number,
  ): LegacyV1GraphAttempt => {
    const attempt = legacyAttemptsById.get(attemptId);
    if (attempt === undefined) {
      throw legacyV1MigrationError(`start record references missing attempt "${attemptId}"`);
    }
    if (migratedAttemptsById.has(attemptId)) {
      throw legacyV1MigrationError(`attempt "${attemptId}" starts more than once`);
    }
    if (
      attempt.taskId !== taskId ||
      attempt.agentId !== agentId ||
      attempt.kind !== expectedKind ||
      attempt.startedAt !== startedAt
    ) {
      throw legacyV1MigrationError(`start record does not match attempt "${attemptId}"`);
    }
    return attempt;
  };

  const storeStartedAttempt = (
    legacyAttempt: LegacyV1GraphAttempt,
    generation: number,
    supersededAttempt?: GraphAttempt,
  ): GraphAttempt => {
    const migrated: GraphAttempt = {
      ...legacyAttempt,
      generation,
      ...(supersededAttempt === undefined ? {} : { supersedesAttemptId: supersededAttempt.id }),
    };
    migratedAttempts.push(migrated);
    migratedAttemptsById.set(migrated.id, migrated);
    replayStatuses.set(migrated.id, "running");
    return migrated;
  };

  const completeAttempt = (
    attemptId: string,
    expectedKind: "work" | "review",
    status: "succeeded" | "failed",
    completedAt: number,
  ): void => {
    const attempt = migratedAttemptsById.get(attemptId);
    const kindMatches = expectedKind === "review" ? attempt?.kind === "review" : attempt?.kind !== "review";
    if (attempt === undefined || !kindMatches || replayStatuses.get(attemptId) !== "running") {
      throw legacyV1MigrationError(`${expectedKind} completion precedes a matching active start for "${attemptId}"`);
    }
    replayStatuses.set(attemptId, status);
    replayCompletedAt.set(attemptId, completedAt);
  };

  for (const record of legacy.records) {
    const event = record.event;
    switch (event.type) {
      case "work.started": {
        const legacyAttempt = legacyAttemptForStart(
          event.attemptId,
          event.taskId,
          event.agentId,
          "work",
          event.at,
        );
        if (currentWorkByTask.has(event.taskId)) {
          throw legacyV1MigrationError(`task "${event.taskId}" starts more than one initial work chain`);
        }
        const migrated = storeStartedAttempt(legacyAttempt, 1);
        currentWorkByTask.set(event.taskId, migrated);
        break;
      }
      case "review.started": {
        const legacyAttempt = legacyAttemptForStart(
          event.attemptId,
          event.taskId,
          event.agentId,
          "review",
          event.at,
        );
        const reviewed = migratedAttemptsById.get(event.reviewsAttemptId);
        if (
          reviewed === undefined ||
          reviewed.kind === "review" ||
          reviewed.taskId !== event.taskId ||
          legacyAttempt.reviewsAttemptId !== reviewed.id ||
          replayStatuses.get(reviewed.id) !== "succeeded" ||
          currentWorkByTask.get(event.taskId)?.id !== reviewed.id
        ) {
          throw legacyV1MigrationError(`review "${event.attemptId}" does not bind to current succeeded work`);
        }
        storeStartedAttempt(legacyAttempt, reviewed.generation);
        break;
      }
      case "retry.started":
      case "fallback.started": {
        const isRetry = event.type === "retry.started";
        const failureAttemptId = isRetry ? event.retryOfAttemptId : event.fallbackOfAttemptId;
        const expectedKind: AttemptKind = isRetry ? "retry" : "fallback";
        const legacyAttempt = legacyAttemptForStart(
          event.attemptId,
          event.taskId,
          event.agentId,
          expectedKind,
          event.at,
        );
        const failure = migratedAttemptsById.get(failureAttemptId);
        const predecessor =
          failure?.kind === "review"
            ? failure.reviewsAttemptId === undefined
              ? undefined
              : migratedAttemptsById.get(failure.reviewsAttemptId)
            : failure;
        const current = currentWorkByTask.get(event.taskId);
        if (
          legacyAttempt.previousAttemptId !== failureAttemptId ||
          failure === undefined ||
          replayStatuses.get(failure.id) !== "failed" ||
          predecessor === undefined ||
          predecessor.kind === "review" ||
          predecessor.taskId !== event.taskId ||
          current?.id !== predecessor.id
        ) {
          throw legacyV1MigrationError(`${expectedKind} "${event.attemptId}" lacks a causal current predecessor`);
        }
        const migrated = storeStartedAttempt(legacyAttempt, predecessor.generation + 1, predecessor);
        currentWorkByTask.set(event.taskId, migrated);
        break;
      }
      case "work.completed":
        completeAttempt(event.attemptId, "work", event.outcome, event.at);
        break;
      case "review.completed":
        completeAttempt(event.attemptId, "review", event.approved ? "succeeded" : "failed", event.at);
        break;
      case "task.cancelled":
        if (hasAffectedTaskIds(event)) {
          const affected = new Set(event.affectedTaskIds);
          for (const attempt of migratedAttempts) {
            if (affected.has(attempt.taskId) && replayStatuses.get(attempt.id) === "running") {
              replayStatuses.set(attempt.id, "cancelled");
              replayCompletedAt.set(attempt.id, event.at);
            }
          }
        }
        break;
      case "handoff.recorded":
        break;
    }
  }

  if (migratedAttempts.length !== legacy.attempts.length) {
    throw legacyV1MigrationError("every attempt must have exactly one start record");
  }
  for (const [index, legacyAttempt] of legacy.attempts.entries()) {
    const migrated = migratedAttempts[index];
    if (migrated?.id !== legacyAttempt.id) {
      throw legacyV1MigrationError(`attempt order does not match start records at index ${index}`);
    }
    if (
      replayStatuses.get(legacyAttempt.id) !== legacyAttempt.status ||
      replayCompletedAt.get(legacyAttempt.id) !== legacyAttempt.completedAt
    ) {
      throw legacyV1MigrationError(`attempt "${legacyAttempt.id}" final state does not match its records`);
    }
  }

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    maxParallelism: legacy.maxParallelism,
    agents: legacy.agents,
    tasks: legacy.tasks,
    attempts: migratedAttempts,
    records: legacy.records,
  };
}

function parseLegacyV1Attempt(value: unknown): LegacyV1GraphAttempt {
  const source = parseObject(value, "legacy v1 attempt");
  if (hasOwn(source, "generation") || hasOwn(source, "supersedesAttemptId")) {
    throw legacyV1MigrationError("v1 attempts cannot contain v2 causal fields");
  }
  const attempt = {
    id: parseString(readRequired(source, "id", "legacy v1 attempt"), "attempt id"),
    taskId: parseString(readRequired(source, "taskId", "legacy v1 attempt"), "attempt taskId"),
    agentId: parseString(readRequired(source, "agentId", "legacy v1 attempt"), "attempt agentId"),
    kind: parseAttemptKind(readRequired(source, "kind", "legacy v1 attempt")),
    status: parseAttemptStatus(readRequired(source, "status", "legacy v1 attempt")),
    startedAt: parseFiniteNumber(readRequired(source, "startedAt", "legacy v1 attempt"), "attempt startedAt"),
  };
  const completedAt = parseOptionalFiniteNumber(source, "completedAt", "legacy v1 attempt");
  const previousAttemptId = parseOptionalString(source, "previousAttemptId", "legacy v1 attempt");
  const reviewsAttemptId = parseOptionalString(source, "reviewsAttemptId", "legacy v1 attempt");
  return {
    ...attempt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(previousAttemptId === undefined ? {} : { previousAttemptId }),
    ...(reviewsAttemptId === undefined ? {} : { reviewsAttemptId }),
  };
}

function legacyV1MigrationError(message: string): GraphValidationError {
  return new GraphValidationError([`legacy v1 migration: ${message}`]);
}

function parseGraphState(value: unknown): GraphState {
  const source = parseObject(value, "graph snapshot");
  const schemaVersion = parseFiniteNumber(readRequired(source, "schemaVersion", "graph snapshot"), "schemaVersion");
  if (schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new GraphValidationError([`unsupported graph schema version "${String(schemaVersion)}"`]);
  }

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    maxParallelism: parseFiniteNumber(readRequired(source, "maxParallelism", "graph snapshot"), "maxParallelism"),
    agents: parseArray(readRequired(source, "agents", "graph snapshot"), "agents").map(parseGraphAgent),
    tasks: parseArray(readRequired(source, "tasks", "graph snapshot"), "tasks").map(parseGraphTask),
    attempts: parseArray(readRequired(source, "attempts", "graph snapshot"), "attempts").map(parseGraphAttempt),
    records: parseArray(readRequired(source, "records", "graph snapshot"), "records").map(parseGraphRecord),
  };
}

function parseGraphAgent(value: unknown): GraphAgent {
  const source = parseObject(value, "agent");
  const agent = {
    id: parseString(readRequired(source, "id", "agent"), "agent id"),
    label: parseString(readRequired(source, "label", "agent"), "agent label"),
  };
  const parentAgentId = parseOptionalString(source, "parentAgentId", "agent");
  return parentAgentId === undefined ? agent : { ...agent, parentAgentId };
}

function parseGraphTask(value: unknown): GraphTask {
  const source = parseObject(value, "task");
  const task = {
    id: parseString(readRequired(source, "id", "task"), "task id"),
    title: parseString(readRequired(source, "title", "task"), "task title"),
    ownerAgentId: parseString(readRequired(source, "ownerAgentId", "task"), "task ownerAgentId"),
  };
  const parentTaskId = parseOptionalString(source, "parentTaskId", "task");
  return {
    ...task,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    dependsOn: parseStringArray(readRequired(source, "dependsOn", "task"), "task dependsOn"),
    priority: parseFiniteNumber(readRequired(source, "priority", "task"), "task priority"),
    reviewRequired: parseBoolean(readRequired(source, "reviewRequired", "task"), "task reviewRequired"),
    status: parseTaskStatus(readRequired(source, "status", "task")),
  };
}

function parseGraphAttempt(value: unknown): GraphAttempt {
  const source = parseObject(value, "attempt");
  const attempt = {
    id: parseString(readRequired(source, "id", "attempt"), "attempt id"),
    taskId: parseString(readRequired(source, "taskId", "attempt"), "attempt taskId"),
    agentId: parseString(readRequired(source, "agentId", "attempt"), "attempt agentId"),
    kind: parseAttemptKind(readRequired(source, "kind", "attempt")),
    generation: parseFiniteNumber(readRequired(source, "generation", "attempt"), "attempt generation"),
    status: parseAttemptStatus(readRequired(source, "status", "attempt")),
    startedAt: parseFiniteNumber(readRequired(source, "startedAt", "attempt"), "attempt startedAt"),
  };
  const completedAt = parseOptionalFiniteNumber(source, "completedAt", "attempt");
  const previousAttemptId = parseOptionalString(source, "previousAttemptId", "attempt");
  const supersedesAttemptId = parseOptionalString(source, "supersedesAttemptId", "attempt");
  const reviewsAttemptId = parseOptionalString(source, "reviewsAttemptId", "attempt");

  return {
    ...attempt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(previousAttemptId === undefined ? {} : { previousAttemptId }),
    ...(supersedesAttemptId === undefined ? {} : { supersedesAttemptId }),
    ...(reviewsAttemptId === undefined ? {} : { reviewsAttemptId }),
  };
}

function parseGraphRecord(value: unknown): GraphRecord {
  const source = parseObject(value, "record");
  return {
    sequence: parseFiniteNumber(readRequired(source, "sequence", "record"), "record sequence"),
    event: parseRecordedGraphEvent(readRequired(source, "event", "record")),
  };
}

function parseRecordedGraphEvent(value: unknown): RecordedGraphEvent {
  const source = parseObject(value, "record event");
  const type = parseString(readRequired(source, "type", "record event"), "record event type");

  switch (type) {
    case "work.started":
      return {
        type,
        taskId: parseString(readRequired(source, "taskId", "work.started"), "work.started taskId"),
        attemptId: parseString(readRequired(source, "attemptId", "work.started"), "work.started attemptId"),
        agentId: parseString(readRequired(source, "agentId", "work.started"), "work.started agentId"),
        at: parseFiniteNumber(readRequired(source, "at", "work.started"), "work.started at"),
      };
    case "work.completed":
      return {
        type,
        attemptId: parseString(readRequired(source, "attemptId", "work.completed"), "work.completed attemptId"),
        outcome: parseOutcome(readRequired(source, "outcome", "work.completed")),
        at: parseFiniteNumber(readRequired(source, "at", "work.completed"), "work.completed at"),
      };
    case "handoff.recorded":
      return {
        type,
        taskId: parseString(readRequired(source, "taskId", "handoff.recorded"), "handoff taskId"),
        fromAgentId: parseString(readRequired(source, "fromAgentId", "handoff.recorded"), "handoff fromAgentId"),
        toAgentId: parseString(readRequired(source, "toAgentId", "handoff.recorded"), "handoff toAgentId"),
        at: parseFiniteNumber(readRequired(source, "at", "handoff.recorded"), "handoff at"),
        message: parseString(readRequired(source, "message", "handoff.recorded"), "handoff message"),
      };
    case "task.cancelled": {
      const event: TaskCancelledEvent = {
        type,
        taskId: parseString(readRequired(source, "taskId", "task.cancelled"), "cancelled taskId"),
        at: parseFiniteNumber(readRequired(source, "at", "task.cancelled"), "cancelled at"),
        reason: parseString(readRequired(source, "reason", "task.cancelled"), "cancelled reason"),
      };
      const affectedTaskIds = hasOwn(source, "affectedTaskIds")
        ? parseStringArray(source.affectedTaskIds, "cancelled affectedTaskIds")
        : undefined;
      return affectedTaskIds === undefined ? event : { ...event, affectedTaskIds };
    }
    case "review.started":
      return {
        type,
        taskId: parseString(readRequired(source, "taskId", "review.started"), "review taskId"),
        attemptId: parseString(readRequired(source, "attemptId", "review.started"), "review attemptId"),
        agentId: parseString(readRequired(source, "agentId", "review.started"), "review agentId"),
        reviewsAttemptId: parseString(
          readRequired(source, "reviewsAttemptId", "review.started"),
          "review reviewsAttemptId",
        ),
        at: parseFiniteNumber(readRequired(source, "at", "review.started"), "review at"),
      };
    case "review.completed":
      return {
        type,
        attemptId: parseString(readRequired(source, "attemptId", "review.completed"), "review completion attemptId"),
        approved: parseBoolean(readRequired(source, "approved", "review.completed"), "review approved"),
        at: parseFiniteNumber(readRequired(source, "at", "review.completed"), "review completion at"),
      };
    case "retry.started":
      return {
        type,
        taskId: parseString(readRequired(source, "taskId", "retry.started"), "retry taskId"),
        attemptId: parseString(readRequired(source, "attemptId", "retry.started"), "retry attemptId"),
        agentId: parseString(readRequired(source, "agentId", "retry.started"), "retry agentId"),
        retryOfAttemptId: parseString(
          readRequired(source, "retryOfAttemptId", "retry.started"),
          "retry retryOfAttemptId",
        ),
        at: parseFiniteNumber(readRequired(source, "at", "retry.started"), "retry at"),
      };
    case "fallback.started":
      return {
        type,
        taskId: parseString(readRequired(source, "taskId", "fallback.started"), "fallback taskId"),
        attemptId: parseString(readRequired(source, "attemptId", "fallback.started"), "fallback attemptId"),
        agentId: parseString(readRequired(source, "agentId", "fallback.started"), "fallback agentId"),
        fallbackOfAttemptId: parseString(
          readRequired(source, "fallbackOfAttemptId", "fallback.started"),
          "fallback fallbackOfAttemptId",
        ),
        reason: parseString(readRequired(source, "reason", "fallback.started"), "fallback reason"),
        at: parseFiniteNumber(readRequired(source, "at", "fallback.started"), "fallback at"),
      };
    default:
      throw new GraphValidationError([`unsupported graph event type "${type}" in snapshot`]);
  }
}

function parseObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GraphValidationError([`${label} must be an object`]);
  }
  return value as JsonObject;
}

function parseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GraphValidationError([`${label} must be an array`]);
  }
  return value;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GraphValidationError([`${label} must be a string`]);
  }
  return value;
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  return parseArray(value, label).map((item) => parseString(item, `${label} item`));
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GraphValidationError([`${label} must be a finite number`]);
  }
  return value;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new GraphValidationError([`${label} must be a boolean`]);
  }
  return value;
}

function parseOptionalString(source: JsonObject, key: string, label: string): string | undefined {
  return hasOwn(source, key) ? parseString(source[key], `${label} ${key}`) : undefined;
}

function parseOptionalFiniteNumber(source: JsonObject, key: string, label: string): number | undefined {
  return hasOwn(source, key) ? parseFiniteNumber(source[key], `${label} ${key}`) : undefined;
}

function parseTaskStatus(value: unknown): TaskStatus {
  const status = parseString(value, "task status");
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "awaiting-review" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new GraphValidationError([`unsupported task status "${status}"`]);
  }
  return status;
}

function parseAttemptKind(value: unknown): AttemptKind {
  const kind = parseString(value, "attempt kind");
  if (kind !== "work" && kind !== "retry" && kind !== "fallback" && kind !== "review") {
    throw new GraphValidationError([`unsupported attempt kind "${kind}"`]);
  }
  return kind;
}

function parseAttemptStatus(value: unknown): AttemptStatus {
  const status = parseString(value, "attempt status");
  if (status !== "running" && status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    throw new GraphValidationError([`unsupported attempt status "${status}"`]);
  }
  return status;
}

function parseOutcome(value: unknown): "succeeded" | "failed" {
  const outcome = parseString(value, "work outcome");
  if (outcome !== "succeeded" && outcome !== "failed") {
    throw new GraphValidationError([`unsupported work outcome "${outcome}"`]);
  }
  return outcome;
}

function readRequired(source: JsonObject, key: string, label: string): unknown {
  if (!hasOwn(source, key)) {
    throw new GraphValidationError([`${label} is missing required property "${key}"`]);
  }
  return source[key];
}

function hasOwn(source: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function copyAgent(agent: GraphAgentInput): GraphAgent {
  return agent.parentAgentId === undefined
    ? { id: agent.id, label: agent.label }
    : { id: agent.id, label: agent.label, parentAgentId: agent.parentAgentId };
}

function copyAgentWithoutParent(agent: GraphAgentInput): GraphAgent {
  return { id: agent.id, label: agent.label };
}

function validatePositiveInteger(value: number, label: string, issues: string[]): void {
  if (!Number.isInteger(value) || value < 1) {
    issues.push(`${label} must be a positive integer`);
  }
}

function validateFiniteNumber(value: number, label: string, issues: string[]): void {
  if (!Number.isFinite(value)) {
    issues.push(`${label} must be finite`);
  }
}

function validateNonEmpty(value: string, label: string, issues: string[]): void {
  if (value.trim().length === 0) {
    issues.push(`${label} must not be empty`);
  }
}

function validateUniqueIds(
  items: readonly { readonly id: string }[],
  kind: string,
  issues: string[],
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      issues.push(`duplicate ${kind} id "${item.id}"`);
    }
    ids.add(item.id);
  }
}

function validateParentCycles<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  parentIdOf: (item: T) => string | undefined,
  kind: string,
  issues: string[],
): void {
  const parents = new Map(items.map((item) => [idOf(item), parentIdOf(item)]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id) || !parents.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      issues.push(`${kind} parent cycle includes "${id}"`);
      return;
    }
    visiting.add(id);
    const parentId = parents.get(id);
    if (parentId !== undefined) {
      visit(parentId);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of parents.keys()) {
    visit(id);
  }
}

function validateDependencyCycles(tasks: readonly GraphTask[], issues: string[]): void {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (taskId: string): void => {
    if (visited.has(taskId) || !dependencies.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      issues.push(`dependency cycle includes task "${taskId}"`);
      return;
    }
    visiting.add(taskId);
    for (const dependencyId of dependencies.get(taskId) ?? []) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of dependencies.keys()) {
    visit(taskId);
  }
}

function validateAttempts(
  graph: GraphState,
  agentIds: ReadonlySet<string>,
  taskIds: ReadonlySet<string>,
  issues: string[],
): void {
  validateUniqueIds(graph.attempts, "attempt", issues);
  const attemptsById = new Map(graph.attempts.map((attempt) => [attempt.id, attempt]));
  const tasksById = new Map(graph.tasks.map((task) => [task.id, task]));
  let runningAttempts = 0;

  for (const attempt of graph.attempts) {
    validateNonEmpty(attempt.id, "attempt id", issues);
    if (!taskIds.has(attempt.taskId)) {
      issues.push(`attempt "${attempt.id}" references missing task "${attempt.taskId}"`);
    }
    if (!agentIds.has(attempt.agentId)) {
      issues.push(`attempt "${attempt.id}" references missing agent "${attempt.agentId}"`);
    }
    validatePositiveInteger(attempt.generation, `attempt "${attempt.id}" generation`, issues);
    validateFiniteNumber(attempt.startedAt, `attempt "${attempt.id}" startedAt`, issues);
    if (attempt.completedAt !== undefined) {
      validateFiniteNumber(attempt.completedAt, `attempt "${attempt.id}" completedAt`, issues);
    }
    if (attempt.status === "running") {
      runningAttempts += 1;
      if (attempt.completedAt !== undefined) {
        issues.push(`running attempt "${attempt.id}" cannot have completedAt`);
      }
    } else if (attempt.completedAt === undefined) {
      issues.push(`completed attempt "${attempt.id}" must have completedAt`);
    }

    const task = tasksById.get(attempt.taskId);
    if (attempt.kind === "retry" || attempt.kind === "fallback") {
      validateAttemptLineage(attempt, attempt.previousAttemptId, attemptsById, issues);
      validateWorkSupersession(attempt, attemptsById, issues);
    } else if (attempt.previousAttemptId !== undefined) {
      issues.push(`${attempt.kind} attempt "${attempt.id}" cannot reference a previous attempt`);
    }

    if (attempt.kind === "review") {
      const reviewed = attempt.reviewsAttemptId === undefined ? undefined : attemptsById.get(attempt.reviewsAttemptId);
      if (
        reviewed === undefined ||
        reviewed.taskId !== attempt.taskId ||
        reviewed.kind === "review" ||
        reviewed.status !== "succeeded"
      ) {
        issues.push(`review attempt "${attempt.id}" must reference a succeeded work attempt on the same task`);
      } else if (reviewed.agentId === attempt.agentId) {
        issues.push(`review attempt "${attempt.id}" must use a different agent than the reviewed work`);
      } else if (attempt.generation !== reviewed.generation) {
        issues.push(`review attempt "${attempt.id}" generation must match reviewed work generation`);
      }
      if (
        (attempt.status === "running" || attempt.status === "succeeded") &&
        currentWorkAttempt(graph, attempt.taskId)?.id !== reviewed?.id
      ) {
        issues.push(`authoritative review attempt "${attempt.id}" must bind to the current work attempt`);
      }
      if (task?.reviewRequired !== true) {
        issues.push(`review attempt "${attempt.id}" belongs to a task that does not require review`);
      }
      if (attempt.supersedesAttemptId !== undefined) {
        issues.push(`review attempt "${attempt.id}" cannot supersede work`);
      }
    } else if (attempt.reviewsAttemptId !== undefined) {
      issues.push(`${attempt.kind} attempt "${attempt.id}" cannot reference a reviewed attempt`);
    }

    if (attempt.kind === "work") {
      if (attempt.generation !== 1) {
        issues.push(`initial work attempt "${attempt.id}" must have generation 1`);
      }
      if (attempt.supersedesAttemptId !== undefined) {
        issues.push(`initial work attempt "${attempt.id}" cannot supersede another attempt`);
      }
    }

    if (attempt.status === "running" && task !== undefined) {
      const expectedStatus = attempt.kind === "review" ? "awaiting-review" : "running";
      if (task.status !== expectedStatus) {
        issues.push(`running attempt "${attempt.id}" is inconsistent with task "${task.id}" status`);
      }
    }
  }

  if (runningAttempts > graph.maxParallelism) {
    issues.push(`running attempts exceed maxParallelism (${runningAttempts} > ${graph.maxParallelism})`);
  }
  validateWorkAttemptChains(graph, issues);
  validateTaskOutcomeAuthority(graph, issues);
}

function validateAttemptLineage(
  attempt: GraphAttempt,
  previousAttemptId: string | undefined,
  attemptsById: ReadonlyMap<string, GraphAttempt>,
  issues: string[],
): void {
  const previous = previousAttemptId === undefined ? undefined : attemptsById.get(previousAttemptId);
  if (previous === undefined || previous.taskId !== attempt.taskId || previous.status !== "failed") {
    issues.push(`${attempt.kind} attempt "${attempt.id}" must reference a failed attempt on the same task`);
  }
}

function validateWorkSupersession(
  attempt: GraphAttempt,
  attemptsById: ReadonlyMap<string, GraphAttempt>,
  issues: string[],
): void {
  const predecessor =
    attempt.supersedesAttemptId === undefined ? undefined : attemptsById.get(attempt.supersedesAttemptId);
  if (predecessor === undefined || predecessor.kind === "review" || predecessor.taskId !== attempt.taskId) {
    issues.push(`${attempt.kind} attempt "${attempt.id}" must supersede a work predecessor on the same task`);
    return;
  }
  if (attempt.generation !== predecessor.generation + 1) {
    issues.push(`${attempt.kind} attempt "${attempt.id}" generation must follow its superseded predecessor`);
  }

  const failure = attempt.previousAttemptId === undefined ? undefined : attemptsById.get(attempt.previousAttemptId);
  const failedWorkAttemptId = failure?.kind === "review" ? failure.reviewsAttemptId : failure?.id;
  if (failedWorkAttemptId !== predecessor.id) {
    issues.push(`${attempt.kind} attempt "${attempt.id}" failure lineage must bind to its superseded work`);
  }
}

function validateWorkAttemptChains(graph: GraphState, issues: string[]): void {
  const workByTask = new Map<string, GraphAttempt[]>();
  for (const attempt of graph.attempts) {
    if (attempt.kind === "review") {
      continue;
    }
    const attempts = workByTask.get(attempt.taskId) ?? [];
    attempts.push(attempt);
    workByTask.set(attempt.taskId, attempts);
  }

  for (const [taskId, attempts] of workByTask) {
    const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
    const seenGenerations = new Set<number>();
    for (const attempt of attempts) {
      if (seenGenerations.has(attempt.generation)) {
        issues.push(`task "${taskId}" has duplicate work generation ${attempt.generation}`);
      }
      seenGenerations.add(attempt.generation);
      if (attempt.generation > 1 && attempt.kind === "work") {
        issues.push(`task "${taskId}" generation ${attempt.generation} must be a retry or fallback`);
      }
    }
    for (let generation = 1; generation <= attempts.length; generation += 1) {
      if (!seenGenerations.has(generation)) {
        issues.push(`task "${taskId}" work generation chain is missing generation ${generation}`);
      }
    }

    const supersededAttemptIds = new Set(
      attempts.flatMap((attempt) =>
        attempt.supersedesAttemptId === undefined ? [] : [attempt.supersedesAttemptId],
      ),
    );
    const currentAttempts = attempts.filter((attempt) => !supersededAttemptIds.has(attempt.id));
    if (currentAttempts.length !== 1) {
      issues.push(`task "${taskId}" must have exactly one current unsuperseded work attempt`);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (attempt: GraphAttempt): void => {
      if (visiting.has(attempt.id)) {
        issues.push(`work supersession cycle includes attempt "${attempt.id}"`);
        return;
      }
      if (visited.has(attempt.id)) {
        return;
      }
      visiting.add(attempt.id);
      const predecessor =
        attempt.supersedesAttemptId === undefined ? undefined : attemptsById.get(attempt.supersedesAttemptId);
      if (predecessor !== undefined) {
        visit(predecessor);
      }
      visiting.delete(attempt.id);
      visited.add(attempt.id);
    };
    for (const attempt of attempts) {
      visit(attempt);
    }
  }
}

function validateTaskOutcomeAuthority(graph: GraphState, issues: string[]): void {
  for (const task of graph.tasks) {
    if (task.status !== "succeeded") {
      continue;
    }
    const currentAttempt = currentWorkAttempt(graph, task.id);
    if (currentAttempt?.status !== "succeeded") {
      issues.push(`successful task "${task.id}" must have succeeded current work`);
      continue;
    }
    if (
      task.reviewRequired &&
      !graph.attempts.some(
        (attempt) =>
          attempt.taskId === task.id &&
          attempt.kind === "review" &&
          attempt.status === "succeeded" &&
          attempt.reviewsAttemptId === currentAttempt.id &&
          attempt.generation === currentAttempt.generation,
      )
    ) {
      issues.push(`successful task "${task.id}" must have an approved review of its current work attempt`);
    }
  }
}

function validateRecords(graph: GraphState, issues: string[]): void {
  const taskIds = new Set(graph.tasks.map((task) => task.id));
  const agentIds = new Set(graph.agents.map((agent) => agent.id));
  const attemptsById = new Map(graph.attempts.map((attempt) => [attempt.id, attempt]));

  validateAttemptChronology(graph, issues);

  for (const [index, record] of graph.records.entries()) {
    if (!Number.isInteger(record.sequence) || record.sequence !== index + 1) {
      issues.push(`record at index ${index} must have sequence ${index + 1}`);
    }
    validateFiniteNumber(record.event.at, `record ${record.sequence} timestamp`, issues);
    if (record.event.type === "handoff.recorded" && record.event.message.trim().length === 0) {
      issues.push(`record ${record.sequence} has an empty handoff message`);
    }
    if (record.event.type === "fallback.started" && record.event.reason.trim().length === 0) {
      issues.push(`record ${record.sequence} has an empty fallback reason`);
    }
    if (hasAffectedTaskIds(record.event)) {
      const affectedTaskIds = record.event.affectedTaskIds;
      const sortedAffectedTaskIds = [...affectedTaskIds].sort();
      if (sortedAffectedTaskIds.some((taskId, affectedIndex) => taskId !== affectedTaskIds[affectedIndex])) {
        issues.push(`record ${record.sequence} cancellation affectedTaskIds must be sorted`);
      }
    }
    validateRecordReferences(graph, record, taskIds, agentIds, attemptsById, issues);
  }
}

function validateRecordReferences(
  graph: GraphState,
  record: GraphRecord,
  taskIds: ReadonlySet<string>,
  agentIds: ReadonlySet<string>,
  attemptsById: ReadonlyMap<string, GraphAttempt>,
  issues: string[],
): void {
  const event = record.event;
  switch (event.type) {
    case "work.started": {
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      validateRecordAgentReference(record, event.agentId, agentIds, issues);
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      if (
        attempt !== undefined &&
        (attempt.kind !== "work" || attempt.taskId !== event.taskId || attempt.agentId !== event.agentId)
      ) {
        issues.push(`record ${record.sequence} work.started does not match attempt "${event.attemptId}"`);
      }
      break;
    }
    case "work.completed": {
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      if (attempt?.kind === "review") {
        issues.push(`record ${record.sequence} work.completed references review attempt "${event.attemptId}"`);
      }
      break;
    }
    case "handoff.recorded":
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      validateRecordAgentReference(record, event.fromAgentId, agentIds, issues);
      validateRecordAgentReference(record, event.toAgentId, agentIds, issues);
      break;
    case "task.cancelled":
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      if (!hasAffectedTaskIds(event)) {
        issues.push(`record ${record.sequence} task.cancelled is missing affectedTaskIds`);
      } else {
        for (const affectedTaskId of event.affectedTaskIds) {
          validateRecordTaskReference(record, affectedTaskId, taskIds, issues);
        }
        if (taskIds.has(event.taskId)) {
          const expectedAffectedTaskIds = cancellationTaskIds(graph, event.taskId);
          if (!sameStringArray(event.affectedTaskIds, expectedAffectedTaskIds)) {
            issues.push(`record ${record.sequence} cancellation affectedTaskIds do not match the authorized closure`);
          }
        }
      }
      break;
    case "review.started": {
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      validateRecordAgentReference(record, event.agentId, agentIds, issues);
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      validateRecordAttemptReference(record, event.reviewsAttemptId, attemptsById, issues);
      if (
        attempt !== undefined &&
        (attempt.kind !== "review" ||
          attempt.taskId !== event.taskId ||
          attempt.agentId !== event.agentId ||
          attempt.reviewsAttemptId !== event.reviewsAttemptId)
      ) {
        issues.push(`record ${record.sequence} review.started does not match attempt "${event.attemptId}"`);
      }
      break;
    }
    case "review.completed": {
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      if (attempt !== undefined && attempt.kind !== "review") {
        issues.push(`record ${record.sequence} review.completed references non-review attempt "${event.attemptId}"`);
      }
      break;
    }
    case "retry.started": {
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      validateRecordAgentReference(record, event.agentId, agentIds, issues);
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      validateRecordAttemptReference(record, event.retryOfAttemptId, attemptsById, issues);
      if (
        attempt !== undefined &&
        (attempt.kind !== "retry" ||
          attempt.taskId !== event.taskId ||
          attempt.agentId !== event.agentId ||
          attempt.previousAttemptId !== event.retryOfAttemptId)
      ) {
        issues.push(`record ${record.sequence} retry.started does not match attempt "${event.attemptId}"`);
      }
      break;
    }
    case "fallback.started": {
      validateRecordTaskReference(record, event.taskId, taskIds, issues);
      validateRecordAgentReference(record, event.agentId, agentIds, issues);
      const attempt = validateRecordAttemptReference(record, event.attemptId, attemptsById, issues);
      validateRecordAttemptReference(record, event.fallbackOfAttemptId, attemptsById, issues);
      if (
        attempt !== undefined &&
        (attempt.kind !== "fallback" ||
          attempt.taskId !== event.taskId ||
          attempt.agentId !== event.agentId ||
          attempt.previousAttemptId !== event.fallbackOfAttemptId)
      ) {
        issues.push(`record ${record.sequence} fallback.started does not match attempt "${event.attemptId}"`);
      }
      break;
    }
  }
}

function validateAttemptChronology(graph: GraphState, issues: string[]): void {
  const recordedAttemptIds: string[] = [];
  const seenAttemptIds = new Set<string>();
  for (const record of graph.records) {
    const event = record.event;
    if (
      event.type !== "work.started" &&
      event.type !== "retry.started" &&
      event.type !== "fallback.started" &&
      event.type !== "review.started"
    ) {
      continue;
    }
    if (seenAttemptIds.has(event.attemptId)) {
      issues.push(`attempt "${event.attemptId}" has more than one start in record chronology`);
    }
    seenAttemptIds.add(event.attemptId);
    recordedAttemptIds.push(event.attemptId);
  }

  if (recordedAttemptIds.length !== graph.attempts.length) {
    issues.push("attempt chronology must contain exactly one start record per attempt");
  }
  for (let index = 0; index < Math.max(recordedAttemptIds.length, graph.attempts.length); index += 1) {
    if (recordedAttemptIds[index] !== graph.attempts[index]?.id) {
      issues.push(`attempt order must match immutable record chronology at index ${index}`);
    }
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRecordTaskReference(
  record: GraphRecord,
  taskId: string,
  taskIds: ReadonlySet<string>,
  issues: string[],
): void {
  if (!taskIds.has(taskId)) {
    issues.push(`record ${record.sequence} ${record.event.type} references unknown task "${taskId}"`);
  }
}

function validateRecordAgentReference(
  record: GraphRecord,
  agentId: string,
  agentIds: ReadonlySet<string>,
  issues: string[],
): void {
  if (!agentIds.has(agentId)) {
    issues.push(`record ${record.sequence} ${record.event.type} references unknown agent "${agentId}"`);
  }
}

function validateRecordAttemptReference(
  record: GraphRecord,
  attemptId: string,
  attemptsById: ReadonlyMap<string, GraphAttempt>,
  issues: string[],
): GraphAttempt | undefined {
  const attempt = attemptsById.get(attemptId);
  if (attempt === undefined) {
    issues.push(`record ${record.sequence} ${record.event.type} references unknown attempt "${attemptId}"`);
  }
  return attempt;
}

function hasAffectedTaskIds(
  event: RecordedGraphEvent,
): event is TaskCancelledEvent & { readonly affectedTaskIds: readonly string[] } {
  return event.type === "task.cancelled" && "affectedTaskIds" in event;
}
