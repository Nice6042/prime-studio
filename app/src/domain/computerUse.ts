/**
 * Pure, fail-closed policy primitives for a brokered Windows computer-use
 * worker. The only stateful object is the broker capability: its WeakMap-held
 * key and lease table model the native broker boundary and make lease start a
 * synchronous compare-and-swap instead of a caller-owned context copy.
 */

export const COMPUTER_USE_POLICY_VERSION = 3 as const;

export const COMPUTER_USE_LIMITS = Object.freeze({
  maxTransportBytes: 24 * 1024,
  maxDecodeWork: 16_384,
  maxIdentifierBytes: 256,
  maxLabelBytes: 1_024,
  maxPathBytes: 8_192,
  maxTextBytes: 8_192,
  maxClipboardTextBytes: 8_192,
  maxScreenshotBytes: 16 * 1024 * 1024,
  maxCaptureBytes: 64 * 1024 * 1024,
  maxRetentionMs: 5 * 60_000,
  maxArguments: 64,
  maxArgumentBytes: 8_192,
  maxRuntimeIdItems: 64,
  maxMonitors: 32,
  maxApprovals: 256,
  maxAllowlistItems: 256,
  maxLedgerRecords: 4_096,
  maxTakeoverAcknowledgementMs: 30_000,
  maxTakeoverTerminationMs: 60_000,
  maxReadinessLifetimeMs: 30_000,
  maxApprovalLifetimeMs: 30_000,
  maxForegroundBindingMs: 5_000,
  maxUiObservationAgeMs: 2_000,
  maxLeaseFreshnessMs: 250,
});

type UnknownRecord = Record<string, unknown>;

interface DecodeBudget {
  remainingWork: number;
  remainingStringBytes: number;
}

const newBudget = (): DecodeBudget => ({
  remainingWork: COMPUTER_USE_LIMITS.maxDecodeWork,
  remainingStringBytes: COMPUTER_USE_LIMITS.maxCaptureBytes,
});

const spend = (budget: DecodeBudget, amount = 1): boolean => {
  if (!Number.isSafeInteger(amount) || amount < 0 || budget.remainingWork < amount) return false;
  budget.remainingWork -= amount;
  return true;
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const utf8 = new TextEncoder();

const parseBoundedJsonTransport = (value: unknown): unknown | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > COMPUTER_USE_LIMITS.maxTransportBytes) return null;
  if (utf8.encode(value).byteLength > COMPUTER_USE_LIMITS.maxTransportBytes) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const boundedString = (
  value: unknown,
  maxBytes: number,
  budget: DecodeBudget,
  allowEmpty = false,
): value is string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxBytes) return false;
  const bytes = utf8.encode(value).byteLength;
  if (bytes > maxBytes || bytes > budget.remainingStringBytes || !spend(budget, Math.max(1, Math.ceil(bytes / 64)))) return false;
  budget.remainingStringBytes -= bytes;
  return true;
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const positiveInteger = (value: unknown): value is number =>
  finiteNumber(value) && Number.isSafeInteger(value) && value > 0;

const nonNegativeInteger = (value: unknown): value is number =>
  finiteNumber(value) && Number.isSafeInteger(value) && value >= 0;

