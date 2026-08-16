import { useCallback, useEffect, useMemo, useState } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
import * as rpc from "../../rpc";
import { PROVIDER_NAME } from "../../accounts";
import { SubscriptionQuota } from "../../components/SubscriptionQuota";
import type { SubscriptionQuotaProjection } from "../../quotaProjection";
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

function UnavailableFact({ name, children, id }: { readonly name: string; readonly children: string; readonly id?: string }) {
  return <div id={id} className="studio-usage-unavailable-fact" role="note" aria-label={`${name} unavailable`} tabIndex={0}>
    <strong>{name}</strong><span>Unavailable</span><small>{children}</small>
  </div>;
}

function boundedRows(value: readonly UsageRow[]): UsageRow[] {
  if (value.length > MAX_RENDERED_ROWS) throw new Error("Account usage row limit exceeded.");
  const rows = value.filter((row) => Number.isSafeInteger(row.ts) && row.ts >= 0 && typeof row.provider === "string" && row.provider.length <= 64 && [row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].every((candidate) => Number.isFinite(candidate) && candidate >= 0));
  if (rows.length !== value.length) throw new Error("Account usage contains an invalid row.");
  return rows;
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

export function AccountUsageSettings({ accounts, onExportCsv, loadUsage = rpc.accountUsageSeriesStrict, quota, quotaStatus = "unavailable", onRefreshQuota }: {
  readonly accounts: readonly Account[];
  readonly onExportCsv?: (csv: string, rangeDays: WindowDays) => Promise<Readonly<{ status: "cancelled" }> | Readonly<{ status: "saved"; path: string; rows: number; bytes: number }>>;
  readonly loadUsage?: (accountId: string, days: WindowDays) => Promise<UsageRow[]>;
  readonly quota?: SubscriptionQuotaProjection;
  readonly quotaStatus?: "loading" | "ready" | "unavailable";
  readonly onRefreshQuota?: () => Promise<Readonly<{ status: "updated" | "preserved" | "unavailable"; message?: string }>>;
}) {
  const [days, setDays] = useState<WindowDays>(7);
  const [metric, setMetric] = useState<Metric>("cost");
  const [rowsByDirectory, setRowsByDirectory] = useState<ReadonlyMap<string, readonly UsageRow[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(accounts.length > 0 ? null : "No account ledger is available. Add an account before requesting account-wide usage.");
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const directories = useMemo(() => { const unique = new Map<string, Account>(); for (const account of accounts) if (!unique.has(account.agentDir)) unique.set(account.agentDir, account); return unique; }, [accounts]);

  useEffect(() => {
    let active = true;
    setNotice(null);
    if (directories.size === 0) {
      setRowsByDirectory(new Map());
      setAvailable(false);
      setUnavailableReason("No account ledger is available. Add an account before requesting account-wide usage.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true); setAvailable(false); setUnavailableReason(null); setRowsByDirectory(new Map());
    void Promise.all([...directories].map(async ([directory, account]) => [directory, boundedRows(await loadUsage(account.id, days))] as const))
      .then((entries) => { if (active) { setRowsByDirectory(new Map(entries)); setAvailable(true); } })
      .catch(() => { if (active) { setRowsByDirectory(new Map()); setAvailable(false); setUnavailableReason("Account usage could not be read from the bounded local ledger. No zero value has been invented."); } })
      .finally(() => { if (active) setLoading(false); });
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
  const providerTotals = useMemo(() => { const grouped = new Map<string, UsageRow[]>(); for (const row of rows) grouped.set(row.provider || "unknown", [...(grouped.get(row.provider || "unknown") ?? []), row]); return [...grouped].map(([provider, providerRows]) => ({ provider, totals: sum(providerRows) })).sort((left, right) => value(right.totals) - value(left.totals)); }, [rows, value]);
  const accountTotals = useMemo(() => accounts.map((account) => {
    const directoryRows = rowsByDirectory.get(account.agentDir) ?? [];
    const peers = accounts.filter((candidate) => candidate.agentDir === account.agentDir);
    const shared = peers.length > 1;
    const sameProviderPeers = peers.filter((candidate) => candidate.provider === account.provider);
    const scopedRows = shared ? directoryRows.filter((row) => row.provider === account.provider) : directoryRows;
    return { account, totals: sum(scopedRows), ambiguous: sameProviderPeers.length > 1 };
  }), [accounts, rowsByDirectory]);
  const chartPath = linePath(daily.map((bucket) => value(bucket.totals)), peak);

  const exportCsv = async () => {
    if (!onExportCsv || loading) return;
    setNotice(null);
    try { const result = await onExportCsv(buildAccountUsageCsv(rows), days); setNotice(result.status === "cancelled" ? "Export cancelled." : "Usage CSV exported."); }
    catch { setNotice("Export failed. Choose a writable destination and try again."); }
  };

  const refresh = async () => {
    setRefreshKey((key) => key + 1);
    if (!onRefreshQuota) return;
    const result = await onRefreshQuota();
    if (result.message) setNotice(result.message);
  };

  const accountLabels = useMemo(() => new Map(accounts.map((account) => [account.id, account.label])), [accounts]);

  return <>
    <div className="studio-usage-summary"><div><span>{metric === "cost" ? "API-equivalent cost" : "Processed tokens"}</span><strong>{loading ? "Refreshing…" : available ? display(totals) : "Unavailable"}</strong><small>{loading ? "Refreshing verified local history…" : available ? `${activeDays} active days in this window` : "Waiting for verified account history"}</small></div><div className="studio-usage-controls"><div className="studio-usage-period" aria-label="Usage period">{WINDOWS.map((candidate) => <button type="button" data-control-id={`${controls.range.controlId}.${candidate}`} data-action={controls.range.action} key={candidate} aria-pressed={days === candidate} onClick={() => setDays(candidate)}>{candidate} days</button>)}</div><div className="studio-usage-period" aria-label="Usage metric"><button type="button" data-control-id="settings.usage.metric.cost" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Cost</button><button type="button" data-control-id="settings.usage.metric.tokens" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button></div><button type="button" className="studio-usage-refresh" data-control-id={controls.refresh.controlId} data-action={controls.refresh.action} disabled={loading || directories.size === 0} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div></div>
    {!loading && !available && <div className="studio-setting-unavailable" role="status" aria-label="Account usage unavailable">{unavailableReason}</div>}
    <section className="studio-usage-stats" aria-label="Usage totals"><div><span>Processed</span><strong>{available ? compact.format(totals.tokens) : "—"}</strong></div><div><span>Cached input</span><strong>{available ? compact.format(totals.cacheRead) : "—"}</strong></div><div><span>Input</span><strong>{available ? compact.format(totals.input) : "—"}</strong></div><div><span>Output</span><strong>{available ? compact.format(totals.output) : "—"}</strong></div><div><span>API-equivalent</span><strong>{available ? money.format(totals.cost) : "—"}</strong></div><UnavailableFact name="Chats">The account ledger does not report chat identity or counts.</UnavailableFact><UnavailableFact name="Tasks">The account ledger does not report task identity or counts.</UnavailableFact></section>
    <section className="studio-usage-chart"><header><div><h2>Daily {metric}</h2><span>Peak {available ? (metric === "cost" ? money.format(peak) : compact.format(peak)) : loading ? "refreshing" : "unavailable"}</span></div><div className="studio-chart-legend" role="group" aria-label="Chart series"><button type="button" data-control-id={controls.series.controlId} data-action={controls.series.action} aria-pressed="true" onClick={() => setNotice(null)}><i />Account history</button><button type="button" data-control-id="settings.usage.series.subagents" data-action={controls.series.action} disabled aria-label="Subagents unavailable" aria-describedby="subagent-series-policy">Subagents</button><button type="button" data-control-id="settings.usage.series.tools" data-action={controls.series.action} disabled aria-label="Tools unavailable" aria-describedby="tool-series-policy">Tools</button></div></header>{available ? <><svg data-chart="account-usage" role="img" aria-label={`Daily ${metric} over ${days} days`} viewBox="0 0 720 180" preserveAspectRatio="none"><title>{`Daily ${metric} over ${days} days`}</title>{[0, 1, 2, 3].map((line) => <path key={line} className="studio-chart-grid" d={`M0 ${line * 56 + 6} H720`} />)}<path className="studio-chart-area" d={chartPath ? `${chartPath} L720,180 L0,180 Z` : ""} /><path className="studio-chart-line" d={chartPath} /></svg><footer><span>{day.format(daily[0]?.timestamp ?? Date.now())}</span><span>{day.format(daily[daily.length - 1]?.timestamp ?? Date.now())}</span></footer></> : <p className="studio-usage-chart-empty">{loading ? "Refreshing the verified account ledger…" : "Daily series is unavailable until a verified account ledger is readable."}</p>}<div className="studio-usage-series-policies"><UnavailableFact name="Subagent daily series" id="subagent-series-policy">The account ledger does not report subagent attribution.</UnavailableFact><UnavailableFact name="Tool daily series" id="tool-series-policy">The account ledger does not report tool attribution.</UnavailableFact></div></section>
    <section className="studio-usage-breakdown" aria-label="Breakdown by provider" tabIndex={0}><header><h2>Breakdown by provider</h2><button type="button" data-control-id={controls.export.controlId} data-action={controls.export.action} disabled={!onExportCsv || loading} title={!onExportCsv ? "A native user-selected save destination is not connected." : undefined} onClick={() => void exportCsv()}>Export CSV</button></header><table><thead><tr><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th><th>Share</th></tr></thead><tbody>{providerTotals.length === 0 ? <tr><td colSpan={3}>No verified usage in this window.</td></tr> : providerTotals.map(({ provider, totals: providerValue }) => <tr key={provider}><td>{PROVIDER_NAME[provider] ?? provider}</td><td>{display(providerValue)}</td><td>{value(totals) > 0 ? `${(value(providerValue) / value(totals) * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></section>
    <section className="studio-usage-breakdown" aria-label="Usage by account" tabIndex={0}><header><h2>Usage by account</h2></header><table><thead><tr><th>Account</th><th>Provider</th><th>{metric === "cost" ? "Cost" : "Tokens"}</th></tr></thead><tbody>{accountTotals.map(({ account, totals: accountValue, ambiguous }) => <tr key={account.id}><td>{account.label}</td><td>{PROVIDER_NAME[account.provider] ?? account.provider}</td><td>{ambiguous ? <span aria-label={`${account.label} usage attribution unavailable`}>Shared ledger · attribution unavailable</span> : available ? display(accountValue) : "Unavailable"}</td></tr>)}</tbody></table></section>
    <section className="acct-group" aria-label="Subscription quota"><h2>Subscription quota</h2>{quotaStatus === "loading" ? <p className="muted small">Loading provider quota evidence…</p> : quota ? <SubscriptionQuota projection={quota} accountLabels={accountLabels} /> : <UnavailableFact name="Subscription quota">Provider quota evidence could not be read; no zero value has been invented.</UnavailableFact>}</section>
    <section className="studio-usage-unsupported" aria-label="Unavailable account-usage dimensions"><UnavailableFact name="Model breakdown">Model identity is not reported by the current account ledger.</UnavailableFact><UnavailableFact name="Project breakdown">Project identity is not reported by the current account ledger.</UnavailableFact></section>
    {notice && <p role="status" className="studio-usage-notice">{notice}</p>}
    <p className="studio-usage-footnote">API-equivalent cost is derived from bounded local session history; subscription logins can have zero marginal billing. Shared agent directories are read once and split by provider. Current-chat usage remains in the active chat’s Harness panel.</p>
  </>;
}
