import {
  type ApprovalContract,
  type CapabilityAttempt,
  type CapabilityBinding,
  type CapabilityGrant,
} from "./contract";

export type DenialReason =
  | "grant-not-found"
  | "scope-mismatch"
  | "action-mismatch"
  | "target-mismatch"
  | "risk-mismatch"
  | "principal-mismatch"
  | "account-mismatch"
  | "project-mismatch"
  | "session-mismatch"
  | "policy-mismatch"
  | "epoch-mismatch"
  | "adapter-evidence-mismatch"
  | "arguments-digest-mismatch"
  | "grant-not-active"
  | "grant-expired"
  | "attempt-replayed"
  | "grant-consumed"
  | "session-ended"
  | "grant-revoked"
  | "policy-epoch-stale"
  | "invalid-time"
  | "grant-outcome-uncertain"
  | "grant-in-flight";
export type TerminalStatus = "succeeded" | "failed" | "denied" | "uncertain";
export type CompletionStatus = Exclude<TerminalStatus, "denied">;
const COMPLETION_STATUSES: readonly CompletionStatus[] = ["succeeded", "failed", "uncertain"];

export interface TerminalOutcome {
  readonly status: TerminalStatus;
  readonly reason?: DenialReason;
  readonly at: number;
}

export interface AttemptRecord {
  readonly attempt: CapabilityAttempt;
  readonly phase: "authorized" | "terminal";
  readonly authorizedAt?: number;
  readonly outcome?: TerminalOutcome;
}

export interface GrantRecord {
  readonly grant: CapabilityGrant;
  readonly consumedBy?: string;
  readonly inFlightBy?: string;
  readonly uncertainBy?: string;
}

export interface Revocation {
  readonly at: number;
  readonly reason: string;
}

export interface PolicyEpoch {
  readonly epoch: number;
  readonly effectiveAt: number;
}

export interface ApprovalDecision {
  readonly verdict: "allow" | "deny";
  readonly reason?: DenialReason;
  readonly at: number;
  readonly attempt: CapabilityAttempt;
  readonly grant: CapabilityGrant | null;
}

export interface ApprovalState {
  readonly grants: Readonly<Record<string, GrantRecord>>;
  readonly approvalGrants: Readonly<Record<string, string>>;
  readonly attempts: Readonly<Record<string, AttemptRecord>>;
  readonly decisions: readonly ApprovalDecision[];
  readonly endedSessions: Readonly<Record<string, number>>;
  readonly revocations: Readonly<Record<string, Revocation>>;
  readonly policyEpochs: Readonly<Record<string, PolicyEpoch>>;
  readonly lastObservedAt: number | null;
}

export type ApprovalReducerAction =
  | { readonly type: "issue"; readonly grant: CapabilityGrant }
  | {
      readonly type: "authorize";
      readonly attempt: CapabilityAttempt;
    }
  | {
      readonly type: "end-session";
      readonly binding: CapabilityBinding;
    }
  | {
      readonly type: "revoke";
      readonly grantId: string;
      readonly reason: string;
    }
  | {
      readonly type: "advance-policy-epoch";
      readonly principalId: string;
      readonly accountId: string;
      readonly projectId: string;
      readonly policyId: string;
      readonly epoch: number;
    }
  | {
      readonly type: "settle";
      readonly attemptId: string;
      readonly outcome: CompletionStatus;
      readonly attestation: unknown;
    };

export interface CompletionAuthentication {
  readonly attempt: CapabilityAttempt;
  readonly outcome: CompletionStatus;
  readonly observedAt: number;
}

export interface ApprovalReducerTrust {
  readonly contract: ApprovalContract;
  /** Trusted monotonic clock, installed outside all untrusted reducer actions. */
  readonly readClock: () => unknown;
  /** Trusted executor verifier; raw action data alone can never settle work. */
  readonly authenticateCompletion: (
    completion: CompletionAuthentication,
    attestation: unknown,
  ) => boolean;
}

const APPROVAL_REDUCER_ACTION_TYPES = {
  issue: true,
  authorize: true,
  "end-session": true,
  revoke: true,
  "advance-policy-epoch": true,
  settle: true,
} as const satisfies Record<ApprovalReducerAction["type"], true>;
void APPROVAL_REDUCER_ACTION_TYPES;

/**
 * Snapshots the reducer envelope and accepts only the closed action vocabulary.
 * This is the reducer's fail-closed runtime boundary; TypeScript unions do not
 * protect callers that deserialize untrusted messages.
 */