const readDataObject = (
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  budget: DecodeBudget,
): UnknownRecord | null => {
  try {
    if (!spend(budget) || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const ownKeys = Reflect.ownKeys(value);
    if (!spend(budget, ownKeys.length) || ownKeys.length > allowed.size) return null;
    if (requiredKeys.some((key) => !hasOwn(value, key))) return null;
    const result: UnknownRecord = {};
    for (const key of ownKeys) {
      if (typeof key !== "string" || !allowed.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
};

const readDiscriminant = (value: unknown, key: string, budget: DecodeBudget): unknown => {
  try {
    if (!spend(budget) || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const readDataArray = (
  value: unknown,
  maxItems: number,
  budget: DecodeBudget,
): readonly unknown[] | null => {
  try {
    if (!spend(budget) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !nonNegativeInteger(lengthDescriptor.value)) return null;
    const length = lengthDescriptor.value;
    if (length > maxItems || !spend(budget, length)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!hasOwn(value, key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || descriptor.enumerable !== true) return null;
      result.push(descriptor.value);
    }
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) return null;
    }
    return result;
  } catch {
    return null;
  }
};

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value && typeof value === "object") {
    const object = value as object;
    if (!seen.has(object)) {
      seen.add(object);
      for (const child of Object.values(object)) deepFreeze(child, seen);
      Object.freeze(object);
    }
  }
  return value;
};

const stableEncode = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "invalid-number";
  if (Array.isArray(value)) return `[${value.map(stableEncode).join(",")}]`;
  if (typeof value === "object") {
    const record = value as UnknownRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableEncode(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
};

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

const sha256Bytes = (input: Uint8Array): Uint8Array => {
  const bitLength = input.length * 8;
  const totalLength = Math.ceil((input.length + 9) / 64) * 64;
  const data = new Uint8Array(totalLength);
  data.set(input);
  data[input.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(totalLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(totalLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upper = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + upper + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const lower = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (lower + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((word, index) => outputView.setUint32(index * 4, word, false));
  return output;
};

const toHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = (value: string): string => `sha256:${toHex(sha256Bytes(utf8.encode(value)))}`;

const hmacSha256 = (key: Uint8Array, value: string): string => {
  let normalized = key;
  if (normalized.length > 64) normalized = sha256Bytes(normalized);
  const padded = new Uint8Array(64);
  padded.set(normalized);
  const innerPad = padded.map((byte) => byte ^ 0x36);
  const outerPad = padded.map((byte) => byte ^ 0x5c);
  const message = utf8.encode(value);
  const inner = new Uint8Array(innerPad.length + message.length);
  inner.set(innerPad);
  inner.set(message, innerPad.length);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(outerPad.length + innerHash.length);
  outer.set(outerPad);
  outer.set(innerHash, outerPad.length);
  return `hmac-sha256:${toHex(sha256Bytes(outer))}`;
};

const digestValue = (value: unknown): string => sha256(stableEncode(value));

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const randomBytes = (length: number): Uint8Array => {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("A cryptographic random source is required");
  const value = new Uint8Array(length);
  cryptoApi.getRandomValues(value);
  return value;
};

const sha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);

const digestText = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const evidenceText = (value: unknown): value is string =>
  typeof value === "string" && /^hmac-sha256:[0-9a-f]{64}$/.test(value);

export interface AuthorityBinding {
  readonly accountId: string;
  readonly projectId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly policyId: string;
  readonly brokerId: string;
  readonly workerId: string;
  readonly accountEpoch: number;
  readonly projectEpoch: number;
  readonly chatEpoch: number;
  readonly sessionEpoch: number;
  readonly principalEpoch: number;
  readonly policyEpoch: number;
  readonly brokerEpoch: number;
  readonly workerEpoch: number;
  readonly readinessEpoch: number;
}

const AUTHORITY_STRING_KEYS = ["accountId", "projectId", "chatId", "sessionId", "principalId", "policyId", "brokerId", "workerId"] as const;
const AUTHORITY_EPOCH_KEYS = ["accountEpoch", "projectEpoch", "chatEpoch", "sessionEpoch", "principalEpoch", "policyEpoch", "brokerEpoch", "workerEpoch", "readinessEpoch"] as const;
const AUTHORITY_KEYS = [...AUTHORITY_STRING_KEYS, ...AUTHORITY_EPOCH_KEYS] as const;

const decodeAuthority = (value: unknown, budget: DecodeBudget): AuthorityBinding | null => {
  const record = readDataObject(value, AUTHORITY_KEYS, [], budget);
  if (!record) return null;
  for (const key of AUTHORITY_STRING_KEYS) if (!boundedString(record[key], COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) return null;
  for (const key of AUTHORITY_EPOCH_KEYS) if (!positiveInteger(record[key])) return null;
  return deepFreeze({
    accountId: record.accountId as string,
    projectId: record.projectId as string,
    chatId: record.chatId as string,
    sessionId: record.sessionId as string,
    principalId: record.principalId as string,
    policyId: record.policyId as string,
    brokerId: record.brokerId as string,
    workerId: record.workerId as string,
    accountEpoch: record.accountEpoch as number,
    projectEpoch: record.projectEpoch as number,
    chatEpoch: record.chatEpoch as number,
    sessionEpoch: record.sessionEpoch as number,
    principalEpoch: record.principalEpoch as number,
    policyEpoch: record.policyEpoch as number,
    brokerEpoch: record.brokerEpoch as number,
    workerEpoch: record.workerEpoch as number,
    readinessEpoch: record.readinessEpoch as number,
  });
};

const sameAuthority = (left: AuthorityBinding, right: AuthorityBinding): boolean =>
  stableEncode(left) === stableEncode(right);

const authorityDigest = (authority: AuthorityBinding): string => digestValue(authority);

export interface ComputerUseBroker {
  readonly brokerId: string;
  readonly workerId: string;
  readonly instanceId: string;
  readonly authorityDigest: string;
}

type BrokerApprovalState = "active" | "leased" | "used" | "revoked";
type BrokerLeaseState = "leased" | "started" | "finished" | "revoked";

interface InternalApproval {
  readonly immutableDigest: string;
  state: BrokerApprovalState;
  leaseId: string | null;
}

interface InternalLease {
  readonly approvalId: string;
  readonly attemptId: string;
  readonly kind: ComputerUseIntentKind;
  readonly actionDigest: string;
  readonly targetDigest: string;
  readonly authorityDigest: string;
  readonly expiresAtMs: number;
  readonly leasedAtMs: number;
  readonly captureRect: Rect | null;
  readonly dataPolicy: DataHandlingPolicy | null;
  state: BrokerLeaseState;
  version: number;
}

interface BrokerState {
  readonly authority: AuthorityBinding;
  readonly authorityDigest: string;
  readonly instanceId: string;
  readonly key: Uint8Array;
  approvals: Map<string, InternalApproval>;
  leases: Map<string, InternalLease>;
  leaseCounter: number;
  ledgerCounter: number;
  takeoverEpoch: number;
  takeoverState: TakeoverState;
  trustedNowMs: number;
}

const brokerStates = new WeakMap<object, BrokerState>();
const nativeBrokerAuthorizations = new WeakSet<object>();
const trustedDecisionOwners = new WeakMap<object, object>();

interface NativeBridgeAuthenticator {
  verify(authorization: object): boolean;
}

const packagePrivateNativeAuthenticator: NativeBridgeAuthenticator = {
  verify: (authorization) => nativeBrokerAuthorizations.has(authorization),
};

const brokerState = (broker: ComputerUseBroker): BrokerState | null => {
  try {
    return broker && typeof broker === "object" ? brokerStates.get(broker as object) ?? null : null;
  } catch {
    return null;
  }
};

const brokerSign = (broker: ComputerUseBroker, domain: string, value: unknown): string => {
  const state = brokerState(broker);
  if (!state) return "";
  return hmacSha256(state.key, `${domain}\u0000${state.instanceId}\u0000${stableEncode(value)}`);
};

function createComputerUseBroker(value: AuthorityBinding, trustedNowMs: number, authorization: object, authenticator: NativeBridgeAuthenticator): ComputerUseBroker {
  if (!authenticator.verify(authorization)) throw new Error("Native computer-use broker evidence is required");
  const decoded = decodeAuthority(value, newBudget());
  if (!decoded || !nonNegativeInteger(trustedNowMs)) throw new RangeError("Broker authority or trusted time is invalid");
  const key = randomBytes(32);
  const nonce = randomBytes(32);
  const digest = authorityDigest(decoded);
  const instanceId = hmacSha256(key, `broker-instance\u0000${digest}\u0000${toHex(nonce)}`);
  const broker = deepFreeze({ brokerId: decoded.brokerId, workerId: decoded.workerId, instanceId, authorityDigest: digest });
  brokerStates.set(broker, {
    authority: decoded,
    authorityDigest: digest,
    instanceId,
    key,
    approvals: new Map(),
    leases: new Map(),
    leaseCounter: 0,
    ledgerCounter: 0,
    takeoverEpoch: 0,
    takeoverState: deepFreeze({ status: "idle", epoch: 0, lastEventAtMs: 0 }),
    trustedNowMs,
  });
  return broker;
}

export type SecurityReadinessStatus = "unavailable" | "admission_only" | "enforced";

export interface SecurityReadiness {
  readonly status: SecurityReadinessStatus;
  readonly policyVersion: typeof COMPUTER_USE_POLICY_VERSION;
  readonly brokerInstanceId: string;
  readonly authorityDigest: string;
  readonly checkedAtMs: number;
  readonly expiresAtMs: number;
  readonly runtimeSha256: string;
  readonly securityExtensionSha256: string;
  readonly brokerBinarySha256: string;
  readonly workerBinarySha256: string;
  readonly brokerEvidence: string;
}

export type SecurityReadinessOptions = Omit<SecurityReadiness, "policyVersion" | "brokerInstanceId" | "authorityDigest" | "brokerEvidence">;

const readinessSnapshot = (
  readiness: Omit<SecurityReadiness, "brokerEvidence"> | SecurityReadiness,
): unknown => ({
  status: readiness.status,
  policyVersion: readiness.policyVersion,
  brokerInstanceId: readiness.brokerInstanceId,
  authorityDigest: readiness.authorityDigest,
  checkedAtMs: readiness.checkedAtMs,
  expiresAtMs: readiness.expiresAtMs,
  runtimeSha256: readiness.runtimeSha256,
  securityExtensionSha256: readiness.securityExtensionSha256,
  brokerBinarySha256: readiness.brokerBinarySha256,
  workerBinarySha256: readiness.workerBinarySha256,
});

function createSecurityReadiness(broker: ComputerUseBroker, options: SecurityReadinessOptions): SecurityReadiness {
  const state = brokerState(broker);
  if (!state || !["unavailable", "admission_only", "enforced"].includes(options.status) || !nonNegativeInteger(options.checkedAtMs) || !nonNegativeInteger(options.expiresAtMs) || options.expiresAtMs <= options.checkedAtMs || options.expiresAtMs - options.checkedAtMs > COMPUTER_USE_LIMITS.maxReadinessLifetimeMs) {
    throw new RangeError("Security readiness is invalid");
  }
  for (const digest of [options.runtimeSha256, options.securityExtensionSha256, options.brokerBinarySha256, options.workerBinarySha256]) {
    if (!sha256Hex(digest)) throw new RangeError("Security readiness closure digest is invalid");
  }
  const unsigned = deepFreeze({
    status: options.status,
    policyVersion: COMPUTER_USE_POLICY_VERSION,
    brokerInstanceId: state.instanceId,
    authorityDigest: state.authorityDigest,
    checkedAtMs: options.checkedAtMs,
    expiresAtMs: options.expiresAtMs,
    runtimeSha256: options.runtimeSha256.toLowerCase(),
    securityExtensionSha256: options.securityExtensionSha256.toLowerCase(),
    brokerBinarySha256: options.brokerBinarySha256.toLowerCase(),
    workerBinarySha256: options.workerBinarySha256.toLowerCase(),
  });
  return deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "readiness-v1", readinessSnapshot(unsigned)) });
}

const decodeSecurityReadiness = (value: unknown, broker: ComputerUseBroker, budget: DecodeBudget): SecurityReadiness | null => {
  const record = readDataObject(value, ["status", "policyVersion", "brokerInstanceId", "authorityDigest", "checkedAtMs", "expiresAtMs", "runtimeSha256", "securityExtensionSha256", "brokerBinarySha256", "workerBinarySha256", "brokerEvidence"], [], budget);
  if (!record || typeof record.status !== "string" || !["unavailable", "admission_only", "enforced"].includes(record.status) || record.policyVersion !== COMPUTER_USE_POLICY_VERSION || !boundedString(record.brokerInstanceId, 128, budget) || !digestText(record.authorityDigest) || !nonNegativeInteger(record.checkedAtMs) || !nonNegativeInteger(record.expiresAtMs) || record.expiresAtMs <= record.checkedAtMs || record.expiresAtMs - record.checkedAtMs > COMPUTER_USE_LIMITS.maxReadinessLifetimeMs || !evidenceText(record.brokerEvidence)) return null;
  for (const key of ["runtimeSha256", "securityExtensionSha256", "brokerBinarySha256", "workerBinarySha256"] as const) if (!sha256Hex(record[key])) return null;
  const decoded = {
    status: record.status as SecurityReadinessStatus,
    policyVersion: COMPUTER_USE_POLICY_VERSION,
    brokerInstanceId: record.brokerInstanceId,
    authorityDigest: record.authorityDigest,
    checkedAtMs: record.checkedAtMs,
    expiresAtMs: record.expiresAtMs,
    runtimeSha256: (record.runtimeSha256 as string).toLowerCase(),
    securityExtensionSha256: (record.securityExtensionSha256 as string).toLowerCase(),
    brokerBinarySha256: (record.brokerBinarySha256 as string).toLowerCase(),
    workerBinarySha256: (record.workerBinarySha256 as string).toLowerCase(),
    brokerEvidence: record.brokerEvidence,
  } as const;
  const state = brokerState(broker);
  const expected = brokerSign(broker, "readiness-v1", readinessSnapshot(decoded));
  return state && decoded.brokerInstanceId === state.instanceId && decoded.authorityDigest === state.authorityDigest && constantTimeEqual(decoded.brokerEvidence, expected)
    ? deepFreeze(decoded)
    : null;
};

export type ExecutableIdentity =
  | {
      readonly kind: "packaged";
      readonly aumid: string;
      readonly packageFamilyName: string;
      readonly packageFullName: string;
      readonly publisherId: string;
      readonly packagePublisherSha256: string;
    }
  | {
      readonly kind: "file";
      readonly canonicalPath: string;
      readonly volumeSerialNumber: string;
      readonly fileId: string;
      readonly signerSha256: string;
      readonly sha256: string;
    };

const canonicalWindowsPath = (value: string): boolean => {
  if (!/^[A-Za-z]:\\/.test(value) || value.includes("/") || value.startsWith("\\\\") || value.includes("\0")) return false;
  const remainder = value.slice(3);
  if (!remainder || remainder.includes("\\\\")) return false;
  return remainder.split("\\").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.endsWith(".") && !segment.endsWith(" ") && !segment.includes(":"));
};

const decodeExecutableIdentity = (value: unknown, budget: DecodeBudget): ExecutableIdentity | null => {
  const kind = readDiscriminant(value, "kind", budget);
  if (kind === "packaged") {
    const record = readDataObject(value, ["kind", "aumid", "packageFamilyName", "packageFullName", "publisherId", "packagePublisherSha256"], [], budget);
    if (!record || !boundedString(record.aumid, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.packageFamilyName, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.packageFullName, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.publisherId, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !sha256Hex(record.packagePublisherSha256)) return null;
    return deepFreeze({ kind, aumid: record.aumid, packageFamilyName: record.packageFamilyName, packageFullName: record.packageFullName, publisherId: record.publisherId, packagePublisherSha256: record.packagePublisherSha256.toLowerCase() });
  }
  if (kind === "file") {
    const record = readDataObject(value, ["kind", "canonicalPath", "volumeSerialNumber", "fileId", "signerSha256", "sha256"], [], budget);
    if (!record || !boundedString(record.canonicalPath, COMPUTER_USE_LIMITS.maxPathBytes, budget) || !canonicalWindowsPath(record.canonicalPath) || !boundedString(record.volumeSerialNumber, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.fileId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !sha256Hex(record.signerSha256) || !sha256Hex(record.sha256)) return null;
    return deepFreeze({ kind, canonicalPath: record.canonicalPath, volumeSerialNumber: record.volumeSerialNumber, fileId: record.fileId, signerSha256: record.signerSha256.toLowerCase(), sha256: record.sha256.toLowerCase() });
  }
  return null;
};

const executableSnapshot = (identity: ExecutableIdentity): unknown => identity.kind === "file"
  ? { ...identity, canonicalPath: identity.canonicalPath.toLowerCase() }
  : identity;

const sameExecutableIdentity = (left: ExecutableIdentity, right: ExecutableIdentity): boolean => {
  const decodedLeft = decodeExecutableIdentity(left, newBudget());
  const decodedRight = decodeExecutableIdentity(right, newBudget());
  return Boolean(decodedLeft && decodedRight && stableEncode(executableSnapshot(decodedLeft)) === stableEncode(executableSnapshot(decodedRight)));
};

export function digestExecutableIdentity(identity: ExecutableIdentity): string {
  const decoded = decodeExecutableIdentity(identity, newBudget());
  return decoded ? digestValue(executableSnapshot(decoded)) : "";
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly creationTimeMs: number;
  readonly executable: ExecutableIdentity;
}

export interface WindowIdentity {
  readonly hwnd: string;
  readonly process: ProcessIdentity;
  readonly className: string;
  readonly title: string;
}

export interface ControlIdentity {
  readonly window: WindowIdentity;
  readonly runtimeId: readonly number[];
  readonly boundingRect: Rect;
  readonly automationId: string;
  readonly controlType: string;
  readonly frameworkId: string;
  readonly name: string;
  readonly passwordField?: boolean;
}

export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export type WindowState = "normal" | "maximized" | "minimized" | "closed";
export type OcclusionState = "none" | "partial" | "full" | "unknown";

export interface UiPreState {
  readonly observedAtMs: number;
  readonly windowBounds: Rect;
  readonly windowState: WindowState;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly foreground: boolean;
  readonly occlusion: OcclusionState;
  readonly uiaSnapshotSha256: string;
}

export interface ComputerUseTarget {
  readonly process: ProcessIdentity;
  readonly window: WindowIdentity;
  readonly control?: ControlIdentity;
  readonly preState: UiPreState;
}

const decodeProcessIdentity = (value: unknown, budget: DecodeBudget): ProcessIdentity | null => {
  const record = readDataObject(value, ["pid", "creationTimeMs", "executable"], [], budget);
  if (!record || !positiveInteger(record.pid) || !nonNegativeInteger(record.creationTimeMs)) return null;
  const executable = decodeExecutableIdentity(record.executable, budget);
  return executable ? deepFreeze({ pid: record.pid, creationTimeMs: record.creationTimeMs, executable }) : null;
};

const decodeWindowIdentity = (value: unknown, budget: DecodeBudget): WindowIdentity | null => {
  const record = readDataObject(value, ["hwnd", "process", "className", "title"], [], budget);
  if (!record || !boundedString(record.hwnd, 64, budget) || !/^0x[0-9a-fA-F]+$/.test(record.hwnd) || !boundedString(record.className, COMPUTER_USE_LIMITS.maxLabelBytes, budget, true) || !boundedString(record.title, COMPUTER_USE_LIMITS.maxLabelBytes, budget, true)) return null;
  const process = decodeProcessIdentity(record.process, budget);
  return process ? deepFreeze({ hwnd: record.hwnd.toLowerCase(), process, className: record.className, title: record.title }) : null;
};

const decodeNumberArray = (value: unknown, budget: DecodeBudget): readonly number[] | null => {
  const values = readDataArray(value, COMPUTER_USE_LIMITS.maxRuntimeIdItems, budget);
  if (!values || values.length === 0 || values.some((item) => !Number.isSafeInteger(item))) return null;
  return deepFreeze(values.map((item) => item as number));
};

const decodeControlIdentity = (value: unknown, budget: DecodeBudget): ControlIdentity | null => {
  const record = readDataObject(value, ["window", "runtimeId", "boundingRect", "automationId", "controlType", "frameworkId", "name"], ["passwordField"], budget);
  if (!record || !boundedString(record.automationId, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.controlType, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.frameworkId, COMPUTER_USE_LIMITS.maxLabelBytes, budget) || !boundedString(record.name, COMPUTER_USE_LIMITS.maxLabelBytes, budget, true) || (hasOwn(record, "passwordField") && typeof record.passwordField !== "boolean")) return null;
  const window = decodeWindowIdentity(record.window, budget);
  const runtimeId = decodeNumberArray(record.runtimeId, budget);
  const boundingRect = decodeRect(record.boundingRect, budget);
  return window && runtimeId && boundingRect ? deepFreeze({ window, runtimeId, boundingRect, automationId: record.automationId, controlType: record.controlType, frameworkId: record.frameworkId, name: record.name, ...(hasOwn(record, "passwordField") ? { passwordField: record.passwordField as boolean } : {}) }) : null;
};

const decodeRect = (value: unknown, budget: DecodeBudget): Rect | null => {
  const record = readDataObject(value, ["left", "top", "right", "bottom"], [], budget);
  if (!record || !finiteNumber(record.left) || !finiteNumber(record.top) || !finiteNumber(record.right) || !finiteNumber(record.bottom) || record.left >= record.right || record.top >= record.bottom) return null;
  return deepFreeze({ left: record.left, top: record.top, right: record.right, bottom: record.bottom });
};

const decodeUiPreState = (value: unknown, budget: DecodeBudget): UiPreState | null => {
  const record = readDataObject(value, ["observedAtMs", "windowBounds", "windowState", "visible", "enabled", "foreground", "occlusion", "uiaSnapshotSha256"], [], budget);
  if (!record || !nonNegativeInteger(record.observedAtMs) || typeof record.windowState !== "string" || !["normal", "maximized", "minimized", "closed"].includes(record.windowState) || typeof record.visible !== "boolean" || typeof record.enabled !== "boolean" || typeof record.foreground !== "boolean" || typeof record.occlusion !== "string" || !["none", "partial", "full", "unknown"].includes(record.occlusion) || !sha256Hex(record.uiaSnapshotSha256)) return null;
  const windowBounds = decodeRect(record.windowBounds, budget);
  return windowBounds ? deepFreeze({ observedAtMs: record.observedAtMs, windowBounds, windowState: record.windowState as WindowState, visible: record.visible, enabled: record.enabled, foreground: record.foreground, occlusion: record.occlusion as OcclusionState, uiaSnapshotSha256: record.uiaSnapshotSha256.toLowerCase() }) : null;
};

export function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  try {
    const decodedLeft = decodeProcessIdentity(left, newBudget());
    const decodedRight = decodeProcessIdentity(right, newBudget());
    return Boolean(decodedLeft && decodedRight && decodedLeft.pid === decodedRight.pid && decodedLeft.creationTimeMs === decodedRight.creationTimeMs && sameExecutableIdentity(decodedLeft.executable, decodedRight.executable));
  } catch {
    return false;
  }
}

export function sameWindowIdentity(left: WindowIdentity, right: WindowIdentity): boolean {
  try {
    const decodedLeft = decodeWindowIdentity(left, newBudget());
    const decodedRight = decodeWindowIdentity(right, newBudget());
    return Boolean(decodedLeft && decodedRight && decodedLeft.hwnd === decodedRight.hwnd && decodedLeft.className === decodedRight.className && decodedLeft.title === decodedRight.title && sameProcessIdentity(decodedLeft.process, decodedRight.process));
  } catch {
    return false;
  }
}

export function sameControlIdentity(left: ControlIdentity, right: ControlIdentity): boolean {
  try {
    const decodedLeft = decodeControlIdentity(left, newBudget());
    const decodedRight = decodeControlIdentity(right, newBudget());
    return Boolean(decodedLeft && decodedRight && sameWindowIdentity(decodedLeft.window, decodedRight.window) && stableEncode(decodedLeft.boundingRect) === stableEncode(decodedRight.boundingRect) && decodedLeft.automationId === decodedRight.automationId && decodedLeft.controlType === decodedRight.controlType && decodedLeft.frameworkId === decodedRight.frameworkId && decodedLeft.name === decodedRight.name && (decodedLeft.passwordField ?? false) === (decodedRight.passwordField ?? false) && decodedLeft.runtimeId.length === decodedRight.runtimeId.length && decodedLeft.runtimeId.every((item, index) => item === decodedRight.runtimeId[index]));
  } catch {
    return false;
  }
}

const sameUiPreState = (left: UiPreState, right: UiPreState): boolean => stableEncode(left) === stableEncode(right);

const decodeTargetInternal = (value: unknown, budget: DecodeBudget): ComputerUseTarget | null => {
  const record = readDataObject(value, ["process", "window", "preState"], ["control"], budget);
  if (!record) return null;
  const process = decodeProcessIdentity(record.process, budget);
  const window = decodeWindowIdentity(record.window, budget);
  const preState = decodeUiPreState(record.preState, budget);
  if (!process || !window || !preState || !sameProcessIdentity(process, window.process)) return null;
  let control: ControlIdentity | undefined;
  if (hasOwn(record, "control")) {
    control = decodeControlIdentity(record.control, budget) ?? undefined;
    if (!control || !sameWindowIdentity(control.window, window) || !containsRect(preState.windowBounds, control.boundingRect)) return null;
  }
  return deepFreeze({ process, window, ...(control ? { control } : {}), preState });
};

export type TargetValidationReason = "valid" | "invalid-target" | "process-mismatch" | "window-mismatch" | "control-mismatch";

export function decodeComputerUseTarget(value: unknown): ComputerUseTarget | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeTargetInternal(parsed, newBudget());
  } catch {
    return null;
  }
}

export function validateComputerUseTarget(value: ComputerUseTarget): TargetValidationReason {
  try {
    const record = readDataObject(value, ["process", "window", "preState"], ["control"], newBudget());
    if (!record) return "invalid-target";
    const process = decodeProcessIdentity(record.process, newBudget());
    const window = decodeWindowIdentity(record.window, newBudget());
    if (!process || !window || !decodeUiPreState(record.preState, newBudget())) return "invalid-target";
    if (!sameProcessIdentity(process, window.process)) return "process-mismatch";
    if (hasOwn(record, "control")) {
      const control = decodeControlIdentity(record.control, newBudget());
      if (!control) return "control-mismatch";
      if (!sameProcessIdentity(control.window.process, process)) return "process-mismatch";
      if (!sameWindowIdentity(control.window, window)) return "window-mismatch";
      const preState = decodeUiPreState(record.preState, newBudget());
      if (!preState || !containsRect(preState.windowBounds, control.boundingRect)) return "control-mismatch";
    }
    return "valid";
  } catch {
    return "invalid-target";
  }
}

export function sameComputerUseTarget(left: ComputerUseTarget, right: ComputerUseTarget): boolean {
  try {
    const decodedLeft = decodeTargetInternal(left, newBudget());
    const decodedRight = decodeTargetInternal(right, newBudget());
    if (!decodedLeft || !decodedRight || !sameProcessIdentity(decodedLeft.process, decodedRight.process) || !sameWindowIdentity(decodedLeft.window, decodedRight.window) || !sameUiPreState(decodedLeft.preState, decodedRight.preState)) return false;
    if (!decodedLeft.control || !decodedRight.control) return decodedLeft.control === decodedRight.control;
    return sameControlIdentity(decodedLeft.control, decodedRight.control);
  } catch {
    return false;
  }
}

export function digestComputerUseTarget(target: ComputerUseTarget): string {
  const decoded = decodeTargetInternal(target, newBudget());
  return decoded ? digestValue(decoded) : "";
}

export type CoordinateSpace = "logical" | "physical";
export interface RequestedCoordinate extends Point { readonly monitorId: string; readonly space: CoordinateSpace }
export interface RequestedRegion extends RequestedCoordinate { readonly width: number; readonly height: number }
export interface ScreenCoordinate extends Point { readonly monitorId: string }
export interface MonitorMetadata { readonly id: string; readonly bounds: Rect; readonly workArea: Rect; readonly scaleFactor: number; readonly dpi: number; readonly primary: boolean }
export interface DisplayMetadata { readonly monitors: readonly MonitorMetadata[]; readonly virtualBounds: Rect }

const decodeRequestedCoordinate = (value: unknown, budget: DecodeBudget): RequestedCoordinate | null => {
  const record = readDataObject(value, ["x", "y", "monitorId", "space"], [], budget);
  if (!record || !finiteNumber(record.x) || !finiteNumber(record.y) || !boundedString(record.monitorId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || (record.space !== "logical" && record.space !== "physical")) return null;
  return deepFreeze({ x: record.x, y: record.y, monitorId: record.monitorId, space: record.space });
};

const decodeRequestedRegion = (value: unknown, budget: DecodeBudget): RequestedRegion | null => {
  const record = readDataObject(value, ["x", "y", "width", "height", "monitorId", "space"], [], budget);
  if (!record || !finiteNumber(record.x) || !finiteNumber(record.y) || !finiteNumber(record.width) || record.width <= 0 || !finiteNumber(record.height) || record.height <= 0 || !boundedString(record.monitorId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || (record.space !== "logical" && record.space !== "physical")) return null;
  return deepFreeze({ x: record.x, y: record.y, width: record.width, height: record.height, monitorId: record.monitorId, space: record.space });
};

const containsRect = (outer: Rect, inner: Rect): boolean => inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;

const decodeDisplayInternal = (value: unknown, budget: DecodeBudget): DisplayMetadata | null => {
  const record = readDataObject(value, ["monitors", "virtualBounds"], [], budget);
  if (!record) return null;
  const monitorValues = readDataArray(record.monitors, COMPUTER_USE_LIMITS.maxMonitors, budget);
  const virtualBounds = decodeRect(record.virtualBounds, budget);
  if (!monitorValues || monitorValues.length === 0 || !virtualBounds) return null;
  const monitors: MonitorMetadata[] = [];
  const ids = new Set<string>();
  let primaryCount = 0;
  for (const valueOfMonitor of monitorValues) {
    const monitor = readDataObject(valueOfMonitor, ["id", "bounds", "workArea", "scaleFactor", "dpi", "primary"], [], budget);
    if (!monitor || !boundedString(monitor.id, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || ids.has(monitor.id) || !finiteNumber(monitor.scaleFactor) || monitor.scaleFactor <= 0 || !finiteNumber(monitor.dpi) || monitor.dpi <= 0 || typeof monitor.primary !== "boolean") return null;
    const bounds = decodeRect(monitor.bounds, budget);
    const workArea = decodeRect(monitor.workArea, budget);
    if (!bounds || !workArea || !containsRect(bounds, workArea) || !containsRect(virtualBounds, bounds)) return null;
    ids.add(monitor.id);
    if (monitor.primary) primaryCount += 1;
    monitors.push(deepFreeze({ id: monitor.id, bounds, workArea, scaleFactor: monitor.scaleFactor, dpi: monitor.dpi, primary: monitor.primary }));
  }
  return primaryCount === 1 ? deepFreeze({ monitors, virtualBounds }) : null;
};

export function decodeDisplayMetadata(value: unknown): DisplayMetadata | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeDisplayInternal(parsed, newBudget());
  } catch {
    return null;
  }
}

export function scaleCoordinate(point: Point, fromScaleFactor: number, toScaleFactor: number): Point {
  if (!finiteNumber(point.x) || !finiteNumber(point.y) || !finiteNumber(fromScaleFactor) || fromScaleFactor <= 0 || !finiteNumber(toScaleFactor) || toScaleFactor <= 0) throw new RangeError("Coordinate scale factors and points must be finite");
  const factor = toScaleFactor / fromScaleFactor;
  return { x: Math.round(point.x * factor), y: Math.round(point.y * factor) };
}

const resolveDecodedCoordinate = (coordinate: RequestedCoordinate, display: DisplayMetadata): ScreenCoordinate | null => {
  if (coordinate.x < 0 || coordinate.y < 0) return null;
  const monitor = display.monitors.find(({ id }) => id === coordinate.monitorId);
  if (!monitor) return null;
  const local = coordinate.space === "logical" ? scaleCoordinate(coordinate, 1, monitor.scaleFactor) : coordinate;
  const result = { x: monitor.bounds.left + local.x, y: monitor.bounds.top + local.y, monitorId: monitor.id };
  return result.x >= monitor.bounds.left && result.x < monitor.bounds.right && result.y >= monitor.bounds.top && result.y < monitor.bounds.bottom && result.x >= display.virtualBounds.left && result.x < display.virtualBounds.right && result.y >= display.virtualBounds.top && result.y < display.virtualBounds.bottom ? result : null;
};

export function resolveScreenCoordinate(coordinate: RequestedCoordinate, display: DisplayMetadata): ScreenCoordinate | null {
  try {
    const decodedCoordinate = decodeRequestedCoordinate(coordinate, newBudget());
    const decodedDisplay = decodeDisplayInternal(display, newBudget());
    return decodedCoordinate && decodedDisplay ? resolveDecodedCoordinate(decodedCoordinate, decodedDisplay) : null;
  } catch {
    return null;
  }
}

const resolveScreenRegion = (region: RequestedRegion, display: DisplayMetadata): Rect | null => {
  const origin = resolveDecodedCoordinate(region, display);
  const monitor = display.monitors.find(({ id }) => id === region.monitorId);
  if (!origin || !monitor) return null;
  const size = region.space === "logical" ? scaleCoordinate({ x: region.width, y: region.height }, 1, monitor.scaleFactor) : { x: region.width, y: region.height };
  const rect = { left: origin.x, top: origin.y, right: origin.x + size.x, bottom: origin.y + size.y };
  return finiteNumber(rect.right) && finiteNumber(rect.bottom) && containsRect(monitor.bounds, rect) && containsRect(display.virtualBounds, rect) ? rect : null;
};

export interface ForegroundBindingOptions { readonly bindingId?: string; readonly epoch?: number; readonly focusedControl?: ControlIdentity }
export interface ForegroundBinding { readonly bindingId: string; readonly epoch: number; readonly window: WindowIdentity; readonly preState: UiPreState; readonly focusedControl?: ControlIdentity; readonly boundAtMs: number; readonly expiresAtMs: number }

export function bindForeground(window: WindowIdentity, preState: UiPreState, boundAtMs: number, expiresAtMs: number, options: ForegroundBindingOptions = {}): ForegroundBinding {
  const decodedWindow = decodeWindowIdentity(window, newBudget());
  const decodedPreState = decodeUiPreState(preState, newBudget());
  const focusedControl = options.focusedControl === undefined ? undefined : decodeControlIdentity(options.focusedControl, newBudget());
  const bindingId = options.bindingId ?? `foreground-${digestValue({ window: decodedWindow, preState: decodedPreState })}`;
  const epoch = options.epoch ?? 1;
  if (!decodedWindow || !decodedPreState || (options.focusedControl !== undefined && !focusedControl) || (focusedControl && !sameWindowIdentity(focusedControl.window, decodedWindow)) || !nonNegativeInteger(boundAtMs) || !nonNegativeInteger(expiresAtMs) || expiresAtMs <= boundAtMs || expiresAtMs - boundAtMs > COMPUTER_USE_LIMITS.maxForegroundBindingMs || decodedPreState.observedAtMs < boundAtMs || decodedPreState.observedAtMs >= expiresAtMs || typeof bindingId !== "string" || bindingId.length === 0 || !positiveInteger(epoch)) throw new RangeError("Foreground binding is invalid");
  return deepFreeze({ bindingId, epoch, window: decodedWindow, preState: decodedPreState, ...(focusedControl ? { focusedControl } : {}), boundAtMs, expiresAtMs });
}

const decodeForegroundInternal = (value: unknown, budget: DecodeBudget): ForegroundBinding | null => {
  const record = readDataObject(value, ["bindingId", "epoch", "window", "preState", "boundAtMs", "expiresAtMs"], ["focusedControl"], budget);
  if (!record || !boundedString(record.bindingId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !positiveInteger(record.epoch) || !nonNegativeInteger(record.boundAtMs) || !nonNegativeInteger(record.expiresAtMs) || record.expiresAtMs <= record.boundAtMs || record.expiresAtMs - record.boundAtMs > COMPUTER_USE_LIMITS.maxForegroundBindingMs) return null;
  const window = decodeWindowIdentity(record.window, budget);
  const preState = decodeUiPreState(record.preState, budget);
  if (!window || !preState || preState.observedAtMs < record.boundAtMs || preState.observedAtMs >= record.expiresAtMs) return null;
  let focusedControl: ControlIdentity | undefined;
  if (hasOwn(record, "focusedControl")) {
    focusedControl = decodeControlIdentity(record.focusedControl, budget) ?? undefined;
    if (!focusedControl || !sameWindowIdentity(focusedControl.window, window)) return null;
  }
  return deepFreeze({ bindingId: record.bindingId, epoch: record.epoch, window, preState, ...(focusedControl ? { focusedControl } : {}), boundAtMs: record.boundAtMs, expiresAtMs: record.expiresAtMs });
};

export function decodeForegroundBinding(value: unknown): ForegroundBinding | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeForegroundInternal(parsed, newBudget());
  } catch { return null; }
}

export function isForegroundBound(targetWindow: WindowIdentity, binding: ForegroundBinding, nowMs: number): boolean {
  const decoded = decodeForegroundInternal(binding, newBudget());
  return Boolean(decoded && nonNegativeInteger(nowMs) && nowMs >= decoded.boundAtMs && nowMs < decoded.expiresAtMs && sameWindowIdentity(targetWindow, decoded.window));
}

export type IntegrityLevel = "low" | "medium" | "high" | "system";
export interface SecurityContext { readonly passwordField: boolean; readonly secureDesktop: boolean; readonly callerIntegrity: IntegrityLevel; readonly targetIntegrity: IntegrityLevel }
const integrityRank: Record<IntegrityLevel, number> = { low: 0, medium: 1, high: 2, system: 3 };

const decodeSecurityContext = (value: unknown, budget: DecodeBudget): SecurityContext | null => {
  const record = readDataObject(value, ["passwordField", "secureDesktop", "callerIntegrity", "targetIntegrity"], [], budget);
  if (!record || typeof record.passwordField !== "boolean" || typeof record.secureDesktop !== "boolean" || typeof record.callerIntegrity !== "string" || typeof record.targetIntegrity !== "string" || !["low", "medium", "high", "system"].includes(record.callerIntegrity) || !["low", "medium", "high", "system"].includes(record.targetIntegrity)) return null;
  return deepFreeze({ passwordField: record.passwordField, secureDesktop: record.secureDesktop, callerIntegrity: record.callerIntegrity as IntegrityLevel, targetIntegrity: record.targetIntegrity as IntegrityLevel });
};

export type DataCategory = "public" | "workspace" | "personal" | "confidential" | "health" | "secret" | "credential" | "authentication" | "payment";
export type RedactionMode = "none" | "required";
export type PersistenceMode = "none" | "ephemeral" | "durable";
export interface DataHandlingPolicy { readonly category: DataCategory; readonly redaction: RedactionMode; readonly redactorId: string | null; readonly persistence: PersistenceMode; readonly maxBytes: number; readonly retentionMs: number }
const DATA_CATEGORIES: readonly DataCategory[] = ["public", "workspace", "personal", "confidential", "health", "secret", "credential", "authentication", "payment"];
const SENSITIVE_CATEGORIES = new Set<DataCategory>(["secret", "credential", "authentication", "payment"]);

const decodeDataHandlingPolicy = (value: unknown, budget: DecodeBudget): DataHandlingPolicy | null => {
  const record = readDataObject(value, ["category", "redaction", "redactorId", "persistence", "maxBytes", "retentionMs"], [], budget);
  if (!record || typeof record.category !== "string" || !DATA_CATEGORIES.includes(record.category as DataCategory) || (record.redaction !== "none" && record.redaction !== "required") || (record.persistence !== "none" && record.persistence !== "ephemeral" && record.persistence !== "durable") || !positiveInteger(record.maxBytes) || record.maxBytes > COMPUTER_USE_LIMITS.maxCaptureBytes || !nonNegativeInteger(record.retentionMs)) return null;
  if (record.redaction === "required") {
    if (!boundedString(record.redactorId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) return null;
  } else if (record.redactorId !== null) return null;
  if (record.persistence === "none" && record.retentionMs !== 0) return null;
  return deepFreeze({ category: record.category as DataCategory, redaction: record.redaction, redactorId: record.redactorId as string | null, persistence: record.persistence, maxBytes: record.maxBytes, retentionMs: record.retentionMs });
};

export type MouseInputAction = "move" | "click" | "double_click" | "right_click" | "scroll";
export type KeyboardInputAction = "key_press" | "text_input";
export type InputAction =
  | { readonly type: "mouse"; readonly action: MouseInputAction; readonly coordinate: RequestedCoordinate }
  | { readonly type: "keyboard"; readonly action: KeyboardInputAction; readonly value: string };

const decodeInputAction = (value: unknown, budget: DecodeBudget): InputAction | null => {
  const type = readDiscriminant(value, "type", budget);
  if (type === "mouse") {
    const record = readDataObject(value, ["type", "action", "coordinate"], [], budget);
    if (!record || typeof record.action !== "string" || !["move", "click", "double_click", "right_click", "scroll"].includes(record.action)) return null;
    const coordinate = decodeRequestedCoordinate(record.coordinate, budget);
    return coordinate ? deepFreeze({ type, action: record.action as MouseInputAction, coordinate }) : null;
  }
  if (type === "keyboard") {
    const record = readDataObject(value, ["type", "action", "value"], [], budget);
    if (!record || typeof record.action !== "string" || !["key_press", "text_input"].includes(record.action) || !boundedString(record.value, COMPUTER_USE_LIMITS.maxTextBytes, budget, true)) return null;
    return deepFreeze({ type, action: record.action as KeyboardInputAction, value: record.value });
  }
  return null;
};

interface BaseIntent { readonly intentId: string; readonly authority: AuthorityBinding; readonly target: ComputerUseTarget }
export interface ScreenshotIntent extends BaseIntent { readonly kind: "screenshot"; readonly region?: RequestedRegion; readonly dataPolicy: DataHandlingPolicy }
export interface InputIntent extends BaseIntent { readonly kind: "input"; readonly action: InputAction }
export type ClipboardOperation = "read" | "write";
export interface ClipboardIntent extends BaseIntent { readonly kind: "clipboard"; readonly operation: ClipboardOperation; readonly text?: string; readonly dataPolicy: DataHandlingPolicy }
export type ProcessOperation = "launch" | "terminate";
export interface ProcessIntent extends BaseIntent { readonly kind: "process"; readonly operation: ProcessOperation; readonly executable: ExecutableIdentity }
export interface ExecutableIntent extends BaseIntent { readonly kind: "executable"; readonly executable: ExecutableIdentity; readonly arguments: readonly string[] }
export type ComputerUseIntent = ScreenshotIntent | InputIntent | ClipboardIntent | ProcessIntent | ExecutableIntent;
export type ComputerUseIntentKind = ComputerUseIntent["kind"];

const decodeStringArray = (value: unknown, maxItems: number, maxItemBytes: number, budget: DecodeBudget): readonly string[] | null => {
  const values = readDataArray(value, maxItems, budget);
  if (!values) return null;
  const decoded: string[] = [];
  for (const item of values) {
    if (!boundedString(item, maxItemBytes, budget, true)) return null;
    decoded.push(item);
  }
  return deepFreeze(decoded);
};

const decodeIntentInternal = (value: unknown, budget: DecodeBudget): ComputerUseIntent | null => {
  const kind = readDiscriminant(value, "kind", budget);
  if (kind === "screenshot") {
    const record = readDataObject(value, ["kind", "intentId", "authority", "target", "dataPolicy"], ["region"], budget);
    if (!record || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) return null;
    const authority = decodeAuthority(record.authority, budget);
    const target = decodeTargetInternal(record.target, budget);
    const dataPolicy = decodeDataHandlingPolicy(record.dataPolicy, budget);
    const region = hasOwn(record, "region") ? decodeRequestedRegion(record.region, budget) : undefined;
    return authority && target && dataPolicy && (!hasOwn(record, "region") || region) ? deepFreeze({ kind, intentId: record.intentId, authority, target, dataPolicy, ...(region ? { region } : {}) }) : null;
  }
  if (kind === "input") {
    const record = readDataObject(value, ["kind", "intentId", "authority", "target", "action"], [], budget);
    if (!record || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) return null;
    const authority = decodeAuthority(record.authority, budget);
    const target = decodeTargetInternal(record.target, budget);
    const action = decodeInputAction(record.action, budget);
    return authority && target && action ? deepFreeze({ kind, intentId: record.intentId, authority, target, action }) : null;
  }
  if (kind === "clipboard") {
    const operation = readDiscriminant(value, "operation", budget);
    const required = operation === "write" ? ["kind", "intentId", "authority", "target", "operation", "text", "dataPolicy"] : ["kind", "intentId", "authority", "target", "operation", "dataPolicy"];
    const record = readDataObject(value, required, [], budget);
    if (!record || (operation !== "read" && operation !== "write") || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || (operation === "write" && !boundedString(record.text, COMPUTER_USE_LIMITS.maxClipboardTextBytes, budget, true))) return null;
    const authority = decodeAuthority(record.authority, budget);
    const target = decodeTargetInternal(record.target, budget);
    const dataPolicy = decodeDataHandlingPolicy(record.dataPolicy, budget);
    return authority && target && dataPolicy ? deepFreeze({ kind, intentId: record.intentId, authority, target, operation, ...(operation === "write" ? { text: record.text as string } : {}), dataPolicy }) : null;
  }
  if (kind === "process") {
    const record = readDataObject(value, ["kind", "intentId", "authority", "target", "operation", "executable"], [], budget);
    if (!record || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || (record.operation !== "launch" && record.operation !== "terminate")) return null;
    const authority = decodeAuthority(record.authority, budget);
    const target = decodeTargetInternal(record.target, budget);
    const executable = decodeExecutableIdentity(record.executable, budget);
    return authority && target && executable && sameExecutableIdentity(executable, target.process.executable)
      ? deepFreeze({ kind, intentId: record.intentId, authority, target, operation: record.operation, executable })
      : null;
  }
  if (kind === "executable") {
    const record = readDataObject(value, ["kind", "intentId", "authority", "target", "executable", "arguments"], [], budget);
    if (!record || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) return null;
    const authority = decodeAuthority(record.authority, budget);
    const target = decodeTargetInternal(record.target, budget);
    const executable = decodeExecutableIdentity(record.executable, budget);
    const args = decodeStringArray(record.arguments, COMPUTER_USE_LIMITS.maxArguments, COMPUTER_USE_LIMITS.maxArgumentBytes, budget);
    return authority && target && executable && args && sameExecutableIdentity(executable, target.process.executable)
      ? deepFreeze({ kind, intentId: record.intentId, authority, target, executable, arguments: args })
      : null;
  }
  return null;
};

export function decodeComputerUseIntent(value: unknown): ComputerUseIntent | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeIntentInternal(parsed, newBudget());
  } catch { return null; }
}

const actionSnapshot = (intent: ComputerUseIntent): unknown => {
  switch (intent.kind) {
    case "screenshot": return { kind: intent.kind, region: intent.region ?? null, dataPolicy: intent.dataPolicy };
    case "input": return { kind: intent.kind, action: intent.action };
    case "clipboard": return { kind: intent.kind, operation: intent.operation, text: intent.text ?? null, dataPolicy: intent.dataPolicy };
    case "process": return { kind: intent.kind, operation: intent.operation, executable: executableSnapshot(intent.executable) };
    case "executable": return { kind: intent.kind, executable: executableSnapshot(intent.executable), arguments: intent.arguments };
  }
};

const exactTargetRect = (target: ComputerUseTarget): Rect => target.control?.boundingRect ?? target.preState.windowBounds;

const geometryDigestFor = (intent: ComputerUseIntent, display: DisplayMetadata | null): string | null => {
  if (!display) return null;
  const targetRect = exactTargetRect(intent.target);
  if (intent.kind === "input" && intent.action.type === "mouse") {
    const requested = intent.action.coordinate;
    return digestValue({ display, targetRect, requested, resolved: resolveDecodedCoordinate(requested, display) });
  }
  if (intent.kind === "screenshot") {
    const requested = intent.region ?? null;
    return digestValue({ display, targetRect, requested, resolved: intent.region ? resolveScreenRegion(intent.region, display) : targetRect });
  }
  return null;
};

const dataPolicyDigestFor = (intent: ComputerUseIntent): string | null =>
  intent.kind === "screenshot" || intent.kind === "clipboard" ? digestValue(intent.dataPolicy) : null;

const executableDigestFor = (intent: ComputerUseIntent): string | null =>
  intent.kind === "process" || intent.kind === "executable" ? digestExecutableIdentity(intent.executable) : null;

export function digestComputerUseIntent(intent: ComputerUseIntent, display: DisplayMetadata | null = null): string {
  const decoded = decodeIntentInternal(intent, newBudget());
  if (!decoded) return "";
  const decodedDisplay = display === null ? null : decodeDisplayInternal(display, newBudget());
  if (display !== null && !decodedDisplay) return "";
  return digestValue({ authority: decoded.authority, intentId: decoded.intentId, targetDigest: digestComputerUseTarget(decoded.target), action: actionSnapshot(decoded), geometryDigest: geometryDigestFor(decoded, decodedDisplay) });
}

export interface ApprovalScope {
  readonly authorityDigest: string;
  readonly kind: ComputerUseIntentKind;
  readonly intentId: string;
  readonly actionDigest: string;
  readonly targetDigest: string;
  readonly geometryDigest: string | null;
  readonly dataPolicyDigest: string | null;
  readonly executableDigest: string | null;
}

export type ApprovalStatus = "active" | "leased" | "used" | "revoked";
export interface ApprovalGrant {
  readonly approvalId: string;
  readonly authority: AuthorityBinding;
  readonly brokerInstanceId: string;
  readonly kind: ComputerUseIntentKind;
  readonly intentId: string;
  readonly target: ComputerUseTarget;
  readonly targetDigest: string;
  readonly actionDigest: string;
  readonly scope: ApprovalScope;
  readonly epoch: number;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
  readonly singleUse: true;
  readonly used: boolean;
  readonly revoked: boolean;
  readonly status: ApprovalStatus;
  readonly usedAtMs?: number;
  readonly revokedAtMs?: number;
  readonly brokerEvidence: string;
}

export interface ApprovalGrantOptions { readonly approvalId: string; readonly epoch: number; readonly grantedAtMs: number; readonly expiresAtMs: number; readonly display?: DisplayMetadata }

const approvalImmutableSnapshot = (grant: Omit<ApprovalGrant, "brokerEvidence" | "used" | "revoked" | "status" | "usedAtMs" | "revokedAtMs">): unknown => grant;

function createApprovalGrant(intent: ComputerUseIntent, options: ApprovalGrantOptions, broker: ComputerUseBroker): ApprovalGrant {
  const state = brokerState(broker);
  const decodedIntent = decodeIntentInternal(intent, newBudget());
  const decodedDisplay = options.display === undefined ? null : decodeDisplayInternal(options.display, newBudget());
  if (!state || !decodedIntent || !sameAuthority(decodedIntent.authority, state.authority) || (options.display !== undefined && !decodedDisplay) || typeof options.approvalId !== "string" || options.approvalId.length === 0 || utf8.encode(options.approvalId).length > COMPUTER_USE_LIMITS.maxIdentifierBytes || !positiveInteger(options.epoch) || !nonNegativeInteger(options.grantedAtMs) || !nonNegativeInteger(options.expiresAtMs) || options.expiresAtMs <= options.grantedAtMs || options.expiresAtMs - options.grantedAtMs > COMPUTER_USE_LIMITS.maxApprovalLifetimeMs || state.approvals.has(options.approvalId)) throw new RangeError("Approval grant is invalid");
  const targetDigest = digestComputerUseTarget(decodedIntent.target);
  const actionDigest = digestComputerUseIntent(decodedIntent, decodedDisplay);
  const scope = deepFreeze({ authorityDigest: state.authorityDigest, kind: decodedIntent.kind, intentId: decodedIntent.intentId, actionDigest, targetDigest, geometryDigest: geometryDigestFor(decodedIntent, decodedDisplay), dataPolicyDigest: dataPolicyDigestFor(decodedIntent), executableDigest: executableDigestFor(decodedIntent) });
  const immutable = deepFreeze({ approvalId: options.approvalId, authority: state.authority, brokerInstanceId: state.instanceId, kind: decodedIntent.kind, intentId: decodedIntent.intentId, target: decodedIntent.target, targetDigest, actionDigest, scope, epoch: options.epoch, grantedAtMs: options.grantedAtMs, expiresAtMs: options.expiresAtMs, singleUse: true as const });
  const brokerEvidence = brokerSign(broker, "approval-v1", approvalImmutableSnapshot(immutable));
  const grant = deepFreeze({ ...immutable, used: false, revoked: false, status: "active" as const, brokerEvidence });
  state.approvals.set(options.approvalId, { immutableDigest: digestValue(approvalImmutableSnapshot(immutable)), state: "active", leaseId: null });
  return grant;
}

const decodeApprovalScope = (value: unknown, budget: DecodeBudget): ApprovalScope | null => {
  const record = readDataObject(value, ["authorityDigest", "kind", "intentId", "actionDigest", "targetDigest", "geometryDigest", "dataPolicyDigest", "executableDigest"], [], budget);
  if (!record || !digestText(record.authorityDigest) || typeof record.kind !== "string" || !["screenshot", "input", "clipboard", "process", "executable"].includes(record.kind) || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !digestText(record.actionDigest) || !digestText(record.targetDigest) || !(record.geometryDigest === null || digestText(record.geometryDigest)) || !(record.dataPolicyDigest === null || digestText(record.dataPolicyDigest)) || !(record.executableDigest === null || digestText(record.executableDigest))) return null;
  return deepFreeze({ authorityDigest: record.authorityDigest, kind: record.kind as ComputerUseIntentKind, intentId: record.intentId, actionDigest: record.actionDigest, targetDigest: record.targetDigest, geometryDigest: record.geometryDigest as string | null, dataPolicyDigest: record.dataPolicyDigest as string | null, executableDigest: record.executableDigest as string | null });
};

const decodeApprovalInternal = (value: unknown, broker: ComputerUseBroker, budget: DecodeBudget): ApprovalGrant | null => {
  const record = readDataObject(value, ["approvalId", "authority", "brokerInstanceId", "kind", "intentId", "target", "targetDigest", "actionDigest", "scope", "epoch", "grantedAtMs", "expiresAtMs", "singleUse", "used", "revoked", "status", "brokerEvidence"], ["usedAtMs", "revokedAtMs"], budget);
  if (!record || !boundedString(record.approvalId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.brokerInstanceId, 128, budget) || typeof record.kind !== "string" || !["screenshot", "input", "clipboard", "process", "executable"].includes(record.kind) || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !digestText(record.targetDigest) || !digestText(record.actionDigest) || !positiveInteger(record.epoch) || !nonNegativeInteger(record.grantedAtMs) || !nonNegativeInteger(record.expiresAtMs) || record.expiresAtMs <= record.grantedAtMs || record.expiresAtMs - record.grantedAtMs > COMPUTER_USE_LIMITS.maxApprovalLifetimeMs || record.singleUse !== true || typeof record.used !== "boolean" || typeof record.revoked !== "boolean" || typeof record.status !== "string" || !["active", "leased", "used", "revoked"].includes(record.status) || !evidenceText(record.brokerEvidence)) return null;
  const hasUsedAt = hasOwn(record, "usedAtMs");
  const hasRevokedAt = hasOwn(record, "revokedAtMs");
  if ((hasUsedAt && !nonNegativeInteger(record.usedAtMs)) || (hasRevokedAt && !nonNegativeInteger(record.revokedAtMs)) || (record.status === "active" && (record.used || record.revoked || hasUsedAt || hasRevokedAt)) || (record.status === "leased" && (record.used || record.revoked || hasUsedAt || hasRevokedAt)) || (record.status === "used" && (!record.used || record.revoked || !hasUsedAt || hasRevokedAt)) || (record.status === "revoked" && (!record.revoked || record.used || !hasRevokedAt || hasUsedAt))) return null;
  const authority = decodeAuthority(record.authority, budget);
  const target = decodeTargetInternal(record.target, budget);
  const scope = decodeApprovalScope(record.scope, budget);
  const state = brokerState(broker);
  if (!authority || !target || !scope || !state || !sameAuthority(authority, state.authority) || record.brokerInstanceId !== state.instanceId || scope.authorityDigest !== state.authorityDigest || scope.kind !== record.kind || scope.intentId !== record.intentId || scope.actionDigest !== record.actionDigest || scope.targetDigest !== record.targetDigest || digestComputerUseTarget(target) !== record.targetDigest) return null;
  const immutable = { approvalId: record.approvalId, authority, brokerInstanceId: record.brokerInstanceId, kind: record.kind as ComputerUseIntentKind, intentId: record.intentId, target, targetDigest: record.targetDigest, actionDigest: record.actionDigest, scope, epoch: record.epoch, grantedAtMs: record.grantedAtMs, expiresAtMs: record.expiresAtMs, singleUse: true as const };
  const expected = brokerSign(broker, "approval-v1", approvalImmutableSnapshot(immutable));
  if (!constantTimeEqual(record.brokerEvidence, expected)) return null;
  return deepFreeze({ ...immutable, used: record.used, revoked: record.revoked, status: record.status as ApprovalStatus, ...(hasUsedAt ? { usedAtMs: record.usedAtMs as number } : {}), ...(hasRevokedAt ? { revokedAtMs: record.revokedAtMs as number } : {}), brokerEvidence: record.brokerEvidence });
};

export function decodeApprovalGrant(value: unknown, broker: ComputerUseBroker): ApprovalGrant | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeApprovalInternal(parsed, broker, newBudget());
  } catch { return null; }
}

