import { describe, expect, it } from "vitest";

import {
  browserActionDigest,
  browserIntentDigest,
  browserOriginKey,
  browserPolicyDigest,
  browserWorkerObservationDigest,
  createBrowserApprovalState,
  consumeBrowserExecutionLease,
  decideBrowserIntent,
  decodeBrowserAction,
  decodeBrowserPolicyContext,
  isAllowedOrigin,
  isSafeFilename,
  normalizeBrowserOrigin,
} from "./policy";
import type {
  BrowserApprovalGrant,
  BrowserCapabilityIntent,
  BrowserPolicy,
  BrowserPolicyContext,
  BrowserWorkerObservation,
} from "./types";

const binding = { accountId: "account-1", projectId: "project-1" } as const;
const target = { sessionId: "session-1", tabId: "tab-1", targetId: "target-1", epoch: 3 } as const;

function makeIntent(
  action: BrowserCapabilityIntent["action"],
  overrides: Partial<BrowserCapabilityIntent> = {},
): BrowserCapabilityIntent {
  return {
    intentId: "intent-1",
    principalId: "principal-1",
    actor: "agent",
    requestedAtMs: 100,
    binding,
    target,
    policyEpoch: 7,
    approvalEpoch: 11,
    profile: {
      profileId: "profile-1",
      mode: "isolated",
      accountId: binding.accountId,
      projectId: binding.projectId,
    },
    action,
    ...overrides,
  };
}

function observationFor(
  candidate: BrowserCapabilityIntent,
  overrides: Partial<BrowserWorkerObservation> = {},
): BrowserWorkerObservation {
  const action = candidate.action;
  let currentUrl = "https://example.com/current";
  let requestedUrl: string | undefined;
  switch (action.type) {
    case "navigate":
      requestedUrl = action.url;
      break;
    case "redirect":
      currentUrl = action.fromUrl;
      requestedUrl = action.toUrl;
      break;
    case "popup":
      currentUrl = action.openerUrl;
      requestedUrl = action.url;
      break;
    case "frame":
      currentUrl = action.parentUrl;
      requestedUrl = action.url;
      break;
    case "download":
    case "upload":
      requestedUrl = action.url;
      break;
    case "screenshot":
    case "selector":
    case "coordinate":
    case "clipboard":
      currentUrl = action.pageUrl;
      break;
    case "takeover":
      break;
  }
  const hosts = [...new Set([currentUrl, requestedUrl].filter((value): value is string => value !== undefined).map((value) => new URL(value).hostname))];
  return {
    observationId: "observation_0123456789abcdef0123456789abcdef",
    actionType: action.type,
    target: candidate.target,
    profile: candidate.profile,
    trustedMode: "untrusted",
    brokerEpoch: 5,
    workerEpoch: 7,
    readinessEpoch: 9,
    observedAtMs: 175,
    documentId: "document_0123456789abcdef0123456789abcdef",
    navigationId: "navigation_0123456789abcdef0123456789abcdef",
    frameId: "frame_0123456789abcdef0123456789abcdef",
    currentUrl,
    currentOrigin: normalizeBrowserOrigin(currentUrl)!,
    ...(requestedUrl === undefined ? {} : { requestedUrl }),
    preStateDigest: `sha256:${"5".repeat(64)}`,
    dns: hosts.map((host, index) => ({
      resolutionId: `dns_${String(index).padStart(2, "0")}_0123456789abcdef0123456789abcdef`,
      host,
      addresses: [`203.0.113.${10 + index}`],
      resolvedAtMs: 160,
      expiresAtMs: 250,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
    })),
    ...overrides,
  };
}

