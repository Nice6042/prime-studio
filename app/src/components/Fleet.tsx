import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import * as rpc from "../rpc";
import { HEALTH_PILL, accountLabel, accountProvider, ago, health, healthLabel, money } from "../accounts";
import { useModalSurfaceFocus } from "../modalSurface";
import { useTopmostSurfaceEscape } from "../surfaceEscape";
import type { Account, AccountStatus, FleetAgent, FleetReport } from "../types";

/** How often the listing is re-read while the view is open. */
const POLL_MS = 4000;
/** Last-seen message counts, so "while you were gone" is a real delta. */
const SEEN_KEY = "prime-fleet-seen";

/**
 * The four states a row can be in, and they partition the listing exactly —
 * every agent falls in one and only one, which is what makes the counter strip
 * add up to the rows underneath it.
 *
 * Only states prime actually reports exist here. The mockup's GATE FAILED,
 * SCHEDULED and ERROR rows have no source in `prime-agent list`, so they are
 * not drawn rather than invented.
 */
type State = "running" | "detached" | "idle" | "retained";

function stateOf(a: FleetAgent): State {
  if (a.depth > 0) return "retained";
  if (a.streaming || a.runningTools || a.runningChildren) return "running";
  return a.clients === 0 ? "detached" : "idle";
}

const STATE_LABEL: Record<State, string> = {
  running: "RUNNING",
  detached: "DETACHED",
  idle: "IDLE",
  retained: "RETAINED",
};

const time = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

/** A short, human name for a row: what prime calls it, else what it was asked. */
const rowName = (a: FleetAgent): string =>
  a.name?.trim() || a.firstMessage?.trim() || a.id;

