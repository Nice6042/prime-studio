import { toMillis } from "./rateLimits";
import type { Account, CodexSubscription, RateLimits } from "./types";

export type QuotaUnavailableReason =
  | "anthropic_not_reported"
  | "codex_snapshot_missing"
  | "codex_refresh_failed"
  | "provider_unsupported";

interface QuotaFactBase {
  readonly provider: string;
  readonly source: "anthropic_rate_limits" | "codex_cli_snapshot" | "unsupported";
}

export type AvailableQuotaFact = QuotaFactBase & Readonly<{
  scope: "account" | "provider";
  accountId?: string;
  availability: "available";
  percent: number;
  windowLabel?: string;
  windowMinutes?: number;
  resetsAt?: number;
  secondary?: Readonly<{ percent: number; windowMinutes: number; resetsAt?: number }>;
  planType?: string;
  observedAt: number;
  ambiguousAccountIds?: readonly string[];
}>;

export type UnavailableQuotaFact = QuotaFactBase & Readonly<{
  scope: "account" | "provider";
  accountId?: string;
  availability: "unavailable";
  reason: QuotaUnavailableReason;
  ambiguousAccountIds?: readonly string[];
}>;

export type QuotaFact = AvailableQuotaFact | UnavailableQuotaFact;

export interface SubscriptionQuotaProjection {
  readonly accountFacts: readonly QuotaFact[];
  readonly providerFacts: readonly QuotaFact[];
}

function unavailable(
  account: Account,
  reason: QuotaUnavailableReason,
): UnavailableQuotaFact {
  return {
    scope: "account",
    accountId: account.id,
    provider: account.provider,
    source: account.provider === "anthropic"
      ? "anthropic_rate_limits"
      : account.provider === "openai-codex"
        ? "codex_cli_snapshot"
        : "unsupported",
    availability: "unavailable",
    reason,
  };
}

function codexAvailable(
  snapshot: CodexSubscription,
  scope: "account" | "provider",
  accountId?: string,
  ambiguousAccountIds?: readonly string[],
): AvailableQuotaFact {
  const reset = toMillis(snapshot.resetsAt);
  const secondaryReset = snapshot.secondary ? toMillis(snapshot.secondary.resetsAt) : null;
  return {
    scope,
    ...(accountId ? { accountId } : {}),
    provider: "openai-codex",
    source: "codex_cli_snapshot",
    availability: "available",
    percent: snapshot.usedPercent,
    windowMinutes: snapshot.windowMinutes,
    ...(reset ? { resetsAt: reset } : {}),
    ...(snapshot.secondary ? {
      secondary: {
        percent: snapshot.secondary.usedPercent,
        windowMinutes: snapshot.secondary.windowMinutes,
        ...(secondaryReset ? { resetsAt: secondaryReset } : {}),
      },
    } : {}),
    ...(snapshot.planType ? { planType: snapshot.planType } : {}),
    observedAt: snapshot.staleAsOf,
    ...(ambiguousAccountIds ? { ambiguousAccountIds } : {}),
  };
}

function anthropicFact(account: Account, limits: RateLimits | undefined): QuotaFact {
  const utilization = limits?.utilization;
  if (utilization === undefined || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) {
    return unavailable(account, "anthropic_not_reported");
  }
  const windows = limits?.windows ?? {};
  const selected = (limits?.representativeWindow ? windows[limits.representativeWindow] : undefined)
    ?? Object.values(windows).find((window) => window?.resetsAt != null);
  const reset = toMillis(selected?.resetsAt);
  return {
    scope: "account",
    accountId: account.id,
    provider: account.provider,
    source: "anthropic_rate_limits",
    availability: "available",
    percent: utilization * 100,
    ...(limits?.representativeWindow ? { windowLabel: limits.representativeWindow } : {}),
    ...(reset ? { resetsAt: reset } : {}),
    observedAt: limits!.seenAt,
  };
}

export function projectSubscriptionQuota(
  accounts: readonly Account[],
  codex: CodexSubscription | null,
  anthropicByAccount: ReadonlyMap<string, RateLimits>,
  codexUnavailableReason: "codex_snapshot_missing" | "codex_refresh_failed" = "codex_snapshot_missing",
): SubscriptionQuotaProjection {
  const accountFacts: QuotaFact[] = [];
  const providerFacts: QuotaFact[] = [];
  const codexAccounts = accounts.filter((account) => account.provider === "openai-codex");

  for (const account of accounts) {
    if (account.provider === "anthropic") {
      accountFacts.push(anthropicFact(account, anthropicByAccount.get(account.id)));
    } else if (account.provider === "openai-codex" && codexAccounts.length === 1) {
      accountFacts.push(codex
        ? codexAvailable(codex, "account", account.id)
        : unavailable(account, codexUnavailableReason));
    } else if (account.provider !== "openai-codex") {
      accountFacts.push(unavailable(account, "provider_unsupported"));
    }
  }

  if (codexAccounts.length > 1) {
    const accountIds = codexAccounts.map((account) => account.id);
    providerFacts.push(codex
      ? codexAvailable(codex, "provider", undefined, accountIds)
      : {
          scope: "provider",
          provider: "openai-codex",
          source: "codex_cli_snapshot",
          availability: "unavailable",
          reason: codexUnavailableReason,
          ambiguousAccountIds: accountIds,
        });
  }

  return { accountFacts, providerFacts };
}