function makeContext(
  candidate: BrowserCapabilityIntent,
  policy: Partial<BrowserPolicy> = {},
  overrides: Partial<BrowserPolicyContext> = {},
): BrowserPolicyContext {
  const resolvedPolicy: BrowserPolicy = {
    allowedOrigins: ["https://example.com"],
    ...policy,
  };
  const workerObservation = overrides.workerObservation ?? observationFor(candidate, {
    target: overrides.target ?? target,
    profile: candidate.profile,
    trustedMode: overrides.trustedMode ?? "untrusted",
    brokerEpoch: overrides.brokerEpoch ?? 5,
    workerEpoch: overrides.workerEpoch ?? 7,
    readinessEpoch: overrides.readinessEpoch ?? 9,
  });
  const brokerEvidence = overrides.brokerEvidence ?? {
    evidenceId: "evidence_0123456789abcdef0123456789abcdef",
    decisionId: "decision_0123456789abcdef0123456789abcdef",
    leaseId: "lease_0123456789abcdef0123456789abcdef",
    intentDigest: browserIntentDigest(candidate),
    actionDigest: browserActionDigest(candidate.action),
    policyDigest: browserPolicyDigest(resolvedPolicy),
    observationDigest: browserWorkerObservationDigest(workerObservation),
    brokerEpoch: overrides.brokerEpoch ?? 5,
    workerEpoch: overrides.workerEpoch ?? 7,
    readinessEpoch: overrides.readinessEpoch ?? 9,
    issuedAtMs: 180,
    expiresAtMs: 240,
  };
  return {
    binding,
    principalId: "principal-1",
    target,
    policyEpoch: 7,
    approvalEpoch: 11,
    brokerEpoch: 5,
    workerEpoch: 7,
    readinessEpoch: 9,
    trustedMode: "untrusted",
    nowMs: 200,
    policy: resolvedPolicy,
    brokerEvidence,
    workerObservation,
    approvalState: createBrowserApprovalState(),
    ...overrides,
  };
}

function approvalStateFor(candidate: BrowserCapabilityIntent, policy: Partial<BrowserPolicy>) {
  const base = makeContext(candidate, policy);
  const grant: BrowserApprovalGrant = {
    approvalId: "approval_0123456789abcdef0123456789abcdef",
    intentId: candidate.intentId,
    actionDigest: base.brokerEvidence.actionDigest,
    policyDigest: base.brokerEvidence.policyDigest,
    observationDigest: base.brokerEvidence.observationDigest,
    target: candidate.target,
    profile: candidate.profile,
    trustedMode: base.trustedMode,
    principalId: candidate.principalId,
    binding: candidate.binding,
    policyEpoch: candidate.policyEpoch,
    approvalEpoch: candidate.approvalEpoch,
    brokerEpoch: base.brokerEpoch,
    workerEpoch: base.workerEpoch,
    readinessEpoch: base.readinessEpoch,
    issuedAtMs: 150,
    expiresAtMs: 230,
  };
  return createBrowserApprovalState([grant]);
}

