import { describe, expect, it } from "vitest";

import type { BrowserCapabilityIntent, BrowserPolicyDecision } from "./types";
import { browserActionDigest, browserDecisionScopeDigest } from "./policy";
import {
  appendVisibleAction,
  createVisibleActionLedger,
  recordBrowserDecision,
  recordBrowserOperation,
} from "./ledger";

const capabilityIntent: BrowserCapabilityIntent = {
  intentId: "intent-1",
  principalId: "principal-1",
  actor: "agent",
  requestedAtMs: 100,
  binding: { accountId: "account-1", projectId: "project-1" },
  target: { sessionId: "session-1", tabId: "tab-1", targetId: "target-1", epoch: 1 },
  policyEpoch: 1,
  approvalEpoch: 1,
  profile: {
    profileId: "profile-1",
    mode: "isolated",
    accountId: "account-1",
    projectId: "project-1",
  },
  action: { type: "navigate", url: "https://example.com/home" },
};

const inspectIntent: BrowserCapabilityIntent = {
  ...capabilityIntent,
  intentId: "intent-inspect",
  action: {
    type: "selector",
    pageUrl: "https://example.com/home",
    selector: "#status",
    operation: "inspect",
  },
};

const emptyAuthorizationState = {
  revision: 0,
  grants: [],
  consumedApprovalIds: [],
  revokedApprovalIds: [],
  activeLeases: [],
  consumedLeaseIds: [],
  consumedUploadCapabilityIds: [],
} as const;

function scopeFor(intent: BrowserCapabilityIntent) {
  return {
    principalId: intent.principalId,
    binding: intent.binding,
    profile: intent.profile,
    target: intent.target,
    trustedMode: "untrusted" as const,
    policyEpoch: intent.policyEpoch,
    approvalEpoch: intent.approvalEpoch,
    policyDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    observationDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    brokerEpoch: 1,
    workerEpoch: 1,
    readinessEpoch: 1,
  };
}

function deniedDecisionFor(intent: BrowserCapabilityIntent): BrowserPolicyDecision {
  const scope = scopeFor(intent);
  return {
    decisionId: "decision_0123456789abcdef0123456789abcdef",
    intentId: intent.intentId,
    actionDigest: browserActionDigest(intent.action),
    status: "denied",
    allowed: false,
    requiresApproval: false,
    reason: "prompt-injection-evidence",
    evidenceIds: ["evidence_0123456789abcdef0123456789abcdef"],
    issuedAtMs: 105,
    scope,
    scopeDigest: browserDecisionScopeDigest(scope),
    expectedStateRevision: 0,
    authorizationState: emptyAuthorizationState,
  };
}

function allowedDecisionFor(intent: BrowserCapabilityIntent): BrowserPolicyDecision {
  const scope = scopeFor(intent);
  const actionDigest = browserActionDigest(intent.action);
  const decisionId = "decision_abcdef0123456789abcdef0123456789";
  const lease = {
    leaseId: "lease_abcdef0123456789abcdef0123456789",
    evidenceId: "evidence_abcdef0123456789abcdef0123456789",
    decisionId,
    intentId: intent.intentId,
    actionDigest,
    policyDigest: scope.policyDigest,
    observationDigest: scope.observationDigest,
    scope,
    issuedAtMs: 105,
    expiresAtMs: 205,
    singleUse: true as const,
    brokerEpoch: 1,
    workerEpoch: 1,
    readinessEpoch: 1,
  };
  return {
    decisionId,
    intentId: intent.intentId,
    actionDigest,
    status: "allowed",
    allowed: true,
    requiresApproval: false,
    reason: "allowed",
    evidenceIds: [],
    issuedAtMs: 105,
    scope,
    scopeDigest: browserDecisionScopeDigest(scope),
    executionLease: lease,
    expectedStateRevision: 0,
    authorizationState: {
      ...emptyAuthorizationState,
      revision: 1,
      activeLeases: [lease],
    },
  };
}

describe("visible browser action ledger", () => {
  it("appends immutable visible entries with monotonically increasing sequence numbers", () => {
    const empty = createVisibleActionLedger();
    const first = appendVisibleAction(empty, {
      eventId: "event-1",
      eventType: "intent",
      actionId: "intent-1",
      atMs: 100,
      intentId: "intent-1",
      actionType: "navigate",
      status: "requested",
      summary: "Navigate to an approved origin",
    });
    const second = appendVisibleAction(first, {
      eventId: "event-2",
      eventType: "takeover",
      actionId: "intent-2",
      atMs: 110,
      actionType: "takeover",
      status: "requested",
      summary: "Request takeover",
    });

    expect(empty.entries).toEqual([]);
    expect(first.entries[0]).toMatchObject({ sequence: 1, visible: true, actionId: "intent-1", status: "requested" });
    expect(second.entries[1]).toMatchObject({ sequence: 2, visible: true, actionId: "intent-2", status: "requested" });
  });

  it("ignores entries without durable identity or a user-visible summary", () => {
    const ledger = createVisibleActionLedger();
    expect(
      appendVisibleAction(ledger, {
        eventId: "",
        eventType: "intent",
        actionId: "intent-1",
        atMs: 100,
        actionType: "navigate",
        status: "requested",
        summary: "Navigate",
      }),
    ).toEqual(ledger);
    expect(
      appendVisibleAction(ledger, {
        eventId: "event-1",
        eventType: "intent",
        actionId: "intent-1",
        atMs: 100,
        actionType: "navigate",
        status: "requested",
        summary: "",
      }),
    ).toEqual(ledger);
  });

  it("records policy decisions as visible entries without losing evidence references", () => {
    const decision = deniedDecisionFor(capabilityIntent);
    const ledger = recordBrowserDecision(createVisibleActionLedger(), capabilityIntent, decision, 130);

    expect(ledger.entries[0]).toMatchObject({
      sequence: 1,
      visible: true,
      eventId: decision.decisionId,
      eventType: "decision",
      actionId: "intent-1",
      decisionId: decision.decisionId,
      actionType: "navigate",
      status: "denied",
      reason: "prompt-injection-evidence",
      evidenceIds: ["evidence_0123456789abcdef0123456789abcdef"],
    });
  });

  it("records timeout and recovery states as visible operation outcomes", () => {
    const actionDigest = browserActionDigest(inspectIntent.action);
    const timedOut = {
      operationId: "operation-1",
      actionDigest,
      retryClass: "idempotent" as const,
      status: "timed_out" as const,
      generation: 1,
      attempt: 1,
      startedAtMs: 110,
      deadlineAtMs: 150,
    };
    const recovered = {
      operationId: "operation-1",
      actionDigest,
      retryClass: "idempotent" as const,
      status: "running" as const,
      generation: 2,
      attempt: 2,
      startedAtMs: 200,
      deadlineAtMs: 275,
    };
    const authorized = recordBrowserDecision(createVisibleActionLedger(), inspectIntent, allowedDecisionFor(inspectIntent), 110);
    const ledger = recordBrowserOperation(
      recordBrowserOperation(authorized, inspectIntent.intentId, "selector", timedOut, 150),
      inspectIntent.intentId,
      "selector",
      recovered,
      200,
    );

    expect(ledger.entries.map((entry) => entry.status)).toEqual(["allowed", "timed_out", "recovered"]);
    expect(ledger.entries[2]).toMatchObject({ attempt: 2, generation: 2, summary: "selector recovered" });
    expect(ledger.entries.every((entry) => entry.visible)).toBe(true);
  });
});
