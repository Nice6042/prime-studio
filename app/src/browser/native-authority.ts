import type {
  BrowserAction,
  BrowserDecisionScope,
  BrowserPolicyReason,
  BrowserPolicyStatus,
} from "./types";

export type NativeBrowserEvidenceKind = "authorize" | "start" | "complete";

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

export interface BrowserAuthoritySnapshot {
  readonly revision: number;
  readonly activeLeaseIds: readonly string[];
  readonly activeAttemptIds: readonly string[];
  readonly ledger: readonly BrowserAuthorityLedgerEntry[];
}

export interface NativeBrowserAuthority {
  authorize(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  start(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  complete(rawEvidence: unknown, expectedRevision: number): BrowserAuthorityResult;
  snapshot(): BrowserAuthoritySnapshot;
}

/**
 * Browser JavaScript cannot construct or inject the native evidence authenticator.
 * The native-owned bridge is not implemented yet, so production remains explicitly fail-closed.
 */
export const nativeBrowserAuthority: NativeBrowserAuthority | null = null;
