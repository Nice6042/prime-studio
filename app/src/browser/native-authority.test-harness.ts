import { hmacSha256Digest } from "./digest";
import {
  createNativeBrowserAuthority,
  type AuthenticatedNativeBrowserEvidence,
  type BrowserAuthorityLedgerEntry,
  type NativeBrowserAuthority,
  type NativeBrowserEvidenceAuthenticator,
  type NativeBrowserEvidenceKind,
} from "./native-authority.test-support";
import {
  canonicalBrowserJson,
  decodeBrowserTransport,
  type BrowserJsonValue,
} from "./transport";

export interface BrowserAuthorityTestHarness {
  readonly authority: NativeBrowserAuthority;
  mint(kind: NativeBrowserEvidenceKind, payload: unknown, observedAtMs: number): string;
  verifyLedger(entries?: readonly BrowserAuthorityLedgerEntry[]): boolean;
}

export interface BrowserAuthorityTestHarnessOptions {
  readonly beforeAuthenticate?: (rawEnvelope: string) => void;
  readonly beforeChain?: (previousTag: string, canonicalEntry: string) => void;
  readonly authenticatedResult?: (evidence: AuthenticatedNativeBrowserEvidence) => unknown;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Explicit test-only native bridge substitute. Never exported from `browser/index.ts`. */
export function createBrowserAuthorityTestHarness(
  secret: string,
  options: BrowserAuthorityTestHarnessOptions = {},
): BrowserAuthorityTestHarness {
  let counter = 0;
  const authenticator: NativeBrowserEvidenceAuthenticator = {
    authenticate(rawEnvelope, expectedKind): string | null {
      options.beforeAuthenticate?.(rawEnvelope);
      const decoded = decodeBrowserTransport(rawEnvelope);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
      const record = decoded as Record<string, BrowserJsonValue>;
      const keys = Object.keys(record).sort();
      if (keys.join(",") !== "evidenceId,kind,observedAtMs,payload,tag") return null;
      if (
        record.kind !== expectedKind ||
        typeof record.evidenceId !== "string" ||
        typeof record.observedAtMs !== "number" ||
        typeof record.tag !== "string"
      ) return null;
      const authenticated = {
        kind: record.kind,
        evidenceId: record.evidenceId,
        observedAtMs: record.observedAtMs,
        payload: record.payload!,
      } as const;
      const expectedTag = hmacSha256Digest(secret, canonicalBrowserJson(authenticated));
      if (!constantTimeEqual(record.tag, expectedTag)) return null;
      return (options.authenticatedResult?.(authenticated) ?? canonicalBrowserJson(authenticated)) as string;
    },
    chain(previousTag, canonicalEntry): string {
      options.beforeChain?.(previousTag, canonicalEntry);
      return hmacSha256Digest(secret, `${previousTag}\n${canonicalEntry}`);
    },
  };
  const authority = createNativeBrowserAuthority(authenticator);
  return Object.freeze({
    authority,
    mint(kind: NativeBrowserEvidenceKind, payload: unknown, observedAtMs: number): string {
      const boundedPayload = decodeBrowserTransport(JSON.stringify(payload));
      if (boundedPayload === null) throw new Error("test payload exceeds browser transport budget");
      counter += 1;
      const authenticated = {
        kind,
        evidenceId: `native_${String(counter).padStart(6, "0")}_0123456789abcdef0123456789abcdef`,
        observedAtMs,
        payload: boundedPayload,
      } as const;
      return JSON.stringify({
        ...authenticated,
        tag: hmacSha256Digest(secret, canonicalBrowserJson(authenticated)),
      });
    },
    verifyLedger(entries = authority.snapshot().ledger): boolean {
      let previousTag = `sha256:${"0".repeat(64)}`;
      for (const entry of entries) {
        const { tag, ...unsigned } = entry;
        const expected = hmacSha256Digest(secret, `${previousTag}\n${canonicalBrowserJson(unsigned as unknown as BrowserJsonValue)}`);
        if (!constantTimeEqual(tag, expected)) return false;
        previousTag = tag;
      }
      return true;
    },
  });
}
