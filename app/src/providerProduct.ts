import type { AuthMode, ProviderProfile } from "./providerAuth";
import type {
  CapabilityAvailability,
  ProviderDescriptor,
} from "./providers/contract";

export const PROVIDER_PRODUCT_SCHEMA_VERSION = 1 as const;

export const PROVIDER_PRODUCT_LIMITS = Object.freeze({
  maxProviders: 64,
  maxAccounts: 256,
  maxProviderIdUtf8Bytes: 56,
  maxProviderIdScalars: 56,
  maxAccountIdUtf8Bytes: 64,
  maxAccountIdScalars: 64,
  maxDisplayNameUtf8Bytes: 256,
  maxDisplayNameScalars: 128,
  maxTransportUtf8Bytes: 128 * 1024,
});

export const PROVIDER_PRODUCT_OPERATIONS = [
  "discover_providers",
  "discover_accounts",
  "account_login",
  "discover_models",
  "start",
  "resume",
  "send",
] as const;

export type ProviderProductOperation =
  (typeof PROVIDER_PRODUCT_OPERATIONS)[number];
export type ProviderProductAdmission =
  | "available"
  | "admission_only"
  | "unavailable";
export type ProviderProductUnavailableReason =
  | "native_authority_unavailable"
  | "native_authority_admission_only"
  | "native_implementation_unavailable";

export interface ProviderProductProviderSnapshot {
  readonly providerId: string;
  readonly displayName: string;
}

export interface ProviderProductAccountSnapshot {
  readonly accountId: string;
  readonly providerId: string;
  readonly displayName: string;
}

export interface ProviderProductCapabilitySnapshot {
  readonly operation: ProviderProductOperation;
  readonly admission: ProviderProductAdmission;
  readonly unavailableReason?: ProviderProductUnavailableReason;
}

export interface ProviderProductSnapshot {
  readonly schemaVersion: typeof PROVIDER_PRODUCT_SCHEMA_VERSION;
  readonly providers: readonly ProviderProductProviderSnapshot[];
  readonly accounts: readonly ProviderProductAccountSnapshot[];
  readonly capabilities: readonly ProviderProductCapabilitySnapshot[];
}

export interface ProviderProductCapabilityProjection {
  readonly operation: ProviderProductOperation;
  readonly admission: ProviderProductAdmission;
  readonly availability: CapabilityAvailability;
}

export interface ProviderProductProjection {
  readonly schemaVersion: typeof PROVIDER_PRODUCT_SCHEMA_VERSION;
  readonly providers: readonly ProviderDescriptor[];
  readonly profiles: readonly ProviderProfile[];
  readonly capabilities: readonly ProviderProductCapabilityProjection[];
}

export class ProviderProductSnapshotError extends Error {
  constructor() {
    super("Provider product snapshot unavailable.");
    this.name = "ProviderProductSnapshotError";
  }
}

function fail(_path?: string): never {
  throw new ProviderProductSnapshotError();
}

interface StringMetrics {
  readonly utf8Bytes: number;
  readonly scalars: number;
}

function boundedStringMetrics(
  value: unknown,
  maxUtf8Bytes: number,
  maxScalars: number,
): StringMetrics | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxUtf8Bytes ||
    value.length > maxScalars * 2
  ) {
    return null;
  }
  let utf8Bytes = 0;
  let scalars = 0;
  for (let index = 0; index < value.length; ) {
    const first = value.charCodeAt(index);
    let codePoint: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return null;
      codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      index += 2;
    } else {
      if (first >= 0xdc00 && first <= 0xdfff) return null;
      codePoint = first;
      index += 1;
    }
    scalars += 1;
    utf8Bytes +=
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (scalars > maxScalars || utf8Bytes > maxUtf8Bytes) return null;
  }
  return { utf8Bytes, scalars };
}

function decodeBoundedTransport(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    boundedStringMetrics(
      value,
      PROVIDER_PRODUCT_LIMITS.maxTransportUtf8Bytes,
      PROVIDER_PRODUCT_LIMITS.maxTransportUtf8Bytes,
    ) === null
  ) {
    return fail("transport");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail("transport");
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return fail(path);
  }
  return value as Record<string, unknown>;
}

// Lossless migration grammar: lowercase ASCII alphanumeric IDs with internal
// hyphens. The 56-byte provider ceiling leaves room for native `default-`
// account IDs inside the 64-byte account boundary.
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const ACCOUNT_ID_PATTERN = PROVIDER_ID_PATTERN;
const RESERVED_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