export interface WorkerEffectEvidence {
  readonly actualRect: Rect | null;
  readonly bytes: number;
  readonly category: DataCategory;
  readonly redactorId: string | null;
  readonly persistence: PersistenceMode;
  readonly artifactSha256: string;
}

export type WorkerOutcomeEvidenceOptions =
  | { readonly outcome: "completed"; readonly actionId: string; readonly leaseId: string; readonly attemptId: string; readonly workerId: string; readonly atMs: number; readonly effect?: WorkerEffectEvidence }
  | { readonly outcome: "cancelled"; readonly actionId: string; readonly leaseId: string; readonly attemptId: string; readonly workerId: string; readonly acknowledgementId: string; readonly atMs: number };

export type WorkerOutcomeEvidence = WorkerOutcomeEvidenceOptions & { readonly brokerEvidence: string };

/**
 * Test-only minting seam. Vite replaces `import.meta.env.MODE` in production,
 * where this constructor throws before an authority capability can be issued.
 * The WeakMap/HMAC evidence used by this harness proves only in-process
 * provenance; it is not an operating-system security boundary. A native bridge
 * must supply an opaque authorization accepted by the package-private
 * authenticator before production broker/readiness construction is enabled.
 */
export interface ComputerUseTestHarness {
  readonly createBroker: (authority: AuthorityBinding, trustedNowMs?: number) => ComputerUseBroker;
  readonly setTrustedNow: (broker: ComputerUseBroker, trustedNowMs: number) => void;
  readonly createReadiness: (broker: ComputerUseBroker, options: SecurityReadinessOptions) => SecurityReadiness;
  readonly createApproval: (intent: ComputerUseIntent, options: ApprovalGrantOptions, broker: ComputerUseBroker) => ApprovalGrant;
  readonly createWorkerOutcome: (broker: ComputerUseBroker, options: WorkerOutcomeEvidenceOptions) => string;
  readonly createTakeoverEvent: (broker: ComputerUseBroker, event: TakeoverEventOptions) => TakeoverEvent;
  readonly createTakeoverWorkerEvent: (broker: ComputerUseBroker, event: { readonly type: "worker_ack"; readonly takeoverId: string; readonly workerId: string; readonly acknowledgementId: string; readonly atMs: number } | { readonly type: "terminated"; readonly takeoverId: string; readonly workerId: string; readonly terminationId: string; readonly atMs: number }) => TakeoverEvent;
}

