export const ARTIFACT_TRANSFER_SCHEMA = "prime.artifact-transfer/v1" as const;
export const ARTIFACT_EXPORT_SCHEMA = "prime.artifact-export/v1" as const;
export const CLOSURE_MANIFEST_SCHEMA = "prime.artifact-closure/v1" as const;

const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1_024;
const MAX_SCHEMA_LENGTH = 128;
const MAX_MEDIA_TYPE_LENGTH = 128;
const MAX_REFERENCE_COUNT = 4_096;
const MAX_EXPORT_ITEMS = 4_096;
const MAX_RUNTIME_BYTE_ARRAY = 64 * 1024 * 1024;
const MAX_SERIALIZED_EXPORT_LENGTH = 128 * 1024 * 1024;
const LIFECYCLE_AUTHORIZATION_WINDOW_MS = 5 * 60 * 1_000;

export type ArtifactErrorCode =
  | "unsafe-input"
  | "unsafe-number"
  | "invalid-id"
  | "invalid-broker-id"
  | "invalid-path"
  | "invalid-digest"
  | "invalid-media-type"
  | "invalid-schema"
  | "invalid-provenance"
  | "invalid-source-revision"
  | "provenance-mismatch"
  | "length-mismatch"
  | "hash-mismatch"
  | "duplicate-id"
  | "identity-conflict"
  | "missing-blob"
  | "corrupt-blob"
  | "reference-mismatch"
  | "invalid-closure"
  | "closure-mismatch"
  | "cycle"
  | "transfer-not-found"
  | "transfer-state"
  | "ack-before-reference"
  | "invalid-lifecycle";

export class ArtifactDomainError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactDomainError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: ArtifactErrorCode, message: string): never {
  throw new ArtifactDomainError(code, message);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requireSafeNonNegativeInteger(value: unknown, label: string): number {
  if (!isSafeInteger(value) || value < 0) {
    fail("unsafe-number", `${label} must be a safe non-negative integer`);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("unsafe-input", `${label} must be a bounded non-empty string`);
  }
  if (/[^\u0020-\u007e]/u.test(value)) {
    fail("unsafe-input", `${label} contains a control or non-ASCII character`);
  }
  return value;
}

function requireBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("unsafe-input", `${label} must be a bounded non-empty string`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      fail("unsafe-input", `${label} contains an unsafe control character`);
    }
  }
  return value;
}

function validateStableId(value: unknown, label: string): string {
  const id = requireBoundedString(value, label, MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(id) || /[\\/]/u.test(id) || /^[A-Za-z]:/u.test(id)) {
    fail("invalid-id", `${label} is not a stable opaque identity`);
  }
  return id;
}

function validateBrokerId(value: unknown): string {
  const id = requireBoundedString(value, "transferId", MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id) || id === "." || id === "..") {
    fail("invalid-broker-id", "transferId must be an opaque broker-issued identifier");
  }
  return id;
}

function validateDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail("invalid-digest", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validateMediaType(value: unknown): string {
  const mediaType = requireBoundedString(value, "mediaType", MAX_MEDIA_TYPE_LENGTH);
  if (
    mediaType !== mediaType.toLowerCase() ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(mediaType)
  ) {
    fail("invalid-media-type", "mediaType must be a canonical lowercase MIME type");
  }
  return mediaType;
}

function validateSchema(value: unknown): string {
  const schema = requireBoundedString(value, "schema", MAX_SCHEMA_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(schema) || schema.includes("..")) {
    fail("invalid-schema", "schema must be a bounded schema identity");
  }
  return schema;
}

function validatePresentationPath(value: unknown): string {
  const path = requireBoundedText(value, "presentationPath", MAX_PATH_LENGTH);
  if (
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.includes(":") ||
    path.endsWith("/") ||
    path.includes("//")
  ) {
    fail("invalid-path", "presentationPath must be canonical and relative");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("invalid-path", "presentationPath contains an unsafe path segment");
  }
  for (const segment of segments) {
    if (/[. ]$/u.test(segment)) {
      fail("invalid-path", "presentationPath contains a trailing-dot-or-space segment");
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/iu.test(segment)) {
      fail("invalid-path", "presentationPath contains a reserved Windows segment");
    }
  }
  return path;
}

export function canonicalRelativePresentationPath(value: string): string {
  return validatePresentationPath(value);
}

export function opaqueBrokerId(value: string): string {
  return validateBrokerId(value);
}

export interface BlobDescriptor {
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly schema: string;
}

export interface BlobReference extends BlobDescriptor {
  readonly blobId: string;
}

export interface ArtifactSourceRevision {
  readonly buildFingerprint: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly cursor: number;
  readonly entryId: string;
  readonly prefixSha256: string;
}

export interface ArtifactTransferBinding {
  readonly artifactId: string;
  readonly projectId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly sourceRevision: ArtifactSourceRevision;
}

export interface ArtifactVersionDraft extends ArtifactTransferBinding {
  readonly versionId: string;
  readonly presentationPath: string;
  readonly root: BlobReference;
}

export interface ArtifactVersion extends ArtifactVersionDraft {
  readonly lifecycle: "durable";
}

export interface BlobManifestEntry extends BlobReference {
  readonly references: readonly BlobReference[];
}

export interface ClosureManifest {
  readonly schema: typeof CLOSURE_MANIFEST_SCHEMA;
  readonly rootArtifactVersionIds: readonly string[];
  readonly artifacts: readonly ArtifactVersion[];
  readonly blobs: readonly BlobManifestEntry[];
  readonly totalBytes: number;
  readonly manifestSha256: string;
}

export interface ExportBlob {
  blobId: string;
  bytes: Uint8Array;
}

export interface ArtifactExport {
  schema: typeof ARTIFACT_EXPORT_SCHEMA;
  manifest: ClosureManifest;
  objects: ExportBlob[];
}

export type TransferLifecycle =
  | "spooled"
  | "verified"
  | "promoted"
  | "referenced"
  | "acked"
  | "aborted";

export type BrokerTransferPhase =
  | "inbound-authorized"
  | "artifact-commit-authorized"
  | "ack-authorized"
  | "revoked";

export interface BrokerTransferRegistration {
  readonly transferId: string;
  readonly blobId: string;
  readonly descriptor: BlobDescriptor;
  readonly references: readonly BlobReference[];
  readonly binding: ArtifactTransferBinding;
  readonly expiresAtMs: number;
}

export interface BrokerTransferSnapshot extends BrokerTransferRegistration {
  readonly phase: BrokerTransferPhase;
  readonly ackArtifactVersionId?: string;
}

export interface ArtifactTransfer extends BrokerTransferRegistration {
  readonly lifecycle: TransferLifecycle;
  readonly artifactVersionId?: string;
}

export interface BlobSnapshot {
  readonly blobId: string;
  readonly descriptor: BlobDescriptor;
  readonly references: readonly BlobReference[];
  readonly bytes: Uint8Array;
}

export interface ArtifactDeletionRequest extends ArtifactTransferBinding {
  readonly versionId: string;
}

declare const artifactBrokerHandleBrand: unique symbol;

/**
 * Opaque in-process handle supplied by the trusted broker integration. Registration rejects
 * accidental structural look-alikes, but it is not an OS authentication boundary: production
 * evidence must originate in package-private native-bridge code before this domain receives it.
 */
export interface ArtifactBrokerHandle {
  readonly [artifactBrokerHandleBrand]: "artifact-broker-handle";
}

/** Test-only facade; production builds expose no broker minting path. */
export interface ArtifactBrokerTestHarness extends ArtifactBrokerHandle {
  createStore(): ArtifactStore;
  nowMs(): number;
  advanceTimeTo(nowMs: number): void;
  registerTransfer(input: BrokerTransferRegistration): BrokerTransferSnapshot;
  getTransfer(transferId: string): BrokerTransferSnapshot | null;
  authorizeArtifactCommit(transferId: string): BrokerTransferSnapshot;
  authorizeTransferAck(transferId: string, artifactVersionId: string): BrokerTransferSnapshot;
  revokeTransfer(transferId: string): BrokerTransferSnapshot;
  authorizeArtifactDeletion(input: ArtifactDeletionRequest): ArtifactLifecycleAuthorization;
  authorizeClosurePin(manifestSha256: string, retentionExpiresAtMs: number): ArtifactLifecycleAuthorization;
  authorizeClosureUnpin(manifestSha256: string): ArtifactLifecycleAuthorization;
  authorizeClosureImport(manifest: ClosureManifest): ArtifactLifecycleAuthorization;
}

export interface ArtifactDomainTestHarness {
  createBroker(initialNowMs?: number): ArtifactBrokerTestHarness;
}

declare const lifecycleAuthorizationBrand: unique symbol;

/** A one-time, broker-minted capability. It cannot be fabricated as a valid command. */
export interface ArtifactLifecycleAuthorization {
  readonly [lifecycleAuthorizationBrand]: "artifact-lifecycle-authorization";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  let ownKeys: string[];
  try {
    ownKeys = Object.keys(value);
  } catch {
    fail("unsafe-input", "object keys could not be inspected safely");
  }
  const expected = new Set(keys);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) {
    fail("unsafe-input", "object contains unknown or missing fields");
  }
}

function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    fail("unsafe-input", `field ${key} is not a data property`);
  }
  return descriptor.value;
}

function inspectBoundedOrdinaryArray(
  value: unknown,
  label: string,
  maximumLength: number,
  minimumLength = 0,
  errorCode: ArtifactErrorCode = "unsafe-input",
): { readonly array: readonly unknown[]; readonly length: number } {
  if (!Array.isArray(value)) fail(errorCode, `${label} must be an array`);
  let length: unknown;
  let prototype: unknown;
  try {
    length = value.length;
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(errorCode, `${label} could not be inspected safely`);
  }
  if (
    prototype !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    (length as number) < minimumLength ||
    (length as number) > maximumLength
  ) {
    fail(errorCode, `${label} is not a bounded ordinary dense array`);
  }
  return { array: value, length: length as number };
}

