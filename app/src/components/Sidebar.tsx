import { useMemo, useState } from "react";
import type { DiskSession, FleetAgent } from "../types";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** Sessions carry either epoch seconds or millis depending on the field. */
function relative(raw?: number): string {
  if (!raw) return "";
  const ms = raw < 1e12 ? raw * 1000 : raw;
  const secs = (ms - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return rtf.format(Math.round(secs), "second");
}

const when = (s: DiskSession) => s.mtime ?? s.timestamp ?? 0;
const folder = (cwd?: string | null) => cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "no folder";

/**
 * One folder, one group. Prime records a cwd however the caller spelled it, so
 * the same directory arrives as both `…\scratchpad\smoke` and `…/scratchpad/smoke`
 * and would otherwise split into two groups with the same name.
 */
const groupKey = (cwd?: string | null) =>
  (cwd ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();


/**
 * Prime's own status words, mapped to the three things a user does differently:
 * watch it (running), reattach it (detached), or leave it (idle). The tooltip
 * still carries prime's verbatim word so nothing is lost in the mapping.
 */
function agentState(a?: FleetAgent): { cls: string; label: string } | null {
  if (!a) return null;
  if (a.streaming || a.runningTools || /run|stream|busy|work/i.test(a.activity))
    return { cls: "live", label: "RUNNING" };
  if (a.clients === 0) return { cls: "warn", label: "DETACHED" };
  return { cls: "idle", label: "IDLE" };
}

/** Sessions grouped by the working folder that bounds their filesystem context. */
export function Sidebar({
  sessions,
  activeId,
  accountName,
  onSelect,
  onNew,
  onRefresh,
  agents,
  searchRef,
}: {
  sessions: DiskSession[];
  activeId: string | null;
  /** Whose history is listed — each account keeps its own sessions dir. */
  accountName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  /** Live agents, joined by session id so a row can say what it is doing now. */
  agents: FleetAgent[];
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  /**
   * A disk transcript and a running agent are the same session seen two ways.
   * Joined on prime's own session id so a row can carry live state instead of
   * only a timestamp. Sessions with no agent are simply history.
   */
  const live = useMemo(() => {
    const by = new Map<string, FleetAgent>();
    for (const a of agents) {
      if (a.sessionId) by.set(a.sessionId, a);
      // The id is also the transcript's filename stem for file-backed rows.
      const stem = a.sessionFile?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "");
      if (stem) by.set(stem, a);
    }
    return by;
  }, [agents]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const by = new Map<string, { key: string; name: string; cwd: string; items: DiskSession[] }>();
    for (const s of sessions) {
      if (needle && !`${s.title ?? ""} ${s.cwd ?? ""}`.toLowerCase().includes(needle)) continue;
      const key = groupKey(s.cwd);
      const g = by.get(key) ?? { key, name: folder(s.cwd), cwd: s.cwd ?? "", items: [] };
      g.items.push(s);
      by.set(key, g);
    }
    const list = [...by.values()];
    // Two different checkouts can both end in `smoke`. Where the leaf repeats,
    // show the parent segment too rather than two identical-looking groups.
    const seen = new Map<string, number>();
    for (const g of list) seen.set(g.name, (seen.get(g.name) ?? 0) + 1);
    for (const g of list) {
      if ((seen.get(g.name) ?? 0) > 1) {
        const parts = g.cwd.split(/[\\/]/).filter(Boolean);
        if (parts.length > 1) g.name = `${parts[parts.length - 2]}/${g.name}`;
      }
    }
    for (const g of list) g.items.sort((a, b) => when(b) - when(a));
    // Most recently touched project first — the one you are working in now.
    list.sort((a, b) => when(b.items[0]) - when(a.items[0]));
    return list;
  }, [sessions, q]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="btn btn-new" onClick={onNew} title="New session (Ctrl+N)">
          New session
        </button>
        <button className="btn btn-icon" onClick={onRefresh} title="Refresh sessions">
          ⟳
        </button>
      </div>

      <div className="search-wrap">
        <input
          ref={searchRef}
          type="search"
          aria-label="Search sessions"
          className="search"
          value={q}
          placeholder="Search sessions"
          onChange={(e) => setQ(e.target.value)}
        />
        <kbd title="Ctrl+F focuses this; Ctrl+K opens the command palette">Ctrl+F</kbd>
      </div>

      <div className="side-label" title={`History is per account — showing ${accountName}`}>
        PROJECTS
      </div>

      <div className="session-list">
        {groups.length === 0 && (
          <p className="rail-empty">
            {sessions.length
              ? "No sessions match that search."
              : "Sessions group by working folder. Your first one will start this list."}
          </p>
        )}

        {groups.map((g) => {
          const shut = closed[g.key];
          return (
            <div className="project" key={g.key || "(none)"}>
              <button
                className="project-head"
                aria-expanded={!shut}
                title={g.cwd || "No working folder"}
                onClick={() => setClosed((c) => ({ ...c, [g.key]: !c[g.key] }))}
              >
                <span className="project-chev">{shut ? "▸" : "▾"}</span>
                <span className="project-name">{g.name}</span>
                <span className="project-n">{g.items.length}</span>
              </button>

              {!shut &&
                g.items.map((s) => {
                    const a = live.get(s.id);
                    const state = agentState(a);
                    return (
                      <button
                        key={s.id}
                        className={`session ${activeId === s.id ? "active" : ""}`}
                        onClick={() => onSelect(s.id)}
                        title={a ? `${s.cwd ?? s.id} — ${a.activity}` : (s.cwd ?? s.id)}
                      >
                        {state && <span className={`dot ${state.cls}`} />}
                        <span className="session-title">
                          {s.title?.trim() || "Untitled session"}
                        </span>
                        {state ? (
                          <span className={`session-qual ${state.cls}`}>{state.label}</span>
                        ) : (
                          <span className="session-when">{relative(when(s))}</span>
                        )}
                      </button>
                    );
                })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
