import { describe, expect, it } from "vitest";

import * as publicBrowser from "./index";
import * as nativeBrowserAuthorityModule from "./native-authority";
import { hmacSha256Digest, sha256Digest } from "./digest";
import {
  browserActionDigest,
  browserDecisionScopeDigest,
  browserIntentDigest,
  browserPolicyDigest,
  browserWorkerObservationDigest,
} from "./policy";
import type { BrowserAction, BrowserCapabilityIntent, BrowserPolicy, BrowserPolicyContext, BrowserWorkerObservation } from "./types";
import { createBrowserAuthorityTestHarness } from "./native-authority.test-harness";
import { canonicalBrowserJson, decodeBrowserTransport, type BrowserJsonValue } from "./transport";

const binding = { accountId: "account-1", projectId: "project-1" } as const;
const profile = { profileId: "profile-1", mode: "isolated", ...binding } as const;
const target = { sessionId: "session-1", tabId: "tab-1", targetId: "target-1", epoch: 3 } as const;

function requestedUrl(action: BrowserAction): string | undefined {
  switch (action.type) {
    case "navigate": case "download": case "upload": case "popup": case "frame": return action.url;
    case "redirect": return action.toUrl;
    default: return undefined;
  }
}

function authorizationPayload(
  action: BrowserAction = { type: "navigate", url: "https://example.com/next" },
  policy: BrowserPolicy = { allowNavigation: true, allowedOrigins: ["https://example.com"] },
) {
  const intent: BrowserCapabilityIntent = {
    intentId: "intent-1",
    principalId: "principal-1",
    actor: "agent",
    requestedAtMs: 100,
    binding,
    profile,
    target,
    policyEpoch: 7,
    approvalEpoch: 11,
    action,
  };
  const observation: BrowserWorkerObservation = {
    observationId: "observation_0123456789abcdef0123456789abcdef",
    actionType: action.type,
    target,
    profile,
    trustedMode: "untrusted",
    observedAtMs: 175,
    documentId: "document_0123456789abcdef0123456789abcdef",
    navigationId: "navigation_0123456789abcdef0123456789abcdef",
    frameId: "frame_0123456789abcdef0123456789abcdef",
    currentUrl: "https://example.com/current",
    currentOrigin: { scheme: "https", host: "example.com", port: 443 },
    ...(requestedUrl(action) === undefined ? {} : { requestedUrl: requestedUrl(action) }),
    preStateDigest: `sha256:${"5".repeat(64)}`,
    dns: [{
      resolutionId: "dns_0123456789abcdef0123456789abcdef",
      host: "example.com",
      addresses: ["203.0.113.10"],
      resolvedAtMs: 160,
      expiresAtMs: 250,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
    }],
    brokerEpoch: 5,
    workerEpoch: 7,
    readinessEpoch: 9,
  };
  const context: BrowserPolicyContext = {
    binding,
    principalId: intent.principalId,
    target,
    policy,
    policyEpoch: intent.policyEpoch,
    approvalEpoch: intent.approvalEpoch,
    trustedMode: "untrusted",
    nowMs: 200,
    brokerEvidence: {
      evidenceId: "evidence_0123456789abcdef0123456789abcdef",
      decisionId: "decision_0123456789abcdef0123456789abcdef",
      leaseId: "lease_0123456789abcdef0123456789abcdef",
      intentDigest: browserIntentDigest(intent),
      actionDigest: browserActionDigest(intent.action),
      policyDigest: browserPolicyDigest(policy),
      observationDigest: browserWorkerObservationDigest(observation),
      issuedAtMs: 180,
      expiresAtMs: 240,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
    },
    workerObservation: observation,
    // A hostile caller snapshot: the authority must overwrite this with its closure state.
    approvalState: {
      revision: 99,
      grants: [],
      consumedApprovalIds: [],
      revokedApprovalIds: [],
      activeLeases: [],
      consumedLeaseIds: [],
      consumedUploadCapabilityIds: [],
    },
    brokerEpoch: 5,
    workerEpoch: 7,
    readinessEpoch: 9,
  };
  return { intent, context, observation };
}

