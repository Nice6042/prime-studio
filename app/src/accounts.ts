// Account presentation helpers shared by the top bar, the tab strip and the
// accounts panel. No secrets pass through here — an account only ever carries
// its id/label/provider/dir plus a derived auth state.
import type { Account, AccountStatus, AuthHealth, UsageBucket } from "./types";

export const PROVIDER_NAME: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "ChatGPT",
};

export const PROVIDERS = ["anthropic", "openai-codex"];

/**
 * Auth health comes from the backend (`account_status.health`) — this module only
 * formats it. The fallback covers a backend that predates the field; it must not
 * turn a signed-in account into a scary one.
 */
export const health = (status?: AccountStatus | null): AuthHealth =>
  status?.health ?? (status?.authed ? "signedIn" : "signedOut");

const HEALTH_LABEL: Record<AuthHealth, string> = {
  signedIn: "Signed in",
  expiringSoon: "Expires soon",
  expired: "Needs re-login",
  signedOut: "Not signed in",
};

/** Pill modifier class — `expiringSoon` and `expired` share the warning colour. */
export const HEALTH_PILL: Record<AuthHealth, string> = {
  signedIn: "authed",
  expiringSoon: "expiring",
  expired: "expired",
  signedOut: "unauthed",
};

/** "Signed in" / "Expires in 2d" / "Needs re-login". */
export function healthLabel(status?: AccountStatus | null): string {
  const h = health(status);
  if (h !== "expiringSoon") return HEALTH_LABEL[h];
  const ms = status?.expiresInMs ?? 0;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expires in ${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `Expires in ${hours}h` : "Expires in under an hour";
}

export const accountLabel = (accounts: Account[], id: string | null): string =>
  accounts.find((a) => a.id === id)?.label ?? "Default";

export const accountProvider = (accounts: Account[], id: string | null): string =>
  accounts.find((a) => a.id === id)?.provider ?? "";

/**
 * Local midnight as epoch millis. The Rust side has no timezone (std doesn't
 * expose one), so the UI owns the day boundary and passes it as `since`.
 */
export const localMidnight = (): number => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

export const money = (n: number): string =>
  `$${(n || 0).toFixed(n > 0 && n < 1 ? 4 : 2)}`;

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago". Date arithmetic, not fixed millis, so DST can't skew it. */
export function ago(ms: number): string {
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
  ];
  let value = Math.round((ms - Date.now()) / 1000);
  for (const [unit, span] of steps) {
    if (Math.abs(value) < span) return relFmt.format(value, unit);
    value = Math.round(value / span);
  }
  return relFmt.format(value, "year");
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export const tokenSummary = (b?: UsageBucket): string => {
  const t = b?.tokens;
  if (!t) return "—";
  return `${compact.format(t.input)} in · ${compact.format(t.output)} out · ${compact.format(
    t.cacheRead + t.cacheWrite,
  )} cache`;
};

export const EMPTY_BUCKET: UsageBucket = {
  cost: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  sessions: 0,
};

export function sumBuckets(list: (UsageBucket | undefined)[]): UsageBucket {
  const out: UsageBucket = {
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessions: 0,
  };
  for (const b of list) {
    if (!b) continue;
    out.cost += b.cost;
    out.sessions += b.sessions;
    out.tokens.input += b.tokens.input;
    out.tokens.output += b.tokens.output;
    out.tokens.cacheRead += b.tokens.cacheRead;
    out.tokens.cacheWrite += b.tokens.cacheWrite;
  }
  return out;
}
