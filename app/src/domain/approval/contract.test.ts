import { describe, expect, it } from "vitest";

import {
  CAPABILITY_ACTIONS,
  createTrustedAdapterAuthority,
  normalizeTarget,
} from "./contract";
import type {
  CapabilityAction,
  CapabilityAttempt,
  CapabilityGrant,
  CapabilityTarget,
  VerifiedAttemptEvidence,
  VerifiedGrantEvidence,
} from "./contract";

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

const grantEvidence = (
  action: CapabilityAction,
  target: CapabilityTarget,
  character = "b",
): VerifiedGrantEvidence =>
  adapterAuthority.mint.grantEvidence({
    adapterId: "adapter:desktop",
    adapterVersion: "1",
    action,
    candidateTarget: target,
    canonicalArguments: `canonical-arguments:${character}`,
  });

const attemptEvidence = (
  action: CapabilityAction,
  target: CapabilityTarget,
  character = "b",
): VerifiedAttemptEvidence =>
  adapterAuthority.mint.attemptEvidence({
    adapterId: "adapter:desktop",
    adapterVersion: "1",
    action,
    candidateTarget: target,
    canonicalArguments: `canonical-arguments:${character}`,
  });

const validGrantInput = (): CapabilityGrant => {
  const action = "file";
  const target: CapabilityTarget<"file"> = { action, value: "C:\\repo\\release.txt" };
  return {
    id: "grant:base",
    approvalId: "approval:base",
    scope: "once",
    action,
    target,
    risk: { severity: "high", fingerprint: "filesystem.write:v1" },
    binding: {
      principalId: "principal:alice",
      accountId: "account:primary",
      projectId: "project:prime",
      sessionId: "session:7",
      policyId: "policy:desktop",
      epoch: 3,
    },
    evidence: grantEvidence(action, target),
    issuedAt: 1_000,
    expiresAt: 2_000,
  };
};

const validAttemptInput = (): CapabilityAttempt => {
  const grant = validGrantInput();
  return {
    id: "attempt:base",
    grantId: grant.id,
    scope: grant.scope,
    action: grant.action,
    target: grant.target,
    risk: grant.risk,
    binding: grant.binding,
    evidence: attemptEvidence(grant.action, grant.target),
  };
};