function providerId(value: unknown, path: string): string {
  if (
    boundedStringMetrics(
      value,
      PROVIDER_PRODUCT_LIMITS.maxProviderIdUtf8Bytes,
      PROVIDER_PRODUCT_LIMITS.maxProviderIdScalars,
    ) === null ||
    !PROVIDER_ID_PATTERN.test(value as string)
  ) {
    return fail(path);
  }
  return value as string;
}

function accountId(value: unknown, path: string): string {
  if (
    boundedStringMetrics(
      value,
      PROVIDER_PRODUCT_LIMITS.maxAccountIdUtf8Bytes,
      PROVIDER_PRODUCT_LIMITS.maxAccountIdScalars,
    ) === null ||
    !ACCOUNT_ID_PATTERN.test(value as string) ||
    RESERVED_ACCOUNT_IDS.has(value as string)
  ) {
    return fail(path);
  }
  return value as string;
}

function displayName(value: unknown, path: string): string {
  if (
    boundedStringMetrics(
      value,
      PROVIDER_PRODUCT_LIMITS.maxDisplayNameUtf8Bytes,
      PROVIDER_PRODUCT_LIMITS.maxDisplayNameScalars,
    ) === null ||
    (value as string).trim().length === 0 ||
    UNSAFE_DISPLAY_CHARACTER.test(value as string)
  ) {
    return fail(path);
  }
  return value as string;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path);
}

const NATIVE_UNIMPLEMENTED_OPERATIONS: ReadonlySet<ProviderProductOperation> = new Set([
  "account_login",
  "discover_models",
  "start",
  "resume",
  "send",
]);

const NATIVE_BUILTIN_PROVIDERS = [
  { providerId: "anthropic", displayName: "Claude" },
  { providerId: "openai-codex", displayName: "ChatGPT" },
] as const;

