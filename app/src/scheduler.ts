/**
 * Pure, deterministic scheduling and heartbeat domain.
 *
 * This module deliberately has no UI, process, filesystem, network, Prime, or
 * wall-clock dependencies. Every time-sensitive operation receives an epoch
 * millisecond value from its caller. The default time-zone adapter only
 * interprets those supplied instants with Intl; it never reads the current
 * time.
 */

export type SchedulerErrorCode =
  | "invalid_input"
  | "invalid_recurrence"
  | "invalid_timezone"
  | "timezone_data_unavailable"
  | "invalid_time"
  | "unsafe_integer"
  | "dst_gap"
  | "dst_fold"
  | "not_found"
  | "conflict"
  | "occurrence_not_claimable"
  | "retry_not_due"
  | "guardrail_exhausted"
  | "usage_budget_exhausted"
  | "capability_denied"
  | "request_not_allowed"
  | "schedule_disabled"
  | "grant_revoked"
  | "grant_expired"
  | "stale_fencing_epoch"
  | "lease_expired"
  | "lease_mismatch"
  | "run_terminal"
  | "dispatch_not_claimed"
  | "policy_regression"
  | "decode_error";

export interface SchedulerError {
  code: SchedulerErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

declare const schedulerDurableAuthorityBrand: unique symbol;

/** Opaque durable scheduler authority. Production construction is intentionally unavailable. */
export interface SchedulerDurableAuthority {
  readonly kind: "scheduler-durable-authority";
  readonly [schedulerDurableAuthorityBrand]: true;
}

export interface ScheduleEnablementEvidence {
  scheduleId: string;
  generation: number;
  enabled: boolean;
  changedAtMs: number;
}

export interface SchedulerDurableEvidence {
  authorityId: string;
  lineageId: string;
  revision: number;
  fencingEpochHighWater: number;
  sequenceHighWater: number;
  scheduleEnablement: ScheduleEnablementEvidence[];
  attestationId: string;
}

interface SchedulerAuthorityState {
  authorityId: string;
  nextLineage: number;
  lineages: Map<string, SchedulerDurableAttestation>;
  initialFencingHistory: FencingEpochRecord[];
  initialSequenceHighWater: number;
}

interface SchedulerDurableAttestation {
  evidence: SchedulerDurableEvidence;
  stateCommitment: string;
}

const schedulerAuthorityStates = new WeakMap<object, SchedulerAuthorityState>();
let schedulerTestAuthoritySequence = 0;

interface SchedulerDurableAuthorityTestOptions {
  initialFencingRecord?: FencingEpochRecord;
  initialSequenceHighWater?: number;
}

function createSchedulerDurableAuthorityForTests(
  options: SchedulerDurableAuthorityTestOptions = {},
): SchedulerDurableAuthority {
  const initialSequenceHighWater = options.initialSequenceHighWater ?? 0;
  if (!isSafeNonNegativeInteger(initialSequenceHighWater)) {
    throw new Error("initialSequenceHighWater must be a non-negative safe integer");
  }
  const initialFencingHistory = options.initialFencingRecord ? [cloneJson(options.initialFencingRecord)] : [];
  let initialGeneratedSequenceHighWater = 0;
  if (initialFencingHistory.length !== 0) {
    const record = initialFencingHistory[0];
    if (!isSafePositiveInteger(record.fencingEpoch) || typeof record.leaderLeaseId !== "string"
      || !record.leaderLeaseId || typeof record.holderId !== "string" || !record.holderId
      || !isSafeInteger(record.issuedAtMs)) {
      throw new Error("initialFencingRecord is invalid");
    }
    const generatedLeaseSuffix = generatedSequenceSuffix(record.leaderLeaseId, "leader");
    if (!generatedLeaseSuffix.ok || generatedLeaseSuffix.value === 0) {
      throw new Error("initialFencingRecord leaderLeaseId must be scheduler-generated");
    }
    initialGeneratedSequenceHighWater = generatedLeaseSuffix.value;
  }
  schedulerTestAuthoritySequence += 1;
  const authority = Object.freeze({ kind: "scheduler-durable-authority" }) as SchedulerDurableAuthority;
  schedulerAuthorityStates.set(authority, {
    authorityId: `scheduler-test-authority-${schedulerTestAuthoritySequence}`,
    nextLineage: 0,
    lineages: new Map(),
    initialFencingHistory,
    initialSequenceHighWater: Math.max(initialSequenceHighWater, initialGeneratedSequenceHighWater),
  });
  return authority;
}

/** In-memory authority exists only in Vitest; production must inject its authenticated native equivalent. */
export const schedulerTestOnly = import.meta.env.MODE === "test"
  ? Object.freeze({ createDurableAuthority: createSchedulerDurableAuthorityForTests })
  : undefined;

export type SchedulerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SchedulerError };

const ok = <T>(value: T): SchedulerResult<T> => ({ ok: true, value });

const fail = <T = never>(
  code: SchedulerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SchedulerResult<T> => ({ ok: false, error: { code, message, details } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value >= 0;

const isSafePositiveInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value > 0;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const MIN_SUPPORTED_TIMESTAMP_MS = -8_640_000_000_000_000;
const MAX_SUPPORTED_TIMESTAMP_MS = 8_640_000_000_000_000;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return value;
}

function copyGrant(grant: GrantSnapshot): GrantSnapshot {
  return deepFreeze(cloneJson(grant));
}

function copySchedule(schedule: Schedule): Schedule {
  return { ...cloneJson(schedule), grantSnapshot: copyGrant(schedule.grantSnapshot) };
}

function copyOccurrence(occurrence: Occurrence): Occurrence {
  return { ...cloneJson(occurrence), grantSnapshot: copyGrant(occurrence.grantSnapshot) };
}

function copyRun(run: ScheduledRun): ScheduledRun {
  return { ...cloneJson(run), grantSnapshot: copyGrant(run.grantSnapshot) };
}

function copyPolicy(policy: CurrentPolicy): CurrentPolicy {
  return cloneJson(policy);
}

function safeTimestamp(value: unknown, field: string): SchedulerResult<number> {
  if (!isSafeInteger(value)) return fail("unsafe_integer", `${field} must be a safe integer`);
  if (value < MIN_SUPPORTED_TIMESTAMP_MS || value > MAX_SUPPORTED_TIMESTAMP_MS) {
    return fail("invalid_time", `${field} is outside the supported Date range`);
  }
  return ok(value);
}

function checkedTimestampAdd(base: number, delta: number, field: string): SchedulerResult<number> {
  if (!isSafeInteger(base) || !isSafeInteger(delta)) return fail("unsafe_integer", `${field} operands must be safe integers`);
  const result = base + delta;
  if (!Number.isSafeInteger(result)) return fail("unsafe_integer", `${field} exceeds the safe integer range`);
  return safeTimestamp(result, field);
}

function checkedNonNegativeMultiply(left: number, right: number, field: string): SchedulerResult<number> {
  if (!isSafeNonNegativeInteger(left) || !isSafeNonNegativeInteger(right)) {
    return fail("unsafe_integer", `${field} operands must be non-negative safe integers`);
  }
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    return fail("unsafe_integer", `${field} exceeds the safe integer range`);
  }
  return ok(left * right);
}

function checkedIntegerMultiply(left: number, right: number, field: string): SchedulerResult<number> {
  if (!isSafeInteger(left) || !isSafeInteger(right)) return fail("unsafe_integer", `${field} operands must be safe integers`);
  if (left !== 0 && Math.abs(right) > Math.floor(Number.MAX_SAFE_INTEGER / Math.abs(left))) {
    return fail("unsafe_integer", `${field} exceeds the safe integer range`);
  }
  const result = left * right;
  return Number.isSafeInteger(result) ? ok(result) : fail("unsafe_integer", `${field} exceeds the safe integer range`);
}

function safeNonNegative(value: unknown, field: string): SchedulerResult<number> {
  if (!isSafeNonNegativeInteger(value)) return fail("unsafe_integer", `${field} must be a non-negative safe integer`);
  return ok(value);
}

function nonEmptyString(value: unknown, field: string): SchedulerResult<string> {
  if (typeof value !== "string" || value.trim() === "") return fail("invalid_input", `${field} must be non-empty`);
  return ok(value);
}

function boundedString(value: unknown, field: string, maxLength: number): SchedulerResult<string> {
  const checked = nonEmptyString(value, field);
  if (!checked.ok) return checked;
  if (checked.value.length > maxLength) return fail("invalid_input", `${field} exceeds ${maxLength} characters`);
  return checked;
}

function checkOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): SchedulerResult<void> {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) return fail("decode_error", `unexpected field: ${unexpected}`);
  return ok(undefined);
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type DstGapPolicy = "skip" | "shift-forward" | "shift-backward" | "reject";
export type DstFoldPolicy = "earlier" | "later" | "reject";

export interface TimeZoneAdapter {
  timeZoneData(timeZone: string): SchedulerResult<TimeZoneDataBinding>;
  localParts(instantMs: number, timeZone: string): LocalDateTime;
  resolveLocal(
    local: LocalDateTime,
    timeZone: string,
    gapPolicy: DstGapPolicy,
    foldPolicy: DstFoldPolicy,
  ): SchedulerResult<number | null>;
}

export interface TimeZoneDataBinding {
  source: "iana";
  version: string;
  fingerprint: string;
  provenance: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_RECURRENCE_SEARCH = 200_000;
export const RECURRENCE_NORMALIZATION_VERSION = 1;

function localNaiveMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
}

function localFromNaiveMs(naiveMs: number): LocalDateTime {
  const date = new Date(naiveMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

function addCivilDays(local: LocalDateTime, days: number): SchedulerResult<LocalDateTime> {
  const delta = checkedIntegerMultiply(days, DAY_MS, "civil-day offset");
  if (!delta.ok) return delta;
  const timestamp = checkedTimestampAdd(localNaiveMs(local), delta.value, "civil date");
  if (!timestamp.ok) return timestamp;
  return ok(localFromNaiveMs(timestamp.value));
}

function dateOnly(local: LocalDateTime): LocalDateTime {
  return { ...local, hour: 0, minute: 0, second: 0 };
}

function dayOfWeek(local: LocalDateTime): number {
  return new Date(localNaiveMs(dateOnly(local))).getUTCDay();
}

function daysBetween(a: LocalDateTime, b: LocalDateTime): number {
  return Math.floor((localNaiveMs(dateOnly(b)) - localNaiveMs(dateOnly(a))) / DAY_MS);
}

function validateLocal(local: unknown, field = "local time"): SchedulerResult<LocalDateTime> {
  if (!isRecord(local)) return fail("invalid_recurrence", `${field} must be an object`);
  const keys = checkOnlyKeys(local, ["year", "month", "day", "hour", "minute", "second"]);
  if (!keys.ok) return keys;
  const fields = ["year", "month", "day", "hour", "minute", "second"] as const;
  for (const name of fields) {
    if (!isSafeInteger(local[name])) return fail("unsafe_integer", `${field}.${name} must be a safe integer`);
  }
  const result: LocalDateTime = {
    year: local.year as number,
    month: local.month as number,
    day: local.day as number,
    hour: local.hour as number,
    minute: local.minute as number,
    second: local.second as number,
  };
  if (result.year < 1970 || result.year > 9999) return fail("invalid_recurrence", `${field}.year is out of range`);
  if (result.month < 1 || result.month > 12) return fail("invalid_recurrence", `${field}.month is out of range`);
  if (result.hour < 0 || result.hour > 23) return fail("invalid_recurrence", `${field}.hour is out of range`);
  if (result.minute < 0 || result.minute > 59) return fail("invalid_recurrence", `${field}.minute is out of range`);
  if (result.second < 0 || result.second > 59) return fail("invalid_recurrence", `${field}.second is out of range`);
  const date = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (
    result.day < 1 ||
    result.day > 31 ||
    date.getUTCFullYear() !== result.year ||
    date.getUTCMonth() !== result.month - 1 ||
    date.getUTCDate() !== result.day
  ) {
    return fail("invalid_recurrence", `${field}.day is not valid for the month`);
  }
  return ok(result);
}

function validateTimeZone(timeZone: unknown): SchedulerResult<string> {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return fail("invalid_timezone", "timeZone must be non-empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    return fail("invalid_timezone", `unsupported time zone: ${timeZone}`);
  }
  return ok(timeZone);
}

export class IntlTimeZoneAdapter implements TimeZoneAdapter {
  private readonly formatters = new Map<string, Intl.DateTimeFormat>();

  public constructor(private readonly binding?: TimeZoneDataBinding) {}

  private formatter(timeZone: string): Intl.DateTimeFormat {
    const existing = this.formatters.get(timeZone);
    if (existing) return existing;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    this.formatters.set(timeZone, formatter);
    return formatter;
  }

  localParts(instantMs: number, timeZone: string): LocalDateTime {
    const parts: Record<string, number> = {};
    for (const part of this.formatter(timeZone).formatToParts(new Date(instantMs))) {
      if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute" || part.type === "second") {
        parts[part.type] = Number(part.value);
      }
    }
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour === 24 ? 0 : parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
  }

  private offsetAt(instantMs: number, timeZone: string): number {
    return localNaiveMs(this.localParts(instantMs, timeZone)) - instantMs;
  }

  public timeZoneData(timeZone: string): SchedulerResult<TimeZoneDataBinding> {
    try {
      this.formatter(timeZone).resolvedOptions().timeZone;
    } catch {
      return fail("timezone_data_unavailable", `time-zone data is unavailable for ${timeZone}`);
    }
    if (!this.binding) {
      return fail("timezone_data_unavailable", "ambient Intl time-zone data has no authoritative version or provenance");
    }
    const checked = validateTimeZoneDataBinding(this.binding);
    return checked.ok ? ok(cloneJson(checked.value)) : checked;
  }

  private offsetsNear(naiveMs: number, timeZone: string): number[] {
    const offsets = new Set<number>();
    for (let delta = -3 * DAY_MS; delta <= 3 * DAY_MS; delta += 30 * MINUTE_MS) {
      offsets.add(this.offsetAt(naiveMs + delta, timeZone));
    }
    return [...offsets];
  }

  resolveLocal(
    local: LocalDateTime,
    timeZone: string,
    gapPolicy: DstGapPolicy,
    foldPolicy: DstFoldPolicy,
  ): SchedulerResult<number | null> {
    const naiveMs = localNaiveMs(local);
    const candidates = this.offsetsNear(naiveMs, timeZone)
      .map((offset) => naiveMs - offset)
      .filter((instantMs, index, all) => all.indexOf(instantMs) === index)
      .filter((instantMs) => sameLocal(this.localParts(instantMs, timeZone), local))
      .sort((a, b) => a - b);

    if (candidates.length === 1) return ok(candidates[0]);
    if (candidates.length > 1) {
      if (foldPolicy === "reject") return fail("dst_fold", "local time occurs twice");
      return ok(foldPolicy === "earlier" ? candidates[0] : candidates[candidates.length - 1]);
    }

    if (gapPolicy === "skip") return ok(null);
    if (gapPolicy === "reject") return fail("dst_gap", "local time does not exist");

    const offsets = this.offsetsNear(naiveMs, timeZone);
    const positiveJump = Math.max(...offsets) - Math.min(...offsets);
    const direction = gapPolicy === "shift-forward" ? 1 : -1;
    const shiftedNaive = naiveMs + direction * (positiveJump > 0 ? positiveJump : HOUR_MS);
    const shifted = this.resolveLocal(localFromNaiveMs(shiftedNaive), timeZone, "skip", foldPolicy);
    if (shifted.ok && shifted.value !== null) return shifted;

    for (let minutes = 1; minutes <= 2 * 24 * 60; minutes++) {
      const candidate = this.resolveLocal(
        localFromNaiveMs(naiveMs + direction * minutes * MINUTE_MS),
        timeZone,
        "skip",
        foldPolicy,
      );
      if (candidate.ok && candidate.value !== null) return candidate;
    }
    return fail("dst_gap", "could not resolve a shifted local time");
  }
}

export const defaultTimeZoneAdapter = new IntlTimeZoneAdapter();

export function captureTimeZoneData(
  timeZone: string,
  adapter: TimeZoneAdapter = defaultTimeZoneAdapter,
): SchedulerResult<TimeZoneDataBinding> {
  const checked = validateTimeZone(timeZone);
  if (!checked.ok) return checked;
  const binding = adapter.timeZoneData(checked.value);
  if (!binding.ok) return binding;
  return validateTimeZoneDataBinding(binding.value);
}

export type ScheduleRecurrence =
  | { kind: "one-shot"; atMs: number }
  | { kind: "daily"; startLocal: LocalDateTime; everyDays: number }
  | { kind: "weekly"; startLocal: LocalDateTime; everyWeeks: number; weekdays: number[] };

export interface NextRunInput {
  recurrence: ScheduleRecurrence;
  timezone: string;
  timezoneData: TimeZoneDataBinding;
  afterMs: number;
  dstGapPolicy: DstGapPolicy;
  dstFoldPolicy: DstFoldPolicy;
}

function validateTimeZoneDataBinding(value: unknown): SchedulerResult<TimeZoneDataBinding> {
  if (!isRecord(value)) return fail("timezone_data_unavailable", "time-zone data binding must be explicit");
  const keys = checkOnlyKeys(value, ["source", "version", "fingerprint", "provenance"]);
  if (!keys.ok) return fail("timezone_data_unavailable", keys.error.message);
  if (value.source !== "iana" || typeof value.version !== "string" || value.version.trim() === "" || value.version.length > 64) {
    return fail("timezone_data_unavailable", "time-zone data version is invalid");
  }
  if (typeof value.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
    return fail("timezone_data_unavailable", "time-zone data fingerprint must be an explicit SHA-256 digest");
  }
  if (typeof value.provenance !== "string" || value.provenance.trim() === "" || value.provenance.length > 256) {
    return fail("timezone_data_unavailable", "time-zone data provenance is invalid");
  }
  return ok({ source: "iana", version: value.version, fingerprint: value.fingerprint, provenance: value.provenance });
}

function requireTimeZoneData(
  expected: unknown,
  timeZone: string,
  adapter: TimeZoneAdapter,
): SchedulerResult<TimeZoneDataBinding> {
  const checked = validateTimeZoneDataBinding(expected);
  if (!checked.ok) return checked;
  const actual = adapter.timeZoneData(timeZone);
  if (!actual.ok) return actual;
  const actualBinding = validateTimeZoneDataBinding(actual.value);
  if (!actualBinding.ok) return actualBinding;
  if (
    actualBinding.value.source !== checked.value.source ||
    actualBinding.value.version !== checked.value.version ||
    actualBinding.value.fingerprint !== checked.value.fingerprint ||
    actualBinding.value.provenance !== checked.value.provenance
  ) {
    return fail("timezone_data_unavailable", "pinned time-zone data is not available in this runtime", {
      expected: checked.value,
      actual: actualBinding.value,
    });
  }
  return checked;
}

function validateRecurrence(recurrence: unknown): SchedulerResult<ScheduleRecurrence> {
  if (!isRecord(recurrence) || typeof recurrence.kind !== "string") {
    return fail("invalid_recurrence", "recurrence must name a supported kind");
  }
  if (recurrence.kind === "one-shot") {
    const keys = checkOnlyKeys(recurrence, ["kind", "atMs"]);
    if (!keys.ok) return fail("decode_error", keys.error.message);
    const atMs = safeTimestamp(recurrence.atMs, "recurrence.atMs");
    if (!atMs.ok) return atMs;
    return ok({ kind: "one-shot", atMs: atMs.value });
  }
  if (recurrence.kind === "daily") {
    const keys = checkOnlyKeys(recurrence, ["kind", "startLocal", "everyDays"]);
    if (!keys.ok) return fail("decode_error", keys.error.message);
    const startLocal = validateLocal(recurrence.startLocal, "recurrence.startLocal");
    if (!startLocal.ok) return startLocal;
    if (!isSafePositiveInteger(recurrence.everyDays)) return fail("invalid_recurrence", "everyDays must be positive");
    return ok({ kind: "daily", startLocal: startLocal.value, everyDays: recurrence.everyDays });
  }
  if (recurrence.kind === "weekly") {
    const keys = checkOnlyKeys(recurrence, ["kind", "startLocal", "everyWeeks", "weekdays"]);
    if (!keys.ok) return fail("decode_error", keys.error.message);
    const startLocal = validateLocal(recurrence.startLocal, "recurrence.startLocal");
    if (!startLocal.ok) return startLocal;
    if (!isSafePositiveInteger(recurrence.everyWeeks)) return fail("invalid_recurrence", "everyWeeks must be positive");
    if (!Array.isArray(recurrence.weekdays) || recurrence.weekdays.length === 0) {
      return fail("invalid_recurrence", "weekdays must not be empty");
    }
    const weekdays = recurrence.weekdays.map((day) => (typeof day === "number" ? day : NaN));
    if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(weekdays).size !== weekdays.length) {
      return fail("invalid_recurrence", "weekdays must contain unique values from 0 through 6");
    }
    return ok({ kind: "weekly", startLocal: startLocal.value, everyWeeks: recurrence.everyWeeks, weekdays: [...weekdays].sort((a, b) => a - b) });
  }
  return fail("invalid_recurrence", `unsupported recurrence kind: ${recurrence.kind}`);
}

