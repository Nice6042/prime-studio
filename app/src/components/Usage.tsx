import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as rpc from "../rpc";
import { PROVIDER_NAME, ago, money } from "../accounts";
import { useModalSurfaceFocus } from "../modalSurface";
import { useTopmostSurfaceEscape } from "../surfaceEscape";
import type { Account, CodexSubscription, RateWindow, UsageRow } from "../types";

const WINDOWS = [7, 30, 90] as const;
type Metric = "cost" | "tokens";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Local midnight of the day `ts` falls in. */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

interface Totals {
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO: Totals = { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function total(rows: UsageRow[]): Totals {
  const t = { ...ZERO };
  for (const r of rows) {
    t.cost += r.cost;
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
  }
  t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

/** Progress bar for a real subscription window. Percent is clamped, never faked. */
function Meter({ w, label }: { w: RateWindow; label: string }) {
  const p = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <div className="sub-meter">
      <div className="sub-meter-head">
        <span>{label}</span>
        <strong>{w.usedPercent.toFixed(1)}%</strong>
      </div>
      <div className="meter-bar">
        <div className={`meter-fill ${p > 80 ? "hot" : ""}`} style={{ width: `${p}%` }} />
      </div>
      <div className="muted small">
        {windowLabel(w.windowMinutes)} window
        {w.resetsAt > 0 && ` · resets ${dateFmt.format(new Date(w.resetsAt * 1000))}`}
      </div>
    </div>
  );
}

export function Usage({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useTopmostSurfaceEscape(backdropRef, onClose);
  const keepFocusInside = useModalSurfaceFocus(backdropRef, dialogRef, closeRef);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const [metric, setMetric] = useState<Metric>("cost");
  /** Keyed by agentDir, not account id: the migrated `default-*` accounts share one. */
  const [series, setSeries] = useState<Record<string, UsageRow[]>>({});
  const [sub, setSub] = useState<CodexSubscription | null>(null);
  const [loading, setLoading] = useState(true);

  const ids = accounts.map((a) => `${a.id}:${a.agentDir}`).join(",");

  /** agentDir -> the accounts sharing it. */
  const dirs = useMemo(() => {
    const by = new Map<string, Account[]>();
    for (const a of accounts) by.set(a.agentDir, [...(by.get(a.agentDir) ?? []), a]);
    return by;
  }, [accounts]);

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await Promise.all(
      [...dirs.entries()].map(async ([dir, list]) => [dir, await rpc.accountUsageSeries(list[0].id, days)] as const),
    );
    setSeries(Object.fromEntries(rows));
    setSub(await rpc.codexSubscriptionUsage());
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, days]);

  useEffect(() => {
    void load();
  }, [load]);

  // The window's local day boundaries, oldest first. Built with setDate so a DST
  // shift inside the window doesn't drift the buckets.
  const dayStarts = useMemo(() => {
    const out: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      out.push(d.getTime());
    }
    return out;
  }, [days]);

  const cutoff = dayStarts[0];
  const inWindow = useCallback((rows: UsageRow[]) => rows.filter((r) => r.ts >= cutoff), [cutoff]);

  /** Every row exactly once — one series per agent dir, so a shared dir isn't doubled. */
  const allRows = useMemo(
    () => inWindow(Object.values(series).flat()),
    [series, inWindow],
  );

  /**
   * An account's own rows. When several accounts share one agent dir (the migrated
   * per-provider defaults) the only thing separating them is the provider on each
   * row, so filter by it; a dir with one account keeps everything.
   */
  const rowsFor = useCallback(
    (a: Account) => {
      const rows = inWindow(series[a.agentDir] ?? []);
      return (dirs.get(a.agentDir)?.length ?? 1) > 1 ? rows.filter((r) => r.provider === a.provider) : rows;
    },
    [series, dirs, inWindow],
  );

  const grand = useMemo(() => total(allRows), [allRows]);
  const value = (t: Totals) => (metric === "cost" ? t.cost : t.tokens);
  const fmt = (t: Totals) => (metric === "cost" ? `${money(value(t))}*` : compact.format(value(t)));

