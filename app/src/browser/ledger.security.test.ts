import { describe, expect, it } from "vitest";

import type { BrowserCapabilityIntent, BrowserPolicyDecision } from "./types";
import { browserActionDigest, browserDecisionScopeDigest } from "./policy";
import {
  appendVisibleAction,
  createVisibleActionLedger,
  recordBrowserDecision,
  recordBrowserOperation,
} from "./ledger";

const intent: BrowserCapabilityIntent = {
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
  action: {
    type: "selector",
    pageUrl: "https://example.com/home",
    selector: "#status",
    operation: "inspect",
  },
};

const scope = {
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

const emptyAuthorizationState = {
  revision: 0,
  grants: [],
  consumedApprovalIds: [],
  revokedApprovalIds: [],
  activeLeases: [],
  consumedLeaseIds: [],
  consumedUploadCapabilityIds: [],
} as const;

const decision: BrowserPolicyDecision = {
  decisionId: "decision_0123456789abcdef0123456789abcdef",
  intentId: intent.intentId,
  actionDigest: browserActionDigest(intent.action),
  status: "denied",
  allowed: false,
  requiresApproval: false,
  reason: "default-deny",
  evidenceIds: [],
  issuedAtMs: 105,
  scope,
  scopeDigest: browserDecisionScopeDigest(scope),
  expectedStateRevision: 0,
  authorizationState: emptyAuthorizationState,
};

const lease = {
  leaseId: "lease_0123456789abcdef0123456789abcdef",
  evidenceId: "evidence_0123456789abcdef0123456789abcdef",
  decisionId: decision.decisionId,
  intentId: intent.intentId,
  actionDigest: browserActionDigest(intent.action),
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

const allowedDecision: BrowserPolicyDecision = {
  ...decision,
  status: "allowed",
  allowed: true,
  reason: "allowed",
  executionLease: lease,
  authorizationState: {
    ...emptyAuthorizationState,
    revision: 1,
    activeLeases: [lease],
  },
};

describe("authoritative visible browser ledger", () => {
  it("deduplicates immutable events and decisions by identity", () => {
    const ledger = createVisibleActionLedger();
    const input = {
      eventId: "event-1",
      eventType: "intent" as const,
      actionId: "intent-1",
      atMs: 100,
      actionType: "selector" as const,
      status: "requested" as const,
      summary: "Navigate to the approved origin",
    };
    const first = appendVisibleAction(ledger, input);
    const duplicate = appendVisibleAction(first, { ...input, summary: "mutated duplicate" });

    expect(duplicate).toEqual(first);
    expect(first.seenEventIds).toEqual(["event-1"]);

    const recorded = recordBrowserDecision(first, intent, decision, 110);
    expect(recordBrowserDecision(recorded, intent, decision, 120)).toEqual(recorded);
    expect(recorded.entries.map((entry) => entry.decisionId)).toEqual([undefined, decision.decisionId]);
  });

  it("rejects a decision for another intent or action digest", () => {
    const ledger = createVisibleActionLedger();

    expect(recordBrowserDecision(ledger, intent, { ...decision, intentId: "intent-other" }, 110)).toEqual(ledger);
    expect(
      recordBrowserDecision(
        ledger,
        intent,
        { ...decision, actionDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
        110,
      ),
    ).toEqual(ledger);
  });

  it("rejects contradictory decision status and an intent-mismatched scope", () => {
    const ledger = createVisibleActionLedger();

    expect(recordBrowserDecision(ledger, intent, { ...decision, allowed: true }, 110)).toEqual(ledger);
    const mismatchedScope = {
      ...scope,
      profile: { ...scope.profile, profileId: "profile-other" },
    };
    expect(
      recordBrowserDecision(
        ledger,
        intent,
        { ...decision, scope: mismatchedScope, scopeDigest: browserDecisionScopeDigest(mismatchedScope) },
        110,
      ),
    ).toEqual(ledger);
  });

  it("rejects decisions issued before their intent or observed before issuance", () => {
    const ledger = createVisibleActionLedger();

    expect(recordBrowserDecision(ledger, intent, { ...decision, issuedAtMs: 99 }, 110)).toEqual(ledger);
    expect(recordBrowserDecision(ledger, intent, decision, 104)).toEqual(ledger);
  });

  it("does not execute decision accessors or revoked proxies", () => {
    const hostile = Object.defineProperty({}, "decisionId", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => recordBrowserDecision(createVisibleActionLedger(), intent, hostile as never, 110)).not.toThrow();
    expect(recordBrowserDecision(createVisibleActionLedger(), intent, hostile as never, 110)).toEqual(createVisibleActionLedger());
    expect(() => appendVisibleAction(createVisibleActionLedger(), proxy as never)).not.toThrow();
  });

  it("rejects malformed entries and events after an operation terminal", () => {
    const ledger = createVisibleActionLedger();
    expect(() => appendVisibleAction(ledger, null as never)).not.toThrow();
    expect(appendVisibleAction(ledger, null as never)).toEqual(ledger);

    const authorized = recordBrowserDecision(ledger, intent, allowedDecision, 110);
    const terminal = recordBrowserOperation(authorized, intent.intentId, "selector", {
      operationId: "operation-1",
      actionDigest: browserActionDigest(intent.action),
      retryClass: "idempotent",
      status: "succeeded",
      generation: 1,
      attempt: 1,
      startedAtMs: 110,
      deadlineAtMs: 200,
      completedAtMs: 150,
    }, 150);
    expect(terminal.entries).toHaveLength(2);
    expect(terminal.terminalOperationIds).toEqual(["operation-1"]);
    expect(
      appendVisibleAction(terminal, {
        eventId: "event-late",
        eventType: "operation",
        actionId: "intent-1",
        intentId: intent.intentId,
        operationId: "operation-1",
        generation: 1,
        attempt: 1,
        atMs: 210,
        actionType: "selector",
        actionDigest: browserActionDigest(intent.action),
        scopeDigest: browserDecisionScopeDigest(scope),
        decisionIssuedAtMs: 105,
        status: "failed",
        summary: "Late failure",
      }),
    ).toEqual(terminal);
  });

  it("rejects low-level decision and operation events without authoritative lineage", () => {
    const ledger = createVisibleActionLedger();

    expect(
      appendVisibleAction(ledger, {
        eventId: "decision_forged_0123456789abcdef01234567",
        eventType: "decision",
        decisionId: "decision_forged_0123456789abcdef01234567",
        actionId: intent.intentId,
        intentId: intent.intentId,
        atMs: 110,
        actionType: "selector",
        status: "allowed",
        summary: "selector allowed",
      }),
    ).toEqual(ledger);
    expect(
      appendVisibleAction(ledger, {
        eventId: "operation_forged_0123456789abcdef0123456",
        eventType: "operation",
        actionId: intent.intentId,
        intentId: intent.intentId,
        operationId: "operation-1",
        generation: 1,
        attempt: 1,
        atMs: 120,
        actionType: "selector",
        actionDigest: browserActionDigest(intent.action),
        status: "running",
        summary: "selector running",
      }),
    ).toEqual(ledger);
  });

  it("uses recovered status and summary consistently across attempts", () => {
    const operation = {
      operationId: "operation-1",
      actionDigest: browserActionDigest(intent.action),
      retryClass: "idempotent" as const,
      status: "running" as const,
      generation: 2,
      attempt: 2,
      startedAtMs: 200,
      deadlineAtMs: 275,
    };
    const authorized = recordBrowserDecision(createVisibleActionLedger(), intent, allowedDecision, 110);
    const ledger = recordBrowserOperation(authorized, "intent-1", "selector", operation, 200);

    expect(ledger.entries[1]).toMatchObject({
      status: "recovered",
      summary: "selector recovered",
      generation: 2,
      attempt: 2,
      actionDigest: browserActionDigest(intent.action),
      scopeDigest: browserDecisionScopeDigest(scope),
    });
  });

  it("rejects operations without a prior matching allowed decision", () => {
    const operation = {
      operationId: "operation-1",
      actionDigest: browserActionDigest(intent.action),
      retryClass: "non_idempotent" as const,
      status: "running" as const,
      generation: 1,
      attempt: 1,
      startedAtMs: 110,
      deadlineAtMs: 160,
    };
    const empty = createVisibleActionLedger();
    const denied = recordBrowserDecision(empty, intent, decision, 110);
    const authorized = recordBrowserDecision(empty, intent, allowedDecision, 110);

    expect(recordBrowserOperation(empty, intent.intentId, "selector", operation, 120)).toEqual(empty);
    expect(recordBrowserOperation(denied, intent.intentId, "selector", operation, 120)).toEqual(denied);
    expect(
      recordBrowserOperation(
        authorized,
        intent.intentId,
        "selector",
        { ...operation, actionDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
        120,
      ),
    ).toEqual(authorized);
  });

  it("rejects an operation whose attempt predates decision issuance", () => {
    const authorized = recordBrowserDecision(createVisibleActionLedger(), intent, allowedDecision, 110);
    const operation = {
      operationId: "operation-1",
      actionDigest: browserActionDigest(intent.action),
      retryClass: "non_idempotent" as const,
      status: "running" as const,
      generation: 1,
      attempt: 1,
      startedAtMs: 104,
      deadlineAtMs: 160,
    };

    expect(recordBrowserOperation(authorized, intent.intentId, "selector", operation, 120)).toEqual(authorized);
  });

  it("rejects recoverable statuses for a non-idempotent retry class", () => {
    const authorized = recordBrowserDecision(createVisibleActionLedger(), intent, allowedDecision, 110);
    const impossibleTimeout = {
      operationId: "operation-1",
      actionDigest: browserActionDigest(intent.action),
      retryClass: "non_idempotent" as const,
      status: "timed_out" as const,
      generation: 1,
      attempt: 1,
      startedAtMs: 110,
      deadlineAtMs: 160,
    };

    expect(recordBrowserOperation(authorized, intent.intentId, "selector", impossibleTimeout, 160)).toEqual(authorized);
  });
});