function decodeCapability(
  value: unknown,
  expectedOperation: ProviderProductOperation,
  index: number,
): ProviderProductCapabilitySnapshot {
  const basePath = `capabilities[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(basePath);
  }
  const candidate = value as Record<string, unknown>;
  const admission = candidate.admission;
  const keys =
    admission === "available"
      ? (["operation", "admission"] as const)
      : (["operation", "admission", "unavailableReason"] as const);
  const record = exactRecord(value, keys, basePath);
  if (record.operation !== expectedOperation) fail(`${basePath}.operation`);

  if (admission === "available") {
    if (NATIVE_UNIMPLEMENTED_OPERATIONS.has(expectedOperation)) {
      fail(`${basePath}.admission`);
    }
    return Object.freeze({ operation: expectedOperation, admission });
  }

  if (admission === "admission_only") {
    if (record.unavailableReason !== "native_authority_admission_only") {
      fail(`${basePath}.unavailableReason`);
    }
    return Object.freeze({
      operation: expectedOperation,
      admission,
      unavailableReason: "native_authority_admission_only",
    });
  }

  if (admission === "unavailable") {
    const unavailableReason = record.unavailableReason;
    if (
      unavailableReason !== "native_authority_unavailable" &&
      unavailableReason !== "native_implementation_unavailable"
    ) {
      fail(`${basePath}.unavailableReason`);
    }
    return Object.freeze({
      operation: expectedOperation,
      admission,
      unavailableReason,
    });
  }

  return fail(`${basePath}.admission`);
}

/** Decode the untrusted IPC value without filling any missing collection. */
export function decodeProviderProductSnapshot(
  value: unknown,
): ProviderProductSnapshot {
  // Only bounded JSON text crosses this decoder. Any later exact-key
  // enumeration is therefore bounded by `maxTransportUtf8Bytes`; arbitrary
  // objects, accessors, and Proxy traps are rejected without inspection.
  const decoded = decodeBoundedTransport(value);
  const record = exactRecord(
    decoded,
    ["schemaVersion", "providers", "accounts", "capabilities"],
    "root",
  );
  if (record.schemaVersion !== PROVIDER_PRODUCT_SCHEMA_VERSION) {
    fail("schemaVersion");
  }
  const rawProviders = record.providers;
  const rawAccounts = record.accounts;
  const rawCapabilities = record.capabilities;
  if (
    !Array.isArray(rawProviders) ||
    rawProviders.length === 0 ||
    rawProviders.length > PROVIDER_PRODUCT_LIMITS.maxProviders
  ) {
    fail("providers");
  }
  if (
    !Array.isArray(rawAccounts) ||
    rawAccounts.length > PROVIDER_PRODUCT_LIMITS.maxAccounts
  ) {
    fail("accounts");
  }
  if (
    !Array.isArray(rawCapabilities) ||
    rawCapabilities.length !== PROVIDER_PRODUCT_OPERATIONS.length
  ) {
    fail("capabilities");
  }

  const providers = rawProviders.map((value, index) => {
    const row = exactRecord(
      value,
      ["providerId", "displayName"],
      `providers[${index}]`,
    );
    return Object.freeze({
      providerId: providerId(row.providerId, `providers[${index}].providerId`),
      displayName: displayName(
        row.displayName,
        `providers[${index}].displayName`,
      ),
    });
  });
  unique(
    providers.map((provider) => provider.providerId),
    "providers",
  );
  for (const [index, expected] of NATIVE_BUILTIN_PROVIDERS.entries()) {
    const actual = providers[index];
    if (
      actual === undefined ||
      actual.providerId !== expected.providerId ||
      actual.displayName !== expected.displayName
    ) {
      fail(`providers[${index}]`);
    }
  }
  const extensionProviders = providers.slice(NATIVE_BUILTIN_PROVIDERS.length);
  for (let index = 0; index < extensionProviders.length; index += 1) {
    const provider = extensionProviders[index];
    const previous = extensionProviders[index - 1];
    if (
      provider.displayName !== provider.providerId ||
      (previous !== undefined && previous.providerId >= provider.providerId)
    ) {
      fail(`providers[${index + NATIVE_BUILTIN_PROVIDERS.length}]`);
    }
  }
  const providerIds = new Set(providers.map((provider) => provider.providerId));

  const accounts = rawAccounts.map((value, index) => {
    const row = exactRecord(
      value,
      ["accountId", "providerId", "displayName"],
      `accounts[${index}]`,
    );
    const decodedProviderId = providerId(
      row.providerId,
      `accounts[${index}].providerId`,
    );
    if (!providerIds.has(decodedProviderId)) fail(`accounts[${index}].providerId`);
    return Object.freeze({
      accountId: accountId(row.accountId, `accounts[${index}].accountId`),
      providerId: decodedProviderId,
      displayName: displayName(
        row.displayName,
        `accounts[${index}].displayName`,
      ),
    });
  });
  unique(
    accounts.map((account) => account.accountId),
    "accounts",
  );
  const backedExtensionProviderIds = new Set(
    accounts
      .map((account) => account.providerId)
      .filter(
        (providerId) =>
          !NATIVE_BUILTIN_PROVIDERS.some(
            (provider) => provider.providerId === providerId,
          ),
      ),
  );
  if (
    backedExtensionProviderIds.size !== extensionProviders.length ||
    extensionProviders.some(
      (provider) => !backedExtensionProviderIds.has(provider.providerId),
    )
  ) {
    fail("providers");
  }

  const capabilities = PROVIDER_PRODUCT_OPERATIONS.map((operation, index) =>
    decodeCapability(rawCapabilities[index], operation, index),
  );
  if (
    capabilities[0].admission !== "available" ||
    capabilities[1].admission !== "available"
  ) {
    fail("capabilities");
  }

  return Object.freeze({
    schemaVersion: PROVIDER_PRODUCT_SCHEMA_VERSION,
    providers: Object.freeze(providers),
    accounts: Object.freeze(accounts),
    capabilities: Object.freeze(capabilities),
  });
}

function capabilityAvailability(
  capability: ProviderProductCapabilitySnapshot,
): CapabilityAvailability {
  if (capability.admission === "available") {
    return Object.freeze({ state: "available" });
  }
  if (capability.admission === "admission_only") {
    return Object.freeze({
      state: "unavailable",
      reason: "disabled_by_policy",
      message: "Native authority is admission-only.",
    });
  }
  if (capability.unavailableReason === "native_implementation_unavailable") {
    return Object.freeze({
      state: "unavailable",
      reason: "not_implemented",
      message: "Native implementation is unavailable.",
    });
  }
  return Object.freeze({
    state: "unavailable",
    reason: "disabled_by_policy",
    message: "Native authority is unavailable.",
  });
}

/** Project native truth into the existing pure provider/auth domain shapes. */
export function projectProviderProductSnapshot(
  snapshot: ProviderProductSnapshot,
): ProviderProductProjection {
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    providers: Object.freeze(
      snapshot.providers.map((provider) =>
        Object.freeze({
          providerId: provider.providerId,
          displayName: provider.displayName,
        }),
      ),
    ),
    profiles: Object.freeze(
      snapshot.accounts.map((account) =>
        Object.freeze({
          profileId: account.accountId,
          providerId: account.providerId,
          label: account.displayName,
          authMode: "unavailable" satisfies AuthMode,
        }),
      ),
    ),
    capabilities: Object.freeze(
      snapshot.capabilities.map((capability) =>
        Object.freeze({
          operation: capability.operation,
          admission: capability.admission,
          availability: capabilityAvailability(capability),
        }),
      ),
    ),
  });
}
