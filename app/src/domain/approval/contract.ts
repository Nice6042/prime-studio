export const CAPABILITY_ACTIONS = [
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
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];
export type CapabilityScope = "once" | "session" | "persistent";
export type RiskSeverity = "low" | "medium" | "high" | "critical";

export interface CapabilityTarget<A extends CapabilityAction = CapabilityAction> {
  readonly action: A;
  /**
   * One concrete resource identity from the trusted adapter for `action`.
   * This is never a glob, template, selector, or executor command language.
   */
  readonly value: string;
}

export interface CapabilityRisk {
  readonly severity: RiskSeverity;
  /** Policy-owned identifier; equality is byte-exact. */
  readonly fingerprint: string;
}

export interface CapabilityBinding {
  readonly principalId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly policyId: string;
  readonly epoch: number;
}

export interface CapabilityClaim<E extends VerifiedAdapterEvidence = VerifiedAdapterEvidence> {
  readonly scope: CapabilityScope;
  readonly action: CapabilityAction;
  readonly target: CapabilityTarget;
  readonly risk: CapabilityRisk;
  readonly binding: CapabilityBinding;
  readonly evidence: E;
}

export interface CapabilityGrant extends CapabilityClaim<VerifiedGrantEvidence> {
  readonly id: string;
  readonly approvalId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CapabilityAttempt extends CapabilityClaim<VerifiedAttemptEvidence> {
  readonly id: string;
  readonly grantId: string;
}

declare const argumentsDigestBrand: unique symbol;
/**
 * Digest supplied independently for both grant and attempt. The trusted
 * executor adapter must SHA-256 the same canonical argument encoding at both
 * boundaries; this no-executor domain validates the wire form and compares it.
 */
export type ArgumentsDigest = string & { readonly [argumentsDigestBrand]: true };

export interface AdapterVerificationInput<A extends CapabilityAction = CapabilityAction> {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly action: A;
  readonly candidateTarget: unknown;
  /** Canonical immutable executor arguments. These exact UTF-8 bytes are hashed. */
  readonly canonicalArguments: string;
}

export interface TrustedAdapterDefinition<A extends CapabilityAction = CapabilityAction> {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly action: A;
  /** Executor-specific validator installed once into the closed registry. */
  readonly validateTarget: (candidate: unknown) => CapabilityTarget<A>;
}

declare const verifiedAdapterEvidenceBrand: unique symbol;
export type VerifiedAdapterEvidence = Readonly<
  {
    readonly kind: "verified-adapter-evidence";
    readonly phase: "grant" | "attempt";
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly action: CapabilityAction;
    readonly target: CapabilityTarget;
    readonly argumentsDigest: ArgumentsDigest;
  }
> & { readonly [verifiedAdapterEvidenceBrand]: true };

export type VerifiedGrantEvidence = VerifiedAdapterEvidence & { readonly phase: "grant" };
export type VerifiedAttemptEvidence = VerifiedAdapterEvidence & { readonly phase: "attempt" };

export interface ApprovalContract {
  readonly createCapabilityGrant: (input: CapabilityGrant) => CapabilityGrant;
  readonly createCapabilityAttempt: (input: CapabilityAttempt) => CapabilityAttempt;
}

export interface TrustedAdapterMint {
  readonly grantEvidence: (input: AdapterVerificationInput) => VerifiedGrantEvidence;
  readonly attemptEvidence: (input: AdapterVerificationInput) => VerifiedAttemptEvidence;
}

export interface TrustedAdapterAuthority {
  /** Give only this verifier capability to the approval reducer. */
  readonly contract: ApprovalContract;
  /** Keep this mint capability inside trusted approval/executor adapters. */
  readonly mint: TrustedAdapterMint;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SCOPES: readonly CapabilityScope[] = ["once", "session", "persistent"];
const SEVERITIES: readonly RiskSeverity[] = ["low", "medium", "high", "critical"];

const exactIdentifier = (value: string, label: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a non-empty exact identifier`);
  }
  return value;
};

const exactTimestamp = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer timestamp`);
  }
  return value;
};

function normalizeArgumentsDigest(value: string): ArgumentsDigest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new TypeError("Arguments digest must be canonical lowercase SHA-256");
  }
  return value as ArgumentsDigest;
}

const rotateRight = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upperSigma1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

