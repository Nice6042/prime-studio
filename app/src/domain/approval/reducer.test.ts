import { describe, expect, it } from "vitest";

import {
  CAPABILITY_ACTIONS,
  createTrustedAdapterAuthority,
} from "./contract";
import type {
  CapabilityAction,
  CapabilityAttempt,
  CapabilityGrant,
  CapabilityTarget,
  VerifiedAttemptEvidence,
  VerifiedGrantEvidence,
} from "./contract";
import { createApprovalReducer, createApprovalState } from "./reducer";
import type {
  ApprovalReducerAction,
  CompletionAuthentication,
  CompletionStatus,
} from "./reducer";

const adapterAuthority = createTrustedAdapterAuthority(
  ["adapter:desktop", "adapter:other"].flatMap((adapterId) =>
    CAPABILITY_ACTIONS.map((action) => ({
      adapterId,
      adapterVersion: "1",
      action,
      validateTarget: (candidate: unknown) => candidate as CapabilityTarget,
    })),
  ),
);
const { createCapabilityAttempt, createCapabilityGrant } = adapterAuthority.contract;

let trustedNow: unknown = 0;
const completionTokens = new WeakMap<object, { attemptId: string; outcome: CompletionStatus }>();
const completionAttestation = (attemptId: string, outcome: CompletionStatus): object => {
  const token = Object.freeze({});
  completionTokens.set(token, { attemptId, outcome });
  return token;
};
const approvalReducer = createApprovalReducer({
  contract: adapterAuthority.contract,
  readClock: () => trustedNow,
  authenticateCompletion: (completion: CompletionAuthentication, token: unknown) => {
    if (typeof token !== "object" || token === null) return false;
    const expected = completionTokens.get(token);
    return Boolean(
      expected &&
      expected.attemptId === completion.attempt.id &&
      expected.outcome === completion.outcome,
    );
  },
});

const reduceApproval = (state: ReturnType<typeof createApprovalState>, input: unknown) => {
  if (typeof input !== "object" || input === null) return approvalReducer(state, input);
  const envelope = input as Record<string, unknown>;
  const { at, ...action } = envelope;
  if (Object.prototype.hasOwnProperty.call(envelope, "at")) trustedNow = at;
  if (
    state.lastObservedAt === null &&
    action.type === "issue" &&
    !Object.prototype.hasOwnProperty.call(envelope, "at")
  ) {
    trustedNow = (action.grant as CapabilityGrant).issuedAt;
  }
  if (
    action.type === "settle" &&
    !Object.prototype.hasOwnProperty.call(action, "attestation")
  ) {
    action.attestation = completionAttestation(
      action.attemptId as string,
      action.outcome as CompletionStatus,
    );
  }
  return approvalReducer(state, action);
};

const canonicalArgumentsByDigest = new Map<string, string>();

const grantEvidence = (
  action: CapabilityAction,
  target: CapabilityTarget,
  canonicalArguments = "canonical-arguments:a",
  adapterId = "adapter:desktop",
): VerifiedGrantEvidence => {
  const evidence = adapterAuthority.mint.grantEvidence({
    adapterId,
    adapterVersion: "1",
    action,
    candidateTarget: target,
    canonicalArguments,
  });
  canonicalArgumentsByDigest.set(evidence.argumentsDigest, canonicalArguments);
  return evidence;
};

const attemptEvidence = (
  action: CapabilityAction,
  target: CapabilityTarget,
  canonicalArguments = "canonical-arguments:a",
  adapterId = "adapter:desktop",
): VerifiedAttemptEvidence => {
  const evidence = adapterAuthority.mint.attemptEvidence({
    adapterId,
    adapterVersion: "1",
    action,
    candidateTarget: target,
    canonicalArguments,
  });
  canonicalArgumentsByDigest.set(evidence.argumentsDigest, canonicalArguments);
  return evidence;
};

