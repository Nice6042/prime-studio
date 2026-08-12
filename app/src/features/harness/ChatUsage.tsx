import type { CurrentChatUsage } from "../../shared/ipc/harness.generated";
import { compactTokenCount, contextPercent, type HarnessPanelDetails } from "./adapter";

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="usage-metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function ChatUsage({ usage, details, onRefresh, refreshing, onOpenAccountUsage }: {
  readonly usage: CurrentChatUsage;
  readonly details: HarnessPanelDetails | null;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly onOpenAccountUsage?: () => void;
}) {
  const categories = [
    ["Input", usage.input], ["Output", usage.output], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheWrite],
  ] as const;
  const categoryTotal = categories.reduce((sum, [, value]) => sum + value, 0);
  const percent = contextPercent(details?.context ?? null);
  const contributions = details?.contributions ?? [];
  const contributionTotal = contributions.reduce((sum, item) => sum + item.tokens, 0);
  return <div className="chat-usage">
    <div className="usage-toolbar"><div><span>Scope</span><strong>Current chat</strong></div><button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh current-chat usage">{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    <section className="usage-context"><div><span>Context window</span><span>{percent === null ? "Unavailable" : `${percent}%`}</span></div><strong>{details?.context ? `${compactTokenCount(details.context.usedTokens)} / ${compactTokenCount(details.context.capacityTokens)}` : "Denominator unavailable"}</strong><span className="harness-progress" aria-hidden="true"><i style={{ inlineSize: `${percent ?? 0}%` }} /></span></section>
    <div className="usage-metrics">
      <Metric label="Chat tokens" value={usage.totalTokens.toLocaleString()} />
      <Metric label="Turns" value={String(details?.context?.turns ?? "—")} />
      <Metric label="Output" value={usage.output.toLocaleString()} />
      <Metric label="Cost" value={usage.cost === null ? "Cost unavailable" : `$${usage.cost.toFixed(4)}`} />
    </div>
    <section className="usage-breakdown" aria-labelledby="contribution-title"><div className="usage-table-heading"><h2 id="contribution-title">Contribution breakdown</h2><span>Share</span><span>Tokens</span></div>{contributions.length ? contributions.map((item) => { const share = contributionTotal ? Math.round(item.tokens / contributionTotal * 100) : 0; return <div className="usage-breakdown-row" key={item.id}><div><span>{item.label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{item.tokens.toLocaleString()}</strong></div>; }) : <p className="harness-empty">Parent and child attribution is unavailable. Totals are not guessed.</p>}</section>
    <section className="usage-breakdown" aria-labelledby="token-breakdown-title"><div className="usage-table-heading"><h2 id="token-breakdown-title">Token types</h2><span>Share</span><span>Tokens</span></div>{categories.map(([label, value]) => { const share = categoryTotal ? Math.round(value / categoryTotal * 100) : 0; return <div className="usage-breakdown-row" key={label}><div><span>{label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{value.toLocaleString()}</strong></div>; })}</section>
    <p className="usage-note">Subagent usage is included only when it belongs to this chat.</p>
    <button className="usage-account-link" type="button" disabled={!onOpenAccountUsage} onClick={onOpenAccountUsage}>Open account-wide usage in Settings → Usage</button>
  </div>;
}
