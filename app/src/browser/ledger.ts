import type {
  BrowserActionType,
  BrowserCapabilityIntent,
  BrowserDecisionScope,
  BrowserPolicyDecision,
  BrowserPolicyReason,
} from "./types";
import type { BrowserOperationState } from "./lifecycle";
import {
  browserActionDigest,
  browserDecisionScopeDigest,
  decodeBrowserApprovalState,
  decodeBrowserCapabilityIntent,
  decodeBrowserDecisionScope,
  decodeBrowserExecutionLease,
} from "./policy";
import {
  finiteNumber,
  nonEmptyString,
  nonNegativeSafeInteger,
  positiveSafeInteger,
  readDataArray,
  readDataObject,
} from "./strict-data";

export type BrowserLedgerEventType = "intent" | "decision" | "operation" | "approval" | "takeover";

export type BrowserLedgerStatus =
  | "requested"
  | "allowed"
  | "denied"
  | "approval_required"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "recoverable"
  | "recovered"
  | "outcome_unknown"
  | "uncertain";

export interface VisibleActionLedgerEntry {
  eventId: string;
  eventType: BrowserLedgerEventType;
  actionId: string;
  sequence: number;
  visible: true;
  atMs: number;
  intentId: string;
  decisionId?: string;
  operationId?: string;
  generation?: number;
  attempt?: number;
  actionType: BrowserActionType;
  actionDigest?: string;
  scopeDigest?: string;
  decisionIssuedAtMs?: number;
  status: BrowserLedgerStatus;
  summary: string;
  reason?: BrowserPolicyReason;
  evidenceIds?: readonly string[];
}

export interface VisibleActionLedger {
  entries: readonly VisibleActionLedgerEntry[];
  nextSequence: number;
  seenEventIds: readonly string[];
  seenDecisionIds: readonly string[];
  terminalOperationIds: readonly string[];
}

export interface VisibleActionLedgerEntryInput {
  eventId: string;
  eventType: BrowserLedgerEventType;
  actionId: string;
  atMs: number;
  intentId?: string;
  decisionId?: string;
  operationId?: string;
  generation?: number;
  attempt?: number;
  actionType: BrowserActionType;
  actionDigest?: string;
  scopeDigest?: string;
  decisionIssuedAtMs?: number;
  status: BrowserLedgerStatus;
  summary: string;
  reason?: BrowserPolicyReason;
  evidenceIds?: readonly string[];
}

const ACTION_TYPES = new Set<BrowserActionType>([
  "navigate",
  "redirect",
  "popup",
  "frame",
  "download",
  "upload",
  "screenshot",
  "selector",
  "coordinate",
  "clipboard",
  "takeover",
]);

const STATUSES = new Set<BrowserLedgerStatus>([
  "requested",
  "allowed",
  "denied",
  "approval_required",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "recoverable",
  "recovered",
  "outcome_unknown",
  "uncertain",
]);