function denseDataItem(
  array: readonly unknown[],
  index: number,
  label: string,
  errorCode: ArtifactErrorCode,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  } catch {
    fail(errorCode, `${label} contains an unreadable item`);
  }
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    fail(errorCode, `${label} must contain only dense data items`);
  }
  return descriptor.value;
}

function snapshotDenseArray(
  value: unknown,
  label: string,
  maximumLength: number,
  minimumLength = 0,
  errorCode: ArtifactErrorCode = "unsafe-input",
): readonly unknown[] {
  const { array, length } = inspectBoundedOrdinaryArray(
    value,
    label,
    maximumLength,
    minimumLength,
    errorCode,
  );
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    snapshot[index] = denseDataItem(array, index, label, errorCode);
  }
  return snapshot;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function intrinsicUint8ArrayByteLength(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (
      !TYPED_ARRAY_TAG_GETTER ||
      !TYPED_ARRAY_BYTE_LENGTH_GETTER ||
      TYPED_ARRAY_TAG_GETTER.call(value) !== "Uint8Array"
    ) {
      return null;
    }
    const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    return isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : null;
  } catch {
    return null;
  }
}

function cloneBytes(value: Uint8Array): Uint8Array {
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === null) fail("unsafe-input", "blob bytes must be a Uint8Array");
  const snapshot = new Uint8Array(byteLength);
  UINT8_ARRAY_SET.call(snapshot, value);
  return snapshot;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return intrinsicUint8ArrayByteLength(value) !== null;
}

function validateBytes(value: unknown): Uint8Array {
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === null) {
    fail("unsafe-input", "blob bytes must be a Uint8Array");
  }
  if (byteLength > MAX_RUNTIME_BYTE_ARRAY) {
    fail("unsafe-input", "blob bytes exceed the runtime byte limit");
  }
  const snapshot = new Uint8Array(byteLength);
  UINT8_ARRAY_SET.call(snapshot, value as Uint8Array);
  return snapshot;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function descriptorEqual(left: BlobDescriptor, right: BlobDescriptor): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.schema === right.schema
  );
}

function referenceEqual(left: BlobReference, right: BlobReference): boolean {
  return left.blobId === right.blobId && descriptorEqual(left, right);
}

function referencesEqual(left: readonly BlobReference[], right: readonly BlobReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => referenceEqual(reference, right[index]));
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Canonical ordering is raw UTF-8 byte order, never host locale collation. */
function compareUtf8Ordinal(left: string, right: string): number {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (leftBytes[index] < rightBytes[index]) return -1;
    if (leftBytes[index] > rightBytes[index]) return 1;
  }
  if (leftBytes.length < rightBytes.length) return -1;
  if (leftBytes.length > rightBytes.length) return 1;
  return 0;
}

const SHA_256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/**
 * Closed SHA-256 implementation. No caller-provided callback can attest bytes or alter
 * manifest hashing; all integrity checks route through this reviewed implementation.
 */
function trustedSha256(input: ArrayLike<number>): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  const compressBlock = (block: ArrayLike<number>, offset: number): void => {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = (
        (block[wordOffset] << 24) |
        (block[wordOffset + 1] << 16) |
        (block[wordOffset + 2] << 8) |
        block[wordOffset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choose + SHA_256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  };

  const fullBlockLength = input.length - (input.length % 64);
  for (let offset = 0; offset < fullBlockLength; offset += 64) {
    compressBlock(input, offset);
  }

  const remainderLength = input.length - fullBlockLength;
  const tail = new Uint8Array(remainderLength < 56 ? 64 : 128);
  for (let index = 0; index < remainderLength; index += 1) {
    tail[index] = input[fullBlockLength + index];
  }
  tail[remainderLength] = 0x80;
  const bitLength = input.length * 8;
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  const lengthOffset = tail.length - 8;
  tail[lengthOffset] = (highBits >>> 24) & 0xff;
  tail[lengthOffset + 1] = (highBits >>> 16) & 0xff;
  tail[lengthOffset + 2] = (highBits >>> 8) & 0xff;
  tail[lengthOffset + 3] = highBits & 0xff;
  tail[lengthOffset + 4] = (lowBits >>> 24) & 0xff;
  tail[lengthOffset + 5] = (lowBits >>> 16) & 0xff;
  tail[lengthOffset + 6] = (lowBits >>> 8) & 0xff;
  tail[lengthOffset + 7] = lowBits & 0xff;
  for (let offset = 0; offset < tail.length; offset += 64) {
    compressBlock(tail, offset);
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

function verifyBytesAgainstDescriptor(bytes: ArrayLike<number>, descriptor: BlobDescriptor): void {
  if (bytes.length !== descriptor.byteLength) {
    fail("length-mismatch", "bytes do not match the declared byte length");
  }
  if (trustedSha256(bytes) !== descriptor.sha256) {
    fail("hash-mismatch", "bytes do not match the declared SHA-256 digest");
  }
}

export function createBlobDescriptor(input: BlobDescriptor): BlobDescriptor {
  const byteLength = requireSafeNonNegativeInteger(input?.byteLength, "byteLength");
  const sha256 = validateDigest(input?.sha256, "sha256");
  const mediaType = validateMediaType(input?.mediaType);
  const schema = validateSchema(input?.schema);
  return Object.freeze({ byteLength, sha256, mediaType, schema });
}

export function createBlobReference(input: BlobReference): BlobReference {
  const blobId = validateStableId(input?.blobId, "blobId");
  const normalized = createBlobDescriptor(input);
  return Object.freeze({ blobId, ...normalized });
}

function createReferences(input: readonly BlobReference[]): readonly BlobReference[] {
  const snapshot = snapshotDenseArray(input, "blob references", MAX_REFERENCE_COUNT);
  const references = snapshot.map((reference) => createBlobReference(reference as BlobReference));
  references.sort((left, right) => compareUtf8Ordinal(left.blobId, right.blobId));
  for (let index = 1; index < references.length; index += 1) {
    if (references[index - 1].blobId === references[index].blobId) {
      fail("duplicate-id", "a blob cannot contain duplicate reference identities");
    }
  }
  return freezeArray(references);
}

export function createSourceRevision(input: ArtifactSourceRevision): ArtifactSourceRevision {
  if (!isPlainRecord(input)) fail("invalid-source-revision", "sourceRevision must be a plain record");
  const buildFingerprint = validateStableId(input.buildFingerprint, "buildFingerprint");
  const profileId = validateStableId(input.profileId, "profileId");
  const sessionId = validateStableId(input.sessionId, "sourceRevision.sessionId");
  const generation = requireSafeNonNegativeInteger(input.generation, "generation");
  const cursor = requireSafeNonNegativeInteger(input.cursor, "cursor");
  const entryId = validateStableId(input.entryId, "entryId");
  const prefixSha256 = validateDigest(input.prefixSha256, "prefixSha256");
  return Object.freeze({ buildFingerprint, profileId, sessionId, generation, cursor, entryId, prefixSha256 });
}

function sourceRevisionEqual(left: ArtifactSourceRevision, right: ArtifactSourceRevision): boolean {
  return (
    left.buildFingerprint === right.buildFingerprint &&
    left.profileId === right.profileId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.cursor === right.cursor &&
    left.entryId === right.entryId &&
    left.prefixSha256 === right.prefixSha256
  );
}

function normalizeArtifactBinding(input: ArtifactTransferBinding): ArtifactTransferBinding {
  if (!isPlainRecord(input)) fail("invalid-provenance", "artifact transfer binding must be a plain record");
  exactKeys(input, ["artifactId", "projectId", "chatId", "sessionId", "agentId", "sourceRevision"]);
  const artifactId = validateStableId(input.artifactId, "artifactId");
  const projectId = validateStableId(input.projectId, "projectId");
  const chatId = validateStableId(input.chatId, "chatId");
  const sessionId = validateStableId(input.sessionId, "sessionId");
  const agentId = validateStableId(input.agentId, "agentId");
  const sourceRevision = createSourceRevision(input.sourceRevision);
  if (sourceRevision.sessionId !== sessionId) {
    fail("provenance-mismatch", "sourceRevision.sessionId must match artifact sessionId");
  }
  return Object.freeze({ artifactId, projectId, chatId, sessionId, agentId, sourceRevision });
}

function artifactBindingEqual(left: ArtifactTransferBinding, right: ArtifactTransferBinding): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.projectId === right.projectId &&
    left.chatId === right.chatId &&
    left.sessionId === right.sessionId &&
    left.agentId === right.agentId &&
    sourceRevisionEqual(left.sourceRevision, right.sourceRevision)
  );
}

function normalizeArtifactDraft(input: ArtifactVersionDraft): ArtifactVersionDraft {
  if (!isPlainRecord(input)) fail("unsafe-input", "artifact version must be a plain record");
  exactKeys(input, [
    "versionId",
    "artifactId",
    "projectId",
    "chatId",
    "sessionId",
    "agentId",
    "presentationPath",
    "sourceRevision",
    "root",
  ]);
  const versionId = validateStableId(input.versionId, "versionId");
  const binding = normalizeArtifactBinding({
    artifactId: input.artifactId,
    projectId: input.projectId,
    chatId: input.chatId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    sourceRevision: input.sourceRevision,
  });
  const presentationPath = validatePresentationPath(input.presentationPath);
  const root = createBlobReference(input.root);
  return Object.freeze({ versionId, ...binding, presentationPath, root });
}

export function createArtifactVersion(input: ArtifactVersionDraft): ArtifactVersion {
  return Object.freeze({ ...normalizeArtifactDraft(input), lifecycle: "durable" as const });
}

function normalizeBrokerTransferRegistration(input: BrokerTransferRegistration): BrokerTransferRegistration {
  if (!isPlainRecord(input)) fail("unsafe-input", "broker transfer must be a plain record");
  exactKeys(input, ["transferId", "blobId", "descriptor", "references", "binding", "expiresAtMs"]);
  const transferId = validateBrokerId(input.transferId);
  const blobId = validateStableId(input.blobId, "blobId");
  const descriptor = createBlobDescriptor(input.descriptor);
  const references = createReferences(input.references);
  const binding = normalizeArtifactBinding(input.binding);
  const expiresAtMs = requireSafeNonNegativeInteger(input.expiresAtMs, "expiresAtMs");
  return Object.freeze({ transferId, blobId, descriptor, references, binding, expiresAtMs });
}

interface StoredBlob {
  readonly blobId: string;
  readonly descriptor: BlobDescriptor;
  readonly references: readonly BlobReference[];
  readonly binding: ArtifactTransferBinding;
  readonly bytes: Uint8Array;
}

interface TransferRecord extends BrokerTransferRegistration {
  lifecycle: TransferLifecycle;
  bytes?: Uint8Array;
  artifactVersionId?: string;
}

interface BrokerTransferRecord extends BrokerTransferRegistration {
  phase: BrokerTransferPhase;
  ackArtifactVersionId?: string;
}

interface RetainedClosure {
  readonly manifest: ClosureManifest;
  readonly expiresAtMs: number;
}

type LifecycleAuthorizationRecord =
  | {
      readonly kind: "delete-artifact";
      readonly expiresAtMs: number;
      readonly request: ArtifactDeletionRequest;
    }
  | {
      readonly kind: "pin-closure";
      readonly expiresAtMs: number;
      readonly manifestSha256: string;
      readonly retentionExpiresAtMs: number;
    }
  | {
      readonly kind: "unpin-closure";
      readonly expiresAtMs: number;
      readonly manifestSha256: string;
    }
  | {
      readonly kind: "import-closure";
      readonly expiresAtMs: number;
      readonly manifestSha256: string;
      readonly bindings: readonly ArtifactImportBinding[];
    };

type LifecycleAuthorizationInput =
  | {
      readonly kind: "delete-artifact";
      readonly request: ArtifactDeletionRequest;
    }
  | {
      readonly kind: "pin-closure";
      readonly manifestSha256: string;
      readonly retentionExpiresAtMs: number;
    }
  | {
      readonly kind: "unpin-closure";
      readonly manifestSha256: string;
    }
  | {
      readonly kind: "import-closure";
      readonly manifestSha256: string;
      readonly bindings: readonly ArtifactImportBinding[];
    };

interface ArtifactImportBinding extends ArtifactTransferBinding {
  readonly versionId: string;
}

interface BrokerAuthorityState {
  nowMs: number;
  readonly transfers: Map<string, BrokerTransferRecord>;
  readonly lifecycleAuthorizations: Map<object, LifecycleAuthorizationRecord>;
}

const brokerAuthorityStates = new WeakMap<ArtifactBrokerAuthority, BrokerAuthorityState>();
const brokerHandleAuthorities = new WeakMap<object, ArtifactBrokerAuthority>();

function requireBrokerAuthority(value: unknown): ArtifactBrokerAuthority {
  if (!(value instanceof ArtifactBrokerAuthority) || !brokerAuthorityStates.has(value)) {
    fail("unsafe-input", "artifact storage requires a trusted broker authority");
  }
  return value;
}

function requireBrokerHandle(value: unknown): ArtifactBrokerAuthority {
  if (typeof value !== "object" || value === null) {
    fail("unsafe-input", "artifact storage requires a trusted broker handle");
  }
  const authority = brokerHandleAuthorities.get(value);
  if (!authority) fail("unsafe-input", "artifact broker handle is not recognized");
  return authority;
}

function brokerState(authority: ArtifactBrokerAuthority): BrokerAuthorityState {
  const state = brokerAuthorityStates.get(authority);
  if (!state) fail("unsafe-input", "artifact broker authority is not recognized");
  return state;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    fail("unsafe-number", `${label} overflows a safe integer`);
  }
  return result;
}

