import { PROVIDER_NAME } from "../accounts";
import { visualizeUntrustedText } from "../accounts/delete";
import type { QuotaFact, SubscriptionQuotaProjection } from "../quotaProjection";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Bar({ percent }: { readonly percent: number }) {
  const bounded = Math.max(0, Math.min(100, percent));
  return <div className="meter-bar" aria-hidden="true"><div className={`meter-fill ${bounded > 80 ? "hot" : ""}`} style={{ width: `${bounded}%` }} /></div>;
}

function windowName(minutes: number | undefined): string {
  if (!minutes) return "Primary window";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}-week window`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function resetText(resetsAt: number | undefined): string {
  return resetsAt ? ` · resets ${dateFmt.format(new Date(resetsAt))}` : "";
}

function unavailableText(fact: Extract<QuotaFact, { availability: "unavailable" }>): string {
  switch (fact.reason) {
    case "anthropic_not_reported": return "Subscription quota is not reported by this prime build. An attributable patched rate_limits event is required.";
    case "codex_snapshot_missing": return "Subscription quota is unavailable: no Codex CLI snapshot exists on this machine. Run the Codex CLI to produce one.";
    case "codex_refresh_failed": return "Subscription quota could not be refreshed from the Codex CLI logs; no zero value has been invented.";
    case "provider_unsupported": return "Subscription quota is unavailable: no quota reported by provider.";
  }
}

export function QuotaFactView({ fact, label }: { readonly fact: QuotaFact; readonly label?: string }) {
  const safeLabel = label ? visualizeUntrustedText(label) : undefined;
  const safePlanType = fact.availability === "available" && fact.planType ? visualizeUntrustedText(fact.planType) : undefined;
  const title = fact.source === "codex_cli_snapshot"
    ? `Codex CLI snapshot${safePlanType ? ` · ${safePlanType}` : ""}`
    : safeLabel ?? PROVIDER_NAME[fact.provider] ?? fact.provider;
  if (fact.availability === "unavailable") {
    return <div className="sub-card acct-quota" role="note" aria-label={`${safeLabel ?? PROVIDER_NAME[fact.provider] ?? fact.provider} subscription quota unavailable`} tabIndex={0}>
      <div className="sub-title">{title}</div>
      <p className="muted small">{unavailableText(fact)}</p>
      {fact.scope === "provider" && fact.ambiguousAccountIds && <p className="muted small">This machine-level source cannot be attached to any one account.</p>}
    </div>;
  }
  return <div className="sub-card acct-quota">
    <div className="sub-title">{title}</div>
    <div className="sub-meter-head"><span className="small">{fact.windowLabel ? `Plan used · ${fact.windowLabel}` : windowName(fact.windowMinutes)}{resetText(fact.resetsAt)}</span><strong>{fact.percent.toFixed(1)}%</strong></div>
    <Bar percent={fact.percent} />
    {fact.secondary && <>
      <div className="sub-meter-head"><span className="small">{windowName(fact.secondary.windowMinutes)}{resetText(fact.secondary.resetsAt)}</span><strong>{fact.secondary.percent.toFixed(1)}%</strong></div>
      <Bar percent={fact.secondary.percent} />
    </>}
    <p className="muted small">
      {fact.source === "codex_cli_snapshot"
        ? <>As of {dateFmt.format(new Date(fact.observedAt))}. This stale snapshot comes from Codex CLI session logs and changes only when that CLI runs.</>
        : <>Observed {dateFmt.format(new Date(fact.observedAt))} from an attributable patched Prime <code>rate_limits</code> event.</>}
    </p>
    {fact.scope === "provider" && fact.ambiguousAccountIds && <p className="muted small">Prime Studio cannot tell which account this machine-level Codex snapshot belongs to, so it is attached to neither account row.</p>}
  </div>;
}

export function SubscriptionQuota({ projection, accountLabels }: {
  readonly projection: SubscriptionQuotaProjection;
  readonly accountLabels: ReadonlyMap<string, string>;
}) {
  const facts = [...projection.accountFacts, ...projection.providerFacts];
  return <div className="sub-cards">
    {facts.map((fact, index) => <QuotaFactView key={`${fact.scope}:${fact.accountId ?? fact.provider}:${index}`} fact={fact} label={fact.accountId ? accountLabels.get(fact.accountId) : undefined} />)}
  </div>;
}