export function createComputerUseTestHarness(): ComputerUseTestHarness {
  if (import.meta.env.MODE !== "test") throw new Error("Computer-use test harness is unavailable outside tests");
  return Object.freeze({
    createBroker: (authority: AuthorityBinding, trustedNowMs = 200) => {
      const authorization = Object.freeze({});
      nativeBrokerAuthorizations.add(authorization);
      return createComputerUseBroker(authority, trustedNowMs, authorization, packagePrivateNativeAuthenticator);
    },
    setTrustedNow: (broker: ComputerUseBroker, trustedNowMs: number) => {
      const state = brokerState(broker);
      if (!state || !nonNegativeInteger(trustedNowMs) || trustedNowMs < state.trustedNowMs) throw new RangeError("Trusted time must be monotonic");
      state.trustedNowMs = trustedNowMs;
    },
    createReadiness: (broker: ComputerUseBroker, options: SecurityReadinessOptions) => createSecurityReadiness(broker, options),
    createApproval: (intent: ComputerUseIntent, options: ApprovalGrantOptions, broker: ComputerUseBroker) => createApprovalGrant(intent, options, broker),
    createWorkerOutcome: (broker: ComputerUseBroker, options: WorkerOutcomeEvidenceOptions) => JSON.stringify(deepFreeze({ ...options, brokerEvidence: brokerSign(broker, "worker-outcome-v1", options) })),
    createTakeoverEvent: (broker: ComputerUseBroker, event: TakeoverEventOptions) => deepFreeze({ ...event, brokerEvidence: brokerSign(broker, "takeover-event-v1", event) }) as TakeoverEvent,
    createTakeoverWorkerEvent: (broker: ComputerUseBroker, event: Parameters<ComputerUseTestHarness["createTakeoverWorkerEvent"]>[1]) => deepFreeze({ ...event, brokerEvidence: brokerSign(broker, "takeover-worker-event-v1", event) }) as TakeoverEvent,
  });
}

export type TakeoverState =
  | { readonly status: "idle"; readonly epoch: number; readonly lastEventAtMs: number }
  | { readonly status: "revocation_pending"; readonly takeoverId: string; readonly workerId: string; readonly requestedAtMs: number; readonly acknowledgementDeadlineMs: number; readonly terminationDeadlineMs: number; readonly epoch: number; readonly lastEventAtMs: number }
  | { readonly status: "acknowledged"; readonly takeoverId: string; readonly workerId: string; readonly acknowledgementId: string; readonly atMs: number; readonly epoch: number; readonly lastEventAtMs: number }
  | { readonly status: "termination_required"; readonly takeoverId: string; readonly workerId: string; readonly requestedAtMs: number; readonly terminationDeadlineMs: number; readonly epoch: number; readonly lastEventAtMs: number }
  | { readonly status: "terminated"; readonly takeoverId: string; readonly workerId: string; readonly terminationId: string; readonly atMs: number; readonly epoch: number; readonly lastEventAtMs: number }
  | { readonly status: "termination_unconfirmed"; readonly takeoverId: string; readonly workerId: string; readonly atMs: number; readonly epoch: number; readonly lastEventAtMs: number };

export type TakeoverEventOptions =
  | { readonly type: "takeover"; readonly takeoverId: string; readonly workerId: string; readonly atMs: number; readonly acknowledgementTimeoutMs: number; readonly terminationTimeoutMs: number }
  | { readonly type: "worker_ack"; readonly takeoverId: string; readonly workerId: string; readonly acknowledgementId: string; readonly atMs: number }
  | { readonly type: "terminated"; readonly takeoverId: string; readonly workerId: string; readonly terminationId: string; readonly atMs: number }
  | { readonly type: "timeout"; readonly atMs: number };

export type TakeoverEvent = TakeoverEventOptions & { readonly brokerEvidence: string };

export function createTakeoverState(initialAtMs = 0): TakeoverState {
  return deepFreeze({ status: "idle", epoch: 0, lastEventAtMs: nonNegativeInteger(initialAtMs) ? initialAtMs : 0 });
}

