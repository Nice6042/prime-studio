import { createControlBinding } from "../../contracts/studioOperations";
import type { CurrentChatUsage } from "../../shared/ipc/harness.generated";
import { compactTokenCount, contextPercent, type HarnessPanelDetails } from "./adapter";

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="usage-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function formatElapsed(startedAtMs: number | null, observedAtMs: number | undefined): string {
  if (startedAtMs === null || observedAtMs === undefined || !Number.isFinite(startedAtMs) || !Number.isFinite(observedAtMs) || observedAtMs < startedAtMs) return "Elapsed unavailable";
  const seconds = Math.floor((observedAtMs - startedAtMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function points(values: readonly number[], width: number, height: number, maximum: number): string {
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height - value / maximum * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function validTurnUsage(details: HarnessPanelDetails | null) {
  const rows = details?.turnUsage;
  if (!rows?.length || rows.length > 1_000) return null;
  let previous = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.turn) || row.turn <= previous || !Number.isSafeInteger(row.input) || row.input < 0 || !Number.isSafeInteger(row.output) || row.output < 0 || !Number.isSafeInteger(row.totalTokens) || row.totalTokens < 0 || row.totalTokens !== row.input + row.output) return null;
    previous = row.turn;
  }
  return rows;
}

function contextRatios(details: HarnessPanelDetails | null): readonly number[] | null {
  const context = details?.context;
  const samples = context?.samples;
  if (!context || !samples?.length || samples.length > 1_000 || !samples.every((sample) => Number.isFinite(sample) && sample >= 0)) return null;
  if (samples.every((sample) => sample <= 1)) return samples;
  if (!Number.isFinite(context.capacityTokens) || context.capacityTokens <= 0 || !samples.every((sample) => Number.isSafeInteger(sample) && sample <= context.capacityTokens)) return null;
  return samples.map((sample) => sample / context.capacityTokens);
}

function UsageCharts({ details }: { readonly details: HarnessPanelDetails | null }) {
  const turns = validTurnUsage(details);
  const contextSamples = contextRatios(details);
  const turnMaximum = turns ? Math.max(1, ...turns.map((row) => row.totalTokens)) : 1;
  return <div className="usage-history">
    <section className="usage-chart-card" aria-labelledby="usage-turn-history-title">
      <div className="usage-chart-heading"><h2 id="usage-turn-history-title">Tokens by turn</h2><span>{turns ? `${turns.length} turns` : "Unavailable"}</span></div>
      {turns ? <>
        <svg className="usage-line-chart" role="img" aria-label="Tokens by turn" viewBox="0 0 300 84" preserveAspectRatio="none"><polyline points={points(turns.map((row) => row.totalTokens), 300, 72, turnMaximum)} /></svg>
        <div className="usage-table-scroll"><table className="usage-turn-table" aria-label="Tokens by turn data"><thead><tr><th>Turn</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>{turns.map((row) => <tr key={row.turn}><th scope="row">{row.turn}</th><td>{row.input.toLocaleString()}</td><td>{row.output.toLocaleString()}</td><td>{row.totalTokens.toLocaleString()}</td></tr>)}</tbody></table></div>
      </> : <p className="usage-unavailable">Per-turn token history is unavailable.</p>}
    </section>
    <section className="usage-chart-card" aria-labelledby="usage-context-history-title">
      <div className="usage-chart-heading"><h2 id="usage-context-history-title">Context history</h2><span>{contextSamples ? `${Math.round(contextSamples[contextSamples.length - 1]! * 100)}% latest` : "Unavailable"}</span></div>
      {contextSamples ? <svg className="usage-sparkline" role="img" aria-label="Context utilization history" viewBox="0 0 300 54" preserveAspectRatio="none"><polyline points={points(contextSamples, 300, 48, 1)} /></svg> : <p className="usage-unavailable">Context history is unavailable.</p>}
    </section>
  </div>;
}

export function ChatUsage({ usage, details, onRefresh, refreshing, onOpenAccountUsage }: {
  readonly usage: CurrentChatUsage;
  readonly details: HarnessPanelDetails | null;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly onOpenAccountUsage?: () => void;
}) {
  const categories = [["Input", usage.input], ["Output", usage.output], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheWrite]] as const;
  const categoryTotal = categories.reduce((sum, [, value]) => sum + value, 0);
  const percent = contextPercent(details?.context ?? null);
  const contributions = details?.contributions ?? [];
  const contributionTotal = contributions.reduce((sum, item) => sum + item.tokens, 0);
  const refresh = createControlBinding("usage.current.refresh", "usage.current.refresh");
  const account = createControlBinding("usage.account.open", "usage.account.open");
  return <div className="chat-usage">
    <div className="usage-toolbar"><div><span>Scope</span><strong>Current chat</strong></div><button type="button" data-control-id={refresh.controlId} onClick={onRefresh} disabled={refreshing} aria-label="Refresh current-chat usage">{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    <section className="usage-context"><div><span>Context window</span><span>{percent === null ? "Unavailable" : `${percent}%`}</span></div><strong>{details?.context ? `${compactTokenCount(details.context.usedTokens)} / ${compactTokenCount(details.context.capacityTokens)}` : "Denominator unavailable"}</strong>{percent === null ? <p>Current utilization is unavailable.</p> : <span className="harness-progress" aria-hidden="true"><i style={{ inlineSize: `${percent}%` }} /></span>}</section>
    <div className="usage-metrics"><Metric label="Chat tokens" value={usage.totalTokens.toLocaleString()} /><Metric label="Turns" value={String(details?.context?.turns ?? "—")} /><Metric label="Elapsed" value={formatElapsed(details?.startedAtMs ?? null, details?.observedAtMs)} /><Metric label="Cost" value={usage.cost === null ? "Cost unavailable" : `$${usage.cost.toFixed(4)}`} /></div>
    <UsageCharts details={details} />
    <section className="usage-breakdown" aria-labelledby="contribution-title"><div className="usage-table-heading"><h2 id="contribution-title">Contribution breakdown</h2><span>Share</span><span>Tokens</span></div>{contributions.length ? contributions.map((item) => { const share = contributionTotal ? Math.round(item.tokens / contributionTotal * 100) : 0; return <div className="usage-breakdown-row" key={item.id}><div><span>{item.label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{item.tokens.toLocaleString()}</strong></div>; }) : <p className="harness-empty">Parent and child attribution is unavailable. Totals are not guessed.</p>}</section>
    <section className="usage-breakdown" aria-labelledby="token-breakdown-title"><div className="usage-table-heading"><h2 id="token-breakdown-title">Token types</h2><span>Share</span><span>Tokens</span></div>{categories.map(([label, value]) => { const share = categoryTotal ? Math.round(value / categoryTotal * 100) : 0; return <div className="usage-breakdown-row" key={label}><div><span>{label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{value.toLocaleString()}</strong></div>; })}</section>
    <p className="usage-note">Subagent usage is included only when it belongs to this chat.</p>
    <button className="usage-account-link" type="button" data-control-id={account.controlId} disabled={!onOpenAccountUsage} title={onOpenAccountUsage ? undefined : "Account usage navigation is unavailable in this host."} onClick={onOpenAccountUsage}>Open account-wide usage in Settings → Usage</button>
  </div>;
}