const grant = (overrides: Partial<CapabilityGrant> = {}): CapabilityGrant => {
  const base: CapabilityGrant = {
    id: "grant:1",
    approvalId: "approval:1",
    scope: "once",
    action: "file",
    target: { action: "file", value: "C:\\repo\\release.txt" },
    risk: { severity: "high", fingerprint: "filesystem.write:v1" },
    binding: {
      principalId: "principal:alice",
      accountId: "account:primary",
      projectId: "project:prime",
      sessionId: "session:7",
      policyId: "policy:desktop",
      epoch: 3,
    },
    evidence: grantEvidence("file", { action: "file", value: "C:\\repo\\release.txt" }),
    issuedAt: 1_000,
    expiresAt: 2_000,
  };
  const merged = {
    ...base,
    ...overrides,
  };
  return createCapabilityGrant({
    ...merged,
    evidence:
      overrides.evidence ??
      grantEvidence(
        merged.action,
        merged.target,
        canonicalArgumentsByDigest.get(base.evidence.argumentsDigest),
      ),
  });
};

const attempt = (
  source: CapabilityGrant = grant(),
  overrides: Partial<CapabilityAttempt> = {},
): CapabilityAttempt => {
  const base: CapabilityAttempt = {
    id: "attempt:1",
    grantId: source.id,
    scope: source.scope,
    action: source.action,
    target: source.target,
    risk: source.risk,
    binding: source.binding,
    evidence: attemptEvidence(
      source.action,
      source.target,
      canonicalArgumentsByDigest.get(source.evidence.argumentsDigest),
      source.evidence.adapterId,
    ),
  };
  const merged = {
    ...base,
    ...overrides,
  };
  return createCapabilityAttempt({
    ...merged,
    evidence:
      overrides.evidence ??
      attemptEvidence(
        merged.action,
        merged.target,
        canonicalArgumentsByDigest.get(source.evidence.argumentsDigest),
        source.evidence.adapterId,
      ),
  });
};