const decodeTakeoverEvent = (value: unknown, budget: DecodeBudget): TakeoverEvent | null => {
  const type = readDiscriminant(value, "type", budget);
  if (type === "takeover") {
    const record = readDataObject(value, ["type", "takeoverId", "workerId", "atMs", "acknowledgementTimeoutMs", "terminationTimeoutMs", "brokerEvidence"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !positiveInteger(record.acknowledgementTimeoutMs) || record.acknowledgementTimeoutMs > COMPUTER_USE_LIMITS.maxTakeoverAcknowledgementMs || !positiveInteger(record.terminationTimeoutMs) || record.terminationTimeoutMs > COMPUTER_USE_LIMITS.maxTakeoverTerminationMs || !evidenceText(record.brokerEvidence)) return null;
    return deepFreeze({ type, takeoverId: record.takeoverId, workerId: record.workerId, atMs: record.atMs, acknowledgementTimeoutMs: record.acknowledgementTimeoutMs, terminationTimeoutMs: record.terminationTimeoutMs, brokerEvidence: record.brokerEvidence });
  }
  if (type === "worker_ack") {
    const record = readDataObject(value, ["type", "takeoverId", "workerId", "acknowledgementId", "atMs", "brokerEvidence"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.acknowledgementId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !evidenceText(record.brokerEvidence)) return null;
    return deepFreeze({ type, takeoverId: record.takeoverId, workerId: record.workerId, acknowledgementId: record.acknowledgementId, atMs: record.atMs, brokerEvidence: record.brokerEvidence });
  }
  if (type === "terminated") {
    const record = readDataObject(value, ["type", "takeoverId", "workerId", "terminationId", "atMs", "brokerEvidence"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.terminationId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !evidenceText(record.brokerEvidence)) return null;
    return deepFreeze({ type, takeoverId: record.takeoverId, workerId: record.workerId, terminationId: record.terminationId, atMs: record.atMs, brokerEvidence: record.brokerEvidence });
  }
  if (type === "timeout") {
    const record = readDataObject(value, ["type", "atMs", "brokerEvidence"], [], budget);
    return record && nonNegativeInteger(record.atMs) && evidenceText(record.brokerEvidence) ? deepFreeze({ type, atMs: record.atMs, brokerEvidence: record.brokerEvidence }) : null;
  }
  return null;
};

const decodeTakeoverInternal = (value: unknown, budget: DecodeBudget): TakeoverState | null => {
  const status = readDiscriminant(value, "status", budget);
  if (status === "idle") {
    const record = readDataObject(value, ["status", "epoch", "lastEventAtMs"], [], budget);
    return record && nonNegativeInteger(record.epoch) && nonNegativeInteger(record.lastEventAtMs) ? deepFreeze({ status, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs }) : null;
  }
  if (status === "revocation_pending") {
    const record = readDataObject(value, ["status", "takeoverId", "workerId", "requestedAtMs", "acknowledgementDeadlineMs", "terminationDeadlineMs", "epoch", "lastEventAtMs"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.requestedAtMs) || !nonNegativeInteger(record.acknowledgementDeadlineMs) || !nonNegativeInteger(record.terminationDeadlineMs) || record.acknowledgementDeadlineMs <= record.requestedAtMs || record.terminationDeadlineMs <= record.acknowledgementDeadlineMs || !positiveInteger(record.epoch) || record.lastEventAtMs !== record.requestedAtMs) return null;
    return deepFreeze({ status, takeoverId: record.takeoverId, workerId: record.workerId, requestedAtMs: record.requestedAtMs, acknowledgementDeadlineMs: record.acknowledgementDeadlineMs, terminationDeadlineMs: record.terminationDeadlineMs, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs });
  }
  if (status === "acknowledged") {
    const record = readDataObject(value, ["status", "takeoverId", "workerId", "acknowledgementId", "atMs", "epoch", "lastEventAtMs"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.acknowledgementId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !positiveInteger(record.epoch) || record.lastEventAtMs !== record.atMs) return null;
    return deepFreeze({ status, takeoverId: record.takeoverId, workerId: record.workerId, acknowledgementId: record.acknowledgementId, atMs: record.atMs, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs });
  }
  if (status === "termination_required") {
    const record = readDataObject(value, ["status", "takeoverId", "workerId", "requestedAtMs", "terminationDeadlineMs", "epoch", "lastEventAtMs"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.requestedAtMs) || !nonNegativeInteger(record.terminationDeadlineMs) || record.terminationDeadlineMs <= record.requestedAtMs || !positiveInteger(record.epoch) || !nonNegativeInteger(record.lastEventAtMs) || record.lastEventAtMs < record.requestedAtMs) return null;
    return deepFreeze({ status, takeoverId: record.takeoverId, workerId: record.workerId, requestedAtMs: record.requestedAtMs, terminationDeadlineMs: record.terminationDeadlineMs, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs });
  }
  if (status === "terminated") {
    const record = readDataObject(value, ["status", "takeoverId", "workerId", "terminationId", "atMs", "epoch", "lastEventAtMs"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.terminationId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !positiveInteger(record.epoch) || record.lastEventAtMs !== record.atMs) return null;
    return deepFreeze({ status, takeoverId: record.takeoverId, workerId: record.workerId, terminationId: record.terminationId, atMs: record.atMs, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs });
  }
  if (status === "termination_unconfirmed") {
    const record = readDataObject(value, ["status", "takeoverId", "workerId", "atMs", "epoch", "lastEventAtMs"], [], budget);
    if (!record || !boundedString(record.takeoverId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !positiveInteger(record.epoch) || record.lastEventAtMs !== record.atMs) return null;
    return deepFreeze({ status, takeoverId: record.takeoverId, workerId: record.workerId, atMs: record.atMs, epoch: record.epoch, lastEventAtMs: record.lastEventAtMs });
  }
  return null;
};

export function decodeTakeoverState(value: unknown): TakeoverState | null {
  try {
    const parsed = parseBoundedJsonTransport(value);
    return parsed === null ? null : decodeTakeoverInternal(parsed, newBudget());
  } catch { return null; }
}

const revokeAllBrokerActions = (state: BrokerState): void => {
  for (const approval of state.approvals.values()) if (approval.state === "active" || approval.state === "leased") approval.state = "revoked";
  for (const lease of state.leases.values()) if (lease.state === "leased" || lease.state === "started") lease.state = "revoked";
};

export function applyTakeoverEvent(stateTransport: unknown, eventTransport: unknown, broker: ComputerUseBroker): TakeoverState {
  try {
    const internal = brokerState(broker);
    if (!internal) return createTakeoverState();
    const stateValue = parseBoundedJsonTransport(stateTransport);
    const eventValue = parseBoundedJsonTransport(eventTransport);
    // The supplied state is only a bounded compatibility snapshot. The broker's
    // state is authoritative so a forged or stale snapshot cannot suppress an
    // acknowledgement deadline, termination, or revocation.
    if (stateValue !== null) decodeTakeoverInternal(stateValue, newBudget());
    if (eventValue === null) return internal.takeoverState;
    const state = internal.takeoverState;
    const event = decodeTakeoverEvent(eventValue, newBudget());
    if (!event || event.atMs !== internal.trustedNowMs || event.atMs < state.lastEventAtMs || state.epoch !== internal.takeoverEpoch) return state;
    const commit = (next: TakeoverState): TakeoverState => {
      internal.takeoverState = next;
      internal.takeoverEpoch = next.epoch;
      return next;
    };
    const { brokerEvidence, ...unsigned } = event;
    const evidenceDomain = event.type === "worker_ack" || event.type === "terminated" ? "takeover-worker-event-v1" : "takeover-event-v1";
    if (!constantTimeEqual(brokerEvidence, brokerSign(broker, evidenceDomain, unsigned))) return state;
    if (event.type === "takeover" && state.status === "idle" && event.workerId === internal.authority.workerId) {
      const acknowledgementDeadlineMs = event.atMs + event.acknowledgementTimeoutMs;
      const terminationDeadlineMs = acknowledgementDeadlineMs + event.terminationTimeoutMs;
      const epoch = state.epoch + 1;
      if (!nonNegativeInteger(acknowledgementDeadlineMs) || !nonNegativeInteger(terminationDeadlineMs) || !positiveInteger(epoch)) return state;
      revokeAllBrokerActions(internal);
      return commit(deepFreeze({ status: "revocation_pending", takeoverId: event.takeoverId, workerId: event.workerId, requestedAtMs: event.atMs, acknowledgementDeadlineMs, terminationDeadlineMs, epoch, lastEventAtMs: event.atMs }));
    }
    if (state.status === "revocation_pending") {
      if (event.type === "worker_ack" && event.takeoverId === state.takeoverId && event.workerId === state.workerId && event.atMs <= state.acknowledgementDeadlineMs) return commit(deepFreeze({ status: "acknowledged", takeoverId: state.takeoverId, workerId: state.workerId, acknowledgementId: event.acknowledgementId, atMs: event.atMs, epoch: state.epoch, lastEventAtMs: event.atMs }));
      if ((event.type === "timeout" && event.atMs >= state.acknowledgementDeadlineMs) || (event.type === "worker_ack" && event.atMs > state.acknowledgementDeadlineMs)) return commit(deepFreeze({ status: "termination_required", takeoverId: state.takeoverId, workerId: state.workerId, requestedAtMs: state.acknowledgementDeadlineMs, terminationDeadlineMs: state.terminationDeadlineMs, epoch: state.epoch, lastEventAtMs: event.atMs }));
      if (event.type === "terminated" && event.takeoverId === state.takeoverId && event.workerId === state.workerId && event.atMs <= state.terminationDeadlineMs) return commit(deepFreeze({ status: "terminated", takeoverId: state.takeoverId, workerId: state.workerId, terminationId: event.terminationId, atMs: event.atMs, epoch: state.epoch, lastEventAtMs: event.atMs }));
    }
    if (state.status === "termination_required") {
      if (event.type === "terminated" && event.takeoverId === state.takeoverId && event.workerId === state.workerId && event.atMs <= state.terminationDeadlineMs) return commit(deepFreeze({ status: "terminated", takeoverId: state.takeoverId, workerId: state.workerId, terminationId: event.terminationId, atMs: event.atMs, epoch: state.epoch, lastEventAtMs: event.atMs }));
      if ((event.type === "timeout" && event.atMs >= state.terminationDeadlineMs) || (event.type === "terminated" && event.atMs > state.terminationDeadlineMs)) return commit(deepFreeze({ status: "termination_unconfirmed", takeoverId: state.takeoverId, workerId: state.workerId, atMs: event.atMs, epoch: state.epoch, lastEventAtMs: event.atMs }));
    }
    return state;
  } catch {
    return brokerState(broker)?.takeoverState ?? createTakeoverState();
  }
}

export function isTakeoverActive(state: TakeoverState): boolean {
  const decoded = decodeTakeoverInternal(state, newBudget());
  return Boolean(decoded && decoded.status !== "idle");
}

export interface ComputerUseAllowLists {
  readonly clipboardOperations: readonly ClipboardOperation[];
  readonly processOperations: readonly ProcessOperation[];
  readonly executableAuthorities: readonly ExecutableIdentity[];
  readonly dataCategories: readonly DataCategory[];
}

const decodeAllowLists = (value: unknown, budget: DecodeBudget): ComputerUseAllowLists | null => {
  const record = readDataObject(value, ["clipboardOperations", "processOperations", "executableAuthorities", "dataCategories"], [], budget);
  if (!record) return null;
  const clipboardValues = readDataArray(record.clipboardOperations, COMPUTER_USE_LIMITS.maxAllowlistItems, budget);
  const processValues = readDataArray(record.processOperations, COMPUTER_USE_LIMITS.maxAllowlistItems, budget);
  const executableValues = readDataArray(record.executableAuthorities, COMPUTER_USE_LIMITS.maxAllowlistItems, budget);
  const categoryValues = readDataArray(record.dataCategories, COMPUTER_USE_LIMITS.maxAllowlistItems, budget);
  if (!clipboardValues || !processValues || !executableValues || !categoryValues || clipboardValues.some((item) => item !== "read" && item !== "write") || processValues.some((item) => item !== "launch" && item !== "terminate") || categoryValues.some((item) => typeof item !== "string" || !DATA_CATEGORIES.includes(item as DataCategory))) return null;
  const executableAuthorities: ExecutableIdentity[] = [];
  for (const item of executableValues) {
    const decoded = decodeExecutableIdentity(item, budget);
    if (!decoded) return null;
    executableAuthorities.push(decoded);
  }
  return deepFreeze({ clipboardOperations: clipboardValues as ClipboardOperation[], processOperations: processValues as ProcessOperation[], executableAuthorities, dataCategories: categoryValues as DataCategory[] });
};

export interface ComputerUsePolicyContext {
  readonly nowMs: number;
  readonly authority: AuthorityBinding;
  readonly readiness: SecurityReadiness;
  readonly foreground: ForegroundBinding | null;
  readonly display: DisplayMetadata | null;
  readonly security: SecurityContext;
  readonly approvals: readonly ApprovalGrant[];
  readonly takeover: TakeoverState;
  readonly approvalEpoch: number;
  readonly freshnessEpoch: number;
  readonly allowlists: ComputerUseAllowLists;
}

const decodePolicyContext = (value: unknown, broker: ComputerUseBroker): ComputerUsePolicyContext | null => {
  const budget = newBudget();
  const record = readDataObject(value, ["nowMs", "authority", "readiness", "foreground", "display", "security", "approvals", "takeover", "approvalEpoch", "freshnessEpoch", "allowlists"], [], budget);
  if (!record || !nonNegativeInteger(record.nowMs) || !positiveInteger(record.approvalEpoch) || !positiveInteger(record.freshnessEpoch)) return null;
  const authority = decodeAuthority(record.authority, budget);
  const readiness = decodeSecurityReadiness(record.readiness, broker, budget);
  const foreground = record.foreground === null ? null : decodeForegroundInternal(record.foreground, budget);
  const display = record.display === null ? null : decodeDisplayInternal(record.display, budget);
  const security = decodeSecurityContext(record.security, budget);
  const approvalValues = readDataArray(record.approvals, COMPUTER_USE_LIMITS.maxApprovals, budget);
  const takeover = decodeTakeoverInternal(record.takeover, budget);
  const allowlists = decodeAllowLists(record.allowlists, budget);
  const state = brokerState(broker);
  if (!authority || !readiness || !state || record.nowMs !== state.trustedNowMs || (record.foreground !== null && !foreground) || (record.display !== null && !display) || !security || !approvalValues || !takeover || !allowlists) return null;
  const approvals: ApprovalGrant[] = [];
  for (const item of approvalValues) {
    const decoded = decodeApprovalInternal(item, broker, budget);
    if (!decoded) return null;
    approvals.push(decoded);
  }
  return deepFreeze({ nowMs: record.nowMs, authority, readiness, foreground, display, security, approvals, takeover, approvalEpoch: record.approvalEpoch, freshnessEpoch: record.freshnessEpoch, allowlists });
};

export type ComputerUseDenialReason =
  | "default-deny" | "broker-unbound" | "authority-mismatch" | "readiness-not-enforced" | "readiness-expired"
  | "invalid-target" | "process-mismatch" | "window-mismatch" | "control-mismatch" | "executable-target-mismatch"
  | "target-not-visible" | "target-occluded" | "target-disabled" | "foreground-unbound" | "foreground-mismatch" | "foreground-expired" | "focused-control-mismatch"
  | "missing-approval" | "approval-expired" | "approval-used" | "approval-revoked" | "approval-epoch-mismatch" | "approval-target-mismatch" | "approval-action-mismatch"
  | "password-field" | "secure-desktop" | "higher-integrity" | "takeover-active" | "stale-decision"
  | "missing-display-metadata" | "coordinate-invalid" | "clipboard-denied" | "process-denied" | "executable-denied"
  | "sensitive-data-category" | "redaction-required" | "persistence-denied" | "data-limit-exceeded";

export interface ApprovalToken { readonly approvalId: string; readonly epoch: number; readonly actionDigest: string; readonly targetDigest: string; readonly geometryDigest: string | null; readonly expiresAtMs: number; readonly brokerEvidence: string }
export interface TakeoverToken { readonly state: "idle"; readonly epoch: number; readonly stateDigest: string; readonly brokerEvidence: string }
export interface FreshnessToken { readonly epoch: number; readonly authorityDigest: string; readonly readinessDigest: string; readonly foregroundDigest: string; readonly displayDigest: string | null; readonly takeoverDigest: string; readonly actionDigest: string; readonly targetDigest: string; readonly brokerEvidence: string }
export interface LeaseToken { readonly leaseId: string; readonly attemptId: string; readonly state: "leased"; readonly version: 1; readonly approvalId: string; readonly actionDigest: string; readonly targetDigest: string; readonly authorityDigest: string; readonly expiresAtMs: number; readonly brokerEvidence: string }
export interface StartedToken { readonly leaseId: string; readonly state: "started"; readonly version: 2; readonly workerId: string; readonly startedAtMs: number; readonly brokerEvidence: string }

export interface ActionLedgerScope {
  readonly authority: AuthorityBinding;
  readonly authorityDigest: string;
  readonly kind: ComputerUseIntentKind;
  readonly intentId: string;
  readonly approvalId: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly approvalEpoch: number;
  readonly freshnessEpoch: number;
  readonly takeoverEpoch: number;
  readonly foregroundEpoch: number | null;
  readonly policyEpoch: number;
  readonly brokerEpoch: number;
  readonly workerEpoch: number;
  readonly readinessEpoch: number;
  readonly readinessDigest: string;
  readonly foregroundDigest: string | null;
  readonly displayDigest: string | null;
  readonly takeoverDigest: string;
  readonly actionDigest: string;
  readonly targetDigest: string;
  readonly geometryDigest: string | null;
  readonly dataPolicyDigest: string | null;
  readonly executableDigest: string | null;
  readonly scopeEvidence: string;
}

export type ComputerUseDecision =
  | { readonly allowed: false; readonly reason: ComputerUseDenialReason }
  | {
      readonly allowed: true;
      readonly kind: ComputerUseIntentKind;
      readonly intentId: string;
      readonly authority: AuthorityBinding;
      readonly target: ComputerUseTarget;
      readonly targetRect: Rect;
      readonly captureRect?: Rect;
      readonly displayDigest: string | null;
      readonly coordinate?: ScreenCoordinate;
      readonly actionDigest: string;
      readonly targetDigest: string;
      readonly geometryDigest: string | null;
      readonly approvalToken: ApprovalToken;
      readonly takeoverToken: TakeoverToken;
      readonly freshnessToken: FreshnessToken;
      readonly leaseToken: LeaseToken;
      readonly ledgerScope: ActionLedgerScope;
      readonly brokerEvidence: string;
    };

export type ExecutionRevalidation =
  | { readonly allowed: false; readonly reason: ComputerUseDenialReason }
  | (Extract<ComputerUseDecision, { readonly allowed: true }> & { readonly startedToken: StartedToken; readonly nextContext: ComputerUsePolicyContext });

const denied = (reason: ComputerUseDenialReason): ComputerUseDecision => deepFreeze({ allowed: false, reason });

const rawBrokerInstance = (context: unknown): string | null => {
  try {
    if (!context || typeof context !== "object") return null;
    const readiness = Object.getOwnPropertyDescriptor(context, "readiness");
    if (!readiness || !("value" in readiness) || !readiness.value || typeof readiness.value !== "object") return null;
    const instance = Object.getOwnPropertyDescriptor(readiness.value, "brokerInstanceId");
    return instance && "value" in instance && typeof instance.value === "string" ? instance.value : null;
  } catch {
    return null;
  }
};

interface PolicySuccess {
  readonly grant: ApprovalGrant;
  readonly actionDigest: string;
  readonly targetDigest: string;
  readonly geometryDigest: string | null;
  readonly targetRect: Rect;
  readonly captureRect?: Rect;
  readonly displayDigest: string | null;
  readonly coordinate?: ScreenCoordinate;
}

const dataPolicyStatus = (intent: ComputerUseIntent, allowlists: ComputerUseAllowLists): ComputerUseDenialReason | null => {
  if (intent.kind !== "screenshot" && intent.kind !== "clipboard") return null;
  const policy = intent.dataPolicy;
  if (!allowlists.dataCategories.includes(policy.category) || SENSITIVE_CATEGORIES.has(policy.category)) return "sensitive-data-category";
  if (policy.redaction !== "required" || !policy.redactorId) return "redaction-required";
  if (policy.persistence === "durable" || policy.retentionMs > COMPUTER_USE_LIMITS.maxRetentionMs || (policy.persistence === "none" && policy.retentionMs !== 0)) return "persistence-denied";
  const maximum = intent.kind === "screenshot" ? COMPUTER_USE_LIMITS.maxScreenshotBytes : COMPUTER_USE_LIMITS.maxClipboardTextBytes;
  if (policy.maxBytes > maximum) return "data-limit-exceeded";
  if (intent.kind === "clipboard" && intent.operation === "write" && utf8.encode(intent.text).byteLength > policy.maxBytes) return "data-limit-exceeded";
  return null;
};

const foregroundStatus = (intent: ComputerUseIntent, context: ComputerUsePolicyContext): ComputerUseDenialReason | null => {
  const binding = context.foreground;
  if (!binding) return "foreground-unbound";
  if (context.nowMs < binding.boundAtMs) return "foreground-unbound";
  if (context.nowMs >= binding.expiresAtMs) return "foreground-expired";
  if (binding.preState.observedAtMs > context.nowMs) return "stale-decision";
  if (context.nowMs - binding.preState.observedAtMs > COMPUTER_USE_LIMITS.maxUiObservationAgeMs) return "stale-decision";
  if (!sameWindowIdentity(intent.target.window, binding.window) || !sameUiPreState(intent.target.preState, binding.preState)) return "foreground-mismatch";
  if (intent.kind === "input" && intent.action.type === "keyboard" && (!intent.target.control || !binding.focusedControl || !sameControlIdentity(intent.target.control, binding.focusedControl))) return "focused-control-mismatch";
  return null;
};

const executableStatus = (intent: ComputerUseIntent, allowlists: ComputerUseAllowLists): ComputerUseDenialReason | null => {
  if (intent.kind !== "process" && intent.kind !== "executable") return null;
  if (!sameExecutableIdentity(intent.executable, intent.target.process.executable)) return "executable-target-mismatch";
  if (!allowlists.executableAuthorities.some((allowed) => sameExecutableIdentity(allowed, intent.executable))) return intent.kind === "process" ? "process-denied" : "executable-denied";
  if (intent.kind === "process" && !allowlists.processOperations.includes(intent.operation)) return "process-denied";
  return null;
};

const matchingApproval = (intent: ComputerUseIntent, context: ComputerUsePolicyContext, broker: ComputerUseBroker, actionDigest: string, targetDigest: string, geometryDigest: string | null, allowLeasedId?: string): ApprovalGrant | ComputerUseDenialReason => {
  const state = brokerState(broker);
  let fallback: ComputerUseDenialReason = "missing-approval";
  for (const grant of context.approvals) {
    if (grant.kind !== intent.kind || grant.intentId !== intent.intentId) continue;
    if (!sameAuthority(grant.authority, intent.authority)) return "authority-mismatch";
    if (grant.targetDigest !== targetDigest || !sameComputerUseTarget(grant.target, intent.target)) { fallback = "approval-target-mismatch"; continue; }
    if (grant.actionDigest !== actionDigest || grant.scope.actionDigest !== actionDigest || grant.scope.geometryDigest !== geometryDigest || grant.scope.dataPolicyDigest !== dataPolicyDigestFor(intent) || grant.scope.executableDigest !== executableDigestFor(intent)) { fallback = "approval-action-mismatch"; continue; }
    const internal = state?.approvals.get(grant.approvalId);
    if (!internal) return "default-deny";
    if (internal.state === "revoked" || grant.revoked || grant.status === "revoked") return "approval-revoked";
    if (internal.state === "used" || grant.used || grant.status === "used") return "approval-used";
    if (internal.state === "leased" && internal.leaseId !== allowLeasedId) return "approval-used";
    if (grant.epoch !== context.approvalEpoch) return "approval-epoch-mismatch";
    if (context.nowMs < grant.grantedAtMs) return "missing-approval";
    if (context.nowMs >= grant.expiresAtMs) return "approval-expired";
    return grant;
  }
  return fallback;
};

const evaluatePolicy = (intent: ComputerUseIntent, context: ComputerUsePolicyContext, broker: ComputerUseBroker, allowLeasedId?: string): PolicySuccess | ComputerUseDenialReason => {
  const state = brokerState(broker);
  if (!state) return "broker-unbound";
  if (!sameAuthority(intent.authority, context.authority) || !sameAuthority(intent.authority, state.authority)) return "authority-mismatch";
  if (context.readiness.status !== "enforced") return "readiness-not-enforced";
  if (context.nowMs < context.readiness.checkedAtMs || context.nowMs >= context.readiness.expiresAtMs) return "readiness-expired";
  if (context.takeover.status !== "idle" || context.takeover.epoch !== state.takeoverEpoch || stableEncode(context.takeover) !== stableEncode(state.takeoverState)) return "takeover-active";
  const targetValidation = validateComputerUseTarget(intent.target);
  if (targetValidation !== "valid") return targetValidation;
  if (intent.target.preState.windowState === "minimized" || intent.target.preState.windowState === "closed" || !intent.target.preState.visible || !intent.target.preState.foreground) return "target-not-visible";
  if (intent.target.preState.occlusion !== "none") return "target-occluded";
  if (!intent.target.preState.enabled) return "target-disabled";
  if (context.security.passwordField || intent.target.control?.passwordField) return "password-field";
  if (context.security.secureDesktop) return "secure-desktop";
  if (integrityRank[context.security.targetIntegrity] > integrityRank[context.security.callerIntegrity]) return "higher-integrity";
  const executable = executableStatus(intent, context.allowlists);
  if (executable) return executable;
  if (intent.kind === "clipboard" && !context.allowlists.clipboardOperations.includes(intent.operation)) return "clipboard-denied";
  const data = dataPolicyStatus(intent, context.allowlists);
  if (data) return data;
  const foreground = foregroundStatus(intent, context);
  if (foreground) return foreground;
  if ((intent.kind === "input" && intent.action.type === "mouse") || intent.kind === "screenshot") if (!context.display) return "missing-display-metadata";
  const targetRect = exactTargetRect(intent.target);
  if (context.display && !containsRect(context.display.virtualBounds, targetRect)) return "coordinate-invalid";
  let coordinate: ScreenCoordinate | undefined;
  let captureRect: Rect | undefined;
  if (intent.kind === "input" && intent.action.type === "mouse") {
    coordinate = context.display ? resolveDecodedCoordinate(intent.action.coordinate, context.display) ?? undefined : undefined;
    if (!coordinate || coordinate.x < targetRect.left || coordinate.x >= targetRect.right || coordinate.y < targetRect.top || coordinate.y >= targetRect.bottom) return "coordinate-invalid";
  }
  if (intent.kind === "screenshot") {
    captureRect = intent.region && context.display ? resolveScreenRegion(intent.region, context.display) ?? undefined : targetRect;
    if (!captureRect || !containsRect(targetRect, captureRect)) return "coordinate-invalid";
  }
  const actionDigest = digestComputerUseIntent(intent, context.display);
  const targetDigest = digestComputerUseTarget(intent.target);
  const geometryDigest = geometryDigestFor(intent, context.display);
  if (!actionDigest || !targetDigest) return "default-deny";
  const grant = matchingApproval(intent, context, broker, actionDigest, targetDigest, geometryDigest, allowLeasedId);
  return typeof grant === "string" ? grant : { grant, actionDigest, targetDigest, geometryDigest, targetRect, ...(captureRect ? { captureRect } : {}), displayDigest: context.display ? digestValue(context.display) : null, ...(coordinate ? { coordinate } : {}) };
};

const approvalToken = (grant: ApprovalGrant, broker: ComputerUseBroker): ApprovalToken => {
  const unsigned = { approvalId: grant.approvalId, epoch: grant.epoch, actionDigest: grant.actionDigest, targetDigest: grant.targetDigest, geometryDigest: grant.scope.geometryDigest, expiresAtMs: grant.expiresAtMs };
  return deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "approval-token-v1", unsigned) });
};

const freshnessToken = (intent: ComputerUseIntent, context: ComputerUsePolicyContext, result: PolicySuccess, broker: ComputerUseBroker): FreshnessToken => {
  const unsigned = { epoch: context.freshnessEpoch, authorityDigest: authorityDigest(intent.authority), readinessDigest: digestValue(context.readiness), foregroundDigest: digestValue(context.foreground), displayDigest: context.display ? digestValue(context.display) : null, takeoverDigest: digestValue(context.takeover), actionDigest: result.actionDigest, targetDigest: result.targetDigest };
  return deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "freshness-token-v1", unsigned) });
};

