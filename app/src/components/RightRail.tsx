import { useEffect, useState } from "react";
import * as rpc from "../rpc";
import { ModelSelect, ThinkingSelect } from "./Pickers";
import type {
  ChildState,
  KernelStatus,
  ModelInfo,
  SessionStats,
  ThinkingLevel,
  TouchedFile,
} from "../types";

// en-US, not the OS locale: an Indian locale renders a 1,000,000-token window as
// "10L", which is not what a context meter is supposed to say.
const fmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** One probe per app run: the interpreter behind the kernel does not move. */
let kernelOnce: Promise<KernelStatus> | null = null;

export function useKernel(): KernelStatus | null {
  const [k, setK] = useState<KernelStatus | null>(null);
  useEffect(() => {
    kernelOnce ??= rpc.kernelStatus();
    let live = true;
    void kernelOnce.then((v) => live && setK(v));
    return () => {
      live = false;
    };
  }, []);
  return k;
}

/** `python 3.11 · ready · 4 vars` — except prime exposes no variable list, so no vars. */
export function kernelLine(k: KernelStatus | null): string {
  if (!k) return "kernel …";
  if (!k.exists) return `no interpreter · ${k.error ?? "python not found"}`;
  const py = k.version?.replace(/^Python\s+/i, "") ?? "python";
  return `python ${py} · ${k.ipykernel ? "ready" : "no ipykernel — tools cannot run"}`;
}


/** Refresh the repository summary when a turn changes working state. */
function FilesTouched({ cwd, turns, busy }: { cwd: string | null; turns: number; busy: boolean }) {
  const [files, setFiles] = useState<TouchedFile[]>([]);
  useEffect(() => {
    if (!cwd) return setFiles([]);
    let live = true;
    void rpc.filesTouched(cwd).then((f) => live && setFiles(f));
    return () => {
      live = false;
    };
  }, [cwd, turns, busy]);

  // A panel with nothing to say does not occupy space saying nothing.
  if (!files.length) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <section className="rail-block">
      <div className="rail-head">
        <span className="rail-label">FILES TOUCHED</span>
        <span className="spacer" />
        {/* Not an approval queue: prime applied these the moment it ran them. */}
        <span className="rail-note" title="Prime applies every edit immediately — there is no approval step. Review them in git.">
          applied · review in git
        </span>
      </div>
      <div className="files">
        {files.map((f) => (
          <div className="file-row" key={f.path} title={f.path}>
            <span className="file-path">{f.path}</span>
            {f.untracked ? (
              <span className="file-new">new</span>
            ) : (
              <>
                {f.added > 0 && <span className="file-add">+{f.added}</span>}
                {f.removed > 0 && <span className="file-del">-{f.removed}</span>}
              </>
            )}
          </div>
        ))}
      </div>
      {(added || removed) > 0 && (
        <div className="rail-note">
          {files.length} file{files.length === 1 ? "" : "s"} · +{added} -{removed}
        </div>
      )}
    </section>
  );
}

function Meter({
  label,
  value,
  segments,
}: {
  label: string;
  value: React.ReactNode;
  /** Widths as percentages, drawn left to right on one 3px track. */
  segments?: { pct: number; cls: string }[];
}) {
  return (
    <div className="rail-meter">
      <div className="rail-meter-head">
        <span className="rail-k">{label}</span>
        <span className="rail-v">{value}</span>
      </div>
      {segments && (
        <div className="rail-track">
          {segments.map((s, i) => (
            <div key={i} className={`rail-fill ${s.cls}`} style={{ width: `${s.pct}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Session measurements and interpreter health live beside the transcript.
 * Goal and gate rows are absent because RPC sessions expose neither value; the
 * repository summary remains available because git can report it directly.
 */
export function RightRail({
  stats,
  children,
  turns,
  models,
  model,
  onModel,
  thinking,
  onThinking,
  cwd,
  busy,
}: {
  stats: SessionStats | null;
  children: ChildState[];
  turns: number;
  /** The session's working folder — git's view of it is the files-touched list. */
  cwd: string | null;
  busy: boolean;
  models: ModelInfo[];
  model: { provider: string; model: string } | null;
  onModel: (provider: string, model: string) => void;
  thinking: ThinkingLevel;
  onThinking: (l: ThinkingLevel) => void;
}) {
  const kernel = useKernel();
  const ctx = stats?.contextUsage;
  const total = stats?.cost ?? 0;
  // Child spend is attributed to the parent, so it is a SLICE of the total, never
  // an addition — the two segments always sum to the number printed above them.
  const kids = Math.min(
    children.reduce((n, c) => n + c.cost, 0),
    total,
  );
  const pct = total > 0 ? (kids / total) * 100 : 0;

  return (
    <aside className="rail">
      <section className="rail-block">
        <div className="rail-head">
          <span className="rail-label">SESSION</span>
          <span className="spacer" />
          <ModelSelect
            models={models}
            model={model}
            onModel={onModel}
            className="rail-chip"
          />
          <ThinkingSelect thinking={thinking} onThinking={onThinking} className="rail-chip" />
        </div>

        <Meter
          label="context"
          value={ctx ? `${fmt.format(ctx.tokens)} / ${fmt.format(ctx.contextWindow)}` : "—"}
          segments={
            ctx ? [{ pct: Math.min(100, ctx.percent), cls: "fill-accent" }] : undefined
          }
        />
        <Meter
          label={children.length ? "spend · children" : "spend"}
          value={
            <>
              ${total.toFixed(2)}
              {children.length > 0 && <span className="rail-kids"> incl. ${kids.toFixed(2)}</span>}
            </>
          }
          segments={
            total > 0
              ? [
                  { pct: 100 - pct, cls: "fill-own" },
                  { pct, cls: "fill-accent" },
                ]
              : undefined
          }
        />
        {/* No turn limit exists without an autonomous run, so no denominator and
            no bar — a meter with an invented maximum would be a lie. */}
        <Meter label="turns" value={String(turns)} />
        {children.length > 0 && (
          <div className="rail-note">children counted in parent</div>
        )}
      </section>

      <FilesTouched cwd={cwd} turns={turns} busy={busy} />

      <section className="rail-block rail-kernel">
        <div className="rail-head">
          <span className="rail-label accent">KERNEL</span>
          <span className="rail-kernel-line">{kernelLine(kernel)}</span>
        </div>
        {kernel?.python && <div className="rail-note mono">{kernel.python}</div>}
        {/* The RPC reports interpreter health, but not the live kernel namespace. */}
        <div className="rail-note">
          Prime's only tool is this IPython kernel. Python state survives cells, turns and
          compaction; shell state does not survive between <code>%%bash</code> cells.
        </div>
      </section>
    </aside>
  );
}