function resolveCandidate(
  local: LocalDateTime,
  timeZone: string,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
  adapter: TimeZoneAdapter,
): SchedulerResult<number | null> {
  return adapter.resolveLocal(local, timeZone, gapPolicy, foldPolicy);
}

function nextDaily(
  recurrence: Extract<ScheduleRecurrence, { kind: "daily" }>,
  timeZone: string,
  afterMs: number,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
  adapter: TimeZoneAdapter,
): SchedulerResult<number | null> {
  const afterLocal = adapter.localParts(afterMs, timeZone);
  const startNaive = localNaiveMs(recurrence.startLocal);
  const afterNaive = localNaiveMs(afterLocal);
  const roughIndex = Math.max(0, Math.floor((afterNaive - startNaive) / DAY_MS / recurrence.everyDays));
  for (let index = roughIndex; index < roughIndex + MAX_RECURRENCE_SEARCH; index++) {
    const dayOffset = checkedNonNegativeMultiply(index, recurrence.everyDays, "daily recurrence offset");
    if (!dayOffset.ok) return dayOffset;
    const local = addCivilDays(recurrence.startLocal, dayOffset.value);
    if (!local.ok) return local;
    const resolved = resolveCandidate(local.value, timeZone, gapPolicy, foldPolicy, adapter);
    if (!resolved.ok) return resolved;
    if (resolved.value !== null && resolved.value > afterMs) return resolved;
  }
  return fail("invalid_recurrence", "recurrence search exceeded its deterministic bound");
}

function nextWeekly(
  recurrence: Extract<ScheduleRecurrence, { kind: "weekly" }>,
  timeZone: string,
  afterMs: number,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
  adapter: TimeZoneAdapter,
): SchedulerResult<number | null> {
  const afterLocal = adapter.localParts(afterMs, timeZone);
  const startDate = dateOnly(recurrence.startLocal);
  const startWeek = addCivilDays(startDate, -dayOfWeek(startDate));
  if (!startWeek.ok) return startWeek;
  const afterDate = dateOnly(afterLocal);
  const afterWeek = addCivilDays(afterDate, -dayOfWeek(afterDate));
  if (!afterWeek.ok) return afterWeek;
  const blockDays = checkedNonNegativeMultiply(7, recurrence.everyWeeks, "weekly recurrence interval");
  if (!blockDays.ok) return blockDays;
  const roughBlock = Math.max(0, Math.floor(daysBetween(startWeek.value, afterWeek.value) / blockDays.value));

  for (let block = roughBlock; block < roughBlock + MAX_RECURRENCE_SEARCH; block++) {
    const blockOffset = checkedNonNegativeMultiply(block, blockDays.value, "weekly recurrence offset");
    if (!blockOffset.ok) return blockOffset;
    const blockStart = addCivilDays(startWeek.value, blockOffset.value);
    if (!blockStart.ok) return blockStart;
    for (const weekday of recurrence.weekdays) {
      const candidateDate = addCivilDays(blockStart.value, weekday);
      if (!candidateDate.ok) return candidateDate;
      const local = {
        ...candidateDate.value,
        hour: recurrence.startLocal.hour,
        minute: recurrence.startLocal.minute,
        second: recurrence.startLocal.second,
      };
      if (localNaiveMs(local) < localNaiveMs(recurrence.startLocal)) continue;
      const resolved = resolveCandidate(local, timeZone, gapPolicy, foldPolicy, adapter);
      if (!resolved.ok) return resolved;
      if (resolved.value !== null && resolved.value > afterMs) return resolved;
    }
  }
  return fail("invalid_recurrence", "recurrence search exceeded its deterministic bound");
}

export function calculateNextRun(input: NextRunInput, adapter: TimeZoneAdapter = defaultTimeZoneAdapter): SchedulerResult<number | null> {
  if (!isRecord(input)) return fail("invalid_input", "next-run input must be an object");
  const inputKeys = checkOnlyKeys(input, ["recurrence", "timezone", "timezoneData", "afterMs", "dstGapPolicy", "dstFoldPolicy"]);
  if (!inputKeys.ok) return inputKeys;
  const afterMs = safeTimestamp(input.afterMs, "afterMs");
  if (!afterMs.ok) return afterMs;
  const timeZone = validateTimeZone(input.timezone);
  if (!timeZone.ok) return timeZone;
  const timeZoneData = requireTimeZoneData(input.timezoneData, timeZone.value, adapter);
  if (!timeZoneData.ok) return timeZoneData;
  const recurrence = validateRecurrence(input.recurrence);
  if (!recurrence.ok) return recurrence;
  if (!["skip", "shift-forward", "shift-backward", "reject"].includes(input.dstGapPolicy)) {
    return fail("invalid_recurrence", "unsupported DST gap policy");
  }
  if (!["earlier", "later", "reject"].includes(input.dstFoldPolicy)) {
    return fail("invalid_recurrence", "unsupported DST fold policy");
  }

  if (recurrence.value.kind === "one-shot") return ok(recurrence.value.atMs > afterMs.value ? recurrence.value.atMs : null);
  if (recurrence.value.kind === "daily") {
    return nextDaily(recurrence.value, timeZone.value, afterMs.value, input.dstGapPolicy, input.dstFoldPolicy, adapter);
  }
  return nextWeekly(recurrence.value, timeZone.value, afterMs.value, input.dstGapPolicy, input.dstFoldPolicy, adapter);
}

export interface Owner {
  projectId: string;
  chatId: string;
  agentId?: string;
}

export interface TaskDefinition {
  id: string;
  revision: number;
  owner: Owner;
  instructions: string;
  request: { provider: string; model: string };
  execution: { kind: "project" | "worktree"; rootId: string };
}

export interface GrantSnapshot {
  grantId: string;
  policyVersion: number;
  epoch: number;
  issuedAtMs: number;
  expiresAtMs: number | null;
  scope: Owner & { capabilities: string[] };
}

export interface CurrentPolicy {
  policyVersion: number;
  epoch: number;
  revokedGrantIds: string[];
  concurrency: PolicyConcurrencyCaps;
  usage: PolicyUsageLimits;
}

export interface PolicyConcurrencyCaps {
  global: number;
  perProject: number;
  perAgent: number;
}

export interface UsageBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCacheReadTokens: number;
  maxCacheWriteTokens: number;
  maxTotalTokens: number;
}

export interface ProviderModel {
  provider: string;
  model: string;
}

export interface PolicyUsageLimits {
  allowedRequests: ProviderModel[];
  perRun: UsageBudget;
  aggregate: UsageBudget;
}

export type MissedRunPolicy =
  | { kind: "latest-only" }
  | { kind: "skip" }
  | { kind: "all"; maxCatchUp: number };

export type MissedRunPolicyInput = MissedRunPolicy;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  multiplier: number;
  maxBackoffMs: number;
}

export interface ScheduleConcurrencyCaps {
  perSchedule: number;
}

export interface ScheduleInput {
  id: string;
  task: TaskDefinition;
  recurrence: ScheduleRecurrence;
  timezone: string;
  timezoneData: TimeZoneDataBinding;
  recurrenceNormalizationVersion: number;
  dstGapPolicy: DstGapPolicy;
  dstFoldPolicy: DstFoldPolicy;
  missedRunPolicy: MissedRunPolicyInput;
  grant: GrantSnapshot;
  retry: RetryPolicy;
  concurrency: ScheduleConcurrencyCaps;
  claimLeaseMs: number;
  createdAtMs: number;
  enabled: boolean;
}

export interface Schedule extends Omit<ScheduleInput, "missedRunPolicy" | "grant"> {
  missedRunPolicy: MissedRunPolicy;
  grantSnapshot: GrantSnapshot;
  enabled: boolean;
  enablementGeneration: number;
  enablementChangedAtMs: number;
  cursorMs: number;
  nextRunAtMs: number | null;
}

export type TerminalOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked-before-action"
  | "missed"
  | "skipped"
  | "outcome_unknown"
  | "guardrail_exhausted";

export type OccurrenceStatus = "pending" | "claimed" | "dispatch_committed" | "running" | "cancellation_requested" | "retry_wait" | TerminalOutcome;
export type RunStatus = "claimed" | "dispatch_committed" | "running" | "cancellation_requested" | TerminalOutcome;

export interface OccurrenceKey {
  scheduleId: string;
  taskRevision: number;
  scheduledInstantMs: number;
}

export interface Occurrence {
  key: string;
  scheduleId: string;
  taskRevision: number;
  scheduledInstantMs: number;
  createdAtMs: number;
  status: OccurrenceStatus;
  attemptCount: number;
  nextRetryAtMs?: number;
  activeRunId?: string;
  runIds: string[];
  grantSnapshot: GrantSnapshot;
  reason?: string;
}

export interface LeaderLease {
  leaseId: string;
  holderId: string;
  fencingEpoch: number;
  issuedAtMs: number;
  expiresAtMs: number;
  durationMs: number;
}

export interface FencingEpochRecord {
  fencingEpoch: number;
  leaderLeaseId: string;
  holderId: string;
  issuedAtMs: number;
}

export interface RunLease {
  leaseId: string;
  runId: string;
  holderId: string;
  fencingEpoch: number;
  issuedAtMs: number;
  expiresAtMs: number;
  durationMs: number;
}

export interface ScheduledRun {
  id: string;
  occurrenceKey: string;
  scheduleId: string;
  taskRevision: number;
  attempt: number;
  owner: Owner;
  request: { provider: string; model: string };
  grantSnapshot: GrantSnapshot;
  status: RunStatus;
  admittedAtMs: number;
  admissionFencingEpoch: number;
  lease?: RunLease;
  dispatch?: { committedAtMs: number; fencingEpoch: number };
  usageBudget?: UsageBudget;
  cancellationRequestedAtMs?: number;
  terminalAtMs?: number;
  outcome?: TerminalOutcome;
  reason?: string;
  retryScheduledAtMs?: number;
  usageObservationIds: string[];
}

export interface DispatchTicket {
  runId: string;
  occurrenceKey: string;
  fencingEpoch: number;
  grantId: string;
  grantEpoch: number;
  policyVersion: number;
  committedAtMs: number;
  usageBudget: UsageBudget;
  aggregateRemaining: UsageBudget;
}

export interface UsageObservation {
  observationId: string;
  runId: string;
  observedAtMs: number;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  source: "reported" | "derived" | "estimated";
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SkippedSpan {
  scheduleId: string;
  taskRevision: number;
  startMs: number;
  endMs: number;
  count: number;
  reason: "missed-catch-up-compressed" | "missed-policy-skip";
}

export interface SchedulerState {
  schemaVersion: 4;
  sequence: number;
  nextFencingEpoch: number;
  fencingEpochHistory: FencingEpochRecord[];
  durableEvidence: SchedulerDurableEvidence;
  policy: CurrentPolicy;
  leader: LeaderLease | null;
  schedules: Record<string, Schedule>;
  occurrences: Record<string, Occurrence>;
  runs: Record<string, ScheduledRun>;
  usage: Record<string, UsageObservation>;
  skippedSpans: SkippedSpan[];
}

function authorityState(authority: SchedulerDurableAuthority | undefined): SchedulerResult<SchedulerAuthorityState> {
  if (!authority || !schedulerAuthorityStates.has(authority)) {
    return fail("decode_error", "durable scheduler authority is unavailable or unauthenticated");
  }
  return ok(schedulerAuthorityStates.get(authority)!);
}

function copyDurableEvidence(evidence: SchedulerDurableEvidence): SchedulerDurableEvidence {
  return cloneJson(evidence);
}

function sameDurableEvidence(left: SchedulerDurableEvidence, right: SchedulerDurableEvidence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) canonical[key] = canonicalJsonValue(value[key]);
  }
  return canonical;
}

function durableStateCommitment(state: SchedulerState): string {
  const { durableEvidence: _durableEvidence, ...committedState } = state;
  return JSON.stringify(canonicalJsonValue(committedState));
}

function scheduleEnablementEvidence(schedules: Record<string, Schedule>): ScheduleEnablementEvidence[] {
  return Object.values(schedules)
    .map((schedule) => ({
      scheduleId: schedule.id,
      generation: schedule.enablementGeneration,
      enabled: schedule.enabled,
      changedAtMs: schedule.enablementChangedAtMs,
    }))
    .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
}

function initializeDurableEvidence(authenticated: SchedulerAuthorityState): SchedulerResult<SchedulerDurableEvidence> {
  if (authenticated.nextLineage >= Number.MAX_SAFE_INTEGER) {
    return fail("unsafe_integer", "durable scheduler authority lineage counter is exhausted");
  }
  authenticated.nextLineage += 1;
  const lineageId = `${authenticated.authorityId}:lineage-${authenticated.nextLineage}`;
  const initialFencingEpoch = authenticated.initialFencingHistory[0]?.fencingEpoch ?? 0;
  const evidence: SchedulerDurableEvidence = {
    authorityId: authenticated.authorityId,
    lineageId,
    revision: 0,
    fencingEpochHighWater: initialFencingEpoch,
    sequenceHighWater: authenticated.initialSequenceHighWater,
    scheduleEnablement: [],
    attestationId: `${lineageId}:revision-0`,
  };
  return ok(evidence);
}

function authenticateInitialDurableState(
  authenticated: SchedulerAuthorityState,
  state: SchedulerState,
): void {
  authenticated.lineages.set(state.durableEvidence.lineageId, {
    evidence: copyDurableEvidence(state.durableEvidence),
    stateCommitment: durableStateCommitment(state),
  });
}

function attestDurableState(
  authority: SchedulerDurableAuthority | undefined,
  state: SchedulerState,
): SchedulerResult<SchedulerDurableEvidence> {
  const authenticated = authorityState(authority);
  if (!authenticated.ok) return authenticated;
  const attestation = authenticated.value.lineages.get(state.durableEvidence.lineageId);
  if (!attestation || !sameDurableEvidence(attestation.evidence, state.durableEvidence)
    || attestation.evidence.authorityId !== authenticated.value.authorityId) {
    return fail("decode_error", "durable scheduler evidence is stale or unauthenticated");
  }
  const current = attestation.evidence;
  if (state.nextFencingEpoch < current.fencingEpochHighWater || state.sequence < current.sequenceHighWater) {
    return fail("decode_error", "scheduler durable high-water cannot move backwards");
  }
  const enablement = scheduleEnablementEvidence(state.schedules);
  const priorById = new Map(current.scheduleEnablement.map((entry) => [entry.scheduleId, entry]));
  for (const entry of enablement) {
    const prior = priorById.get(entry.scheduleId);
    if (prior && (entry.generation < prior.generation || entry.changedAtMs < prior.changedAtMs
      || (entry.generation === prior.generation
        && (entry.enabled !== prior.enabled || entry.changedAtMs !== prior.changedAtMs)))) {
      return fail("decode_error", "schedule enablement authority high-water cannot move backwards or fork");
    }
    priorById.delete(entry.scheduleId);
  }
  if (priorById.size !== 0) return fail("decode_error", "an attested schedule cannot disappear from durable state");
  const stateCommitment = durableStateCommitment(state);
  const changed = stateCommitment !== attestation.stateCommitment;
  if (!changed) return ok(copyDurableEvidence(current));
  if (current.revision >= Number.MAX_SAFE_INTEGER) return fail("unsafe_integer", "durable scheduler evidence revision is exhausted");
  const revision = current.revision + 1;
  const next: SchedulerDurableEvidence = {
    authorityId: current.authorityId,
    lineageId: current.lineageId,
    revision,
    fencingEpochHighWater: state.nextFencingEpoch,
    sequenceHighWater: state.sequence,
    scheduleEnablement: enablement,
    attestationId: `${current.lineageId}:revision-${revision}`,
  };
  authenticated.value.lineages.set(next.lineageId, {
    evidence: copyDurableEvidence(next),
    stateCommitment,
  });
  return ok(next);
}

export interface Materialization {
  created: Occurrence[];
  skippedSpans: SkippedSpan[];
}

export interface ClaimedRun {
  run: ScheduledRun;
  occurrence: Occurrence;
  runLease: RunLease;
}

export type RunCompletion =
  | { outcome: "succeeded" }
  | { outcome: "cancelled"; reason?: string }
  | { outcome: "outcome_unknown"; reason: string }
  | { outcome: "failed"; retryable: boolean; reason: string };

export interface RecoveryReport {
  expiredLeader: boolean;
  reclaimedBeforeDispatch: number;
  markedOutcomeUnknown: number;
}