const takeoverToken = (context: ComputerUsePolicyContext, broker: ComputerUseBroker): TakeoverToken => {
  const unsigned = { state: "idle" as const, epoch: context.takeover.epoch, stateDigest: digestValue(context.takeover) };
  return deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "takeover-token-v1", unsigned) });
};

function createActionLedgerScope(intentValue: ComputerUseIntent, grantValue: ApprovalGrant, contextValue: ComputerUsePolicyContext, leaseToken: LeaseToken, broker: ComputerUseBroker): ActionLedgerScope {
  const intent = decodeIntentInternal(intentValue, newBudget());
  const context = decodePolicyContext(contextValue, broker);
  const grant = decodeApprovalInternal(grantValue, broker, newBudget());
  const state = brokerState(broker);
  const lease = state?.leases.get(leaseToken.leaseId);
  if (!intent || !context || !grant || !state || !lease || lease.attemptId !== leaseToken.attemptId || lease.approvalId !== grant.approvalId || grant.intentId !== intent.intentId || grant.kind !== intent.kind || grant.epoch !== context.approvalEpoch || !sameAuthority(intent.authority, context.authority) || !sameAuthority(intent.authority, state.authority)) throw new RangeError("Action ledger scope is invalid");
  const actionDigest = digestComputerUseIntent(intent, context.display);
  const targetDigest = digestComputerUseTarget(intent.target);
  const geometryDigest = geometryDigestFor(intent, context.display);
  const dataPolicyDigest = dataPolicyDigestFor(intent);
  const executableDigest = executableDigestFor(intent);
  const contextGrant = context.approvals.find(({ approvalId }) => approvalId === grant.approvalId);
  if (!contextGrant || contextGrant.brokerEvidence !== grant.brokerEvidence || grant.actionDigest !== actionDigest || grant.targetDigest !== targetDigest || grant.scope.geometryDigest !== geometryDigest || grant.scope.dataPolicyDigest !== dataPolicyDigest || grant.scope.executableDigest !== executableDigest) throw new RangeError("Action ledger scope is invalid");
  const unsigned = {
    authority: state.authority,
    authorityDigest: state.authorityDigest,
    kind: intent.kind,
    intentId: intent.intentId,
    approvalId: grant.approvalId,
    leaseId: leaseToken.leaseId,
    attemptId: leaseToken.attemptId,
    approvalEpoch: context.approvalEpoch,
    freshnessEpoch: context.freshnessEpoch,
    takeoverEpoch: context.takeover.epoch,
    foregroundEpoch: context.foreground?.epoch ?? null,
    policyEpoch: state.authority.policyEpoch,
    brokerEpoch: state.authority.brokerEpoch,
    workerEpoch: state.authority.workerEpoch,
    readinessEpoch: state.authority.readinessEpoch,
    readinessDigest: digestValue(context.readiness),
    foregroundDigest: context.foreground ? digestValue(context.foreground) : null,
    displayDigest: context.display ? digestValue(context.display) : null,
    takeoverDigest: digestValue(context.takeover),
    actionDigest: grant.actionDigest,
    targetDigest: grant.targetDigest,
    geometryDigest: grant.scope.geometryDigest,
    dataPolicyDigest: grant.scope.dataPolicyDigest,
    executableDigest: grant.scope.executableDigest,
  };
  return deepFreeze({ ...unsigned, scopeEvidence: brokerSign(broker, "ledger-scope-v1", unsigned) });
}

const leaseApproval = (result: PolicySuccess, intent: ComputerUseIntent, leasedAtMs: number, broker: ComputerUseBroker): LeaseToken | null => {
  const state = brokerState(broker);
  const approval = state?.approvals.get(result.grant.approvalId);
  if (!state || !approval || approval.state !== "active") return null;
  state.leaseCounter += 1;
  if (!positiveInteger(state.leaseCounter)) return null;
  const leaseId = brokerSign(broker, "lease-id-v1", { counter: state.leaseCounter, approvalId: result.grant.approvalId, actionDigest: result.actionDigest, intentId: intent.intentId });
  const attemptId = brokerSign(broker, "attempt-id-v1", { leaseId, counter: state.leaseCounter, workerId: state.authority.workerId });
  const unsigned = { leaseId, attemptId, state: "leased" as const, version: 1 as const, approvalId: result.grant.approvalId, actionDigest: result.actionDigest, targetDigest: result.targetDigest, authorityDigest: state.authorityDigest, expiresAtMs: result.grant.expiresAtMs };
  const token = deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "lease-token-v1", unsigned) });
  approval.state = "leased";
  approval.leaseId = leaseId;
  state.leases.set(leaseId, { approvalId: result.grant.approvalId, attemptId, kind: intent.kind, actionDigest: result.actionDigest, targetDigest: result.targetDigest, authorityDigest: state.authorityDigest, expiresAtMs: result.grant.expiresAtMs, leasedAtMs, captureRect: result.captureRect ?? null, dataPolicy: intent.kind === "screenshot" || intent.kind === "clipboard" ? intent.dataPolicy : null, state: "leased", version: 1 });
  return token;
};

const decisionSnapshot = (decision: Omit<Extract<ComputerUseDecision, { readonly allowed: true }>, "brokerEvidence">): unknown => decision;

export function evaluateComputerUseIntent(intentTransport: unknown, contextTransport: unknown, broker: ComputerUseBroker): ComputerUseDecision {
  try {
    const state = brokerState(broker);
    if (!state) return denied("broker-unbound");
    const intentValue = parseBoundedJsonTransport(intentTransport);
    const contextValue = parseBoundedJsonTransport(contextTransport);
    if (intentValue === null || contextValue === null) return denied("default-deny");
    const rawInstance = rawBrokerInstance(contextValue);
    if (rawInstance && rawInstance !== state.instanceId) return denied("broker-unbound");
    const intent = decodeIntentInternal(intentValue, newBudget());
    const context = decodePolicyContext(contextValue, broker);
    if (!intent || !context) return denied("default-deny");
    const result = evaluatePolicy(intent, context, broker);
    if (typeof result === "string") return denied(result);
    const leaseToken = leaseApproval(result, intent, context.nowMs, broker);
    if (!leaseToken) return denied("approval-used");
    const ledgerScope = createActionLedgerScope(intent, result.grant, context, leaseToken, broker);
    const unsigned = deepFreeze({
      allowed: true as const,
      kind: intent.kind,
      intentId: intent.intentId,
      authority: intent.authority,
      target: intent.target,
      targetRect: result.targetRect,
      ...(result.captureRect ? { captureRect: result.captureRect } : {}),
      displayDigest: result.displayDigest,
      ...(result.coordinate ? { coordinate: result.coordinate } : {}),
      actionDigest: result.actionDigest,
      targetDigest: result.targetDigest,
      geometryDigest: result.geometryDigest,
      approvalToken: approvalToken(result.grant, broker),
      takeoverToken: takeoverToken(context, broker),
      freshnessToken: freshnessToken(intent, context, result, broker),
      leaseToken,
      ledgerScope,
    });
    const decision = deepFreeze({ ...unsigned, brokerEvidence: brokerSign(broker, "decision-v1", decisionSnapshot(unsigned)) });
    trustedDecisionOwners.set(decision, broker as object);
    return decision;
  } catch {
    return denied("default-deny");
  }
}

