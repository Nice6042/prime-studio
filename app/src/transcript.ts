// Pure view-model helpers for the transcript column. No React, no Tauri — the
// heuristics live here, alone, so they can be tuned (and checked) in one place.
// `npm run check` replays these against the synthetic Prime stream.
import type { ChatState } from "./reducer";
import type { ChildState, TextBlock, TimelineItem, ToolState } from "./types";

const LANGS: Record<string, string> = {
  ipython: "python",
  python: "python",
  bash: "bash",
  shell: "bash",
  sh: "bash",
};

/** `args.code` is the payload for ipython/bash; everything else shows its JSON. */
export function cellSource(tool: { name: string; args: Record<string, unknown> }): {
  code: string;
  lang: string;
} {
  const code = tool.args?.code;
  if (typeof code === "string") return { code, lang: LANGS[tool.name] ?? "python" };
  const cmd = tool.args?.command;
  if (typeof cmd === "string") return { code: cmd, lang: "bash" };
  return { code: JSON.stringify(tool.args ?? {}, null, 2), lang: "json" };
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** `%%bash`, `%cd`, `!pip` … — magics say how a cell runs, never what it found. */
const isMagic = (l: string) => /^\s*[%!]/.test(l);

/** Python exception lines: the last one in a traceback is the actual failure. */
const EXCEPTION = /^[\w.]*(?:Error|Exception|Exit|Failure)\b.*/;

/**
 * Prime reports `isError: false` for a cell whose code ran but whose *content*
 * failed — a Python traceback in the output, a shell command that was not found.
 * Verified live: `python -c "import tracer"` under `%%bash` came back
 * `isError:false` with `exit code: 127`. So failure is read out of the output as
 * well, or "auto-expand on error" would never once fire.
 *
 * Tune here; nothing else decides what counts as a failed cell.
 */
const FAILURE = [
  /^Traceback \(most recent call last\)/m,
  /^[A-Za-z_.]*(?:Error|Exception): /m,
  /: command not found/,
  /No such file or directory/,
  /^\s*exit code: (?!0\b)\d+/m,
];

export function cellFailed(tool: Pick<ToolState, "status" | "output" | "details">): boolean {
  if (tool.status === "error") return true;
  if (tool.status === "running") return false;
  const text = `${tool.output ?? ""}\n${tool.details?.stderr ?? ""}`;
  return FAILURE.some((re) => re.test(text));
}

/**
 * Decoration, not a finding: bare rules (`------`) and the banners a model prints
 * around its own output (`--- bash identity ---`). Both showed up as cell captions
 * in a live session before this existed.
 */
const isRule = (l: string) =>
  !/[A-Za-z0-9]/.test(l) || /^[-=*_#~]{3,}/.test(l) || /[-=*_#~]{3,}$/.test(l);

/** `rlm(...)`/`name="lane-0"` — a spawn cell can be captioned from its own code. */
const SPAWN = /\brlm\s*\(/;
const NAMED = /name\s*=\s*["']([^"']+)["']/g;

export interface Caption {
  text: string;
  /** `error` captions are styled as the failure and force the cell open. */
  kind: "error" | "finding" | "command";
}

/**
 * Caption a cell with what it FOUND, not what it ran — the command is one click
 * away and is rarely the answer to "what happened?".
 *
 * Order, most informative first:
 *   1. failed → the exception line (last one wins: that's the raised error),
 *      else the last line of output.
 *   2. spawned subagents → the names it created, read out of its own source.
 *   3. produced output → its first meaningful line, which for a REPL cell is the
 *      value or the print the model wrote the cell to get.
 *   4. nothing to show → fall back to the command, skipping cell magics.
 */
export function findingCaption(tool: ToolState): Caption {
  const out = lines(tool.output ?? "");
  if (cellFailed(tool)) {
    const err = lines(String(tool.details?.stderr ?? ""));
    const pool = [...out, ...err].filter((l) => !isRule(l));
    const exc = [...pool].reverse().find((l) => EXCEPTION.test(l));
    return { text: squash(exc ?? pool[pool.length - 1] ?? "cell failed"), kind: "error" };
  }

  const { code } = cellSource(tool);
  if (SPAWN.test(code)) {
    // Names come from the source when they are literals, and from the returned
    // handles when they are not: a `name=f"lane-{i}"` loop — the shape the design
    // is built around — has no literal to read, but its RLMSpawnHandle repr does.
    const names = [
      ...new Set(
        [...code.matchAll(NAMED), ...(tool.output ?? "").matchAll(NAMED)].map((m) => m[1]),
      ),
    ];
    return {
      text: names.length
        ? `spawned ${names.join(", ")} as retained children`
        : "spawned subagents",
      kind: "finding",
    };
  }

  const first = out.find((l) => !isMagic(l) && !isRule(l));
  if (first) return { text: squash(first), kind: "finding" };

  const cmd = lines(code).find((l) => !isMagic(l)) ?? lines(code)[0] ?? tool.name;
  return { text: squash(cmd), kind: "command" };
}

/** Openers that mark a paragraph as a conclusion rather than progress commentary. */
const VERDICT_CUE =
  /^(verdict|conclusion|decision|recommendation|bottom line|in short|net[- ]net|summary)\b[:—-]?|^(so|therefore),/i;

/** A one-line "ok, done." is a sign-off, not a verdict worth its own block. */
const VERDICT_MIN_CHARS = 60;

/**
 * Does this assistant text block state a conclusion?
 *
 * Two ways in, both cheap to tune:
 *   - it opens with a decision cue ("Verdict:", "So, …", "Bottom line …"), or
 *   - it closes the whole exchange: the last text of the last assistant message,
 *     with the turn settled.
 *
 * `closesTurn` is the load-bearing one, and it is narrow on purpose. A live
 * session showed why: prime ends a turn after every tool call, so "last text of a
 * finished message" matched five times in one exchange and boxed each throwaway
 * remark ("Interesting — the failure wasn't the one I expected. Let me
 * diagnose."). A message that still goes on to run a cell is a prelude, not a
 * conclusion, so the caller must exclude those — see `Message.tsx`.
 *
 * Never invents: it only changes how text the model actually wrote is styled.
 */
export function isVerdict(
  text: string,
  opts: { closesTurn: boolean; streaming: boolean; busy: boolean; quiet?: boolean },
): boolean {
  const body = text.trim();
  if (body.length < VERDICT_MIN_CHARS) return false;
  if (VERDICT_CUE.test(body)) return true;
  // A plain Q&A has no progress commentary for a conclusion to stand apart from,
  // so boxing its only paragraph adds chrome to the calmest turn there is.
  if (opts.quiet) return false;
  return opts.closesTurn && !opts.streaming && !opts.busy;
}

/** Text blocks only — `last` in `isVerdict` means the last of these. */
export const textBlocks = (item: Extract<TimelineItem, { kind: "assistant" }>) =>
  item.blocks.filter((b) => b.type === "text" && String((b as TextBlock).text ?? "").trim());

/**
 * Group prime's own child `status` word into the three things the UI does
 * differently. The status string itself is still what gets printed — this only
 * decides the dot colour and which action the row offers.
 *
 * `returned`/`idle`/`retained` children stay addressable via `agent_message`,
 * which is the one action prime can actually perform on a child.
 */
export type ChildPhase = "running" | "retained" | "waiting";
export function childPhase(status: string): ChildPhase {
  const s = status.toLowerCase();
  if (/return|done|complete|idle|retain|finish/.test(s)) return "retained";
  if (/queue|wait|block|admit/.test(s)) return "waiting";
  return "running";
}

/**
 * Which cell spawned which child — the strip has to sit under its own cell.
 *
 * Two links, either is enough: the cell that was in flight when prime announced
 * the child (recorded by the reducer), or the child's name appearing literally in
 * the cell's source. The second alone is not enough — `name=f"lane-{i}"` in a
 * loop never matches — and the first alone loses children announced between
 * cells, so both are kept.
 */
export function childrenForCell(children: ChildState[], tool: ToolState): ChildState[] {
  const { code } = cellSource(tool);
  return children.filter((c) => c.cell === tool.cellNo || code.includes(c.name));
}

/**
 * The plain-language "what is happening right now" sentence, or null when idle.
 * Composed only from live state: running children, the cell in flight, and how
 * long it has been in flight.
 */
export function statusSentence(
  state: ChatState,
  opts: { elapsedSec?: number } = {},
): string | null {
  if (!state.busy) return null;
  const kids = Object.values(state.children);
  const running = kids.filter((c) => childPhase(c.status) === "running").map((c) => c.name);
  const waiting = kids.filter((c) => childPhase(c.status) === "waiting");
  const cell = Object.values(state.tools).find((t) => t.status === "running");
  const secs = opts.elapsedSec ? `, ${opts.elapsedSec}s` : "";

  const parts: string[] = [];
  if (running.length) {
    parts.push(
      running.length === 1
        ? `Running ${running[0]}`
        : `Running ${running.length} subagents (${running.join(", ")})`,
    );
  }
  for (const c of waiting) parts.push(`${c.name} ${c.status}`);
  if (cell) {
    const what = findingCaption({ ...cell, status: "ok", output: "" }).text;
    parts.push(`cell ${cell.cellNo} in flight — ${what.slice(0, 60)}${secs}`);
  }
  if (!parts.length) return `Thinking${secs}.`;
  const [head, ...rest] = parts;
  return `${head}${rest.length ? `; ${rest.join("; ")}` : ""}.`;
}

/**
 * A quiet turn: nothing ran, nothing was spawned. Everything with nothing to say
 * disappears — no rail, no meters, no cell chrome — and the column is a chat app.
 */
export const isQuiet = (state: ChatState) =>
  Object.keys(state.tools).length === 0 && Object.keys(state.children).length === 0;
