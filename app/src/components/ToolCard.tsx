import { useState } from "react";
import { cellFailed, childPhase, cellSource, findingCaption } from "../transcript";
import type { ChildState, ToolCallBlock, ToolState } from "../types";

/** Sub-second cells are the common case, so they get two decimals, not "0.0s". */
const secs = (ms?: number) =>
  typeof ms !== "number" ? "" : `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;

export interface ChildActions {
  /** Ask the running session to message a retained child. */
  onMessageChild: (name: string, text: string) => void;
  /** Open a child's own transcript read-only, from its reported session dir. */
  onOpenChild: (child: ChildState) => void;
}

/**
 * One subagent line, captioned with prime's own status word.
 *
 * The action matches what the state supports: MESSAGE for a child that is still
 * addressable, READ for a running one (prime has no live child-stream view, so
 * this opens its transcript read-only and says so), and nothing for a child that
 * is only queued — a button that cannot do its job is worse than no button.
 */
function ChildRow({ child, actions }: { child: ChildState; actions: ChildActions }) {
  const [draft, setDraft] = useState<string | null>(null);
  const phase = childPhase(child.status);

  const send = () => {
    const t = (draft ?? "").trim();
    if (t) actions.onMessageChild(child.name, t);
    setDraft(null);
  };

  return (
    <>
      <span className={`child child-${phase}`}>
        <span className="child-dot" />
        <span className="child-name">{child.name}</span>
        <span className="child-phase">{child.status}</span>
        {child.model && <span className="child-model">{child.model}</span>}
        {child.cost > 0 && (
          <span className="child-cost" title="Child spend is attributed to the parent">
            ${child.cost.toFixed(2)} in parent
          </span>
        )}
        {phase === "retained" && (
          <button
            className="child-act"
            onClick={() => setDraft((d) => (d === null ? "" : null))}
            aria-expanded={draft !== null}
          >
            MESSAGE
          </button>
        )}
        {phase === "running" && child.sessionDir && (
          <button
            className="child-act"
            title="Opens this child's transcript read-only. Prime has no live child stream view, so this is a snapshot of what it has written so far."
            onClick={() => actions.onOpenChild(child)}
          >
            READ
          </button>
        )}
      </span>
      {draft !== null && (
        <span className="child-compose">
          <input
            autoFocus
            value={draft}
            placeholder={`Message ${child.name}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <button className="child-act" onClick={send}>
            SEND
          </button>
        </span>
      )}
    </>
  );
}

/**
 * A cell: one muted mono line captioned with what it FOUND. Subordinate to the
 * prose around it by design — the command and the full output are one click away,
 * except on failure, which opens itself.
 */
export function ToolCard({
  block,
  tool,
  children,
  actions,
}: {
  block: ToolCallBlock;
  tool?: ToolState;
  /** Subagents this cell spawned, rendered as a strip under its line. */
  children?: ChildState[];
  actions: ChildActions;
}) {
  // null = the user has not decided, so the error state gets to open the cell.
  // A plain `useState(false)` could never reopen: status flips to "error" long
  // after mount, when tool_execution_end lands.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const unavailable = !tool;
  const state: ToolState = tool ?? {
    id: block.id,
    name: block.name,
    args: block.arguments ?? {},
    status: "ok",
    output: "",
    cellNo: 0,
  };
  // Failure is read from the output too: prime says isError:false for a cell that
  // ran fine but whose command failed inside it.
  const failed = cellFailed(state);
  const open = userOpen ?? failed;
  const caption = unavailable
    ? { text: "result not resident in this view", kind: "command" as const }
    : findingCaption(state);
  const { code } = cellSource(state);
  const duration = secs(state.details?.durationMs as number | undefined);

  return (
    <div className={`cell ${failed ? "cell-error" : `cell-${state.status}`}`}>
      <button
        className="cell-head"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="cell-no">CELL {state.cellNo || "—"}</span>
        <span className={`cell-cap cap-${caption.kind}`}>
          {state.status === "running" && !state.output ? "running…" : caption.text}
        </span>
        {duration && <span className="cell-dur">{duration}</span>}
        <span className="cell-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="cell-body">
          <pre className="cell-code">{code}</pre>
          {state.output && <pre className="cell-out">{state.output}</pre>}
        </div>
      )}
      {!!children?.length && (
        <div className="child-strip">
          {children.map((c) => (
            <ChildRow key={c.id} child={c} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}
