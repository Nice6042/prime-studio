import { useEffect, useMemo, useRef, useState } from "react";

export interface Cmd {
  id: string;
  /** Category header. Groups render in the order they first appear in `cmds`. */
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Substring match with a prefix boost. Returns the match offset and a score, or
 * null for a miss.
 *
 * ponytail: no fuzzy-search dependency. If subsequence matching ("nc" -> "New
 * chat") is ever wanted, that is the upgrade point.
 */
function match(label: string, q: string): { at: number; score: number } | null {
  if (!q) return { at: -1, score: 0 };
  const at = label.toLowerCase().indexOf(q);
  if (at < 0) return null;
  // Start-of-string beats start-of-word beats anywhere; earlier beats later.
  const boost = at === 0 ? 2000 : /[\s/\\.\-_]/.test(label[at - 1]) ? 1000 : 0;
  return { at, score: boost - at };
}

function Highlight({ text, at, len }: { text: string; at: number; len: number }) {
  if (at < 0 || len === 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + len)}</mark>
      {text.slice(at + len)}
    </>
  );
}

/** Ctrl/Cmd+K palette. Keyboard-only: type to filter, ↑/↓, Enter, Esc. */
export function Palette({ cmds, onClose }: { cmds: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const query = q.trim().toLowerCase();

  /** Flat render list — group headers interleaved — plus the selectable subset. */
  const { rows, items } = useMemo(() => {
    const hits = cmds
      .map((c) => ({ c, m: match(c.label, query) }))
      .filter((h): h is { c: Cmd; m: { at: number; score: number } } => h.m !== null);

    const order = new Map<string, number>();
    for (const c of cmds) if (!order.has(c.group)) order.set(c.group, order.size);
    hits.sort(
      (a, b) =>
        (order.get(a.c.group) ?? 0) - (order.get(b.c.group) ?? 0) || b.m.score - a.m.score,
    );

    const rows: ({ head: string } | { c: Cmd; at: number; i: number })[] = [];
    const items: Cmd[] = [];
    let group = "";
    for (const h of hits) {
      if (h.c.group !== group) {
        group = h.c.group;
        rows.push({ head: group });
      }
      rows.push({ c: h.c, at: h.m.at, i: items.length });
      items.push(h.c);
    }
    return { rows, items };
  }, [cmds, query]);

  useEffect(() => setSel(0), [query]);

  // Keep the cursor on a real row when the result count shrinks.
  const active = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector("[data-on='1']")?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const run = (c?: Cmd) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Search sessions, models, accounts, actions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // Handled here, not on window: ChatPane has a window-level Escape that
          // aborts a running turn, and closing the palette must not also abort.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(items.length ? (active + 1) % items.length : 0);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(items.length ? (active - 1 + items.length) % items.length : 0);
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(items[active]);
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="palette-empty muted">No matches</div>}
          {rows.map((r) =>
            "head" in r ? (
              <div key={`h-${r.head}`} className="palette-head">
                {r.head}
              </div>
            ) : (
              <div
                key={r.c.id}
                className={`palette-row ${r.i === active ? "on" : ""}`}
                data-on={r.i === active ? "1" : "0"}
                onMouseMove={() => setSel(r.i)}
                onClick={() => run(r.c)}
              >
                <span className="palette-label">
                  <Highlight text={r.c.label} at={r.at} len={query.length} />
                </span>
                {r.c.hint && <span className="palette-hint muted">{r.c.hint}</span>}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
