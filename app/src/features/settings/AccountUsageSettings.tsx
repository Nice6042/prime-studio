import { useCallback, useEffect, useMemo, useState } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
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

const controls = {
  range: createControlBinding("settings.usage.range", "usage.account.range-select"),
  refresh: createControlBinding("settings.usage.refresh", "usage.account.refresh"),
  export: createControlBinding("settings.usage.export", "usage.account.export-csv"),
  series: createControlBinding("settings.usage.series.main", "usage.account.series-toggle"),
};

function boundedRows(value: readonly UsageRow[]): UsageRow[] {
  if (value.length > MAX_RENDERED_ROWS) return [];
  return value.filter((row) => Number.isSafeInteger(row.ts) && row.ts >= 0 && typeof row.provider === "string" && row.provider.length <= 64 && [row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].every((candidate) => Number.isFinite(candidate) && candidate >= 0));
}

function sum(rows: readonly UsageRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) { totals.cost += row.cost; totals.input += row.input; totals.output += row.output; totals.cacheRead += row.cacheRead; totals.cacheWrite += row.cacheWrite; }
  totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

function localDayStart(timestamp: number): number { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date.getTime(); }

function csvCell(value: string | number): string {
  let text = String(value).replace(/\r\n?/gu, "\n");
  if (/^[\t\n=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function buildAccountUsageCsv(rows: readonly UsageRow[]): string {
  const header = "timestamp,provider,cost,input,output,cache_read,cache_write";
  return [header, ...boundedRows(rows).map((row) => [new Date(row.ts).toISOString(), row.provider || "unknown", row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

function linePath(values: readonly number[], peak: number, width = 720, height = 180): string {
  if (values.length === 0) return "";
  return values.map((value, index) => `${index === 0 ? "M" : "L"}${(index / Math.max(1, values.length - 1) * width).toFixed(2)},${(height - (peak > 0 ? value / peak * (height - 12) : 0)).toFixed(2)}`).join(" ");
}

export function AccountUsageSettings({ accounts, onExportCsv, loadUsage = rpc.accountUsageSeriesStrict }: {
  readonly accounts: readonly Account[];
  readonly onExportCsv?: (csv: string, rangeDays: WindowDays) => Promise<Readonly<{ status: "cancelled" }> | Readonly<{ status: "saved"; path: string; rows: number; bytes: number }>>;
  readonly loadUsage?: (accountId: string, days: WindowDays) => Promise<UsageRow[]>;
}) {
  const [days, setDays] = useState<WindowDays>(7);
  const [metric, setMetric] = useState<Metric>("cost");
  const [rowsByDirectory, setRowsByDirectory] = useState<ReadonlyMap<string, readonly UsageRow[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const directories = useMemo(() => { const unique = new Map<string, Account>(); for (const account of accounts) if (!unique.has(account.agentDir)) unique.set(account.agentDir, account); return unique; }, [accounts]);

  useEffect(() => {
    let active = true; setLoading(true); setAvailable(true); setNotice(null);
    void Promise.all([...directories].map(async ([directory, account]) => [directory, boundedRows(await loadUsage(account.id, days))] as const)).then((entries) => { if (active) setRowsByDirectory(new Map(entries)); }).catch(() => { if (active) { setRowsByDirectory(new Map()); setAvailable(false); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, directories, loadUsage, refreshKey]);

  const rows = useMemo(() => [...rowsByDirectory.values()].flat(), [rowsByDirectory]);
  const totals = useMemo(() => sum(rows), [rows]);
  const value = useCallback((candidate: Totals) => metric === "cost" ? candidate.cost : candidate.tokens, [metric]);
  const display = useCallback((candidate: Totals) => metric === "cost" ? money.format(candidate.cost) : compact.format(candidate.tokens), [metric]);
  const daily = useMemo(() => {
    const starts: number[] = []; const now = new Date(); now.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) { const date = new Date(now); date.setDate(date.getDate() - offset); starts.push(date.getTime()); }
    const grouped = new Map<number, UsageRow[]>(); for (const row of rows) { const key = localDayStart(row.ts); grouped.set(key, [...(grouped.get(key) ?? []), row]); }
    return starts.map((timestamp) => ({ timestamp, totals: sum(grouped.get(timestamp) ?? []) }));
  }, [days, rows]);
  const peak = Math.max(0, ...daily.map((bucket) => value(bucket.totals)));
  const activeDays = daily.filter((bucket) => value(bucket.totals) > 0).length;
  const cacheShare = totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : 0;
  const providerTotals = useMemo(() => { const grouped = new Map<string, UsageRow[]>(); for (const row of rows) grouped.set(row.provider || "unknown", [...(grouped.get(row.provider || "unknown") ?? []), row]); return [...grouped].map(([provider, providerRows]) => ({ provider, totals: sum(providerRows) })).sort((left, right) => value(right.totals) - value(left.totals)); }, [rows, value]);
  const accountTotals = useMemo(() => accounts.map((account) => { const directoryRows = rowsByDirectory.get(account.agentDir) ?? []; const shared = accounts.filter((candidate) => candidate.agentDir === account.agentDir).length > 1; return { account, totals: sum(shared ? directoryRows.filter((row) => row.provider === account.provider) : directoryRows) }; }), [accounts, rowsByDirectory]);
  const chartPath = linePath(daily.map((bucket) => value(bucket.totals)), peak);

  const exportCsv = async () => {
    if (!onExportCsv || loading) return;
    setNotice(null);
    try { const result = await onExportCsv(buildAccountUsageCsv(rows), days); setNotice(result.status === "cancelled" ? "Export cancelled." : "Usage CSV exported."); }
    catch { setNotice("Export failed. Choose a writable destination and try again."); }
  };

  return <>
    <div className="studio-usage-summary"><div><span>{metric === "cost" ? "API-equivalent cost" : "Processed tokens"}</span><strong>{display(totals)}</strong><small>{loading ? "Refreshing verified local history…" : `${activeDays} active days in this window`}</small></div><div className="studio-usage-controls"><div className="studio-usage-period" aria-label="Usage period">{WINDOWS.map((candidate) => <button type="button" data-control-id={`${controls.range.controlId}.${candidate}`} data-action={controls.range.action} key={candidate} aria-pressed={days === candidate} onClick={() => setDays(candidate)}>{candidate} days</button>)}</div><div className="studio-usage-period" aria-label="Usage metric"><button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Cost</button><button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button></div><button type="button" className="studio-usage-refresh" data-control-id={controls.refresh.controlId} data-action={controls.refresh.action} disabled={loading} onClick={() => setRefreshKey((key) => key + 1)}>{loading ? "Refreshing…" : "Refresh"}</button></div></div>
    {!available && <div className="studio-setting-unavailable" role="alert">Account usage could not be read. No zero value has been invented.</div>}
    <section className="studio-usage-stats" aria-label="Usage totals"><div><span>Processed</span><strong>{compact.format(totals.tokens)}</strong></div><div><span>Input</span><strong>{compact.format(totals.input)}</strong></div><div><span>Output</span><strong>{compact.format(totals.output)}</strong></div><div><span>Cached input</span><strong>{compact.format(totals.cacheRead)}</strong></div><div><span>Cache writes</span><strong>{compact.format(totals.cacheWrite)}</strong></div><div><span>Cache share</span><strong>{`${(cacheShare * 100).toFixed(0)}%`}</strong></div><div><span>API-equivalent</span><strong>{money.format(totals.cost)}</strong></div></section>
    <section className="studio-usage-chart"><header><div><h2>Daily {metric}</h2><span>Peak {metric === "cost" ? money.format(peak) : compact.format(peak)}</span></div><div className="studio-chart-legend" role="group" aria-label="Chart series"><button type="button" data-control-id={controls.series.controlId} data-action={controls.series.action} aria-pressed="true"><i />Account history</button><button type="button" disabled title="Subagent attribution was not reported by the usage ledger.">Subagents</button><button type="button" disabled title="Tool attribution was not reported by the usage ledger.">Tools</button></div></header><svg data-chart="account-usage" role="img" aria-label={`Daily ${metric} over ${days} days`} viewBox="0 0 720 180" preserveAspectRatio="none"><title>{`Daily ${metric} over ${days} days`}</title>{[0, 1, 2, 3].map((line) => <path key={line} className="studio-chart-grid" d={`M0 ${line * 56 + 6} H720`} />)}<path className="studio-chart-area" d={chartPath ? `${chartPath} L720,180 L0,180 Z` : ""} /><path className="studio-chart-line" d={chartPath} /></svg><footer><span>{day.format(daily[0]?.timestamp ?? Date.now())}</span><span>{day.format(daily[daily.length - 1]?.timestamp ?? Date.now())}</span></footer></section>
    <section className="studio-usage-breakdown"><header><h2>Breakdown</h2><button type="button" data-control-id={controls.export.controlId} data-action={controls.export.action} disabled={!onExportCsv || loading} title={!onExportCsv ? "A native user-selected save destination is not connected." : undefined} onClick={() => void exportCsv()}>Export CSV</button></header><table><thead><tr><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th><th>Share</th></tr></thead><tbody>{providerTotals.length === 0 ? <tr><td colSpan={3}>No verified usage in this window.</td></tr> : providerTotals.map(({ provider, totals: providerValue }) => <tr key={provider}><td>{PROVIDER_NAME[provider] ?? provider}</td><td>{display(providerValue)}</td><td>{value(totals) > 0 ? `${(value(providerValue) / value(totals) * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></section>
    <section className="studio-usage-breakdown"><header><h2>Usage by account</h2></header><table><thead><tr><th>Account</th><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th></tr></thead><tbody>{accountTotals.map(({ account, totals: accountValue }) => <tr key={account.id}><td>{account.label}</td><td>{PROVIDER_NAME[account.provider] ?? account.provider}</td><td>{display(accountValue)}</td></tr>)}</tbody></table></section>
    {notice && <p role="status" className="studio-usage-notice">{notice}</p>}
    <p className="studio-usage-footnote">API-equivalent cost is derived from bounded local session history; subscription logins can have zero marginal billing. Shared agent directories are read once and split by provider. Current-chat usage remains in the active chat’s Harness panel.</p>
  </>;
}