function validatePolicy(policy: unknown): SchedulerResult<CurrentPolicy> {
  if (!isRecord(policy)) return fail("invalid_input", "policy must be an object");
  const keys = checkOnlyKeys(policy, ["policyVersion", "epoch", "revokedGrantIds", "concurrency", "usage"]);
  if (!keys.ok) return keys;
  if (!isSafeNonNegativeInteger(policy.policyVersion) || !isSafeNonNegativeInteger(policy.epoch)) {
    return fail("unsafe_integer", "policy versions must be non-negative safe integers");
  }
  if (!Array.isArray(policy.revokedGrantIds) || policy.revokedGrantIds.some((id) => typeof id !== "string")) {
    return fail("invalid_input", "revokedGrantIds must be an array of strings");
  }
  const concurrency = validatePolicyConcurrency(policy.concurrency);
  if (!concurrency.ok) return concurrency;
  const usage = validatePolicyUsage(policy.usage);
  if (!usage.ok) return usage;
  return ok({
    policyVersion: policy.policyVersion,
    epoch: policy.epoch,
    revokedGrantIds: [...new Set(policy.revokedGrantIds as string[])],
    concurrency: concurrency.value,
    usage: usage.value,
  });
}

function validatePolicyConcurrency(value: unknown): SchedulerResult<PolicyConcurrencyCaps> {
  if (!isRecord(value)) return fail("invalid_input", "policy.concurrency must be an object");
  const keys = checkOnlyKeys(value, ["global", "perProject", "perAgent"]);
  if (!keys.ok) return keys;
  for (const field of ["global", "perProject", "perAgent"] as const) {
    if (!isSafePositiveInteger(value[field])) return fail("invalid_input", `policy.concurrency.${field} must be positive`);
  }
  return ok({
    global: value.global as number,
    perProject: value.perProject as number,
    perAgent: value.perAgent as number,
  });
}

const USAGE_BUDGET_FIELDS = [
  "maxInputTokens",
  "maxOutputTokens",
  "maxCacheReadTokens",
  "maxCacheWriteTokens",
  "maxTotalTokens",
] as const;

function validateUsageBudget(value: unknown, field: string): SchedulerResult<UsageBudget> {
  if (!isRecord(value)) return fail("invalid_input", `${field} must be an object`);
  const keys = checkOnlyKeys(value, USAGE_BUDGET_FIELDS);
  if (!keys.ok) return keys;
  for (const name of USAGE_BUDGET_FIELDS) {
    if (!isSafeNonNegativeInteger(value[name])) return fail("unsafe_integer", `${field}.${name} must be a non-negative safe integer`);
  }
  return ok({
    maxInputTokens: value.maxInputTokens as number,
    maxOutputTokens: value.maxOutputTokens as number,
    maxCacheReadTokens: value.maxCacheReadTokens as number,
    maxCacheWriteTokens: value.maxCacheWriteTokens as number,
    maxTotalTokens: value.maxTotalTokens as number,
  });
}

function validatePolicyUsage(value: unknown): SchedulerResult<PolicyUsageLimits> {
  if (!isRecord(value)) return fail("invalid_input", "policy.usage must be an object");
  const keys = checkOnlyKeys(value, ["allowedRequests", "perRun", "aggregate"]);
  if (!keys.ok) return keys;
  if (!Array.isArray(value.allowedRequests)) return fail("invalid_input", "policy.usage.allowedRequests must be an array");
  const allowedRequests: ProviderModel[] = [];
  for (const request of value.allowedRequests) {
    if (!isRecord(request)) return fail("invalid_input", "allowed provider/model entry must be an object");
    const requestKeys = checkOnlyKeys(request, ["provider", "model"]);
    if (!requestKeys.ok) return requestKeys;
    const provider = boundedString(request.provider, "allowed provider", 64);
    if (!provider.ok) return provider;
    const model = boundedString(request.model, "allowed model", 256);
    if (!model.ok) return model;
    if (!allowedRequests.some((entry) => entry.provider === provider.value && entry.model === model.value)) {
      allowedRequests.push({ provider: provider.value, model: model.value });
    }
  }
  const perRun = validateUsageBudget(value.perRun, "policy.usage.perRun");
  if (!perRun.ok) return perRun;
  const aggregate = validateUsageBudget(value.aggregate, "policy.usage.aggregate");
  if (!aggregate.ok) return aggregate;
  return ok({ allowedRequests, perRun: perRun.value, aggregate: aggregate.value });
}

function validateOwner(owner: unknown, field: string, allowCapabilities = false): SchedulerResult<Owner> {
  if (!isRecord(owner)) return fail("invalid_input", `${field} must be an object`);
  const keys = checkOnlyKeys(owner, allowCapabilities ? ["projectId", "chatId", "agentId", "capabilities"] : ["projectId", "chatId", "agentId"]);
  if (!keys.ok) return keys;
  const projectId = nonEmptyString(owner.projectId, `${field}.projectId`);
  if (!projectId.ok) return projectId;
  const chatId = nonEmptyString(owner.chatId, `${field}.chatId`);
  if (!chatId.ok) return chatId;
  let agentId: string | undefined;
  if (owner.agentId !== undefined) {
    const result = nonEmptyString(owner.agentId, `${field}.agentId`);
    if (!result.ok) return result;
    agentId = result.value;
  }
  return ok({ projectId: projectId.value, chatId: chatId.value, ...(agentId ? { agentId } : {}) });
}

function validateTask(task: unknown): SchedulerResult<TaskDefinition> {
  if (!isRecord(task)) return fail("invalid_input", "task must be an object");
  const keys = checkOnlyKeys(task, ["id", "revision", "owner", "instructions", "request", "execution"]);
  if (!keys.ok) return keys;
  const id = nonEmptyString(task.id, "task.id");
  if (!id.ok) return id;
  const revision = safeNonNegative(task.revision, "task.revision");
  if (!revision.ok) return revision;
  const owner = validateOwner(task.owner, "task.owner");
  if (!owner.ok) return owner;
  if (typeof task.instructions !== "string") return fail("invalid_input", "task.instructions must be a string");
  if (!isRecord(task.request)) {
    return fail("invalid_input", "task.request must contain provider and model");
  }
  const requestKeys = checkOnlyKeys(task.request, ["provider", "model"]);
  if (!requestKeys.ok) return requestKeys;
  const provider = boundedString(task.request.provider, "task.request.provider", 64);
  if (!provider.ok) return provider;
  const model = boundedString(task.request.model, "task.request.model", 256);
  if (!model.ok) return model;
  if (!isRecord(task.execution) || (task.execution.kind !== "project" && task.execution.kind !== "worktree") || typeof task.execution.rootId !== "string" || !task.execution.rootId) {
    return fail("invalid_input", "task.execution must contain a supported kind and rootId");
  }
  const executionKeys = checkOnlyKeys(task.execution, ["kind", "rootId"]);
  if (!executionKeys.ok) return executionKeys;
  return ok({
    id: id.value,
    revision: revision.value,
    owner: owner.value,
    instructions: task.instructions,
    request: { provider: provider.value, model: model.value },
    execution: { kind: task.execution.kind, rootId: task.execution.rootId },
  });
}

function validateGrant(grant: unknown): SchedulerResult<GrantSnapshot> {
  if (!isRecord(grant)) return fail("invalid_input", "grant must be an object");
  const keys = checkOnlyKeys(grant, ["grantId", "policyVersion", "epoch", "issuedAtMs", "expiresAtMs", "scope"]);
  if (!keys.ok) return keys;
  const grantId = nonEmptyString(grant.grantId, "grant.grantId");
  if (!grantId.ok) return grantId;
  const policyVersion = safeNonNegative(grant.policyVersion, "grant.policyVersion");
  if (!policyVersion.ok) return policyVersion;
  const epoch = safeNonNegative(grant.epoch, "grant.epoch");
  if (!epoch.ok) return epoch;
  const issuedAtMs = safeTimestamp(grant.issuedAtMs, "grant.issuedAtMs");
  if (!issuedAtMs.ok) return issuedAtMs;
  let expiresAtMs: number | null = null;
  if (grant.expiresAtMs !== null) {
    const expiry = safeTimestamp(grant.expiresAtMs, "grant.expiresAtMs");
    if (!expiry.ok) return expiry;
    if (expiry.value <= issuedAtMs.value) return fail("invalid_input", "grant expiry must be after issuance");
    expiresAtMs = expiry.value;
  }
  if (!isRecord(grant.scope)) return fail("invalid_input", "grant.scope must be an object");
  const scope = validateOwner(grant.scope, "grant.scope", true);
  if (!scope.ok) return scope;
  if (!Array.isArray(grant.scope.capabilities) || grant.scope.capabilities.some((capability) => typeof capability !== "string" || !capability)) {
    return fail("invalid_input", "grant.scope.capabilities must be non-empty strings");
  }
  return ok({
    grantId: grantId.value,
    policyVersion: policyVersion.value,
    epoch: epoch.value,
    issuedAtMs: issuedAtMs.value,
    expiresAtMs,
    scope: { ...scope.value, capabilities: [...grant.scope.capabilities] as string[] },
  });
}

function normalizeMissedPolicy(input: unknown): SchedulerResult<MissedRunPolicy> {
  if (isRecord(input) && input.kind === "latest-only") {
    const keys = checkOnlyKeys(input, ["kind"]);
    if (!keys.ok) return keys;
    return ok({ kind: "latest-only" });
  }
  if (isRecord(input) && input.kind === "skip") {
    const keys = checkOnlyKeys(input, ["kind"]);
    if (!keys.ok) return keys;
    return ok({ kind: "skip" });
  }
  if (isRecord(input) && input.kind === "all") {
    const keys = checkOnlyKeys(input, ["kind", "maxCatchUp"]);
    if (!keys.ok) return keys;
    if (!isSafePositiveInteger(input.maxCatchUp)) return fail("invalid_input", "all missed-run policy needs a positive maxCatchUp");
    return ok({ kind: "all", maxCatchUp: input.maxCatchUp });
  }
  return fail("invalid_input", "unsupported missed-run policy");
}

function validateRetry(retry: unknown): SchedulerResult<RetryPolicy> {
  if (!isRecord(retry)) return fail("invalid_input", "retry must be an object");
  const keys = checkOnlyKeys(retry, ["maxAttempts", "backoffMs", "multiplier", "maxBackoffMs"]);
  if (!keys.ok) return keys;
  const maxAttempts = safeNonNegative(retry.maxAttempts, "retry.maxAttempts");
  if (!maxAttempts.ok) return maxAttempts;
  if (maxAttempts.value < 1) return fail("invalid_input", "retry.maxAttempts must be at least one");
  const backoffMs = safeNonNegative(retry.backoffMs, "retry.backoffMs");
  if (!backoffMs.ok) return backoffMs;
  const maxBackoffMs = safeNonNegative(retry.maxBackoffMs, "retry.maxBackoffMs");
  if (!maxBackoffMs.ok) return maxBackoffMs;
  if (maxBackoffMs.value < backoffMs.value) return fail("invalid_input", "maxBackoffMs must not be below backoffMs");
  if (typeof retry.multiplier !== "number" || !Number.isFinite(retry.multiplier) || retry.multiplier < 1) {
    return fail("invalid_input", "retry.multiplier must be finite and at least one");
  }
  return ok({ maxAttempts: maxAttempts.value, backoffMs: backoffMs.value, multiplier: retry.multiplier, maxBackoffMs: maxBackoffMs.value });
}

function retryDelay(retry: RetryPolicy, attempt: number): SchedulerResult<number> {
  if (!isSafePositiveInteger(attempt)) return fail("unsafe_integer", "run attempt must be a positive safe integer");
  if (retry.backoffMs === 0 || retry.maxBackoffMs === 0) return ok(0);
  const raw = retry.backoffMs * Math.pow(retry.multiplier, attempt - 1);
  if (!Number.isFinite(raw) || raw >= retry.maxBackoffMs) return ok(retry.maxBackoffMs);
  const rounded = Math.ceil(raw);
  if (!isSafeNonNegativeInteger(rounded)) return fail("unsafe_integer", "retry delay exceeds the safe integer range");
  return ok(rounded);
}

function validateConcurrency(concurrency: unknown): SchedulerResult<ScheduleConcurrencyCaps> {
  if (!isRecord(concurrency)) return fail("invalid_input", "concurrency must be an object");
  const keys = checkOnlyKeys(concurrency, ["perSchedule"]);
  if (!keys.ok) return keys;
  if (!isSafePositiveInteger(concurrency.perSchedule)) return fail("invalid_input", "perSchedule must be positive");
  return ok({ perSchedule: concurrency.perSchedule });
}

function validateScheduleInput(
  input: ScheduleInput,
): SchedulerResult<Omit<Schedule, "cursorMs" | "nextRunAtMs" | "enablementGeneration" | "enablementChangedAtMs">> {
  if (!isRecord(input)) return fail("invalid_input", "schedule must be an object");
  const keys = checkOnlyKeys(input, [
    "id", "task", "recurrence", "timezone", "timezoneData", "recurrenceNormalizationVersion", "dstGapPolicy",
    "dstFoldPolicy", "missedRunPolicy", "grant", "retry", "concurrency", "claimLeaseMs", "createdAtMs", "enabled",
  ]);
  if (!keys.ok) return keys;
  const id = nonEmptyString(input.id, "schedule.id");
  if (!id.ok) return id;
  const task = validateTask(input.task);
  if (!task.ok) return task;
  const recurrence = validateRecurrence(input.recurrence);
  if (!recurrence.ok) return recurrence;
  const timezone = validateTimeZone(input.timezone);
  if (!timezone.ok) return timezone;
  const timezoneData = validateTimeZoneDataBinding(input.timezoneData);
  if (!timezoneData.ok) return timezoneData;
  const recurrenceNormalizationVersion = safeNonNegative(input.recurrenceNormalizationVersion, "recurrenceNormalizationVersion");
  if (!recurrenceNormalizationVersion.ok || recurrenceNormalizationVersion.value !== RECURRENCE_NORMALIZATION_VERSION) {
    return fail("invalid_input", `recurrenceNormalizationVersion must be ${RECURRENCE_NORMALIZATION_VERSION}`);
  }
  if (!["skip", "shift-forward", "shift-backward", "reject"].includes(input.dstGapPolicy)) return fail("invalid_input", "unsupported DST gap policy");
  if (!["earlier", "later", "reject"].includes(input.dstFoldPolicy)) return fail("invalid_input", "unsupported DST fold policy");
  const missedRunPolicy = normalizeMissedPolicy(input.missedRunPolicy);
  if (!missedRunPolicy.ok) return missedRunPolicy;
  const grant = validateGrant(input.grant);
  if (!grant.ok) return grant;
  if (grant.value.scope.projectId !== task.value.owner.projectId || grant.value.scope.chatId !== task.value.owner.chatId || (grant.value.scope.agentId !== undefined && grant.value.scope.agentId !== task.value.owner.agentId)) {
    return fail("invalid_input", "grant scope does not cover the scheduled task owner");
  }
  const retry = validateRetry(input.retry);
  if (!retry.ok) return retry;
  const concurrency = validateConcurrency(input.concurrency);
  if (!concurrency.ok) return concurrency;
  const claimLeaseMs = safeNonNegative(input.claimLeaseMs, "claimLeaseMs");
  if (!claimLeaseMs.ok || claimLeaseMs.value < 1) return fail("invalid_input", "claimLeaseMs must be positive");
  const createdAtMs = safeTimestamp(input.createdAtMs, "createdAtMs");
  if (!createdAtMs.ok) return createdAtMs;
  if (typeof input.enabled !== "boolean") return fail("invalid_input", "enabled must be boolean");
  return ok({
    id: id.value,
    task: task.value,
    recurrence: recurrence.value,
    timezone: timezone.value,
    timezoneData: timezoneData.value,
    recurrenceNormalizationVersion: recurrenceNormalizationVersion.value,
    dstGapPolicy: input.dstGapPolicy,
    dstFoldPolicy: input.dstFoldPolicy,
    missedRunPolicy: missedRunPolicy.value,
    grantSnapshot: copyGrant(grant.value),
    retry: retry.value,
    concurrency: concurrency.value,
    claimLeaseMs: claimLeaseMs.value,
    createdAtMs: createdAtMs.value,
    enabled: input.enabled,
  });
}

function grantCurrent(grant: GrantSnapshot, policy: CurrentPolicy, nowMs: number): SchedulerResult<void> {
  if (!grant.scope.capabilities.includes("schedule.run")) {
    return fail("capability_denied", "grant does not include schedule.run");
  }
  if (nowMs < grant.issuedAtMs) return fail("grant_revoked", "grant is not valid yet");
  if (grant.expiresAtMs !== null && nowMs >= grant.expiresAtMs) return fail("grant_expired", "grant has expired");
  if (grant.policyVersion !== policy.policyVersion || grant.epoch !== policy.epoch || policy.revokedGrantIds.includes(grant.grantId)) {
    return fail("grant_revoked", "grant no longer matches the current policy generation");
  }
  return ok(undefined);
}

function requestAllowed(request: ProviderModel, policy: CurrentPolicy): SchedulerResult<void> {
  if (!policy.usage.allowedRequests.some((allowed) => allowed.provider === request.provider && allowed.model === request.model)) {
    return fail("request_not_allowed", "provider/model is not allowed by the current policy");
  }
  return ok(undefined);
}

function activeRun(run: ScheduledRun): boolean {
  return run.status === "claimed" || run.status === "dispatch_committed" || run.status === "running" || run.status === "cancellation_requested";
}

function terminalStatus(status: RunStatus): status is TerminalOutcome {
  return !["claimed", "dispatch_committed", "running", "cancellation_requested"].includes(status);
}

function addUsageValue(left: number, right: number, field: string): SchedulerResult<number> {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) return fail("unsafe_integer", `${field} total exceeds the safe integer range`);
  return ok(sum);
}

function usageTotals(observations: UsageObservation[]): SchedulerResult<UsageTotals> {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const observation of observations) {
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      const amount = observation[field] ?? 0;
      const metric = addUsageValue(totals[field], amount, field);
      if (!metric.ok) return metric;
      totals[field] = metric.value;
      const total = addUsageValue(totals.totalTokens, amount, "usage");
      if (!total.ok) return total;
      totals.totalTokens = total.value;
    }
  }
  return ok(totals);
}

function budgetExceeded(totals: UsageTotals, budget: UsageBudget): keyof UsageBudget | undefined {
  const comparisons: Array<[keyof UsageBudget, number]> = [
    ["maxInputTokens", totals.inputTokens],
    ["maxOutputTokens", totals.outputTokens],
    ["maxCacheReadTokens", totals.cacheReadTokens],
    ["maxCacheWriteTokens", totals.cacheWriteTokens],
    ["maxTotalTokens", totals.totalTokens],
  ];
  return comparisons.find(([field, total]) => total > budget[field])?.[0];
}