describe("approval capability contract", () => {
  it("retains an exact account identifier in the authority binding", () => {
    const base = validGrantInput();
    const input = {
      ...base,
      binding: { ...base.binding, accountId: "account:primary" },
    } as CapabilityGrant & { binding: CapabilityGrant["binding"] & { accountId: string } };

    const snapshot = createCapabilityGrant(input);

    expect(snapshot.binding).toMatchObject({ accountId: "account:primary" });
  });

  it("freezes verified adapter evidence for one exact action, target, and argument digest", () => {
    const evidence = adapterAuthority.mint.grantEvidence({
      adapterId: "adapter:desktop",
      adapterVersion: "1",
      action: "file",
      candidateTarget: { action: "file", value: "C:\\repo\\release.txt" },
      canonicalArguments: "abc",
    });

    expect(evidence).toEqual({
      kind: "verified-adapter-evidence",
      phase: "grant",
      adapterId: "adapter:desktop",
      adapterVersion: "1",
      action: "file",
      target: { action: "file", value: "C:\\repo\\release.txt" },
      argumentsDigest: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect([Object.isFrozen(evidence), Object.isFrozen(evidence.target)]).toEqual([true, true]);
    expect(() =>
      adapterAuthority.mint.grantEvidence({
        adapterId: "adapter:desktop",
        adapterVersion: "1",
        action: "shell",
        candidateTarget: evidence.target,
        canonicalArguments: "abc",
      }),
    ).toThrow(/evidence.*action/i);
  });

  it("binds grants to verified adapter evidence rather than a bare caller digest", () => {
    const base = validGrantInput();
    const snapshot = createCapabilityGrant(base);

    expect(snapshot).toMatchObject({ evidence: base.evidence });
    expect(snapshot).not.toHaveProperty("argumentsDigest");
  });

  it("rejects unverified or claim-mismatched adapter evidence at the contract boundary", () => {
    const base = validGrantInput();
    const unverified = {
      ...base.evidence,
    } as unknown as VerifiedGrantEvidence;

    expect(() => createCapabilityGrant({ ...base, evidence: unverified })).toThrow(
      /evidence.*verified/i,
    );
    expect(() =>
      createCapabilityGrant({
        ...base,
        evidence: grantEvidence("file", { action: "file", value: "C:\\repo\\other.txt" }),
      }),
    ).toThrow(/evidence.*exact action and target/i);
  });

  it("enumerates every executable action category and no implicit catch-all", () => {
    expect(CAPABILITY_ACTIONS).toEqual([
      "file",
      "shell",
      "network",
      "browser",
      "computer",
      "credentials",
      "messages",
      "download",
      "upload",
      "git",
      "package",
      "process",
    ]);
  });

  it("keeps targets action-qualified and byte-exact instead of broadening them", () => {
    const exact = "HTTPS://example.test/a/../Admin";

    expect(CAPABILITY_ACTIONS.map((action) => normalizeTarget(action, exact))).toEqual(
      CAPABILITY_ACTIONS.map((action) => ({ action, value: exact })),
    );
    expect(normalizeTarget("file", "C:\\Repo\\File.txt")).not.toEqual(
      normalizeTarget("file", "c:\\repo\\file.txt"),
    );
    expect(normalizeTarget("browser", "https://example.test/a/../admin")).not.toEqual(
      normalizeTarget("browser", "https://example.test/admin"),
    );
  });

  it("rejects targets that cannot name one exact resource", () => {
    for (const action of CAPABILITY_ACTIONS) {
      expect(() => normalizeTarget(action, "")).toThrow(/target/i);
      expect(() => normalizeTarget(action, "host\0smuggled")).toThrow(/target/i);
      expect(() => normalizeTarget(action, "*")).toThrow(/target/i);
      expect(() => normalizeTarget(action, `exact:${action}:*`)).toThrow(/target/i);
    }
    expect(() => normalizeTarget("wildcard" as CapabilityAction, "exact"))
      .toThrow(/action/i);
  });

  it("recomputes SHA-256 from canonical immutable arguments", () => {
    const target = { action: "file" as const, value: "C:\\repo\\release.txt" };
    const first = grantEvidence("file", target, "first");
    const second = grantEvidence("file", target, "second");

    expect(first.argumentsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.argumentsDigest).not.toBe(second.argumentsDigest);
    expect(() =>
      adapterAuthority.mint.grantEvidence({
        adapterId: "adapter:desktop",
        adapterVersion: "1",
        action: "file",
        candidateTarget: target,
        canonicalArguments: {} as unknown as string,
      }),
    ).toThrow(/canonical arguments/i);
  });

  it("calls the concrete target validator once and rejects its wildcard result", () => {
    let validations = 0;

    const wildcardAuthority = createTrustedAdapterAuthority([{
      adapterId: "adapter:wildcard",
      adapterVersion: "1",
      action: "file",
      validateTarget: () => {
        validations += 1;
        return { action: "file", value: "C:\\repo\\*" };
      },
    }]);
    expect(() =>
      wildcardAuthority.mint.grantEvidence({
        adapterId: "adapter:wildcard",
        adapterVersion: "1",
        action: "file",
        candidateTarget: { path: "C:\\repo\\*" },
        canonicalArguments: "{}",
      }),
    ).toThrow(/target/i);
    expect(validations).toBe(1);
  });

  it("snapshots and freezes every authority-bearing grant field", () => {
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
    const adapterEvidence = grantEvidence("file", target);

    const grant = createCapabilityGrant({
      id: "grant:7",
      approvalId: "approval:7",
      scope: "once",
      action: "file",
      target,
      risk,
      binding,
      evidence: adapterEvidence,
      issuedAt: 1_000,
      expiresAt: 2_000,
    });

    target.value = "C:\\repo\\broader";
    risk.fingerprint = "filesystem.any:v1";
    binding.epoch = 99;

    expect(grant).toEqual({
      id: "grant:7",
      approvalId: "approval:7",
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
      evidence: adapterEvidence,
      issuedAt: 1_000,
      expiresAt: 2_000,
    });
    expect([
      Object.isFrozen(grant),
      Object.isFrozen(grant.target),
      Object.isFrozen(grant.risk),
      Object.isFrozen(grant.binding),
      Object.isFrozen(grant.evidence),
      Object.isFrozen(grant.evidence.target),
    ]).toEqual([true, true, true, true, true, true]);
  });

  it("rejects malformed or internally inconsistent grants", () => {
    const base = validGrantInput();

    expect(() =>
      createCapabilityGrant({ ...base, target: { action: "shell", value: base.target.value } }),
    ).toThrow(/action/i);
    expect(() =>
      createCapabilityGrant({ ...base, target: { action: "file", value: "" } }),
    ).toThrow(/target/i);
    expect(() =>
      createCapabilityGrant({ ...base, risk: { ...base.risk, fingerprint: "" } }),
    ).toThrow(/risk/i);
    expect(() =>
      createCapabilityGrant({
        ...base,
        binding: { ...base.binding, principalId: "" },
      }),
    ).toThrow(/binding/i);
    expect(() =>
      createCapabilityGrant({ ...base, binding: { ...base.binding, epoch: -1 } }),
    ).toThrow(/epoch/i);
    expect(() => createCapabilityGrant({ ...base, expiresAt: base.issuedAt })).toThrow(/expiry/i);
    expect(() =>
      createCapabilityGrant({
        ...base,
        binding: { ...base.binding, accountId: "" },
      }),
    ).toThrow(/binding/i);
  });

  it("snapshots an attempt so later argument-object mutations cannot change its claim", () => {
    const input = validAttemptInput();
    const original = input.target.value;

    const attempt = createCapabilityAttempt(input);
    (input.target as { value: string }).value = "C:\\repo\\broader";

    expect(attempt.target.value).toBe(original);
    expect(attempt.evidence.argumentsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect([
      Object.isFrozen(attempt),
      Object.isFrozen(attempt.target),
      Object.isFrozen(attempt.risk),
      Object.isFrozen(attempt.binding),
    ]).toEqual([true, true, true, true]);
  });

  it("rejects grant-phase evidence when replayed as attempt evidence", () => {
    const grant = validGrantInput();
    const rawAttempt = {
      ...validAttemptInput(),
      evidence: grant.evidence,
    } as unknown as CapabilityAttempt;

    expect(() => createCapabilityAttempt(rawAttempt)).toThrow(/phase|attempt.*evidence/i);
  });

  it("rejects evidence from another registry and same-phase claim replay", () => {
    const foreignAuthority = createTrustedAdapterAuthority([{
      adapterId: "adapter:desktop",
      adapterVersion: "1",
      action: "file",
      validateTarget: (candidate) => candidate as CapabilityTarget<"file">,
    }]);
    const base = validGrantInput();
    const foreignEvidence = foreignAuthority.mint.grantEvidence({
      adapterId: "adapter:desktop",
      adapterVersion: "1",
      action: "file",
      candidateTarget: base.target,
      canonicalArguments: "canonical-arguments:b",
    });

    expect(() =>
      createCapabilityGrant({ ...base, evidence: foreignEvidence }),
    ).toThrow(/not verified/i);

    const sealed = createCapabilityGrant(base);
    expect(() =>
      createCapabilityGrant({
        ...sealed,
        id: "grant:replayed",
        approvalId: "approval:replayed",
      }),
    ).toThrow(/replayed|different.*claim/i);
  });

  it("rejects mutable string-like objects in every authority-bearing string field", () => {
    const stringLike = {
      trim() {
        return this;
      },
      includes() {
        return false;
      },
      toString() {
        return `sha256:${"a".repeat(64)}`;
      },
    } as unknown as string;
    const base = validGrantInput();

    expect(() => normalizeTarget("file", stringLike)).toThrow(/target/i);
    expect(() =>
      adapterAuthority.mint.grantEvidence({
        adapterId: "adapter:desktop",
        adapterVersion: "1",
        action: "file",
        candidateTarget: base.target,
        canonicalArguments: stringLike,
      }),
    ).toThrow(/canonical arguments/i);
    expect(() => createCapabilityGrant({ ...base, id: stringLike })).toThrow(/id/i);
    expect(() =>
      createCapabilityGrant({ ...base, risk: { ...base.risk, fingerprint: stringLike } }),
    ).toThrow(/risk/i);
    expect(() =>
      createCapabilityGrant({
        ...base,
        binding: { ...base.binding, principalId: stringLike },
      }),
    ).toThrow(/binding/i);
  });

  it("snapshots accessor-backed fields once before validating them", () => {
    const input = { ...validGrantInput() };
    let actionReads = 0;
    Object.defineProperty(input, "action", {
      enumerable: true,
      get: () => (++actionReads === 1 ? "file" : "shell"),
    });

    const snapshot = createCapabilityGrant(input);

    expect(actionReads).toBe(1);
    expect(snapshot.action).toBe("file");
    expect(snapshot.target.action).toBe("file");
  });
});