function brokerTransferSnapshot(record: BrokerTransferRecord): BrokerTransferSnapshot {
  return Object.freeze({
    transferId: record.transferId,
    blobId: record.blobId,
    descriptor: record.descriptor,
    references: record.references,
    binding: record.binding,
    expiresAtMs: record.expiresAtMs,
    phase: record.phase,
    ...(record.ackArtifactVersionId ? { ackArtifactVersionId: record.ackArtifactVersionId } : {}),
  });
}

function activeBrokerTransfer(authority: ArtifactBrokerAuthority, transferId: string): BrokerTransferRecord {
  const state = brokerState(authority);
  pruneExpiredBrokerTransfers(state);
  const id = validateBrokerId(transferId);
  const record = state.transfers.get(id);
  if (!record) fail("transfer-not-found", `broker transfer ${id} was not registered`);
  return record;
}

function pruneExpiredBrokerTransfers(state: BrokerAuthorityState): void {
  for (const [transferId, record] of state.transfers) {
    if (record.expiresAtMs <= state.nowMs) state.transfers.delete(transferId);
  }
}

function pruneExpiredLifecycleAuthorizations(state: BrokerAuthorityState): void {
  for (const [authorization, record] of state.lifecycleAuthorizations) {
    if (record.expiresAtMs <= state.nowMs) state.lifecycleAuthorizations.delete(authorization);
  }
}

function issueLifecycleAuthorization(
  state: BrokerAuthorityState,
  record: LifecycleAuthorizationInput,
): ArtifactLifecycleAuthorization {
  const authorization = Object.freeze({});
  state.lifecycleAuthorizations.set(authorization, {
    ...record,
    expiresAtMs: checkedAdd(state.nowMs, LIFECYCLE_AUTHORIZATION_WINDOW_MS, "lifecycle authorization expiry"),
  } as LifecycleAuthorizationRecord);
  return authorization as unknown as ArtifactLifecycleAuthorization;
}

function peekLifecycleAuthorization(
  authority: ArtifactBrokerAuthority,
  authorization: ArtifactLifecycleAuthorization,
  expectedKind: LifecycleAuthorizationRecord["kind"],
): LifecycleAuthorizationRecord {
  const state = brokerState(authority);
  pruneExpiredLifecycleAuthorizations(state);
  if (typeof authorization !== "object" || authorization === null) {
    fail("unsafe-input", "lifecycle authorization must be broker-minted");
  }
  const record = state.lifecycleAuthorizations.get(authorization as unknown as object);
  if (!record || record.kind !== expectedKind) {
    fail("unsafe-input", "lifecycle authorization is absent, replayed, or for another operation");
  }
  return record;
}

function consumeLifecycleAuthorization(
  authority: ArtifactBrokerAuthority,
  authorization: ArtifactLifecycleAuthorization,
): void {
  brokerState(authority).lifecycleAuthorizations.delete(authorization as unknown as object);
}

function normalizeDeletionRequest(input: ArtifactDeletionRequest): ArtifactDeletionRequest {
  if (!isPlainRecord(input)) fail("unsafe-input", "artifact deletion request must be a plain record");
  exactKeys(input, ["versionId", "artifactId", "projectId", "chatId", "sessionId", "agentId", "sourceRevision"]);
  const binding = normalizeArtifactBinding({
    artifactId: input.artifactId,
    projectId: input.projectId,
    chatId: input.chatId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    sourceRevision: input.sourceRevision,
  });
  return Object.freeze({ versionId: validateStableId(input.versionId, "versionId"), ...binding });
}

function importBinding(artifact: ArtifactVersion): ArtifactImportBinding {
  return Object.freeze({
    versionId: artifact.versionId,
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    chatId: artifact.chatId,
    sessionId: artifact.sessionId,
    agentId: artifact.agentId,
    sourceRevision: artifact.sourceRevision,
  });
}

function importBindingEqual(left: ArtifactImportBinding, right: ArtifactImportBinding): boolean {
  return left.versionId === right.versionId && artifactBindingEqual(left, right);
}

function importBindingsEqual(left: readonly ArtifactImportBinding[], right: readonly ArtifactImportBinding[]): boolean {
  return left.length === right.length && left.every((binding, index) => importBindingEqual(binding, right[index]));
}

/**
 * In-process authority for transfer registration, phase progression, time, and one-shot lifecycle
 * capabilities. Module-private state provides provenance inside this JavaScript realm only; it is
 * not a substitute for authenticated native-bridge evidence in production.
 */
class ArtifactBrokerAuthority {
  constructor(initialNowMs = 0) {
    brokerAuthorityStates.set(this, {
      nowMs: requireSafeNonNegativeInteger(initialNowMs, "initialNowMs"),
      transfers: new Map(),
      lifecycleAuthorizations: new Map(),
    });
  }

  nowMs(): number {
    return brokerState(this).nowMs;
  }

  advanceTimeTo(nowMs: number): void {
    const state = brokerState(this);
    const next = requireSafeNonNegativeInteger(nowMs, "nowMs");
    if (next < state.nowMs) fail("unsafe-number", "broker time cannot move backward");
    state.nowMs = next;
    pruneExpiredBrokerTransfers(state);
    pruneExpiredLifecycleAuthorizations(state);
  }