function remainingBudget(totals: UsageTotals, budget: UsageBudget): UsageBudget {
  return {
    maxInputTokens: Math.max(0, budget.maxInputTokens - totals.inputTokens),
    maxOutputTokens: Math.max(0, budget.maxOutputTokens - totals.outputTokens),
    maxCacheReadTokens: Math.max(0, budget.maxCacheReadTokens - totals.cacheReadTokens),
    maxCacheWriteTokens: Math.max(0, budget.maxCacheWriteTokens - totals.cacheWriteTokens),
    maxTotalTokens: Math.max(0, budget.maxTotalTokens - totals.totalTokens),
  };
}

function budgetAsTotals(budget: UsageBudget): UsageTotals {
  return {
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
    cacheReadTokens: budget.maxCacheReadTokens,
    cacheWriteTokens: budget.maxCacheWriteTokens,
    totalTokens: budget.maxTotalTokens,
  };
}

function addUsageTotals(left: UsageTotals, right: UsageTotals): SchedulerResult<UsageTotals> {
  const inputTokens = addUsageValue(left.inputTokens, right.inputTokens, "inputTokens");
  if (!inputTokens.ok) return inputTokens;
  const outputTokens = addUsageValue(left.outputTokens, right.outputTokens, "outputTokens");
  if (!outputTokens.ok) return outputTokens;
  const cacheReadTokens = addUsageValue(left.cacheReadTokens, right.cacheReadTokens, "cacheReadTokens");
  if (!cacheReadTokens.ok) return cacheReadTokens;
  const cacheWriteTokens = addUsageValue(left.cacheWriteTokens, right.cacheWriteTokens, "cacheWriteTokens");
  if (!cacheWriteTokens.ok) return cacheWriteTokens;
  const totalTokens = addUsageValue(left.totalTokens, right.totalTokens, "usage");
  if (!totalTokens.ok) return totalTokens;
  return ok({
    inputTokens: inputTokens.value,
    outputTokens: outputTokens.value,
    cacheReadTokens: cacheReadTokens.value,
    cacheWriteTokens: cacheWriteTokens.value,
    totalTokens: totalTokens.value,
  });
}

function reservationRemaining(budget: UsageBudget, actual: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, budget.maxInputTokens - actual.inputTokens),
    outputTokens: Math.max(0, budget.maxOutputTokens - actual.outputTokens),
    cacheReadTokens: Math.max(0, budget.maxCacheReadTokens - actual.cacheReadTokens),
    cacheWriteTokens: Math.max(0, budget.maxCacheWriteTokens - actual.cacheWriteTokens),
    totalTokens: Math.max(0, budget.maxTotalTokens - actual.totalTokens),
  };
}

function minimumBudget(left: UsageBudget, right: UsageBudget): UsageBudget {
  return {
    maxInputTokens: Math.min(left.maxInputTokens, right.maxInputTokens),
    maxOutputTokens: Math.min(left.maxOutputTokens, right.maxOutputTokens),
    maxCacheReadTokens: Math.min(left.maxCacheReadTokens, right.maxCacheReadTokens),
    maxCacheWriteTokens: Math.min(left.maxCacheWriteTokens, right.maxCacheWriteTokens),
    maxTotalTokens: Math.min(left.maxTotalTokens, right.maxTotalTokens),
  };
}

function occurrenceKeyString(key: OccurrenceKey): string {
  return `${key.scheduleId}:${key.taskRevision}:${key.scheduledInstantMs}`;
}

export function makeOccurrenceKey(key: OccurrenceKey): string {
  return occurrenceKeyString(key);
}

function reserveSequenceIds(state: SchedulerState, prefixes: string[]): SchedulerResult<string[]> {
  if (state.sequence > Number.MAX_SAFE_INTEGER - prefixes.length) {
    return fail("unsafe_integer", "scheduler sequence exhausted");
  }
  const ids = prefixes.map((prefix, index) => `${prefix}-${state.sequence + index + 1}`);
  state.sequence += prefixes.length;
  return ok(ids);
}

function cloneState(state: SchedulerState): SchedulerState {
  const cloned = cloneJson(state);
  for (const schedule of Object.values(cloned.schedules)) schedule.grantSnapshot = copyGrant(schedule.grantSnapshot);
  for (const occurrence of Object.values(cloned.occurrences)) occurrence.grantSnapshot = copyGrant(occurrence.grantSnapshot);
  for (const run of Object.values(cloned.runs)) run.grantSnapshot = copyGrant(run.grantSnapshot);
  return cloned;
}

function validateLeaderLease(lease: LeaderLease): SchedulerResult<LeaderLease> {
  if (!isRecord(lease)) return fail("lease_mismatch", "leader lease is malformed");
  const keys = checkOnlyKeys(lease, ["leaseId", "holderId", "fencingEpoch", "issuedAtMs", "expiresAtMs", "durationMs"]);
  if (!keys.ok) return keys;
  if (typeof lease.leaseId !== "string" || typeof lease.holderId !== "string") return fail("lease_mismatch", "leader lease identity is malformed");
  if (!isSafePositiveInteger(lease.fencingEpoch) || !isSafePositiveInteger(lease.durationMs)) {
    return fail("unsafe_integer", "leader lease fencing epoch and duration must be positive safe integers");
  }
  const issuedAtMs = safeTimestamp(lease.issuedAtMs, "leader lease issuedAtMs");
  if (!issuedAtMs.ok) return issuedAtMs;
  const expiresAtMs = safeTimestamp(lease.expiresAtMs, "leader lease expiresAtMs");
  if (!expiresAtMs.ok) return expiresAtMs;
  if (expiresAtMs.value < issuedAtMs.value) return fail("lease_mismatch", "leader lease timing is invalid");
  return ok(lease);
}

function validateCompletion(completion: RunCompletion): SchedulerResult<RunCompletion> {
  if (!isRecord(completion) || typeof completion.outcome !== "string") return fail("invalid_input", "completion is malformed");
  const outcome = completion.outcome;
  if (outcome === "succeeded") {
    const keys = checkOnlyKeys(completion, ["outcome"]);
    return keys.ok ? ok(completion as RunCompletion) : keys;
  }
  if (outcome === "cancelled") {
    const keys = checkOnlyKeys(completion, ["outcome", "reason"]);
    if (!keys.ok) return keys;
    if (completion.reason !== undefined && typeof completion.reason !== "string") return fail("invalid_input", "cancelled reason must be a string");
    return ok(completion as RunCompletion);
  }
  if (outcome === "failed") {
    const keys = checkOnlyKeys(completion, ["outcome", "retryable", "reason"]);
    if (!keys.ok) return keys;
    if (typeof completion.retryable !== "boolean" || typeof completion.reason !== "string") return fail("invalid_input", "failed completion needs retryable and reason");
    return ok(completion as RunCompletion);
  }
  if (outcome === "outcome_unknown" && typeof completion.reason === "string") {
    const keys = checkOnlyKeys(completion, ["outcome", "reason"]);
    if (!keys.ok) return keys;
    return ok(completion as RunCompletion);
  }
  return fail("invalid_input", "unsupported completion outcome");
}

export class SchedulerDomain {
  private readonly state: SchedulerState;
  private readonly adapter: TimeZoneAdapter;
  private readonly durableAuthority: SchedulerDurableAuthority;

  public static create(
    policy: CurrentPolicy,
    adapter: TimeZoneAdapter = defaultTimeZoneAdapter,
    durableAuthority?: SchedulerDurableAuthority,
  ): SchedulerDomain {
    const checked = validatePolicy(policy);
    if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
    const authenticated = authorityState(durableAuthority);
    if (!authenticated.ok) throw new Error(`${authenticated.error.code}: ${authenticated.error.message}`);
    const durableEvidence = initializeDurableEvidence(authenticated.value);
    if (!durableEvidence.ok) throw new Error(`${durableEvidence.error.code}: ${durableEvidence.error.message}`);
    const state: SchedulerState = {
      schemaVersion: 4,
      sequence: authenticated.value.initialSequenceHighWater,
      nextFencingEpoch: durableEvidence.value.fencingEpochHighWater,
      fencingEpochHistory: cloneJson(authenticated.value.initialFencingHistory),
      durableEvidence: durableEvidence.value,
      policy: checked.value,
      leader: null,
      schedules: {},
      occurrences: {},
      runs: {},
      usage: {},
      skippedSpans: [],
    };
    authenticateInitialDurableState(authenticated.value, state);
    return new SchedulerDomain(state, adapter, durableAuthority!);
  }

  public static fromState(
    state: SchedulerState,
    adapter: TimeZoneAdapter = defaultTimeZoneAdapter,
    durableAuthority?: SchedulerDurableAuthority,
  ): SchedulerDomain {
    const checked = decodeSerializedState(state, adapter, durableAuthority);
    if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
    return new SchedulerDomain(checked.value, adapter, durableAuthority!);
  }

  private constructor(
    state: SchedulerState,
    adapter: TimeZoneAdapter,
    durableAuthority: SchedulerDurableAuthority,
  ) {
    this.state = state;
    this.adapter = adapter;
    this.durableAuthority = durableAuthority;
  }

  private withDurableMutation<T>(mutation: () => SchedulerResult<T>): SchedulerResult<T> {
    const authenticated = verifyDurableState(this.durableAuthority, this.state);
    if (!authenticated.ok) return authenticated;
    const previous = cloneState(this.state);
    const result = mutation();
    if (durableStateCommitment(previous) === durableStateCommitment(this.state)) return result;
    const evidence = attestDurableState(this.durableAuthority, this.state);
    if (!evidence.ok) {
      Object.assign(this.state, previous);
      return evidence;
    }
    this.state.durableEvidence = copyDurableEvidence(evidence.value);
    return result;
  }

  public serialize(): SchedulerState {
    const cloned = cloneState(this.state);
    const evidence = attestDurableState(this.durableAuthority, cloned);
    if (!evidence.ok) throw new Error(`${evidence.error.code}: scheduler state is not attestable: ${evidence.error.message}`);
    this.state.durableEvidence = copyDurableEvidence(evidence.value);
    cloned.durableEvidence = copyDurableEvidence(evidence.value);
    const checked = decodeSerializedState(cloned, this.adapter, this.durableAuthority);
    if (!checked.ok) throw new Error(`${checked.error.code}: scheduler state is not serializable: ${checked.error.message}`);
    return checked.value;
  }

  public snapshot(): SchedulerState {
    return this.serialize();
  }

  public getState(): SchedulerState {
    return this.serialize();
  }

  public getSchedule(id: string): Schedule | undefined {
    const schedule = this.state.schedules[id];
    return schedule ? copySchedule(schedule) : undefined;
  }

  public getOccurrence(key: string): Occurrence | undefined {
    const occurrence = this.state.occurrences[key];
    return occurrence ? copyOccurrence(occurrence) : undefined;
  }

  public getRun(id: string): ScheduledRun | undefined {
    const run = this.state.runs[id];
    return run ? copyRun(run) : undefined;
  }

  public getUsage(id: string): UsageObservation | undefined {
    const usage = this.state.usage[id];
    return usage ? cloneJson(usage) : undefined;
  }

  public getSkippedSpans(): SkippedSpan[] {
    return cloneJson(this.state.skippedSpans);
  }

  public registerSchedule(input: ScheduleInput): SchedulerResult<Schedule> {
    return this.withDurableMutation(() => {
    const checked = validateScheduleInput(input);
    if (!checked.ok) return checked;
    if (this.state.schedules[checked.value.id]) return fail("conflict", `schedule already exists: ${checked.value.id}`);
    const authority = grantCurrent(checked.value.grantSnapshot, this.state.policy, checked.value.createdAtMs);
    if (!authority.ok) return authority;
    const allowed = requestAllowed(checked.value.task.request, this.state.policy);
    if (!allowed.ok) return allowed;
    const cursor = checkedTimestampAdd(checked.value.createdAtMs, -1, "schedule.cursorMs");
    if (!cursor.ok) return cursor;
    const cursorMs = cursor.value;
    const first = calculateNextRun({
      recurrence: checked.value.recurrence,
      timezone: checked.value.timezone,
      timezoneData: checked.value.timezoneData,
      afterMs: cursorMs,
      dstGapPolicy: checked.value.dstGapPolicy,
      dstFoldPolicy: checked.value.dstFoldPolicy,
    }, this.adapter);
    if (!first.ok) return first;
    const schedule: Schedule = {
      ...checked.value,
      enablementGeneration: 1,
      enablementChangedAtMs: checked.value.createdAtMs,
      cursorMs,
      nextRunAtMs: first.value,
    };
    this.state.schedules[schedule.id] = schedule;
    return ok(copySchedule(schedule));
    });
  }

  public setScheduleEnabled(scheduleId: string, enabled: boolean, nowMs: number): SchedulerResult<Schedule> {
    return this.withDurableMutation(() => {
    const schedule = this.state.schedules[scheduleId];
    if (!schedule) return fail("not_found", `schedule not found: ${scheduleId}`);
    if (typeof enabled !== "boolean") return fail("invalid_input", "enabled must be boolean");
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    if (now.value < schedule.createdAtMs) return fail("invalid_time", "schedule state change predates schedule creation");
    if (now.value < schedule.enablementChangedAtMs) {
      return fail("invalid_time", "schedule state change predates its durable enablement high-water");
    }
    if (enabled === schedule.enabled) return ok(copySchedule(schedule));

    const occurrencesToCancel: Occurrence[] = [];
    const claimedToCancel: Array<{ occurrence: Occurrence; run: ScheduledRun }> = [];
    if (!enabled) {
      for (const occurrence of Object.values(this.state.occurrences)) {
        if (occurrence.scheduleId !== scheduleId) continue;
        if (now.value < occurrence.createdAtMs) return fail("invalid_time", "schedule disable predates occurrence state");
        for (const runId of occurrence.runIds) {
          const run = this.state.runs[runId];
          if (!run || run.scheduleId !== scheduleId || run.occurrenceKey !== occurrence.key) {
            return fail("decode_error", "schedule disable encountered invalid run state");
          }
          const persistedEventTimes = [
            run.admittedAtMs,
            run.lease?.issuedAtMs,
            run.dispatch?.committedAtMs,
            run.cancellationRequestedAtMs,
            run.terminalAtMs,
            ...run.usageObservationIds.map((id) => this.state.usage[id]?.observedAtMs),
          ].filter((value): value is number => value !== undefined);
          if (persistedEventTimes.some((eventAtMs) => now.value < eventAtMs)) {
            return fail("invalid_time", "schedule disable predates persisted run state");
          }
        }
        if (occurrence.status === "pending" || occurrence.status === "retry_wait") {
          occurrencesToCancel.push(occurrence);
          continue;
        }
        if (occurrence.status !== "claimed") continue;
        if (!occurrence.activeRunId) return fail("decode_error", "claimed occurrence has no active run");
        const run = this.state.runs[occurrence.activeRunId];
        if (!run || run.status !== "claimed" || !run.lease) {
          return fail("decode_error", "claimed occurrence has invalid run state");
        }
        claimedToCancel.push({ occurrence, run });
      }
    }

    if (schedule.enablementGeneration >= Number.MAX_SAFE_INTEGER) {
      return fail("unsafe_integer", "schedule enablement generation is exhausted");
    }
    schedule.enabled = enabled;
    schedule.enablementGeneration += 1;
    schedule.enablementChangedAtMs = now.value;
    if (!enabled) {
      for (const occurrence of occurrencesToCancel) {
        occurrence.status = "cancelled";
        occurrence.reason = "schedule disabled";
        delete occurrence.nextRetryAtMs;
        delete occurrence.activeRunId;
      }
      for (const { occurrence, run } of claimedToCancel) {
        run.status = "cancelled";
        run.outcome = "cancelled";
        run.reason = "schedule disabled";
        run.terminalAtMs = now.value;
        if (run.lease) run.lease.expiresAtMs = Math.min(run.lease.expiresAtMs, now.value);
        occurrence.status = "cancelled";
        occurrence.reason = "schedule disabled";
        delete occurrence.activeRunId;
      }
    }
    return ok(copySchedule(schedule));
    });
  }

  public updatePolicy(policy: CurrentPolicy): SchedulerResult<CurrentPolicy> {
    return this.withDurableMutation(() => {
    const checked = validatePolicy(policy);
    if (!checked.ok) return checked;
    if (checked.value.policyVersion < this.state.policy.policyVersion || checked.value.epoch < this.state.policy.epoch) {
      return fail("policy_regression", "policy generation cannot move backwards");
    }
    const sameGeneration = checked.value.policyVersion === this.state.policy.policyVersion && checked.value.epoch === this.state.policy.epoch;
    if (sameGeneration && JSON.stringify(checked.value) !== JSON.stringify(this.state.policy)) {
      return fail("policy_regression", "policy contents cannot change without advancing its generation");
    }
    if (this.state.policy.revokedGrantIds.some((grantId) => !checked.value.revokedGrantIds.includes(grantId))) {
      return fail("policy_regression", "a recorded grant revocation cannot be removed");
    }
    this.state.policy = checked.value;
    return ok(copyPolicy(this.state.policy));
    });
  }

  public acquireLeader(holderId: string, nowMs: number, durationMs: number): SchedulerResult<LeaderLease> {
    return this.withDurableMutation(() => {
    const holder = nonEmptyString(holderId, "holderId");
    if (!holder.ok) return holder;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const duration = safeNonNegative(durationMs, "durationMs");
    if (!duration.ok || duration.value < 1) return fail("invalid_input", "leader duration must be positive");
    if (this.state.leader && now.value < this.state.leader.expiresAtMs) return fail("conflict", "scheduler leader lease is still active");
    const latestFence = this.state.fencingEpochHistory[this.state.fencingEpochHistory.length - 1];
    if ((latestFence?.fencingEpoch ?? 0) !== this.state.nextFencingEpoch) {
      return fail("decode_error", "scheduler fencing high-water is inconsistent");
    }
    if (latestFence && now.value < latestFence.issuedAtMs) return fail("invalid_time", "leader acquisition predates durable fencing history");
    const fencingEpoch = this.state.nextFencingEpoch + 1;
    if (!Number.isSafeInteger(fencingEpoch)) return fail("unsafe_integer", "fencing epoch overflow");
    const expiresAtMs = checkedTimestampAdd(now.value, duration.value, "leader.expiresAtMs");
    if (!expiresAtMs.ok) return expiresAtMs;
    const ids = reserveSequenceIds(this.state, ["leader"]);
    if (!ids.ok) return ids;
    this.state.nextFencingEpoch = fencingEpoch;
    const lease: LeaderLease = {
      leaseId: ids.value[0],
      holderId: holder.value,
      fencingEpoch,
      issuedAtMs: now.value,
      expiresAtMs: expiresAtMs.value,
      durationMs: duration.value,
    };
    this.state.fencingEpochHistory.push({
      fencingEpoch,
      leaderLeaseId: lease.leaseId,
      holderId: lease.holderId,
      issuedAtMs: lease.issuedAtMs,
    });
    this.state.leader = lease;
    return ok(cloneJson(lease));
    });
  }

