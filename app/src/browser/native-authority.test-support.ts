import type {
  BrowserAction,
  BrowserApprovalState,
  BrowserDecisionScope,
  BrowserExecutionLease,
  BrowserPolicyReason,
  BrowserPolicyStatus,
  BrowserWorkerObservation,
} from "./types";
import {
  browserDecisionScopeDigest,
  consumeBrowserExecutionLease,
  createBrowserApprovalState,
  decodeBrowserCapabilityIntent,
  decodeBrowserWorkerObservation,
  decideBrowserIntent,
} from "./policy";
import { sha256Digest } from "./digest";
import { canonicalBrowserJson, decodeBrowserTransport, type BrowserJsonValue } from "./transport";

export type NativeBrowserEvidenceKind = "authorize" | "start" | "complete";

export interface AuthenticatedNativeBrowserEvidence {
  readonly kind: NativeBrowserEvidenceKind;
  readonly evidenceId: string;
  readonly observedAtMs: number;
  readonly payload: BrowserJsonValue;
}

/** Implemented by the native bridge. This interface is deliberately absent from the browser barrel. */
export interface NativeBrowserEvidenceAuthenticator {
  authenticate(rawEnvelope: string, expectedKind: NativeBrowserEvidenceKind): string | null;
  chain(previousTag: string, canonicalEntry: string): string;
}

export type BrowserAuthorityFailureReason =
  | "invalid-native-evidence"
  | "native-evidence-replayed"
  | "stale-authority-revision"
  | "invalid-authority-payload"
  | "authorization-denied"
  | "lease-not-owned"
  | "attempt-already-active"
  | "lease-start-rejected"
  | "attempt-not-owned"
  | "completion-binding-mismatch"
  | "completion-proof-invalid"
  | "capture-proof-invalid";

export interface BrowserAuthorityResult {
  readonly accepted: boolean;
  readonly reason: "authorized" | "started" | "completed" | BrowserAuthorityFailureReason | BrowserPolicyReason;
  readonly revision: number;
  readonly status?: BrowserPolicyStatus;
  readonly leaseId?: string;
  readonly attemptId?: string;
}

export interface BrowserAuthoritySnapshot {
  readonly revision: number;
  readonly activeLeaseIds: readonly string[];
  readonly activeAttemptIds: readonly string[];
  readonly ledger: readonly BrowserAuthorityLedgerEntry[];
}

export type BrowserAuthorityLedgerPhase = "requested" | "decision" | "leased" | "running" | "terminal";
export type BrowserAuthorityLedgerStatus = "requested" | "allowed" | "denied" | "approval_required" | "leased" | "running" |
  "succeeded" | "failed" | "outcome_unknown";

export interface BrowserAuthorityLedgerEntry {
  readonly sequence: number;
  readonly phase: BrowserAuthorityLedgerPhase;
  readonly status: BrowserAuthorityLedgerStatus;
  readonly atMs: number;
  readonly nativeEvidenceId: string;
  readonly intentId: string;
  readonly decisionId: string;
  readonly leaseId?: string;
  readonly attemptId?: string;
  readonly actionType: BrowserAction["type"];
  readonly actionDigest: string;
  readonly scopeDigest: string;
  readonly scope: BrowserDecisionScope;
  readonly completionDigest?: string;
  readonly previousTag: string;
  readonly tag: string;
}

type UnsignedLedgerEntry = Omit<BrowserAuthorityLedgerEntry, "sequence" | "previousTag" | "tag">;

interface PreparedLedgerEntries {
  readonly entries: readonly BrowserAuthorityLedgerEntry[];
  readonly lastTag: string;
}

interface ActiveAttempt {
  readonly attemptId: string;
  readonly lease: BrowserExecutionLease;
  readonly observation: BrowserWorkerObservation;
  readonly action: BrowserAction;
  readonly startedAtMs: number;
}