const EVENT_TYPES = new Set<BrowserLedgerEventType>(["intent", "decision", "operation", "approval", "takeover"]);
const TERMINAL_STATUSES = new Set<BrowserLedgerStatus>(["succeeded", "failed", "cancelled", "outcome_unknown", "uncertain"]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;

function actionSummary(actionType: BrowserActionType, status: BrowserLedgerStatus): string {
  return `${actionType} ${status.replace(/_/g, " ")}`;
}

function decodeStringArray(value: unknown): readonly string[] | null {
  const array = readDataArray(value);
  return array && array.every((item) => typeof item === "string") ? [...array] as string[] : null;
}

function decodeEntryInput(input: unknown): VisibleActionLedgerEntryInput | null {
  const record = readDataObject(
    input,
    ["eventId", "eventType", "actionId", "atMs", "actionType", "status", "summary"],
    [
      "intentId",
      "decisionId",
      "operationId",
      "generation",
      "attempt",
      "actionDigest",
      "scopeDigest",
      "decisionIssuedAtMs",
      "reason",
      "evidenceIds",
    ],
  );
  if (
    !record ||
    !nonEmptyString(record.eventId) ||
    typeof record.eventType !== "string" ||
    !EVENT_TYPES.has(record.eventType as BrowserLedgerEventType) ||
    !nonEmptyString(record.actionId) ||
    !finiteNumber(record.atMs) ||
    record.atMs < 0 ||
    typeof record.actionType !== "string" ||
    !ACTION_TYPES.has(record.actionType as BrowserActionType) ||
    typeof record.status !== "string" ||
    !STATUSES.has(record.status as BrowserLedgerStatus) ||
    !nonEmptyString(record.summary)
  ) return null;
  if (record.intentId !== undefined && !nonEmptyString(record.intentId)) return null;
  if (record.decisionId !== undefined && !nonEmptyString(record.decisionId)) return null;
  if (record.operationId !== undefined && !nonEmptyString(record.operationId)) return null;
  if (record.generation !== undefined && !positiveSafeInteger(record.generation)) return null;
  if (record.attempt !== undefined && !positiveSafeInteger(record.attempt)) return null;
  if ((record.generation === undefined) !== (record.attempt === undefined)) return null;
  if (record.operationId === undefined && record.generation !== undefined) return null;
  if (record.eventType === "operation" && (record.operationId === undefined || record.generation === undefined)) return null;
  if (record.eventType === "decision" && record.decisionId !== record.eventId) return null;
  if (record.actionDigest !== undefined && (typeof record.actionDigest !== "string" || !DIGEST_PATTERN.test(record.actionDigest))) return null;
  if (record.scopeDigest !== undefined && (typeof record.scopeDigest !== "string" || !DIGEST_PATTERN.test(record.scopeDigest))) return null;
  if (record.decisionIssuedAtMs !== undefined && (!finiteNumber(record.decisionIssuedAtMs) || record.decisionIssuedAtMs < 0)) return null;
  if (record.reason !== undefined && !nonEmptyString(record.reason)) return null;
  const evidenceIds = record.evidenceIds === undefined ? undefined : decodeStringArray(record.evidenceIds);
  if (evidenceIds === null) return null;

  return {
    eventId: record.eventId,
    eventType: record.eventType as BrowserLedgerEventType,
    actionId: record.actionId,
    atMs: record.atMs,
    intentId: record.intentId as string | undefined,
    decisionId: record.decisionId as string | undefined,
    operationId: record.operationId as string | undefined,
    generation: record.generation as number | undefined,
    attempt: record.attempt as number | undefined,
    actionType: record.actionType as BrowserActionType,
    actionDigest: record.actionDigest as string | undefined,
    scopeDigest: record.scopeDigest as string | undefined,
    decisionIssuedAtMs: record.decisionIssuedAtMs as number | undefined,
    status: record.status as BrowserLedgerStatus,
    summary: record.summary,
    reason: record.reason as BrowserPolicyReason | undefined,
    evidenceIds,
  };
}

function decodeStoredEntry(input: unknown): VisibleActionLedgerEntry | null {
  const record = readDataObject(
    input,
    ["eventId", "eventType", "actionId", "sequence", "visible", "atMs", "intentId", "actionType", "status", "summary"],
    [
      "decisionId",
      "operationId",
      "generation",
      "attempt",
      "actionDigest",
      "scopeDigest",
      "decisionIssuedAtMs",
      "reason",
      "evidenceIds",
    ],
  );
  if (!record || !positiveSafeInteger(record.sequence) || record.visible !== true) return null;
  const candidate = decodeEntryInput({
    eventId: record.eventId,
    eventType: record.eventType,
    actionId: record.actionId,
    atMs: record.atMs,
    intentId: record.intentId,
    actionType: record.actionType,
    status: record.status,
    summary: record.summary,
    ...(record.decisionId === undefined ? {} : { decisionId: record.decisionId }),
    ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
    ...(record.generation === undefined ? {} : { generation: record.generation }),
    ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
    ...(record.actionDigest === undefined ? {} : { actionDigest: record.actionDigest }),
    ...(record.scopeDigest === undefined ? {} : { scopeDigest: record.scopeDigest }),
    ...(record.decisionIssuedAtMs === undefined ? {} : { decisionIssuedAtMs: record.decisionIssuedAtMs }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.evidenceIds === undefined ? {} : { evidenceIds: record.evidenceIds }),
  });
  return candidate ? { ...candidate, intentId: candidate.intentId ?? candidate.actionId, sequence: record.sequence, visible: true } : null;
}

function decodeLedger(input: unknown): VisibleActionLedger | null {
  const record = readDataObject(input, ["entries", "nextSequence", "seenEventIds", "seenDecisionIds", "terminalOperationIds"]);
  const entriesInput = record ? readDataArray(record.entries) : null;
  const seenEventIds = record ? decodeStringArray(record.seenEventIds) : null;
  const seenDecisionIds = record ? decodeStringArray(record.seenDecisionIds) : null;
  const terminalOperationIds = record ? decodeStringArray(record.terminalOperationIds) : null;
  if (!record || !entriesInput || !seenEventIds || !seenDecisionIds || !terminalOperationIds || !positiveSafeInteger(record.nextSequence)) return null;
  const entries: VisibleActionLedgerEntry[] = [];
  for (const candidate of entriesInput) {
    const entry = decodeStoredEntry(candidate);
    if (!entry || entry.sequence !== entries.length + 1) return null;
    entries.push(entry);
  }
  if (record.nextSequence !== entries.length + 1) return null;
  return { entries, nextSequence: record.nextSequence, seenEventIds, seenDecisionIds, terminalOperationIds };
}

export function createVisibleActionLedger(): VisibleActionLedger {
  return { entries: [], nextSequence: 1, seenEventIds: [], seenDecisionIds: [], terminalOperationIds: [] };
}

/** Appends one immutable, visible event; malformed, duplicate, or late input is ignored. */
export function appendVisibleAction(ledgerInput: VisibleActionLedger, input: VisibleActionLedgerEntryInput): VisibleActionLedger {
  const ledger = decodeLedger(ledgerInput);
  const candidate = decodeEntryInput(input);
  if (!ledger || !candidate) return ledgerInput;
  if (candidate.eventType === "intent" && candidate.status !== "requested") return ledgerInput;
  if (
    candidate.eventType === "decision" &&
    ((candidate.status !== "allowed" && candidate.status !== "denied" && candidate.status !== "approval_required") ||
      candidate.intentId === undefined ||
      candidate.actionDigest === undefined ||
      candidate.scopeDigest === undefined ||
      candidate.decisionIssuedAtMs === undefined ||
      candidate.decisionIssuedAtMs > candidate.atMs)
  ) return ledgerInput;
  if (
    candidate.eventType === "operation" &&
    (candidate.actionDigest === undefined || candidate.scopeDigest === undefined || candidate.decisionIssuedAtMs === undefined)
  ) return ledgerInput;
  if (ledger.entries.length > 0 && candidate.atMs < ledger.entries[ledger.entries.length - 1].atMs) return ledgerInput;
  if (ledger.seenEventIds.includes(candidate.eventId) || ledger.entries.some((entry) => entry.eventId === candidate.eventId)) return ledgerInput;
  if (
    candidate.decisionId !== undefined &&
    (ledger.seenDecisionIds.includes(candidate.decisionId) || ledger.entries.some((entry) => entry.decisionId === candidate.decisionId))
  ) return ledgerInput;
  if (
    candidate.operationId !== undefined &&
    (ledger.terminalOperationIds.includes(candidate.operationId) ||
      ledger.entries.some((entry) => entry.operationId === candidate.operationId && TERMINAL_STATUSES.has(entry.status)))
  ) return ledgerInput;
  const priorActionEntries = ledger.entries.filter((entry) => entry.actionId === candidate.actionId);
  if (
    candidate.eventType === "operation" &&
    !priorActionEntries.some((entry) =>
      entry.eventType === "decision" &&
      entry.status === "allowed" &&
      entry.intentId === candidate.intentId &&
      entry.actionType === candidate.actionType &&
      entry.actionDigest === candidate.actionDigest &&
      entry.scopeDigest === candidate.scopeDigest &&
      entry.decisionIssuedAtMs === candidate.decisionIssuedAtMs,
    )
  ) return ledgerInput;
  if (
    priorActionEntries.some((entry) =>
      entry.actionType !== candidate.actionType ||
      (entry.actionDigest !== undefined && candidate.actionDigest !== undefined && entry.actionDigest !== candidate.actionDigest) ||
      (entry.scopeDigest !== undefined && candidate.scopeDigest !== undefined && entry.scopeDigest !== candidate.scopeDigest),
    )
  ) return ledgerInput;

  const entry: VisibleActionLedgerEntry = {
    ...candidate,
    sequence: ledger.nextSequence,
    visible: true,
    intentId: candidate.intentId ?? candidate.actionId,
    ...(candidate.evidenceIds === undefined ? {} : { evidenceIds: [...candidate.evidenceIds] }),
  };
  return {
    entries: [...ledger.entries, entry],
    nextSequence: ledger.nextSequence + 1,
    seenEventIds: [...ledger.seenEventIds, candidate.eventId],
    seenDecisionIds: candidate.decisionId === undefined ? [...ledger.seenDecisionIds] : [...ledger.seenDecisionIds, candidate.decisionId],
    terminalOperationIds: candidate.operationId !== undefined && TERMINAL_STATUSES.has(candidate.status)
      ? [...ledger.terminalOperationIds, candidate.operationId]
      : [...ledger.terminalOperationIds],
  };
}

function sameScopeAsIntent(scope: BrowserDecisionScope, intent: BrowserCapabilityIntent): boolean {
  return scope.principalId === intent.principalId &&
    scope.binding.accountId === intent.binding.accountId &&
    scope.binding.projectId === intent.binding.projectId &&
    scope.profile.profileId === intent.profile.profileId &&
    scope.profile.mode === intent.profile.mode &&
    scope.profile.accountId === intent.profile.accountId &&
    scope.profile.projectId === intent.profile.projectId &&
    scope.target.sessionId === intent.target.sessionId &&
    scope.target.tabId === intent.target.tabId &&
    scope.target.targetId === intent.target.targetId &&
    scope.target.epoch === intent.target.epoch &&
    scope.policyEpoch === intent.policyEpoch &&
    scope.approvalEpoch === intent.approvalEpoch;
}

function decodePolicyDecision(input: unknown): BrowserPolicyDecision | null {
  const record = readDataObject(
    input,
    [
      "decisionId",
      "intentId",
      "actionDigest",
      "status",
      "allowed",
      "requiresApproval",
      "reason",
      "evidenceIds",
      "issuedAtMs",
      "expectedStateRevision",
      "authorizationState",
    ],
    ["scope", "scopeDigest", "approvalId", "executionLease"],
  );
  const evidenceIds = record ? decodeStringArray(record.evidenceIds) : null;
  const scope = record?.scope === undefined ? undefined : decodeBrowserDecisionScope(record.scope);
  const authorizationState = record ? decodeBrowserApprovalState(record.authorizationState) : null;
  if (
    !record ||
    !nonEmptyString(record.decisionId) ||
    !OPAQUE_ID_PATTERN.test(record.decisionId) ||
    !nonEmptyString(record.intentId) ||
    typeof record.actionDigest !== "string" ||
    !DIGEST_PATTERN.test(record.actionDigest) ||
    (record.status !== "allowed" && record.status !== "denied" && record.status !== "approval_required") ||
    typeof record.allowed !== "boolean" ||
    typeof record.requiresApproval !== "boolean" ||
    !nonEmptyString(record.reason) ||
    !evidenceIds ||
    evidenceIds.some((id) => !OPAQUE_ID_PATTERN.test(id)) ||
    !finiteNumber(record.issuedAtMs) ||
    record.issuedAtMs < 0 ||
    !nonNegativeSafeInteger(record.expectedStateRevision) ||
    !authorizationState ||
    (record.scope !== undefined && !scope) ||
    (record.scopeDigest !== undefined && (typeof record.scopeDigest !== "string" || !DIGEST_PATTERN.test(record.scopeDigest))) ||
    (record.approvalId !== undefined && (!nonEmptyString(record.approvalId) || !OPAQUE_ID_PATTERN.test(record.approvalId)))
  ) return null;
  const executionLease = record.executionLease === undefined ? undefined : decodeBrowserExecutionLease(record.executionLease);
  if (record.executionLease !== undefined && !executionLease) return null;
  const decodedScope: BrowserDecisionScope | undefined = scope ?? undefined;
  const decodedExecutionLease = executionLease ?? undefined;

  return {
    decisionId: record.decisionId,
    intentId: record.intentId,
    actionDigest: record.actionDigest,
    status: record.status,
    allowed: record.allowed,
    requiresApproval: record.requiresApproval,
    reason: record.reason as BrowserPolicyReason,
    evidenceIds,
    issuedAtMs: record.issuedAtMs,
    ...(decodedScope === undefined ? {} : { scope: decodedScope }),
    ...(record.scopeDigest === undefined ? {} : { scopeDigest: record.scopeDigest as string }),
    ...(record.approvalId === undefined ? {} : { approvalId: record.approvalId }),
    ...(decodedExecutionLease === undefined ? {} : { executionLease: decodedExecutionLease }),
    expectedStateRevision: record.expectedStateRevision,
    authorizationState,
  };
}

function decisionStatusIsConsistent(decision: BrowserPolicyDecision): boolean {
  if (decision.status === "allowed") {
    return decision.allowed === true && decision.reason === "allowed" && decision.executionLease !== undefined;
  }
  if (decision.status === "approval_required") {
    return decision.allowed === false && decision.requiresApproval === true && decision.reason === "approval-required" && decision.executionLease === undefined;
  }
  return decision.allowed === false && decision.reason !== "allowed" && decision.executionLease === undefined;
}

export function recordBrowserDecision(
  ledger: VisibleActionLedger,
  intentInput: BrowserCapabilityIntent,
  decisionInput: BrowserPolicyDecision,
  atMs: number,
): VisibleActionLedger {
  const intent = decodeBrowserCapabilityIntent(intentInput);
  const decision = decodePolicyDecision(decisionInput);
  if (!intent || !decision || !finiteNumber(atMs) || atMs < 0) return ledger;
  if (
    decision.intentId !== intent.intentId ||
    decision.actionDigest !== browserActionDigest(intent.action) ||
    !decisionStatusIsConsistent(decision) ||
    decision.issuedAtMs < intent.requestedAtMs ||
    atMs < decision.issuedAtMs ||
    !decision.scope ||
    !decision.scopeDigest ||
    !sameScopeAsIntent(decision.scope, intent) ||
    decision.scopeDigest !== browserDecisionScopeDigest(decision.scope)
  ) return ledger;
  if (decision.status === "allowed") {
    const lease = decision.executionLease;
    if (
      !lease ||
      lease.decisionId !== decision.decisionId ||
      lease.intentId !== decision.intentId ||
      lease.actionDigest !== decision.actionDigest ||
      lease.policyDigest !== decision.scope.policyDigest ||
      lease.observationDigest !== decision.scope.observationDigest ||
      browserDecisionScopeDigest(lease.scope) !== decision.scopeDigest ||
      lease.issuedAtMs !== decision.issuedAtMs ||
      decision.authorizationState.revision !== decision.expectedStateRevision + 1 ||
      !decision.authorizationState.activeLeases.some((candidate) => candidate.leaseId === lease.leaseId)
    ) return ledger;
  } else if (decision.authorizationState.revision !== decision.expectedStateRevision) {
    return ledger;
  }

  return appendVisibleAction(ledger, {
    eventId: decision.decisionId,
    eventType: "decision",
    actionId: intent.intentId,
    intentId: intent.intentId,
    decisionId: decision.decisionId,
    atMs,
    actionType: intent.action.type,
    actionDigest: decision.actionDigest,
    scopeDigest: decision.scopeDigest,
    decisionIssuedAtMs: decision.issuedAtMs,
    status: decision.status,
    summary: actionSummary(intent.action.type, decision.status),
    reason: decision.reason,
    evidenceIds: decision.evidenceIds,
  });
}

export function recordBrowserOperation(
  ledger: VisibleActionLedger,
  intentId: string,
  actionType: BrowserActionType,
  operation: BrowserOperationState,
  atMs: number,
): VisibleActionLedger {
  const decodedLedger = decodeLedger(ledger);
  const record = readDataObject(
    operation,
    ["operationId", "actionDigest", "retryClass", "status", "generation", "attempt", "startedAtMs", "deadlineAtMs"],
    ["lastError", "cancelReason", "completedAtMs"],
  );
  if (
    !decodedLedger ||
    !nonEmptyString(intentId) ||
    !ACTION_TYPES.has(actionType) ||
    !record ||
    !nonEmptyString(record.operationId) ||
    typeof record.actionDigest !== "string" ||
    !DIGEST_PATTERN.test(record.actionDigest) ||
    (record.retryClass !== "idempotent" && record.retryClass !== "non_idempotent") ||
    typeof record.status !== "string" ||
    !STATUSES.has(record.status as BrowserLedgerStatus) ||
    !positiveSafeInteger(record.generation) ||
    !positiveSafeInteger(record.attempt) ||
    !finiteNumber(record.startedAtMs) ||
    !finiteNumber(atMs) ||
    atMs < record.startedAtMs
  ) return ledger;
  if (
    record.retryClass === "non_idempotent" &&
    (record.status === "timed_out" || record.status === "recoverable" || record.attempt > 1)
  ) return ledger;
  if (record.retryClass === "idempotent" && record.status === "outcome_unknown") return ledger;
  const decisionEntry = [...decodedLedger.entries].reverse().find((entry) =>
    entry.eventType === "decision" &&
    entry.intentId === intentId &&
    entry.actionType === actionType &&
    entry.status === "allowed" &&
    entry.actionDigest === record.actionDigest &&
    entry.scopeDigest !== undefined &&
    entry.decisionIssuedAtMs !== undefined,
  );
  if (!decisionEntry || record.startedAtMs < decisionEntry.decisionIssuedAtMs!) return ledger;
  const status: BrowserLedgerStatus = record.status === "running" && record.attempt > 1
    ? "recovered"
    : record.status as BrowserLedgerStatus;
  const eventId = `operation:${record.operationId}:${record.generation}:${record.attempt}:${status}`;
  return appendVisibleAction(ledger, {
    eventId,
    eventType: "operation",
    actionId: intentId,
    intentId,
    operationId: record.operationId,
    generation: record.generation,
    attempt: record.attempt,
    atMs,
    actionType,
    actionDigest: record.actionDigest,
    scopeDigest: decisionEntry.scopeDigest,
    decisionIssuedAtMs: decisionEntry.decisionIssuedAtMs,
    status,
    summary: actionSummary(actionType, status),
  });
}