const snapshotClaim = <E extends VerifiedAdapterEvidence>(
  input: CapabilityClaim<E>,
  label: string,
  phase: E["phase"],
  verifiedEvidence: WeakSet<object>,
): CapabilityClaim<E> => {
  const scope = input.scope;
  const action = input.action;
  const targetInput = input.target;
  const riskInput = input.risk;
  const bindingInput = input.binding;
  const evidenceInput = input.evidence;
  if (
    typeof evidenceInput !== "object" ||
    evidenceInput === null ||
    !verifiedEvidence.has(evidenceInput)
  ) {
    throw new TypeError(`${label} adapter evidence is not verified`);
  }
  const targetAction = targetInput.action;
  const targetValue = targetInput.value;
  const riskSeverity = riskInput.severity;
  const riskFingerprint = riskInput.fingerprint;
  const principalId = bindingInput.principalId;
  const accountId = bindingInput.accountId;
  const projectId = bindingInput.projectId;
  const sessionId = bindingInput.sessionId;
  const policyId = bindingInput.policyId;
  const epoch = bindingInput.epoch;
  const evidenceKind = evidenceInput.kind;
  const evidencePhase = evidenceInput.phase;
  const evidenceAction = evidenceInput.action;
  const evidenceTarget = evidenceInput.target;

  if (!CAPABILITY_ACTIONS.includes(action)) {
    throw new TypeError(`${label} action is not a recognized capability action`);
  }
  if (!SCOPES.includes(scope)) {
    throw new TypeError(`${label} scope is not recognized`);
  }
  if (targetAction !== action) {
    throw new TypeError(`${label} action and target action must match exactly`);
  }
  const target = normalizeTarget(action, targetValue);
  if (evidenceKind !== "verified-adapter-evidence" || evidencePhase !== phase) {
    throw new TypeError(`${label} adapter evidence phase is not verified`);
  }
  if (
    evidenceAction !== action ||
    evidenceTarget.action !== target.action ||
    evidenceTarget.value !== target.value
  ) {
    throw new TypeError(`${label} adapter evidence must bind the exact action and target`);
  }
  if (!SEVERITIES.includes(riskSeverity) || !riskFingerprint) {
    throw new TypeError(`${label} risk must have an exact severity and fingerprint`);
  }
  const risk = Object.freeze({
    severity: riskSeverity,
    fingerprint: exactIdentifier(riskFingerprint, `${label} risk fingerprint`),
  });
  const binding = Object.freeze({
    principalId: exactIdentifier(principalId, `${label} binding principal`),
    accountId: exactIdentifier(accountId, `${label} binding account`),
    projectId: exactIdentifier(projectId, `${label} binding project`),
    sessionId: exactIdentifier(sessionId, `${label} binding session`),
    policyId: exactIdentifier(policyId, `${label} binding policy`),
    epoch,
  });
  if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 0) {
    throw new TypeError(`${label} binding epoch must be a non-negative integer`);
  }
  return Object.freeze({
    scope,
    action,
    target,
    risk,
    binding,
    evidence: evidenceInput,
  });
};

/**
 * Creates one closed registry. The trusted bootstrap retains `mint`; the
 * authoritative reducer receives only `contract`. Evidence from any other
 * registry instance, or from the wrong phase, is rejected by object identity.
 */
