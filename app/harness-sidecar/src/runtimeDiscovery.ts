import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseClosedJson } from "./framing.js";
import { profileForPackageIdentity, type PrimeDaemonProfile } from "./profiles/index.js";

const MANIFEST_MAX_BYTES = 256 * 1024;
const ENTRYPOINT_MAX_BYTES = 16 * 1024 * 1024;
const EXPECTED_PACKAGE = "prime-agent";
const KNOWN_CAPABILITIES = new Set([
  "attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog",
  "extension_ui", "chunked_snapshot", "prompt_admission_cancellation", "queue_management",
  "resource_snapshot", "delete_child", "heartbeat_catalog", "heartbeat_management",
  "side_question_transcript", "transient_bash",
]);

export interface RuntimeIdentity {
  packageName: "prime-agent";
  packageVersion: string;
  packageDigest: string;
  entrypointDigest: string;
  protocolName: string;
  protocolVersion: number;
  schemaRevision: number;
  schemaId: string;
  capabilities: string[];
}

export interface RuntimeIdentityProfile {
  readonly packageName: "prime-agent";
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly entrypointDigest: string;
  readonly protocolName: string;
  readonly protocolVersion: number;
  readonly schemaRevision: number;
  readonly schemaId: string;
  readonly supportedCapabilities: readonly string[];
}

export type RuntimeDiscoveryErrorCode =
  | "runtime_path_untrusted"
  | "runtime_metadata_too_large"
  | "runtime_identity_mismatch"
  | "unsupported_runtime";

export class RuntimeDiscoveryError extends Error {
  readonly code: RuntimeDiscoveryErrorCode;
  constructor(code: RuntimeDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "RuntimeDiscoveryError";
    this.code = code;
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readRegularBounded(path: string, maxBytes: number, tooLargeCode: RuntimeDiscoveryErrorCode): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => { throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime file is missing"); });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime file is not regular");
  if (metadata.size > maxBytes) throw new RuntimeDiscoveryError(tooLargeCode, "runtime file exceeds its bound");
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new RuntimeDiscoveryError(tooLargeCode, "runtime file exceeds its bound");
  return bytes;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RuntimeDiscoveryError("unsupported_runtime", `${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function dataProperty(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
    throw new RuntimeDiscoveryError("unsupported_runtime", `${key} must be a data export`);
  }
  return descriptor.value;
}

function rootImportExport(value: unknown): string {
  if (typeof value === "string") return value;
  const descriptor = record(value, "package root export");
  return boundedString(dataProperty(descriptor, "import"), "package import export", 512);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new RuntimeDiscoveryError("unsupported_runtime", `${label} is invalid`);
  }
  return value;
}

function within(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function selectedProfile(
  packageVersion: string,
  packageDigest: string,
  entrypointDigest: string,
  expected: RuntimeIdentityProfile | undefined,
): RuntimeIdentityProfile {
  const observed = { packageName: EXPECTED_PACKAGE, packageVersion, packageDigest, entrypointDigest } as const;
  const profile = expected ?? profileForPackageIdentity(observed);
  if (!profile
    || packageVersion !== profile.packageVersion
    || packageDigest !== profile.packageDigest
    || entrypointDigest !== profile.entrypointDigest) {
    throw new RuntimeDiscoveryError("runtime_identity_mismatch", "runtime bytes do not match a reviewed profile");
  }
  return profile;
}

export async function discoverRuntime(
  packageRoot: string,
  expected?: RuntimeIdentityProfile | PrimeDaemonProfile,
): Promise<RuntimeIdentity> {
  if (!isAbsolute(packageRoot)) throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime root must be absolute");
  const rootMetadata = await lstat(packageRoot).catch(() => { throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime root is missing"); });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime root must be a direct directory");
  }
  const canonicalRoot = await realpath(packageRoot);
  if (canonicalRoot !== resolve(packageRoot)) throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime root identity changed");

  const manifestPath = resolve(canonicalRoot, "package.json");
  const manifestBytes = await readRegularBounded(manifestPath, MANIFEST_MAX_BYTES, "runtime_metadata_too_large");
  const manifest = record(parseClosedJson(manifestBytes.toString("utf8")), "package manifest");
  if (manifest.name !== EXPECTED_PACKAGE) throw new RuntimeDiscoveryError("runtime_identity_mismatch", "runtime package name does not match");
  const packageVersion = boundedString(manifest.version, "package version", 64);
  const exportsRecord = record(manifest.exports, "package exports");
  const relativeEntrypoint = rootImportExport(dataProperty(exportsRecord, "."));
  if (isAbsolute(relativeEntrypoint)) {
    throw new RuntimeDiscoveryError("runtime_path_untrusted", "package root export is invalid");
  }
  const entrypointPath = resolve(canonicalRoot, relativeEntrypoint);
  const canonicalEntrypoint = await realpath(entrypointPath).catch(() => { throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime entrypoint is missing"); });
  if (!within(canonicalRoot, canonicalEntrypoint)) throw new RuntimeDiscoveryError("runtime_path_untrusted", "runtime entrypoint escaped package root");
  const entrypointBytes = await readRegularBounded(canonicalEntrypoint, ENTRYPOINT_MAX_BYTES, "unsupported_runtime");
  const entrypointDigest = digest(entrypointBytes);
  const packageDigest = digest(manifestBytes);
  const profile = selectedProfile(packageVersion, packageDigest, entrypointDigest, expected);

  const capabilities = [...profile.supportedCapabilities].sort();
  if (capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability))) {
    throw new RuntimeDiscoveryError("unsupported_runtime", "runtime reports an unknown capability");
  }

  return {
    packageName: EXPECTED_PACKAGE,
    packageVersion,
    packageDigest,
    entrypointDigest,
    protocolName: profile.protocolName,
    protocolVersion: profile.protocolVersion,
    schemaRevision: profile.schemaRevision,
    schemaId: profile.schemaId,
    capabilities,
  };
}
