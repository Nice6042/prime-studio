import type { BrowserAction } from "./types";
import { browserActionDigest, decodeBrowserAction } from "./policy";
import {
  finiteNumber,
  nonEmptyString,
  positiveSafeInteger,
  readDataObject,
} from "./strict-data";

export type BrowserRetryClass = "idempotent" | "non_idempotent";

export type BrowserOperationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "recoverable"
  | "outcome_unknown"
  | "uncertain";

export interface BrowserOperationToken {
  generation: number;
  attempt: number;
}

export interface BrowserOperationState extends BrowserOperationToken {
  operationId: string;
  actionDigest: string;
  retryClass: BrowserRetryClass;
  status: BrowserOperationStatus;
  startedAtMs: number;
  deadlineAtMs: number;
  lastError?: string;
  cancelReason?: string;
  completedAtMs?: number;
}

export interface CreateBrowserOperationInput {
  operationId: string;
  action: BrowserAction;
  startedAtMs: number;
  timeoutMs: number;
}

export type BrowserOperationEvent =
  | ({ type: "tick"; nowMs: number } & BrowserOperationToken)
  | ({ type: "complete"; nowMs: number } & BrowserOperationToken)
  | ({ type: "cancel"; reason: string } & BrowserOperationToken)
  | ({ type: "fail"; error: string; recoverable: boolean } & BrowserOperationToken)
  | ({ type: "uncertain"; error: string } & BrowserOperationToken)
  | ({ type: "recover"; nowMs: number; timeoutMs: number } & BrowserOperationToken);

const OPERATION_STATUSES = new Set<BrowserOperationStatus>([
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "recoverable",
  "outcome_unknown",
  "uncertain",
]);
const RETRY_CLASSES = new Set<BrowserRetryClass>(["idempotent", "non_idempotent"]);
const ACTION_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function operationIdFrom(value: unknown): string {
  const record = readDataObject(value, [], [
    "operationId",
    "actionDigest",
    "retryClass",
    "status",
    "generation",
    "attempt",
    "startedAtMs",
    "deadlineAtMs",
    "lastError",
    "cancelReason",
    "completedAtMs",
  ]);
  return record && nonEmptyString(record.operationId) ? record.operationId : "invalid-operation";
}

function uncertainState(operationId: string, lastError: string): BrowserOperationState {
  return {
    operationId,
    actionDigest: "sha256:invalid-action",
    retryClass: "non_idempotent",
    status: "uncertain",
    generation: 1,
    attempt: 1,
    startedAtMs: 0,
    deadlineAtMs: 0,
    lastError,
  };
}

function decodeToken(value: Record<string, unknown>): BrowserOperationToken | null {
  return positiveSafeInteger(value.generation) && positiveSafeInteger(value.attempt)
    ? { generation: value.generation, attempt: value.attempt }
    : null;
}

function decodeState(value: unknown): BrowserOperationState | null {
  const record = readDataObject(
    value,
    ["operationId", "actionDigest", "retryClass", "status", "generation", "attempt", "startedAtMs", "deadlineAtMs"],
    ["lastError", "cancelReason", "completedAtMs"],
  );
  if (
    !record ||
    !nonEmptyString(record.operationId) ||
    typeof record.actionDigest !== "string" ||
    !ACTION_DIGEST_PATTERN.test(record.actionDigest) ||
    typeof record.retryClass !== "string" ||
    !RETRY_CLASSES.has(record.retryClass as BrowserRetryClass) ||
    typeof record.status !== "string" ||
    !OPERATION_STATUSES.has(record.status as BrowserOperationStatus) ||
    !finiteNumber(record.startedAtMs) ||
    record.startedAtMs < 0 ||
    !finiteNumber(record.deadlineAtMs) ||
    record.deadlineAtMs < record.startedAtMs
  ) return null;
  const token = decodeToken(record);
  if (!token) return null;
  if (record.lastError !== undefined && typeof record.lastError !== "string") return null;
  if (record.cancelReason !== undefined && typeof record.cancelReason !== "string") return null;
  if (record.completedAtMs !== undefined && !finiteNumber(record.completedAtMs)) return null;

  return {
    operationId: record.operationId,
    actionDigest: record.actionDigest,
    retryClass: record.retryClass as BrowserRetryClass,
    status: record.status as BrowserOperationStatus,
    ...token,
    startedAtMs: record.startedAtMs,
    deadlineAtMs: record.deadlineAtMs,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.cancelReason === undefined ? {} : { cancelReason: record.cancelReason }),
    ...(record.completedAtMs === undefined ? {} : { completedAtMs: record.completedAtMs }),
  };
}

