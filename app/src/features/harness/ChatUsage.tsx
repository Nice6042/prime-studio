import type { CurrentChatUsage } from "../../shared/ipc/harness.generated";

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="usage-metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function ChatUsage({ usage, onOpenAccountUsage }: {
  readonly usage: CurrentChatUsage;
  readonly onOpenAccountUsage?: () => void;
}) {
  const categories = [
    ["Input", usage.input], ["Output", usage.output], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheWrite],
  ] as const;
  const categoryTotal = categories.reduce((sum, [, value]) => sum + value, 0);
  return <div className="chat-usage">
    <div className="usage-scope"><span>Usage</span><strong>Current chat only</strong></div>
    <section className="usage-context"><span>Context utilization</span><strong>Unavailable</strong><p>The runtime snapshot does not expose a verified context-window denominator.</p></section>
    <div className="usage-metrics">
      <Metric label="Total tokens" value={usage.totalTokens.toLocaleString()} />
      <Metric label="Input" value={usage.input.toLocaleString()} />
      <Metric label="Output" value={usage.output.toLocaleString()} />
      <Metric label="Cost" value={usage.cost === null ? "Cost unavailable" : `$${usage.cost.toFixed(4)}`} />
    </div>
    <section className="usage-breakdown" aria-labelledby="token-breakdown-title">
      <h2 id="token-breakdown-title">Token types</h2>
      {categories.map(([label, value]) => <div className="usage-breakdown-row" key={label}>
        <span>{label}</span><span className="usage-bar" aria-hidden="true"><i style={{ inlineSize: `${categoryTotal === 0 ? 0 : value / categoryTotal * 100}%` }} /></span><strong>{value.toLocaleString()}</strong>
      </div>)}
    </section>
    <section className="usage-attribution"><h2>Contribution</h2><p>Parent and child attribution is unavailable in this snapshot. Totals are not guessed.</p></section>
    <button className="usage-account-link" type="button" disabled={!onOpenAccountUsage} onClick={onOpenAccountUsage}>Open account-wide usage in Settings</button>
  </div>;
}
