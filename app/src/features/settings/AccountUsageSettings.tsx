import { useEffect, useMemo, useState } from "react";

import * as rpc from "../../rpc";
import { PROVIDER_NAME } from "../../accounts";
import type { Account, UsageRow } from "../../types";

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];
type Metric = "cost" | "tokens";
const MAX_RENDERED_ROWS = 100_000;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

interface Totals { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number }
const emptyTotals = (): Totals => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 });

function boundedRows(value: readonly UsageRow[]): UsageRow[] {
  if (value.length > MAX_RENDERED_ROWS) return [];
  return value.filter((row) =>
    Number.isSafeInteger(row.ts) && row.ts >= 0 &&
    typeof row.provider === "string" && row.provider.length <= 64 &&
    [row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].every((candidate) => Number.isFinite(candidate) && candidate >= 0),
  );
}

function sum(rows: readonly UsageRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.cost += row.cost;
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
  }
  totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function AccountUsageSettings({ accounts }: { readonly accounts: readonly Account[] }) {
  const [days, setDays] = useState<WindowDays>(7);
  const [metric, setMetric] = useState<Metric>("cost");
  const [rowsByDirectory, setRowsByDirectory] = useState<ReadonlyMap<string, readonly UsageRow[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);

  const directories = useMemo(() => {
    const unique = new Map<string, Account>();
    for (const account of accounts) if (!unique.has(account.agentDir)) unique.set(account.agentDir, account);
    return unique;
  }, [accounts]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setAvailable(true);
    void Promise.all([...directories].map(async ([directory, account]) => {
      const rows = boundedRows(await rpc.accountUsageSeriesStrict(account.id, days));
      return [directory, rows] as const;
    })).then((entries) => {
      if (!active) return;
      setRowsByDirectory(new Map(entries));
    }).catch(() => {
      if (!active) return;
      setRowsByDirectory(new Map());
      setAvailable(false);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, directories]);

  const rows = useMemo(() => [...rowsByDirectory.values()].flat(), [rowsByDirectory]);
  const totals = useMemo(() => sum(rows), [rows]);
  const value = (candidate: Totals) => metric === "cost" ? candidate.cost : candidate.tokens;
  const display = (candidate: Totals) => metric === "cost" ? money.format(candidate.cost) : compact.format(candidate.tokens);

  const daily = useMemo(() => {
    const starts: number[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      starts.push(date.getTime());
    }
    const grouped = new Map<number, UsageRow[]>();
    for (const row of rows) {
      const key = localDayStart(row.ts);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return starts.map((timestamp) => ({ timestamp, totals: sum(grouped.get(timestamp) ?? []) }));
  }, [days, rows]);
  const peak = Math.max(0, ...daily.map((bucket) => value(bucket.totals)));
  const activeDays = daily.filter((bucket) => value(bucket.totals) > 0).length;
  const cacheShare = totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : 0;

  const providerTotals = useMemo(() => {
    const grouped = new Map<string, UsageRow[]>();
    for (const row of rows) grouped.set(row.provider || "unknown", [...(grouped.get(row.provider || "unknown") ?? []), row]);
    return [...grouped].map(([provider, providerRows]) => ({ provider, totals: sum(providerRows) })).sort((left, right) => value(right.totals) - value(left.totals));
  }, [rows, metric]);

  const accountTotals = useMemo(() => accounts.map((account) => {
    const directoryRows = rowsByDirectory.get(account.agentDir) ?? [];
    const shared = accounts.filter((candidate) => candidate.agentDir === account.agentDir).length > 1;
    return { account, totals: sum(shared ? directoryRows.filter((row) => row.provider === account.provider) : directoryRows) };
  }), [accounts, rowsByDirectory]);

  return <>
    <div className="studio-usage-summary">
      <div><span>{metric === "cost" ? "API-equivalent cost" : "Processed tokens"}</span><strong>{display(totals)}</strong><small>{loading ? "Refreshing verified local history…" : `${activeDays} active days in this window`}</small></div>
      <div className="studio-usage-controls">
        <div className="studio-usage-period" aria-label="Usage period">{WINDOWS.map((candidate) => <button type="button" key={candidate} aria-pressed={days === candidate} onClick={() => setDays(candidate)}>{candidate} days</button>)}</div>
        <div className="studio-usage-period" aria-label="Usage metric"><button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Cost</button><button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button></div>
      </div>
    </div>
    {!available && <div className="studio-setting-unavailable">Account usage could not be read. No zero value has been invented.</div>}
    <section className="studio-usage-stats" aria-label="Usage totals"><div><span>Input</span><strong>{compact.format(totals.input)}</strong></div><div><span>Output</span><strong>{compact.format(totals.output)}</strong></div><div><span>Cache read</span><strong>{compact.format(totals.cacheRead)}</strong></div><div><span>Cache share</span><strong>{`${(cacheShare * 100).toFixed(0)}%`}</strong></div></section>
    <section className="studio-usage-chart" aria-label={`Daily ${metric} over ${days} days`} role="img"><header><h2>Daily {metric}</h2><span>Peak {metric === "cost" ? money.format(peak) : compact.format(peak)}</span></header><div>{daily.map((bucket) => <span key={bucket.timestamp} title={`${day.format(bucket.timestamp)}: ${display(bucket.totals)}`}><i style={{ height: peak > 0 ? `${Math.max(2, value(bucket.totals) / peak * 100)}%` : "2%" }} /></span>)}</div><footer><span>{day.format(daily[0]?.timestamp ?? Date.now())}</span><span>{day.format(daily[daily.length - 1]?.timestamp ?? Date.now())}</span></footer></section>
    <section className="studio-usage-breakdown"><header><h2>Breakdown</h2><button type="button" disabled title="A native user-selected save destination is not connected.">Export CSV</button></header><table><thead><tr><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th><th>Share</th></tr></thead><tbody>{providerTotals.length === 0 ? <tr><td colSpan={3}>No verified usage in this window.</td></tr> : providerTotals.map(({ provider, totals: providerValue }) => <tr key={provider}><td>{PROVIDER_NAME[provider] ?? provider}</td><td>{display(providerValue)}</td><td>{value(totals) > 0 ? `${(value(providerValue) / value(totals) * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></section>
    <section className="studio-usage-breakdown"><header><h2>By account</h2></header><table><thead><tr><th>Account</th><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th></tr></thead><tbody>{accountTotals.map(({ account, totals: accountValue }) => <tr key={account.id}><td>{account.label}</td><td>{PROVIDER_NAME[account.provider] ?? account.provider}</td><td>{display(accountValue)}</td></tr>)}</tbody></table></section>
    <p className="studio-usage-footnote">API-equivalent cost is derived from bounded local session history; subscription logins can have zero marginal billing. Shared agent directories are read once and split by provider.</p>
  </>;
}