function decodeEvent(value: unknown): BrowserOperationEvent | null {
  const typeRecord = readDataObject(value, ["type", "generation", "attempt"], ["nowMs", "reason", "error", "recoverable", "timeoutMs"]);
  if (!typeRecord || typeof typeRecord.type !== "string") return null;
  const token = decodeToken(typeRecord);
  if (!token) return null;

  switch (typeRecord.type) {
    case "tick": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "nowMs"]);
      return record && finiteNumber(record.nowMs) && record.nowMs >= 0
        ? { type: "tick", nowMs: record.nowMs, ...token }
        : null;
    }
    case "complete": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "nowMs"]);
      return record && finiteNumber(record.nowMs) && record.nowMs >= 0
        ? { type: "complete", nowMs: record.nowMs, ...token }
        : null;
    }
    case "cancel": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "reason"]);
      return record && nonEmptyString(record.reason) ? { type: "cancel", reason: record.reason, ...token } : null;
    }
    case "fail": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "error", "recoverable"]);
      return record && nonEmptyString(record.error) && typeof record.recoverable === "boolean"
        ? { type: "fail", error: record.error, recoverable: record.recoverable, ...token }
        : null;
    }
    case "uncertain": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "error"]);
      return record && nonEmptyString(record.error) ? { type: "uncertain", error: record.error, ...token } : null;
    }
    case "recover": {
      const record = readDataObject(typeRecord, ["type", "generation", "attempt", "nowMs", "timeoutMs"]);
      return record && finiteNumber(record.nowMs) && finiteNumber(record.timeoutMs) && record.nowMs >= 0 && record.timeoutMs >= 0
        ? { type: "recover", nowMs: record.nowMs, timeoutMs: record.timeoutMs, ...token }
        : null;
    }
    default:
      return null;
  }
}

/** Only observation-like commands are safe to repeat after an ambiguous result. */
export function browserActionRetryClass(actionInput: unknown): BrowserRetryClass {
  const action = decodeBrowserAction(actionInput);
  if (!action) return "non_idempotent";
  if (action.type === "screenshot") return "idempotent";
  if (action.type === "selector" && action.operation === "inspect") return "idempotent";
  if (action.type === "coordinate" && action.operation === "move") return "idempotent";
  if (action.type === "clipboard" && action.operation === "read") return "idempotent";
  return "non_idempotent";
}

function isTerminal(status: BrowserOperationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "outcome_unknown" || status === "uncertain";
}

function tokenMatches(state: BrowserOperationState, event: BrowserOperationEvent): boolean {
  return state.generation === event.generation && state.attempt === event.attempt;
}

export function createBrowserOperation(input: CreateBrowserOperationInput): BrowserOperationState {
  const record = readDataObject(input, ["operationId", "action", "startedAtMs", "timeoutMs"]);
  if (
    !record ||
    !nonEmptyString(record.operationId) ||
    !finiteNumber(record.startedAtMs) ||
    record.startedAtMs < 0 ||
    !finiteNumber(record.timeoutMs) ||
    record.timeoutMs < 0 ||
    !Number.isFinite(record.startedAtMs + record.timeoutMs)
  ) return uncertainState(operationIdFrom(input), "invalid-operation-input");
  const action = decodeBrowserAction(record.action);
  if (!action) return uncertainState(record.operationId, "invalid-operation-input");

  return {
    operationId: record.operationId,
    actionDigest: browserActionDigest(action),
    retryClass: browserActionRetryClass(action),
    status: "running",
    generation: 1,
    attempt: 1,
    startedAtMs: record.startedAtMs,
    deadlineAtMs: record.startedAtMs + record.timeoutMs,
  };
}

