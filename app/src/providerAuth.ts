/**
 * Pure, credential-free provider account and authentication domain.
 *
 * Prime owns provider credentials and login. This module only models the
 * non-secret profile/account relationship, observed auth health, capabilities,
 * policy eligibility, and the proof that a Prime session is attached to the
 * selected account at the current auth/capability epochs.
 */

export const CLAUDE_PROVIDER_ID = "anthropic";
export const CHATGPT_CODEX_PROVIDER_ID = "openai-codex";

export type ProviderId = string;

export const AUTH_MODE = {
  SUBSCRIPTION_MANAGED: "subscription-managed",
  API_KEY: "api-key",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
} as const;

export type AuthMode = (typeof AUTH_MODE)[keyof typeof AUTH_MODE];

export const AUTH_STATUS = {
  NOT_INSTALLED: "not-installed",
  SIGNED_OUT: "signed-out",
  READY: "ready",
  REFRESHING: "refreshing",
  EXPIRED: "expired",
  REAUTH_REQUIRED: "reauth-required",
  REVOKED: "revoked",
  UNAVAILABLE: "unavailable",
  RATE_LIMITED: "rate-limited",
} as const;

export type AuthStatus = (typeof AUTH_STATUS)[keyof typeof AUTH_STATUS];

export const CAPABILITY_READINESS = {
  READY: "ready",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown",
} as const;

export type CapabilityReadiness = (typeof CAPABILITY_READINESS)[keyof typeof CAPABILITY_READINESS];

export const ADAPTER_SUPPORT = {
  SUPPORTED: "supported",
  UNSUPPORTED: "unsupported",
} as const;

export type AdapterSupport = (typeof ADAPTER_SUPPORT)[keyof typeof ADAPTER_SUPPORT];

export const PUBLIC_SUBSCRIPTION = {
  AUTHORIZED: "authorized",
  UNAUTHORIZED: "unauthorized",
} as const;

export type PublicSubscriptionSupport = (typeof PUBLIC_SUBSCRIPTION)[keyof typeof PUBLIC_SUBSCRIPTION];

export const AUTH_HEALTH = {
  NOT_INSTALLED: "not-installed",
  READY: "ready",
  EXPIRING_SOON: "expiring-soon",
  EXPIRED: "expired",
  SIGNED_OUT: "signed-out",
  REFRESHING: "refreshing",
  REAUTH_REQUIRED: "reauth-required",
  REVOKED: "revoked",
  UNAVAILABLE: "unavailable",
  RATE_LIMITED: "rate-limited",
  RECONCILIATION_REQUIRED: "reconciliation-required",
} as const;

export type AuthHealth = (typeof AUTH_HEALTH)[keyof typeof AUTH_HEALTH];

export const AUTH_REASON = {
  USER_SIGNED_OUT: "user-signed-out",
  PROVIDER_REVOKED: "provider-revoked",
  PROVIDER_UNAVAILABLE: "provider-unavailable",
  PROVIDER_NOT_INSTALLED: "provider-not-installed",
  EXPIRED: "expired",
  EXPIRED_AT_AUTHENTICATION: "expired-at-authentication",
  EXPIRED_AT_REFRESH: "expired-at-refresh",
  REFRESH_REJECTED: "refresh-rejected",
  PROVIDER_RATE_LIMITED: "provider-rate-limited",
} as const;

export type AuthReasonCode = (typeof AUTH_REASON)[keyof typeof AUTH_REASON];

export const CAPABILITY_REASON = {
  PROVIDER_DEGRADED: "provider-reported-degraded",
  PROVIDER_UNAVAILABLE: "provider-reported-unavailable",
  PROVIDER_UNKNOWN: "provider-reported-unknown",
} as const;

export type CapabilityReasonCode = (typeof CAPABILITY_REASON)[keyof typeof CAPABILITY_REASON];

export interface ProviderProfile {
  profileId: string;
  providerId: ProviderId;
  label: string;
  /** A mode label only; no credential or credential handle is stored. */
  authMode: AuthMode;
}

export interface RefreshAttempt {
  accountId: string;
  attemptId: string;
  baseAuthEpoch: number;
  startedAtMs: number;
}

export interface ObservationSource {
  providerId: ProviderId;
  profileId: string;
  accountId: string;
  generation: number;
  sequence: number;
}

export interface AuthSnapshot {
  status: AuthStatus;
  /** Monotonically increases whenever the usable auth principal changes. */
  authEpoch: number;
  expiresAtMs: number | null;
  rateLimitExpiresAtMs: number | null;
  updatedAtMs: number;
  reason: AuthReasonCode | null;
  refresh: RefreshAttempt | null;
  source: ObservationSource | null;
  /** Live trust is deliberately cleared by persistence decoding. */
  live: boolean;
}

export interface CapabilityObservation {
  readiness: CapabilityReadiness;
  observedAtMs: number;
  reason: CapabilityReasonCode | null;
  source: ObservationSource;
  /** Live trust is deliberately cleared by persistence decoding. */
  live: boolean;
}

export type CapabilityInput = Pick<CapabilityObservation, "readiness" | "observedAtMs" | "source"> & {
  reason?: CapabilityReasonCode | null;
};

export interface ProviderAccount {
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  label: string;
  auth: AuthSnapshot;
  capabilities: Record<string, CapabilityObservation>;
  /** Changes whenever any capability observation changes. */
  capabilityEpoch: number;
}

export interface ProviderAccountInput {
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  label: string;
  nowMs?: number;
  capabilities?: Readonly<Record<string, CapabilityInput>>;
}

export interface SelectedAccountBinding {
  projectId: string;
  sessionId: string;
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  selectionGeneration: number;
  selectedAtMs: number;
}

export interface ProviderAuthDomain {
  schemaVersion: 1;
  profiles: readonly ProviderProfile[];
  accounts: readonly ProviderAccount[];
  selectedAccounts: readonly SelectedAccountBinding[];
}

export interface ProviderAdapterPolicy {
  subscriptionManaged: AdapterSupport;
  apiKey: AdapterSupport;
  /** Public subscription-backed login requires explicit provider authorization. */
  publicSubscription: PublicSubscriptionSupport;
}

export interface AuthPolicy {
  release: "personal" | "public";
  adapters: Record<ProviderId, ProviderAdapterPolicy>;
}

export type DomainErrorCode =
  | "invalid-runtime-input"
  | "invalid-transition"
  | "account-not-found"
  | "profile-not-found"
  | "account-profile-mismatch"
  | "session-not-selected"
  | "session-mismatch"
  | "session-account-mismatch"
  | "stale-selection-generation"
  | "observation-source-mismatch"
  | "stale-observation"
  | "non-monotonic-observation-time"
  | "invalid-required-capabilities"
  | "live-reconciliation-required"
  | "stale-auth-epoch"
  | "stale-capability-epoch"
  | "stale-refresh"
  | "refresh-in-progress"
  | "refresh-not-allowed"
  | "not-eligible"
  | "profile-unavailable"
  | "profile-unsupported"
  | "provider-policy-missing"
  | "subscription-adapter-unsupported"
  | "public-subscription-not-authorized"
  | "api-key-adapter-unsupported"
  | "signed-out"
  | "expired"
  | "revoked"
  | "reauth-required"
  | "refreshing"
  | "auth-unavailable"
  | "auth-not-installed"
  | "rate-limited"
  | "rate-limit-not-active"
  | "rate-limit-not-expired"
  | "capability-not-ready";

export interface DomainError {
  code: DomainErrorCode;
  path?: string;
}

export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export type EligibilityStatus = "eligible" | "reauth-required" | "unavailable" | "unsupported";

export interface ProviderEligibility {
  status: EligibilityStatus;
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  mode: AuthMode;
  authEpoch: number;
  capabilityEpoch: number;
  reason?: DomainErrorCode;
  capabilityId?: string;
}

export interface EligibilityRequest {
  accountId: string;
  nowMs: number;
  policy: AuthPolicy;
  requiredCapabilities?: readonly string[];
}

export interface RefreshStart {
  domain: ProviderAuthDomain;
  attempt: RefreshAttempt;
}

export interface SessionAttachmentProof {
  version: 1;
  projectId: string;
  sessionId: string;
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  selectionGeneration: number;
  authEpoch: number;
  capabilityEpoch: number;
  issuedAtMs: number;
}

export interface SessionAttachmentRequest {
  projectId: string;
  sessionId: string;
  nowMs: number;
  policy: AuthPolicy;
  requiredCapabilities?: readonly string[];
}

export interface SessionAttachmentVerificationOptions {
  projectId: string;
  sessionId: string;
  nowMs: number;
  policy: AuthPolicy;
  requiredCapabilities?: readonly string[];
}

export interface VerifiedSessionAttachment {
  projectId: string;
  sessionId: string;
  accountId: string;
  profileId: string;
  providerId: ProviderId;
  selectionGeneration: number;
  authEpoch: number;
  capabilityEpoch: number;
}

