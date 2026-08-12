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
  const series = details?.turnUsage;
  if (!series || !Number.isSafeInteger(series.totalTurns) || series.totalTurns < 0 || !Number.isSafeInteger(series.omittedTurns) || series.omittedTurns < 0 || series.rows.length > 300 || series.totalTurns !== series.omittedTurns + series.rows.length) return null;
  let previousOccurredAtMs = 0;
  for (const [index, row] of series.rows.entries()) {
    const categories = [row.input, row.output, row.cacheRead, row.cacheWrite];
    if (row.turn !== series.omittedTurns + index + 1 || !Number.isSafeInteger(row.occurredAtMs) || row.occurredAtMs < previousOccurredAtMs || categories.some((value) => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(row.totalTokens) || row.totalTokens < 0 || row.totalTokens !== categories.reduce((sum, value) => sum + value, 0)) return null;
    previousOccurredAtMs = row.occurredAtMs;
  }
  return series;
}

function contextRatios(details: HarnessPanelDetails | null): readonly number[] | null {
  const context = details?.context;
  const samples = context?.samples;
  if (!context || !samples?.length || samples.length > 1_000 || !samples.every((sample) => Number.isFinite(sample) && sample >= 0)) return null;
  if (samples.every((sample) => sample <= 1)) return samples;
  if (!Number.isFinite(context.capacityTokens) || context.capacityTokens <= 0 || !samples.every((sample) => Number.isSafeInteger(sample) && sample <= context.capacityTokens)) return null;
  return samples.map((sample) => sample / context.capacityTokens);
}