  private leaderForClaim(lease: LeaderLease, nowMs: number): SchedulerResult<LeaderLease> {
    const checked = validateLeaderLease(lease);
    if (!checked.ok) return checked;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    if (!this.state.leader) return fail("lease_expired", "no scheduler leader lease exists");
    const latestFence = this.state.fencingEpochHistory[this.state.fencingEpochHistory.length - 1];
    if (!latestFence || latestFence.fencingEpoch !== this.state.nextFencingEpoch
      || latestFence.fencingEpoch !== this.state.leader.fencingEpoch
      || latestFence.leaderLeaseId !== this.state.leader.leaseId
      || latestFence.holderId !== this.state.leader.holderId) {
      return fail("stale_fencing_epoch", "leader fence is not recorded at the durable high-water");
    }
    if (now.value < lease.issuedAtMs) return fail("invalid_time", "leader operation predates lease issuance");
    if (this.state.leader.leaseId !== lease.leaseId || this.state.leader.holderId !== lease.holderId || this.state.leader.fencingEpoch !== lease.fencingEpoch) {
      return fail("stale_fencing_epoch", "leader lease is stale");
    }
    if (now.value >= lease.expiresAtMs || now.value >= this.state.leader.expiresAtMs) return fail("lease_expired", "leader lease has expired");
    return ok(this.state.leader);
  }

  public heartbeatLeader(lease: LeaderLease, nowMs: number): SchedulerResult<LeaderLease> {
    return this.withDurableMutation(() => {
    const checked = validateLeaderLease(lease);
    if (!checked.ok) return checked;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    if (now.value >= lease.expiresAtMs) return fail("lease_expired", "leader lease has expired");
    if (now.value < lease.issuedAtMs) return fail("invalid_time", "leader heartbeat predates lease issuance");
    const active = this.state.leader;
    if (!active || active.leaseId !== lease.leaseId || active.holderId !== lease.holderId || active.fencingEpoch !== lease.fencingEpoch) {
      return fail("stale_fencing_epoch", "leader lease is stale");
    }
    const latestFence = this.state.fencingEpochHistory[this.state.fencingEpochHistory.length - 1];
    if (!latestFence || latestFence.fencingEpoch !== this.state.nextFencingEpoch
      || latestFence.fencingEpoch !== active.fencingEpoch
      || latestFence.leaderLeaseId !== active.leaseId
      || latestFence.holderId !== active.holderId) {
      return fail("stale_fencing_epoch", "leader fence is not recorded at the durable high-water");
    }
    if (now.value >= active.expiresAtMs) return fail("lease_expired", "leader lease has expired");
    const expiresAtMs = checkedTimestampAdd(now.value, active.durationMs, "leader.expiresAtMs");
    if (!expiresAtMs.ok) return expiresAtMs;
    active.expiresAtMs = expiresAtMs.value;
    return ok(cloneJson(active));
    });
  }

  public materializeDue(scheduleId: string, leader: LeaderLease, nowMs: number): SchedulerResult<Materialization> {
    return this.withDurableMutation(() => {
    const activeLeader = this.leaderForClaim(leader, nowMs);
    if (!activeLeader.ok) return activeLeader;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const schedule = this.state.schedules[scheduleId];
    if (!schedule) return fail("not_found", `schedule not found: ${scheduleId}`);
    if (!schedule.enabled) return ok({ created: [], skippedSpans: [] });

    const due: number[] = [];
    let cursor = schedule.cursorMs;
    for (let count = 0; count < MAX_RECURRENCE_SEARCH; count++) {
      const next = calculateNextRun({
        recurrence: schedule.recurrence,
        timezone: schedule.timezone,
        timezoneData: schedule.timezoneData,
        afterMs: cursor,
        dstGapPolicy: schedule.dstGapPolicy,
        dstFoldPolicy: schedule.dstFoldPolicy,
      }, this.adapter);
      if (!next.ok) return next;
      if (next.value === null || next.value > now.value) {
        schedule.cursorMs = cursor;
        schedule.nextRunAtMs = next.value;
        break;
      }
      if (next.value <= cursor) return fail("invalid_recurrence", "next occurrence did not advance");
      due.push(next.value);
      cursor = next.value;
      if (count === MAX_RECURRENCE_SEARCH - 1) return fail("invalid_recurrence", "missed occurrence search exceeded its deterministic bound");
    }

    if (due.length === 0) return ok({ created: [], skippedSpans: [] });
    schedule.cursorMs = cursor;
    const next = calculateNextRun({
      recurrence: schedule.recurrence,
      timezone: schedule.timezone,
      timezoneData: schedule.timezoneData,
      afterMs: cursor,
      dstGapPolicy: schedule.dstGapPolicy,
      dstFoldPolicy: schedule.dstFoldPolicy,
    }, this.adapter);
    if (!next.ok) return next;
    schedule.nextRunAtMs = next.value;

    const policy = schedule.missedRunPolicy;
    let selected = due;
    let skipped: SkippedSpan | undefined;
    if (policy.kind === "skip") {
      skipped = this.makeSkippedSpan(schedule, due, "missed-policy-skip");
      selected = [];
    } else if (policy.kind === "latest-only") {
      selected = [due[due.length - 1]];
      if (due.length > 1) skipped = this.makeSkippedSpan(schedule, due.slice(0, -1), "missed-catch-up-compressed");
    } else if (due.length > policy.maxCatchUp) {
      selected = due.slice(-policy.maxCatchUp);
      skipped = this.makeSkippedSpan(schedule, due.slice(0, -policy.maxCatchUp), "missed-catch-up-compressed");
    }

    const created: Occurrence[] = [];
    for (const scheduledInstantMs of selected) {
      const key = occurrenceKeyString({ scheduleId, taskRevision: schedule.task.revision, scheduledInstantMs });
      if (this.state.occurrences[key]) continue;
      const occurrence: Occurrence = {
        key,
        scheduleId,
        taskRevision: schedule.task.revision,
        scheduledInstantMs,
        createdAtMs: now.value,
        status: "pending",
        attemptCount: 0,
        runIds: [],
        grantSnapshot: copyGrant(schedule.grantSnapshot),
      };
      this.state.occurrences[key] = occurrence;
      created.push(copyOccurrence(occurrence));
    }
    const skippedSpans = skipped ? [skipped] : [];
    if (skipped) this.state.skippedSpans.push(skipped);
    return ok({ created, skippedSpans: cloneJson(skippedSpans) });
    });
  }

  private makeSkippedSpan(schedule: Schedule, due: number[], reason: SkippedSpan["reason"]): SkippedSpan {
    return {
      scheduleId: schedule.id,
      taskRevision: schedule.task.revision,
      startMs: due[0],
      endMs: due[due.length - 1],
      count: due.length,
      reason,
    };
  }

  private accountedUsageTotals(additional?: UsageObservation): SchedulerResult<UsageTotals> {
    const observations = Object.values(this.state.usage);
    if (additional) observations.push(additional);
    const aggregate = usageTotals(observations);
    if (!aggregate.ok) return aggregate;
    let accounted = aggregate.value;
    for (const run of Object.values(this.state.runs)) {
      if (!activeRun(run) || !run.usageBudget) continue;
      const actual = usageTotals(observations.filter((observation) => observation.runId === run.id));
      if (!actual.ok) return actual;
      const reserved = addUsageTotals(accounted, reservationRemaining(run.usageBudget, actual.value));
      if (!reserved.ok) return reserved;
      accounted = reserved.value;
    }
    return ok(accounted);
  }

  private activeCounts(schedule: Schedule): { global: number; perProject: number; perAgent: number; perSchedule: number } {
    const activeRuns = Object.values(this.state.runs).filter(activeRun);
    const sameAgent = (run: ScheduledRun): boolean => {
      if (schedule.task.owner.agentId !== undefined) return run.owner.agentId === schedule.task.owner.agentId;
      return run.owner.agentId === undefined && run.owner.projectId === schedule.task.owner.projectId && run.owner.chatId === schedule.task.owner.chatId;
    };
    return {
      global: activeRuns.length,
      perProject: activeRuns.filter((run) => run.owner.projectId === schedule.task.owner.projectId).length,
      perAgent: activeRuns.filter(sameAgent).length,
      perSchedule: activeRuns.filter((run) => run.scheduleId === schedule.id).length,
    };
  }

  private guardrail(schedule: Schedule): SchedulerError | undefined {
    const counts = this.activeCounts(schedule);
    const limits = {
      ...this.state.policy.concurrency,
      perSchedule: schedule.concurrency.perSchedule,
    };
    for (const field of ["global", "perProject", "perAgent", "perSchedule"] as const) {
      const limit = limits[field];
      if (counts[field] >= limit) {
        return {
          code: "guardrail_exhausted",
          message: `${field} concurrency cap exhausted`,
          details: { field, limit, active: counts[field] },
        };
      }
    }
    return undefined;
  }

  private createRun(
    schedule: Schedule,
    occurrence: Occurrence,
    runId: string,
    nowMs: number,
    admissionFencingEpoch: number,
    status: RunStatus,
    reason?: string,
  ): ScheduledRun {
    const attempt = occurrence.attemptCount + 1;
    occurrence.attemptCount = attempt;
    const run: ScheduledRun = {
      id: runId,
      occurrenceKey: occurrence.key,
      scheduleId: schedule.id,
      taskRevision: schedule.task.revision,
      attempt,
      owner: cloneJson(schedule.task.owner),
      request: cloneJson(schedule.task.request),
      grantSnapshot: copyGrant(occurrence.grantSnapshot),
      status,
      admittedAtMs: nowMs,
      admissionFencingEpoch,
      ...(reason ? { reason } : {}),
      usageObservationIds: [],
    };
    this.state.runs[runId] = run;
    occurrence.runIds.push(runId);
    occurrence.activeRunId = runId;
    return run;
  }

  private blockOccurrence(
    schedule: Schedule,
    occurrence: Occurrence,
    nowMs: number,
    admissionFencingEpoch: number,
    outcome: "blocked-before-action" | "guardrail_exhausted",
    error: SchedulerError,
  ): SchedulerResult<never> {
    if (occurrence.attemptCount >= Number.MAX_SAFE_INTEGER) return fail("unsafe_integer", "occurrence attempt counter exhausted");
    const ids = reserveSequenceIds(this.state, ["run"]);
    if (!ids.ok) return ids;
    const run = this.createRun(schedule, occurrence, ids.value[0], nowMs, admissionFencingEpoch, outcome, error.message);
    run.outcome = outcome;
    run.terminalAtMs = nowMs;
    occurrence.status = outcome;
    occurrence.reason = error.message;
    delete occurrence.activeRunId;
    return fail(error.code, error.message, { ...error.details, runId: run.id });
  }

  public claimOccurrence(key: string, leader: LeaderLease, nowMs: number): SchedulerResult<ClaimedRun> {
    return this.withDurableMutation(() => {
    const activeLeader = this.leaderForClaim(leader, nowMs);
    if (!activeLeader.ok) return activeLeader;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const occurrence = this.state.occurrences[key];
    if (!occurrence) return fail("not_found", `occurrence not found: ${key}`);
    const schedule = this.state.schedules[occurrence.scheduleId];
    if (!schedule) return fail("not_found", `schedule not found: ${occurrence.scheduleId}`);
    if (!schedule.enabled) {
      if (occurrence.status === "pending" || occurrence.status === "retry_wait") {
        occurrence.status = "cancelled";
        occurrence.reason = "schedule disabled";
        delete occurrence.nextRetryAtMs;
        delete occurrence.activeRunId;
      }
      return fail("schedule_disabled", "schedule is disabled");
    }
    if (occurrence.status === "retry_wait") {
      if (occurrence.nextRetryAtMs === undefined || now.value < occurrence.nextRetryAtMs) return fail("retry_not_due", "retry backoff has not elapsed");
    } else if (occurrence.status !== "pending") {
      return fail("occurrence_not_claimable", `occurrence is ${occurrence.status}`);
    }

    const authority = grantCurrent(occurrence.grantSnapshot, this.state.policy, now.value);
    if (!authority.ok) return this.blockOccurrence(schedule, occurrence, now.value, activeLeader.value.fencingEpoch, "blocked-before-action", authority.error);
    const allowed = requestAllowed(schedule.task.request, this.state.policy);
    if (!allowed.ok) return this.blockOccurrence(schedule, occurrence, now.value, activeLeader.value.fencingEpoch, "blocked-before-action", allowed.error);
    const aggregateTotals = this.accountedUsageTotals();
    if (!aggregateTotals.ok) return aggregateTotals;
    if (aggregateTotals.value.totalTokens >= this.state.policy.usage.aggregate.maxTotalTokens) {
      return this.blockOccurrence(schedule, occurrence, now.value, activeLeader.value.fencingEpoch, "guardrail_exhausted", {
        code: "usage_budget_exhausted",
        message: "aggregate usage budget is exhausted",
        details: { field: "maxTotalTokens", active: aggregateTotals.value.totalTokens },
      });
    }
    const guardrail = this.guardrail(schedule);
    if (guardrail) return this.blockOccurrence(schedule, occurrence, now.value, activeLeader.value.fencingEpoch, "guardrail_exhausted", guardrail);

    if (occurrence.attemptCount >= Number.MAX_SAFE_INTEGER) return fail("unsafe_integer", "occurrence attempt counter exhausted");
    const expiresAtMs = checkedTimestampAdd(now.value, schedule.claimLeaseMs, "run.lease.expiresAtMs");
    if (!expiresAtMs.ok) return expiresAtMs;
    const ids = reserveSequenceIds(this.state, ["run", "run-lease"]);
    if (!ids.ok) return ids;
    const run = this.createRun(schedule, occurrence, ids.value[0], now.value, activeLeader.value.fencingEpoch, "claimed");
    const leaseId = ids.value[1];
    const runLease: RunLease = {
      leaseId,
      runId: run.id,
      holderId: activeLeader.value.holderId,
      fencingEpoch: activeLeader.value.fencingEpoch,
      issuedAtMs: now.value,
      expiresAtMs: expiresAtMs.value,
      durationMs: schedule.claimLeaseMs,
    };
    run.lease = runLease;
    occurrence.status = "claimed";
    delete occurrence.nextRetryAtMs;
    return ok({ run: copyRun(run), occurrence: copyOccurrence(occurrence), runLease: cloneJson(runLease) });
    });
  }

  public commitDispatch(runId: string, leader: LeaderLease, nowMs: number): SchedulerResult<DispatchTicket> {
    return this.withDurableMutation(() => {
    const activeLeader = this.leaderForClaim(leader, nowMs);
    if (!activeLeader.ok) return activeLeader;
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    const schedule = this.state.schedules[run.scheduleId];
    if (!schedule) return fail("not_found", `schedule not found: ${run.scheduleId}`);
    if (!schedule.enabled) return fail("schedule_disabled", "schedule is disabled");
    if (terminalStatus(run.status)) return fail("run_terminal", `run is ${run.status}`);
    if (run.status !== "claimed") return fail("dispatch_not_claimed", "dispatch requires a claimed run");
    if (!run.lease || run.admissionFencingEpoch !== activeLeader.value.fencingEpoch
      || run.lease.fencingEpoch !== activeLeader.value.fencingEpoch || run.lease.holderId !== activeLeader.value.holderId) {
      return fail("stale_fencing_epoch", "run lease is not held by the current leader");
    }
    if (now.value < run.admittedAtMs || now.value < run.lease.issuedAtMs) {
      return fail("invalid_time", "dispatch commitment predates run admission");
    }
    if (now.value >= run.lease.expiresAtMs) return fail("lease_expired", "run lease has expired");
    const authority = grantCurrent(run.grantSnapshot, this.state.policy, now.value);
    if (!authority.ok) {
      const occurrence = this.state.occurrences[run.occurrenceKey];
      const schedule = this.state.schedules[run.scheduleId];
      if (occurrence && schedule) {
        run.status = "blocked-before-action";
        run.outcome = "blocked-before-action";
        run.reason = authority.error.message;
        run.terminalAtMs = now.value;
        occurrence.status = "blocked-before-action";
        occurrence.reason = authority.error.message;
        delete occurrence.activeRunId;
        delete run.lease;
      }
      return fail(authority.error.code, authority.error.message);
    }
    const occurrence = this.state.occurrences[run.occurrenceKey];
    if (!occurrence) return fail("not_found", `occurrence not found: ${run.occurrenceKey}`);
    const aggregateTotals = this.accountedUsageTotals();
    if (!aggregateTotals.ok) return aggregateTotals;
    const aggregateExceeded = budgetExceeded(aggregateTotals.value, this.state.policy.usage.aggregate);
    const aggregateTotalExhausted = aggregateTotals.value.totalTokens >= this.state.policy.usage.aggregate.maxTotalTokens;
    if (aggregateExceeded || aggregateTotalExhausted) {
      const field = aggregateExceeded ?? "maxTotalTokens";
      const reason = "aggregate usage budget is exhausted";
      run.status = "guardrail_exhausted";
      run.outcome = "guardrail_exhausted";
      run.reason = reason;
      run.terminalAtMs = now.value;
      occurrence.status = "guardrail_exhausted";
      occurrence.reason = reason;
      delete occurrence.activeRunId;
      delete run.lease;
      return fail("usage_budget_exhausted", reason, { field });
    }
    const available = remainingBudget(aggregateTotals.value, this.state.policy.usage.aggregate);
    const usageBudget = minimumBudget(this.state.policy.usage.perRun, available);
    const accountedAfterReservation = addUsageTotals(aggregateTotals.value, budgetAsTotals(usageBudget));
    if (!accountedAfterReservation.ok) return accountedAfterReservation;
    const aggregateRemaining = remainingBudget(accountedAfterReservation.value, this.state.policy.usage.aggregate);
    run.status = "dispatch_committed";
    run.dispatch = { committedAtMs: now.value, fencingEpoch: activeLeader.value.fencingEpoch };
    run.usageBudget = cloneJson(usageBudget);
    occurrence.status = "dispatch_committed";
    occurrence.activeRunId = run.id;
    return ok({
      runId,
      occurrenceKey: run.occurrenceKey,
      fencingEpoch: activeLeader.value.fencingEpoch,
      grantId: run.grantSnapshot.grantId,
      grantEpoch: run.grantSnapshot.epoch,
      policyVersion: run.grantSnapshot.policyVersion,
      committedAtMs: now.value,
      usageBudget: cloneJson(usageBudget),
      aggregateRemaining,
    });
    });
  }