const validDecisionEvidence = (
  decision: ComputerUseDecision,
  broker: ComputerUseBroker,
): decision is Extract<ComputerUseDecision, { readonly allowed: true }> => {
  try {
    if (typeof decision !== "object" || decision === null || trustedDecisionOwners.get(decision) !== broker || !decision.allowed) return false;
    if (!evidenceText(decision.brokerEvidence) || !evidenceText(decision.leaseToken.brokerEvidence)) return false;
    const { brokerEvidence: _evidence, ...unsigned } = decision;
    const { brokerEvidence: _leaseEvidence, ...unsignedLease } = decision.leaseToken;
    return constantTimeEqual(decision.brokerEvidence, brokerSign(broker, "decision-v1", decisionSnapshot(unsigned))) && constantTimeEqual(decision.leaseToken.brokerEvidence, brokerSign(broker, "lease-token-v1", unsignedLease));
  } catch {
    return false;
  }
};

const projectConsumedContext = (context: ComputerUsePolicyContext, approvalId: string): ComputerUsePolicyContext => {
  const approvals = context.approvals.map((grant) => grant.approvalId === approvalId ? deepFreeze({ ...grant, status: "used" as const, used: true, revoked: false, usedAtMs: context.nowMs }) : grant);
  return deepFreeze({ ...context, approvals, approvalEpoch: context.approvalEpoch + 1, freshnessEpoch: context.freshnessEpoch + 1 });
};

export function revalidateBeforeExecution(decision: ComputerUseDecision, intentTransport: unknown, contextTransport: unknown, broker: ComputerUseBroker): ExecutionRevalidation {
  try {
    if (!validDecisionEvidence(decision, broker)) return { allowed: false, reason: "stale-decision" };
    const state = brokerState(broker);
    const lease = state?.leases.get(decision.leaseToken.leaseId);
    const approval = state?.approvals.get(decision.approvalToken.approvalId);
    if (!state || !lease || !approval) return { allowed: false, reason: "stale-decision" };
    if (lease.state === "revoked" || approval.state === "revoked") return { allowed: false, reason: "approval-revoked" };
    if (lease.state !== "leased" || lease.version !== 1 || lease.attemptId !== decision.leaseToken.attemptId || approval.state !== "leased" || approval.leaseId !== decision.leaseToken.leaseId) return { allowed: false, reason: "approval-used" };
    const intentValue = parseBoundedJsonTransport(intentTransport);
    const contextValue = parseBoundedJsonTransport(contextTransport);
    if (intentValue === null || contextValue === null) return { allowed: false, reason: "default-deny" };
    const intent = decodeIntentInternal(intentValue, newBudget());
    const context = decodePolicyContext(contextValue, broker);
    if (!intent || !context) return { allowed: false, reason: "default-deny" };
    if (context.nowMs < lease.leasedAtMs || context.nowMs - lease.leasedAtMs > COMPUTER_USE_LIMITS.maxLeaseFreshnessMs) return { allowed: false, reason: "stale-decision" };
    if (context.foreground && sameWindowIdentity(intent.target.window, context.foreground.window) && !sameUiPreState(intent.target.preState, context.foreground.preState)) {
      return { allowed: false, reason: "stale-decision" };
    }
    const result = evaluatePolicy(intent, context, broker, decision.leaseToken.leaseId);
    if (typeof result === "string") return { allowed: false, reason: result };
    if (result.actionDigest !== decision.actionDigest || result.targetDigest !== decision.targetDigest || result.geometryDigest !== decision.geometryDigest || stableEncode(freshnessToken(intent, context, result, broker)) !== stableEncode(decision.freshnessToken) || stableEncode(takeoverToken(context, broker)) !== stableEncode(decision.takeoverToken)) return { allowed: false, reason: "stale-decision" };
    if (context.nowMs >= lease.expiresAtMs) return { allowed: false, reason: "approval-expired" };
    lease.state = "started";
    lease.version = 2;
    approval.state = "used";
    const startedUnsigned = { leaseId: decision.leaseToken.leaseId, state: "started" as const, version: 2 as const, workerId: state.authority.workerId, startedAtMs: context.nowMs };
    const startedToken = deepFreeze({ ...startedUnsigned, brokerEvidence: brokerSign(broker, "started-token-v1", startedUnsigned) });
    return deepFreeze({ ...decision, startedToken, nextContext: projectConsumedContext(context, decision.approvalToken.approvalId) });
  } catch {
    return { allowed: false, reason: "default-deny" };
  }
}

export function revokeApproval(contextTransport: unknown, approvalId: string, atMs: number, broker: ComputerUseBroker): ComputerUsePolicyContext {
  try {
    const contextValue = parseBoundedJsonTransport(contextTransport);
    const context = decodePolicyContext(contextValue, broker);
    const state = brokerState(broker);
    if (!context || !state || typeof approvalId !== "string" || approvalId.length === 0 || !nonNegativeInteger(atMs)) return context ?? safePolicyContext(state?.authority, broker);
    const internal = state.approvals.get(approvalId);
    if (!internal || internal.state === "used" || internal.state === "revoked") return context;
    internal.state = "revoked";
    if (internal.leaseId) {
      const lease = state.leases.get(internal.leaseId);
      if (lease) lease.state = "revoked";
    }
    const approvals = context.approvals.map((grant) => grant.approvalId === approvalId ? deepFreeze({ ...grant, used: false, revoked: true, status: "revoked" as const, revokedAtMs: atMs }) : grant);
    return deepFreeze({ ...context, approvals, approvalEpoch: context.approvalEpoch + 1, freshnessEpoch: context.freshnessEpoch + 1 });
  } catch {
    return safePolicyContext(brokerState(broker)?.authority, broker);
  }
}

const safePolicyContext = (authority: AuthorityBinding | undefined, broker: ComputerUseBroker): ComputerUsePolicyContext => {
  const fallback = authority ?? ({ accountId: "deny", projectId: "deny", chatId: "deny", sessionId: "deny", principalId: "deny", policyId: "deny", brokerId: "deny", workerId: "deny", accountEpoch: 1, projectEpoch: 1, chatEpoch: 1, sessionEpoch: 1, principalEpoch: 1, policyEpoch: 1, brokerEpoch: 1, workerEpoch: 1, readinessEpoch: 1 } as const);
  let readiness: SecurityReadiness;
  try { readiness = createSecurityReadiness(broker, { status: "unavailable", checkedAtMs: 0, expiresAtMs: 1, runtimeSha256: "0".repeat(64), securityExtensionSha256: "0".repeat(64), brokerBinarySha256: "0".repeat(64), workerBinarySha256: "0".repeat(64) }); }
  catch { readiness = deepFreeze({ status: "unavailable", policyVersion: COMPUTER_USE_POLICY_VERSION, brokerInstanceId: "deny", authorityDigest: digestValue(fallback), checkedAtMs: 0, expiresAtMs: 1, runtimeSha256: "0".repeat(64), securityExtensionSha256: "0".repeat(64), brokerBinarySha256: "0".repeat(64), workerBinarySha256: "0".repeat(64), brokerEvidence: `hmac-sha256:${"0".repeat(64)}` }); }
  return deepFreeze({ nowMs: 0, authority: fallback, readiness, foreground: null, display: null, security: { passwordField: true, secureDesktop: true, callerIntegrity: "low", targetIntegrity: "system" }, approvals: [], takeover: createTakeoverState(), approvalEpoch: 1, freshnessEpoch: 1, allowlists: { clipboardOperations: [], processOperations: [], executableAuthorities: [], dataCategories: [] } });
};

export type ActionLedgerStatus = "requested" | "approved" | "leased" | "started" | "dispatched" | "cancel_requested" | "completed" | "denied" | "cancelled" | "timed_out" | "outcome_unknown";
export type TerminalActionOutcome = "completed" | "denied" | "cancelled" | "timed_out" | "outcome_unknown" | "ledger_corrupt";

export interface ActionLedgerRecord {
  readonly sequence: number;
  readonly actionId: string;
  readonly intentId: string;
  readonly kind: ComputerUseIntentKind;
  readonly scope: ActionLedgerScope;
  readonly status: ActionLedgerStatus;
  readonly atMs: number;
  readonly reason?: string;
  readonly acknowledgementDeadlineMs?: number;
  readonly acknowledgementId?: string;
  readonly workerId?: string;
  readonly workerEvidenceDigest?: string;
  readonly effect?: WorkerEffectEvidence;
  readonly previousEvidence: string;
  readonly brokerEvidence: string;
}

export type ActionLedgerRecordInput = Omit<ActionLedgerRecord, "sequence" | "previousEvidence" | "brokerEvidence">;

export interface ActionLedger {
  readonly version: typeof COMPUTER_USE_POLICY_VERSION;
  readonly integrity: "healthy" | "corrupt";
  readonly ledgerId: string;
  readonly authorityDigest: string;
  readonly genesisEvidence: string;
  readonly headEvidence: string;
  readonly records: readonly ActionLedgerRecord[];
}

// Ledgers returned by this module are opaque in-process envelopes. Serialized
// ledgers must cross the same bounded JSON transport used by other boundaries;
// arbitrary caller objects are never enumerated to discover whether they fit.
const trustedLedgerOwners = new WeakMap<object, object>();
const trustLedger = <T extends ActionLedger>(ledger: T, broker: ComputerUseBroker): T => {
  trustedLedgerOwners.set(ledger, broker as object);
  return ledger;
};

const decodeLedgerScope = (value: unknown, broker: ComputerUseBroker, budget: DecodeBudget): ActionLedgerScope | null => {
  const record = readDataObject(value, ["authority", "authorityDigest", "kind", "intentId", "approvalId", "leaseId", "attemptId", "approvalEpoch", "freshnessEpoch", "takeoverEpoch", "foregroundEpoch", "policyEpoch", "brokerEpoch", "workerEpoch", "readinessEpoch", "readinessDigest", "foregroundDigest", "displayDigest", "takeoverDigest", "actionDigest", "targetDigest", "geometryDigest", "dataPolicyDigest", "executableDigest", "scopeEvidence"], [], budget);
  if (!record || !digestText(record.authorityDigest) || typeof record.kind !== "string" || !["screenshot", "input", "clipboard", "process", "executable"].includes(record.kind) || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.approvalId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !evidenceText(record.leaseId) || !evidenceText(record.attemptId) || !positiveInteger(record.approvalEpoch) || !positiveInteger(record.freshnessEpoch) || !nonNegativeInteger(record.takeoverEpoch) || !(record.foregroundEpoch === null || positiveInteger(record.foregroundEpoch)) || !positiveInteger(record.policyEpoch) || !positiveInteger(record.brokerEpoch) || !positiveInteger(record.workerEpoch) || !positiveInteger(record.readinessEpoch) || !digestText(record.readinessDigest) || !(record.foregroundDigest === null || digestText(record.foregroundDigest)) || !(record.displayDigest === null || digestText(record.displayDigest)) || !digestText(record.takeoverDigest) || !digestText(record.actionDigest) || !digestText(record.targetDigest) || !(record.geometryDigest === null || digestText(record.geometryDigest)) || !(record.dataPolicyDigest === null || digestText(record.dataPolicyDigest)) || !(record.executableDigest === null || digestText(record.executableDigest)) || !evidenceText(record.scopeEvidence)) return null;
  if ((record.foregroundEpoch === null) !== (record.foregroundDigest === null)) return null;
  const authority = decodeAuthority(record.authority, budget);
  const state = brokerState(broker);
  if (!authority || !state || !sameAuthority(authority, state.authority) || record.authorityDigest !== state.authorityDigest || record.policyEpoch !== authority.policyEpoch || record.brokerEpoch !== authority.brokerEpoch || record.workerEpoch !== authority.workerEpoch || record.readinessEpoch !== authority.readinessEpoch) return null;
  const unsigned = { authority, authorityDigest: record.authorityDigest, kind: record.kind as ComputerUseIntentKind, intentId: record.intentId, approvalId: record.approvalId, leaseId: record.leaseId, attemptId: record.attemptId, approvalEpoch: record.approvalEpoch, freshnessEpoch: record.freshnessEpoch, takeoverEpoch: record.takeoverEpoch, foregroundEpoch: record.foregroundEpoch as number | null, policyEpoch: record.policyEpoch, brokerEpoch: record.brokerEpoch, workerEpoch: record.workerEpoch, readinessEpoch: record.readinessEpoch, readinessDigest: record.readinessDigest, foregroundDigest: record.foregroundDigest as string | null, displayDigest: record.displayDigest as string | null, takeoverDigest: record.takeoverDigest, actionDigest: record.actionDigest, targetDigest: record.targetDigest, geometryDigest: record.geometryDigest as string | null, dataPolicyDigest: record.dataPolicyDigest as string | null, executableDigest: record.executableDigest as string | null };
  return constantTimeEqual(record.scopeEvidence, brokerSign(broker, "ledger-scope-v1", unsigned)) ? deepFreeze({ ...unsigned, scopeEvidence: record.scopeEvidence }) : null;
};