describe("approval reducer", () => {
  it("default-denies an unknown reducer action instead of treating it as authorization", () => {
    const issued = grant({ scope: "session" });
    const claim = attempt(issued);
    const state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });

    const next = reduceApproval(
      state,
      {
        type: "authorize-and-bypass-decoder",
        attempt: claim,
        at: 1_500,
      } as unknown as ApprovalReducerAction,
    );

    expect(next).toBe(state);
    expect(next.decisions).toEqual([]);
    expect(next.attempts).toEqual({});

    let typeReads = 0;
    const hostileEnvelope = {
      get type() {
        typeReads += 1;
        return typeReads === 1 ? "not-an-action" : "authorize";
      },
      attempt: claim,
      at: 1_500,
    };
    expect(reduceApproval(state, hostileEnvelope)).toBe(state);
    expect(typeReads).toBe(1);
  });

  it("default-denies an attempt with no issued grant and records the full claim", () => {
    const claim = attempt();

    const state = reduceApproval(createApprovalState(), {
      type: "authorize",
      attempt: claim,
      at: 1_500,
    });

    expect(state.decisions).toEqual([
      {
        verdict: "deny",
        reason: "grant-not-found",
        at: 1_500,
        attempt: claim,
        grant: null,
      },
    ]);
    expect(state.attempts[claim.id]).toEqual({
      attempt: claim,
      phase: "terminal",
      outcome: { status: "denied", reason: "grant-not-found", at: 1_500 },
    });
    expect(Object.isFrozen(state.decisions[0].attempt.binding)).toBe(true);
  });

  it("authorizes one exact issued claim and consumes once authority atomically", () => {
    const issued = grant();
    const claim = attempt(issued);
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });

    state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_500 });

    expect(state.decisions).toEqual([
      {
        verdict: "allow",
        at: 1_500,
        attempt: claim,
        grant: issued,
      },
    ]);
    expect(state.grants[issued.id]).toEqual({
      grant: issued,
      consumedBy: claim.id,
      inFlightBy: claim.id,
    });
    expect(state.attempts[claim.id]).toEqual({
      attempt: claim,
      phase: "authorized",
      authorizedAt: 1_500,
    });
  });

  it("denies every exact scope, target, risk, binding, and digest mismatch", () => {
    const issued = grant();
    const cases: Array<[string, Partial<CapabilityAttempt>]> = [
      ["scope-mismatch", { scope: "session" }],
      ["action-mismatch", { action: "shell", target: { action: "shell", value: issued.target.value } }],
      ["target-mismatch", { target: { action: "file", value: "c:\\repo\\release.txt" } }],
      ["risk-mismatch", { risk: { severity: "critical", fingerprint: issued.risk.fingerprint } }],
      ["principal-mismatch", { binding: { ...issued.binding, principalId: "principal:mallory" } }],
      ["account-mismatch", { binding: { ...issued.binding, accountId: "account:other" } }],
      ["project-mismatch", { binding: { ...issued.binding, projectId: "project:other" } }],
      ["session-mismatch", { binding: { ...issued.binding, sessionId: "session:other" } }],
      ["policy-mismatch", { binding: { ...issued.binding, policyId: "policy:other" } }],
      ["epoch-mismatch", { binding: { ...issued.binding, epoch: 4 } }],
      [
        "adapter-evidence-mismatch",
        {
          evidence: attemptEvidence(
            issued.action,
            issued.target,
            canonicalArgumentsByDigest.get(issued.evidence.argumentsDigest),
            "adapter:other",
          ),
        },
      ],
      [
        "arguments-digest-mismatch",
        { evidence: attemptEvidence(issued.action, issued.target, "canonical-arguments:c") },
      ],
    ];

    for (const [reason, override] of cases) {
      const claim = attempt(issued, override);
      let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });

      state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_500 });

      const decision = state.decisions[state.decisions.length - 1];
      expect(decision).toEqual({
        verdict: "deny",
        reason,
        at: 1_500,
        attempt: claim,
        grant: issued,
      });
      expect(state.grants[issued.id]).toEqual({ grant: issued });
    }
  });

  it("denies authority before issuance and at the exact expiry deadline", () => {
    const issued = grant();

    for (const [at, reason] of [[2_000, "grant-expired"]] as const) {
      let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
      state = reduceApproval(state, { type: "authorize", attempt: attempt(issued), at });

      expect(state.decisions[0]).toMatchObject({ verdict: "deny", reason, at });
    }
    const issuedState = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    expect(
      reduceApproval(issuedState, { type: "authorize", attempt: attempt(issued), at: 999 }),
    ).toBe(issuedState);
  });

  it("denies replay of an attempt id without overwriting its first authorization", () => {
    const issued = grant({ scope: "session" });
    const claim = attempt(issued);
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_500 });
    const authorized = state;

    state = reduceApproval(state, { type: "authorize", attempt: claim, at: Number.NaN });
    expect(state).toBe(authorized);

    state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_501 });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["allow", undefined],
      ["deny", "attempt-replayed"],
    ]);
    expect(state.attempts[claim.id]).toEqual({
      attempt: claim,
      phase: "authorized",
      authorizedAt: 1_500,
    });
  });

  it("denies a second unique attempt against consumed once authority", () => {
    const issued = grant({ scope: "once" });
    const first = attempt(issued, { id: "attempt:first" });
    const second = attempt(issued, { id: "attempt:second" });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, { type: "authorize", attempt: first, at: 1_500 });

    state = reduceApproval(state, { type: "authorize", attempt: second, at: 1_501 });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["allow", undefined],
      ["deny", "grant-consumed"],
    ]);
    expect(state.grants[issued.id]).toEqual({
      grant: issued,
      consumedBy: first.id,
      inFlightBy: first.id,
    });
    expect(state.attempts[second.id]?.outcome).toEqual({
      status: "denied",
      reason: "grant-consumed",
      at: 1_501,
    });
  });

  it("ends session authority without widening or destroying persistent authority", () => {
    const sessionGrant = grant({ id: "grant:session", scope: "session" });
    const persistentGrant = grant({
      id: "grant:persistent",
      approvalId: "approval:persistent",
      scope: "persistent",
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: sessionGrant });
    state = reduceApproval(state, { type: "issue", grant: persistentGrant });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(sessionGrant, { id: "attempt:session:first" }),
      at: 1_500,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(persistentGrant, { id: "attempt:persistent:first" }),
      at: 1_500,
    });
    state = reduceApproval(state, {
      type: "settle",
      attemptId: "attempt:session:first",
      outcome: "succeeded",
      at: 1_550,
    });
    state = reduceApproval(state, {
      type: "settle",
      attemptId: "attempt:persistent:first",
      outcome: "succeeded",
      at: 1_550,
    });

    state = reduceApproval(state, {
      type: "end-session",
      binding: sessionGrant.binding,
      at: 1_600,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(sessionGrant, { id: "attempt:session:second" }),
      at: 1_601,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(persistentGrant, { id: "attempt:persistent:second" }),
      at: 1_601,
    });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["allow", undefined],
      ["allow", undefined],
      ["deny", "session-ended"],
      ["allow", undefined],
    ]);
  });

  it("ends a session across policy and epoch changes without ending another session", () => {
    const ended = grant({ id: "grant:ended", scope: "session" });
    const other = grant({
      id: "grant:other-session",
      approvalId: "approval:other-session",
      scope: "session",
      binding: { ...ended.binding, sessionId: "session:8" },
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: ended });
    state = reduceApproval(state, { type: "issue", grant: other });

    state = reduceApproval(state, {
      type: "end-session",
      binding: { ...ended.binding, policyId: "policy:rotated", epoch: 99 },
      at: 1_550,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(ended, { id: "attempt:ended-after-rotation" }),
      at: 1_600,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(other, { id: "attempt:other-session" }),
      at: 1_600,
    });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["deny", "session-ended"],
      ["allow", undefined],
    ]);
  });

  it("keeps equal session identifiers isolated across account bindings", () => {
    const ended = grant({ id: "grant:account:ended", approvalId: "approval:account:ended", scope: "session" });
    const otherAccount = grant({
      id: "grant:account:other",
      approvalId: "approval:account:other",
      scope: "session",
      binding: { ...ended.binding, accountId: "account:other" },
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: ended });
    state = reduceApproval(state, { type: "issue", grant: otherAccount });
    state = reduceApproval(state, { type: "end-session", binding: ended.binding, at: 1_400 });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(ended, { id: "attempt:account:ended" }),
      at: 1_500,
    });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(otherAccount, { id: "attempt:account:other" }),
      at: 1_500,
    });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["deny", "session-ended"],
      ["allow", undefined],
    ]);
  });

  it("revokes a grant irreversibly even when a later attempt backdates its clock", () => {
    const issued = grant({ scope: "persistent" });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, {
      type: "revoke",
      grantId: issued.id,
      at: 1_600,
      reason: "operator-revoked",
    });
    const revokedState = state;

    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(issued),
      at: 1_500,
    });

    expect(state).toBe(revokedState);
    expect(state.decisions).toEqual([]);
    expect(state.revocations[issued.id]).toEqual({ at: 1_600, reason: "operator-revoked" });
  });

  it("never replaces an issued grant id with replayed broader authority", () => {
    const original = grant();
    const replay = grant({
      scope: "persistent",
      target: { action: "file", value: "C:\\" },
      risk: { severity: "low", fingerprint: "filesystem.read:v1" },
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: original });

    state = reduceApproval(state, { type: "issue", grant: replay });

    expect(state.grants[original.id]).toEqual({ grant: original });
  });

  it("keeps a revocation tombstone so an old grant id cannot be reissued", () => {
    const revoked = grant({ id: "grant:tombstoned" });
    let state = reduceApproval(createApprovalState(), {
      type: "revoke",
      grantId: revoked.id,
      at: 1_200,
      reason: "policy-revoked",
    });

    state = reduceApproval(state, { type: "issue", grant: revoked });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(revoked),
      at: 1_500,
    });

    expect(state.grants[revoked.id]).toBeUndefined();
    expect(state.decisions[0]).toMatchObject({
      verdict: "deny",
      reason: "grant-revoked",
      grant: null,
    });
  });

  it("invalidates matching stale claims when the bound policy epoch advances", () => {
    const oldGrant = grant({ id: "grant:epoch-3", scope: "persistent" });
    const newGrant = grant({
      id: "grant:epoch-4",
      approvalId: "approval:epoch-4",
      scope: "persistent",
      binding: { ...oldGrant.binding, epoch: 4 },
      issuedAt: 1_400,
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: oldGrant });
    state = reduceApproval(state, {
      type: "advance-policy-epoch",
      principalId: oldGrant.binding.principalId,
      accountId: oldGrant.binding.accountId,
      projectId: oldGrant.binding.projectId,
      policyId: oldGrant.binding.policyId,
      epoch: 4,
      at: 1_400,
    });
    state = reduceApproval(state, {
      type: "advance-policy-epoch",
      principalId: oldGrant.binding.principalId,
      accountId: oldGrant.binding.accountId,
      projectId: oldGrant.binding.projectId,
      policyId: oldGrant.binding.policyId,
      epoch: 2,
      at: 1_401,
    });
    state = reduceApproval(state, {
      type: "advance-policy-epoch",
      principalId: oldGrant.binding.principalId,
      accountId: oldGrant.binding.accountId,
      projectId: oldGrant.binding.projectId,
      policyId: oldGrant.binding.policyId,
      epoch: 5,
      at: 1_399,
    });

    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(oldGrant, { id: "attempt:stale" }),
      at: 1_500,
    });
    state = reduceApproval(state, { type: "issue", grant: newGrant });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(newGrant, { id: "attempt:current" }),
      at: 1_500,
    });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["deny", "policy-epoch-stale"],
      ["allow", undefined],
    ]);
    expect(state.policyEpochs).toEqual({
      '["principal:alice","account:primary","project:prime","policy:desktop"]': {
        epoch: 4,
        effectiveAt: 1_400,
      },
    });
  });

  it("rejects a current-epoch grant issued before that epoch became effective", () => {
    const oldGrant = grant({ id: "grant:epoch:old", approvalId: "approval:epoch:old" });
    const premature = grant({
      id: "grant:epoch:premature",
      approvalId: "approval:epoch:premature",
      binding: { ...oldGrant.binding, epoch: 4 },
      issuedAt: 1_399,
    });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: oldGrant });
    state = reduceApproval(state, {
      type: "advance-policy-epoch",
      principalId: oldGrant.binding.principalId,
      accountId: oldGrant.binding.accountId,
      projectId: oldGrant.binding.projectId,
      policyId: oldGrant.binding.policyId,
      epoch: 4,
      at: 1_400,
    });

    const advanced = state;
    state = reduceApproval(state, { type: "issue", grant: premature });

    expect(state).toBe(advanced);
    expect(state.grants[premature.id]).toBeUndefined();
  });

  it("records success, failure, and uncertainty as immutable terminal outcomes", () => {
    for (const status of ["succeeded", "failed", "uncertain"] as const) {
      const issued = grant({ id: `grant:${status}`, scope: "session" });
      const claim = attempt(issued, { id: `attempt:${status}` });
      let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
      state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_500 });

      state = reduceApproval(state, { type: "settle", attemptId: claim.id, outcome: status, at: 1_600 });

      expect(state.attempts[claim.id]).toEqual({
        attempt: claim,
        phase: "terminal",
        authorizedAt: 1_500,
        outcome: { status, at: 1_600 },
      });
      const terminal = state;
      state = reduceApproval(state, {
        type: "settle",
        attemptId: claim.id,
        outcome: status === "uncertain" ? "succeeded" : "uncertain",
        at: 1_700,
      });
      expect(state).toBe(terminal);
    }
  });

  it("quarantines reusable authority after uncertainty until a new grant is issued", () => {
    const issued = grant({ id: "grant:uncertain", scope: "persistent" });
    const first = attempt(issued, { id: "attempt:uncertain:first" });
    const replay = attempt(issued, { id: "attempt:uncertain:fresh-id" });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, { type: "authorize", attempt: first, at: 1_500 });
    state = reduceApproval(state, {
      type: "settle",
      attemptId: first.id,
      outcome: "uncertain",
      at: 1_550,
    });

    state = reduceApproval(state, { type: "authorize", attempt: replay, at: 1_600 });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["allow", undefined],
      ["deny", "grant-outcome-uncertain"],
    ]);
    expect(state.grants[issued.id]).toEqual({ grant: issued, uncertainBy: first.id });

    const renamed = grant({
      id: "grant:renamed-same-approval",
      approvalId: issued.approvalId,
      scope: "persistent",
    });
    state = reduceApproval(state, { type: "issue", grant: renamed });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(renamed, { id: "attempt:renamed-same-approval" }),
      at: 1_600,
    });
    expect(state.grants[renamed.id]).toBeUndefined();
    expect(state.decisions[2]).toMatchObject({ verdict: "deny", reason: "grant-not-found" });

    const replacement = grant({
      id: "grant:replacement",
      approvalId: "approval:replacement",
      scope: "persistent",
    });
    state = reduceApproval(state, { type: "issue", grant: replacement });
    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(replacement, { id: "attempt:replacement" }),
      at: 1_600,
    });
    expect(state.decisions[3]?.verdict).toBe("allow");
  });

  it("default-denies invalid evaluation clocks instead of bypassing time bounds", () => {
    const issued = grant();
    const issuedState = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    const hostileClock = new Proxy(
      {},
      {
        get() {
          throw new Error("clock must not be coerced");
        },
      },
    );

    for (const at of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1_500.5,
      1_500n,
      hostileClock,
    ]) {
      expect(
        reduceApproval(issuedState, {
          type: "authorize",
          attempt: attempt(issued),
          at,
        }),
      ).toBe(issuedState);
    }
  });

  it("ignores a caller backdate and evaluates expiry with one trusted clock observation", () => {
    const issued = grant({ scope: "session" });
    const state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    const claim = attempt(issued);
    let clockReads = 0;
    const singleReadReducer = createApprovalReducer({
      contract: adapterAuthority.contract,
      readClock: () => (++clockReads === 1 ? 2_001 : 1_001),
      authenticateCompletion: () => false,
    });

    const next = singleReadReducer(state, {
      type: "authorize",
      attempt: claim,
      at: 1_001,
    });

    expect(next.decisions[0]).toMatchObject({
      verdict: "deny",
      reason: "grant-expired",
      at: 2_001,
    });
    expect(next.lastObservedAt).toBe(2_001);
    expect(clockReads).toBe(1);
  });

  it("keeps reusable authority quarantined after forged settlement until authenticated uncertainty", () => {
    const issued = grant({ scope: "session" });
    const first = attempt(issued, { id: "attempt:completion:original" });
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, { type: "authorize", attempt: first, at: 1_500 });
    const authorized = state;

    trustedNow = 1_600;
    state = approvalReducer(state, {
      type: "settle",
      attemptId: first.id,
      outcome: "succeeded",
      attestation: Object.freeze({ forged: true }),
    });
    expect(state).toBe(authorized);
    expect(state.grants[issued.id]).toMatchObject({ inFlightBy: first.id });

    state = reduceApproval(state, {
      type: "authorize",
      attempt: attempt(issued, { id: "attempt:completion:blocked" }),
      at: 1_601,
    });
    expect(state.decisions[state.decisions.length - 1]).toMatchObject({
      verdict: "deny",
      reason: "grant-in-flight",
    });

    trustedNow = 1_700;
    state = approvalReducer(state, {
      type: "settle",
      attemptId: first.id,
      outcome: "uncertain",
      attestation: completionAttestation(first.id, "uncertain"),
    });
    expect(state.attempts[first.id]?.outcome).toEqual({ status: "uncertain", at: 1_700 });
    expect(state.grants[issued.id]).toMatchObject({ uncertainBy: first.id });
    expect(state.grants[issued.id]).not.toHaveProperty("inFlightBy");
  });

  it("requires primitive true from the completion authenticator and fails closed on exceptions", () => {
    const issued = grant({ scope: "session" });
    const claim = attempt(issued, { id: "attempt:strict-authenticator" });
    let authorized = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    authorized = reduceApproval(authorized, {
      type: "authorize",
      attempt: claim,
      at: 1_500,
    });

    for (const result of [
      Object.freeze({ authenticated: true }),
      Promise.resolve(false),
      Object.freeze({ then: () => false }),
    ]) {
      const untrustedReducer = createApprovalReducer({
        contract: adapterAuthority.contract,
        readClock: () => 1_600,
        authenticateCompletion: () => result as unknown as boolean,
      });

      expect(
        untrustedReducer(authorized, {
          type: "settle",
          attemptId: claim.id,
          outcome: "succeeded",
          attestation: Object.freeze({}),
        }),
      ).toBe(authorized);
    }

    const throwingReducer = createApprovalReducer({
      contract: adapterAuthority.contract,
      readClock: () => 1_600,
      authenticateCompletion: () => {
        throw new Error("executor verifier unavailable");
      },
    });
    expect(() =>
      throwingReducer(authorized, {
        type: "settle",
        attemptId: claim.id,
        outcome: "uncertain",
        attestation: Object.freeze({}),
      }),
    ).not.toThrow();
    expect(
      throwingReducer(authorized, {
        type: "settle",
        attemptId: claim.id,
        outcome: "uncertain",
        attestation: Object.freeze({}),
      }),
    ).toBe(authorized);
  });

  it("reads an authorization clock once and rejects malformed attempts without throwing", () => {
    const issued = grant({ scope: "session" });
    const state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    let clockReads = 0;
    const invalidClockEnvelope = {
      type: "authorize",
      attempt: attempt(issued),
      get at() {
        clockReads += 1;
        return clockReads === 1 ? Number.NaN : 1_500;
      },
    };

    expect(reduceApproval(state, invalidClockEnvelope)).toBe(state);
    expect(clockReads).toBe(1);

    let attemptReads = 0;
    const accessorAttemptEnvelope = {
      type: "authorize",
      get attempt() {
        attemptReads += 1;
        return attemptReads === 1 ? null : attempt(issued);
      },
      at: 1_500,
    };
    expect(reduceApproval(state, accessorAttemptEnvelope)).toBe(state);
    expect(attemptReads).toBe(1);

    const throwingAttempt = new Proxy(
      {},
      {
        get() {
          throw new Error("malformed attempt");
        },
      },
    );
    for (const malformed of [null, throwingAttempt]) {
      expect(() =>
        reduceApproval(state, { type: "authorize", attempt: malformed, at: 1_500 }),
      ).not.toThrow();
      expect(
        reduceApproval(state, { type: "authorize", attempt: malformed, at: 1_500 }),
      ).toBe(state);
    }
  });

  it("rejects bare-cast adapter evidence without throwing or persisting an attempt", () => {
    const issued = grant({ scope: "session" });
    const state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    const valid = attempt(issued);
    const unverified = {
      ...valid,
      evidence: { ...valid.evidence },
    } as unknown as CapabilityAttempt;

    expect(() =>
      reduceApproval(state, { type: "authorize", attempt: unverified, at: 1_500 }),
    ).not.toThrow();
    expect(
      reduceApproval(state, { type: "authorize", attempt: unverified, at: 1_500 }),
    ).toBe(state);
  });

  it("snapshots a hostile session binding once before keying session termination", () => {
    const issued = grant({ scope: "session" });
    const state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    let principalReads = 0;
    const binding = { ...issued.binding };
    Object.defineProperty(binding, "principalId", {
      enumerable: true,
      get: () => (++principalReads === 1 ? issued.binding.principalId : "principal:mallory"),
    });

    const ended = reduceApproval(state, { type: "end-session", binding, at: 1_400 });
    const next = reduceApproval(ended, {
      type: "authorize",
      attempt: attempt(issued),
      at: 1_500,
    });

    expect(principalReads).toBe(1);
    expect(next.decisions[0]).toMatchObject({ verdict: "deny", reason: "session-ended" });
  });

  it("does not accept a terminal outcome with an invalid or backdated clock", () => {
    const issued = grant({ scope: "session" });
    const claim = attempt(issued);
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
    state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_500 });
    const authorized = state;

    state = reduceApproval(state, {
      type: "settle",
      attemptId: claim.id,
      outcome: "uncertain",
      at: Number.NaN,
    });
    expect(state).toBe(authorized);
    state = reduceApproval(state, {
      type: "settle",
      attemptId: claim.id,
      outcome: "uncertain",
      at: 1_499,
    });
    expect(state).toBe(authorized);
    state = reduceApproval(state, {
      type: "settle",
      attemptId: claim.id,
      outcome: "anything" as CompletionStatus,
      at: 1_600,
    });
    expect(state).toBe(authorized);
    state = reduceApproval(state, {
      type: "settle",
      attemptId: { toString: () => claim.id } as unknown as string,
      outcome: "uncertain",
      at: 1_600,
    });
    expect(state).toBe(authorized);
  });

  it("applies the same closed contract to every action category", () => {
    for (const action of CAPABILITY_ACTIONS) {
      const issued = grant({
        id: `grant:${action}`,
        approvalId: `approval:${action}`,
        scope: "session",
        action,
        target: { action, value: `exact:${action}:target` },
      });
      let state = reduceApproval(createApprovalState(), { type: "issue", grant: issued });
      state = reduceApproval(state, {
        type: "authorize",
        attempt: attempt(issued, { id: `attempt:${action}` }),
        at: 1_500,
      });

      expect(state.decisions[0]?.verdict).toBe("allow");
    }
  });

  it("keeps audit decisions isolated from later mutation of caller-owned objects", () => {
    const target = { action: "file" as const, value: "C:\\repo\\release.txt" };
    const risk = { severity: "high" as const, fingerprint: "filesystem.write:v1" };
    const binding = {
      principalId: "principal:alice",
      accountId: "account:primary",
      projectId: "project:prime",
      sessionId: "session:7",
      policyId: "policy:desktop",
      epoch: 3,
    };
    const rawGrant: CapabilityGrant = {
      ...grant(),
      target,
      risk,
      binding,
    };
    let state = reduceApproval(createApprovalState(), { type: "issue", grant: rawGrant });
    target.value = "C:\\";
    risk.fingerprint = "filesystem.any:v1";
    binding.epoch = 99;
    const stored = state.grants[rawGrant.id].grant;
    const attemptTarget = { ...stored.target };
    const attemptRisk = { ...stored.risk };
    const attemptBinding = { ...stored.binding };
    const rawAttempt: CapabilityAttempt = {
      ...attempt(stored),
      target: attemptTarget,
      risk: attemptRisk,
      binding: attemptBinding,
    };

    state = reduceApproval(state, { type: "authorize", attempt: rawAttempt, at: 1_500 });
    attemptTarget.value = "C:\\broader";
    attemptRisk.fingerprint = "filesystem.any:v2";
    attemptBinding.sessionId = "session:other";

    const decision = state.decisions[0];
    expect(decision.grant).toMatchObject({
      target: { value: "C:\\repo\\release.txt" },
      risk: { fingerprint: "filesystem.write:v1" },
      binding: { epoch: 3 },
    });
    expect(decision.attempt).toMatchObject({
      target: { value: "C:\\repo\\release.txt" },
      risk: { fingerprint: "filesystem.write:v1" },
      binding: { sessionId: "session:7" },
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("cannot replay a previously denied attempt after its missing grant appears", () => {
    const issued = grant({ scope: "session" });
    const claim = attempt(issued);
    let state = reduceApproval(createApprovalState(), {
      type: "authorize",
      attempt: claim,
      at: 1_500,
    });
    state = reduceApproval(state, { type: "issue", grant: issued });

    state = reduceApproval(state, { type: "authorize", attempt: claim, at: 1_501 });

    expect(state.decisions.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["deny", "grant-not-found"],
      ["deny", "attempt-replayed"],
    ]);
  });

  it("ignores malformed lifecycle events instead of corrupting audit state", () => {
    const initial = createApprovalState();
    const binding = grant().binding;

    expect(
      reduceApproval(initial, { type: "end-session", binding, at: Number.NaN }),
    ).toBe(initial);
    expect(
      reduceApproval(initial, {
        type: "revoke",
        grantId: "",
        at: 1_500,
        reason: "operator-revoked",
      }),
    ).toBe(initial);
    expect(
      reduceApproval(initial, {
        type: "advance-policy-epoch",
        principalId: binding.principalId,
        accountId: binding.accountId,
        projectId: binding.projectId,
        policyId: binding.policyId,
        epoch: 4,
        at: 1_500.5,
      }),
    ).toBe(initial);
  });
});