/** Pure lifecycle reducer. Invalid runtime data fails closed to an uncertain state. */
export function transitionBrowserOperation(stateInput: unknown, eventInput: unknown): BrowserOperationState {
  const state = decodeState(stateInput);
  if (!state) return uncertainState(operationIdFrom(stateInput), "invalid-operation-state");
  if (isTerminal(state.status)) return state;
  const event = decodeEvent(eventInput);
  if (!event) return { ...state, status: "uncertain", lastError: "invalid-operation-event" };
  if (!tokenMatches(state, event)) return state;

  switch (event.type) {
    case "tick":
      if (state.status !== "running" || event.nowMs < state.deadlineAtMs) return state;
      return state.retryClass === "non_idempotent"
        ? { ...state, status: "outcome_unknown", lastError: "operation outcome is unknown after timeout" }
        : { ...state, status: "timed_out", lastError: "operation timed out" };
    case "complete":
      return state.status === "running" ? { ...state, status: "succeeded", completedAtMs: event.nowMs } : state;
    case "cancel":
      return state.status === "running" || state.status === "timed_out" || state.status === "recoverable"
        ? { ...state, status: "cancelled", cancelReason: event.reason }
        : state;
    case "fail":
      if (state.status !== "running") return state;
      if (!event.recoverable) return { ...state, status: "failed", lastError: event.error };
      return state.retryClass === "non_idempotent"
        ? { ...state, status: "outcome_unknown", lastError: event.error }
        : { ...state, status: "recoverable", lastError: event.error };
    case "uncertain":
      return { ...state, status: "uncertain", lastError: event.error };
    case "recover":
      if (state.retryClass !== "idempotent" || (state.status !== "recoverable" && state.status !== "timed_out")) return state;
      if (state.generation >= Number.MAX_SAFE_INTEGER || state.attempt >= Number.MAX_SAFE_INTEGER || !Number.isFinite(event.nowMs + event.timeoutMs)) {
        return { ...state, status: "uncertain", lastError: "invalid-recovery-generation" };
      }
      return {
        operationId: state.operationId,
        actionDigest: state.actionDigest,
        retryClass: state.retryClass,
        status: "running",
        generation: state.generation + 1,
        attempt: state.attempt + 1,
        startedAtMs: event.nowMs,
        deadlineAtMs: event.nowMs + event.timeoutMs,
        lastError: undefined,
        cancelReason: undefined,
        completedAtMs: undefined,
      };
  }
}

function tokenFor(state: BrowserOperationState, token?: BrowserOperationToken): BrowserOperationToken {
  if (token !== undefined) {
    const record = readDataObject(token, ["generation", "attempt"]);
    return record && positiveSafeInteger(record.generation) && positiveSafeInteger(record.attempt)
      ? { generation: record.generation, attempt: record.attempt }
      : { generation: 0, attempt: 0 };
  }
  const decoded = decodeState(state);
  return decoded
    ? { generation: decoded.generation, attempt: decoded.attempt }
    : { generation: 0, attempt: 0 };
}

export function expireBrowserOperation(state: BrowserOperationState, nowMs: number, token?: BrowserOperationToken): BrowserOperationState {
  return transitionBrowserOperation(state, { type: "tick", nowMs, ...tokenFor(state, token) });
}

export function cancelBrowserOperation(state: BrowserOperationState, reason: string, token?: BrowserOperationToken): BrowserOperationState {
  return transitionBrowserOperation(state, { type: "cancel", reason, ...tokenFor(state, token) });
}

export function completeBrowserOperation(state: BrowserOperationState, nowMs: number, token?: BrowserOperationToken): BrowserOperationState {
  return transitionBrowserOperation(state, { type: "complete", nowMs, ...tokenFor(state, token) });
}

export function failBrowserOperation(state: BrowserOperationState, error: string, recoverable: boolean, token?: BrowserOperationToken): BrowserOperationState {
  return transitionBrowserOperation(state, { type: "fail", error, recoverable, ...tokenFor(state, token) });
}

export function recoverBrowserOperation(state: BrowserOperationState, nowMs: number, timeoutMs: number, token?: BrowserOperationToken): BrowserOperationState {
  return transitionBrowserOperation(state, { type: "recover", nowMs, timeoutMs, ...tokenFor(state, token) });
}