  public startRun(runId: string, runLeaseId: string, nowMs: number): SchedulerResult<ScheduledRun> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    if (terminalStatus(run.status)) return fail("run_terminal", `run is ${run.status}`);
    if (run.status !== "dispatch_committed") return fail("dispatch_not_claimed", "run has not committed dispatch");
    const lease = this.currentRunLease(run, runLeaseId, now.value);
    if (!lease.ok) return lease;
    run.status = "running";
    const occurrence = this.state.occurrences[run.occurrenceKey];
    if (occurrence) occurrence.status = "running";
    return ok(copyRun(run));
    });
  }

  public heartbeatRun(runId: string, runLeaseId: string, nowMs: number): SchedulerResult<RunLease> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    if (terminalStatus(run.status)) return fail("run_terminal", `run is ${run.status}`);
    const lease = this.currentRunLease(run, runLeaseId, now.value);
    if (!lease.ok) return lease;
    const authority = grantCurrent(run.grantSnapshot, this.state.policy, now.value);
    if (!authority.ok) return authority;
    const expiresAtMs = checkedTimestampAdd(now.value, lease.value.durationMs, "run.lease.expiresAtMs");
    if (!expiresAtMs.ok) return expiresAtMs;
    run.lease!.expiresAtMs = expiresAtMs.value;
    return ok(cloneJson(run.lease!));
    });
  }

  private currentRunLease(run: ScheduledRun, runLeaseId: string, nowMs: number): SchedulerResult<RunLease> {
    if (!run.lease || run.lease.leaseId !== runLeaseId) return fail("lease_mismatch", "run lease does not match");
    if (run.lease.fencingEpoch !== run.admissionFencingEpoch) return fail("stale_fencing_epoch", "run lease differs from its immutable admission fence");
    if (nowMs < run.admittedAtMs || nowMs < run.lease.issuedAtMs || (run.dispatch && nowMs < run.dispatch.committedAtMs)) {
      return fail("invalid_time", "run operation predates persisted lifecycle evidence");
    }
    if (nowMs >= run.lease.expiresAtMs) return fail("lease_expired", "run lease has expired");
    if (run.dispatch && run.dispatch.fencingEpoch !== run.lease.fencingEpoch) {
      return fail("stale_fencing_epoch", "dispatch and run lease fencing epochs differ");
    }
    const leader = this.state.leader;
    if (!leader || leader.holderId !== run.lease.holderId || leader.fencingEpoch !== run.lease.fencingEpoch) {
      return fail("stale_fencing_epoch", "run lease is not bound to the current scheduler leader");
    }
    const latestFence = this.state.fencingEpochHistory[this.state.fencingEpochHistory.length - 1];
    if (!latestFence || latestFence.fencingEpoch !== this.state.nextFencingEpoch
      || latestFence.fencingEpoch !== leader.fencingEpoch
      || latestFence.leaderLeaseId !== leader.leaseId
      || latestFence.holderId !== leader.holderId) {
      return fail("stale_fencing_epoch", "run lease is not bound to the durable fencing high-water");
    }
    if (nowMs >= leader.expiresAtMs) return fail("lease_expired", "scheduler leader lease has expired");
    return ok(run.lease);
  }

  public recordUsage(runId: string, input: Omit<UsageObservation, "runId">): SchedulerResult<UsageObservation> {
    return this.withDurableMutation(() => {
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    if (!isRecord(input)) return fail("invalid_input", "usage observation must be an object");
    const inputKeys = checkOnlyKeys(input, [
      "observationId", "observedAtMs", "provider", "model", "inputTokens", "outputTokens", "cacheReadTokens",
      "cacheWriteTokens", "source",
    ]);
    if (!inputKeys.ok) return inputKeys;
    const observationId = nonEmptyString(input.observationId, "observationId");
    if (!observationId.ok) return observationId;
    const observedAtMs = safeTimestamp(input.observedAtMs, "observedAtMs");
    if (!observedAtMs.ok) return observedAtMs;
    if (observedAtMs.value < run.admittedAtMs) return fail("invalid_time", "usage observation predates run admission");
    if (typeof input.provider !== "string" || typeof input.model !== "string" || !input.provider || !input.model) return fail("invalid_input", "usage provider/model are required");
    if (!["reported", "derived", "estimated"].includes(input.source)) return fail("invalid_input", "invalid usage source");
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      if (input[field] !== undefined && !isSafeNonNegativeInteger(input[field])) return fail("unsafe_integer", `${field} must be a non-negative safe integer`);
    }
    const existing = this.state.usage[observationId.value];
    const observation: UsageObservation = { ...cloneJson(input), observationId: observationId.value, runId, observedAtMs: observedAtMs.value };
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(observation)) return ok(cloneJson(existing));
      return fail("conflict", `usage observation already exists: ${observationId.value}`);
    }
    if (observation.provider !== run.request.provider || observation.model !== run.request.model) {
      return fail("request_not_allowed", "usage provider/model does not match the scheduled run request");
    }
    const allowed = requestAllowed(run.request, this.state.policy);
    if (!allowed.ok) return allowed;
    const runObservations = run.usageObservationIds.map((id) => this.state.usage[id]).filter((item): item is UsageObservation => item !== undefined);
    const perRunTotals = usageTotals([...runObservations, observation]);
    if (!perRunTotals.ok) return perRunTotals;
    const effectivePerRunBudget = minimumBudget(run.usageBudget ?? this.state.policy.usage.perRun, this.state.policy.usage.perRun);
    const perRunExceeded = budgetExceeded(perRunTotals.value, effectivePerRunBudget);
    if (perRunExceeded) {
      return fail("usage_budget_exhausted", "per-run usage budget would be exceeded", { scope: "run", field: perRunExceeded });
    }
    const aggregateTotals = this.accountedUsageTotals(observation);
    if (!aggregateTotals.ok) return aggregateTotals;
    const aggregateExceeded = budgetExceeded(aggregateTotals.value, this.state.policy.usage.aggregate);
    if (aggregateExceeded) {
      return fail("usage_budget_exhausted", "aggregate usage budget would be exceeded", { scope: "aggregate", field: aggregateExceeded });
    }
    this.state.usage[observationId.value] = observation;
    if (!run.usageObservationIds.includes(observationId.value)) run.usageObservationIds.push(observationId.value);
    return ok(cloneJson(observation));
    });
  }

  public completeRun(runId: string, runLeaseId: string, completion: RunCompletion, nowMs: number): SchedulerResult<ScheduledRun> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const checked = validateCompletion(completion);
    if (!checked.ok) return checked;
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    if (terminalStatus(run.status)) return fail("run_terminal", `run is ${run.status}`);
    if (run.status === "claimed") return fail("dispatch_not_claimed", "completion requires dispatch commitment");
    const lease = this.currentRunLease(run, runLeaseId, now.value);
    if (!lease.ok) return lease;
    const occurrence = this.state.occurrences[run.occurrenceKey];
    if (!occurrence) return fail("not_found", `occurrence not found: ${run.occurrenceKey}`);
    const schedule = this.state.schedules[run.scheduleId];
    if (!schedule) return fail("not_found", `schedule not found: ${run.scheduleId}`);

    let nextRetryAtMs: number | undefined;
    if (schedule.enabled && checked.value.outcome === "failed" && checked.value.retryable && run.attempt < schedule.retry.maxAttempts) {
      const delay = retryDelay(schedule.retry, run.attempt);
      if (!delay.ok) return delay;
      const retryAt = checkedTimestampAdd(now.value, delay.value, "occurrence.nextRetryAtMs");
      if (!retryAt.ok) return retryAt;
      nextRetryAtMs = retryAt.value;
    }

    run.status = checked.value.outcome;
    run.outcome = checked.value.outcome;
    run.terminalAtMs = now.value;
    const completionReason = "reason" in checked.value ? checked.value.reason : undefined;
    if (completionReason) run.reason = completionReason;
    delete occurrence.activeRunId;
    if (!schedule.enabled && checked.value.outcome === "failed" && checked.value.retryable) {
      occurrence.status = "cancelled";
      occurrence.reason = "schedule disabled";
      delete occurrence.nextRetryAtMs;
    } else if (nextRetryAtMs !== undefined) {
      occurrence.status = "retry_wait";
      occurrence.nextRetryAtMs = nextRetryAtMs;
      occurrence.reason = completionReason;
      run.retryScheduledAtMs = occurrence.nextRetryAtMs;
    } else {
      occurrence.status = checked.value.outcome;
      occurrence.reason = completionReason;
    }
    if (run.lease) run.lease.expiresAtMs = Math.min(run.lease.expiresAtMs, now.value);
    return ok(copyRun(run));
    });
  }

  public cancelRun(runId: string, nowMs: number): SchedulerResult<ScheduledRun> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const run = this.state.runs[runId];
    if (!run) return fail("not_found", `run not found: ${runId}`);
    if (terminalStatus(run.status)) return fail("run_terminal", `run is ${run.status}`);
    if (now.value < run.admittedAtMs || (run.dispatch && now.value < run.dispatch.committedAtMs)) {
      return fail("invalid_time", "run cancellation predates persisted lifecycle evidence");
    }
    const occurrence = this.state.occurrences[run.occurrenceKey];
    if (!occurrence) return fail("not_found", `occurrence not found: ${run.occurrenceKey}`);
    if (run.status === "claimed") {
      run.status = "cancelled";
      run.outcome = "cancelled";
      run.terminalAtMs = now.value;
      occurrence.status = "cancelled";
      delete occurrence.activeRunId;
    } else {
      run.status = "cancellation_requested";
      run.cancellationRequestedAtMs = now.value;
      occurrence.status = "cancellation_requested";
    }
    return ok(copyRun(run));
    });
  }

  public cancelOccurrence(key: string, nowMs: number): SchedulerResult<Occurrence> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    const occurrence = this.state.occurrences[key];
    if (!occurrence) return fail("not_found", `occurrence not found: ${key}`);
    if (occurrence.activeRunId) {
      const result = this.cancelRun(occurrence.activeRunId, now.value);
      if (!result.ok) return result;
    } else if (occurrence.status === "pending" || occurrence.status === "retry_wait") {
      occurrence.status = "cancelled";
      occurrence.reason = "cancelled before claim";
    } else if (occurrence.status !== "cancelled") {
      return fail("occurrence_not_claimable", `occurrence is ${occurrence.status}`);
    }
    return ok(copyOccurrence(occurrence));
    });
  }

  public garbageCollectTerminalHistory(): SchedulerResult<number> {
    return this.withDurableMutation(() => {
      let collected = 0;
      for (const [key, occurrence] of Object.entries(this.state.occurrences)) {
        if (!["succeeded", "failed", "cancelled", "blocked-before-action", "missed", "skipped", "outcome_unknown", "guardrail_exhausted"].includes(occurrence.status)) {
          continue;
        }
        if (occurrence.activeRunId !== undefined) {
          return fail("decode_error", "terminal occurrence cannot retain an active run");
        }
        const runs: ScheduledRun[] = [];
        for (const runId of occurrence.runIds) {
          const run = this.state.runs[runId];
          if (!run || !terminalStatus(run.status)) {
            return fail("decode_error", "terminal occurrence history contains a missing or active run");
          }
          runs.push(run);
        }
        for (const run of runs) {
          for (const observationId of run.usageObservationIds) delete this.state.usage[observationId];
          delete this.state.runs[run.id];
        }
        delete this.state.occurrences[key];
        collected += 1;
      }
      return ok(collected);
    });
  }

  public recover(nowMs: number): SchedulerResult<RecoveryReport> {
    return this.withDurableMutation(() => {
    const now = safeTimestamp(nowMs, "nowMs");
    if (!now.ok) return now;
    let expiredLeader = false;
    if (this.state.leader && now.value >= this.state.leader.expiresAtMs) {
      this.state.leader = null;
      expiredLeader = true;
    }
    let reclaimedBeforeDispatch = 0;
    let markedOutcomeUnknown = 0;
    for (const run of Object.values(this.state.runs)) {
      if (!activeRun(run) || !run.lease || now.value < run.lease.expiresAtMs) continue;
      const occurrence = this.state.occurrences[run.occurrenceKey];
      if (!occurrence) continue;
      if (run.status === "claimed") {
        run.status = "missed";
        run.outcome = "missed";
        run.reason = "claim lease expired before dispatch commitment";
        run.terminalAtMs = now.value;
        const schedule = this.state.schedules[run.scheduleId];
        if (schedule && !schedule.enabled) {
          occurrence.status = "cancelled";
          occurrence.reason = "schedule disabled";
        } else if (schedule && Math.max(occurrence.attemptCount, run.attempt) >= schedule.retry.maxAttempts) {
          occurrence.status = "missed";
          occurrence.reason = "retry ceiling reached after pre-dispatch crash";
        } else {
          occurrence.status = "pending";
          occurrence.reason = undefined;
        }
        delete occurrence.activeRunId;
        delete run.lease;
        reclaimedBeforeDispatch += 1;
      } else {
        run.status = "outcome_unknown";
        run.outcome = "outcome_unknown";
        run.reason = "lease expired after dispatch commitment";
        run.terminalAtMs = now.value;
        occurrence.status = "outcome_unknown";
        occurrence.reason = run.reason;
        delete occurrence.activeRunId;
        run.lease.expiresAtMs = now.value;
        markedOutcomeUnknown += 1;
      }
    }
    return ok({ expiredLeader, reclaimedBeforeDispatch, markedOutcomeUnknown });
    });
  }

  public reapExpired(nowMs: number): SchedulerResult<RecoveryReport> {
    return this.recover(nowMs);
  }
}

function decodeLeader(value: unknown): SchedulerResult<LeaderLease | null> {
  if (value === null) return ok(null);
  if (!isRecord(value)) return fail("decode_error", "leader must be an object or null");
  const keys = checkOnlyKeys(value, ["leaseId", "holderId", "fencingEpoch", "issuedAtMs", "expiresAtMs", "durationMs"]);
  if (!keys.ok) return keys;
  for (const field of ["leaseId", "holderId"] as const) if (typeof value[field] !== "string" || !value[field]) return fail("decode_error", `leader.${field} is invalid`);
  if (!isSafePositiveInteger(value.fencingEpoch) || !isSafePositiveInteger(value.durationMs)) return fail("unsafe_integer", "leader fencing epoch and duration must be positive safe integers");
  const checkedIssuedAtMs = safeTimestamp(value.issuedAtMs, "leader.issuedAtMs");
  if (!checkedIssuedAtMs.ok) return checkedIssuedAtMs;
  const checkedExpiresAtMs = safeTimestamp(value.expiresAtMs, "leader.expiresAtMs");
  if (!checkedExpiresAtMs.ok) return checkedExpiresAtMs;
  const durationMs = value.durationMs as number;
  const expiresAtMs = value.expiresAtMs as number;
  const issuedAtMs = value.issuedAtMs as number;
  if (durationMs <= 0 || expiresAtMs < issuedAtMs) return fail("decode_error", "leader timing is invalid");
  return ok(value as unknown as LeaderLease);
}

function decodeSchedule(value: unknown): SchedulerResult<Schedule> {
  if (!isRecord(value)) return fail("decode_error", "schedule must be an object");
  const keys = checkOnlyKeys(value, ["id", "task", "recurrence", "timezone", "timezoneData", "recurrenceNormalizationVersion", "dstGapPolicy", "dstFoldPolicy", "missedRunPolicy", "grantSnapshot", "retry", "concurrency", "claimLeaseMs", "createdAtMs", "enabled", "enablementGeneration", "enablementChangedAtMs", "cursorMs", "nextRunAtMs"]);
  if (!keys.ok) return keys;
  const input: ScheduleInput = {
    id: value.id as string,
    task: value.task as TaskDefinition,
    recurrence: value.recurrence as ScheduleRecurrence,
    timezone: value.timezone as string,
    timezoneData: value.timezoneData as TimeZoneDataBinding,
    recurrenceNormalizationVersion: value.recurrenceNormalizationVersion as number,
    dstGapPolicy: value.dstGapPolicy as DstGapPolicy,
    dstFoldPolicy: value.dstFoldPolicy as DstFoldPolicy,
    missedRunPolicy: value.missedRunPolicy as MissedRunPolicy,
    grant: value.grantSnapshot as GrantSnapshot,
    retry: value.retry as RetryPolicy,
    concurrency: value.concurrency as ScheduleConcurrencyCaps,
    claimLeaseMs: value.claimLeaseMs as number,
    createdAtMs: value.createdAtMs as number,
    enabled: value.enabled as boolean,
  };
  const checked = validateScheduleInput(input);
  if (!checked.ok) return checked;
  const cursorMs = safeTimestamp(value.cursorMs, "schedule.cursorMs");
  if (!cursorMs.ok) return cursorMs;
  if (value.nextRunAtMs !== null) {
    const nextRunAtMs = safeTimestamp(value.nextRunAtMs, "schedule.nextRunAtMs");
    if (!nextRunAtMs.ok) return nextRunAtMs;
  }
  if (typeof value.enabled !== "boolean") return fail("decode_error", "schedule.enabled is invalid");
  if (!isSafePositiveInteger(value.enablementGeneration)) {
    return fail("unsafe_integer", "schedule.enablementGeneration must be a positive safe integer");
  }
  const enablementChangedAtMs = safeTimestamp(value.enablementChangedAtMs, "schedule.enablementChangedAtMs");
  if (!enablementChangedAtMs.ok) return enablementChangedAtMs;
  if (enablementChangedAtMs.value < checked.value.createdAtMs) {
    return fail("decode_error", "schedule enablement transition predates schedule creation");
  }
  if (value.enablementGeneration === 1 && enablementChangedAtMs.value !== checked.value.createdAtMs) {
    return fail("decode_error", "initial schedule enablement evidence must match schedule creation");
  }
  return ok({
    ...checked.value,
    enablementGeneration: value.enablementGeneration,
    enablementChangedAtMs: enablementChangedAtMs.value,
    cursorMs: cursorMs.value,
    nextRunAtMs: value.nextRunAtMs as number | null,
  });
}

function decodeOccurrence(value: unknown): SchedulerResult<Occurrence> {
  if (!isRecord(value)) return fail("decode_error", "occurrence must be an object");
  const keys = checkOnlyKeys(value, ["key", "scheduleId", "taskRevision", "scheduledInstantMs", "createdAtMs", "status", "attemptCount", "nextRetryAtMs", "activeRunId", "runIds", "grantSnapshot", "reason"]);
  if (!keys.ok) return keys;
  for (const field of ["key", "scheduleId"] as const) if (typeof value[field] !== "string" || !value[field]) return fail("decode_error", `occurrence.${field} is invalid`);
  if (!isSafeNonNegativeInteger(value.taskRevision) || !isSafeNonNegativeInteger(value.attemptCount)) return fail("unsafe_integer", "occurrence revision and attempt count are invalid");
  const checkedScheduledInstantMs = safeTimestamp(value.scheduledInstantMs, "occurrence.scheduledInstantMs");
  if (!checkedScheduledInstantMs.ok) return checkedScheduledInstantMs;
  const checkedCreatedAtMs = safeTimestamp(value.createdAtMs, "occurrence.createdAtMs");
  if (!checkedCreatedAtMs.ok) return checkedCreatedAtMs;
  if (typeof value.status !== "string" || !["pending", "claimed", "dispatch_committed", "running", "cancellation_requested", "retry_wait", "succeeded", "failed", "cancelled", "blocked-before-action", "missed", "skipped", "outcome_unknown", "guardrail_exhausted"].includes(value.status)) return fail("decode_error", "occurrence.status is invalid");
  if (!Array.isArray(value.runIds) || value.runIds.some((id) => typeof id !== "string")) return fail("decode_error", "occurrence.runIds is invalid");
  const grant = validateGrant(value.grantSnapshot);
  if (!grant.ok) return grant;
  if (value.nextRetryAtMs !== undefined) {
    const checkedNextRetryAtMs = safeTimestamp(value.nextRetryAtMs, "occurrence.nextRetryAtMs");
    if (!checkedNextRetryAtMs.ok) return checkedNextRetryAtMs;
  }
  if (value.activeRunId !== undefined && typeof value.activeRunId !== "string") return fail("decode_error", "occurrence.activeRunId is invalid");
  if (value.reason !== undefined && typeof value.reason !== "string") return fail("decode_error", "occurrence.reason is invalid");
  const key = value.key as string;
  const scheduleId = value.scheduleId as string;
  const taskRevision = value.taskRevision as number;
  const scheduledInstantMs = value.scheduledInstantMs as number;
  const createdAtMs = value.createdAtMs as number;
  const attemptCount = value.attemptCount as number;
  return ok({
    key,
    scheduleId,
    taskRevision,
    scheduledInstantMs,
    createdAtMs,
    status: value.status as OccurrenceStatus,
    attemptCount,
    ...(value.nextRetryAtMs !== undefined ? { nextRetryAtMs: value.nextRetryAtMs as number } : {}),
    ...(value.activeRunId !== undefined ? { activeRunId: value.activeRunId } : {}),
    runIds: [...value.runIds],
    grantSnapshot: copyGrant(grant.value),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  });
}