export function decodeApprovalReducerAction(input: unknown): ApprovalReducerAction | null {
  try {
    if (typeof input !== "object" || input === null) return null;
    const envelope = input as Record<string, unknown>;
    const type = envelope.type;
    switch (type) {
      case "issue":
        return { type, grant: envelope.grant as CapabilityGrant };
      case "authorize":
        return {
          type,
          attempt: envelope.attempt as CapabilityAttempt,
        };
      case "end-session":
        return {
          type,
          binding: envelope.binding as CapabilityBinding,
        };
      case "revoke":
        return {
          type,
          grantId: envelope.grantId as string,
          reason: envelope.reason as string,
        };
      case "advance-policy-epoch":
        return {
          type,
          principalId: envelope.principalId as string,
          accountId: envelope.accountId as string,
          projectId: envelope.projectId as string,
          policyId: envelope.policyId as string,
          epoch: envelope.epoch as number,
        };
      case "settle":
        return {
          type,
          attemptId: envelope.attemptId as string,
          outcome: envelope.outcome as CompletionStatus,
          attestation: envelope.attestation,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const emptyRecord = <T>(): Readonly<Record<string, T>> =>
  Object.freeze(Object.create(null) as Record<string, T>);

const withEntry = <T>(
  source: Readonly<Record<string, T>>,
  key: string,
  value: T,
): Readonly<Record<string, T>> => {
  const next = Object.assign(Object.create(null) as Record<string, T>, source);
  next[key] = value;
  return Object.freeze(next);
};

const hasEntry = <T>(source: Readonly<Record<string, T>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(source, key);

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validIdentifier = (value: string): boolean =>
  typeof value === "string" && Boolean(value) && value === value.trim() && !value.includes("\0");
const snapshotBinding = (binding: CapabilityBinding): CapabilityBinding | null => {
  const principalId = binding.principalId;
  const accountId = binding.accountId;
  const projectId = binding.projectId;
  const sessionId = binding.sessionId;
  const policyId = binding.policyId;
  const epoch = binding.epoch;
  if (
    !validIdentifier(principalId) ||
    !validIdentifier(accountId) ||
    !validIdentifier(projectId) ||
    !validIdentifier(sessionId) ||
    !validIdentifier(policyId) ||
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0
  ) {
    return null;
  }
  return Object.freeze({ principalId, accountId, projectId, sessionId, policyId, epoch });
};

const freezeState = (state: ApprovalState): ApprovalState => Object.freeze(state);

export function createApprovalState(): ApprovalState {
  return freezeState({
    grants: emptyRecord(),
    approvalGrants: emptyRecord(),
    attempts: emptyRecord(),
    decisions: Object.freeze([]),
    endedSessions: emptyRecord(),
    revocations: emptyRecord(),
    policyEpochs: emptyRecord(),
    lastObservedAt: null,
  });
}

const sessionKey = (
  binding: Pick<CapabilityBinding, "principalId" | "accountId" | "projectId" | "sessionId">,
): string =>
  JSON.stringify([binding.principalId, binding.accountId, binding.projectId, binding.sessionId]);

const policyKey = (
  binding: Pick<CapabilityBinding, "principalId" | "accountId" | "projectId" | "policyId">,
): string =>
  JSON.stringify([binding.principalId, binding.accountId, binding.projectId, binding.policyId]);

const claimMismatch = (
  grant: CapabilityGrant,
  attempt: CapabilityAttempt,
): DenialReason | undefined => {
  if (grant.scope !== attempt.scope) return "scope-mismatch";
  if (grant.action !== attempt.action) return "action-mismatch";
  if (
    grant.target.action !== attempt.target.action ||
    grant.target.value !== attempt.target.value
  ) {
    return "target-mismatch";
  }
  if (
    grant.risk.severity !== attempt.risk.severity ||
    grant.risk.fingerprint !== attempt.risk.fingerprint
  ) {
    return "risk-mismatch";
  }
  if (grant.binding.principalId !== attempt.binding.principalId) return "principal-mismatch";
  if (grant.binding.accountId !== attempt.binding.accountId) return "account-mismatch";
  if (grant.binding.projectId !== attempt.binding.projectId) return "project-mismatch";
  if (grant.binding.sessionId !== attempt.binding.sessionId) return "session-mismatch";
  if (grant.binding.policyId !== attempt.binding.policyId) return "policy-mismatch";
  if (grant.binding.epoch !== attempt.binding.epoch) return "epoch-mismatch";
  if (
    grant.evidence.kind !== attempt.evidence.kind ||
    grant.evidence.adapterId !== attempt.evidence.adapterId ||
    grant.evidence.adapterVersion !== attempt.evidence.adapterVersion ||
    grant.evidence.action !== attempt.evidence.action ||
    grant.evidence.target.action !== attempt.evidence.target.action ||
    grant.evidence.target.value !== attempt.evidence.target.value
  ) {
    return "adapter-evidence-mismatch";
  }
  if (grant.evidence.argumentsDigest !== attempt.evidence.argumentsDigest) {
    return "arguments-digest-mismatch";
  }
  return undefined;
};

const deny = (
  state: ApprovalState,
  presented: CapabilityAttempt,
  at: number,
  grant: CapabilityGrant | null,
  reason: DenialReason,
): ApprovalState => {
  const decision = Object.freeze({
    verdict: "deny" as const,
    reason,
    at,
    attempt: presented,
    grant,
  });
  const record = Object.freeze({
    attempt: presented,
    phase: "terminal" as const,
    outcome: Object.freeze({
      status: "denied" as const,
      reason,
      at,
    }),
  });
  return freezeState({
    ...state,
    attempts: withEntry(state.attempts, presented.id, record),
    decisions: Object.freeze([...state.decisions, decision]),
  });
};

const denyReplay = (
  state: ApprovalState,
  presented: CapabilityAttempt,
  at: number,
  grant: CapabilityGrant | null,
): ApprovalState => {
  const decision = Object.freeze({
    verdict: "deny" as const,
    reason: "attempt-replayed" as const,
    at,
    attempt: presented,
    grant,
  });
  return freezeState({
    ...state,
    decisions: Object.freeze([...state.decisions, decision]),
  });
};

const reduceApprovalAt = (
  state: ApprovalState,
  action: ApprovalReducerAction,
  observedAt: number,
  contract: ApprovalContract,
  authenticateCompletion: ApprovalReducerTrust["authenticateCompletion"],
): ApprovalState => {
  try {
  if (action.type === "issue") {
    const issued = contract.createCapabilityGrant(action.grant);
    if (
      hasEntry(state.grants, issued.id) ||
      hasEntry(state.revocations, issued.id) ||
      hasEntry(state.approvalGrants, issued.approvalId)
    ) {
      return state;
    }
    const key = policyKey(issued.binding);
    const currentEpoch = state.policyEpochs[key];
    if (
      currentEpoch &&
      (currentEpoch.epoch !== issued.binding.epoch ||
        issued.issuedAt < currentEpoch.effectiveAt)
    ) {
      return state;
    }
    return freezeState({
      ...state,
      grants: withEntry(state.grants, issued.id, Object.freeze({ grant: issued })),
      approvalGrants: withEntry(state.approvalGrants, issued.approvalId, issued.id),
      policyEpochs: currentEpoch
        ? state.policyEpochs
        : withEntry(
            state.policyEpochs,
            key,
            Object.freeze({ epoch: issued.binding.epoch, effectiveAt: issued.issuedAt }),
          ),
    });
  }
  if (action.type === "end-session") {
    const binding = snapshotBinding(action.binding);
    if (!binding) return state;
    return freezeState({
      ...state,
      endedSessions: withEntry(state.endedSessions, sessionKey(binding), observedAt),
    });
  }
  if (action.type === "revoke") {
    if (
      !validIdentifier(action.grantId) ||
      !validIdentifier(action.reason)
    ) {
      return state;
    }
    if (hasEntry(state.revocations, action.grantId)) return state;
    return freezeState({
      ...state,
      revocations: withEntry(
        state.revocations,
        action.grantId,
        Object.freeze({ at: observedAt, reason: action.reason }),
      ),
    });
  }
  if (action.type === "advance-policy-epoch") {
    if (
      !Number.isSafeInteger(action.epoch) ||
      action.epoch < 0 ||
      !validIdentifier(action.principalId) ||
      !validIdentifier(action.accountId) ||
      !validIdentifier(action.projectId) ||
      !validIdentifier(action.policyId)
    ) {
      return state;
    }
    const key = policyKey(action);
    const current = state.policyEpochs[key];
    if (
      current &&
      (action.epoch <= current.epoch || observedAt < current.effectiveAt)
    ) {
      return state;
    }
    return freezeState({
      ...state,
      policyEpochs: withEntry(
        state.policyEpochs,
        key,
        Object.freeze({ epoch: action.epoch, effectiveAt: observedAt }),
      ),
    });
  }
  if (action.type === "settle") {
    if (!validIdentifier(action.attemptId)) return state;
    const existing = state.attempts[action.attemptId];
    if (
      !existing ||
      existing.phase !== "authorized" ||
      existing.authorizedAt === undefined ||
      !COMPLETION_STATUSES.includes(action.outcome) ||
      observedAt < existing.authorizedAt
    ) {
      return state;
    }
    const authority = state.grants[existing.attempt.grantId];
    if (!authority || authority.inFlightBy !== existing.attempt.id) {
      return state;
    }
    const authenticated = authenticateCompletion(
      Object.freeze({ attempt: existing.attempt, outcome: action.outcome, observedAt }),
      action.attestation,
    );
    if (authenticated !== true) return state;
    const terminal = Object.freeze({
      attempt: existing.attempt,
      phase: "terminal" as const,
      authorizedAt: existing.authorizedAt,
      outcome: Object.freeze({ status: action.outcome, at: observedAt }),
    });
    const completedGrant = Object.freeze({
      grant: authority.grant,
      ...(authority.consumedBy ? { consumedBy: authority.consumedBy } : {}),
      ...(action.outcome === "uncertain" ? { uncertainBy: existing.attempt.id } : {}),
    });
    return freezeState({
      ...state,
      grants: withEntry(state.grants, authority.grant.id, completedGrant),
      attempts: withEntry(state.attempts, action.attemptId, terminal),
    });
  }

  const presented = contract.createCapabilityAttempt(action.attempt);
  const replayed = hasEntry(state.attempts, presented.id);
  const authority = state.grants[presented.grantId];
  if (replayed) {
    return denyReplay(
      state,
      presented,
      observedAt,
      state.grants[presented.grantId]?.grant ?? null,
    );
  }
  if (hasEntry(state.revocations, presented.grantId)) {
    return deny(state, presented, observedAt, authority?.grant ?? null, "grant-revoked");
  }
  if (!authority) {
    return deny(state, presented, observedAt, null, "grant-not-found");
  }
  if (authority.uncertainBy) {
    return deny(state, presented, observedAt, authority.grant, "grant-outcome-uncertain");
  }
  if (authority.grant.scope === "once" && authority.consumedBy) {
    return deny(state, presented, observedAt, authority.grant, "grant-consumed");
  }
  const mismatch = claimMismatch(authority.grant, presented);
  if (mismatch) {
    return deny(state, presented, observedAt, authority.grant, mismatch);
  }
  if (authority.inFlightBy) {
    return deny(state, presented, observedAt, authority.grant, "grant-in-flight");
  }
  const currentEpoch = state.policyEpochs[policyKey(authority.grant.binding)];
  if (
    currentEpoch?.epoch !== authority.grant.binding.epoch ||
    authority.grant.issuedAt < currentEpoch.effectiveAt
  ) {
    return deny(state, presented, observedAt, authority.grant, "policy-epoch-stale");
  }
  if (observedAt < authority.grant.issuedAt) {
    return deny(state, presented, observedAt, authority.grant, "grant-not-active");
  }
  if (observedAt >= authority.grant.expiresAt) {
    return deny(state, presented, observedAt, authority.grant, "grant-expired");
  }
  if (
    authority.grant.scope !== "persistent" &&
    hasEntry(state.endedSessions, sessionKey(authority.grant.binding))
  ) {
    return deny(state, presented, observedAt, authority.grant, "session-ended");
  }
  const decision = Object.freeze({
    verdict: "allow" as const,
    at: observedAt,
    attempt: presented,
    grant: authority.grant,
  });
  const attemptRecord = Object.freeze({
    attempt: presented,
    phase: "authorized" as const,
    authorizedAt: observedAt,
  });
  const grantRecord = Object.freeze({
    grant: authority.grant,
    ...(authority.grant.scope === "once" ? { consumedBy: presented.id } : {}),
    inFlightBy: presented.id,
  });
  return freezeState({
    ...state,
    grants: withEntry(state.grants, authority.grant.id, grantRecord),
    attempts: withEntry(state.attempts, presented.id, attemptRecord),
    decisions: Object.freeze([...state.decisions, decision]),
  });
  } catch {
    return state;
  }
};

/** Creates the only reducer entrypoint, bound to trusted time and provenance. */
export function createApprovalReducer(
  trust: ApprovalReducerTrust,
): (state: ApprovalState, input: unknown) => ApprovalState {
  const contract = trust.contract;
  const readClock = trust.readClock;
  const authenticateCompletion = trust.authenticateCompletion;
  return (state, input) => {
    const action = decodeApprovalReducerAction(input);
    if (!action) return state;
    let observedAt: unknown;
    try {
      observedAt = readClock();
    } catch {
      return state;
    }
    if (
      !validTime(observedAt) ||
      (state.lastObservedAt !== null && observedAt < state.lastObservedAt)
    ) {
      return state;
    }
    const next = reduceApprovalAt(
      state,
      action,
      observedAt,
      contract,
      authenticateCompletion,
    );
    if (next === state) return state;
    return freezeState({ ...next, lastObservedAt: observedAt });
  };
}