describe("native browser authority", () => {
  it("uses standard HMAC-SHA-256 for keyed native evidence", () => {
    expect(hmacSha256Digest("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "sha256:f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("does not export a plain-JavaScript authority mint", () => {
    expect("decideBrowserIntent" in publicBrowser).toBe(false);
    expect("consumeBrowserExecutionLease" in publicBrowser).toBe(false);
    expect("createNativeBrowserAuthority" in publicBrowser).toBe(false);
    expect("createBrowserAuthorityTestHarness" in publicBrowser).toBe(false);
    expect("createNativeBrowserAuthority" in nativeBrowserAuthorityModule).toBe(false);
    expect(nativeBrowserAuthorityModule.nativeBrowserAuthority).toBeNull();
  });

  it("bounds raw evidence before authentication and treats native boundary failures as invalid", () => {
    let authenticationCalls = 0;
    const oversizedHarness = createBrowserAuthorityTestHarness("test-secret", {
      beforeAuthenticate: () => { authenticationCalls += 1; },
    });
    const oversized = `{"padding":"${"a".repeat(262_145)}"}`;
    expect(oversizedHarness.authority.authorize(oversized, 0)).toMatchObject({
      accepted: false,
      reason: "invalid-native-evidence",
    });
    expect(authenticationCalls).toBe(0);

    const throwingHarness = createBrowserAuthorityTestHarness("test-secret", {
      beforeAuthenticate: () => { throw new Error("native boundary failed"); },
    });
    expect(() => throwingHarness.authority.authorize("{}", 0)).not.toThrow();
    expect(throwingHarness.authority.authorize("{}", 0)).toMatchObject({
      accepted: false,
      reason: "invalid-native-evidence",
    });
  });

  it("never reflects on an authenticator-returned proxy or accepts it as evidence", () => {
    let reflected = false;
    const hostile = new Proxy({}, {
      get: () => {
        reflected = true;
        throw new Error("must not read native objects");
      },
      has: () => {
        reflected = true;
        throw new Error("must not inspect native objects");
      },
      ownKeys: () => {
        reflected = true;
        throw new Error("must not enumerate native objects");
      },
    });
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      authenticatedResult: () => hostile,
    });
    const payload = authorizationPayload();
    const evidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    let result: ReturnType<typeof harness.authority.authorize> | undefined;

    expect(() => { result = harness.authority.authorize(evidence, 0); }).not.toThrow();
    expect(result).toMatchObject({ accepted: false, reason: "invalid-native-evidence", revision: 0 });
    expect(reflected).toBe(false);
  });

  it("rejects raw, unsigned, and wrong-key evidence", () => {
    const first = createBrowserAuthorityTestHarness("test-secret-one");
    const second = createBrowserAuthorityTestHarness("test-secret-two");
    const payload = authorizationPayload();
    const authorizePayload = { intent: payload.intent, context: payload.context };
    const signed = first.mint("authorize", authorizePayload, 190);
    const unsigned = JSON.stringify({
      kind: "authorize",
      evidenceId: "unsigned_0123456789abcdef0123456789abcdef",
      observedAtMs: 190,
      payload: authorizePayload,
      tag: `sha256:${"0".repeat(64)}`,
    });

    expect(first.authority.authorize(payload as never, 0)).toMatchObject({ accepted: false, reason: "invalid-native-evidence" });
    expect(first.authority.authorize(unsigned, 0)).toMatchObject({ accepted: false, reason: "invalid-native-evidence" });
    expect(second.authority.authorize(signed, 0)).toMatchObject({ accepted: false, reason: "invalid-native-evidence" });
  });

  it("owns state and atomically authorizes one lease for one revision", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const payload = authorizationPayload();
    const evidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);

    const first = harness.authority.authorize(evidence, 0);
    expect(first).toMatchObject({
      accepted: true,
      reason: "authorized",
      revision: 1,
      leaseId: "lease_0123456789abcdef0123456789abcdef",
    });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 1,
      activeLeaseIds: ["lease_0123456789abcdef0123456789abcdef"],
    });
    expect(harness.authority.authorize(evidence, 0)).toMatchObject({
      accepted: false,
      reason: "stale-authority-revision",
      revision: 1,
    });
    expect(harness.authority.authorize(evidence, 1)).toMatchObject({
      accepted: false,
      reason: "native-evidence-replayed",
      revision: 1,
    });
  });

  it("atomically consumes an owned lease and starts one exact attempt", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190), 0);
    expect(authorized.accepted).toBe(true);
    const startEvidence = harness.mint("start", {
      leaseId: "lease_0123456789abcdef0123456789abcdef",
      attemptId: "attempt_0123456789abcdef0123456789abcdef",
      observation: payload.observation,
      startedAtMs: 201,
    }, 201);

    expect(harness.authority.start(startEvidence, 1)).toMatchObject({
      accepted: true,
      reason: "started",
      revision: 2,
      attemptId: "attempt_0123456789abcdef0123456789abcdef",
    });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 2,
      activeLeaseIds: [],
      activeAttemptIds: ["attempt_0123456789abcdef0123456789abcdef"],
    });
    expect(harness.authority.start(startEvidence, 1)).toMatchObject({
      accepted: false,
      reason: "stale-authority-revision",
      revision: 2,
    });
    expect(harness.authority.start(startEvidence, 2)).toMatchObject({
      accepted: false,
      reason: "native-evidence-replayed",
      revision: 2,
    });
  });

  it("requires authenticated completion evidence bound to the exact lease, attempt, scope, and epochs", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190), 0);
    const startEvidence = harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId: "attempt_0123456789abcdef0123456789abcdef",
      observation: payload.observation,
      startedAtMs: 201,
    }, 201);
    expect(harness.authority.start(startEvidence, 1).accepted).toBe(true);
    const common = {
      attemptId: "attempt_0123456789abcdef0123456789abcdef",
      leaseId: authorized.leaseId,
      decisionId: payload.context.brokerEvidence.decisionId,
      actionDigest: payload.context.brokerEvidence.actionDigest,
      scopeDigest: browserDecisionScopeDigest({
        principalId: payload.intent.principalId,
        binding,
        profile,
        target,
        trustedMode: "untrusted",
        policyEpoch: 7,
        approvalEpoch: 11,
        policyDigest: payload.context.brokerEvidence.policyDigest,
        observationDigest: payload.context.brokerEvidence.observationDigest,
        brokerEpoch: 5,
        workerEpoch: 7,
        readinessEpoch: 9,
      }),
      target,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
      status: "succeeded",
      completedAtMs: 220,
      navigation: {
        finalObservation: {
          ...payload.observation,
          observationId: "final_observation_0123456789abcdef0123456789abcdef",
          observedAtMs: 219,
          documentId: "final_document_0123456789abcdef0123456789abcdef",
          navigationId: "final_navigation_0123456789abcdef0123456789abcdef",
          currentUrl: "https://example.com/next",
          preStateDigest: `sha256:${"6".repeat(64)}`,
        },
        redirectChain: [],
      },
    };

    expect(harness.authority.complete(harness.mint("complete", { ...common, attemptId: "attempt_wrong_0123456789abcdef0123456789abcdef" }, 220), 2))
      .toMatchObject({ accepted: false, reason: "attempt-not-owned", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", { ...common, workerEpoch: 8 }, 220), 2))
      .toMatchObject({ accepted: false, reason: "completion-binding-mismatch", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", {
      ...common,
      navigation: {
        ...common.navigation,
        finalObservation: { ...common.navigation.finalObservation, dns: [] },
      },
    }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", {
      ...common,
      navigation: {
        ...common.navigation,
        finalObservation: { ...common.navigation.finalObservation, observedAtMs: 200 },
      },
    }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", {
      ...common,
      navigation: {
        ...common.navigation,
        finalObservation: { ...common.navigation.finalObservation, observedAtMs: 221 },
      },
    }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", {
      ...common,
      navigation: {
        ...common.navigation,
        finalObservation: {
          ...common.navigation.finalObservation,
          profile: { ...common.navigation.finalObservation.profile, accountId: "different-account" },
        },
      },
    }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    expect(harness.authority.complete(harness.mint("complete", {
      ...common,
      navigation: {
        ...common.navigation,
        finalObservation: { ...common.navigation.finalObservation, requestedUrl: "https://example.com/wrong" },
      },
    }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });

    const completionEvidence = harness.mint("complete", common, 220);
    expect(harness.authority.complete(completionEvidence, 2)).toMatchObject({
      accepted: true,
      reason: "completed",
      revision: 3,
      attemptId: common.attemptId,
    });
    expect(harness.authority.snapshot()).toMatchObject({ revision: 3, activeAttemptIds: [] });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual([
      "requested", "decision", "leased", "running", "terminal",
    ]);
    expect(harness.authority.snapshot().ledger.map((entry) => entry.status)).toEqual([
      "requested", "allowed", "leased", "running", "succeeded",
    ]);
    const decodedCompletion = decodeBrowserTransport(completionEvidence) as Record<string, BrowserJsonValue>;
    const { tag: _tag, ...authenticatedCompletion } = decodedCompletion;
    const ledger = harness.authority.snapshot().ledger;
    const terminal = ledger[ledger.length - 1]!;
    expect(terminal.completionDigest).toBe(
      sha256Digest(canonicalBrowserJson(authenticatedCompletion as BrowserJsonValue)),
    );
    expect(harness.verifyLedger()).toBe(true);
    expect(harness.verifyLedger(ledger.map((entry) => entry.phase === "terminal"
      ? { ...entry, completionDigest: `sha256:${"0".repeat(64)}` }
      : entry))).toBe(false);
  });

  it("rejects same-tab popup completion and requires a distinct top-level popup target", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const popupUrl = "https://example.com/popup";
    const payload = authorizationPayload(
      { type: "popup", openerUrl: "https://example.com/current", url: popupUrl },
      { allowPopups: true, allowedPopupOrigins: ["https://example.com"] },
    );
    const authorized = harness.authority.authorize(
      harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190),
      0,
    );
    expect(authorized.accepted).toBe(true);
    const attemptId = "popup_attempt_0123456789abcdef0123456789abcdef";
    expect(harness.authority.start(harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId,
      observation: payload.observation,
      startedAtMs: 201,
    }, 201), 1).accepted).toBe(true);

    const popupTarget = {
      sessionId: target.sessionId,
      tabId: "popup-tab-1",
      targetId: "popup-target-1",
      epoch: 0,
    } as const;
    const completion = {
      attemptId,
      leaseId: authorized.leaseId,
      decisionId: payload.context.brokerEvidence.decisionId,
      actionDigest: payload.context.brokerEvidence.actionDigest,
      scopeDigest: browserDecisionScopeDigest({
        principalId: payload.intent.principalId,
        binding,
        profile,
        target,
        trustedMode: "untrusted",
        policyEpoch: 7,
        approvalEpoch: 11,
        policyDigest: payload.context.brokerEvidence.policyDigest,
        observationDigest: payload.context.brokerEvidence.observationDigest,
        brokerEpoch: 5,
        workerEpoch: 7,
        readinessEpoch: 9,
      }),
      target,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
      status: "succeeded",
      completedAtMs: 220,
      navigation: {
        popupTarget,
        finalObservation: {
          ...payload.observation,
          observationId: "popup_observation_0123456789abcdef0123456789abcdef",
          target: popupTarget,
          observedAtMs: 219,
          documentId: "popup_document_0123456789abcdef0123456789abcdef",
          navigationId: "popup_navigation_0123456789abcdef0123456789abcdef",
          frameId: "popup_frame_0123456789abcdef0123456789abcdef",
          currentUrl: popupUrl,
          requestedUrl: popupUrl,
          preStateDigest: `sha256:${"6".repeat(64)}`,
        },
        redirectChain: [],
      },
    } as const;

    for (const sameTabTarget of [target, { ...target, epoch: target.epoch + 1 }]) {
      expect(harness.authority.complete(harness.mint("complete", {
        ...completion,
        navigation: {
          ...completion.navigation,
          popupTarget: sameTabTarget,
          finalObservation: { ...completion.navigation.finalObservation, target: sameTabTarget },
        },
      }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    }

    for (const finalObservation of [
      { ...completion.navigation.finalObservation, documentId: payload.observation.documentId },
      { ...completion.navigation.finalObservation, frameId: payload.observation.frameId },
      { ...completion.navigation.finalObservation, navigationId: payload.observation.navigationId },
      { ...completion.navigation.finalObservation, parentFrameId: payload.observation.frameId },
      {
        ...completion.navigation.finalObservation,
        dns: [
          ...completion.navigation.finalObservation.dns,
          {
            ...completion.navigation.finalObservation.dns[0],
            resolutionId: "duplicate_dns_0123456789abcdef0123456789abcdef",
          },
        ],
      },
    ]) {
      expect(harness.authority.complete(harness.mint("complete", {
        ...completion,
        navigation: { ...completion.navigation, finalObservation },
      }, 220), 2)).toMatchObject({ accepted: false, reason: "completion-proof-invalid", revision: 2 });
    }

    expect(harness.authority.complete(harness.mint("complete", completion, 220), 2)).toMatchObject({
      accepted: true,
      reason: "completed",
      revision: 3,
      attemptId,
    });
  });

  it("requires worker-proved capture output and redactor evidence for sensitive capture", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const payload = authorizationPayload(
      { type: "screenshot", pageUrl: "https://example.com/current", target: "viewport", redaction: "sensitive" },
      { allowScreenshots: true, allowedOrigins: ["https://example.com"], sensitiveOrigins: ["https://example.com"] },
    );
    const authorized = harness.authority.authorize(harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190), 0);
    expect(authorized.accepted).toBe(true);
    expect(harness.authority.start(harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId: "capture_attempt_0123456789abcdef0123456789abcdef",
      observation: payload.observation,
      startedAtMs: 201,
    }, 201), 1).accepted).toBe(true);
    const completion = {
      attemptId: "capture_attempt_0123456789abcdef0123456789abcdef",
      leaseId: authorized.leaseId,
      decisionId: payload.context.brokerEvidence.decisionId,
      actionDigest: payload.context.brokerEvidence.actionDigest,
      scopeDigest: browserDecisionScopeDigest({
        principalId: payload.intent.principalId, binding, profile, target, trustedMode: "untrusted",
        policyEpoch: 7, approvalEpoch: 11,
        policyDigest: payload.context.brokerEvidence.policyDigest,
        observationDigest: payload.context.brokerEvidence.observationDigest,
        brokerEpoch: 5, workerEpoch: 7, readinessEpoch: 9,
      }),
      target, brokerEpoch: 5, workerEpoch: 7, readinessEpoch: 9,
      status: "succeeded", completedAtMs: 220,
      capture: {
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
        outputDigest: `sha256:${"7".repeat(64)}`,
        classification: "sensitive_redacted",
        redactionApplied: true,
        persistence: "ephemeral",
      },
    };
    expect(harness.authority.complete(harness.mint("complete", completion, 220), 2))
      .toMatchObject({ accepted: false, reason: "capture-proof-invalid", revision: 2 });
    const withProof = {
      ...completion,
      capture: {
        ...completion.capture,
        redactor: {
          redactorId: "redactor_0123456789abcdef0123456789abcdef",
          version: "1.0.0",
          proofDigest: `sha256:${"8".repeat(64)}`,
        },
      },
    };
    expect(harness.authority.complete(harness.mint("complete", withProof, 220), 2))
      .toMatchObject({ accepted: true, reason: "completed", revision: 3 });
  });

  it("records denied decisions only after their request and consumes the authority revision", () => {
    const harness = createBrowserAuthorityTestHarness("test-secret");
    const payload = authorizationPayload({ type: "navigate", url: "https://example.com/next" }, {});
    const evidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    expect(harness.authority.authorize(evidence, 0)).toMatchObject({ accepted: false, status: "denied", revision: 1 });
    const ledger = harness.authority.snapshot().ledger;
    expect(ledger.map((entry) => [entry.phase, entry.status, entry.atMs])).toEqual([
      ["requested", "requested", 100],
      ["decision", "denied", 180],
    ]);
    expect(ledger[1]?.intentId).toBe(ledger[0]?.intentId);
    expect(harness.verifyLedger()).toBe(true);
    expect(harness.authority.authorize(evidence, 0)).toMatchObject({ reason: "stale-authority-revision", revision: 1 });
  });

  it("rolls back a failed authorization ledger chain without burning its evidence", () => {
    let chainCall = 0;
    let failChainAt = 2;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeChain: () => {
        chainCall += 1;
        if (chainCall === failChainAt) throw new Error("native ledger chain failed");
      },
    });
    const payload = authorizationPayload();
    const evidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    let failed: ReturnType<typeof harness.authority.authorize> | undefined;

    expect(() => { failed = harness.authority.authorize(evidence, 0); }).not.toThrow();
    expect(failed).toMatchObject({ accepted: false, reason: "invalid-native-evidence", revision: 0 });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 0,
      activeLeaseIds: [],
      activeAttemptIds: [],
      ledger: [],
    });

    chainCall = 0;
    failChainAt = Number.POSITIVE_INFINITY;
    expect(harness.authority.authorize(evidence, 0)).toMatchObject({
      accepted: true,
      reason: "authorized",
      revision: 1,
    });
  });

  it("rolls back a failed start ledger chain without consuming its lease or evidence", () => {
    let failChain = false;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeChain: () => {
        if (failChain) throw new Error("native ledger chain failed");
      },
    });
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(
      harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190),
      0,
    );
    const attemptId = "chain_attempt_0123456789abcdef0123456789abcdef";
    const evidence = harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId,
      observation: payload.observation,
      startedAtMs: 201,
    }, 201);
    failChain = true;
    let failed: ReturnType<typeof harness.authority.start> | undefined;

    expect(() => { failed = harness.authority.start(evidence, 1); }).not.toThrow();
    expect(failed).toMatchObject({ accepted: false, reason: "invalid-native-evidence", revision: 1 });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 1,
      activeLeaseIds: [authorized.leaseId],
      activeAttemptIds: [],
    });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual(["requested", "decision", "leased"]);

    failChain = false;
    expect(harness.authority.start(evidence, 1)).toMatchObject({
      accepted: true,
      reason: "started",
      revision: 2,
      attemptId,
    });
  });

  it("rolls back a failed completion ledger chain without consuming its attempt or evidence", () => {
    let failChain = false;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeChain: () => {
        if (failChain) throw new Error("native ledger chain failed");
      },
    });
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(
      harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190),
      0,
    );
    const attemptId = "chain_attempt_0123456789abcdef0123456789abcdef";
    expect(harness.authority.start(harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId,
      observation: payload.observation,
      startedAtMs: 201,
    }, 201), 1).accepted).toBe(true);
    const evidence = harness.mint("complete", {
      attemptId,
      leaseId: authorized.leaseId,
      decisionId: payload.context.brokerEvidence.decisionId,
      actionDigest: payload.context.brokerEvidence.actionDigest,
      scopeDigest: browserDecisionScopeDigest({
        principalId: payload.intent.principalId,
        binding,
        profile,
        target,
        trustedMode: "untrusted",
        policyEpoch: 7,
        approvalEpoch: 11,
        policyDigest: payload.context.brokerEvidence.policyDigest,
        observationDigest: payload.context.brokerEvidence.observationDigest,
        brokerEpoch: 5,
        workerEpoch: 7,
        readinessEpoch: 9,
      }),
      target,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
      status: "failed",
      completedAtMs: 220,
      lastError: "worker failed",
    }, 220);
    failChain = true;
    let failed: ReturnType<typeof harness.authority.complete> | undefined;

    expect(() => { failed = harness.authority.complete(evidence, 2); }).not.toThrow();
    expect(failed).toMatchObject({ accepted: false, reason: "invalid-native-evidence", revision: 2 });
    expect(harness.authority.snapshot()).toMatchObject({ revision: 2, activeAttemptIds: [attemptId] });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual([
      "requested", "decision", "leased", "running",
    ]);

    failChain = false;
    expect(harness.authority.complete(evidence, 2)).toMatchObject({
      accepted: true,
      reason: "completed",
      revision: 3,
      attemptId,
    });
  });

  it("rejects authority reentry while ledger tags are being chained", () => {
    let reenter: (() => void) | undefined;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeChain: () => {
        const callback = reenter;
        reenter = undefined;
        callback?.();
      },
    });
    const payload = authorizationPayload({ type: "navigate", url: "https://example.com/next" }, {});
    const innerEvidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    const outerEvidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    let innerResult: ReturnType<typeof harness.authority.authorize> | undefined;
    reenter = () => { innerResult = harness.authority.authorize(innerEvidence, 0); };

    const outerResult = harness.authority.authorize(outerEvidence, 0);

    expect(innerResult).toMatchObject({ accepted: false, reason: "stale-authority-revision", revision: 0 });
    expect(outerResult).toMatchObject({ accepted: false, status: "denied", revision: 1 });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual(["requested", "decision"]);
    expect(harness.verifyLedger()).toBe(true);
  });

  it("rechecks the authorize revision after reentrant native authentication", () => {
    let reenter: (() => void) | undefined;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeAuthenticate: () => {
        const callback = reenter;
        reenter = undefined;
        callback?.();
      },
    });
    const payload = authorizationPayload();
    const innerEvidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    const outerEvidence = harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190);
    let innerResult: ReturnType<typeof harness.authority.authorize> | undefined;
    reenter = () => { innerResult = harness.authority.authorize(innerEvidence, 0); };

    const outerResult = harness.authority.authorize(outerEvidence, 0);

    expect(innerResult).toMatchObject({ accepted: true, reason: "authorized", revision: 1 });
    expect(outerResult).toMatchObject({ accepted: false, reason: "stale-authority-revision", revision: 1 });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 1,
      activeLeaseIds: ["lease_0123456789abcdef0123456789abcdef"],
    });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual(["requested", "decision", "leased"]);
  });

  it("rechecks the start revision after reentrant native authentication", () => {
    let reenter: (() => void) | undefined;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeAuthenticate: () => {
        const callback = reenter;
        reenter = undefined;
        callback?.();
      },
    });
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(
      harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190),
      0,
    );
    const denied = authorizationPayload({ type: "navigate", url: "https://example.com/next" }, {});
    const innerEvidence = harness.mint("authorize", { intent: denied.intent, context: denied.context }, 190);
    const outerEvidence = harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId: "outer_attempt_0123456789abcdef0123456789abcdef",
      observation: payload.observation,
      startedAtMs: 201,
    }, 201);
    let innerResult: ReturnType<typeof harness.authority.authorize> | undefined;
    reenter = () => { innerResult = harness.authority.authorize(innerEvidence, 1); };

    const outerResult = harness.authority.start(outerEvidence, 1);

    expect(innerResult).toMatchObject({ accepted: false, status: "denied", revision: 2 });
    expect(outerResult).toMatchObject({ accepted: false, reason: "stale-authority-revision", revision: 2 });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 2,
      activeLeaseIds: ["lease_0123456789abcdef0123456789abcdef"],
      activeAttemptIds: [],
    });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual([
      "requested", "decision", "leased", "requested", "decision",
    ]);
  });

  it("rechecks the completion revision after reentrant native authentication", () => {
    let reenter: (() => void) | undefined;
    const harness = createBrowserAuthorityTestHarness("test-secret", {
      beforeAuthenticate: () => {
        const callback = reenter;
        reenter = undefined;
        callback?.();
      },
    });
    const payload = authorizationPayload();
    const authorized = harness.authority.authorize(
      harness.mint("authorize", { intent: payload.intent, context: payload.context }, 190),
      0,
    );
    const attemptId = "outer_attempt_0123456789abcdef0123456789abcdef";
    expect(harness.authority.start(harness.mint("start", {
      leaseId: authorized.leaseId,
      attemptId,
      observation: payload.observation,
      startedAtMs: 201,
    }, 201), 1).accepted).toBe(true);
    const denied = authorizationPayload({ type: "navigate", url: "https://example.com/next" }, {});
    const innerEvidence = harness.mint("authorize", { intent: denied.intent, context: denied.context }, 190);
    const outerEvidence = harness.mint("complete", {
      attemptId,
      leaseId: authorized.leaseId,
      decisionId: payload.context.brokerEvidence.decisionId,
      actionDigest: payload.context.brokerEvidence.actionDigest,
      scopeDigest: browserDecisionScopeDigest({
        principalId: payload.intent.principalId,
        binding,
        profile,
        target,
        trustedMode: "untrusted",
        policyEpoch: 7,
        approvalEpoch: 11,
        policyDigest: payload.context.brokerEvidence.policyDigest,
        observationDigest: payload.context.brokerEvidence.observationDigest,
        brokerEpoch: 5,
        workerEpoch: 7,
        readinessEpoch: 9,
      }),
      target,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
      status: "failed",
      completedAtMs: 220,
      lastError: "worker failed",
    }, 220);
    let innerResult: ReturnType<typeof harness.authority.authorize> | undefined;
    reenter = () => { innerResult = harness.authority.authorize(innerEvidence, 2); };

    const outerResult = harness.authority.complete(outerEvidence, 2);

    expect(innerResult).toMatchObject({ accepted: false, status: "denied", revision: 3 });
    expect(outerResult).toMatchObject({ accepted: false, reason: "stale-authority-revision", revision: 3 });
    expect(harness.authority.snapshot()).toMatchObject({
      revision: 3,
      activeAttemptIds: [attemptId],
    });
    expect(harness.authority.snapshot().ledger.map((entry) => entry.phase)).toEqual([
      "requested", "decision", "leased", "running", "requested", "decision",
    ]);
  });
});
