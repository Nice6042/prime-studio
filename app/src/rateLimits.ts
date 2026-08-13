// Anthropic subscription utilization, which exists ONLY as the `rate_limits` RPC
// event a patched prime-agent emits. Stock prime never sends it and no other
// source exists, so this store is empty until one arrives — and an empty store
// must render as "not reported by this prime build", never as 0%.
//
// Session-scoped on purpose: the event is not persisted anywhere, so a figure
// from a previous run would be a number with no known age.
import type { RateLimits } from "./types";

/** Keyed by account id. */
const seen = new Map<string, RateLimits>();
const listeners = new Set<() => void>();

/** epoch seconds, epoch millis or an ISO string — the shape is unverified. */
export function toMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e12) return v;
    if (v > 1e9) return v * 1000;
    return null;
  }
  if (typeof v === "string") {
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Record a `rate_limits` event. Parsed defensively: only `utilization` and
 * `representativeWindow` are verified, so anything else is best-effort and
 * absence is rendered as absence.
 */
export function note(accountId: string | null, event: Record<string, unknown>): void {
  // The transient first tab has no account yet; a figure we cannot attribute is
  // worse than none.
  if (!accountId) return;
  const body = (event.rateLimits ?? event) as Record<string, unknown>;
  const utilization = num(body.utilization);
  if (utilization === undefined) return;
  seen.set(accountId, {
    utilization,
    representativeWindow:
      typeof body.representativeWindow === "string" ? body.representativeWindow : undefined,
    windows: (body.windows ?? undefined) as RateLimits["windows"],
    seenAt: Date.now(),
  });
  for (const listener of listeners) listener();
}

/**
 * ponytail: no subscription — the only reader is the accounts pane, which already
 * re-renders every 2s off its auth poll. Add one if a passive surface ever needs it.
 */
export const rateLimitsFor = (accountId: string): RateLimits | undefined => seen.get(accountId);

/** Detached session-transient evidence for passive account-wide surfaces. */
export const rateLimitsSnapshot = (): ReadonlyMap<string, RateLimits> => new Map(seen);

export function subscribeRateLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