const decodeLedgerInput = (value: unknown, broker: ComputerUseBroker, budget: DecodeBudget, allowEnvelope = false): ActionLedgerRecordInput | null => {
  const optionalKeys = ["reason", "acknowledgementDeadlineMs", "acknowledgementId", "workerId", "workerEvidenceDigest", "effect"];
  if (allowEnvelope) optionalKeys.push("sequence", "previousEvidence", "brokerEvidence");
  const record = readDataObject(value, ["actionId", "intentId", "kind", "scope", "status", "atMs"], optionalKeys, budget);
  if (!record || !boundedString(record.actionId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.intentId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || typeof record.kind !== "string" || !["screenshot", "input", "clipboard", "process", "executable"].includes(record.kind) || typeof record.status !== "string" || !["requested", "approved", "leased", "started", "dispatched", "cancel_requested", "completed", "denied", "cancelled", "timed_out", "outcome_unknown"].includes(record.status) || !nonNegativeInteger(record.atMs) || (hasOwn(record, "reason") && !boundedString(record.reason, COMPUTER_USE_LIMITS.maxLabelBytes, budget, true)) || (hasOwn(record, "acknowledgementDeadlineMs") && !nonNegativeInteger(record.acknowledgementDeadlineMs)) || (hasOwn(record, "acknowledgementId") && !boundedString(record.acknowledgementId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) || (hasOwn(record, "workerId") && !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) || (hasOwn(record, "workerEvidenceDigest") && !digestText(record.workerEvidenceDigest))) return null;
  const scope = decodeLedgerScope(record.scope, broker, budget);
  if (!scope || scope.kind !== record.kind || scope.intentId !== record.intentId) return null;
  const effect = hasOwn(record, "effect") ? decodeWorkerEffectEvidence(record.effect, budget) : undefined;
  if (hasOwn(record, "effect") && !effect) return null;
  return deepFreeze({ actionId: record.actionId, intentId: record.intentId, kind: record.kind as ComputerUseIntentKind, scope, status: record.status as ActionLedgerStatus, atMs: record.atMs, ...(hasOwn(record, "reason") ? { reason: record.reason as string } : {}), ...(hasOwn(record, "acknowledgementDeadlineMs") ? { acknowledgementDeadlineMs: record.acknowledgementDeadlineMs as number } : {}), ...(hasOwn(record, "acknowledgementId") ? { acknowledgementId: record.acknowledgementId as string } : {}), ...(hasOwn(record, "workerId") ? { workerId: record.workerId as string } : {}), ...(hasOwn(record, "workerEvidenceDigest") ? { workerEvidenceDigest: record.workerEvidenceDigest as string } : {}), ...(effect ? { effect } : {}) });
};

const legalNextStatuses: Record<ActionLedgerStatus, readonly ActionLedgerStatus[]> = {
  requested: ["approved", "denied", "cancelled", "timed_out"],
  approved: ["leased", "denied", "cancelled", "timed_out"],
  leased: ["started", "cancelled", "timed_out"],
  started: ["dispatched", "cancelled", "timed_out"],
  dispatched: ["completed", "cancel_requested", "outcome_unknown"],
  cancel_requested: ["cancelled", "outcome_unknown"],
  completed: [], denied: [], cancelled: [], timed_out: [], outcome_unknown: [],
};

const sameLedgerScope = (left: ActionLedgerScope, right: ActionLedgerScope): boolean => stableEncode(left) === stableEncode(right);

const followsLedgerState = (previous: ActionLedgerRecord | undefined, record: ActionLedgerRecordInput, allowSpecial: boolean): boolean => {
  if ((record.status === "outcome_unknown" || record.status === "completed" || record.status === "cancelled") && !allowSpecial) return false;
  if (!previous) return record.status === "requested";
  if (previous.intentId !== record.intentId || previous.kind !== record.kind || !sameLedgerScope(previous.scope, record.scope) || record.atMs < previous.atMs || !legalNextStatuses[previous.status].includes(record.status)) return false;
  if (record.status === "cancel_requested") return record.acknowledgementDeadlineMs !== undefined && record.acknowledgementDeadlineMs > record.atMs && record.acknowledgementDeadlineMs - record.atMs <= COMPUTER_USE_LIMITS.maxTakeoverAcknowledgementMs && record.acknowledgementId === undefined && record.workerId === undefined;
  if (record.status === "cancelled" && previous.status === "cancel_requested") return Boolean(record.acknowledgementId && record.workerId === record.scope.authority.workerId && record.workerEvidenceDigest && record.effect === undefined && previous.acknowledgementDeadlineMs !== undefined && record.atMs <= previous.acknowledgementDeadlineMs);
  if (record.status === "completed") return record.workerId === record.scope.authority.workerId && Boolean(record.workerEvidenceDigest) && ((record.kind === "screenshot" || record.kind === "clipboard") ? record.effect !== undefined : record.effect === undefined) && record.acknowledgementDeadlineMs === undefined && record.acknowledgementId === undefined;
  if (record.status === "outcome_unknown") return (!record.effect || Boolean(record.workerEvidenceDigest)) && (previous.status === "dispatched" || (previous.status === "cancel_requested" && previous.acknowledgementDeadlineMs !== undefined && record.atMs >= previous.acknowledgementDeadlineMs));
  return record.acknowledgementDeadlineMs === undefined && record.acknowledgementId === undefined && record.workerId === undefined && record.workerEvidenceDigest === undefined && record.effect === undefined;
};

const ledgerGenesis = (broker: ComputerUseBroker, ledgerId: string, authorityDigestValue: string, integrity: "healthy" | "corrupt"): string => brokerSign(broker, "ledger-genesis-v1", { ledgerId, authorityDigest: authorityDigestValue, integrity });

export function createActionLedger(broker: ComputerUseBroker): ActionLedger {
  const state = brokerState(broker);
  if (!state) throw new RangeError("Broker is invalid");
  state.ledgerCounter += 1;
  if (!positiveInteger(state.ledgerCounter)) throw new RangeError("Ledger counter exhausted");
  const ledgerId = brokerSign(broker, "ledger-id-v1", { counter: state.ledgerCounter });
  const genesisEvidence = ledgerGenesis(broker, ledgerId, state.authorityDigest, "healthy");
  return trustLedger(deepFreeze({ version: COMPUTER_USE_POLICY_VERSION, integrity: "healthy", ledgerId, authorityDigest: state.authorityDigest, genesisEvidence, headEvidence: genesisEvidence, records: [] }), broker);
}

const corruptLedger = (broker: ComputerUseBroker): ActionLedger => {
  const state = brokerState(broker);
  if (!state) throw new RangeError("Broker is invalid");
  state.ledgerCounter += 1;
  const ledgerId = brokerSign(broker, "ledger-corrupt-id-v1", { counter: state.ledgerCounter });
  const genesisEvidence = ledgerGenesis(broker, ledgerId, state.authorityDigest, "corrupt");
  return trustLedger(deepFreeze({ version: COMPUTER_USE_POLICY_VERSION, integrity: "corrupt", ledgerId, authorityDigest: state.authorityDigest, genesisEvidence, headEvidence: genesisEvidence, records: [] }), broker);
};

const recordEvidenceSnapshot = (ledgerId: string, sequence: number, previousEvidence: string, record: ActionLedgerRecordInput): unknown => ({ ledgerId, sequence, previousEvidence, record });

const decodeLedger = (value: unknown, broker: ComputerUseBroker): ActionLedger | null => {
  try {
    if (typeof value === "object" && value !== null) {
      const owner = trustedLedgerOwners.get(value);
      if (owner) return owner === broker ? value as ActionLedger : null;
    }
    const parsed = parseBoundedJsonTransport(value);
    if (parsed === null) return null;
    const budget = newBudget();
    const record = readDataObject(parsed, ["version", "integrity", "ledgerId", "authorityDigest", "genesisEvidence", "headEvidence", "records"], [], budget);
    if (!record || record.version !== COMPUTER_USE_POLICY_VERSION || (record.integrity !== "healthy" && record.integrity !== "corrupt") || !evidenceText(record.ledgerId) || !digestText(record.authorityDigest) || !evidenceText(record.genesisEvidence) || !evidenceText(record.headEvidence)) return null;
    const state = brokerState(broker);
    if (!state || record.authorityDigest !== state.authorityDigest || !constantTimeEqual(record.genesisEvidence, ledgerGenesis(broker, record.ledgerId, record.authorityDigest, record.integrity))) return null;
    const recordValues = readDataArray(record.records, COMPUTER_USE_LIMITS.maxLedgerRecords, budget);
    if (!recordValues) return null;
    if (record.integrity === "corrupt") return recordValues.length === 0 && record.headEvidence === record.genesisEvidence ? trustLedger(deepFreeze({ version: COMPUTER_USE_POLICY_VERSION, integrity: "corrupt", ledgerId: record.ledgerId, authorityDigest: record.authorityDigest, genesisEvidence: record.genesisEvidence, headEvidence: record.headEvidence, records: [] }), broker) : null;
    const decoded: ActionLedgerRecord[] = [];
    const latest = new Map<string, ActionLedgerRecord>();
    let previousEvidence = record.genesisEvidence;
    for (let sequence = 0; sequence < recordValues.length; sequence += 1) {
      const itemRecord = readDataObject(recordValues[sequence], ["sequence", "actionId", "intentId", "kind", "scope", "status", "atMs", "previousEvidence", "brokerEvidence"], ["reason", "acknowledgementDeadlineMs", "acknowledgementId", "workerId", "workerEvidenceDigest", "effect"], budget);
      if (!itemRecord || itemRecord.sequence !== sequence || itemRecord.previousEvidence !== previousEvidence || !evidenceText(itemRecord.brokerEvidence)) return null;
      const input = decodeLedgerInput(itemRecord, broker, budget, true);
      if (!input || !followsLedgerState(latest.get(input.actionId), input, true)) return null;
      const expected = brokerSign(broker, "ledger-record-v1", recordEvidenceSnapshot(record.ledgerId, sequence, previousEvidence, input));
      if (!constantTimeEqual(itemRecord.brokerEvidence, expected)) return null;
      const decodedRecord = deepFreeze({ ...input, sequence, previousEvidence, brokerEvidence: itemRecord.brokerEvidence });
      decoded.push(decodedRecord);
      latest.set(input.actionId, decodedRecord);
      previousEvidence = itemRecord.brokerEvidence;
    }
    if (record.headEvidence !== previousEvidence) return null;
    return trustLedger(deepFreeze({ version: COMPUTER_USE_POLICY_VERSION, integrity: "healthy", ledgerId: record.ledgerId, authorityDigest: record.authorityDigest, genesisEvidence: record.genesisEvidence, headEvidence: record.headEvidence, records: decoded }), broker);
  } catch {
    return null;
  }
};

const latestLedgerRecord = (ledger: ActionLedger, actionId: string): ActionLedgerRecord | undefined => {
  for (let index = ledger.records.length - 1; index >= 0; index -= 1) if (ledger.records[index].actionId === actionId) return ledger.records[index];
  return undefined;
};

const appendLedgerRecord = (ledger: ActionLedger, inputValue: ActionLedgerRecordInput, broker: ComputerUseBroker, allowSpecial: boolean): ActionLedger => {
  if (ledger.integrity === "corrupt" || ledger.records.length >= COMPUTER_USE_LIMITS.maxLedgerRecords) return ledger;
  const input = decodeLedgerInput(inputValue, broker, newBudget());
  if (!input || !followsLedgerState(latestLedgerRecord(ledger, input.actionId), input, allowSpecial)) return ledger;
  const sequence = ledger.records.length;
  const previousEvidence = ledger.headEvidence;
  const brokerEvidence = brokerSign(broker, "ledger-record-v1", recordEvidenceSnapshot(ledger.ledgerId, sequence, previousEvidence, input));
  const nextRecord = deepFreeze({ ...input, sequence, previousEvidence, brokerEvidence });
  return trustLedger(deepFreeze({ ...ledger, headEvidence: brokerEvidence, records: [...ledger.records, nextRecord] }), broker);
};

export function appendActionLedgerRecord(ledgerValue: unknown, inputTransport: unknown, broker: ComputerUseBroker): ActionLedger {
  const ledger = decodeLedger(ledgerValue, broker);
  if (!ledger) return corruptLedger(broker);
  try {
    const parsed = parseBoundedJsonTransport(inputTransport);
    return parsed === null ? ledger : appendLedgerRecord(ledger, parsed as ActionLedgerRecordInput, broker, false);
  } catch {
    return ledger;
  }
}

export function markOutcomeUnknown(ledgerValue: ActionLedger, actionId: string, atMs: number, broker: ComputerUseBroker): ActionLedger {
  const ledger = decodeLedger(ledgerValue, broker);
  if (!ledger) return corruptLedger(broker);
  if (ledger.integrity === "corrupt" || typeof actionId !== "string" || actionId.length === 0 || !nonNegativeInteger(atMs)) return ledger;
  const previous = latestLedgerRecord(ledger, actionId);
  if (!previous || (previous.status !== "dispatched" && previous.status !== "cancel_requested")) return ledger;
  return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "outcome_unknown", atMs, reason: "dispatched effect lacks a bounded worker acknowledgement" }, broker, true);
}

export function requestActionCancellation(ledgerValue: ActionLedger, actionId: string, atMs: number, acknowledgementDeadlineMs: number, broker: ComputerUseBroker): ActionLedger {
  const ledger = decodeLedger(ledgerValue, broker);
  if (!ledger) return corruptLedger(broker);
  if (ledger.integrity === "corrupt") return ledger;
  const previous = latestLedgerRecord(ledger, actionId);
  if (!previous || previous.status !== "dispatched") return ledger;
  return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "cancel_requested", atMs, acknowledgementDeadlineMs, reason: "cancellation requested after dispatch" }, broker, false);
}

const decodeWorkerEffectEvidence = (value: unknown, budget: DecodeBudget): WorkerEffectEvidence | null => {
  const record = readDataObject(value, ["actualRect", "bytes", "category", "redactorId", "persistence", "artifactSha256"], [], budget);
  if (!record || !nonNegativeInteger(record.bytes) || typeof record.category !== "string" || !DATA_CATEGORIES.includes(record.category as DataCategory) || !(record.redactorId === null || boundedString(record.redactorId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget)) || (record.persistence !== "none" && record.persistence !== "ephemeral" && record.persistence !== "durable") || !sha256Hex(record.artifactSha256)) return null;
  const actualRect = record.actualRect === null ? null : decodeRect(record.actualRect, budget);
  if (record.actualRect !== null && !actualRect) return null;
  return deepFreeze({ actualRect, bytes: record.bytes, category: record.category as DataCategory, redactorId: record.redactorId as string | null, persistence: record.persistence, artifactSha256: record.artifactSha256.toLowerCase() });
};

const decodeWorkerOutcomeEvidence = (transport: unknown, broker: ComputerUseBroker): WorkerOutcomeEvidence | null => {
  const parsed = parseBoundedJsonTransport(transport);
  if (parsed === null) return null;
  const budget = newBudget();
  const outcome = readDiscriminant(parsed, "outcome", budget);
  if (outcome === "completed") {
    const record = readDataObject(parsed, ["outcome", "actionId", "leaseId", "attemptId", "workerId", "atMs", "brokerEvidence"], ["effect"], budget);
    if (!record || !boundedString(record.actionId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !evidenceText(record.leaseId) || !evidenceText(record.attemptId) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !evidenceText(record.brokerEvidence)) return null;
    const effect = hasOwn(record, "effect") ? decodeWorkerEffectEvidence(record.effect, budget) : undefined;
    if (hasOwn(record, "effect") && !effect) return null;
    const options: WorkerOutcomeEvidenceOptions = { outcome, actionId: record.actionId, leaseId: record.leaseId, attemptId: record.attemptId, workerId: record.workerId, atMs: record.atMs, ...(effect ? { effect } : {}) };
    return constantTimeEqual(record.brokerEvidence, brokerSign(broker, "worker-outcome-v1", options)) ? deepFreeze({ ...options, brokerEvidence: record.brokerEvidence }) : null;
  }
  if (outcome === "cancelled") {
    const record = readDataObject(parsed, ["outcome", "actionId", "leaseId", "attemptId", "workerId", "acknowledgementId", "atMs", "brokerEvidence"], [], budget);
    if (!record || !boundedString(record.actionId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !evidenceText(record.leaseId) || !evidenceText(record.attemptId) || !boundedString(record.workerId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !boundedString(record.acknowledgementId, COMPUTER_USE_LIMITS.maxIdentifierBytes, budget) || !nonNegativeInteger(record.atMs) || !evidenceText(record.brokerEvidence)) return null;
    const options: WorkerOutcomeEvidenceOptions = { outcome, actionId: record.actionId, leaseId: record.leaseId, attemptId: record.attemptId, workerId: record.workerId, acknowledgementId: record.acknowledgementId, atMs: record.atMs };
    return constantTimeEqual(record.brokerEvidence, brokerSign(broker, "worker-outcome-v1", options)) ? deepFreeze({ ...options, brokerEvidence: record.brokerEvidence }) : null;
  }
  return null;
};

const workerEffectMatchesLease = (evidence: Extract<WorkerOutcomeEvidence, { readonly outcome: "completed" }>, lease: InternalLease): boolean => {
  if (lease.kind !== "screenshot" && lease.kind !== "clipboard") return evidence.effect === undefined;
  const policy = lease.dataPolicy;
  const effect = evidence.effect;
  if (!policy || !effect || effect.bytes > policy.maxBytes || effect.category !== policy.category || SENSITIVE_CATEGORIES.has(effect.category) || policy.redaction !== "required" || effect.redactorId !== policy.redactorId || effect.persistence !== policy.persistence || effect.persistence === "durable") return false;
  if (lease.kind === "screenshot") return lease.captureRect !== null && effect.actualRect !== null && stableEncode(effect.actualRect) === stableEncode(lease.captureRect);
  return effect.actualRect === null;
};

export function recordWorkerOutcome(ledgerValue: ActionLedger, actionId: string, evidenceTransport: unknown, broker: ComputerUseBroker): ActionLedger {
  const ledger = decodeLedger(ledgerValue, broker);
  if (!ledger) return corruptLedger(broker);
  if (ledger.integrity === "corrupt") return ledger;
  const state = brokerState(broker);
  const evidence = decodeWorkerOutcomeEvidence(evidenceTransport, broker);
  const previous = latestLedgerRecord(ledger, actionId);
  if (!state || !evidence || !previous || evidence.actionId !== actionId || evidence.workerId !== state.authority.workerId || evidence.atMs !== state.trustedNowMs || evidence.leaseId !== previous.scope.leaseId || evidence.attemptId !== previous.scope.attemptId) return ledger;
  const lease = state.leases.get(evidence.leaseId);
  if (!lease || lease.attemptId !== evidence.attemptId || lease.state !== "started") return ledger;
  const workerEvidenceDigest = digestValue(evidence);
  if (evidence.outcome === "completed") {
    if (previous.status !== "dispatched") return ledger;
    lease.state = "finished";
    if (!workerEffectMatchesLease(evidence, lease)) return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "outcome_unknown", atMs: evidence.atMs, workerEvidenceDigest, ...(evidence.effect ? { effect: evidence.effect } : {}), reason: "authenticated worker result violated the approved data or geometry scope" }, broker, true);
    return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "completed", atMs: evidence.atMs, workerId: evidence.workerId, workerEvidenceDigest, ...(evidence.effect ? { effect: evidence.effect } : {}), reason: "broker authenticated the exact worker result" }, broker, true);
  }
  if (previous.status !== "cancel_requested" || previous.acknowledgementDeadlineMs === undefined) return ledger;
  lease.state = "finished";
  if (evidence.atMs > previous.acknowledgementDeadlineMs) return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "outcome_unknown", atMs: evidence.atMs, workerEvidenceDigest, reason: "authenticated cancellation acknowledgement missed its deadline" }, broker, true);
  return appendLedgerRecord(ledger, { actionId, intentId: previous.intentId, kind: previous.kind, scope: previous.scope, status: "cancelled", atMs: evidence.atMs, acknowledgementId: evidence.acknowledgementId, workerId: evidence.workerId, workerEvidenceDigest, reason: "broker authenticated the exact cancellation acknowledgement" }, broker, true);
}

export function acknowledgeActionCancellation(ledgerValue: ActionLedger, actionId: string, evidenceTransport: unknown, broker: ComputerUseBroker): ActionLedger {
  return recordWorkerOutcome(ledgerValue, actionId, evidenceTransport, broker);
}

const terminalStatuses: readonly TerminalActionOutcome[] = ["completed", "denied", "cancelled", "timed_out", "outcome_unknown"];

export function getActionOutcome(ledgerValue: ActionLedger, actionId: string, broker: ComputerUseBroker): TerminalActionOutcome | null {
  const ledger = decodeLedger(ledgerValue, broker);
  if (!ledger || ledger.integrity === "corrupt") return "ledger_corrupt";
  const latest = latestLedgerRecord(ledger, actionId);
  return latest && terminalStatuses.includes(latest.status as TerminalActionOutcome) ? latest.status as TerminalActionOutcome : null;
}