interface OwnedLease {
  readonly lease: BrowserExecutionLease;
  readonly action: BrowserAction;
}

export interface NativeBrowserAuthority {
  authorize(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  start(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  complete(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  snapshot(): BrowserAuthoritySnapshot;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;

function jsonRecord(value: BrowserJsonValue): Record<string, BrowserJsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, BrowserJsonValue>
    : null;
}

function hasExactKeys(record: Record<string, BrowserJsonValue>, requiredKeys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...requiredKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasClosedKeys(
  record: Record<string, BrowserJsonValue>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const actual = Object.keys(record);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && actual.every((key) => allowed.has(key));
}

function sameTarget(left: BrowserWorkerObservation["target"], right: BrowserWorkerObservation["target"]): boolean {
  return left.sessionId === right.sessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.epoch === right.epoch;
}

function sameProfile(left: BrowserWorkerObservation["profile"], right: BrowserWorkerObservation["profile"]): boolean {
  return left.profileId === right.profileId && left.mode === right.mode &&
    left.accountId === right.accountId && left.projectId === right.projectId;
}

function decodeTarget(value: BrowserJsonValue): BrowserWorkerObservation["target"] | null {
  const record = jsonRecord(value);
  if (!record || !hasExactKeys(record, ["sessionId", "tabId", "targetId", "epoch"])) return null;
  if (
    typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 200 ||
    typeof record.tabId !== "string" || !record.tabId || record.tabId.length > 200 ||
    typeof record.targetId !== "string" || !record.targetId || record.targetId.length > 200 ||
    typeof record.epoch !== "number" || !Number.isSafeInteger(record.epoch) || record.epoch < 0
  ) return null;
  return { sessionId: record.sessionId, tabId: record.tabId, targetId: record.targetId, epoch: record.epoch };
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NAVIGATION_ACTIONS = new Set(["navigate", "redirect", "popup", "frame"]);

function navigationDestination(action: BrowserAction): string | null {
  switch (action.type) {
    case "navigate": case "popup": case "frame": return action.url;
    case "redirect": return action.toUrl;
    default: return null;
  }
}

function validCaptureProof(value: BrowserJsonValue, lease: BrowserExecutionLease): boolean {
  const record = jsonRecord(value);
  if (!record || !hasClosedKeys(record,
    ["bounds", "outputDigest", "classification", "redactionApplied", "persistence"], ["redactor"])) return false;
  const bounds = jsonRecord(record.bounds);
  if (!bounds || !hasExactKeys(bounds, ["x", "y", "width", "height"])) return false;
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every((candidate) => typeof candidate === "number" && Number.isFinite(candidate))) return false;
  if ((bounds.width as number) <= 0 || (bounds.height as number) <= 0 || (bounds.x as number) < 0 || (bounds.y as number) < 0) return false;
  if (typeof record.outputDigest !== "string" || !DIGEST_PATTERN.test(record.outputDigest)) return false;
  if (record.classification !== "non_sensitive" && record.classification !== "sensitive_redacted") return false;
  if (typeof record.redactionApplied !== "boolean") return false;
  if (record.persistence !== "ephemeral" && record.persistence !== "encrypted") return false;
  const mustProveRedaction = lease.capture?.sensitiveOrigin === true || lease.capture?.redaction === "sensitive" || record.redactionApplied;
  if (!mustProveRedaction) return record.classification === "non_sensitive" && record.redactor === undefined;
  if (!record.redactionApplied || record.classification !== "sensitive_redacted") return false;
  const redactor = jsonRecord(record.redactor);
  return !!redactor && hasExactKeys(redactor, ["redactorId", "version", "proofDigest"]) &&
    typeof redactor.redactorId === "string" && OPAQUE_ID_PATTERN.test(redactor.redactorId) &&
    typeof redactor.version === "string" && redactor.version.length > 0 && redactor.version.length <= 64 &&
    typeof redactor.proofDigest === "string" && DIGEST_PATTERN.test(redactor.proofDigest);
}

function validRedirectChain(value: BrowserJsonValue, action: BrowserAction): boolean {
  if (!Array.isArray(value) || value.length > 32) return false;
  for (const candidate of value) {
    const hop = jsonRecord(candidate);
    if (!hop || !hasExactKeys(hop, ["fromUrl", "toUrl", "statusCode", "documentId", "navigationId"])) return false;
    if (typeof hop.fromUrl !== "string" || typeof hop.toUrl !== "string") return false;
    try { new URL(hop.fromUrl); new URL(hop.toUrl); } catch { return false; }
    if (typeof hop.statusCode !== "number" || !Number.isSafeInteger(hop.statusCode) || hop.statusCode < 300 || hop.statusCode > 399) return false;
    if (typeof hop.documentId !== "string" || !OPAQUE_ID_PATTERN.test(hop.documentId) ||
        typeof hop.navigationId !== "string" || !OPAQUE_ID_PATTERN.test(hop.navigationId)) return false;
  }
  if (action.type === "redirect") {
    if (value.length === 0) return false;
    const first = value[0] as Record<string, BrowserJsonValue>;
    const last = value[value.length - 1] as Record<string, BrowserJsonValue>;
    return first.fromUrl === action.fromUrl && last.toUrl === action.toUrl;
  }
  return true;
}

function safeFailure(reason: BrowserAuthorityFailureReason, revision: number): BrowserAuthorityResult {
  return Object.freeze({ accepted: false, reason, revision });
}

/** Test-only deterministic substitute for the unavailable native-owned production authority. */
export function createNativeBrowserAuthority(
  authenticator: NativeBrowserEvidenceAuthenticator,
): NativeBrowserAuthority {
  let approvalState: BrowserApprovalState = createBrowserApprovalState();
  let authorityRevision = 0;
  const usedEvidenceIds = new Set<string>();
  const ownedLeases = new Map<string, OwnedLease>();
  const activeAttempts = new Map<string, ActiveAttempt>();
  const ledger: BrowserAuthorityLedgerEntry[] = [];
  let lastLedgerTag = `sha256:${"0".repeat(64)}`;
  let chainInFlight = false;

  const prepareLedgerEntries = (entries: readonly UnsignedLedgerEntry[]): PreparedLedgerEntries | null => {
    if (chainInFlight) return null;
    const prepared: BrowserAuthorityLedgerEntry[] = [];
    let previousTag = lastLedgerTag;
    chainInFlight = true;
    try {
      for (const entry of entries) {
        const unsigned = Object.freeze({
          sequence: ledger.length + prepared.length + 1,
          ...entry,
          previousTag,
        });
        const tag = authenticator.chain(previousTag, canonicalBrowserJson(unsigned as unknown as BrowserJsonValue));
        if (typeof tag !== "string" || !DIGEST_PATTERN.test(tag)) return null;
        prepared.push(Object.freeze({ ...unsigned, tag }));
        previousTag = tag;
      }
      return Object.freeze({ entries: Object.freeze(prepared), lastTag: previousTag });
    } catch {
      return null;
    } finally {
      chainInFlight = false;
    }
  };

  const commitLedgerEntries = (prepared: PreparedLedgerEntries): void => {
    ledger.push(...prepared.entries);
    lastLedgerTag = prepared.lastTag;
  };

  const currentRevision = (): number => authorityRevision;
  const authenticate = (
    rawEvidence: unknown,
    expectedRevision: number,
    kind: NativeBrowserEvidenceKind,
  ): AuthenticatedNativeBrowserEvidence | BrowserAuthorityResult => {
    if (chainInFlight || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== currentRevision()) {
      return safeFailure("stale-authority-revision", currentRevision());
    }
    if (typeof rawEvidence !== "string") return safeFailure("invalid-native-evidence", currentRevision());
    try {
      const boundedEnvelope = decodeBrowserTransport(rawEvidence);
      if (boundedEnvelope === null) return safeFailure("invalid-native-evidence", currentRevision());
      const nativeResult = authenticator.authenticate(canonicalBrowserJson(boundedEnvelope), kind);
      if (typeof nativeResult !== "string") return safeFailure("invalid-native-evidence", currentRevision());
      const decodedResult = decodeBrowserTransport(nativeResult);
      const record = decodedResult === null ? null : jsonRecord(decodedResult);
      if (!record || !hasExactKeys(record, ["kind", "evidenceId", "observedAtMs", "payload"]) ||
          record.kind !== kind || typeof record.evidenceId !== "string" ||
          !OPAQUE_ID_PATTERN.test(record.evidenceId) || typeof record.observedAtMs !== "number" ||
          !Number.isFinite(record.observedAtMs) || record.observedAtMs < 0) {
        return safeFailure("invalid-native-evidence", currentRevision());
      }
      const evidence: AuthenticatedNativeBrowserEvidence = Object.freeze({
        kind,
        evidenceId: record.evidenceId,
        observedAtMs: record.observedAtMs,
        payload: record.payload,
      });
      if (usedEvidenceIds.has(evidence.evidenceId)) return safeFailure("native-evidence-replayed", currentRevision());
      return evidence;
    } catch {
      return safeFailure("invalid-native-evidence", currentRevision());
    }
  };

  return Object.freeze({
    authorize(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult {
      const authenticated = authenticate(rawEvidence, expectedRevision, "authorize");
      if ("accepted" in authenticated) return authenticated;
      if (expectedRevision !== currentRevision()) return safeFailure("stale-authority-revision", currentRevision());
      const payload = jsonRecord(authenticated.payload);
      if (!payload || !hasExactKeys(payload, ["intent", "context"])) {
        return safeFailure("invalid-authority-payload", currentRevision());
      }
      const context = jsonRecord(payload.context);
      if (!context) return safeFailure("invalid-authority-payload", currentRevision());
      const intent = decodeBrowserCapabilityIntent(payload.intent);
      if (!intent) return safeFailure("invalid-authority-payload", currentRevision());
      const decision = decideBrowserIntent(payload.intent, { ...context, approvalState });
      if (
        !decision.scope || !decision.scopeDigest ||
        decision.scopeDigest !== browserDecisionScopeDigest(decision.scope) ||
        decision.intentId !== intent.intentId || decision.actionDigest === "sha256:invalid-action" ||
        decision.issuedAtMs < intent.requestedAtMs || decision.issuedAtMs > authenticated.observedAtMs
      ) return safeFailure("authorization-denied", currentRevision());

      const ledgerBase = {
        nativeEvidenceId: authenticated.evidenceId,
        intentId: intent.intentId,
        decisionId: decision.decisionId,
        actionType: intent.action.type,
        actionDigest: decision.actionDigest,
        scopeDigest: decision.scopeDigest,
        scope: decision.scope,
      } as const;
      if (decision.status !== "allowed" || !decision.executionLease) {
        const prepared = prepareLedgerEntries([
          { ...ledgerBase, phase: "requested", status: "requested", atMs: intent.requestedAtMs },
          { ...ledgerBase, phase: "decision", status: decision.status, atMs: decision.issuedAtMs },
        ]);
        if (!prepared) return safeFailure("invalid-native-evidence", currentRevision());
        if (expectedRevision !== currentRevision()) return safeFailure("stale-authority-revision", currentRevision());
        usedEvidenceIds.add(authenticated.evidenceId);
        commitLedgerEntries(prepared);
        authorityRevision += 1;
        return Object.freeze({
          accepted: false,
          reason: decision.reason === "allowed" ? "authorization-denied" : decision.reason,
          revision: currentRevision(),
          status: decision.status,
        });
      }
      if (decision.expectedStateRevision !== approvalState.revision || decision.authorizationState.revision !== approvalState.revision + 1) {
        return safeFailure("authorization-denied", currentRevision());
      }
      const prepared = prepareLedgerEntries([
        { ...ledgerBase, phase: "requested", status: "requested", atMs: intent.requestedAtMs },
        { ...ledgerBase, phase: "decision", status: decision.status, atMs: decision.issuedAtMs },
        {
          ...ledgerBase,
          phase: "leased",
          status: "leased",
          atMs: decision.executionLease.issuedAtMs,
          leaseId: decision.executionLease.leaseId,
        },
      ]);
      if (!prepared) return safeFailure("invalid-native-evidence", currentRevision());
      if (
        expectedRevision !== currentRevision() ||
        decision.expectedStateRevision !== approvalState.revision ||
        decision.authorizationState.revision !== approvalState.revision + 1
      ) return safeFailure("stale-authority-revision", currentRevision());
      usedEvidenceIds.add(authenticated.evidenceId);
      approvalState = decision.authorizationState;
      ownedLeases.set(decision.executionLease.leaseId, { lease: decision.executionLease, action: intent.action });
      commitLedgerEntries(prepared);
      authorityRevision += 1;
      return Object.freeze({
        accepted: true,
        reason: "authorized",
        revision: currentRevision(),
        status: decision.status,
        leaseId: decision.executionLease.leaseId,
      });
    },

    start(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult {
      const authenticated = authenticate(rawEvidence, expectedRevision, "start");
      if ("accepted" in authenticated) return authenticated;
      if (expectedRevision !== currentRevision()) return safeFailure("stale-authority-revision", currentRevision());
      const payload = jsonRecord(authenticated.payload);
      if (!payload || !hasExactKeys(payload, ["leaseId", "attemptId", "observation", "startedAtMs"])) {
        return safeFailure("invalid-authority-payload", currentRevision());
      }
      if (
        typeof payload.leaseId !== "string" ||
        !OPAQUE_ID_PATTERN.test(payload.leaseId) ||
        typeof payload.attemptId !== "string" ||
        !OPAQUE_ID_PATTERN.test(payload.attemptId) ||
        typeof payload.startedAtMs !== "number" ||
        !Number.isFinite(payload.startedAtMs) ||
        payload.startedAtMs < authenticated.observedAtMs
      ) return safeFailure("invalid-authority-payload", currentRevision());
      const owned = ownedLeases.get(payload.leaseId);
      if (!owned) return safeFailure("lease-not-owned", currentRevision());
      if (activeAttempts.has(payload.attemptId)) return safeFailure("attempt-already-active", currentRevision());
      const observation = decodeBrowserWorkerObservation(payload.observation);
      if (!observation) return safeFailure("invalid-authority-payload", currentRevision());
      const lease = owned.lease;
      const consumed = consumeBrowserExecutionLease(approvalState, lease, payload.observation, payload.startedAtMs);
      if (!consumed.accepted) return safeFailure("lease-start-rejected", currentRevision());
      const prepared = prepareLedgerEntries([{
        phase: "running",
        status: "running",
        atMs: payload.startedAtMs,
        nativeEvidenceId: authenticated.evidenceId,
        intentId: lease.intentId,
        decisionId: lease.decisionId,
        leaseId: lease.leaseId,
        attemptId: payload.attemptId,
        actionType: owned.action.type,
        actionDigest: lease.actionDigest,
        scopeDigest: browserDecisionScopeDigest(lease.scope),
        scope: lease.scope,
      }]);
      if (!prepared) return safeFailure("invalid-native-evidence", currentRevision());
      if (
        expectedRevision !== currentRevision() ||
        consumed.expectedStateRevision !== approvalState.revision ||
        consumed.state.revision !== approvalState.revision + 1
      ) return safeFailure("stale-authority-revision", currentRevision());
      usedEvidenceIds.add(authenticated.evidenceId);
      approvalState = consumed.state;
      ownedLeases.delete(lease.leaseId);
      activeAttempts.set(payload.attemptId, {
        attemptId: payload.attemptId,
        lease,
        observation,
        action: owned.action,
        startedAtMs: payload.startedAtMs,
      });
      commitLedgerEntries(prepared);
      authorityRevision += 1;
      return Object.freeze({
        accepted: true,
        reason: "started",
        revision: currentRevision(),
        attemptId: payload.attemptId,
        leaseId: lease.leaseId,
      });
    },

    complete(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult {
      const authenticated = authenticate(rawEvidence, expectedRevision, "complete");
      if ("accepted" in authenticated) return authenticated;
      if (expectedRevision !== currentRevision()) return safeFailure("stale-authority-revision", currentRevision());
      const payload = jsonRecord(authenticated.payload);
      const required = [
        "attemptId", "leaseId", "decisionId", "actionDigest", "scopeDigest", "target",
        "brokerEpoch", "workerEpoch", "readinessEpoch", "status", "completedAtMs",
      ];
      if (!payload || !hasClosedKeys(payload, required, ["navigation", "capture", "lastError"])) {
        return safeFailure("invalid-authority-payload", currentRevision());
      }
      if (typeof payload.attemptId !== "string" || !OPAQUE_ID_PATTERN.test(payload.attemptId)) {
        return safeFailure("invalid-authority-payload", currentRevision());
      }
      const attempt = activeAttempts.get(payload.attemptId);
      if (!attempt) return safeFailure("attempt-not-owned", currentRevision());
      const target = decodeTarget(payload.target);
      const lease = attempt.lease;
      if (
        typeof payload.leaseId !== "string" || payload.leaseId !== lease.leaseId ||
        typeof payload.decisionId !== "string" || payload.decisionId !== lease.decisionId ||
        typeof payload.actionDigest !== "string" || payload.actionDigest !== lease.actionDigest ||
        typeof payload.scopeDigest !== "string" || payload.scopeDigest !== browserDecisionScopeDigest(lease.scope) ||
        !target || !sameTarget(target, lease.scope.target) ||
        payload.brokerEpoch !== lease.brokerEpoch || payload.workerEpoch !== lease.workerEpoch ||
        payload.readinessEpoch !== lease.readinessEpoch
      ) return safeFailure("completion-binding-mismatch", currentRevision());
      if (
        (payload.status !== "succeeded" && payload.status !== "failed" && payload.status !== "outcome_unknown") ||
        typeof payload.completedAtMs !== "number" || !Number.isFinite(payload.completedAtMs) ||
        payload.completedAtMs < attempt.startedAtMs || payload.completedAtMs !== authenticated.observedAtMs ||
        (payload.lastError !== undefined && (typeof payload.lastError !== "string" || payload.lastError.length > 500))
      ) return safeFailure("completion-proof-invalid", currentRevision());

      if (payload.status === "succeeded" && NAVIGATION_ACTIONS.has(attempt.action.type)) {
        const navigation = jsonRecord(payload.navigation);
        if (!navigation || !hasClosedKeys(navigation, ["finalObservation", "redirectChain"], ["popupTarget"])) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        const finalObservation = decodeBrowserWorkerObservation(navigation.finalObservation);
        if (!finalObservation || finalObservation.actionType !== attempt.action.type ||
            finalObservation.observedAtMs < attempt.startedAtMs ||
            finalObservation.observedAtMs > payload.completedAtMs ||
            finalObservation.observationId === attempt.observation.observationId ||
            finalObservation.trustedMode !== lease.scope.trustedMode ||
            !sameProfile(finalObservation.profile, lease.scope.profile) ||
            finalObservation.brokerEpoch !== lease.brokerEpoch || finalObservation.workerEpoch !== lease.workerEpoch ||
            finalObservation.readinessEpoch !== lease.readinessEpoch ||
            !finalObservation.dns.every((dns) => dns.brokerEpoch === lease.brokerEpoch && dns.workerEpoch === lease.workerEpoch && dns.readinessEpoch === lease.readinessEpoch) ||
            !validRedirectChain(navigation.redirectChain, attempt.action)) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        let finalHost: string;
        try { finalHost = new URL(finalObservation.currentUrl).hostname.toLowerCase(); } catch {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        const finalDns = finalObservation.dns.filter((dns) => dns.host === finalHost);
        if (finalDns.length !== 1 || finalDns[0]!.resolvedAtMs > finalObservation.observedAtMs || finalDns[0]!.expiresAtMs <= finalObservation.observedAtMs) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        if (attempt.action.type === "popup") {
          const popupTarget = decodeTarget(navigation.popupTarget);
          if (
            !popupTarget ||
            !sameTarget(popupTarget, finalObservation.target) ||
            popupTarget.sessionId !== lease.scope.target.sessionId ||
            popupTarget.tabId === lease.scope.target.tabId ||
            popupTarget.targetId === lease.scope.target.targetId ||
            finalObservation.parentFrameId !== undefined ||
            finalObservation.documentId === attempt.observation.documentId ||
            finalObservation.frameId === attempt.observation.frameId ||
            finalObservation.navigationId === attempt.observation.navigationId
          ) return safeFailure("completion-proof-invalid", currentRevision());
        } else if (!sameTarget(finalObservation.target, lease.scope.target) || navigation.popupTarget !== undefined) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        const expectedUrl = navigationDestination(attempt.action);
        if (expectedUrl === null || finalObservation.currentUrl !== expectedUrl || finalObservation.requestedUrl !== expectedUrl) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
        if (attempt.action.type === "frame" && finalObservation.parentFrameId === undefined) {
          return safeFailure("completion-proof-invalid", currentRevision());
        }
      } else if (payload.navigation !== undefined) {
        return safeFailure("completion-proof-invalid", currentRevision());
      }

      if (payload.status === "succeeded" && attempt.action.type === "screenshot") {
        if (!validCaptureProof(payload.capture, lease)) return safeFailure("capture-proof-invalid", currentRevision());
      } else if (payload.capture !== undefined) {
        return safeFailure("capture-proof-invalid", currentRevision());
      }

      const prepared = prepareLedgerEntries([{
        phase: "terminal",
        status: payload.status,
        atMs: payload.completedAtMs,
        nativeEvidenceId: authenticated.evidenceId,
        intentId: lease.intentId,
        decisionId: lease.decisionId,
        leaseId: lease.leaseId,
        attemptId: attempt.attemptId,
        actionType: attempt.action.type,
        actionDigest: lease.actionDigest,
        scopeDigest: browserDecisionScopeDigest(lease.scope),
        scope: lease.scope,
        completionDigest: sha256Digest(canonicalBrowserJson(authenticated as unknown as BrowserJsonValue)),
      }]);
      if (!prepared) return safeFailure("invalid-native-evidence", currentRevision());
      if (expectedRevision !== currentRevision()) return safeFailure("stale-authority-revision", currentRevision());
      usedEvidenceIds.add(authenticated.evidenceId);
      activeAttempts.delete(attempt.attemptId);
      commitLedgerEntries(prepared);
      authorityRevision += 1;
      return Object.freeze({
        accepted: true,
        reason: "completed",
        revision: currentRevision(),
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
      });
    },

    snapshot(): BrowserAuthoritySnapshot {
      return Object.freeze({
        revision: currentRevision(),
        activeLeaseIds: Object.freeze([...ownedLeases.keys()]),
        activeAttemptIds: Object.freeze([...activeAttempts.keys()]),
        ledger: Object.freeze([...ledger]),
      });
    },
  });
}