  const perDay = useMemo(() => {
    const by = new Map<number, UsageRow[]>();
    for (const r of allRows) {
      const k = dayStart(r.ts);
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return dayStarts.map((d) => ({ day: d, v: value(total(by.get(d) ?? [])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, dayStarts, metric]);

  const peak = Math.max(...perDay.map((d) => d.v), 0);
  const activeDays = perDay.filter((d) => d.v > 0).length;
  const dailyAvg = value(grand) / days;
  const cachedShare = grand.input + grand.cacheRead > 0 ? grand.cacheRead / (grand.input + grand.cacheRead) : 0;

  const byProvider = useMemo(() => {
    const by = new Map<string, UsageRow[]>();
    for (const r of allRows) by.set(r.provider || "unknown", [...(by.get(r.provider || "unknown") ?? []), r]);
    return [...by.entries()]
      .map(([p, rows]) => ({ provider: p, t: total(rows) }))
      .sort((a, b) => value(b.t) - value(a.t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, metric]);

  const claude = byProvider.find((p) => p.provider === "anthropic")?.t ?? ZERO;

  return (
    <div ref={backdropRef} className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong id={titleId}>Usage</strong>
          <div className="seg">
            {WINDOWS.map((w) => (
              <button key={w} className={`seg-btn ${w === days ? "on" : ""}`} onClick={() => setDays(w)}>
                {w}d
              </button>
            ))}
          </div>
          <div className="seg">
            {(["cost", "tokens"] as Metric[]).map((m) => (
              <button key={m} className={`seg-btn ${m === metric ? "on" : ""}`} onClick={() => setMetric(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="spacer" />
          {loading && <span className="muted small">loading…</span>}
          <button className="btn btn-icon" onClick={() => void load()} title="Refresh">
            ⟳
          </button>
          <button
            ref={closeRef}
            className="btn btn-icon"
            onClick={onClose}
            title="Close"
            aria-label="Close usage"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          <section className="stat-row">
            <div className="stat">
              <div className="stat-v">{fmt(grand)}</div>
              <div className="stat-k">total, last {days} days</div>
            </div>
            <div className="stat">
              <div className="stat-v">
                {metric === "cost" ? `${money(dailyAvg)}*` : compact.format(dailyAvg)}
              </div>
              <div className="stat-k">daily average</div>
            </div>
            <div className="stat">
              <div className="stat-v">
                {activeDays}/{days}
              </div>
              <div className="stat-k">active days</div>
            </div>
            <div className="stat">
              <div className="stat-v">{(cachedShare * 100).toFixed(0)}%</div>
              <div className="stat-k" title="cacheRead / (input + cacheRead)">
                cached share
              </div>
            </div>
          </section>

          <section className="acct-group">
            <h3>
              Daily {metric}
              <span className="muted small"> · peak {metric === "cost" ? money(peak) : compact.format(peak)}</span>
            </h3>
            <div className="chart" role="img" aria-label={`Daily ${metric} over ${days} days`}>
              {perDay.map((d) => (
                <div
                  key={d.day}
                  className="chart-col"
                  title={`${dayFmt.format(new Date(d.day))} — ${
                    metric === "cost" ? money(d.v) : `${compact.format(d.v)} tokens`
                  }`}
                >
                  <div
                    className="chart-bar"
                    style={{ height: peak > 0 ? `${Math.max(1, (d.v / peak) * 100)}%` : "1%" }}
                  />
                </div>
              ))}
            </div>
            <div className="chart-axis muted small">
              <span>{dayFmt.format(new Date(dayStarts[0]))}</span>
              <span>{dayFmt.format(new Date(dayStarts[dayStarts.length - 1]))}</span>
            </div>
          </section>

          <section className="acct-group">
            <h3>By provider</h3>
            <table className="usage">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="num">{metric === "cost" ? "Cost" : "Tokens"}</th>
                  <th className="num">Share</th>
                  <th className="num">Cached</th>
                </tr>
              </thead>
              <tbody>
                {byProvider.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Nothing in this window.
                    </td>
                  </tr>
                )}
                {byProvider.map(({ provider, t }) => (
                  <tr key={provider}>
                    <td>{PROVIDER_NAME[provider] ?? provider}</td>
                    <td className="num">{fmt(t)}</td>
                    <td className="num">{pct(value(t), value(grand))}</td>
                    <td className="num">{pct(t.cacheRead, t.input + t.cacheRead)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="acct-group">
            <h3>By account</h3>
            <table className="usage">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">{metric === "cost" ? "Cost" : "Tokens"}</th>
                  <th className="num">Share</th>
                  <th className="num">Cached</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const t = total(rowsFor(a));
                  return (
                    <tr key={a.id}>
                      <td>
                        {a.label}
                        <span className="muted small"> · {PROVIDER_NAME[a.provider] ?? a.provider}</span>
                      </td>
                      <td className="num">{fmt(t)}</td>
                      <td className="num">{pct(value(t), value(grand))}</td>
                      <td className="num">{pct(t.cacheRead, t.input + t.cacheRead)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="acct-group">
            <h3>Subscription quota</h3>
            <div className="sub-cards">
              <div className="sub-card">
                <div className="sub-title">
                  ChatGPT / Codex
                  {sub?.planType && <span className={"pill pill-authed"}>{sub.planType}</span>}
                </div>
                {sub ? (
                  <>
                    <Meter w={sub} label="Primary window" />
                    {sub.secondary && <Meter w={sub.secondary} label="Secondary window" />}
                    <p className="muted small">
                      Real account-level quota, as of {ago(sub.staleAsOf)} (
                      {dateFmt.format(new Date(sub.staleAsOf))}). It is a snapshot from the Codex
                      CLI's own session log and only refreshes when that CLI runs — it is not live.
                    </p>
                  </>
                ) : (
                  <p className="muted small">
                    No snapshot yet. This figure comes from the Codex CLI's session logs
                    (<code>~/.codex/sessions</code>); run Codex once and it appears here.
                  </p>
                )}
              </div>

              <div className="sub-card">
                <div className="sub-title">Claude</div>
                <div className="sub-meter-head">
                  <span>Last {days} days</span>
                  <strong>{fmt(claude)}</strong>
                </div>
                <p className="muted small">
                  No plan-percentage source exists for Claude. Prime talks to the Anthropic API
                  directly with a hardcoded base URL, so its rate-limit headers cannot be
                  intercepted, and Prime itself does not expose subscription quota. Rather than
                  show a fabricated or empty meter, this card reports cost and tokens only.
                </p>
              </div>
            </div>
          </section>

          <p className="muted small">
            * API-equivalent cost — subscription logins bill $0 marginal. Accounts sharing one
            agent directory are read once and split by provider, so nothing is double-counted.
          </p>
        </div>
      </div>
    </div>
  );
}