function reconciledContributions(details: HarnessPanelDetails | null, totalTokens: number) {
  const partition = details?.contributionPartition;
  if (!partition || partition.unit !== "current_chat_tokens" || partition.totalTokens !== totalTokens || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return null;
  const contributions = partition.contributions;
  if (!contributions.length || !Number.isSafeInteger(partition.totalTokens) || partition.totalTokens < 0) return null;
  const ids = new Set<string>();
  let total = 0;
  for (const contribution of contributions) {
    if (!contribution.id || ids.has(contribution.id) || !Number.isSafeInteger(contribution.tokens) || contribution.tokens < 0) return null;
    ids.add(contribution.id);
    total += contribution.tokens;
    if (!Number.isSafeInteger(total) || total > partition.totalTokens) return null;
  }
  return total === partition.totalTokens ? contributions : null;
}

function UsageCharts({ details }: { readonly details: HarnessPanelDetails | null }) {
  const turns = validTurnUsage(details);
  const contextSamples = contextRatios(details);
  const plottedTurns = turns?.rows.slice(-24) ?? [];
  const turnMaximum = Math.max(1, ...plottedTurns.flatMap((row) => [row.input, row.output, row.cacheRead, row.cacheWrite]));
  const chartBars = plottedTurns.flatMap((row, index) => {
    const groupWidth = 300 / plottedTurns.length;
    const barWidth = Math.max(1, Math.min(8, (groupWidth - 2) / 4));
    const groupStart = index * groupWidth + (groupWidth - barWidth * 4) / 2;
    return (["input", "output", "cacheRead", "cacheWrite"] as const).map((category, categoryIndex) => {
      const height = row[category] / turnMaximum * 68;
      return <rect key={`${row.turn}-${category}`} className={`usage-turn-${category}`} x={(groupStart + categoryIndex * barWidth).toFixed(2)} y={(74 - height).toFixed(2)} width={barWidth.toFixed(2)} height={height.toFixed(2)} rx="1" />;
    });
  });
  return <div className="usage-history">
    <section className="usage-chart-card" aria-labelledby="usage-turn-history-title">
      <div className="usage-chart-heading"><h2 id="usage-turn-history-title">Tokens by turn</h2><span>{turns ? turns.omittedTurns > 0 ? `${turns.totalTurns} turns · last ${turns.rows.length} shown` : `${turns.totalTurns} turns` : "Unavailable"}</span></div>
      {turns?.rows.length ? <>
        <div className="usage-chart-legend" aria-hidden="true"><span>Input</span><span>Output</span><span>Cache read</span><span>Cache write</span></div>
        <svg className="usage-turn-chart" role="img" aria-label="Tokens by turn" viewBox="0 0 300 80" preserveAspectRatio="none">{chartBars}</svg>
        {turns.omittedTurns > 0 && <p className="usage-bounded-note">{turns.omittedTurns} earlier {turns.omittedTurns === 1 ? "turn is" : "turns are"} omitted from this bounded view.</p>}
        <div className="usage-table-scroll" role="region" aria-label="Scrollable tokens by turn data" tabIndex={0}><table className="usage-turn-table" aria-label="Tokens by turn data"><thead><tr><th>Turn</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th></tr></thead><tbody>{turns.rows.map((row) => <tr key={row.turn}><th scope="row">{row.turn}</th><td>{row.input.toLocaleString()}</td><td>{row.output.toLocaleString()}</td><td>{row.cacheRead.toLocaleString()}</td><td>{row.cacheWrite.toLocaleString()}</td><td>{row.totalTokens.toLocaleString()}</td></tr>)}</tbody></table></div>
      </> : turns ? <p className="usage-unavailable">No completed turn usage yet.</p> : <p className="usage-unavailable">Per-turn token history is unavailable.</p>}
    </section>
    <section className="usage-chart-card" aria-labelledby="usage-context-history-title">
      <div className="usage-chart-heading"><h2 id="usage-context-history-title">Context history</h2><span>{contextSamples ? `${Math.round(contextSamples[contextSamples.length - 1]! * 100)}% latest` : "Unavailable"}</span></div>
      {contextSamples ? <svg className="usage-sparkline" role="img" aria-label="Context utilization history" viewBox="0 0 300 54" preserveAspectRatio="none"><polyline points={points(contextSamples, 300, 48, 1)} /></svg> : <p className="usage-unavailable">Context history is unavailable.</p>}
    </section>
  </div>;
}

export function ChatUsage({ usage, details, nowMs, onRefresh, refreshing, onOpenAccountUsage }: {
  readonly usage: CurrentChatUsage;
  readonly details: HarnessPanelDetails | null;
  readonly nowMs?: number;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly onOpenAccountUsage?: () => void;
}) {
  const categories = [["Input", usage.input], ["Output", usage.output], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheWrite]] as const;
  const categoryTotal = categories.reduce((sum, [, value]) => sum + value, 0);
  const tokenEvidence = categoryTotal > 0;
  const percent = contextPercent(details?.context ?? null);
  const contributions = reconciledContributions(details, usage.totalTokens);
  const contributionTotal = contributions?.reduce((sum, item) => sum + item.tokens, 0) ?? 0;
  const refresh = createControlBinding("usage.current.refresh", "usage.current.refresh");
  const account = createControlBinding("usage.account.open", "usage.account.open");
  return <div className="chat-usage">
    <div className="usage-toolbar"><div><span>Scope</span><strong>Current chat</strong></div><button type="button" data-control-id={refresh.controlId} onClick={onRefresh} disabled={refreshing} aria-label="Refresh current-chat usage">{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    <section className="usage-context"><div><span>Context window</span><span>{percent === null ? "Unavailable" : `${percent}%`}</span></div><strong>{details?.context ? `${compactTokenCount(details.context.usedTokens)} / ${compactTokenCount(details.context.capacityTokens)}` : "Denominator unavailable"}</strong>{percent === null ? <p>Current utilization is unavailable.</p> : <span className="harness-progress" aria-hidden="true"><i style={{ inlineSize: `${percent}%` }} /></span>}</section>
    <div className="usage-metrics"><Metric label="Chat tokens" value={tokenEvidence ? usage.totalTokens.toLocaleString() : "Chat usage unavailable"} /><Metric label="Turns" value={String(details?.context?.turns ?? "—")} /><Metric label="Elapsed" value={formatElapsed(details?.startedAtMs ?? null, nowMs ?? details?.observedAtMs)} /><Metric label="Cost" value={usage.cost === null ? "Cost unavailable" : `$${usage.cost.toFixed(4)}`} /></div>
    <UsageCharts details={details} />
    <section className="usage-breakdown" aria-labelledby="contribution-title"><div className="usage-table-heading"><h2 id="contribution-title">Contribution breakdown</h2><span>Share</span><span>Tokens</span></div>{contributions ? contributions.map((item) => { const share = contributionTotal ? Math.round(item.tokens / contributionTotal * 100) : 0; return <div className="usage-breakdown-row" key={item.id}><div><span>{item.label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{item.tokens.toLocaleString()}</strong></div>; }) : <p className="harness-empty">Parent and child attribution is unavailable. Totals are not guessed.</p>}</section>
    <section className="usage-breakdown" aria-labelledby="token-breakdown-title"><div className="usage-table-heading"><h2 id="token-breakdown-title">Token types</h2><span>Share</span><span>Tokens</span></div>{tokenEvidence ? categories.map(([label, value]) => { const share = Math.round(value / categoryTotal * 100); return <div className="usage-breakdown-row" key={label}><div><span>{label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${share}%` }} /></span></div><span>{share}%</span><strong>{value.toLocaleString()}</strong></div>; }) : <p className="usage-unavailable">Token-type usage is unavailable.</p>}</section>
    <p className="usage-note">Subagent usage is included only when it belongs to this chat.</p>
    <button className="usage-account-link" type="button" data-control-id={account.controlId} disabled={!onOpenAccountUsage} title={onOpenAccountUsage ? undefined : "Account usage navigation is unavailable in this host."} onClick={onOpenAccountUsage}>Open account-wide usage in Settings → Usage</button>
  </div>;
}