const folder = (p: string | null): string =>
  p?.split(/[\\/]/).filter(Boolean).pop() ?? "";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function StopConfirmation({
  agent,
  onConfirm,
  onClose,
  restoreFallbackRef,
}: {
  agent: FleetAgent;
  onConfirm: () => void;
  onClose: () => void;
  restoreFallbackRef: RefObject<HTMLButtonElement | null>;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRunningRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useTopmostSurfaceEscape(backdropRef, onClose);
  const keepFocusInside = useModalSurfaceFocus(
    backdropRef,
    dialogRef,
    keepRunningRef,
    restoreFallbackRef,
  );

  return createPortal(
    <div ref={backdropRef} className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong id={titleId}>Stop {rowName(agent)}?</strong>
        </div>
        <div className="modal-body">
          <p>
            This ends the agent, not just this window&apos;s view of it. Its kernel and any
            running work go with it; the transcript on disk stays.
          </p>
          <div className="acct-actions">
            <button className="btn btn-danger" onClick={onConfirm}>
              Stop agent
            </button>
            <button ref={keepRunningRef} className="btn" onClick={onClose}>
              Keep it running
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What prime reports about this agent right now, in one plain sentence. */
function signal(a: FleetAgent): string {
  const bits: string[] = [];
  if (a.streaming) bits.push("streaming a reply");
  if (a.runningTools) bits.push("running a cell");
  if (a.runningChildren) bits.push("subagents running");
  if (a.queued) bits.push(`${a.queued} queued`);
  bits.push(`${a.messages} message${a.messages === 1 ? "" : "s"}`);
  const at = time(a.lastActivity ?? a.modified);
  if (!Number.isNaN(at)) bits.push(`last activity ${ago(at)}`);
  return bits.join(" · ");
}

/** Who else is driving this agent. Read from the listing, never assumed. */
function clientsNote(a: FleetAgent): string {
  if (a.clients === 0) return "no client attached";
  if (a.attachedHere) {
    return a.clients === 1 ? "attached here" : `attached here + ${a.clients - 1} elsewhere`;
  }
  return `${a.clients} client${a.clients === 1 ? "" : "s"} elsewhere`;
}

export function Fleet({
  accounts,
  onAttach,
  onRead,
  onClose,
}: {
  accounts: Account[];
  /** Open a tab attached to this live agent. */
  onAttach: (agent: FleetAgent) => void;
  /** Open the agent's transcript read-only, by session-file stem. */
  onRead: (sessionStem: string, accountId: string | null) => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useTopmostSurfaceEscape(backdropRef, onClose);
  const keepFocusInside = useModalSurfaceFocus(backdropRef, dialogRef, closeRef);
  const [report, setReport] = useState<FleetReport | null>(null);
  const [statuses, setStatuses] = useState<Record<string, AccountStatus | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<FleetAgent | null>(null);
  // Snapshotted once, on open: it is what "while you were gone" is measured
  // against, so it must not move under the poll.
  const [seen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });

  const load = useCallback(async () => setReport(await rpc.fleetList()), []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Auth health per group header — real state from the same source Accounts uses.
  useEffect(() => {
    let alive = true;
    const ids = accounts.map((account) => account.id);
    if (ids.length === 0) {
      setStatuses({});
      return () => { alive = false; };
    }
    void rpc.accountStatuses(ids).then(
      (rows) => {
        if (!alive) return;
        setStatuses(Object.fromEntries(
          rows
            .filter((row) => row.available)
            .map((row) => [row.accountId, row.status]),
        ));
      },
      () => {
        if (alive) setStatuses({});
      },
    );
    return () => { alive = false; };
  }, [accounts]);

  const agents = useMemo(() => report?.agents ?? [], [report]);

  // Record what we have now, so the next visit can diff against it.
  useEffect(() => {
    if (!agents.length) return;
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify(Object.fromEntries(agents.map((a) => [a.id, a.messages]))),
    );
  }, [agents]);

  const counts = useMemo(() => {
    const c: Record<State, number> = { running: 0, detached: 0, idle: 0, retained: 0 };
    for (const a of agents) c[stateOf(a)] += 1;
    return c;
  }, [agents]);

  const attachedHere = agents.filter((a) => a.attachedHere).length;

  /**
   * Prime attributes a subagent's spend to its parent, so only top-level rows
   * carry money. Summing children too would count the same dollars twice, and
   * the group subtotals below are the same sum restricted to one account —
   * which is why they add up to this exactly.
   */
  const spend = (rows: FleetAgent[]) =>
    rows.filter((a) => a.depth === 0).reduce((n, a) => n + (a.cost ?? 0), 0);

  /** Rows grouped by account, parents first with their children right under them. */
  const groups = useMemo(() => {
    const byAccount = new Map<string | null, FleetAgent[]>();
    for (const a of agents) {
      const key = a.accountId ?? null;
      byAccount.set(key, [...(byAccount.get(key) ?? []), a]);
    }
    return [...byAccount.entries()].map(([id, rows]) => ({
      id,
      rows: [...rows].sort((x, y) => x.depth - y.depth || (time(y.modified) || 0) - (time(x.modified) || 0)),
    }));
  }, [agents]);

  /** Agents that moved on since this window last looked. */
  const gone = useMemo(() => {
    const moved = agents.filter((a) => a.messages > (seen[a.id] ?? 0));
    const fresh = agents.filter((a) => !(a.id in seen));
    const added = moved.reduce((n, a) => n + a.messages - (seen[a.id] ?? 0), 0);
    return { moved, fresh, added };
  }, [agents, seen]);

  const act = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusy(id);
      try {
        await run();
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load],
  );

  const rename = useCallback(
    (a: FleetAgent) => {
      const next = window.prompt("Rename agent", rowName(a));
      if (next && next.trim() && next.trim() !== a.name) {
        void act(a.id, () => rpc.renameAgent(a.id, next.trim()));
      }
    },
    [act],
  );

  return (
    <div ref={backdropRef} className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal-fleet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong id={titleId}>Fleet</strong>
          <span className="fleet-sub">
            {agents.length} agent{agents.length === 1 ? "" : "s"} across {groups.length} account
            {groups.length === 1 ? "" : "s"} · children counted in their parent
          </span>
          <span style={{ flex: 1 }} />
          <span className="fleet-note">grouped by account</span>
          <button className="btn" onClick={() => void load()}>
            Refresh
          </button>
          <button ref={closeRef} className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          {!report ? (
            <p className="fleet-empty">Reading the daemon…</p>
          ) : !report.daemon ? (
            <p className="fleet-empty">
              This prime build has no session daemon: every session belongs to the window that
              started it and ends when its tab closes. There is no fleet to list — only the tabs
              you can already see. Upgrade prime-agent (or point Prime Studio at a build whose
              <code> --help</code> offers <code>-d, --background</code>) to keep agents running
              across restarts.
            </p>
          ) : report.error ? (
            <p className="fleet-empty">
              No daemon answered. Nothing is running, or it is on a different socket.
              <pre className="cli-error">{report.error}</pre>
            </p>
          ) : !agents.length ? (
            <p className="fleet-empty">
              No agents are running. Sessions you start now stay alive when their tab closes, and
              will appear here.
            </p>
          ) : (
            <>
              <div className="fleet-counters">
                {(["running", "detached", "idle", "retained"] as State[]).map((s) => (
                  <div key={s} className="fleet-counter">
                    <span className="fleet-counter-label">
                      {s === "retained" ? "RETAINED CHILD" : STATE_LABEL[s]}
                    </span>
                    <span className={`fleet-counter-n s-${s}`}>{counts[s]}</span>
                  </div>
                ))}
                <div className="fleet-counter">
                  <span className="fleet-counter-label">ATTACHED HERE</span>
                  <span className="fleet-counter-n">{attachedHere}</span>
                </div>
                <div className="fleet-counter fleet-counter-spend">
                  <span className="fleet-counter-label">SPEND, LIVE AGENTS</span>
                  <span className="fleet-counter-n">{money(spend(agents))}</span>
                </div>
              </div>

              {groups.map((g) => (
                <div key={g.id ?? "unfiled"} className="fleet-group">
                  <div className="fleet-group-head">
                    <span className={`dot p-${accountProvider(accounts, g.id) || "none"}`} />
                    <strong>{g.id ? accountLabel(accounts, g.id) : "Outside any profile"}</strong>
                    {g.id && statuses[g.id] !== undefined && (
                      <span className={`pill pill-${HEALTH_PILL[health(statuses[g.id])]}`}>
                        {healthLabel(statuses[g.id])}
                      </span>
                    )}
                    <span className="fleet-note">
                      {g.rows.length} agent{g.rows.length === 1 ? "" : "s"} · {money(spend(g.rows))}
                    </span>
                  </div>

                  {g.rows.map((a) => {
                    const state = stateOf(a);
                    const stem = a.sessionFile?.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? "";
                    return (
                      <div key={a.id} className={`fleet-row ${a.depth > 0 ? "child" : ""}`}>
                        <span className={`fleet-dot s-${state}`} />
                        <div className="fleet-name">
                          <div className="fleet-title" title={rowName(a)}>
                            {a.depth > 0 && <span className="fleet-arrow">↳</span>}
                            {rowName(a)}
                          </div>
                          <div className="fleet-meta">
                            {[folder(a.cwd), a.id, clientsNote(a)].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <span className={`fleet-state s-${state}`}>{STATE_LABEL[state]}</span>
                        <span className="fleet-model">{a.model ?? "—"}</span>
                        <span className="fleet-signal">{signal(a)}</span>
                        <span className="fleet-cost">
                          {a.cost === null
                            ? "—"
                            : a.depth > 0
                              ? `${money(a.cost)} in parent`
                              : money(a.cost)}
                          {a.tokens ? <em>{compact.format(a.tokens)} tok</em> : null}
                        </span>
                        <span className="fleet-actions">
                          <button
                            className={`btn ${a.attachedHere ? "" : "btn-send"}`}
                            disabled={busy === a.id || a.attachedHere}
                            title={
                              a.attachedHere
                                ? "This window already has a client on this agent"
                                : "Open a tab driving this agent"
                            }
                            onClick={() => onAttach(a)}
                          >
                            {a.attachedHere ? "FOCUS" : "ATTACH"}
                          </button>
                          <button
                            className="btn"
                            disabled={!stem}
                            title="Open the transcript read-only (a snapshot, not a live follow)"
                            onClick={() => onRead(stem, a.accountId)}
                          >
                            READ
                          </button>
                          <button className="btn" disabled={busy === a.id} onClick={() => rename(a)}>
                            RENAME
                          </button>
                          <button
                            className="btn btn-danger"
                            disabled={busy === a.id}
                            title="End this agent's work"
                            onClick={() => setConfirmStop(a)}
                          >
                            STOP
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}

              <div className="fleet-footer">
                <span className="fleet-counter-label">WHILE YOU WERE GONE</span>
                <span className="fleet-note">
                  {gone.moved.length || gone.fresh.length
                    ? [
                        gone.moved.length &&
                          `${gone.moved.length} agent${gone.moved.length === 1 ? "" : "s"} advanced by ${gone.added} message${gone.added === 1 ? "" : "s"}`,
                        gone.fresh.length && `${gone.fresh.length} not seen here before`,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Nothing moved since this window last looked."}
                </span>
              </div>
            </>
          )}
        </div>

        {confirmStop && (
          <StopConfirmation
            agent={confirmStop}
            restoreFallbackRef={closeRef}
            onClose={() => setConfirmStop(null)}
            onConfirm={() => {
              const agent = confirmStop;
              setConfirmStop(null);
              void act(agent.id, () => rpc.stopAgent(agent.id));
            }}
          />
        )}
      </div>
    </div>
  );
}