  registerTransfer(input: BrokerTransferRegistration): BrokerTransferSnapshot {
    const state = brokerState(this);
    pruneExpiredBrokerTransfers(state);
    const normalized = normalizeBrokerTransferRegistration(input);
    if (normalized.expiresAtMs <= state.nowMs) {
      fail("transfer-state", "broker transfer expiry must be in the future");
    }
    const existing = state.transfers.get(normalized.transferId);
    if (existing) {
      if (
        existing.blobId !== normalized.blobId ||
        !descriptorEqual(existing.descriptor, normalized.descriptor) ||
        !referencesEqual(existing.references, normalized.references) ||
        !artifactBindingEqual(existing.binding, normalized.binding) ||
        existing.expiresAtMs !== normalized.expiresAtMs
      ) {
        fail("identity-conflict", "transferId already names a different broker transfer");
      }
      return brokerTransferSnapshot(existing);
    }
    const record: BrokerTransferRecord = {
      ...normalized,
      phase: "inbound-authorized",
    };
    state.transfers.set(record.transferId, record);
    return brokerTransferSnapshot(record);
  }

  getTransfer(transferId: string): BrokerTransferSnapshot | null {
    const state = brokerState(this);
    pruneExpiredBrokerTransfers(state);
    const id = validateBrokerId(transferId);
    const record = state.transfers.get(id);
    if (!record) return null;
    return brokerTransferSnapshot(record);
  }

  authorizeArtifactCommit(transferId: string): BrokerTransferSnapshot {
    const record = activeBrokerTransfer(this, transferId);
    if (record.phase === "artifact-commit-authorized") return brokerTransferSnapshot(record);
    if (record.phase !== "inbound-authorized") {
      fail("transfer-state", "broker transfer cannot enter artifact commit phase");
    }
    record.phase = "artifact-commit-authorized";
    return brokerTransferSnapshot(record);
  }

  authorizeTransferAck(transferId: string, artifactVersionId: string): BrokerTransferSnapshot {
    const record = activeBrokerTransfer(this, transferId);
    const versionId = validateStableId(artifactVersionId, "versionId");
    if (record.phase === "ack-authorized") {
      if (record.ackArtifactVersionId !== versionId) {
        fail("identity-conflict", "broker ACK phase is bound to another artifact version");
      }
      return brokerTransferSnapshot(record);
    }
    if (record.phase !== "artifact-commit-authorized") {
      fail("transfer-state", "broker transfer cannot enter ACK phase");
    }
    record.phase = "ack-authorized";
    record.ackArtifactVersionId = versionId;
    return brokerTransferSnapshot(record);
  }

  revokeTransfer(transferId: string): BrokerTransferSnapshot {
    const record = activeBrokerTransfer(this, transferId);
    if (record.phase === "ack-authorized") {
      fail("transfer-state", "an ACK-authorized transfer cannot be revoked");
    }
    record.phase = "revoked";
    return brokerTransferSnapshot(record);
  }

  authorizeArtifactDeletion(input: ArtifactDeletionRequest): ArtifactLifecycleAuthorization {
    return issueLifecycleAuthorization(brokerState(this), {
      kind: "delete-artifact",
      request: normalizeDeletionRequest(input),
    });
  }

  authorizeClosurePin(manifestSha256: string, retentionExpiresAtMs: number): ArtifactLifecycleAuthorization {
    const state = brokerState(this);
    const digest = validateDigest(manifestSha256, "manifestSha256");
    const expiry = requireSafeNonNegativeInteger(retentionExpiresAtMs, "retentionExpiresAtMs");
    if (expiry <= state.nowMs) fail("transfer-state", "closure retention expiry must be in the future");
    return issueLifecycleAuthorization(state, {
      kind: "pin-closure",
      manifestSha256: digest,
      retentionExpiresAtMs: expiry,
    });
  }

  authorizeClosureUnpin(manifestSha256: string): ArtifactLifecycleAuthorization {
    return issueLifecycleAuthorization(brokerState(this), {
      kind: "unpin-closure",
      manifestSha256: validateDigest(manifestSha256, "manifestSha256"),
    });
  }

  authorizeClosureImport(manifest: ClosureManifest): ArtifactLifecycleAuthorization {
    const state = brokerState(this);
    const normalized = normalizeManifest(manifest);
    if (manifestPayloadSha256(normalized) !== normalized.manifestSha256) {
      fail("closure-mismatch", "closure import approval requires a valid manifest digest");
    }
    return issueLifecycleAuthorization(state, {
      kind: "import-closure",
      manifestSha256: normalized.manifestSha256,
      bindings: freezeArray(normalized.artifacts.map(importBinding)),
    });
  }
}

function transferSnapshot(record: TransferRecord): ArtifactTransfer {
  return Object.freeze({
    transferId: record.transferId,
    blobId: record.blobId,
    descriptor: record.descriptor,
    references: record.references,
    binding: record.binding,
    expiresAtMs: record.expiresAtMs,
    lifecycle: record.lifecycle,
    ...(record.artifactVersionId ? { artifactVersionId: record.artifactVersionId } : {}),
  });
}

function blobSnapshot(blob: StoredBlob): BlobSnapshot {
  return {
    blobId: blob.blobId,
    descriptor: blob.descriptor,
    references: [...blob.references],
    bytes: cloneBytes(blob.bytes),
  };
}

function storedBlobEqual(
  blob: StoredBlob,
  blobId: string,
  descriptor: BlobDescriptor,
  references: readonly BlobReference[],
  binding: ArtifactTransferBinding,
  bytes: Uint8Array,
): boolean {
  return (
    blob.blobId === blobId &&
    descriptorEqual(blob.descriptor, descriptor) &&
    referencesEqual(blob.references, references) &&
    artifactBindingEqual(blob.binding, binding) &&
    bytesEqual(blob.bytes, bytes)
  );
}

function canonicalReferenceValue(reference: BlobReference): Record<string, unknown> {
  return {
    blobId: reference.blobId,
    byteLength: reference.byteLength,
    sha256: reference.sha256,
    mediaType: reference.mediaType,
    schema: reference.schema,
  };
}

function canonicalArtifact(artifact: ArtifactVersion): string {
  return JSON.stringify({
    versionId: artifact.versionId,
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    chatId: artifact.chatId,
    sessionId: artifact.sessionId,
    agentId: artifact.agentId,
    presentationPath: artifact.presentationPath,
    sourceRevision: {
      buildFingerprint: artifact.sourceRevision.buildFingerprint,
      profileId: artifact.sourceRevision.profileId,
      sessionId: artifact.sourceRevision.sessionId,
      generation: artifact.sourceRevision.generation,
      cursor: artifact.sourceRevision.cursor,
      entryId: artifact.sourceRevision.entryId,
      prefixSha256: artifact.sourceRevision.prefixSha256,
    },
    root: canonicalReferenceValue(artifact.root),
    lifecycle: artifact.lifecycle,
  });
}

function artifactEqual(left: ArtifactVersion, right: ArtifactVersion): boolean {
  return canonicalArtifact(left) === canonicalArtifact(right);
}

function canonicalManifestPayload(manifest: Omit<ClosureManifest, "manifestSha256">): Record<string, unknown> {
  return {
    schema: manifest.schema,
    rootArtifactVersionIds: [...manifest.rootArtifactVersionIds],
    artifacts: manifest.artifacts.map((artifact) => JSON.parse(canonicalArtifact(artifact)) as Record<string, unknown>),
    blobs: manifest.blobs.map((blob) => ({
      ...canonicalReferenceValue(blob),
      references: blob.references.map(canonicalReferenceValue),
    })),
    totalBytes: manifest.totalBytes,
  };
}

function manifestPayloadSha256(manifest: Omit<ClosureManifest, "manifestSha256">): string {
  return trustedSha256(utf8Bytes(JSON.stringify(canonicalManifestPayload(manifest))));
}

function canonicalManifestValue(manifest: ClosureManifest): Record<string, unknown> {
  return { ...canonicalManifestPayload(manifest), manifestSha256: manifest.manifestSha256 };
}

export class ArtifactStore {
  readonly #broker: ArtifactBrokerAuthority;
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly artifacts = new Map<string, ArtifactVersion>();
  private readonly pins = new Map<string, RetainedClosure>();

  private constructor(broker: ArtifactBrokerAuthority) {
    this.#broker = requireBrokerAuthority(broker);
    this.reconcileRetention();
  }

  /** Creates a store only from an opaque handle minted by the trusted broker integration. */
  static createFromTrustedBroker(broker: ArtifactBrokerHandle): ArtifactStore {
    return new ArtifactStore(requireBrokerHandle(broker));
  }