function decodeRun(value: unknown): SchedulerResult<ScheduledRun> {
  if (!isRecord(value)) return fail("decode_error", "run must be an object");
  const keys = checkOnlyKeys(value, ["id", "occurrenceKey", "scheduleId", "taskRevision", "attempt", "owner", "request", "grantSnapshot", "status", "admittedAtMs", "admissionFencingEpoch", "lease", "dispatch", "usageBudget", "cancellationRequestedAtMs", "terminalAtMs", "outcome", "reason", "retryScheduledAtMs", "usageObservationIds"]);
  if (!keys.ok) return keys;
  for (const field of ["id", "occurrenceKey", "scheduleId"] as const) if (typeof value[field] !== "string" || !value[field]) return fail("decode_error", `run.${field} is invalid`);
  if (!isSafeNonNegativeInteger(value.taskRevision) || !isSafePositiveInteger(value.attempt) || !isSafePositiveInteger(value.admissionFencingEpoch)) {
    return fail("unsafe_integer", "run revision, attempt, and admission fencing epoch are invalid");
  }
  const checkedAdmittedAtMs = safeTimestamp(value.admittedAtMs, "run.admittedAtMs");
  if (!checkedAdmittedAtMs.ok) return checkedAdmittedAtMs;
  const owner = validateOwner(value.owner, "run.owner");
  if (!owner.ok) return owner;
  if (!isRecord(value.request)) return fail("decode_error", "run.request is invalid");
  const requestKeys = checkOnlyKeys(value.request, ["provider", "model"]);
  if (!requestKeys.ok) return requestKeys;
  const provider = boundedString(value.request.provider, "run.request.provider", 64);
  if (!provider.ok) return provider;
  const model = boundedString(value.request.model, "run.request.model", 256);
  if (!model.ok) return model;
  const grant = validateGrant(value.grantSnapshot);
  if (!grant.ok) return grant;
  if (typeof value.status !== "string" || !["claimed", "dispatch_committed", "running", "cancellation_requested", "succeeded", "failed", "cancelled", "blocked-before-action", "missed", "skipped", "outcome_unknown", "guardrail_exhausted"].includes(value.status)) return fail("decode_error", "run.status is invalid");
  const lease = value.lease === undefined ? ok(undefined) : decodeRunLease(value.lease);
  if (!lease.ok) return lease;
  if (value.dispatch !== undefined) {
    if (!isRecord(value.dispatch)) return fail("decode_error", "run.dispatch is invalid");
    const dispatchKeys = checkOnlyKeys(value.dispatch, ["committedAtMs", "fencingEpoch"]);
    if (!dispatchKeys.ok) return dispatchKeys;
    const committedAtMs = safeTimestamp(value.dispatch.committedAtMs, "run.dispatch.committedAtMs");
    if (!committedAtMs.ok) return committedAtMs;
    if (!isSafePositiveInteger(value.dispatch.fencingEpoch)) return fail("unsafe_integer", "run.dispatch.fencingEpoch is invalid");
  }
  const usageBudget = value.usageBudget === undefined ? ok(undefined) : validateUsageBudget(value.usageBudget, "run.usageBudget");
  if (!usageBudget.ok) return usageBudget;
  for (const field of ["cancellationRequestedAtMs", "terminalAtMs", "retryScheduledAtMs"] as const) {
    if (value[field] !== undefined) {
      const timestamp = safeTimestamp(value[field], `run.${field}`);
      if (!timestamp.ok) return timestamp;
    }
  }
  if (value.outcome !== undefined && (typeof value.outcome !== "string" || !["succeeded", "failed", "cancelled", "blocked-before-action", "missed", "skipped", "outcome_unknown", "guardrail_exhausted"].includes(value.outcome))) {
    return fail("decode_error", "run.outcome is invalid");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") return fail("decode_error", "run.reason is invalid");
  if (!Array.isArray(value.usageObservationIds) || value.usageObservationIds.some((id) => typeof id !== "string")) return fail("decode_error", "run.usageObservationIds is invalid");
  const id = value.id as string;
  const occurrenceKey = value.occurrenceKey as string;
  const scheduleId = value.scheduleId as string;
  const taskRevision = value.taskRevision as number;
  const attempt = value.attempt as number;
  const admittedAtMs = value.admittedAtMs as number;
  const dispatch = value.dispatch as Record<string, unknown> | undefined;
  const cancellationRequestedAtMs = value.cancellationRequestedAtMs as number | undefined;
  const terminalAtMs = value.terminalAtMs as number | undefined;
  const retryScheduledAtMs = value.retryScheduledAtMs as number | undefined;
  return ok({
    id,
    occurrenceKey,
    scheduleId,
    taskRevision,
    attempt,
    owner: owner.value,
    request: { provider: provider.value, model: model.value },
    grantSnapshot: copyGrant(grant.value),
    status: value.status as RunStatus,
    admittedAtMs,
    admissionFencingEpoch: value.admissionFencingEpoch as number,
    ...(lease.value ? { lease: lease.value } : {}),
    ...(dispatch ? { dispatch: { committedAtMs: dispatch.committedAtMs as number, fencingEpoch: dispatch.fencingEpoch as number } } : {}),
    ...(usageBudget.value ? { usageBudget: usageBudget.value } : {}),
    ...(cancellationRequestedAtMs !== undefined ? { cancellationRequestedAtMs } : {}),
    ...(terminalAtMs !== undefined ? { terminalAtMs } : {}),
    ...(value.outcome !== undefined ? { outcome: value.outcome as TerminalOutcome } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(retryScheduledAtMs !== undefined ? { retryScheduledAtMs } : {}),
    usageObservationIds: [...value.usageObservationIds],
  });
}

function validateRunLifecycle(run: ScheduledRun): SchedulerResult<void> {
  const hasDispatch = run.dispatch !== undefined;
  const hasBudget = run.usageBudget !== undefined;
  if (hasDispatch !== hasBudget) return fail("decode_error", "run dispatch and usage budget must be persisted together");
  if (hasDispatch && !run.lease) return fail("decode_error", "a dispatched run must retain its lease evidence");
  if (run.lease && run.lease.fencingEpoch !== run.admissionFencingEpoch) return fail("decode_error", "run lease differs from its immutable admission fence");
  if (run.dispatch && run.dispatch.fencingEpoch !== run.admissionFencingEpoch) return fail("decode_error", "run dispatch differs from its immutable admission fence");
  if (run.lease && run.lease.issuedAtMs !== run.admittedAtMs) return fail("decode_error", "run lease admission evidence is inconsistent");
  if (run.dispatch && run.dispatch.committedAtMs < run.admittedAtMs) return fail("decode_error", "run dispatch predates admission");
  if (run.cancellationRequestedAtMs !== undefined && run.cancellationRequestedAtMs < run.admittedAtMs) {
    return fail("decode_error", "run cancellation predates admission");
  }

  const requireActiveEvidence = (dispatchRequired: boolean, cancellationRequired: boolean): SchedulerResult<void> => {
    if (!run.lease) return fail("decode_error", "an active run must retain its lease evidence");
    if (run.lease.expiresAtMs <= run.lease.issuedAtMs) return fail("decode_error", "an active run lease must have positive remaining chronology");
    if (run.outcome !== undefined || run.terminalAtMs !== undefined || run.retryScheduledAtMs !== undefined || run.reason !== undefined) {
      return fail("decode_error", "an active run cannot contain terminal evidence");
    }
    if (hasDispatch !== dispatchRequired) return fail("decode_error", `${run.status} has invalid dispatch evidence`);
    if ((run.cancellationRequestedAtMs !== undefined) !== cancellationRequired) {
      return fail("decode_error", `${run.status} has invalid cancellation-request evidence`);
    }
    return ok(undefined);
  };
  const requireTerminalEvidence = (): SchedulerResult<void> => {
    if (run.outcome !== run.status || run.terminalAtMs === undefined) {
      return fail("decode_error", "a terminal run must contain matching outcome and terminal timestamp evidence");
    }
    if (run.terminalAtMs < run.admittedAtMs || (run.dispatch && run.terminalAtMs < run.dispatch.committedAtMs)) {
      return fail("decode_error", "run terminal timestamp precedes its lifecycle evidence");
    }
    return ok(undefined);
  };

  switch (run.status) {
    case "claimed":
      return requireActiveEvidence(false, false);
    case "dispatch_committed":
    case "running":
      return requireActiveEvidence(true, false);
    case "cancellation_requested":
      return requireActiveEvidence(true, true);
    case "blocked-before-action":
    case "guardrail_exhausted":
    case "missed": {
      const terminal = requireTerminalEvidence();
      if (!terminal.ok) return terminal;
      if (run.lease || hasDispatch || run.cancellationRequestedAtMs !== undefined || run.retryScheduledAtMs !== undefined) {
        return fail("decode_error", `${run.status} cannot contain lease, dispatch, budget, cancellation, or retry evidence`);
      }
      if (!run.reason) return fail("decode_error", `${run.status} requires terminal reason evidence`);
      return ok(undefined);
    }
    case "succeeded":
    case "failed":
    case "outcome_unknown": {
      const terminal = requireTerminalEvidence();
      if (!terminal.ok) return terminal;
      if (!run.lease || !hasDispatch) return fail("decode_error", `${run.status} requires committed dispatch and usage-budget evidence`);
      if (run.status !== "failed" && run.retryScheduledAtMs !== undefined) {
        return fail("decode_error", `${run.status} cannot contain retry evidence`);
      }
      if (run.status === "failed" && run.retryScheduledAtMs !== undefined && run.retryScheduledAtMs < run.terminalAtMs!) {
        return fail("decode_error", "retry evidence predates the failed run terminal timestamp");
      }
      if ((run.status === "failed" || run.status === "outcome_unknown") && !run.reason) {
        return fail("decode_error", `${run.status} requires terminal reason evidence`);
      }
      return ok(undefined);
    }
    case "cancelled": {
      const terminal = requireTerminalEvidence();
      if (!terminal.ok) return terminal;
      if (!run.lease) return fail("decode_error", "a cancelled run must retain its claim lease evidence");
      if (run.retryScheduledAtMs !== undefined) return fail("decode_error", "a cancelled run cannot contain retry evidence");
      if (run.cancellationRequestedAtMs !== undefined && !hasDispatch) {
        return fail("decode_error", "cancellation-request evidence requires a dispatched run");
      }
      return ok(undefined);
    }
    case "skipped":
      return fail("decode_error", "a skipped span cannot be represented as a run");
    default: {
      const exhaustive: never = run.status;
      return fail("decode_error", `unsupported run status: ${exhaustive}`);
    }
  }
}

function validateOccurrenceLifecycle(
  occurrence: Occurrence,
  schedule: Schedule,
  runs: Record<string, ScheduledRun>,
): SchedulerResult<void> {
  const latestRunId = occurrence.runIds[occurrence.runIds.length - 1];
  const latest = latestRunId === undefined ? undefined : runs[latestRunId];
  if (occurrence.activeRunId !== undefined) {
    return occurrence.activeRunId === latestRunId
      ? ok(undefined)
      : fail("decode_error", "occurrence active run must be its latest persisted attempt");
  }

  if (occurrence.status === "retry_wait") {
    if (!schedule.enabled || !latest || latest.status !== "failed"
      || latest.retryScheduledAtMs === undefined
      || occurrence.nextRetryAtMs !== latest.retryScheduledAtMs
      || latest.attempt >= schedule.retry.maxAttempts
      || occurrence.reason !== latest.reason) {
      return fail("decode_error", "retry_wait must exactly match its latest eligible failed run");
    }
    return ok(undefined);
  }

  if (occurrence.status === "pending") {
    if (!latest) {
      if (occurrence.attemptCount !== 0 || occurrence.runIds.length !== 0 || occurrence.reason !== undefined) {
        return fail("decode_error", "initial pending occurrence contains persisted predecessor evidence");
      }
      return ok(undefined);
    }
    if (!schedule.enabled || latest.status !== "missed" || latest.dispatch !== undefined || latest.lease !== undefined
      || latest.reason !== "claim lease expired before dispatch commitment"
      || latest.attempt >= schedule.retry.maxAttempts || occurrence.reason !== undefined) {
      return fail("decode_error", "recovered pending occurrence lacks its exact missed predecessor");
    }
    return ok(undefined);
  }

  if (activeRun({ status: occurrence.status } as ScheduledRun)) {
    return fail("decode_error", "active occurrence has no matching active run");
  }

  if (!latest) {
    const allowedPreclaimCancellation = occurrence.status === "cancelled"
      && (occurrence.reason === "cancelled before claim"
        || (!schedule.enabled && occurrence.reason === "schedule disabled"));
    return allowedPreclaimCancellation
      ? ok(undefined)
      : fail("decode_error", "terminal occurrence has no persisted terminal predecessor");
  }

  if (occurrence.status === "cancelled" && latest.status !== "cancelled") {
    const cancelledDuringWait = terminalStatus(latest.status)
      && (occurrence.reason === "cancelled before claim"
        || (!schedule.enabled && occurrence.reason === "schedule disabled"));
    return cancelledDuringWait
      ? ok(undefined)
      : fail("decode_error", "cancelled occurrence lacks an allowed unclaimed predecessor");
  }

  if (occurrence.status !== latest.status || occurrence.reason !== latest.reason) {
    return fail("decode_error", "terminal occurrence must exactly match its latest run outcome");
  }
  return ok(undefined);
}

function decodeRunLease(value: unknown): SchedulerResult<RunLease> {
  if (!isRecord(value)) return fail("decode_error", "run.lease is invalid");
  const keys = checkOnlyKeys(value, ["leaseId", "runId", "holderId", "fencingEpoch", "issuedAtMs", "expiresAtMs", "durationMs"]);
  if (!keys.ok) return keys;
  for (const field of ["leaseId", "runId", "holderId"] as const) if (typeof value[field] !== "string" || !value[field]) return fail("decode_error", `run.lease.${field} is invalid`);
  if (!isSafePositiveInteger(value.fencingEpoch) || !isSafePositiveInteger(value.durationMs)) return fail("unsafe_integer", "run lease fencing epoch and duration are invalid");
  const checkedIssuedAtMs = safeTimestamp(value.issuedAtMs, "run.lease.issuedAtMs");
  if (!checkedIssuedAtMs.ok) return checkedIssuedAtMs;
  const checkedExpiresAtMs = safeTimestamp(value.expiresAtMs, "run.lease.expiresAtMs");
  if (!checkedExpiresAtMs.ok) return checkedExpiresAtMs;
  const durationMs = value.durationMs as number;
  const expiresAtMs = value.expiresAtMs as number;
  const issuedAtMs = value.issuedAtMs as number;
  if (durationMs <= 0 || expiresAtMs < issuedAtMs) return fail("decode_error", "run lease timing is invalid");
  return ok(value as unknown as RunLease);
}

function decodeUsage(value: unknown): SchedulerResult<UsageObservation> {
  if (!isRecord(value)) return fail("decode_error", "usage must be an object");
  const keys = checkOnlyKeys(value, ["observationId", "runId", "observedAtMs", "provider", "model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "source"]);
  if (!keys.ok) return keys;
  for (const field of ["observationId", "runId"] as const) if (typeof value[field] !== "string" || !value[field]) return fail("decode_error", `usage.${field} is invalid`);
  const provider = boundedString(value.provider, "usage.provider", 64);
  if (!provider.ok) return provider;
  const model = boundedString(value.model, "usage.model", 256);
  if (!model.ok) return model;
  const observedAtMs = safeTimestamp(value.observedAtMs, "usage.observedAtMs");
  if (!observedAtMs.ok) return observedAtMs;
  if (!["reported", "derived", "estimated"].includes(value.source as string)) return fail("decode_error", "usage.source is invalid");
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) if (value[field] !== undefined && !isSafeNonNegativeInteger(value[field])) return fail("unsafe_integer", `usage.${field} is invalid`);
  return ok({ ...(value as unknown as UsageObservation), provider: provider.value, model: model.value, observedAtMs: observedAtMs.value });
}

function generatedSequenceSuffix(id: string, prefix: "leader" | "run" | "run-lease"): SchedulerResult<number> {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  if (!match) return ok(0);
  const suffix = Number(match[1]);
  if (!Number.isSafeInteger(suffix)) return fail("unsafe_integer", `generated identifier is outside the safe sequence range: ${id}`);
  return ok(suffix);
}

function decodeFencingEpochHistory(value: unknown, nextFencingEpoch: number): SchedulerResult<FencingEpochRecord[]> {
  if (!Array.isArray(value)) return fail("decode_error", "fencing epoch history must be an array");
  const history: FencingEpochRecord[] = [];
  const leaseIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return fail("decode_error", "fencing epoch history entry must be an object");
    const keys = checkOnlyKeys(item, ["fencingEpoch", "leaderLeaseId", "holderId", "issuedAtMs"]);
    if (!keys.ok) return keys;
    if (!isSafePositiveInteger(item.fencingEpoch)) return fail("unsafe_integer", "fencing history epoch must be a positive safe integer");
    if (typeof item.leaderLeaseId !== "string" || !item.leaderLeaseId || typeof item.holderId !== "string" || !item.holderId) {
      return fail("decode_error", "fencing history identity is invalid");
    }
    const issuedAtMs = safeTimestamp(item.issuedAtMs, "fencingEpochHistory.issuedAtMs");
    if (!issuedAtMs.ok) return issuedAtMs;
    const generatedLeaseSuffix = generatedSequenceSuffix(item.leaderLeaseId, "leader");
    if (!generatedLeaseSuffix.ok) return generatedLeaseSuffix;
    if (generatedLeaseSuffix.value === 0) return fail("decode_error", "fencing history leader lease id is not scheduler-generated");
    const previous = history[history.length - 1];
    if (previous && item.fencingEpoch !== previous.fencingEpoch + 1) {
      return fail("decode_error", "fencing epoch history must be strictly consecutive");
    }
    if (previous && issuedAtMs.value < previous.issuedAtMs) {
      return fail("decode_error", "fencing epoch history issuance time cannot move backwards");
    }
    if (leaseIds.has(item.leaderLeaseId)) return fail("decode_error", "fencing epoch history reuses a leader lease id");
    leaseIds.add(item.leaderLeaseId);
    history.push({
      fencingEpoch: item.fencingEpoch as number,
      leaderLeaseId: item.leaderLeaseId,
      holderId: item.holderId,
      issuedAtMs: issuedAtMs.value,
    });
  }
  const durableHighWater = history[history.length - 1]?.fencingEpoch ?? 0;
  if (durableHighWater !== nextFencingEpoch) {
    return fail("decode_error", "next fencing epoch must equal the durable fencing history high-water");
  }
  return ok(history);
}

function decodeDurableEvidence(value: unknown): SchedulerResult<SchedulerDurableEvidence> {
  if (!isRecord(value)) return fail("decode_error", "durable scheduler evidence must be an object");
  const keys = checkOnlyKeys(value, [
    "authorityId",
    "lineageId",
    "revision",
    "fencingEpochHighWater",
    "sequenceHighWater",
    "scheduleEnablement",
    "attestationId",
  ]);
  if (!keys.ok) return keys;
  for (const field of ["authorityId", "lineageId", "attestationId"] as const) {
    if (typeof value[field] !== "string" || !value[field] || value[field].length > 256) {
      return fail("decode_error", `durableEvidence.${field} is invalid`);
    }
  }
  if (!isSafeNonNegativeInteger(value.revision)
    || !isSafeNonNegativeInteger(value.fencingEpochHighWater)
    || !isSafeNonNegativeInteger(value.sequenceHighWater)) {
    return fail("unsafe_integer", "durable scheduler evidence high-water values must be safe integers");
  }
  if (value.attestationId !== `${value.lineageId}:revision-${value.revision}`) {
    return fail("decode_error", "durable scheduler attestation identity is inconsistent");
  }
  if (!Array.isArray(value.scheduleEnablement)) {
    return fail("decode_error", "durable schedule enablement evidence must be an array");
  }
  const scheduleEnablement: ScheduleEnablementEvidence[] = [];
  for (const item of value.scheduleEnablement) {
    if (!isRecord(item)) return fail("decode_error", "durable schedule enablement entry must be an object");
    const entryKeys = checkOnlyKeys(item, ["scheduleId", "generation", "enabled", "changedAtMs"]);
    if (!entryKeys.ok) return entryKeys;
    if (typeof item.scheduleId !== "string" || !item.scheduleId || item.scheduleId.length > 256
      || !isSafePositiveInteger(item.generation) || typeof item.enabled !== "boolean") {
      return fail("decode_error", "durable schedule enablement entry is invalid");
    }
    const changedAtMs = safeTimestamp(item.changedAtMs, "durableEvidence.scheduleEnablement.changedAtMs");
    if (!changedAtMs.ok) return changedAtMs;
    const previous = scheduleEnablement[scheduleEnablement.length - 1];
    if (previous && previous.scheduleId >= item.scheduleId) {
      return fail("decode_error", "durable schedule enablement entries must have unique sorted identities");
    }
    scheduleEnablement.push({
      scheduleId: item.scheduleId,
      generation: item.generation,
      enabled: item.enabled,
      changedAtMs: changedAtMs.value,
    });
  }
  return ok({
    authorityId: value.authorityId as string,
    lineageId: value.lineageId as string,
    revision: value.revision,
    fencingEpochHighWater: value.fencingEpochHighWater,
    sequenceHighWater: value.sequenceHighWater,
    scheduleEnablement,
    attestationId: value.attestationId as string,
  });
}

function verifyDurableState(
  authority: SchedulerDurableAuthority | undefined,
  state: SchedulerState,
): SchedulerResult<void> {
  const authenticated = authorityState(authority);
  if (!authenticated.ok) return authenticated;
  const evidence = state.durableEvidence;
  const current = authenticated.value.lineages.get(evidence.lineageId);
  if (!current || current.evidence.authorityId !== authenticated.value.authorityId
    || !sameDurableEvidence(current.evidence, evidence)) {
    return fail("decode_error", "durable scheduler evidence is stale or unauthenticated");
  }
  if (state.nextFencingEpoch !== evidence.fencingEpochHighWater || state.sequence !== evidence.sequenceHighWater) {
    return fail("decode_error", "serialized scheduler state must exactly match its authenticated durable high-water");
  }
  if (JSON.stringify(scheduleEnablementEvidence(state.schedules)) !== JSON.stringify(evidence.scheduleEnablement)) {
    return fail("decode_error", "schedule enablement state does not match authenticated durable evidence");
  }
  if (durableStateCommitment(state) !== current.stateCommitment) {
    return fail("decode_error", "serialized scheduler state does not match its authenticated durable commitment");
  }
  return ok(undefined);
}

export function decodeSerializedState(
  input: unknown,
  adapter: TimeZoneAdapter = defaultTimeZoneAdapter,
  durableAuthority?: SchedulerDurableAuthority,
): SchedulerResult<SchedulerState> {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return fail("decode_error", "serialized scheduler state is not valid JSON");
    }
  }
  if (!isRecord(value)) return fail("decode_error", "scheduler state must be an object");
  const keys = checkOnlyKeys(value, ["schemaVersion", "sequence", "nextFencingEpoch", "fencingEpochHistory", "durableEvidence", "policy", "leader", "schedules", "occurrences", "runs", "usage", "skippedSpans"]);
  if (!keys.ok) return keys;
  if (value.schemaVersion !== 4) return fail("decode_error", "unsupported scheduler schema version");
  if (!("sequence" in value) || !("nextFencingEpoch" in value) || !("fencingEpochHistory" in value) || !("durableEvidence" in value) || !("policy" in value) || !("leader" in value) || !("schedules" in value) || !("occurrences" in value) || !("runs" in value) || !("usage" in value) || !("skippedSpans" in value)) {
    return fail("decode_error", "scheduler state is missing a required field");
  }
  if (!isSafeNonNegativeInteger(value.sequence) || !isSafeNonNegativeInteger(value.nextFencingEpoch)) return fail("unsafe_integer", "scheduler sequence values must be safe");
  const durableEvidence = decodeDurableEvidence(value.durableEvidence);
  if (!durableEvidence.ok) return durableEvidence;
  const fencingEpochHistory = decodeFencingEpochHistory(value.fencingEpochHistory, value.nextFencingEpoch as number);
  if (!fencingEpochHistory.ok) return fencingEpochHistory;
  const policy = validatePolicy(value.policy);
  if (!policy.ok) return policy;
  const leader = decodeLeader(value.leader);
  if (!leader.ok) return leader;
  if (leader.value) {
    const latestFence = fencingEpochHistory.value[fencingEpochHistory.value.length - 1];
    if (!latestFence || latestFence.fencingEpoch !== leader.value.fencingEpoch
      || latestFence.leaderLeaseId !== leader.value.leaseId
      || latestFence.holderId !== leader.value.holderId
      || latestFence.issuedAtMs !== leader.value.issuedAtMs) {
      return fail("decode_error", "active leader does not match the durable fencing high-water record");
    }
  }
  if (!isRecord(value.schedules) || !isRecord(value.occurrences) || !isRecord(value.runs) || !isRecord(value.usage) || !Array.isArray(value.skippedSpans)) return fail("decode_error", "scheduler maps are malformed");
  const schedules: Record<string, Schedule> = {};
  for (const [id, scheduleValue] of Object.entries(value.schedules)) {
    if (id !== (isRecord(scheduleValue) ? scheduleValue.id : undefined)) return fail("decode_error", "schedule map key does not match its id");
    const schedule = decodeSchedule(scheduleValue);
    if (!schedule.ok) return schedule;
    const timeZoneData = requireTimeZoneData(schedule.value.timezoneData, schedule.value.timezone, adapter);
    if (!timeZoneData.ok) return timeZoneData;
    if (schedule.value.grantSnapshot.policyVersion > policy.value.policyVersion || schedule.value.grantSnapshot.epoch > policy.value.epoch) {
      return fail("policy_regression", "serialized policy predates a persisted grant snapshot");
    }
    schedules[id] = schedule.value;
  }
  const occurrences: Record<string, Occurrence> = {};
  for (const [key, occurrenceValue] of Object.entries(value.occurrences)) {
    const occurrence = decodeOccurrence(occurrenceValue);
    if (!occurrence.ok) return occurrence;
    if (occurrence.value.key !== key) return fail("decode_error", "occurrence map key does not match its key");
    occurrences[key] = occurrence.value;
  }
  const runs: Record<string, ScheduledRun> = {};
  for (const [id, runValue] of Object.entries(value.runs)) {
    const run = decodeRun(runValue);
    if (!run.ok) return run;
    if (run.value.id !== id) return fail("decode_error", "run map key does not match its id");
    runs[id] = run.value;
  }
  const usage: Record<string, UsageObservation> = {};
  for (const [id, usageValue] of Object.entries(value.usage)) {
    const decoded = decodeUsage(usageValue);
    if (!decoded.ok) return decoded;
    if (decoded.value.observationId !== id) return fail("decode_error", "usage map key does not match its id");
    usage[id] = decoded.value;
  }
  const skippedSpans: SkippedSpan[] = [];
  for (const span of value.skippedSpans) {
    if (!isRecord(span)) return fail("decode_error", "skipped span is malformed");
    const spanKeys = checkOnlyKeys(span, ["scheduleId", "taskRevision", "startMs", "endMs", "count", "reason"]);
    if (!spanKeys.ok) return spanKeys;
    if (typeof span.scheduleId !== "string" || !isSafeNonNegativeInteger(span.taskRevision) || !isSafePositiveInteger(span.count) || !["missed-catch-up-compressed", "missed-policy-skip"].includes(span.reason as string)) return fail("decode_error", "skipped span is invalid");
    const startMs = safeTimestamp(span.startMs, "skippedSpan.startMs");
    if (!startMs.ok) return startMs;
    const endMs = safeTimestamp(span.endMs, "skippedSpan.endMs");
    if (!endMs.ok) return endMs;
    if (endMs.value < startMs.value) return fail("decode_error", "skipped span end precedes its start");
    skippedSpans.push(span as unknown as SkippedSpan);
  }
  for (const occurrence of Object.values(occurrences)) {
    const schedule = schedules[occurrence.scheduleId];
    if (!schedule || occurrence.taskRevision !== schedule.task.revision || occurrence.key !== occurrenceKeyString({ scheduleId: occurrence.scheduleId, taskRevision: occurrence.taskRevision, scheduledInstantMs: occurrence.scheduledInstantMs })) {
      return fail("decode_error", "occurrence does not reference its schedule consistently");
    }
    if (JSON.stringify(occurrence.grantSnapshot) !== JSON.stringify(schedule.grantSnapshot)) {
      return fail("decode_error", "occurrence grant snapshot does not match its schedule");
    }
    if (schedule.grantSnapshot.policyVersion > policy.value.policyVersion || schedule.grantSnapshot.epoch > policy.value.epoch) {
      return fail("policy_regression", "serialized policy predates a persisted grant snapshot");
    }
    if (!schedule.enabled && (occurrence.status === "pending" || occurrence.status === "retry_wait" || occurrence.status === "claimed")) {
      return fail("decode_error", "disabled schedule contains pre-dispatch work");
    }
    if ((occurrence.status === "retry_wait") !== (occurrence.nextRetryAtMs !== undefined)) {
      return fail("decode_error", "occurrence retry status and retry timestamp must be persisted together");
    }
    if (new Set(occurrence.runIds).size !== occurrence.runIds.length) return fail("decode_error", "occurrence run references contain duplicates");
    let persistedAttemptHighWater = 0;
    for (const [runIndex, runId] of occurrence.runIds.entries()) {
      const run = runs[runId];
      if (!run || run.occurrenceKey !== occurrence.key) return fail("decode_error", "occurrence run reference is broken");
      if (run.attempt > schedule.retry.maxAttempts) return fail("decode_error", "run attempt exceeds the schedule retry ceiling");
      if (run.attempt !== runIndex + 1) return fail("decode_error", "occurrence run attempts must form an exact persisted sequence");
      persistedAttemptHighWater = Math.max(persistedAttemptHighWater, run.attempt);
    }
    if (occurrence.attemptCount !== persistedAttemptHighWater) {
      return fail("decode_error", "occurrence attempt counter must equal its persisted run attempt high-water");
    }
    if (occurrence.attemptCount > schedule.retry.maxAttempts) return fail("decode_error", "occurrence attempt counter exceeds the schedule retry ceiling");
    if ((occurrence.status === "pending" || occurrence.status === "retry_wait") && occurrence.attemptCount >= schedule.retry.maxAttempts) {
      return fail("decode_error", "claimable occurrence has exhausted its retry ceiling");
    }
    const activeRuns = occurrence.runIds.map((runId) => runs[runId]).filter((run) => run !== undefined && activeRun(run));
    if (activeRuns.length > 1) return fail("decode_error", "occurrence has multiple active runs");
    if (occurrence.activeRunId !== undefined) {
      const active = runs[occurrence.activeRunId];
      if (!active || !activeRun(active) || !occurrence.runIds.includes(active.id) || active.status !== occurrence.status) {
        return fail("decode_error", "occurrence active run reference is inconsistent");
      }
    } else if (activeRuns.length !== 0) {
      return fail("decode_error", "active run is not referenced by its occurrence");
    }
    const occurrenceLifecycle = validateOccurrenceLifecycle(occurrence, schedule, runs);
    if (!occurrenceLifecycle.ok) return occurrenceLifecycle;
  }
  for (const run of Object.values(runs)) {
    const lifecycle = validateRunLifecycle(run);
    if (!lifecycle.ok) return lifecycle;
    const occurrence = occurrences[run.occurrenceKey];
    if (!occurrence || !occurrence.runIds.includes(run.id) || run.scheduleId !== occurrence.scheduleId || run.taskRevision !== occurrence.taskRevision) {
      return fail("decode_error", "run does not reference its occurrence consistently");
    }
    const schedule = schedules[run.scheduleId];
    if (!schedule || JSON.stringify(run.owner) !== JSON.stringify(schedule.task.owner) || JSON.stringify(run.request) !== JSON.stringify(schedule.task.request)) {
      return fail("decode_error", "run ownership or request does not match its schedule");
    }
    if (JSON.stringify(run.grantSnapshot) !== JSON.stringify(occurrence.grantSnapshot)) {
      return fail("decode_error", "run grant snapshot does not match its occurrence");
    }
    if (run.lease && run.lease.runId !== run.id) return fail("decode_error", "run lease does not reference its run");
    const admissionFence = fencingEpochHistory.value.find((entry) => entry.fencingEpoch === run.admissionFencingEpoch);
    if (!admissionFence) return fail("decode_error", "run admission fence is absent from durable history");
    if (run.admittedAtMs < admissionFence.issuedAtMs || run.admittedAtMs < occurrence.createdAtMs
      || run.admittedAtMs < schedule.createdAtMs || run.admittedAtMs < run.grantSnapshot.issuedAtMs) {
      return fail("decode_error", "run admission predates its durable fencing, occurrence, schedule, or grant evidence");
    }
    if (run.lease) {
      const fence = fencingEpochHistory.value.find((entry) => entry.fencingEpoch === run.lease!.fencingEpoch);
      if (!fence || fence.fencingEpoch !== admissionFence.fencingEpoch || fence.holderId !== run.lease.holderId
        || run.lease.issuedAtMs !== run.admittedAtMs || run.lease.issuedAtMs < fence.issuedAtMs) {
        return fail("decode_error", "run lease does not exactly join its durable admission fence");
      }
    }
    if (run.dispatch && (!run.lease || run.dispatch.fencingEpoch !== run.lease.fencingEpoch)) {
      return fail("decode_error", "run dispatch fencing epoch does not match its lease");
    }
    if (run.dispatch && !fencingEpochHistory.value.some((entry) => entry.fencingEpoch === run.dispatch!.fencingEpoch)) {
      return fail("decode_error", "run dispatch fence is absent from durable history");
    }
    if (run.dispatch && run.dispatch.committedAtMs < admissionFence.issuedAtMs) {
      return fail("decode_error", "run dispatch predates its durable admission fence");
    }
    if (run.terminalAtMs !== undefined && run.terminalAtMs < admissionFence.issuedAtMs) {
      return fail("decode_error", "run terminal evidence predates its durable admission fence");
    }
    for (const usageId of run.usageObservationIds) {
      const observation = usage[usageId];
      if (!observation || observation.runId !== run.id) return fail("decode_error", "run usage reference is broken");
    }
  }
  for (const observation of Object.values(usage)) {
    const run = runs[observation.runId];
    if (!run || !run.usageObservationIds.includes(observation.observationId)) return fail("decode_error", "usage run reference is broken");
    if (observation.observedAtMs < run.admittedAtMs) return fail("decode_error", "usage observation predates run admission");
    if (observation.provider !== run.request.provider || observation.model !== run.request.model) {
      return fail("decode_error", "usage provider/model does not match its run");
    }
  }
  let generatedSequenceHighWater = 0;
  const generatedIds: Array<[string, "leader" | "run" | "run-lease"]> = [];
  if (leader.value) generatedIds.push([leader.value.leaseId, "leader"]);
  for (const fence of fencingEpochHistory.value) generatedIds.push([fence.leaderLeaseId, "leader"]);
  for (const run of Object.values(runs)) {
    generatedIds.push([run.id, "run"]);
    if (run.lease) generatedIds.push([run.lease.leaseId, "run-lease"]);
  }
  for (const [id, prefix] of generatedIds) {
    const suffix = generatedSequenceSuffix(id, prefix);
    if (!suffix.ok) return suffix;
    generatedSequenceHighWater = Math.max(generatedSequenceHighWater, suffix.value);
  }
  if (generatedSequenceHighWater > value.sequence) {
    return fail("decode_error", "serialized scheduler sequence is lower than its generated identity high-water");
  }
  const decodedState: SchedulerState = {
    schemaVersion: 4,
    sequence: value.sequence,
    nextFencingEpoch: value.nextFencingEpoch,
    fencingEpochHistory: fencingEpochHistory.value,
    durableEvidence: durableEvidence.value,
    policy: policy.value,
    leader: leader.value,
    schedules,
    occurrences,
    runs,
    usage,
    skippedSpans,
  };
  const durable = verifyDurableState(durableAuthority, decodedState);
  if (!durable.ok) return durable;
  return ok(decodedState);
}