export function createTrustedAdapterAuthority(
  definitions: readonly TrustedAdapterDefinition[],
): TrustedAdapterAuthority {
  const adapters = new Map<string, TrustedAdapterDefinition>();
  for (const input of definitions) {
    const adapterId = exactIdentifier(input.adapterId, "Trusted adapter id");
    const adapterVersion = exactIdentifier(input.adapterVersion, "Trusted adapter version");
    const action = input.action;
    const validateTarget = input.validateTarget;
    if (!CAPABILITY_ACTIONS.includes(action) || typeof validateTarget !== "function") {
      throw new TypeError("Trusted adapter definition is invalid");
    }
    const key = JSON.stringify([adapterId, adapterVersion, action]);
    if (adapters.has(key)) throw new TypeError("Trusted adapter definition is duplicated");
    adapters.set(key, Object.freeze({ adapterId, adapterVersion, action, validateTarget }));
  }
  const grantEvidence = new WeakSet<object>();
  const attemptEvidence = new WeakSet<object>();
  const grantClaims = new WeakMap<object, string>();
  const attemptClaims = new WeakMap<object, string>();

  const bindClaim = (
    claims: WeakMap<object, string>,
    evidence: VerifiedAdapterEvidence,
    fingerprint: string,
  ): void => {
    const existing = claims.get(evidence);
    if (existing !== undefined && existing !== fingerprint) {
      throw new TypeError("Adapter evidence cannot be replayed for a different phase claim");
    }
    claims.set(evidence, fingerprint);
  };

  const mintEvidence = (
    phase: "grant" | "attempt",
    input: AdapterVerificationInput,
  ): VerifiedAdapterEvidence => {
    const adapterId = input.adapterId;
    const adapterVersion = input.adapterVersion;
    const action = input.action;
    const candidateTarget = input.candidateTarget;
    const canonicalArguments = input.canonicalArguments;
    if (typeof canonicalArguments !== "string") {
      throw new TypeError("Canonical arguments must be an immutable string");
    }
    const definition = adapters.get(JSON.stringify([adapterId, adapterVersion, action]));
    if (!definition) throw new TypeError("Adapter is not in the closed trusted registry");
    const targetInput = definition.validateTarget(candidateTarget);
    const targetAction = targetInput.action;
    const targetValue = targetInput.value;
    if (targetAction !== action) {
      throw new TypeError("Adapter evidence action and target action must match exactly");
    }
    const evidence = {
      kind: "verified-adapter-evidence" as const,
      phase,
      adapterId: definition.adapterId,
      adapterVersion: definition.adapterVersion,
      action,
      target: normalizeTarget(action, targetValue),
      argumentsDigest: normalizeArgumentsDigest(`sha256:${sha256Hex(canonicalArguments)}`),
    };
    (phase === "grant" ? grantEvidence : attemptEvidence).add(evidence);
    return Object.freeze(evidence) as unknown as VerifiedAdapterEvidence;
  };

  const createCapabilityGrant = (input: CapabilityGrant): CapabilityGrant => {
    const claim = snapshotClaim(input, "Grant", "grant", grantEvidence);
    const issuedAt = exactTimestamp(input.issuedAt, "Grant issue time");
    const expiresAt = exactTimestamp(input.expiresAt, "Grant expiry");
    if (expiresAt <= issuedAt) {
      throw new TypeError("Grant expiry must be later than its issue time");
    }
    const grant = Object.freeze({
      id: exactIdentifier(input.id, "Grant id"),
      approvalId: exactIdentifier(input.approvalId, "Approval id"),
      ...claim,
      issuedAt,
      expiresAt,
    }) as CapabilityGrant;
    bindClaim(
      grantClaims,
      grant.evidence,
      JSON.stringify([
        grant.id,
        grant.approvalId,
        grant.scope,
        grant.action,
        grant.target.action,
        grant.target.value,
        grant.risk.severity,
        grant.risk.fingerprint,
        grant.binding.principalId,
        grant.binding.accountId,
        grant.binding.projectId,
        grant.binding.sessionId,
        grant.binding.policyId,
        grant.binding.epoch,
        grant.evidence.adapterId,
        grant.evidence.adapterVersion,
        grant.evidence.argumentsDigest,
        grant.issuedAt,
        grant.expiresAt,
      ]),
    );
    return grant;
  };

  const createCapabilityAttempt = (input: CapabilityAttempt): CapabilityAttempt => {
    const claim = snapshotClaim(input, "Attempt", "attempt", attemptEvidence);
    const attempt = Object.freeze({
      id: exactIdentifier(input.id, "Attempt id"),
      grantId: exactIdentifier(input.grantId, "Grant id"),
      ...claim,
    }) as CapabilityAttempt;
    bindClaim(
      attemptClaims,
      attempt.evidence,
      JSON.stringify([
        attempt.id,
        attempt.grantId,
        attempt.scope,
        attempt.action,
        attempt.target.action,
        attempt.target.value,
        attempt.risk.severity,
        attempt.risk.fingerprint,
        attempt.binding.principalId,
        attempt.binding.accountId,
        attempt.binding.projectId,
        attempt.binding.sessionId,
        attempt.binding.policyId,
        attempt.binding.epoch,
        attempt.evidence.adapterId,
        attempt.evidence.adapterVersion,
        attempt.evidence.argumentsDigest,
      ]),
    );
    return attempt;
  };

  const contract = Object.freeze({ createCapabilityGrant, createCapabilityAttempt });
  const mint = Object.freeze({
    grantEvidence: (input: AdapterVerificationInput) =>
      mintEvidence("grant", input) as VerifiedGrantEvidence,
    attemptEvidence: (input: AdapterVerificationInput) =>
      mintEvidence("attempt", input) as VerifiedAttemptEvidence,
  });
  return Object.freeze({ contract, mint });
}

const exactTarget = <A extends CapabilityAction>(action: A, value: string): CapabilityTarget<A> =>
  Object.freeze({ action, value });

/**
 * Targets deliberately keep their original bytes. Filesystem case-folding, URL
 * resolution, shell parsing, and similar "helpful" normalization can only make
 * a grant authorize more resources than the approver saw. Action adapters own
 * their concrete resource schema and must reject patterns before calling this
 * boundary; this function validates and snapshots their opaque identity.
 */
export function normalizeTarget<A extends CapabilityAction>(
  action: A,
  value: string,
): CapabilityTarget<A> {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("*")) {
    throw new TypeError("Capability target must identify one non-empty exact resource");
  }
  switch (action) {
    case "file":
      return exactTarget(action, value);
    case "shell":
      return exactTarget(action, value);
    case "network":
      return exactTarget(action, value);
    case "browser":
      return exactTarget(action, value);
    case "computer":
      return exactTarget(action, value);
    case "credentials":
      return exactTarget(action, value);
    case "messages":
      return exactTarget(action, value);
    case "download":
      return exactTarget(action, value);
    case "upload":
      return exactTarget(action, value);
    case "git":
      return exactTarget(action, value);
    case "package":
      return exactTarget(action, value);
    case "process":
      return exactTarget(action, value);
    default:
      throw new TypeError("Capability target action is not recognized");
  }
}