  /** Stage only a transfer already registered by this exact broker authority. */
  stageTransfer(transferId: string): ArtifactTransfer {
    this.reconcileRetention();
    const evidence = activeBrokerTransfer(this.#broker, transferId);
    const existing = this.transfers.get(evidence.transferId);
    if (existing) return transferSnapshot(existing);
    if (evidence.phase !== "inbound-authorized") {
      fail("transfer-state", "a transfer must be staged during its inbound-authorized broker phase");
    }
    const record: TransferRecord = { ...evidence, lifecycle: "spooled" };
    this.transfers.set(record.transferId, record);
    return transferSnapshot(record);
  }

  beginTransfer(transferId: string): ArtifactTransfer {
    return this.stageTransfer(transferId);
  }

  receiveTransfer(transferId: string, input: Uint8Array): ArtifactTransfer {
    this.reconcileRetention();
    const record = this.requireTransfer(transferId);
    const evidence = activeBrokerTransfer(this.#broker, record.transferId);
    if (evidence.phase === "revoked") fail("transfer-state", "a revoked broker transfer cannot receive bytes");
    if (record.lifecycle === "verified" && record.bytes) {
      const bytes = validateBytes(input);
      if (!bytesEqual(record.bytes, bytes)) {
        fail("identity-conflict", "transferId already received different bytes");
      }
      return transferSnapshot(record);
    }
    if (record.lifecycle !== "spooled") {
      fail("transfer-state", `cannot receive bytes in ${record.lifecycle} state`);
    }
    const bytes = validateBytes(input);
    verifyBytesAgainstDescriptor(bytes, record.descriptor);
    record.bytes = bytes;
    record.lifecycle = "verified";
    return transferSnapshot(record);
  }

  promoteTransfer(transferId: string): ArtifactTransfer {
    this.reconcileRetention();
    const record = this.requireTransfer(transferId);
    const evidence = activeBrokerTransfer(this.#broker, record.transferId);
    if (evidence.phase === "revoked") fail("transfer-state", "a revoked broker transfer cannot be promoted");
    if (record.lifecycle === "promoted" || record.lifecycle === "referenced" || record.lifecycle === "acked") {
      return transferSnapshot(record);
    }
    if (record.lifecycle !== "verified" || !record.bytes) {
      fail("transfer-state", `cannot promote a transfer in ${record.lifecycle} state`);
    }
    verifyBytesAgainstDescriptor(record.bytes, record.descriptor);
    const existing = this.blobs.get(record.blobId);
    if (existing) {
      if (!storedBlobEqual(existing, record.blobId, record.descriptor, record.references, record.binding, record.bytes)) {
        fail("identity-conflict", "blobId already names different immutable bytes or metadata");
      }
    } else {
      this.blobs.set(record.blobId, {
        blobId: record.blobId,
        descriptor: record.descriptor,
        references: record.references,
        binding: record.binding,
        bytes: cloneBytes(record.bytes),
      });
    }
    record.lifecycle = "promoted";
    return transferSnapshot(record);
  }

  /**
   * A durable artifact can only be committed from a promoted transfer whose broker record has
   * explicitly entered commit phase and whose full ownership/source binding is identical.
   */
  commitArtifact(transferId: string, input: ArtifactVersionDraft): ArtifactVersion {
    this.reconcileRetention();
    const record = this.requireTransfer(transferId);
    const evidence = activeBrokerTransfer(this.#broker, record.transferId);
    if (record.lifecycle !== "promoted" && record.lifecycle !== "referenced") {
      fail("transfer-state", `cannot commit an artifact from ${record.lifecycle} state`);
    }
    const draft = normalizeArtifactDraft(input);
    const repeatCommit = record.artifactVersionId === draft.versionId;
    if (
      evidence.phase !== "artifact-commit-authorized" &&
      !(repeatCommit && evidence.phase === "ack-authorized")
    ) {
      fail("transfer-state", "artifact commit lacks broker commit-phase evidence");
    }
    if (record.artifactVersionId && !repeatCommit) {
      fail("transfer-state", "one transfer cannot acknowledge multiple artifact versions");
    }
    if (!referenceEqual(draft.root, { blobId: record.blobId, ...record.descriptor })) {
      fail("reference-mismatch", "artifact root does not match the promoted transfer");
    }
    if (!artifactBindingEqual(draft, evidence.binding)) {
      fail("provenance-mismatch", "artifact ownership or source revision differs from broker transfer evidence");
    }
    const artifact = this.commitArtifactDraft(draft);
    record.artifactVersionId = draft.versionId;
    record.lifecycle = "referenced";
    return artifact;
  }

  ackTransfer(transferId: string): ArtifactTransfer {
    this.reconcileRetention();
    const record = this.requireTransfer(transferId);
    const evidence = activeBrokerTransfer(this.#broker, record.transferId);
    if (record.lifecycle === "acked") return transferSnapshot(record);
    if (record.lifecycle !== "referenced" || !record.artifactVersionId) {
      fail("ack-before-reference", "ACK is valid only after a durable broker-bound reference exists");
    }
    if (evidence.phase !== "ack-authorized" || evidence.ackArtifactVersionId !== record.artifactVersionId) {
      fail("transfer-state", "ACK lacks broker evidence for this durable artifact version");
    }
    if (!this.isBlobReachable(record.blobId)) {
      fail("ack-before-reference", "ACK is valid only after a durable closure reference exists");
    }
    record.lifecycle = "acked";
    return transferSnapshot(record);
  }

  abortTransfer(transferId: string): ArtifactTransfer {
    this.reconcileRetention();
    const record = this.requireTransfer(transferId);
    const evidence = activeBrokerTransfer(this.#broker, record.transferId);
    if (evidence.phase !== "revoked") {
      fail("transfer-state", "transfer abort requires broker revocation evidence");
    }
    if (record.lifecycle === "acked" || record.lifecycle === "referenced") {
      fail("transfer-state", "a durably referenced transfer cannot be aborted");
    }
    record.lifecycle = "aborted";
    record.bytes = undefined;
    this.reconcileRetention();
    return transferSnapshot(record);
  }

  getTransfer(transferId: string): ArtifactTransfer | null {
    this.reconcileRetention();
    const record = this.transfers.get(validateBrokerId(transferId));
    return record ? transferSnapshot(record) : null;
  }

  getBlob(blobId: string): BlobSnapshot | null {
    this.reconcileRetention();
    const blob = this.blobs.get(validateStableId(blobId, "blobId"));
    return blob ? blobSnapshot(blob) : null;
  }

  getArtifact(versionId: string): ArtifactVersion | null {
    this.reconcileRetention();
    return this.artifacts.get(validateStableId(versionId, "versionId")) ?? null;
  }

  listArtifacts(): ArtifactVersion[] {
    this.reconcileRetention();
    return [...this.artifacts.values()].sort((left, right) => compareUtf8Ordinal(left.versionId, right.versionId));
  }

  /** Deletes only the exact project/chat/session target authorized by the broker. */
  deleteArtifact(authorization: ArtifactLifecycleAuthorization): boolean {
    this.reconcileRetention();
    const command = peekLifecycleAuthorization(this.#broker, authorization, "delete-artifact");
    if (command.kind !== "delete-artifact") fail("unsafe-input", "invalid delete authorization");
    // A broker command is one-shot even when the target was concurrently removed or mismatched.
    consumeLifecycleAuthorization(this.#broker, authorization);
    const artifact = this.artifacts.get(command.request.versionId);
    if (!artifact) return false;
    if (!artifactBindingEqual(artifact, command.request)) {
      fail("provenance-mismatch", "deletion authorization does not match artifact ownership");
    }
    this.artifacts.delete(artifact.versionId);
    this.reconcileRetention();
    return true;
  }

  createClosureManifest(rootArtifactVersionIds: readonly string[]): ClosureManifest {
    this.reconcileRetention();
    return this.buildClosureManifest(rootArtifactVersionIds);
  }

  /** Pins are finite broker-approved retention leases, not caller-managed reachability. */
  pinClosure(authorization: ArtifactLifecycleAuthorization, manifest: ClosureManifest): void {
    this.reconcileRetention();
    const command = peekLifecycleAuthorization(this.#broker, authorization, "pin-closure");
    if (command.kind !== "pin-closure") fail("unsafe-input", "invalid pin authorization");
    consumeLifecycleAuthorization(this.#broker, authorization);
    const normalized = normalizeManifest(manifest);
    if (command.manifestSha256 !== normalized.manifestSha256) {
      fail("provenance-mismatch", "pin authorization does not match closure manifest");
    }
    const expected = this.buildClosureManifest(normalized.rootArtifactVersionIds);
    if (serializeClosureManifest(expected) !== serializeClosureManifest(normalized)) {
      fail("closure-mismatch", "only the exact current closure may be pinned");
    }
    this.verifyManifestBlobs(normalized);
    this.pins.set(normalized.manifestSha256, {
      manifest: normalized,
      expiresAtMs: command.retentionExpiresAtMs,
    });
  }

  unpinClosure(authorization: ArtifactLifecycleAuthorization): boolean {
    this.reconcileRetention();
    const command = peekLifecycleAuthorization(this.#broker, authorization, "unpin-closure");
    if (command.kind !== "unpin-closure") fail("unsafe-input", "invalid unpin authorization");
    consumeLifecycleAuthorization(this.#broker, authorization);
    const removed = this.pins.delete(command.manifestSha256);
    this.reconcileRetention();
    return removed;
  }

  verifyClosureManifest(manifest: ClosureManifest): void {
    this.reconcileRetention();
    const normalized = normalizeManifest(manifest);
    const expected = this.buildClosureManifest(normalized.rootArtifactVersionIds);
    if (serializeClosureManifest(expected) !== serializeClosureManifest(normalized)) {
      fail("closure-mismatch", "closure manifest does not match the current immutable graph");
    }
    this.verifyManifestBlobs(normalized);
  }

  exportClosure(rootArtifactVersionIds: readonly string[]): ArtifactExport {
    this.reconcileRetention();
    const manifest = this.buildClosureManifest(rootArtifactVersionIds);
    const objects = manifest.blobs.map((blob) => {
      const stored = this.blobs.get(blob.blobId);
      if (!stored) fail("missing-blob", `manifest blob ${blob.blobId} is missing`);
      return { blobId: blob.blobId, bytes: cloneBytes(stored.bytes) };
    });
    return { schema: ARTIFACT_EXPORT_SCHEMA, manifest, objects };
  }

  restoreClosure(authorization: ArtifactLifecycleAuthorization, input: unknown): void {
    this.reconcileRetention();
    const command = peekLifecycleAuthorization(this.#broker, authorization, "import-closure");
    if (command.kind !== "import-closure") fail("unsafe-input", "invalid import authorization");
    consumeLifecycleAuthorization(this.#broker, authorization);
    const decoded = typeof input === "string" ? deserializeArtifactExport(input) : decodeArtifactExport(input);
    const bindings = decoded.manifest.artifacts.map(importBinding);
    if (command.manifestSha256 !== decoded.manifest.manifestSha256 || !importBindingsEqual(command.bindings, bindings)) {
      fail("provenance-mismatch", "closure import lacks matching broker ownership/source evidence");
    }
    const imported = new ArtifactStore(this.#broker);
    imported.loadDecodedClosure(decoded);
    this.mergeImportedClosure(imported);
    this.reconcileRetention();
  }

  restore(authorization: ArtifactLifecycleAuthorization, input: unknown): void {
    this.restoreClosure(authorization, input);
  }

  static restore(
    input: unknown,
    broker: ArtifactBrokerHandle,
    authorization: ArtifactLifecycleAuthorization,
  ): ArtifactStore {
    const store = ArtifactStore.createFromTrustedBroker(broker);
    store.restoreClosure(authorization, input);
    return store;
  }

  private loadDecodedClosure(decoded: ArtifactExport): void {
    const objects = new Map(decoded.objects.map((object) => [object.blobId, object]));
    const bindings = deriveManifestBlobBindings(decoded.manifest);
    for (const blob of decoded.manifest.blobs) {
      const object = objects.get(blob.blobId);
      if (!object) fail("missing-blob", `export is missing blob ${blob.blobId}`);
      const binding = bindings.get(blob.blobId);
      if (!binding) fail("invalid-closure", `export blob ${blob.blobId} has no artifact ownership binding`);
      const bytes = cloneBytes(object.bytes);
      verifyBytesAgainstDescriptor(bytes, blob);
      this.blobs.set(blob.blobId, {
        blobId: blob.blobId,
        descriptor: blob,
        references: blob.references,
        binding,
        bytes,
      });
    }
    if (objects.size !== decoded.manifest.blobs.length) {
      fail("invalid-closure", "export contains a blob outside the exact manifest closure");
    }
    for (const artifact of decoded.manifest.artifacts) this.artifacts.set(artifact.versionId, artifact);
    this.verifyClosureManifest(decoded.manifest);
  }

  /**
   * An import is scoped to its broker-approved immutable closure. It can add that closure or
   * prove an idempotent duplicate, but it can never clear unrelated artifacts, transfers, or
   * retention leases that the import authority did not cover.
   */
  private mergeImportedClosure(other: ArtifactStore): void {
    for (const [blobId, blob] of other.blobs) {
      const existing = this.blobs.get(blobId);
      if (
        existing &&
        !storedBlobEqual(existing, blob.blobId, blob.descriptor, blob.references, blob.binding, blob.bytes)
      ) {
        fail("identity-conflict", `imported blob ${blobId} conflicts with durable storage`);
      }
    }
    for (const [versionId, artifact] of other.artifacts) {
      const existing = this.artifacts.get(versionId);
      if (existing && !artifactEqual(existing, artifact)) {
        fail("identity-conflict", `imported artifact ${versionId} conflicts with durable storage`);
      }
    }
    for (const [blobId, blob] of other.blobs) {
      if (!this.blobs.has(blobId)) {
        this.blobs.set(blobId, {
          blobId: blob.blobId,
          descriptor: blob.descriptor,
          references: blob.references,
          binding: blob.binding,
          bytes: cloneBytes(blob.bytes),
        });
      }
    }
    for (const [versionId, artifact] of other.artifacts) {
      if (!this.artifacts.has(versionId)) this.artifacts.set(versionId, artifact);
    }
  }

  private requireTransfer(transferId: string): TransferRecord {
    const id = validateBrokerId(transferId);
    const record = this.transfers.get(id);
    if (!record) fail("transfer-not-found", `transfer ${id} was not staged`);
    return record;
  }

  private commitArtifactDraft(draft: ArtifactVersionDraft): ArtifactVersion {
    const artifact = createArtifactVersion(draft);
    const existing = this.artifacts.get(artifact.versionId);
    if (existing) {
      if (!artifactEqual(existing, artifact)) {
        fail("identity-conflict", "versionId already names a different immutable artifact version");
      }
      return existing;
    }
    if (!this.blobs.has(artifact.root.blobId)) {
      fail("missing-blob", `artifact root ${artifact.root.blobId} is not durable`);
    }
    this.artifacts.set(artifact.versionId, artifact);
    try {
      this.buildClosureManifest([artifact.versionId]);
    } catch (error) {
      this.artifacts.delete(artifact.versionId);
      throw error;
    }
    return artifact;
  }

  private buildClosureManifest(rootArtifactVersionIds: readonly string[]): ClosureManifest {
    const rootSnapshot = snapshotDenseArray(
      rootArtifactVersionIds,
      "closure roots",
      MAX_EXPORT_ITEMS,
      1,
      "invalid-closure",
    );
    const roots = rootSnapshot.map((versionId) => validateStableId(versionId, "versionId"));
    const uniqueRoots = [...new Set(roots)].sort(compareUtf8Ordinal);
    if (uniqueRoots.length !== roots.length) fail("duplicate-id", "closure root identities must be unique");
    const artifacts = uniqueRoots.map((versionId) => {
      const artifact = this.artifacts.get(versionId);
      if (!artifact) fail("invalid-closure", `artifact ${versionId} is missing`);
      return artifact;
    });
    const blobs = new Map<string, BlobManifestEntry>();
    const blobBindings = new Map<string, ArtifactTransferBinding>();
    for (const artifact of artifacts) this.visitBlob(artifact.root, artifact, new Set(), blobs, blobBindings);
    const orderedBlobs = [...blobs.values()].sort((left, right) => compareUtf8Ordinal(left.blobId, right.blobId));
    let totalBytes = 0;
    for (const blob of orderedBlobs) totalBytes = checkedAdd(totalBytes, blob.byteLength, "closure totalBytes");
    const payload: Omit<ClosureManifest, "manifestSha256"> = {
      schema: CLOSURE_MANIFEST_SCHEMA,
      rootArtifactVersionIds: freezeArray(uniqueRoots),
      artifacts: freezeArray(artifacts),
      blobs: freezeArray(orderedBlobs),
      totalBytes,
    };
    return Object.freeze({ ...payload, manifestSha256: manifestPayloadSha256(payload) });
  }

  private visitBlob(
    reference: BlobReference,
    expectedBinding: ArtifactTransferBinding,
    stack: Set<string>,
    blobs: Map<string, BlobManifestEntry>,
    blobBindings: Map<string, ArtifactTransferBinding>,
  ): void {
    const existing = blobs.get(reference.blobId);
    if (existing) {
      if (!referenceEqual(existing, reference)) {
        fail("identity-conflict", `blob ${reference.blobId} has conflicting descriptors`);
      }
      const existingBinding = blobBindings.get(reference.blobId);
      if (!existingBinding || !artifactBindingEqual(existingBinding, expectedBinding)) {
        fail("provenance-mismatch", `blob ${reference.blobId} crosses artifact ownership/source boundaries`);
      }
      return;
    }
    if (stack.has(reference.blobId)) fail("cycle", `blob closure contains a cycle at ${reference.blobId}`);
    const stored = this.blobs.get(reference.blobId);
    if (!stored) fail("missing-blob", `blob ${reference.blobId} is missing from durable storage`);
    this.verifyStoredBlob(stored);
    if (!descriptorEqual(stored.descriptor, reference)) {
      fail("reference-mismatch", `blob ${reference.blobId} differs from its declared reference`);
    }
    if (!artifactBindingEqual(stored.binding, expectedBinding)) {
      fail("provenance-mismatch", `blob ${reference.blobId} differs from broker ownership/source evidence`);
    }
    stack.add(reference.blobId);
    for (const child of stored.references) this.visitBlob(child, expectedBinding, stack, blobs, blobBindings);
    stack.delete(reference.blobId);
    blobBindings.set(reference.blobId, expectedBinding);
    blobs.set(reference.blobId, Object.freeze({
      blobId: stored.blobId,
      ...stored.descriptor,
      references: stored.references,
    }));
  }

  private verifyStoredBlob(blob: StoredBlob): void {
    if (blob.bytes.byteLength !== blob.descriptor.byteLength) {
      fail("corrupt-blob", `durable blob ${blob.blobId} has a length mismatch`);
    }
    if (trustedSha256(blob.bytes) !== blob.descriptor.sha256) {
      fail("corrupt-blob", `durable blob ${blob.blobId} has a digest mismatch`);
    }
  }

  private verifyManifestBlobs(manifest: ClosureManifest): void {
    const bindings = deriveManifestBlobBindings(manifest);
    for (const blob of manifest.blobs) {
      const stored = this.blobs.get(blob.blobId);
      if (!stored) fail("missing-blob", `manifest blob ${blob.blobId} is missing`);
      const binding = bindings.get(blob.blobId);
      if (!binding || !artifactBindingEqual(stored.binding, binding)) {
        fail("provenance-mismatch", `manifest blob ${blob.blobId} differs from durable ownership/source evidence`);
      }
      this.verifyStoredBlob(stored);
      if (!descriptorEqual(stored.descriptor, blob) || !referencesEqual(stored.references, blob.references)) {
        fail("corrupt-blob", `manifest blob ${blob.blobId} does not match durable metadata`);
      }
    }
  }

  private isBlobReachable(blobId: string): boolean {
    return this.reachableBlobIds().has(blobId);
  }

  private reachableBlobIds(): Set<string> {
    const reachable = new Set<string>();
    const bindings = new Map<string, ArtifactTransferBinding>();
    const visit = (reference: BlobReference, expectedBinding: ArtifactTransferBinding): void => {
      const existingBinding = bindings.get(reference.blobId);
      if (existingBinding) {
        if (!artifactBindingEqual(existingBinding, expectedBinding)) {
          fail("provenance-mismatch", `reachable blob ${reference.blobId} crosses artifact ownership/source boundaries`);
        }
        return;
      }
      const stored = this.blobs.get(reference.blobId);
      if (!stored) fail("missing-blob", `reachable blob ${reference.blobId} is missing`);
      this.verifyStoredBlob(stored);
      if (!descriptorEqual(stored.descriptor, reference)) {
        fail("reference-mismatch", `reachable blob ${reference.blobId} differs from its reference`);
      }
      if (!artifactBindingEqual(stored.binding, expectedBinding)) {
        fail("provenance-mismatch", `reachable blob ${reference.blobId} differs from broker ownership/source evidence`);
      }
      bindings.set(reference.blobId, expectedBinding);
      reachable.add(reference.blobId);
      for (const child of stored.references) visit(child, expectedBinding);
    };
    for (const artifact of this.artifacts.values()) visit(artifact.root, artifact);
    for (const pin of this.pins.values()) {
      this.verifyManifestBlobs(pin.manifest);
      for (const blob of pin.manifest.blobs) reachable.add(blob.blobId);
    }
    return reachable;
  }

  /**
   * Retention is enforced on every public state transition/read. Expired spool records vanish;
   * expired transfer leases and pins no longer retain unreferenced durable blobs, which are then
   * collected atomically by this reconciliation pass rather than an optional caller cleanup call.
   */
  private reconcileRetention(): void {
    const now = this.#broker.nowMs();
    for (const [transferId, record] of this.transfers) {
      if (record.expiresAtMs <= now) this.transfers.delete(transferId);
    }
    for (const [manifestSha256, pin] of this.pins) {
      if (pin.expiresAtMs <= now) this.pins.delete(manifestSha256);
    }
    const reachable = this.reachableBlobIds();
    const transferRetainedBlobIds = new Set<string>();
    for (const transfer of this.transfers.values()) {
      if (
        transfer.lifecycle === "promoted" ||
        transfer.lifecycle === "referenced" ||
        transfer.lifecycle === "acked"
      ) {
        transferRetainedBlobIds.add(transfer.blobId);
      }
    }
    for (const blobId of this.blobs.keys()) {
      if (!reachable.has(blobId) && !transferRetainedBlobIds.has(blobId)) this.blobs.delete(blobId);
    }
  }
}

function createTestBrokerHandle(initialNowMs = 0): ArtifactBrokerTestHarness {
  const authority = new ArtifactBrokerAuthority(initialNowMs);
  let handle: ArtifactBrokerTestHarness;
  handle = Object.freeze({
    createStore: () => ArtifactStore.createFromTrustedBroker(handle),
    nowMs: () => authority.nowMs(),
    advanceTimeTo: (nowMs: number) => authority.advanceTimeTo(nowMs),
    registerTransfer: (input: BrokerTransferRegistration) => authority.registerTransfer(input),
    getTransfer: (transferId: string) => authority.getTransfer(transferId),
    authorizeArtifactCommit: (transferId: string) => authority.authorizeArtifactCommit(transferId),
    authorizeTransferAck: (transferId: string, artifactVersionId: string) =>
      authority.authorizeTransferAck(transferId, artifactVersionId),
    revokeTransfer: (transferId: string) => authority.revokeTransfer(transferId),
    authorizeArtifactDeletion: (input: ArtifactDeletionRequest) => authority.authorizeArtifactDeletion(input),
    authorizeClosurePin: (manifestSha256: string, retentionExpiresAtMs: number) =>
      authority.authorizeClosurePin(manifestSha256, retentionExpiresAtMs),
    authorizeClosureUnpin: (manifestSha256: string) => authority.authorizeClosureUnpin(manifestSha256),
    authorizeClosureImport: (manifest: ClosureManifest) => authority.authorizeClosureImport(manifest),
  }) as unknown as ArtifactBrokerTestHarness;
  brokerHandleAuthorities.set(handle as unknown as object, authority);
  return handle;
}

/**
 * Production bootstrap is deliberately unavailable until package-private native-bridge code can
 * authenticate broker evidence. This public module never mints production authority in JavaScript.
 */
export const artifactDomainProductionBroker: ArtifactBrokerHandle | undefined = undefined;

/** Test builds alone may create isolated in-process fixtures; these are not production authority. */
export const artifactDomainTestHarness: ArtifactDomainTestHarness | undefined =
  import.meta.env.MODE === "test" && !import.meta.env.PROD
    ? Object.freeze({ createBroker: createTestBrokerHandle })
    : undefined;

function normalizeManifest(input: ClosureManifest): ClosureManifest {
  if (!isPlainRecord(input)) fail("unsafe-input", "closure manifest must be a plain record");
  exactKeys(input, ["schema", "rootArtifactVersionIds", "artifacts", "blobs", "totalBytes", "manifestSha256"]);
  if (field(input, "schema") !== CLOSURE_MANIFEST_SCHEMA) {
    fail("invalid-closure", "closure manifest schema is unsupported");
  }
  const rootsValue = snapshotDenseArray(
    field(input, "rootArtifactVersionIds"),
    "closure manifest roots",
    MAX_EXPORT_ITEMS,
    1,
    "invalid-closure",
  );
  const roots = rootsValue.map((root) => validateStableId(root, "versionId")).sort(compareUtf8Ordinal);
  if (new Set(roots).size !== roots.length) fail("duplicate-id", "closure manifest roots must be unique");

  const artifactsValue = snapshotDenseArray(
    field(input, "artifacts"),
    "closure manifest artifacts",
    MAX_EXPORT_ITEMS,
    0,
    "invalid-closure",
  );
  if (artifactsValue.length !== roots.length) {
    fail("invalid-closure", "closure manifest artifact set is not exact");
  }
  const artifacts = artifactsValue.map((artifact) => decodeArtifactValue(artifact));
  artifacts.sort((left, right) => compareUtf8Ordinal(left.versionId, right.versionId));
  if (artifacts.some((artifact, index) => artifact.versionId !== roots[index])) {
    fail("invalid-closure", "closure manifest roots and artifacts disagree");
  }

  const blobsValue = snapshotDenseArray(
    field(input, "blobs"),
    "closure manifest blobs",
    MAX_EXPORT_ITEMS,
    0,
    "invalid-closure",
  );
  const blobs = blobsValue.map((blob) => decodeBlobManifestValue(blob));
  blobs.sort((left, right) => compareUtf8Ordinal(left.blobId, right.blobId));
  if (new Set(blobs.map((blob) => blob.blobId)).size !== blobs.length) {
    fail("duplicate-id", "closure manifest blob identities must be unique");
  }
  const totalBytes = requireSafeNonNegativeInteger(field(input, "totalBytes"), "totalBytes");
  const manifestSha256 = validateDigest(field(input, "manifestSha256"), "manifestSha256");
  const manifest = Object.freeze({
    schema: CLOSURE_MANIFEST_SCHEMA,
    rootArtifactVersionIds: freezeArray(roots),
    artifacts: freezeArray(artifacts),
    blobs: freezeArray(blobs),
    totalBytes,
    manifestSha256,
  });
  validateManifestClosure(manifest);
  return manifest;
}

/** Every blob in a closure must be reachable from exactly one ownership/source binding. */
function deriveManifestBlobBindings(manifest: ClosureManifest): Map<string, ArtifactTransferBinding> {
  const manifestBlobs = new Map(manifest.blobs.map((blob) => [blob.blobId, blob]));
  const bindings = new Map<string, ArtifactTransferBinding>();
  const visit = (
    reference: BlobReference,
    binding: ArtifactTransferBinding,
    stack: Set<string>,
  ): void => {
    if (stack.has(reference.blobId)) fail("cycle", `manifest blob closure contains a cycle at ${reference.blobId}`);
    const blob = manifestBlobs.get(reference.blobId);
    if (!blob) fail("missing-blob", `manifest is missing blob ${reference.blobId}`);
    if (!referenceEqual(blob, reference)) {
      fail("reference-mismatch", `manifest blob ${reference.blobId} differs from its declared reference`);
    }
    const existingBinding = bindings.get(reference.blobId);
    if (existingBinding) {
      if (!artifactBindingEqual(existingBinding, binding)) {
        fail("provenance-mismatch", `manifest blob ${reference.blobId} crosses artifact ownership/source boundaries`);
      }
      return;
    }
    stack.add(reference.blobId);
    for (const child of blob.references) visit(child, binding, stack);
    stack.delete(reference.blobId);
    bindings.set(reference.blobId, binding);
  };
  for (const artifact of manifest.artifacts) visit(artifact.root, artifact, new Set());
  if (bindings.size !== manifestBlobs.size) {
    fail("invalid-closure", "manifest contains a blob outside its declared artifact closure");
  }
  return bindings;
}

function validateManifestClosure(manifest: ClosureManifest): void {
  deriveManifestBlobBindings(manifest);
  let totalBytes = 0;
  for (const blob of manifest.blobs) totalBytes = checkedAdd(totalBytes, blob.byteLength, "closure totalBytes");
  if (totalBytes !== manifest.totalBytes) {
    fail("closure-mismatch", "manifest totalBytes does not match its exact blob closure");
  }
}

function decodeDescriptorValue(value: unknown): BlobDescriptor {
  if (!isPlainRecord(value)) fail("unsafe-input", "blob descriptor must be a plain record");
  exactKeys(value, ["byteLength", "sha256", "mediaType", "schema"]);
  return createBlobDescriptor({
    byteLength: field(value, "byteLength") as number,
    sha256: field(value, "sha256") as string,
    mediaType: field(value, "mediaType") as string,
    schema: field(value, "schema") as string,
  });
}

function decodeReferenceValue(value: unknown): BlobReference {
  if (!isPlainRecord(value)) fail("unsafe-input", "blob reference must be a plain record");
  exactKeys(value, ["blobId", "byteLength", "sha256", "mediaType", "schema"]);
  return createBlobReference({
    blobId: field(value, "blobId") as string,
    byteLength: field(value, "byteLength") as number,
    sha256: field(value, "sha256") as string,
    mediaType: field(value, "mediaType") as string,
    schema: field(value, "schema") as string,
  });
}

function decodeSourceRevisionValue(value: unknown): ArtifactSourceRevision {
  if (!isPlainRecord(value)) fail("unsafe-input", "source revision must be a plain record");
  exactKeys(value, ["buildFingerprint", "profileId", "sessionId", "generation", "cursor", "entryId", "prefixSha256"]);
  return createSourceRevision({
    buildFingerprint: field(value, "buildFingerprint") as string,
    profileId: field(value, "profileId") as string,
    sessionId: field(value, "sessionId") as string,
    generation: field(value, "generation") as number,
    cursor: field(value, "cursor") as number,
    entryId: field(value, "entryId") as string,
    prefixSha256: field(value, "prefixSha256") as string,
  });
}

function decodeArtifactValue(value: unknown): ArtifactVersion {
  if (!isPlainRecord(value)) fail("unsafe-input", "artifact version must be a plain record");
  exactKeys(value, [
    "versionId",
    "artifactId",
    "projectId",
    "chatId",
    "sessionId",
    "agentId",
    "presentationPath",
    "sourceRevision",
    "root",
    "lifecycle",
  ]);
  if (field(value, "lifecycle") !== "durable") fail("invalid-lifecycle", "artifact lifecycle is unsupported");
  return createArtifactVersion({
    versionId: field(value, "versionId") as string,
    artifactId: field(value, "artifactId") as string,
    projectId: field(value, "projectId") as string,
    chatId: field(value, "chatId") as string,
    sessionId: field(value, "sessionId") as string,
    agentId: field(value, "agentId") as string,
    presentationPath: field(value, "presentationPath") as string,
    sourceRevision: decodeSourceRevisionValue(field(value, "sourceRevision")),
    root: decodeReferenceValue(field(value, "root")),
  });
}

function decodeBlobManifestValue(value: unknown): BlobManifestEntry {
  if (!isPlainRecord(value)) fail("unsafe-input", "manifest blob must be a plain record");
  exactKeys(value, ["blobId", "byteLength", "sha256", "mediaType", "schema", "references"]);
  const referencesValue = snapshotDenseArray(
    field(value, "references"),
    "manifest blob references",
    MAX_REFERENCE_COUNT,
  );
  return Object.freeze({
    ...decodeReferenceValue({
      blobId: field(value, "blobId"),
      byteLength: field(value, "byteLength"),
      sha256: field(value, "sha256"),
      mediaType: field(value, "mediaType"),
      schema: field(value, "schema"),
    }),
    references: createReferences(referencesValue.map((reference) => decodeReferenceValue(reference))),
  });
}

function decodeRuntimeBytes(value: unknown): Uint8Array {
  if (isUint8Array(value)) return validateBytes(value);
  const { array, length } = inspectBoundedOrdinaryArray(value, "encoded bytes", MAX_RUNTIME_BYTE_ARRAY);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const byte = denseDataItem(array, index, "encoded bytes", "unsafe-input");
    if (!isSafeInteger(byte) || byte < 0 || byte > 255) {
      fail("unsafe-number", "encoded bytes contain a value outside 0..255");
    }
    bytes[index] = byte;
  }
  return bytes;
}

function decodeManifestValue(value: unknown): ClosureManifest {
  const manifest = normalizeManifest(value as ClosureManifest);
  if (manifestPayloadSha256(manifest) !== manifest.manifestSha256) {
    fail("closure-mismatch", "manifest digest does not match its canonical content");
  }
  return manifest;
}

function assertExactExportObjects(exported: ArtifactExport): void {
  const expectedIds = new Set(exported.manifest.blobs.map((blob) => blob.blobId));
  const actualIds = new Set(exported.objects.map((object) => object.blobId));
  for (const expectedId of expectedIds) {
    if (!actualIds.has(expectedId)) fail("missing-blob", `export is missing blob ${expectedId}`);
  }
  for (const actualId of actualIds) {
    if (!expectedIds.has(actualId)) fail("invalid-closure", `export contains unexpected blob ${actualId}`);
  }
}

export function decodeTransferEnvelope(value: unknown, broker: ArtifactBrokerHandle): {
  schema: typeof ARTIFACT_TRANSFER_SCHEMA;
  transferId: string;
  blobId: string;
  descriptor: BlobDescriptor;
  references: readonly BlobReference[];
  bytes: Uint8Array;
} {
  const authority = requireBrokerHandle(broker);
  if (!isPlainRecord(value)) fail("unsafe-input", "transfer envelope must be a plain record");
  exactKeys(value, ["schema", "transferId", "blobId", "descriptor", "references", "bytes"]);
  if (field(value, "schema") !== ARTIFACT_TRANSFER_SCHEMA) {
    fail("unsafe-input", "transfer envelope schema is unsupported");
  }
  const transferId = validateBrokerId(field(value, "transferId"));
  const evidence = activeBrokerTransfer(authority, transferId);
  if (evidence.phase !== "inbound-authorized") {
    fail("transfer-state", "transfer envelopes require live inbound-authorized broker evidence");
  }
  const descriptor = decodeDescriptorValue(field(value, "descriptor"));
  const referencesValue = snapshotDenseArray(
    field(value, "references"),
    "transfer envelope references",
    MAX_REFERENCE_COUNT,
  );
  const references = createReferences(referencesValue.map((reference) => decodeReferenceValue(reference)));
  const bytes = decodeRuntimeBytes(field(value, "bytes"));
  verifyBytesAgainstDescriptor(bytes, descriptor);
  const blobId = validateStableId(field(value, "blobId"), "blobId");
  if (
    evidence.blobId !== blobId ||
    !descriptorEqual(evidence.descriptor, descriptor) ||
    !referencesEqual(evidence.references, references)
  ) {
    fail("provenance-mismatch", "transfer envelope metadata does not match broker transfer evidence");
  }
  return { schema: ARTIFACT_TRANSFER_SCHEMA, transferId, blobId, descriptor, references, bytes };
}

export function decodeArtifactExport(value: unknown): ArtifactExport {
  if (!isPlainRecord(value)) fail("unsafe-input", "artifact export must be a plain record");
  exactKeys(value, ["schema", "manifest", "objects"]);
  if (field(value, "schema") !== ARTIFACT_EXPORT_SCHEMA) {
    fail("unsafe-input", "artifact export schema is unsupported");
  }
  const manifest = decodeManifestValue(field(value, "manifest"));
  const objectsValue = snapshotDenseArray(
    field(value, "objects"),
    "artifact export objects",
    MAX_EXPORT_ITEMS,
  );
  const objects: ExportBlob[] = [];
  const seen = new Set<string>();
  for (const object of objectsValue) {
    if (!isPlainRecord(object)) fail("unsafe-input", "export blob must be a plain record");
    exactKeys(object, ["blobId", "bytes"]);
    const blobId = validateStableId(field(object, "blobId"), "blobId");
    if (seen.has(blobId)) fail("duplicate-id", `export contains duplicate blob ${blobId}`);
    seen.add(blobId);
    objects.push({ blobId, bytes: decodeRuntimeBytes(field(object, "bytes")) });
  }
  objects.sort((left, right) => compareUtf8Ordinal(left.blobId, right.blobId));
  const decoded: ArtifactExport = { schema: ARTIFACT_EXPORT_SCHEMA, manifest, objects };
  // Exact closure is a decoding invariant: callers never receive an incomplete/overcomplete export.
  assertExactExportObjects(decoded);
  const manifestBlobs = new Map(manifest.blobs.map((blob) => [blob.blobId, blob]));
  for (const object of objects) {
    const manifestBlob = manifestBlobs.get(object.blobId);
    if (!manifestBlob) fail("invalid-closure", "export contains unexpected blob");
    verifyBytesAgainstDescriptor(object.bytes, manifestBlob);
  }
  return decoded;
}

export function serializeClosureManifest(manifest: ClosureManifest): string {
  const normalized = normalizeManifest(manifest);
  const expectedDigest = manifestPayloadSha256(normalized);
  if (expectedDigest !== normalized.manifestSha256) {
    fail("closure-mismatch", "manifest digest does not match its canonical content");
  }
  return JSON.stringify(canonicalManifestValue(normalized));
}

export function serializeArtifactExport(value: ArtifactExport): string {
  const decoded = decodeArtifactExport(value);
  const manifest = JSON.parse(serializeClosureManifest(decoded.manifest)) as Record<string, unknown>;
  const objects = [...decoded.objects]
    .sort((left, right) => compareUtf8Ordinal(left.blobId, right.blobId))
    .map((object) => ({ blobId: object.blobId, bytes: [...object.bytes] }));
  return JSON.stringify({ schema: ARTIFACT_EXPORT_SCHEMA, manifest, objects });
}

export function deserializeArtifactExport(serialized: string): ArtifactExport {
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_EXPORT_LENGTH) {
    fail("unsafe-input", "serialized artifact export is too large or not text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("unsafe-input", "serialized artifact export is not valid JSON");
  }
  return decodeArtifactExport(parsed);
}