describe("browser runtime security boundary", () => {
  it("rejects descriptor-hostile and open action objects without throwing", () => {
    const throwingGetter: Record<string, unknown> = {};
    Object.defineProperty(throwingGetter, "type", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });

    const inherited = Object.create({ type: "navigate", url: "https://example.com" });
    const decorated = { type: "navigate", url: "https://example.com", unexpected: true };
    const symbolDecorated = { type: "navigate", url: "https://example.com" } as Record<PropertyKey, unknown>;
    symbolDecorated[Symbol("hidden")] = "hidden";
    const revoked = Proxy.revocable({ type: "navigate", url: "https://example.com" }, {});
    revoked.revoke();
    const validIntent = makeIntent({ type: "navigate", url: "https://example.com" });

    for (const hostile of [throwingGetter, inherited, decorated, symbolDecorated, revoked.proxy]) {
      expect(() => decodeBrowserAction(hostile)).not.toThrow();
      expect(decodeBrowserAction(hostile)).toBeNull();
      expect(() => decideBrowserIntent(hostile, makeContext(validIntent, { allowNavigation: true }))).not.toThrow();
    }
  });

  it("uses the canonical SHA-256 action digest instead of a collision-prone local ID", () => {
    expect(browserActionDigest({ type: "navigate", url: "https://example.com" })).toBe(
      "sha256:b4aecc3c034116de4975afe1c76583bb14f89024adaee5cac3ee0e1a2f42b506",
    );
  });

  it("decodes known actions exhaustively and denies unknown actions without throwing", () => {
    expect(decodeBrowserAction({ type: "clipboard", pageUrl: "https://example.com", operation: "read" })).toEqual({
      type: "clipboard",
      pageUrl: "https://example.com",
      operation: "read",
    });
    expect(decodeBrowserAction({ type: "future-browser-capability" })).toBeNull();

    const validIntent = makeIntent({ type: "navigate", url: "https://example.com" });
    const decision = decideBrowserIntent(
      { ...validIntent, action: { type: "future-browser-capability" } },
      makeContext(validIntent, { allowNavigation: true }),
    );

    expect(decision).toMatchObject({ status: "denied", allowed: false, reason: "invalid-intent" });
    expect(() => decideBrowserIntent(null, null)).not.toThrow();
    expect(decideBrowserIntent(null, null)).toMatchObject({ status: "denied", reason: "invalid-intent" });
    const circularAction: Record<string, unknown> = { type: "future-browser-capability" };
    circularAction.self = circularAction;
    expect(() => decideBrowserIntent({ ...validIntent, action: circularAction }, makeContext(validIntent))).not.toThrow();
  });

  it("keeps clipboard denied by default and treats writes as consequential", () => {
    const action = { type: "clipboard", pageUrl: "https://example.com", operation: "write", text: "secret" } as const;
    const intent = makeIntent(action);

    expect(decideBrowserIntent(intent, makeContext(intent))).toMatchObject({
      status: "denied",
      reason: "default-deny",
    });

    expect(
      decideBrowserIntent(intent, makeContext(intent, { allowClipboard: true })),
    ).toMatchObject({ status: "approval_required", requiresApproval: true });
  });

  it("denies an upload without an authoritative file capability", () => {
    const intent = makeIntent({
      type: "upload",
      url: "https://example.com/upload",
      fileCapabilityId: "file_capability_0123456789abcdef0123456789abcdef",
    });
    const decision = decideBrowserIntent(intent, makeContext(intent, { allowUploads: true, maxUploadBytes: 10_000 }));

    expect(decision).toMatchObject({ status: "denied", reason: "missing-upload-capability" });
  });

  it("matches normalized origins by scheme, host, and effective port only", () => {
    expect(normalizeBrowserOrigin("HTTPS://Example.com:443/path")).toEqual({
      scheme: "https",
      host: "example.com",
      port: 443,
    });
    expect(isAllowedOrigin("https://example.com:443/path", ["https://EXAMPLE.COM"])).toBe(true);
    expect(isAllowedOrigin("http://example.com/path", ["https://example.com"])).toBe(false);
    expect(isAllowedOrigin("https://example.com:444/path", ["https://example.com"])).toBe(false);
    expect(isAllowedOrigin("https://app.example.com/path", ["https://example.com"])).toBe(false);
    expect(isAllowedOrigin("https://example.com/path", ["*.example.com"])).toBe(false);
  });

  it("does not reuse the general origin policy for redirects or popups", () => {
    const redirect = makeIntent({
      type: "redirect",
      fromUrl: "https://example.com/start",
      toUrl: "https://example.com/finish",
    });
    const popup = makeIntent({
      type: "popup",
      openerUrl: "https://example.com/home",
      url: "https://example.com/popup",
    });

    expect(decideBrowserIntent(redirect, makeContext(redirect, { allowRedirects: true }))).toMatchObject({
      status: "denied",
      reason: "redirect-not-allowed",
    });
    expect(decideBrowserIntent(popup, makeContext(popup, { allowPopups: true }))).toMatchObject({
      status: "denied",
      reason: "popup-not-allowed",
    });
  });

  it("binds approvals to immutable identity, digest, epochs, and expiry", () => {
    const action = { type: "download", url: "https://example.com/report.pdf", filename: "report.pdf" } as const;
    const intent = makeIntent(action);
    const policy = { allowDownloads: true };
    const approved = makeContext(intent, policy, { approvalState: approvalStateFor(intent, policy) });

    expect(decideBrowserIntent(intent, approved)).toMatchObject({
      status: "allowed",
      approvalId: "approval_0123456789abcdef0123456789abcdef",
    });
    const changed = { ...intent, action: { ...action, filename: "other.pdf" } };
    expect(
      decideBrowserIntent(changed, makeContext(changed, policy, { approvalState: approvalStateFor(intent, policy) })),
    ).toMatchObject({ status: "denied", reason: "approval-invalid" });
    expect(
      decideBrowserIntent(intent, makeContext(intent, policy, { approvalState: approvalStateFor(intent, policy), nowMs: 230 })),
    ).toMatchObject({ status: "denied", reason: "approval-expired" });
  });

  it("does not replay an approval across an exact profile id or mode", () => {
    const action = { type: "download", url: "https://example.com/report.pdf", filename: "report.pdf" } as const;
    const approvedIntent = makeIntent(action);
    const basePolicy = { allowDownloads: true };
    const approvalState = approvalStateFor(approvedIntent, basePolicy);
    const changedProfile = {
      ...approvedIntent,
      profile: { ...approvedIntent.profile, profileId: "profile-2" },
    };

    expect(
      decideBrowserIntent(
        changedProfile,
        makeContext(changedProfile, basePolicy, { approvalState }),
      ),
    ).toMatchObject({ status: "denied", reason: "approval-invalid" });
    const reused = {
      ...approvedIntent,
      profile: { ...approvedIntent.profile, mode: "reused" as const },
    };
    const reusedPolicy = {
      allowDownloads: true,
      allowReusedProfiles: true,
      reusableProfiles: [{ profileId: approvedIntent.profile.profileId, binding }],
    };
    expect(
      decideBrowserIntent(
        reused,
        makeContext(reused, reusedPolicy, { approvalState }),
      ),
    ).toMatchObject({ status: "denied", reason: "approval-invalid" });
  });

  it("atomically consumes approval while issuing one worker-consumable lease", () => {
    const action = { type: "download", url: "https://example.com/report.pdf", filename: "report.pdf" } as const;
    const candidate = makeIntent(action);
    const policy = { allowDownloads: true };
    const initialState = approvalStateFor(candidate, policy);
    const initialContext = makeContext(candidate, policy, { approvalState: initialState });

    const first = decideBrowserIntent(candidate, initialContext);

    expect(first).toMatchObject({
      status: "allowed",
      expectedStateRevision: 0,
      approvalId: "approval_0123456789abcdef0123456789abcdef",
    });
    expect(first.authorizationState).toMatchObject({
      revision: 1,
      consumedApprovalIds: ["approval_0123456789abcdef0123456789abcdef"],
    });
    expect(first.authorizationState.activeLeases).toHaveLength(1);
    expect(first.executionLease).toMatchObject({
      leaseId: "lease_0123456789abcdef0123456789abcdef",
      singleUse: true,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
    });

    const replay = decideBrowserIntent(candidate, makeContext(candidate, policy, {
      approvalState: first.authorizationState,
    }));
    expect(replay).toMatchObject({ status: "denied", reason: "approval-used" });

    const consumed = consumeBrowserExecutionLease(
      first.authorizationState,
      first.executionLease,
      initialContext.workerObservation,
      200,
    );
    expect(consumed).toMatchObject({ accepted: true, reason: "consumed", expectedStateRevision: 1 });
    expect(consumed.state).toMatchObject({
      revision: 2,
      activeLeases: [],
      consumedLeaseIds: ["lease_0123456789abcdef0123456789abcdef"],
    });
    expect(
      consumeBrowserExecutionLease(consumed.state, first.executionLease, initialContext.workerObservation, 201),
    ).toMatchObject({ accepted: false, reason: "lease-used" });
  });

  it("rejects a lease when worker or readiness identity changes before dispatch", () => {
    const candidate = makeIntent({ type: "navigate", url: "https://example.com/next" });
    const initialContext = makeContext(candidate, { allowNavigation: true });
    const decision = decideBrowserIntent(candidate, initialContext);
    expect(decision.status).toBe("allowed");

    expect(
      consumeBrowserExecutionLease(
        decision.authorizationState,
        decision.executionLease,
        { ...initialContext.workerObservation, readinessEpoch: 10 },
        200,
      ),
    ).toMatchObject({ accepted: false, reason: "stale-readiness-epoch" });
  });

  it("rejects mismatched broker evidence instead of generating local authority", () => {
    const intent = makeIntent({ type: "navigate", url: "https://example.com/next" });
    const valid = makeContext(intent, { allowNavigation: true });
    const context = {
      ...valid,
      brokerEvidence: {
        ...valid.brokerEvidence,
        actionDigest: `sha256:${"2".repeat(64)}`,
      },
    };

    expect(decideBrowserIntent(intent, context)).toMatchObject({
      status: "denied",
      reason: "broker-evidence-mismatch",
    });
  });

  it("uses worker-observed document, origin, frame, navigation, pre-state, and DNS identity", () => {
    const action = {
      type: "selector",
      pageUrl: "https://example.com/home",
      selector: "button.submit",
      operation: "inspect",
    } as const;
    const observation: BrowserWorkerObservation = {
      observationId: "observation_0123456789abcdef0123456789abcdef",
      actionType: "selector",
      target,
      profile: makeIntent(action).profile,
      trustedMode: "untrusted",
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
      observedAtMs: 175,
      documentId: "document_0123456789abcdef0123456789abcdef",
      navigationId: "navigation_0123456789abcdef0123456789abcdef",
      frameId: "frame_0123456789abcdef0123456789abcdef",
      currentUrl: "https://evil.example/forged",
      currentOrigin: { scheme: "https", host: "evil.example", port: 443 },
      preStateDigest: `sha256:${"5".repeat(64)}`,
      dns: [
        {
          resolutionId: "dns_0123456789abcdef0123456789abcdef",
          host: "evil.example",
          addresses: ["203.0.113.10"],
          resolvedAtMs: 160,
          expiresAtMs: 250,
          brokerEpoch: 5,
          workerEpoch: 7,
          readinessEpoch: 9,
        },
      ],
    };

    expect(
      decideBrowserIntent(
        makeIntent(action),
        makeContext(makeIntent(action), { allowSelectorActions: true }, { workerObservation: observation }),
      ),
    ).toMatchObject({ status: "denied", reason: "worker-observation-mismatch" });
  });

  it("does not trust upload filename, size, or file identity supplied by the intent", () => {
    const forgedUpload = {
      type: "upload",
      url: "https://example.com/upload",
      filename: "safe.csv",
      fileId: "caller-file",
      sizeBytes: 1,
    } as const;

    const validUpload = makeIntent({
      type: "upload",
      url: "https://example.com/upload",
      fileCapabilityId: "file_capability_0123456789abcdef0123456789abcdef",
    });
    expect(
      decideBrowserIntent(
        { ...validUpload, action: forgedUpload },
        makeContext(validUpload, { allowUploads: true, maxUploadBytes: 10_000 }, { uploadFileCapabilities: [] }),
      ),
    ).toMatchObject({ status: "denied", reason: "invalid-intent" });
  });

  it("binds authoritative upload metadata into broker evidence and the execution lease", () => {
    const upload = makeIntent({
      type: "upload",
      url: "https://example.com/upload",
      fileCapabilityId: "file_capability_0123456789abcdef0123456789abcdef",
    });
    const policy = {
      allowUploads: true,
      allowedUploadOrigins: ["https://example.com"],
      maxUploadBytes: 10_000,
    };
    const capability = {
      capabilityId: upload.action.type === "upload" ? upload.action.fileCapabilityId : "unreachable",
      evidenceId: "file_evidence_0123456789abcdef0123456789abcdef",
      principalId: upload.principalId,
      binding,
      profile: upload.profile,
      target,
      filename: "quarterly-report.csv",
      sizeBytes: 4_096,
      contentDigest: `sha256:${"6".repeat(64)}`,
      issuedAtMs: 150,
      expiresAtMs: 250,
      brokerEpoch: 5,
      workerEpoch: 7,
      readinessEpoch: 9,
    } as const;
    const uploadCapabilityDigest = "sha256:9dfd7b1cb943a0ea010d36d1be31ec02d1dba3c80adffa0e22ac99431ef1e089";
    const base = makeContext(upload, policy, {
      uploadFileCapabilities: [capability],
      approvalState: approvalStateFor(upload, policy),
    });
    const authoritative = {
      ...base,
      brokerEvidence: { ...base.brokerEvidence, uploadCapabilityDigest },
    };

    expect(decideBrowserIntent(upload, authoritative)).toMatchObject({
      status: "allowed",
      executionLease: {
        uploadCapabilityId: capability.capabilityId,
        uploadCapabilityDigest,
      },
    });

    const tampered = {
      ...authoritative,
      uploadFileCapabilities: [{ ...capability, filename: "different-safe-name.csv" }],
    };
    expect(decideBrowserIntent(upload, tampered)).toMatchObject({
      status: "denied",
      reason: "broker-evidence-mismatch",
    });
  });

  it("rejects Windows ADS, device, reserved-character, and trailing-dot filenames", () => {
    for (const filename of [
      "report.txt:secret",
      "CON",
      "con.txt",
      "LPT1.log",
      "NUL.csv",
      "report.",
      "report ",
      "a?.txt",
      "a|b.txt",
    ]) {
      expect(isSafeFilename(filename), filename).toBe(false);
    }
    expect(isSafeFilename("quarterly-report.csv")).toBe(true);
  });

  it("binds sensitive-origin capture redaction into policy evidence and the lease", () => {
    const raw = makeIntent({
      type: "screenshot",
      pageUrl: "https://example.com/account",
      target: "viewport",
      redaction: "none",
    });
    const policy = {
      allowScreenshots: true,
      sensitiveOrigins: ["https://example.com"],
    };
    expect(decideBrowserIntent(raw, makeContext(raw, policy))).toMatchObject({
      status: "denied",
      reason: "sensitive-origin-capture",
    });

    const redacted = makeIntent({
      type: "screenshot",
      pageUrl: "https://example.com/account",
      target: "viewport",
      redaction: "sensitive",
    });
    expect(decideBrowserIntent(redacted, makeContext(redacted, policy))).toMatchObject({
      status: "allowed",
      executionLease: {
        capture: { sensitiveOrigin: true, redaction: "sensitive" },
      },
    });

    const approvalPolicy = { ...policy, approvalRequiredFor: ["screenshot" as const] };
    const originalApproval = approvalStateFor(redacted, approvalPolicy);
    expect(
      decideBrowserIntent(raw, makeContext(raw, approvalPolicy, { approvalState: originalApproval })),
    ).toMatchObject({ status: "denied", reason: "sensitive-origin-capture" });
  });

  it("fails closed before unbounded URL and observation-array work", () => {
    expect(
      decodeBrowserAction({ type: "navigate", url: `https://example.com/${"a".repeat(8_193)}` }),
    ).toBeNull();

    const intent = makeIntent({ type: "navigate", url: "https://example.com/home" });
    const valid = makeContext(intent, { allowNavigation: true, allowedOrigins: ["https://example.com"] });
    const repeatedDns = Array.from({ length: 257 }, (_, index) => ({
      ...valid.workerObservation.dns[0],
      resolutionId: `resolution_${String(index).padStart(22, "0")}`,
    }));

    expect(decodeBrowserPolicyContext({
      ...valid,
      workerObservation: { ...valid.workerObservation, dns: repeatedDns },
    })).toBeNull();
  });

  it("never executes origin accessors at the public normalization boundary", () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "scheme", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not execute");
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => browserOriginKey(hostile as never)).not.toThrow();
    expect(browserOriginKey(hostile as never)).toBeNull();
    expect(getterCalls).toBe(0);
    expect(() => browserOriginKey(proxy as never)).not.toThrow();
  });

  it("requires an exact takeover release identity", () => {
    const activeTakeover = {
      takeoverId: "takeover-1",
      intentId: "takeover-intent-1",
      principalId: "principal-1",
      target,
    } as const;
    const release = makeIntent({
      type: "takeover",
      operation: "release",
      takeoverId: "takeover-1",
      takeoverIntentId: "takeover-intent-1",
      reason: "Operator is done.",
    });

    expect(
      decideBrowserIntent(release, makeContext(release, { allowTakeover: true }, { activeTakeover })),
    ).toMatchObject({ status: "approval_required" });
    const otherPrincipal = { ...release, principalId: "other-principal" };
    expect(
      decideBrowserIntent(
        otherPrincipal,
        makeContext(otherPrincipal, { allowTakeover: true }, { activeTakeover, principalId: "other-principal" }),
      ),
    ).toMatchObject({ status: "denied", reason: "takeover-release-mismatch" });
  });

  it("rejects stale target, policy, and approval epochs", () => {
    const intent = makeIntent({ type: "navigate", url: "https://example.com" });
    const staleTarget = { ...intent, target: { ...target, epoch: 2 } };

    expect(
      decideBrowserIntent(staleTarget, makeContext(staleTarget, { allowNavigation: true }, { target })),
    ).toMatchObject({ status: "denied", reason: "stale-target-epoch" });
    expect(
      decideBrowserIntent(intent, makeContext(intent, { allowNavigation: true }, { policyEpoch: 8 })),
    ).toMatchObject({ status: "denied", reason: "stale-policy-epoch" });
    expect(
      decideBrowserIntent(intent, makeContext(intent, { allowNavigation: true }, { approvalEpoch: 12 })),
    ).toMatchObject({ status: "denied", reason: "stale-approval-epoch" });
    const wrongTab = { ...intent, target: { ...target, tabId: "tab-2" } };
    expect(
      decideBrowserIntent(wrongTab, makeContext(wrongTab, { allowNavigation: true }, { target })),
    ).toMatchObject({ status: "denied", reason: "target-identity-mismatch" });
  });
});