const EXPIRING_SOON_WINDOW_MS = 3 * 86_400_000;
const MAX_REQUIRED_CAPABILITIES = 64;
const MAX_TEXT_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const compareIdentifier = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1);

function redactDiagnosticPath(inputPath: string | undefined): string | undefined {
  if (inputPath === undefined) return undefined;
  if (inputPath.startsWith("$")) return "$";
  return /^[A-Za-z][A-Za-z-]*/.exec(inputPath)?.[0] ?? "runtime";
}

class InvalidRuntimeInput extends Error {
  readonly inputPath: string;

  constructor(inputPath: string) {
    const redactedPath = redactDiagnosticPath(inputPath) ?? "runtime";
    super(`Invalid provider auth input at ${redactedPath}`);
    this.inputPath = redactedPath;
    this.name = "InvalidRuntimeInput";
  }
}

const success = <T>(value: T): DomainResult<T> => ({ ok: true, value });

const failure = (code: DomainErrorCode, path?: string): DomainResult<never> => ({
  ok: false,
  error: { code, path: redactDiagnosticPath(path) },
});

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function createCapabilityRecord(): Record<string, CapabilityObservation> {
  return Object.create(null) as Record<string, CapabilityObservation>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeText(value: unknown, maxLength = MAX_TEXT_LENGTH, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && IDENTIFIER_PATTERN.test(value);
}

function isAuthReasonCode(value: unknown): value is AuthReasonCode {
  return Object.values(AUTH_REASON).includes(value as AuthReasonCode);
}

function isCapabilityReasonCode(value: unknown): value is CapabilityReasonCode {
  return Object.values(CAPABILITY_REASON).includes(value as CapabilityReasonCode);
}

function nextAuthEpoch(account: ProviderAccount): number | null {
  return account.auth.authEpoch === Number.MAX_SAFE_INTEGER ? null : account.auth.authEpoch + 1;
}

function cloneObservationSource(source: ObservationSource): ObservationSource {
  return {
    providerId: source.providerId,
    profileId: source.profileId,
    accountId: source.accountId,
    generation: source.generation,
    sequence: source.sequence,
  };
}

function cloneProfile(profile: ProviderProfile): ProviderProfile {
  return {
    profileId: profile.profileId,
    providerId: profile.providerId,
    label: profile.label,
    authMode: profile.authMode,
  };
}

function cloneAuth(auth: AuthSnapshot): AuthSnapshot {
  return {
    status: auth.status,
    authEpoch: auth.authEpoch,
    expiresAtMs: auth.expiresAtMs,
    rateLimitExpiresAtMs: auth.rateLimitExpiresAtMs,
    updatedAtMs: auth.updatedAtMs,
    reason: auth.reason,
    refresh: auth.refresh
      ? {
          accountId: auth.refresh.accountId,
          attemptId: auth.refresh.attemptId,
          baseAuthEpoch: auth.refresh.baseAuthEpoch,
          startedAtMs: auth.refresh.startedAtMs,
        }
      : null,
    source: auth.source ? cloneObservationSource(auth.source) : null,
    live: auth.live,
  };
}

function cloneAccount(account: ProviderAccount): ProviderAccount {
  const capabilities = createCapabilityRecord();
  for (const [capabilityId, observation] of Object.entries(account.capabilities)) {
    capabilities[capabilityId] = {
      readiness: observation.readiness,
      observedAtMs: observation.observedAtMs,
      reason: observation.reason,
      source: cloneObservationSource(observation.source),
      live: observation.live,
    };
  }
  return {
    accountId: account.accountId,
    profileId: account.profileId,
    providerId: account.providerId,
    label: account.label,
    auth: cloneAuth(account.auth),
    capabilities,
    capabilityEpoch: account.capabilityEpoch,
  };
}

function cloneSelection(selection: SelectedAccountBinding): SelectedAccountBinding {
  return {
    projectId: selection.projectId,
    sessionId: selection.sessionId,
    accountId: selection.accountId,
    profileId: selection.profileId,
    providerId: selection.providerId,
    selectionGeneration: selection.selectionGeneration,
    selectedAtMs: selection.selectedAtMs,
  };
}

function cloneDomain(domain: ProviderAuthDomain): ProviderAuthDomain {
  return {
    schemaVersion: 1,
    profiles: domain.profiles.map(cloneProfile),
    accounts: domain.accounts.map(cloneAccount),
    selectedAccounts: domain.selectedAccounts.map(cloneSelection),
  };
}

function accountById(domain: ProviderAuthDomain, accountId: string): ProviderAccount | undefined {
  return domain.accounts.find((account) => account.accountId === accountId);
}

function profileById(domain: ProviderAuthDomain, profileId: string): ProviderProfile | undefined {
  return domain.profiles.find((profile) => profile.profileId === profileId);
}

function observationSourceForAccount(
  account: Pick<ProviderAccount, "accountId" | "profileId" | "providerId">,
  input: unknown,
  previous: ObservationSource | null,
  inputPath: string,
): DomainResult<ObservationSource> {
  if (!isPlainRecord(input)) return failure("invalid-transition", inputPath);
  if (
    !isSafeIdentifier(input.providerId) ||
    !isSafeIdentifier(input.profileId) ||
    !isSafeIdentifier(input.accountId) ||
    !isSafeEpoch(input.generation) ||
    !isSafeEpoch(input.sequence)
  ) {
    return failure("invalid-transition", inputPath);
  }
  const source: ObservationSource = {
    providerId: input.providerId,
    profileId: input.profileId,
    accountId: input.accountId,
    generation: input.generation,
    sequence: input.sequence,
  };
  if (
    source.providerId !== account.providerId ||
    source.profileId !== account.profileId ||
    source.accountId !== account.accountId
  ) {
    return failure("observation-source-mismatch", inputPath);
  }
  if (
    previous &&
    (source.generation < previous.generation ||
      (source.generation === previous.generation && source.sequence <= previous.sequence))
  ) {
    return failure("stale-observation", inputPath);
  }
  return success(source);
}

function newestCapabilitySource(account: ProviderAccount): ObservationSource | null {
  let newest: ObservationSource | null = null;
  for (const observation of Object.values(account.capabilities)) {
    if (
      newest === null ||
      observation.source.generation > newest.generation ||
      (observation.source.generation === newest.generation && observation.source.sequence > newest.sequence)
    ) {
      newest = observation.source;
    }
  }
  return newest;
}

function latestCapabilityTime(account: ProviderAccount): number {
  let latest = 0;
  for (const observation of Object.values(account.capabilities)) {
    latest = Math.max(latest, observation.observedAtMs);
  }
  return latest;
}

function authObservationSource(
  account: ProviderAccount,
  input: unknown,
  observedAtMs: number,
  inputPath: string,
): DomainResult<ObservationSource> {
  const source = observationSourceForAccount(account, input, account.auth.source, `${inputPath}.source`);
  if (!source.ok) return source;
  if (observedAtMs < account.auth.updatedAtMs) {
    return failure("non-monotonic-observation-time", `${inputPath}.nowMs`);
  }
  return source;
}

function selectionBySession(
  domain: ProviderAuthDomain,
  projectId: string,
  sessionId: string,
): SelectedAccountBinding | undefined {
  return domain.selectedAccounts.find(
    (selection) => selection.projectId === projectId && selection.sessionId === sessionId,
  );
}

function replaceAccount(domain: ProviderAuthDomain, account: ProviderAccount): DomainResult<ProviderAuthDomain> {
  const index = domain.accounts.findIndex((entry) => entry.accountId === account.accountId);
  if (index < 0) return failure("account-not-found", "accounts.accountId");
  const accounts = domain.accounts.map(cloneAccount);
  accounts[index] = cloneAccount(account);
  return success({
    schemaVersion: 1,
    profiles: domain.profiles.map(cloneProfile),
    accounts,
    selectedAccounts: domain.selectedAccounts.map(cloneSelection),
  });
}

function replaceSelection(
  domain: ProviderAuthDomain,
  selection: SelectedAccountBinding,
): DomainResult<ProviderAuthDomain> {
  const existing = domain.selectedAccounts.findIndex(
    (entry) => entry.projectId === selection.projectId && entry.sessionId === selection.sessionId,
  );
  const selectedAccounts = domain.selectedAccounts.map(cloneSelection);
  if (existing < 0) selectedAccounts.push(cloneSelection(selection));
  else selectedAccounts[existing] = cloneSelection(selection);
  return success({
    schemaVersion: 1,
    profiles: domain.profiles.map(cloneProfile),
    accounts: domain.accounts.map(cloneAccount),
    selectedAccounts,
  });
}

function validateCapabilityInput(
  capabilityId: string,
  input: CapabilityInput,
  source: ObservationSource,
): CapabilityObservation {
  if (!isSafeIdentifier(capabilityId)) throw new TypeError("Invalid capability id");
  if (!Object.values(CAPABILITY_READINESS).includes(input.readiness)) {
    throw new TypeError("Invalid capability readiness");
  }
  if (!isSafeMillis(input.observedAtMs)) throw new TypeError("Invalid capability observation time");
  if (input.reason !== undefined && input.reason !== null && !isCapabilityReasonCode(input.reason)) {
    throw new TypeError("Invalid capability observation reason");
  }
  return {
    readiness: input.readiness,
    observedAtMs: input.observedAtMs,
    reason: input.reason ?? null,
    source: cloneObservationSource(source),
    live: true,
  };
}

export function createProviderAccount(input: ProviderAccountInput): ProviderAccount {
  if (!isSafeIdentifier(input.accountId) || !isSafeIdentifier(input.profileId) || !isSafeIdentifier(input.providerId)) {
    throw new TypeError("Invalid provider account identifier");
  }
  if (!isSafeText(input.label)) throw new TypeError("Invalid provider account label");
  const nowMs = input.nowMs ?? 0;
  if (!isSafeMillis(nowMs)) throw new TypeError("Invalid provider account time");

  const capabilities = createCapabilityRecord();
  for (const [capabilityId, observation] of Object.entries(input.capabilities ?? {})) {
    const source = observationSourceForAccount(input, observation.source, null, `capabilities.${capabilityId}.source`);
    if (!source.ok) throw new TypeError("Invalid provider capability source");
    capabilities[capabilityId] = validateCapabilityInput(capabilityId, observation, source.value);
  }

  return {
    accountId: input.accountId,
    profileId: input.profileId,
    providerId: input.providerId,
    label: input.label,
    auth: {
      status: AUTH_STATUS.SIGNED_OUT,
      authEpoch: 0,
      expiresAtMs: null,
      rateLimitExpiresAtMs: null,
      updatedAtMs: nowMs,
      reason: null,
      refresh: null,
      source: null,
      live: false,
    },
    capabilities,
    capabilityEpoch: 0,
  };
}

export function createProviderAuthDomain(input: {
  profiles: readonly ProviderProfile[];
  accounts: readonly ProviderAccount[];
  selectedAccounts?: readonly SelectedAccountBinding[];
}): ProviderAuthDomain {
  const domain: ProviderAuthDomain = {
    schemaVersion: 1,
    profiles: input.profiles.map(cloneProfile),
    accounts: input.accounts.map(cloneAccount),
    selectedAccounts: (input.selectedAccounts ?? []).map(cloneSelection),
  };
  try {
    assertValidDomain(domain);
  } catch (error) {
    if (error instanceof InvalidRuntimeInput) throw new TypeError(error.message);
    throw error;
  }
  return domain;
}

export function authHealthAt(account: ProviderAccount, nowMs: number): AuthHealth {
  if (!isSafeMillis(nowMs)) return AUTH_HEALTH.UNAVAILABLE;
  switch (account.auth.status) {
    case AUTH_STATUS.READY: {
      if (!account.auth.live) return AUTH_HEALTH.RECONCILIATION_REQUIRED;
      if (account.auth.expiresAtMs !== null && nowMs >= account.auth.expiresAtMs) return AUTH_HEALTH.EXPIRED;
      if (
        account.auth.expiresAtMs !== null &&
        account.auth.expiresAtMs - nowMs <= EXPIRING_SOON_WINDOW_MS
      ) {
        return AUTH_HEALTH.EXPIRING_SOON;
      }
      return AUTH_HEALTH.READY;
    }
    case AUTH_STATUS.REFRESHING:
      return AUTH_HEALTH.REFRESHING;
    case AUTH_STATUS.EXPIRED:
      return AUTH_HEALTH.EXPIRED;
    case AUTH_STATUS.REAUTH_REQUIRED:
      return AUTH_HEALTH.REAUTH_REQUIRED;
    case AUTH_STATUS.REVOKED:
      return AUTH_HEALTH.REVOKED;
    case AUTH_STATUS.UNAVAILABLE:
      return AUTH_HEALTH.UNAVAILABLE;
    case AUTH_STATUS.RATE_LIMITED:
      return AUTH_HEALTH.RATE_LIMITED;
    case AUTH_STATUS.SIGNED_OUT:
      return AUTH_HEALTH.SIGNED_OUT;
    case AUTH_STATUS.NOT_INSTALLED:
      return AUTH_HEALTH.NOT_INSTALLED;
  }
}

function authTransition(
  domain: ProviderAuthDomain,
  accountId: string,
  nowMs: number,
  auth: AuthSnapshot,
): DomainResult<ProviderAuthDomain> {
  if (!isSafeMillis(nowMs)) return failure("invalid-transition", "nowMs");
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (nowMs < account.auth.updatedAtMs) {
    return failure("non-monotonic-observation-time", "auth.updatedAtMs");
  }
  return replaceAccount(domain, { ...account, auth: cloneAuth(auth) });
}

export function authenticateAccount(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; expiresAtMs: number | null; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  if (!isSafeMillis(input.nowMs) || (input.expiresAtMs !== null && !isSafeMillis(input.expiresAtMs))) {
    return failure("invalid-transition", "authentication");
  }
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (account.auth.status === AUTH_STATUS.RATE_LIMITED) {
    if (account.auth.rateLimitExpiresAtMs !== null && input.nowMs < account.auth.rateLimitExpiresAtMs) {
      return failure("rate-limit-not-expired", "rateLimit");
    }
    return failure("invalid-transition", "rateLimit.clearRequired");
  }
  const source = authObservationSource(account, input.source, input.nowMs, "authentication");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  const immediatelyExpired = input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs;
  return authTransition(domain, accountId, input.nowMs, {
    status: immediatelyExpired ? AUTH_STATUS.EXPIRED : AUTH_STATUS.READY,
    authEpoch: epoch,
    expiresAtMs: input.expiresAtMs,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: immediatelyExpired ? AUTH_REASON.EXPIRED_AT_AUTHENTICATION : null,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function signOutAccount(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; reason?: AuthReasonCode; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || (input.reason !== undefined && !isAuthReasonCode(input.reason))) {
    return failure("invalid-transition", "signOut");
  }
  const source = authObservationSource(account, input.source, input.nowMs, "signOut");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.SIGNED_OUT,
    authEpoch: epoch,
    expiresAtMs: null,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: input.reason ?? AUTH_REASON.USER_SIGNED_OUT,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function revokeAccount(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; reason: AuthReasonCode; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || !isAuthReasonCode(input.reason)) return failure("invalid-transition", "revoke");
  const source = authObservationSource(account, input.source, input.nowMs, "revoke");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.REVOKED,
    authEpoch: epoch,
    expiresAtMs: null,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: input.reason,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function markAccountUnavailable(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; reason: AuthReasonCode; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || !isAuthReasonCode(input.reason)) return failure("invalid-transition", "unavailable");
  const source = authObservationSource(account, input.source, input.nowMs, "unavailable");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.UNAVAILABLE,
    authEpoch: epoch,
    expiresAtMs: null,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: input.reason,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function markAccountNotInstalled(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; reason?: AuthReasonCode; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || (input.reason !== undefined && !isAuthReasonCode(input.reason))) {
    return failure("invalid-transition", "notInstalled");
  }
  const source = authObservationSource(account, input.source, input.nowMs, "notInstalled");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.NOT_INSTALLED,
    authEpoch: epoch,
    expiresAtMs: null,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: input.reason ?? AUTH_REASON.PROVIDER_NOT_INSTALLED,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function markAccountRateLimited(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; rateLimitExpiresAtMs: number; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", "accounts.accountId");
  if (
    !isSafeMillis(input.nowMs) ||
    !isSafeMillis(input.rateLimitExpiresAtMs) ||
    input.rateLimitExpiresAtMs <= input.nowMs
  ) {
    return failure("invalid-transition", "rateLimit");
  }
  const health = authHealthAt(account, input.nowMs);
  if (health !== AUTH_HEALTH.READY && health !== AUTH_HEALTH.EXPIRING_SOON) {
    return failure("invalid-transition", "rateLimit.status");
  }
  const source = authObservationSource(account, input.source, input.nowMs, "rateLimit");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.RATE_LIMITED,
    authEpoch: epoch,
    expiresAtMs: account.auth.expiresAtMs,
    rateLimitExpiresAtMs: input.rateLimitExpiresAtMs,
    updatedAtMs: input.nowMs,
    reason: AUTH_REASON.PROVIDER_RATE_LIMITED,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function clearAccountRateLimit(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { nowMs: number; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", "accounts.accountId");
  if (!isSafeMillis(input.nowMs)) return failure("invalid-transition", "rateLimit.clear");
  if (account.auth.status !== AUTH_STATUS.RATE_LIMITED || account.auth.rateLimitExpiresAtMs === null) {
    return failure("rate-limit-not-active", "rateLimit");
  }
  if (input.nowMs < account.auth.rateLimitExpiresAtMs) {
    return failure("rate-limit-not-expired", "rateLimit");
  }
  const source = authObservationSource(account, input.source, input.nowMs, "rateLimit.clear");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  const expired = account.auth.expiresAtMs !== null && input.nowMs >= account.auth.expiresAtMs;
  return authTransition(domain, accountId, input.nowMs, {
    status: expired ? AUTH_STATUS.EXPIRED : AUTH_STATUS.READY,
    authEpoch: epoch,
    expiresAtMs: account.auth.expiresAtMs,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: expired ? AUTH_REASON.EXPIRED : null,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function expireAccountAt(
  domain: ProviderAuthDomain,
  accountId: string,
  nowMs: number,
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(nowMs)) return failure("invalid-transition", "nowMs");
  if (
    account.auth.expiresAtMs === null ||
    nowMs < account.auth.expiresAtMs ||
    account.auth.status !== AUTH_STATUS.READY &&
    account.auth.status !== AUTH_STATUS.REFRESHING &&
    account.auth.status !== AUTH_STATUS.RATE_LIMITED
  ) {
    return success(cloneDomain(domain));
  }
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, nowMs, {
    status: AUTH_STATUS.EXPIRED,
    authEpoch: epoch,
    expiresAtMs: account.auth.expiresAtMs,
    rateLimitExpiresAtMs: null,
    updatedAtMs: nowMs,
    reason: AUTH_REASON.EXPIRED,
    refresh: null,
    source: account.auth.source ? cloneObservationSource(account.auth.source) : null,
    live: account.auth.live,
  });
}

export function beginRefresh(
  domain: ProviderAuthDomain,
  accountId: string,
  input: { attemptId: string; nowMs: number },
): DomainResult<RefreshStart> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeIdentifier(input.attemptId) || !isSafeMillis(input.nowMs)) {
    return failure("invalid-transition", "refresh.start");
  }
  if (account.auth.status === AUTH_STATUS.REFRESHING) return failure("refresh-in-progress", "auth.refresh");
  const health = authHealthAt(account, input.nowMs);
  if (health !== AUTH_HEALTH.READY && health !== AUTH_HEALTH.EXPIRING_SOON) {
    return failure("refresh-not-allowed", "auth.status");
  }
  const attempt: RefreshAttempt = {
    accountId,
    attemptId: input.attemptId,
    baseAuthEpoch: account.auth.authEpoch,
    startedAtMs: input.nowMs,
  };
  const refreshing: AuthSnapshot = {
    ...cloneAuth(account.auth),
    status: AUTH_STATUS.REFRESHING,
    updatedAtMs: input.nowMs,
    reason: null,
    refresh: attempt,
  };
  const updated = authTransition(domain, accountId, input.nowMs, refreshing);
  return updated.ok ? success({ domain: updated.value, attempt }) : updated;
}

function refreshAttemptMatches(auth: AuthSnapshot, attempt: RefreshAttempt): boolean {
  return (
    auth.status === AUTH_STATUS.REFRESHING &&
    auth.refresh !== null &&
    auth.refresh.accountId === attempt.accountId &&
    auth.refresh.attemptId === attempt.attemptId &&
    auth.refresh.baseAuthEpoch === attempt.baseAuthEpoch &&
    auth.refresh.startedAtMs === attempt.startedAtMs &&
    auth.authEpoch === attempt.baseAuthEpoch
  );
}

export function completeRefresh(
  domain: ProviderAuthDomain,
  accountId: string,
  attempt: RefreshAttempt,
  input: { nowMs: number; expiresAtMs: number | null; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || (input.expiresAtMs !== null && !isSafeMillis(input.expiresAtMs))) {
    return failure("invalid-transition", "refresh.complete");
  }
  if (!refreshAttemptMatches(account.auth, attempt)) return failure("stale-refresh", "auth.refresh");
  const source = authObservationSource(account, input.source, input.nowMs, "refresh.complete");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  const immediatelyExpired = input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs;
  return authTransition(domain, accountId, input.nowMs, {
    status: immediatelyExpired ? AUTH_STATUS.EXPIRED : AUTH_STATUS.READY,
    authEpoch: epoch,
    expiresAtMs: input.expiresAtMs,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: immediatelyExpired ? AUTH_REASON.EXPIRED_AT_REFRESH : null,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function failRefresh(
  domain: ProviderAuthDomain,
  accountId: string,
  attempt: RefreshAttempt,
  input: { nowMs: number; reason: AuthReasonCode; source: ObservationSource },
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  if (!isSafeMillis(input.nowMs) || !isAuthReasonCode(input.reason)) {
    return failure("invalid-transition", "refresh.fail");
  }
  if (!refreshAttemptMatches(account.auth, attempt)) return failure("stale-refresh", "auth.refresh");
  const source = authObservationSource(account, input.source, input.nowMs, "refresh.fail");
  if (!source.ok) return source;
  const epoch = nextAuthEpoch(account);
  if (epoch === null) return failure("invalid-transition", "auth.authEpoch");
  return authTransition(domain, accountId, input.nowMs, {
    status: AUTH_STATUS.REAUTH_REQUIRED,
    authEpoch: epoch,
    expiresAtMs: null,
    rateLimitExpiresAtMs: null,
    updatedAtMs: input.nowMs,
    reason: input.reason,
    refresh: null,
    source: source.value,
    live: true,
  });
}

export function observeCapability(
  domain: ProviderAuthDomain,
  accountId: string,
  capabilityId: string,
  observation: CapabilityInput,
): DomainResult<ProviderAuthDomain> {
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  const source = observationSourceForAccount(
    account,
    observation.source,
    newestCapabilitySource(account),
    `capabilities.${capabilityId}.source`,
  );
  if (!source.ok) return source;
  if (!isSafeMillis(observation.observedAtMs)) {
    return failure("invalid-transition", `capabilities.${capabilityId}.observedAtMs`);
  }
  if (observation.observedAtMs < latestCapabilityTime(account)) {
    return failure("non-monotonic-observation-time", `capabilities.${capabilityId}.observedAtMs`);
  }
  let normalized: CapabilityObservation;
  try {
    normalized = validateCapabilityInput(capabilityId, observation, source.value);
  } catch {
    return failure("invalid-transition", `capabilities.${capabilityId}`);
  }
  const previous = account.capabilities[capabilityId];
  if (
    previous &&
    previous.readiness === normalized.readiness &&
    previous.observedAtMs === normalized.observedAtMs &&
    previous.reason === normalized.reason &&
    previous.source.generation === normalized.source.generation &&
    previous.source.sequence === normalized.source.sequence &&
    previous.live === normalized.live
  ) {
    return success(cloneDomain(domain));
  }
  if (account.capabilityEpoch === Number.MAX_SAFE_INTEGER) return failure("invalid-transition", "capabilityEpoch");
  const capabilities = createCapabilityRecord();
  Object.assign(capabilities, account.capabilities);
  capabilities[capabilityId] = normalized;
  return replaceAccount(domain, {
    ...account,
    capabilities,
    capabilityEpoch: account.capabilityEpoch + 1,
  });
}

export function selectAccount(
  domain: ProviderAuthDomain,
  projectId: string,
  sessionId: string,
  accountId: string,
  selectedAtMs: number,
): DomainResult<ProviderAuthDomain> {
  if (!isSafeIdentifier(projectId) || !isSafeIdentifier(sessionId) || !isSafeMillis(selectedAtMs)) {
    return failure("invalid-transition", "selection");
  }
  const account = accountById(domain, accountId);
  if (!account) return failure("account-not-found", `accounts.${accountId}`);
  const profile = profileById(domain, account.profileId);
  if (!profile) return failure("profile-not-found", `profiles.${account.profileId}`);
  if (profile.providerId !== account.providerId) return failure("account-profile-mismatch", `accounts.${accountId}`);
  const previous = selectionBySession(domain, projectId, sessionId);
  if (previous && selectedAtMs < previous.selectedAtMs) return failure("invalid-transition", "selection.selectedAtMs");
  if (previous?.selectionGeneration === Number.MAX_SAFE_INTEGER) {
    return failure("invalid-transition", "selection.selectionGeneration");
  }
  return replaceSelection(domain, {
    projectId,
    sessionId,
    accountId: account.accountId,
    profileId: profile.profileId,
    providerId: profile.providerId,
    selectionGeneration: previous ? previous.selectionGeneration + 1 : 1,
    selectedAtMs,
  });
}

function baseEligibility(account: ProviderAccount, profile: ProviderProfile): ProviderEligibility {
  return {
    status: "unavailable",
    accountId: account.accountId,
    profileId: profile.profileId,
    providerId: profile.providerId,
    mode: profile.authMode,
    authEpoch: account.auth.authEpoch,
    capabilityEpoch: account.capabilityEpoch,
  };
}

function ineligible(
  account: ProviderAccount,
  profile: ProviderProfile,
  status: Exclude<EligibilityStatus, "eligible">,
  reason: DomainErrorCode,
  capabilityId?: string,
): ProviderEligibility {
  return { ...baseEligibility(account, profile), status, reason, capabilityId };
}

function adapterPolicyFor(policy: AuthPolicy, providerId: ProviderId): ProviderAdapterPolicy | undefined {
  if (!isPlainRecord(policy.adapters) || !hasOwn(policy.adapters, providerId)) return undefined;
  return policy.adapters[providerId];
}

function isClosedDenseCapabilityArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_REQUIRED_CAPABILITIES
  ) {
    return false;
  }
  const length = lengthDescriptor.value as number;
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== length + 1
  ) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false;
  }
  return true;
}

function decodeRequiredCapabilities(
  account: ProviderAccount,
  input: unknown,
): DomainResult<readonly string[]> {
  if (input === undefined) return success([]);
  try {
    if (!isClosedDenseCapabilityArray(input)) {
      return failure("invalid-required-capabilities", "requiredCapabilities");
    }
  } catch {
    return failure("invalid-required-capabilities", "requiredCapabilities");
  }

  let detached: unknown;
  try {
    detached = structuredClone(input);
  } catch {
    return failure("invalid-required-capabilities", "requiredCapabilities");
  }

  try {
    if (!isClosedDenseCapabilityArray(detached)) {
      return failure("invalid-required-capabilities", "requiredCapabilities");
    }
    const decoded: string[] = [];
    for (let index = 0; index < detached.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(detached, String(index));
      if (!descriptor || !("value" in descriptor)) {
        return failure("invalid-required-capabilities", "requiredCapabilities");
      }
      const capabilityId = descriptor.value;
      if (
        !isSafeIdentifier(capabilityId) ||
        !hasOwn(account.capabilities, capabilityId)
      ) {
        return failure("invalid-required-capabilities", "requiredCapabilities");
      }
      decoded.push(capabilityId);
    }
    return success(decoded);
  } catch {
    return failure("invalid-required-capabilities", "requiredCapabilities");
  }
}

function requiredCapabilitiesReady(
  account: ProviderAccount,
  requiredCapabilities: readonly string[],
): { capabilityId: string; reason: "capability-not-ready" | "live-reconciliation-required" } | null {
  for (const capabilityId of requiredCapabilities) {
    const observation = hasOwn(account.capabilities, capabilityId)
      ? account.capabilities[capabilityId]
      : undefined;
    if (observation?.readiness !== CAPABILITY_READINESS.READY) {
      return { capabilityId, reason: "capability-not-ready" };
    }
    if (!observation.live) return { capabilityId, reason: "live-reconciliation-required" };
  }
  return null;
}

export function evaluateProviderEligibility(
  domain: ProviderAuthDomain,
  request: EligibilityRequest,
): DomainResult<ProviderEligibility> {
  if (!isSafeMillis(request.nowMs)) return failure("invalid-transition", "eligibility.nowMs");
  const decodedPolicy = decodeProviderPolicy(request.policy);
  if (!decodedPolicy.ok) return decodedPolicy;
  const safePolicy = decodedPolicy.value;
  const account = accountById(domain, request.accountId);
  if (!account) return failure("account-not-found", `accounts.${request.accountId}`);
  const requiredCapabilities = decodeRequiredCapabilities(account, request.requiredCapabilities);
  if (!requiredCapabilities.ok) return requiredCapabilities;
  const profile = profileById(domain, account.profileId);
  if (!profile) return failure("profile-not-found", `profiles.${account.profileId}`);
  if (profile.providerId !== account.providerId) return failure("account-profile-mismatch", `accounts.${account.accountId}`);

  if (profile.authMode === AUTH_MODE.UNAVAILABLE) return success(ineligible(account, profile, "unavailable", "profile-unavailable"));
  if (profile.authMode === AUTH_MODE.UNSUPPORTED) return success(ineligible(account, profile, "unsupported", "profile-unsupported"));

  const adapter = adapterPolicyFor(safePolicy, profile.providerId);
  if (!adapter) return success(ineligible(account, profile, "unavailable", "provider-policy-missing"));
  if (profile.authMode === AUTH_MODE.SUBSCRIPTION_MANAGED) {
    if (adapter.subscriptionManaged !== ADAPTER_SUPPORT.SUPPORTED) {
      return success(ineligible(account, profile, "unsupported", "subscription-adapter-unsupported"));
    }
    if (safePolicy.release === "public" && adapter.publicSubscription !== PUBLIC_SUBSCRIPTION.AUTHORIZED) {
      return success(ineligible(account, profile, "unsupported", "public-subscription-not-authorized"));
    }
  } else if (adapter.apiKey !== ADAPTER_SUPPORT.SUPPORTED) {
    return success(ineligible(account, profile, "unsupported", "api-key-adapter-unsupported"));
  }

  const health = authHealthAt(account, request.nowMs);
  switch (health) {
    case AUTH_HEALTH.SIGNED_OUT:
      return success(ineligible(account, profile, "reauth-required", "signed-out"));
    case AUTH_HEALTH.EXPIRED:
      return success(ineligible(account, profile, "reauth-required", "expired"));
    case AUTH_HEALTH.REVOKED:
      return success(ineligible(account, profile, "reauth-required", "revoked"));
    case AUTH_HEALTH.REAUTH_REQUIRED:
      return success(ineligible(account, profile, "reauth-required", "reauth-required"));
    case AUTH_HEALTH.REFRESHING:
      return success(ineligible(account, profile, "reauth-required", "refreshing"));
    case AUTH_HEALTH.UNAVAILABLE:
      return success(ineligible(account, profile, "unavailable", "auth-unavailable"));
    case AUTH_HEALTH.NOT_INSTALLED:
      return success(ineligible(account, profile, "unavailable", "auth-not-installed"));
    case AUTH_HEALTH.RATE_LIMITED:
      return success(ineligible(account, profile, "unavailable", "rate-limited"));
    case AUTH_HEALTH.RECONCILIATION_REQUIRED:
      return success(ineligible(account, profile, "unavailable", "live-reconciliation-required"));
    case AUTH_HEALTH.READY:
    case AUTH_HEALTH.EXPIRING_SOON:
      break;
  }

  const missingCapability = requiredCapabilitiesReady(account, requiredCapabilities.value);
  if (missingCapability !== null) {
    return success(
      ineligible(account, profile, "unavailable", missingCapability.reason, missingCapability.capabilityId),
    );
  }
  return success({
    ...baseEligibility(account, profile),
    status: "eligible",
  });
}

function attachmentFailureForEligibility(eligibility: ProviderEligibility): DomainResult<never> {
  if (eligibility.reason === "stale-auth-epoch") return failure("stale-auth-epoch");
  if (eligibility.reason === "stale-capability-epoch") return failure("stale-capability-epoch");
  if (eligibility.reason === "capability-not-ready") return failure("capability-not-ready");
  if (eligibility.status === "reauth-required") return failure("reauth-required");
  return failure("not-eligible");
}

export function issueSessionAttachmentProof(
  domain: ProviderAuthDomain,
  request: SessionAttachmentRequest,
): DomainResult<SessionAttachmentProof> {
  if (!isSafeIdentifier(request.projectId) || !isSafeIdentifier(request.sessionId) || !isSafeMillis(request.nowMs)) {
    return failure("invalid-transition", "attachment.request");
  }
  const selection = selectionBySession(domain, request.projectId, request.sessionId);
  if (!selection) return failure("session-not-selected", `selectedAccounts.${request.projectId}.${request.sessionId}`);
  const eligibility = evaluateProviderEligibility(domain, {
    accountId: selection.accountId,
    nowMs: request.nowMs,
    policy: request.policy,
    requiredCapabilities: request.requiredCapabilities,
  });
  if (!eligibility.ok) return eligibility;
  if (eligibility.value.status !== "eligible") return attachmentFailureForEligibility(eligibility.value);
  return success({
    version: 1,
    projectId: selection.projectId,
    sessionId: selection.sessionId,
    accountId: selection.accountId,
    profileId: selection.profileId,
    providerId: selection.providerId,
    selectionGeneration: selection.selectionGeneration,
    authEpoch: eligibility.value.authEpoch,
    capabilityEpoch: eligibility.value.capabilityEpoch,
    issuedAtMs: request.nowMs,
  });
}

export function verifySessionAttachment(
  domain: ProviderAuthDomain,
  proof: SessionAttachmentProof,
  options: SessionAttachmentVerificationOptions,
): DomainResult<VerifiedSessionAttachment> {
  const decodedProof = decodeSessionAttachmentProof(proof);
  if (!decodedProof.ok) return decodedProof;
  const cleanProof = decodedProof.value;
  if (!isSafeIdentifier(options.projectId) || !isSafeIdentifier(options.sessionId) || !isSafeMillis(options.nowMs)) {
    return failure("invalid-transition", "attachment.binding");
  }
  if (options.projectId !== cleanProof.projectId || options.sessionId !== cleanProof.sessionId) {
    return failure("session-mismatch", "attachment.sessionId");
  }
  const selection = selectionBySession(domain, cleanProof.projectId, cleanProof.sessionId);
  if (!selection) {
    return failure("session-not-selected", `selectedAccounts.${cleanProof.projectId}.${cleanProof.sessionId}`);
  }
  if (
    selection.accountId !== cleanProof.accountId ||
    selection.profileId !== cleanProof.profileId ||
    selection.providerId !== cleanProof.providerId
  ) {
    return failure("session-account-mismatch", "attachment.binding");
  }
  if (selection.selectionGeneration !== cleanProof.selectionGeneration) {
    return failure("stale-selection-generation", "attachment.selectionGeneration");
  }
  const account = accountById(domain, cleanProof.accountId);
  if (!account) return failure("account-not-found", `accounts.${cleanProof.accountId}`);
  const profile = profileById(domain, cleanProof.profileId);
  if (!profile) return failure("profile-not-found", `profiles.${cleanProof.profileId}`);
  if (cleanProof.authEpoch !== account.auth.authEpoch) return failure("stale-auth-epoch", "attachment.authEpoch");
  if (cleanProof.capabilityEpoch !== account.capabilityEpoch) {
    return failure("stale-capability-epoch", "attachment.capabilityEpoch");
  }
  if (cleanProof.issuedAtMs > options.nowMs) return failure("invalid-runtime-input", "attachment.issuedAtMs");

  const eligibility = evaluateProviderEligibility(domain, {
    accountId: account.accountId,
    nowMs: options.nowMs,
    policy: options.policy,
    requiredCapabilities: options.requiredCapabilities,
  });
  if (!eligibility.ok) return eligibility;
  if (eligibility.value.status !== "eligible") return attachmentFailureForEligibility(eligibility.value);
  return success({
    projectId: cleanProof.projectId,
    sessionId: cleanProof.sessionId,
    accountId: cleanProof.accountId,
    profileId: cleanProof.profileId,
    providerId: cleanProof.providerId,
    selectionGeneration: cleanProof.selectionGeneration,
    authEpoch: cleanProof.authEpoch,
    capabilityEpoch: cleanProof.capabilityEpoch,
  });
}

function expectPlain(value: unknown, inputPath: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new InvalidRuntimeInput(inputPath);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectExactKeys(value: Record<string, unknown>, keys: readonly string[], inputPath: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !hasOwn(value, key))) {
    const unexpected = actual.find((key) => !keys.includes(key));
    throw new InvalidRuntimeInput(unexpected ? `${inputPath}.${unexpected}` : inputPath);
  }
}

function expectString(value: unknown, inputPath: string, maxLength = MAX_TEXT_LENGTH): string {
  if (!isSafeText(value, maxLength)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectIdentifier(value: unknown, inputPath: string): string {
  if (!isSafeIdentifier(value)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectMillis(value: unknown, inputPath: string): number {
  if (!isSafeMillis(value)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectEpoch(value: unknown, inputPath: string): number {
  if (!isSafeEpoch(value)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectNullableMillis(value: unknown, inputPath: string): number | null {
  if (value === null) return null;
  return expectMillis(value, inputPath);
}

function expectNullableAuthReason(value: unknown, inputPath: string): AuthReasonCode | null {
  if (value === null) return null;
  if (!isAuthReasonCode(value)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectNullableCapabilityReason(value: unknown, inputPath: string): CapabilityReasonCode | null {
  if (value === null) return null;
  if (!isCapabilityReasonCode(value)) throw new InvalidRuntimeInput(inputPath);
  return value;
}

function expectArray(value: unknown, inputPath: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidRuntimeInput(inputPath);
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index))) throw new InvalidRuntimeInput(`${inputPath}[${index}]`);
  }
  return value;
}

function decodeProfileOrThrow(value: unknown, inputPath: string): ProviderProfile {
  const record = expectPlain(value, inputPath);
  expectExactKeys(record, ["profileId", "providerId", "label", "authMode"], inputPath);
  const authMode = record.authMode;
  if (!Object.values(AUTH_MODE).includes(authMode as AuthMode)) throw new InvalidRuntimeInput(`${inputPath}.authMode`);
  return {
    profileId: expectIdentifier(record.profileId, `${inputPath}.profileId`),
    providerId: expectIdentifier(record.providerId, `${inputPath}.providerId`),
    label: expectString(record.label, `${inputPath}.label`),
    authMode: authMode as AuthMode,
  };
}

function decodeRefreshOrThrow(value: unknown, inputPath: string): RefreshAttempt {
  const record = expectPlain(value, inputPath);
  expectExactKeys(record, ["accountId", "attemptId", "baseAuthEpoch", "startedAtMs"], inputPath);
  return {
    accountId: expectIdentifier(record.accountId, `${inputPath}.accountId`),
    attemptId: expectIdentifier(record.attemptId, `${inputPath}.attemptId`),
    baseAuthEpoch: expectEpoch(record.baseAuthEpoch, `${inputPath}.baseAuthEpoch`),
    startedAtMs: expectMillis(record.startedAtMs, `${inputPath}.startedAtMs`),
  };
}

function decodeObservationSourceOrThrow(value: unknown, inputPath: string): ObservationSource {
  const record = expectPlain(value, inputPath);
  expectExactKeys(record, ["providerId", "profileId", "accountId", "generation", "sequence"], inputPath);
  return {
    providerId: expectIdentifier(record.providerId, `${inputPath}.providerId`),
    profileId: expectIdentifier(record.profileId, `${inputPath}.profileId`),
    accountId: expectIdentifier(record.accountId, `${inputPath}.accountId`),
    generation: expectEpoch(record.generation, `${inputPath}.generation`),
    sequence: expectEpoch(record.sequence, `${inputPath}.sequence`),
  };
}

function decodeAuthOrThrow(value: unknown, inputPath: string): AuthSnapshot {
  const record = expectPlain(value, inputPath);
  expectExactKeys(
    record,
    [
      "status",
      "authEpoch",
      "expiresAtMs",
      "rateLimitExpiresAtMs",
      "updatedAtMs",
      "reason",
      "refresh",
      "source",
      "live",
    ],
    inputPath,
  );
  if (!Object.values(AUTH_STATUS).includes(record.status as AuthStatus)) {
    throw new InvalidRuntimeInput(`${inputPath}.status`);
  }
  const refresh = record.refresh === null ? null : decodeRefreshOrThrow(record.refresh, `${inputPath}.refresh`);
  const status = record.status as AuthStatus;
  if ((status === AUTH_STATUS.REFRESHING) !== (refresh !== null)) {
    throw new InvalidRuntimeInput(`${inputPath}.refresh`);
  }
  if (record.live !== false) throw new InvalidRuntimeInput(`${inputPath}.live`);
  return {
    status,
    authEpoch: expectEpoch(record.authEpoch, `${inputPath}.authEpoch`),
    expiresAtMs: expectNullableMillis(record.expiresAtMs, `${inputPath}.expiresAtMs`),
    rateLimitExpiresAtMs: expectNullableMillis(
      record.rateLimitExpiresAtMs,
      `${inputPath}.rateLimitExpiresAtMs`,
    ),
    updatedAtMs: expectMillis(record.updatedAtMs, `${inputPath}.updatedAtMs`),
    reason: expectNullableAuthReason(record.reason, `${inputPath}.reason`),
    refresh,
    source:
      record.source === null
        ? null
        : decodeObservationSourceOrThrow(record.source, `${inputPath}.source`),
    live: false,
  };
}

function decodeCapabilitiesOrThrow(
  value: unknown,
  inputPath: string,
): Record<string, CapabilityObservation> {
  const record = expectPlain(value, inputPath);
  const capabilities = createCapabilityRecord();
  for (const capabilityId of Object.keys(record)) {
    const observation = expectPlain(record[capabilityId], `${inputPath}.${capabilityId}`);
    expectExactKeys(
      observation,
      ["readiness", "observedAtMs", "reason", "source", "live"],
      `${inputPath}.${capabilityId}`,
    );
    if (!Object.values(CAPABILITY_READINESS).includes(observation.readiness as CapabilityReadiness)) {
      throw new InvalidRuntimeInput(`${inputPath}.${capabilityId}.readiness`);
    }
    if (observation.live !== false) throw new InvalidRuntimeInput(`${inputPath}.${capabilityId}.live`);
    capabilities[expectIdentifier(capabilityId, `${inputPath}.${capabilityId}`)] = {
      readiness: observation.readiness as CapabilityReadiness,
      observedAtMs: expectMillis(observation.observedAtMs, `${inputPath}.${capabilityId}.observedAtMs`),
      reason: expectNullableCapabilityReason(observation.reason, `${inputPath}.capabilities.reason`),
      source: decodeObservationSourceOrThrow(observation.source, `${inputPath}.${capabilityId}.source`),
      live: false,
    };
  }
  return capabilities;
}

function decodeAccountOrThrow(value: unknown, inputPath: string): ProviderAccount {
  const record = expectPlain(value, inputPath);
  expectExactKeys(record, ["accountId", "profileId", "providerId", "label", "auth", "capabilities", "capabilityEpoch"], inputPath);
  const account: ProviderAccount = {
    accountId: expectIdentifier(record.accountId, `${inputPath}.accountId`),
    profileId: expectIdentifier(record.profileId, `${inputPath}.profileId`),
    providerId: expectIdentifier(record.providerId, `${inputPath}.providerId`),
    label: expectString(record.label, `${inputPath}.label`),
    auth: decodeAuthOrThrow(record.auth, `${inputPath}.auth`),
    capabilities: decodeCapabilitiesOrThrow(record.capabilities, `${inputPath}.capabilities`),
    capabilityEpoch: expectEpoch(record.capabilityEpoch, `${inputPath}.capabilityEpoch`),
  };
  if (
    account.auth.refresh !== null &&
    (account.auth.refresh.accountId !== account.accountId ||
      account.auth.refresh.baseAuthEpoch !== account.auth.authEpoch)
  ) {
    throw new InvalidRuntimeInput(`${inputPath}.auth.refresh`);
  }
  if (
    (account.auth.source !== null &&
      (account.auth.source.accountId !== account.accountId ||
        account.auth.source.profileId !== account.profileId ||
        account.auth.source.providerId !== account.providerId)) ||
    (account.auth.source === null &&
      (account.auth.status !== AUTH_STATUS.SIGNED_OUT || account.auth.authEpoch !== 0))
  ) {
    throw new InvalidRuntimeInput(`${inputPath}.auth.source`);
  }
  if (
    (account.auth.status === AUTH_STATUS.RATE_LIMITED) !==
      (account.auth.rateLimitExpiresAtMs !== null) ||
    (account.auth.rateLimitExpiresAtMs !== null &&
      account.auth.rateLimitExpiresAtMs <= account.auth.updatedAtMs)
  ) {
    throw new InvalidRuntimeInput(`${inputPath}.auth.rateLimitExpiresAtMs`);
  }
  for (const observation of Object.values(account.capabilities)) {
    if (
      observation.source.accountId !== account.accountId ||
      observation.source.profileId !== account.profileId ||
      observation.source.providerId !== account.providerId
    ) {
      throw new InvalidRuntimeInput(`${inputPath}.capabilities.source`);
    }
  }
  return account;
}

function decodeSelectionOrThrow(value: unknown, inputPath: string): SelectedAccountBinding {
  const record = expectPlain(value, inputPath);
  expectExactKeys(
    record,
    ["projectId", "sessionId", "accountId", "profileId", "providerId", "selectionGeneration", "selectedAtMs"],
    inputPath,
  );
  return {
    projectId: expectIdentifier(record.projectId, `${inputPath}.projectId`),
    sessionId: expectIdentifier(record.sessionId, `${inputPath}.sessionId`),
    accountId: expectIdentifier(record.accountId, `${inputPath}.accountId`),
    profileId: expectIdentifier(record.profileId, `${inputPath}.profileId`),
    providerId: expectIdentifier(record.providerId, `${inputPath}.providerId`),
    selectionGeneration: expectEpoch(record.selectionGeneration, `${inputPath}.selectionGeneration`),
    selectedAtMs: expectMillis(record.selectedAtMs, `${inputPath}.selectedAtMs`),
  };
}

function assertValidDomain(domain: ProviderAuthDomain): void {
  if (domain.schemaVersion !== 1) throw new InvalidRuntimeInput("schemaVersion");
  const profiles = new Map<string, ProviderProfile>();
  for (const profile of domain.profiles) {
    if (
      !isSafeIdentifier(profile.profileId) ||
      !isSafeIdentifier(profile.providerId) ||
      !isSafeText(profile.label) ||
      !Object.values(AUTH_MODE).includes(profile.authMode)
    ) {
      throw new InvalidRuntimeInput("profiles");
    }
    if (profiles.has(profile.profileId)) throw new InvalidRuntimeInput(`profiles.${profile.profileId}`);
    profiles.set(profile.profileId, profile);
  }
  const accounts = new Map<string, ProviderAccount>();
  for (const account of domain.accounts) {
    if (
      !isSafeIdentifier(account.accountId) ||
      !isSafeIdentifier(account.profileId) ||
      !isSafeIdentifier(account.providerId) ||
      !isSafeText(account.label) ||
      !isSafeEpoch(account.auth.authEpoch) ||
      !isSafeMillis(account.auth.updatedAtMs) ||
      typeof account.auth.live !== "boolean" ||
      !isSafeEpoch(account.capabilityEpoch)
    ) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}`);
    }
    if (accounts.has(account.accountId)) throw new InvalidRuntimeInput(`accounts.${account.accountId}`);
    const profile = profiles.get(account.profileId);
    if (!profile) throw new InvalidRuntimeInput(`accounts.${account.accountId}.profileId`);
    if (profile.providerId !== account.providerId) throw new InvalidRuntimeInput(`accounts.${account.accountId}.providerId`);
    if (!Object.values(AUTH_STATUS).includes(account.auth.status)) throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.status`);
    if ((account.auth.status === AUTH_STATUS.REFRESHING) !== (account.auth.refresh !== null)) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.refresh`);
    }
    if (
      account.auth.refresh !== null &&
      (account.auth.refresh.accountId !== account.accountId ||
        account.auth.refresh.baseAuthEpoch !== account.auth.authEpoch ||
        !isSafeIdentifier(account.auth.refresh.attemptId) ||
        !isSafeMillis(account.auth.refresh.startedAtMs))
    ) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.refresh`);
    }
    if (account.auth.expiresAtMs !== null && !isSafeMillis(account.auth.expiresAtMs)) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.expiresAtMs`);
    }
    if (
      (account.auth.status === AUTH_STATUS.RATE_LIMITED) !==
        (account.auth.rateLimitExpiresAtMs !== null) ||
      (account.auth.rateLimitExpiresAtMs !== null &&
        (!isSafeMillis(account.auth.rateLimitExpiresAtMs) ||
          account.auth.rateLimitExpiresAtMs <= account.auth.updatedAtMs))
    ) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.rateLimitExpiresAtMs`);
    }
    if (account.auth.reason !== null && !isAuthReasonCode(account.auth.reason)) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.reason`);
    }
    if (
      account.auth.source !== null &&
      (!isSafeIdentifier(account.auth.source.providerId) ||
        !isSafeIdentifier(account.auth.source.profileId) ||
        !isSafeIdentifier(account.auth.source.accountId) ||
        !isSafeEpoch(account.auth.source.generation) ||
        !isSafeEpoch(account.auth.source.sequence) ||
        account.auth.source.providerId !== account.providerId ||
        account.auth.source.profileId !== account.profileId ||
        account.auth.source.accountId !== account.accountId)
    ) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.source`);
    }
    if (
      account.auth.source === null &&
      (account.auth.live || account.auth.status !== AUTH_STATUS.SIGNED_OUT || account.auth.authEpoch !== 0)
    ) {
      throw new InvalidRuntimeInput(`accounts.${account.accountId}.auth.source`);
    }
    for (const [capabilityId, observation] of Object.entries(account.capabilities)) {
      if (
        !isSafeIdentifier(capabilityId) ||
        !Object.values(CAPABILITY_READINESS).includes(observation.readiness) ||
        !isSafeMillis(observation.observedAtMs) ||
        (observation.reason !== null && !isCapabilityReasonCode(observation.reason)) ||
        typeof observation.live !== "boolean" ||
        !isSafeIdentifier(observation.source?.providerId) ||
        !isSafeIdentifier(observation.source?.profileId) ||
        !isSafeIdentifier(observation.source?.accountId) ||
        !isSafeEpoch(observation.source?.generation) ||
        !isSafeEpoch(observation.source?.sequence) ||
        observation.source.providerId !== account.providerId ||
        observation.source.profileId !== account.profileId ||
        observation.source.accountId !== account.accountId
      ) {
        throw new InvalidRuntimeInput(`accounts.${account.accountId}.capabilities.${capabilityId}`);
      }
    }
    accounts.set(account.accountId, account);
  }
  const sessions = new Set<string>();
  for (const selection of domain.selectedAccounts) {
    if (
      !isSafeIdentifier(selection.projectId) ||
      !isSafeIdentifier(selection.sessionId) ||
      !isSafeEpoch(selection.selectionGeneration) ||
      selection.selectionGeneration < 1 ||
      !isSafeMillis(selection.selectedAtMs)
    ) {
      throw new InvalidRuntimeInput(`selectedAccounts.${selection.projectId}.${selection.sessionId}`);
    }
    const sessionKey = `${selection.projectId}\u0000${selection.sessionId}`;
    if (sessions.has(sessionKey)) {
      throw new InvalidRuntimeInput(`selectedAccounts.${selection.projectId}.${selection.sessionId}`);
    }
    const account = accounts.get(selection.accountId);
    const profile = profiles.get(selection.profileId);
    if (!account || !profile || account.profileId !== selection.profileId || profile.providerId !== selection.providerId) {
      throw new InvalidRuntimeInput(`selectedAccounts.${selection.projectId}.${selection.sessionId}`);
    }
    sessions.add(sessionKey);
  }
}

export function decodeProviderProfile(input: unknown): DomainResult<ProviderProfile> {
  try {
    return success(decodeProfileOrThrow(input, "$"));
  } catch (error) {
    return failure("invalid-runtime-input", error instanceof InvalidRuntimeInput ? error.inputPath : "$runtime");
  }
}

export function decodeProviderAccount(input: unknown): DomainResult<ProviderAccount> {
  try {
    return success(decodeAccountOrThrow(input, "$"));
  } catch (error) {
    return failure("invalid-runtime-input", error instanceof InvalidRuntimeInput ? error.inputPath : "$runtime");
  }
}

export function decodeProviderAuthDomain(input: unknown): DomainResult<ProviderAuthDomain> {
  try {
    const record = expectPlain(input, "$" );
    expectExactKeys(record, ["schemaVersion", "profiles", "accounts", "selectedAccounts"], "$" );
    if (record.schemaVersion !== 1) throw new InvalidRuntimeInput("$.schemaVersion");
    const profilesRaw = expectArray(record.profiles, "$.profiles");
    const accountsRaw = expectArray(record.accounts, "$.accounts");
    const selectedRaw = expectArray(record.selectedAccounts, "$.selectedAccounts");
    const domain: ProviderAuthDomain = {
      schemaVersion: 1,
      profiles: profilesRaw.map((value, index) => decodeProfileOrThrow(value, `$.profiles[${index}]`)),
      accounts: accountsRaw.map((value, index) => decodeAccountOrThrow(value, `$.accounts[${index}]`)),
      selectedAccounts: selectedRaw.map((value, index) => decodeSelectionOrThrow(value, `$.selectedAccounts[${index}]`)),
    };
    assertValidDomain(domain);
    return success(domain);
  } catch (error) {
    return failure("invalid-runtime-input", error instanceof InvalidRuntimeInput ? error.inputPath : "$runtime");
  }
}

export function decodeProviderPolicy(input: unknown): DomainResult<AuthPolicy> {
  try {
    const record = expectPlain(input, "$" );
    expectExactKeys(record, ["release", "adapters"], "$" );
    if (record.release !== "personal" && record.release !== "public") throw new InvalidRuntimeInput("$.release");
    const adapters = expectPlain(record.adapters, "$.adapters");
    const decoded: Record<ProviderId, ProviderAdapterPolicy> = {};
    for (const providerId of Object.keys(adapters)) {
      expectIdentifier(providerId, `$.adapters.${providerId}`);
      const adapter = expectPlain(adapters[providerId], `$.adapters.${providerId}`);
      expectExactKeys(adapter, ["subscriptionManaged", "apiKey", "publicSubscription"], `$.adapters.${providerId}`);
      if (adapter.subscriptionManaged !== ADAPTER_SUPPORT.SUPPORTED && adapter.subscriptionManaged !== ADAPTER_SUPPORT.UNSUPPORTED) {
        throw new InvalidRuntimeInput(`$.adapters.${providerId}.subscriptionManaged`);
      }
      if (adapter.apiKey !== ADAPTER_SUPPORT.SUPPORTED && adapter.apiKey !== ADAPTER_SUPPORT.UNSUPPORTED) {
        throw new InvalidRuntimeInput(`$.adapters.${providerId}.apiKey`);
      }
      if (adapter.publicSubscription !== PUBLIC_SUBSCRIPTION.AUTHORIZED && adapter.publicSubscription !== PUBLIC_SUBSCRIPTION.UNAUTHORIZED) {
        throw new InvalidRuntimeInput(`$.adapters.${providerId}.publicSubscription`);
      }
      decoded[providerId] = {
        subscriptionManaged: adapter.subscriptionManaged,
        apiKey: adapter.apiKey,
        publicSubscription: adapter.publicSubscription,
      };
    }
    return success({ release: record.release, adapters: decoded });
  } catch (error) {
    return failure("invalid-runtime-input", error instanceof InvalidRuntimeInput ? error.inputPath : "$runtime");
  }
}

export function decodeSessionAttachmentProof(input: unknown): DomainResult<SessionAttachmentProof> {
  try {
    const record = expectPlain(input, "$" );
    expectExactKeys(
      record,
      [
        "version",
        "projectId",
        "sessionId",
        "accountId",
        "profileId",
        "providerId",
        "selectionGeneration",
        "authEpoch",
        "capabilityEpoch",
        "issuedAtMs",
      ],
      "$" ,
    );
    if (record.version !== 1) throw new InvalidRuntimeInput("$.version");
    return success({
      version: 1,
      projectId: expectIdentifier(record.projectId, "$.projectId"),
      sessionId: expectIdentifier(record.sessionId, "$.sessionId"),
      accountId: expectIdentifier(record.accountId, "$.accountId"),
      profileId: expectIdentifier(record.profileId, "$.profileId"),
      providerId: expectIdentifier(record.providerId, "$.providerId"),
      selectionGeneration: expectEpoch(record.selectionGeneration, "$.selectionGeneration"),
      authEpoch: expectEpoch(record.authEpoch, "$.authEpoch"),
      capabilityEpoch: expectEpoch(record.capabilityEpoch, "$.capabilityEpoch"),
      issuedAtMs: expectMillis(record.issuedAtMs, "$.issuedAtMs"),
    });
  } catch (error) {
    return failure("invalid-runtime-input", error instanceof InvalidRuntimeInput ? error.inputPath : "$runtime");
  }
}

function canonicalProfile(profile: ProviderProfile): ProviderProfile {
  return {
    profileId: profile.profileId,
    providerId: profile.providerId,
    label: profile.label,
    authMode: profile.authMode,
  };
}

function canonicalAccount(account: ProviderAccount): ProviderAccount {
  const capabilities = createCapabilityRecord();
  for (const capabilityId of Object.keys(account.capabilities).sort()) {
    const observation = account.capabilities[capabilityId];
    capabilities[capabilityId] = {
      readiness: observation.readiness,
      observedAtMs: observation.observedAtMs,
      reason: observation.reason,
      source: cloneObservationSource(observation.source),
      live: false,
    };
  }
  return {
    accountId: account.accountId,
    profileId: account.profileId,
    providerId: account.providerId,
    label: account.label,
    auth: {
      status: account.auth.status,
      authEpoch: account.auth.authEpoch,
      expiresAtMs: account.auth.expiresAtMs,
      rateLimitExpiresAtMs: account.auth.rateLimitExpiresAtMs,
      updatedAtMs: account.auth.updatedAtMs,
      reason: account.auth.reason,
      refresh: account.auth.refresh
        ? {
            accountId: account.auth.refresh.accountId,
            attemptId: account.auth.refresh.attemptId,
            baseAuthEpoch: account.auth.refresh.baseAuthEpoch,
            startedAtMs: account.auth.refresh.startedAtMs,
          }
        : null,
      source: account.auth.source ? cloneObservationSource(account.auth.source) : null,
      live: false,
    },
    capabilities,
    capabilityEpoch: account.capabilityEpoch,
  };
}

export function serializeProviderAuthDomain(domain: ProviderAuthDomain): string {
  try {
    assertValidDomain(domain);
  } catch (error) {
    const path = error instanceof InvalidRuntimeInput ? error.inputPath : "invalid input";
    throw new TypeError(`Cannot serialize provider auth domain: ${path}`);
  }
  const canonical = {
    schemaVersion: 1 as const,
    profiles: [...domain.profiles].sort((a, b) => compareIdentifier(a.profileId, b.profileId)).map(canonicalProfile),
    accounts: [...domain.accounts].sort((a, b) => compareIdentifier(a.accountId, b.accountId)).map(canonicalAccount),
    selectedAccounts: [...domain.selectedAccounts]
      .sort(
        (a, b) =>
          compareIdentifier(a.projectId, b.projectId) || compareIdentifier(a.sessionId, b.sessionId),
      )
      .map((selection) => ({
        projectId: selection.projectId,
        sessionId: selection.sessionId,
        accountId: selection.accountId,
        profileId: selection.profileId,
        providerId: selection.providerId,
        selectionGeneration: selection.selectionGeneration,
        selectedAtMs: selection.selectedAtMs,
      })),
  };
  return JSON.stringify(canonical);
}
