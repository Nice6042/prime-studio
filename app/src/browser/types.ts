export const BROWSER_CONTRACT_VERSION = 2 as const;

export type BrowserActor = "agent" | "user";
export type BrowserProfileMode = "isolated" | "reused";
export type BrowserTrustedMode = "untrusted" | "trusted";
export type BrowserCaptureRedaction = "none" | "sensitive";

export interface BrowserBinding {
  readonly accountId: string;
  readonly projectId: string;
}

/** Stable browser target plus its current navigation epoch. */
export interface BrowserTargetIdentity {
  readonly sessionId: string;
  readonly tabId: string;
  readonly targetId: string;
  readonly epoch: number;
}

export interface BrowserAuthorityEpochs {
  readonly brokerEpoch: number;
  readonly workerEpoch: number;
  readonly readinessEpoch: number;
}

export interface BrowserOrigin {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
}

/** Origin rules normalize to exact scheme + host + effective port tuples. */
export type BrowserOriginRule = string | BrowserOrigin;

export interface BrowserProfileIntent extends BrowserBinding {
  readonly profileId: string;
  readonly mode: BrowserProfileMode;
}

export interface ReusableBrowserProfile {
  readonly profileId: string;
  readonly binding: BrowserBinding;
}

export type BrowserAction =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "redirect"; readonly fromUrl: string; readonly toUrl: string }
  | { readonly type: "popup"; readonly openerUrl: string; readonly url: string }
  | { readonly type: "frame"; readonly parentUrl: string; readonly url: string }
  | { readonly type: "download"; readonly url: string; readonly filename: string }
  | { readonly type: "upload"; readonly url: string; readonly fileCapabilityId: string }
  | {
      readonly type: "screenshot";
      readonly pageUrl: string;
      readonly target: "viewport" | "element";
      readonly redaction: BrowserCaptureRedaction;
      readonly selector?: string;
    }
  | {
      readonly type: "selector";
      readonly pageUrl: string;
      readonly selector: string;
      readonly operation: "inspect" | "click" | "type" | "submit";
      readonly text?: string;
    }
  | {
      readonly type: "coordinate";
      readonly pageUrl: string;
      readonly operation: "move" | "click" | "doubleClick" | "drag";
      readonly x: number;
      readonly y: number;
      readonly endX?: number;
      readonly endY?: number;
      readonly viewport: { readonly width: number; readonly height: number };
    }
  | {
      readonly type: "clipboard";
      readonly pageUrl: string;
      readonly operation: "read" | "write";
      readonly text?: string;
    }
  | {
      readonly type: "takeover";
      readonly operation: "request";
      readonly takeoverId: string;
      readonly reason: string;
    }
  | {
      readonly type: "takeover";
      readonly operation: "release";
      readonly takeoverId: string;
      readonly takeoverIntentId: string;
      readonly reason: string;
    };

export type BrowserActionType = BrowserAction["type"];

export interface BrowserCapabilityIntent {
  readonly intentId: string;
  readonly principalId: string;
  readonly actor: BrowserActor;
  readonly requestedAtMs: number;
  readonly binding: BrowserBinding;
  readonly profile: BrowserProfileIntent;
  readonly target: BrowserTargetIdentity;
  readonly policyEpoch: number;
  readonly approvalEpoch: number;
  readonly action: BrowserAction;
}

export interface BrowserPolicy {
  readonly allowedOrigins?: readonly BrowserOriginRule[];
  /** Compatibility spelling; entries are still exact origins, never host globs. */
  readonly allowedDomains?: readonly BrowserOriginRule[];
  readonly allowNavigation?: boolean;
  readonly allowRedirects?: boolean;
  readonly allowedRedirectOrigins?: readonly BrowserOriginRule[];
  readonly allowPopups?: boolean;
  readonly allowedPopupOrigins?: readonly BrowserOriginRule[];
  readonly allowFrames?: boolean;
  readonly allowedFrameOrigins?: readonly BrowserOriginRule[];
  readonly allowCrossOriginFrames?: boolean;
  readonly allowDownloads?: boolean;
  readonly allowedDownloadOrigins?: readonly BrowserOriginRule[];
  readonly allowUploads?: boolean;
  readonly allowedUploadOrigins?: readonly BrowserOriginRule[];
  readonly maxUploadBytes?: number;
  readonly allowScreenshots?: boolean;
  readonly sensitiveOrigins?: readonly BrowserOriginRule[];
  readonly requireCaptureRedaction?: boolean;
  readonly allowSelectorActions?: boolean;
  readonly allowCoordinateActions?: boolean;
  readonly allowClipboard?: boolean;
  readonly allowTakeover?: boolean;
  readonly allowReusedProfiles?: boolean;
  readonly reusableProfiles?: readonly ReusableBrowserProfile[];
  readonly approvalRequiredFor?: readonly BrowserActionType[];
}

/** DNS result observed by the worker and pinned into one execution lease. */
export interface BrowserDnsIdentity extends BrowserAuthorityEpochs {
  readonly resolutionId: string;
  readonly host: string;
  readonly addresses: readonly string[];
  readonly resolvedAtMs: number;
  readonly expiresAtMs: number;
}

/** Current browser state reported by the worker, never by the capability intent. */
export interface BrowserWorkerObservation extends BrowserAuthorityEpochs {
  readonly observationId: string;
  readonly actionType: BrowserActionType;
  readonly target: BrowserTargetIdentity;
  readonly profile: BrowserProfileIntent;
  readonly trustedMode: BrowserTrustedMode;
  readonly observedAtMs: number;
  readonly documentId: string;
  readonly navigationId: string;
  readonly frameId: string;
  readonly parentFrameId?: string;
  readonly currentUrl: string;
  readonly currentOrigin: BrowserOrigin;
  readonly requestedUrl?: string;
  readonly preStateDigest: string;
  readonly dns: readonly BrowserDnsIdentity[];
}

/** Collision-resistant values minted by the broker for exactly one decision. */
export interface BrowserBrokerEvidence extends BrowserAuthorityEpochs {
  readonly evidenceId: string;
  readonly decisionId: string;
  readonly leaseId: string;
  readonly intentDigest: string;
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly observationDigest: string;
  readonly uploadCapabilityDigest?: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** Opaque broker-owned file reference; intent input never supplies its metadata. */
export interface BrowserUploadFileCapability extends BrowserAuthorityEpochs {
  readonly capabilityId: string;
  readonly evidenceId: string;
  readonly principalId: string;
  readonly binding: BrowserBinding;
  readonly profile: BrowserProfileIntent;
  readonly target: BrowserTargetIdentity;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface BrowserApprovalGrant extends BrowserAuthorityEpochs {
  readonly approvalId: string;
  readonly intentId: string;
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly observationDigest: string;
  readonly target: BrowserTargetIdentity;
  readonly profile: BrowserProfileIntent;
  readonly trustedMode: BrowserTrustedMode;
  readonly principalId: string;
  readonly binding: BrowserBinding;
  readonly policyEpoch: number;
  readonly approvalEpoch: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface BrowserDecisionScope extends BrowserAuthorityEpochs {
  readonly principalId: string;
  readonly binding: BrowserBinding;
  readonly profile: BrowserProfileIntent;
  readonly target: BrowserTargetIdentity;
  readonly trustedMode: BrowserTrustedMode;
  readonly policyEpoch: number;
  readonly approvalEpoch: number;
  readonly policyDigest: string;
  readonly observationDigest: string;
}

export interface BrowserExecutionLease extends BrowserAuthorityEpochs {
  readonly leaseId: string;
  readonly evidenceId: string;
  readonly decisionId: string;
  readonly intentId: string;
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly observationDigest: string;
  readonly scope: BrowserDecisionScope;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly singleUse: true;
  readonly approvalId?: string;
  readonly uploadCapabilityId?: string;
  readonly uploadCapabilityDigest?: string;
  readonly capture?: {
    readonly sensitiveOrigin: boolean;
    readonly redaction: BrowserCaptureRedaction;
  };
}

export interface BrowserApprovalState {
  readonly revision: number;
  readonly grants: readonly BrowserApprovalGrant[];
  readonly consumedApprovalIds: readonly string[];
  readonly revokedApprovalIds: readonly string[];
  readonly activeLeases: readonly BrowserExecutionLease[];
  readonly consumedLeaseIds: readonly string[];
  readonly consumedUploadCapabilityIds: readonly string[];
}

export interface PromptInjectionEvidence {
  readonly evidenceId: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly source: "page" | "frame" | "download" | "tool" | "user-report";
  readonly summary: string;
  readonly observedAtMs: number;
}

export interface ActiveBrowserTakeover {
  readonly takeoverId: string;
  readonly intentId: string;
  readonly principalId: string;
  readonly target: BrowserTargetIdentity;
}

export interface BrowserPolicyContext extends BrowserAuthorityEpochs {
  readonly binding: BrowserBinding;
  readonly principalId: string;
  readonly target: BrowserTargetIdentity;
  readonly policy: BrowserPolicy;
  readonly policyEpoch: number;
  readonly approvalEpoch: number;
  readonly trustedMode: BrowserTrustedMode;
  readonly nowMs: number;
  readonly brokerEvidence: BrowserBrokerEvidence;
  readonly workerObservation: BrowserWorkerObservation;
  readonly approvalState: BrowserApprovalState;
  readonly uploadFileCapabilities?: readonly BrowserUploadFileCapability[];
  readonly promptInjectionEvidence?: readonly PromptInjectionEvidence[];
  readonly activeTakeover?: ActiveBrowserTakeover;
}

export type BrowserPolicyStatus = "allowed" | "denied" | "approval_required";

export type BrowserPolicyReason =
  | "allowed"
  | "default-deny"
  | "invalid-intent"
  | "invalid-context"
  | "invalid-broker-evidence"
  | "broker-evidence-mismatch"
  | "account-binding-mismatch"
  | "project-binding-mismatch"
  | "principal-mismatch"
  | "target-identity-mismatch"
  | "stale-target-epoch"
  | "stale-policy-epoch"
  | "stale-approval-epoch"
  | "stale-broker-epoch"
  | "stale-worker-epoch"
  | "stale-readiness-epoch"
  | "profile-binding-mismatch"
  | "reused-profile-not-authorized"
  | "isolated-profile-reuse"
  | "worker-observation-mismatch"
  | "dns-identity-mismatch"
  | "unsupported-url"
  | "domain-not-allowed"
  | "redirect-not-allowed"
  | "popup-not-allowed"
  | "frame-not-allowed"
  | "cross-origin-frame-not-allowed"
  | "unsafe-filename"
  | "missing-upload-capability"
  | "invalid-upload-capability"
  | "expired-upload-capability"
  | "upload-capability-used"
  | "upload-too-large"
  | "invalid-selector"
  | "invalid-coordinate"
  | "clipboard-not-allowed"
  | "invalid-clipboard"
  | "capture-redaction-required"
  | "sensitive-origin-capture"
  | "takeover-active"
  | "no-active-takeover"
  | "takeover-release-mismatch"
  | "invalid-takeover-reason"
  | "prompt-injection-evidence"
  | "approval-required"
  | "approval-invalid"
  | "approval-expired"
  | "approval-used"
  | "approval-revoked"
  | "authorization-replay";

export interface BrowserPolicyDecision {
  readonly decisionId: string;
  readonly intentId: string;
  readonly actionDigest: string;
  readonly status: BrowserPolicyStatus;
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reason: BrowserPolicyReason;
  readonly evidenceIds: readonly string[];
  readonly issuedAtMs: number;
  readonly scope?: BrowserDecisionScope;
  readonly scopeDigest?: string;
  readonly approvalId?: string;
  readonly executionLease?: BrowserExecutionLease;
  /** Caller must commit this transition only if its stored revision equals this value. */
  readonly expectedStateRevision: number;
  readonly authorizationState: BrowserApprovalState;
}

export type BrowserLeaseConsumeReason =
  | "consumed"
  | "invalid-state"
  | "invalid-lease"
  | "lease-not-active"
  | "lease-used"
  | "lease-expired"
  | "worker-observation-mismatch"
  | "stale-broker-epoch"
  | "stale-worker-epoch"
  | "stale-readiness-epoch";

export interface BrowserLeaseConsumeResult {
  readonly accepted: boolean;
  readonly reason: BrowserLeaseConsumeReason;
  readonly expectedStateRevision: number;
  readonly state: BrowserApprovalState;
}
