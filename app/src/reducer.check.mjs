// Self-check: replay the synthetic prime-agent stream (../../dev/rpc-raw.log)
// through the transcript reducer and assert the transcript it produces.
// Both committed fixtures are deterministic synthetic inputs.
//   node src/reducer.check.mjs
// Bundles reducer.ts with the esbuild that already ships inside vite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = path.resolve(here, "../../dev/rpc-raw.log");

async function load(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [path.join(here, entry)],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
  });
  return import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
  );
}

const { reduce, empty } = await load("reducer.ts");
const { findingCaption, cellFailed, isVerdict, statusSentence, isQuiet, childrenForCell } =
  await load("transcript.ts");

const events = fs
  .readFileSync(log, "utf8")
  .split("\n")
  .filter(Boolean)
  // Ignore malformed lines if a fixture is deliberately extended with framing cases.
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

// Keep the persisted-history shape separate so the same deterministic messages
// exercise both the live-event and disk-session reducer paths.
const shapes = JSON.parse(fs.readFileSync(path.resolve(here, "../../dev/rpc-shapes.json"), "utf8"));
const agentEnd = shapes.agent_end;

let state = empty;
for (const e of [...events, agentEnd]) {
  if (e.type === "response") continue;
  state = reduce(state, { t: "event", e });
}

// The synthetic run: one prompt -> assistant text + ipython call -> assistant reply.
const assistants = state.timeline.filter((i) => i.kind === "assistant");
assert.equal(state.timeline.length, 2, "user echo must not create bubbles");
assert.equal(assistants.length, 2, "two assistant messages");
assert.equal(state.busy, false, "agent_end clears busy");
assert.ok(assistants.every((a) => !a.streaming), "no bubble left streaming");

const first = assistants[0];
assert.equal(first.blocks[0].text, "I'll create the file.");
const call = first.blocks.find((b) => b.type === "toolCall");
assert.ok(call, "toolCall block preserved inline");
assert.ok(assistants[1].blocks[0].text.includes("done"));
assert.ok(typeof first.cost === "number" && first.cost > 0, "message_end carries cost");

const tool = state.tools[call.id];
assert.equal(tool.name, "ipython");
assert.equal(tool.status, "ok");
assert.ok(tool.args.code.includes("write_text"), "ipython args.code captured");
assert.equal(tool.output, "True 'OK\\n'\n", "tool_execution_end output captured");
assert.equal(tool.cellNo, 1, "cells are numbered in the order the session ran them");
assert.deepEqual(state.children, {}, "no children in this capture");

// The disk-session path (read_disk_session -> messages) must rebuild the same view.
const loaded = reduce(empty, { t: "load", messages: agentEnd.messages });
assert.equal(loaded.timeline.length, 3, "user bubble + two assistant bubbles");
assert.equal(loaded.timeline[0].kind, "user");
assert.ok(loaded.timeline[0].text.startsWith("Create a file fixture.txt"));
assert.ok(loaded.timeline.slice(1).every((i) => i.kind === "assistant" && !i.streaming));
assert.equal(loaded.tools[call.id].status, "ok");
assert.equal(loaded.tools[call.id].output, "True 'OK\\n'\n");
assert.ok(loaded.tools[call.id].args.code.includes("write_text"), "args recovered from toolCall block");

// A steer lands a user bubble mid-stream; the stream must keep filling the
// assistant bubble already open, not fork a duplicate below the steer.
const firstEnd = events.findIndex((e) => e.type === "message_end" && e.message.role === "assistant");
const updates = events
  .slice(0, firstEnd)
  .filter((e) => e.type === "message_update" && e.message.role === "assistant");
let steered = reduce(empty, { t: "event", e: updates[0] });
steered = reduce(steered, { t: "user", text: "actually, use pathlib" });
for (const e of updates.slice(1)) steered = reduce(steered, { t: "event", e });
assert.equal(
  steered.timeline.filter((i) => i.kind === "assistant").length,
  1,
  "steering mid-stream must not fork the assistant bubble",
);
assert.equal(steered.timeline.at(-1).kind, "user", "steer bubble stays where it was sent");
assert.ok(steered.timeline[0].blocks.some((b) => b.type === "toolCall"), "stream kept filling the open bubble");

assert.equal(loaded.tools[call.id].cellNo, 1, "cell numbers survive the disk path");

// ---- transcript view model ------------------------------------------------

// A cell is captioned with what it FOUND, so the collapsed line answers "what
// happened?" rather than repeating the command.
assert.equal(findingCaption(tool).text, "True 'OK\\n'", "success caption is the finding");
assert.equal(findingCaption(tool).kind, "finding");

const failed = {
  ...tool,
  status: "error",
  output:
    "Traceback (most recent call last):\n  File \"<stdin>\", line 1\n" +
    "ModuleNotFoundError: No module named 'tracer'\n",
};
assert.equal(
  findingCaption(failed).text,
  "ModuleNotFoundError: No module named 'tracer'",
  "error caption is the raised exception, not the traceback header",
);
assert.equal(findingCaption(failed).kind, "error", "error captions force the cell open");

// Falls back to the command only when there is nothing better, skipping magics.
const silent = { ...tool, output: "", args: { code: "%%bash\npytest bench/ -q\n" } };
assert.equal(findingCaption(silent).text, "pytest bench/ -q");
assert.equal(findingCaption(silent).kind, "command");

// A spawn cell can name its own children out of its source.
const spawn = {
  ...tool,
  output: "",
  args: { code: 'h = [await rlm("go", name="lane-0"), await rlm("go", name="lane-1")]' },
};
assert.equal(findingCaption(spawn).text, "spawned lane-0, lane-1 as retained children");
assert.equal(childrenForCell([{ id: "1", name: "lane-1", cost: 0 }], spawn).length, 1);
assert.equal(childrenForCell([{ id: "2", name: "lane-9", cost: 0 }], spawn).length, 0);

// The design's own shape — names built in a loop — has no literal to read, so
// the names come back off the returned handles. Verified against a live run.
const loopSpawn = {
  ...tool,
  args: { code: 'for i in range(2):\n    h = await rlm(prompt="reply OK", name=f"lane-{i}")' },
  output:
    "[RLMSpawnHandle(rlm_child_id='sub-3c853dd3', name='lane-0', model='anthropic/claude-opus-5'), " +
    "RLMSpawnHandle(rlm_child_id='sub-d9670af5', name='lane-1', model='anthropic/claude-opus-5')]",
};
assert.equal(findingCaption(loopSpawn).text, "spawned lane-0, lane-1 as retained children");

const long =
  "Lane-0 is in: fewer calls per task but more work per call — the programmatic model holds.";
assert.ok(
  isVerdict(long, { closesTurn: true, streaming: false, busy: false }),
  "closing text of a settled exchange is the verdict",
);
assert.ok(
  !isVerdict(long, { closesTurn: true, streaming: true, busy: true }),
  "nothing becomes a verdict mid-stream",
);
assert.ok(
  !isVerdict(long, { closesTurn: false, streaming: false, busy: false }),
  "a message that still runs a cell is a prelude, not a conclusion",
);
assert.ok(
  isVerdict(`Verdict: ${long}`, { closesTurn: false, streaming: false, busy: true }),
  "an explicit decision cue wins wherever it appears",
);
assert.ok(
  !isVerdict("Done.", { closesTurn: true, streaming: false, busy: false }),
  "sign-offs are not verdicts",
);
assert.ok(
  !isVerdict(long, { closesTurn: true, streaming: false, busy: false, quiet: true }),
  "a plain Q&A answer is not boxed — nothing to stand apart from",
);
assert.ok(
  isVerdict(`Verdict: ${long}`, { closesTurn: true, streaming: false, busy: false, quiet: true }),
  "an explicit cue still counts on a quiet turn",
);

// Prime reports isError:false for a cell whose command failed inside it — this
// is the case that would otherwise defeat "auto-expand on error" entirely.
const shellFail = {
  ...tool,
  status: "ok",
  output: "exit code: 127\n\n-bash: line 1: python: command not found\n",
  details: { stderr: "-bash: line 1: python: command not found\n" },
};
assert.ok(cellFailed(shellFail), "a failed shell command counts as a failed cell");
assert.equal(findingCaption(shellFail).kind, "error");
assert.equal(findingCaption(shellFail).text, "-bash: line 1: python: command not found");
assert.ok(!cellFailed(tool), "a clean cell is not a failure");
assert.ok(!cellFailed({ ...tool, status: "running", output: "" }), "running is not failure");

// Rule/banner lines are not findings.
const banner = { ...tool, output: "--- bash identity ---\nubuntu 22.04\n" };
assert.equal(findingCaption(banner).text, "ubuntu 22.04", "banner lines are skipped");

// The status line is composed, not templated — and says nothing when idle.
assert.equal(statusSentence(state), null, "idle sessions have no status line");
const busy = { ...state, busy: true };
assert.match(statusSentence(busy), /^Thinking/, "busy with no cell in flight");
const inflight = {
  ...busy,
  tools: { x: { ...tool, status: "running", output: "", cellNo: 7 } },
};
assert.match(
  statusSentence(inflight, { elapsedSec: 8 }),
  /cell 7 in flight — .*, 8s\.$/,
  "the cell in flight and its age",
);
// Verified live against prime-agent 0.7.1: spawning a subagent emits
// rlm_child_update with a real status word, a name and the child's session dir.
const spawned = reduce(state, {
  t: "event",
  e: {
    type: "rlm_child_update",
    child: {
      id: "sub-ce91ee5c",
      label: "Reply with OK",
      model: "anthropic/claude-opus-5",
      sessionDir: "C:\\Users\\x\\.prime\\agent\\session-artifacts\\019f\\sub-ce91ee5c",
      sessionName: "probe-child",
      status: "queued",
    },
  },
});
const kid = spawned.children["sub-ce91ee5c"];
assert.equal(kid.name, "probe-child", "sessionName is the child's name");
assert.equal(kid.status, "queued", "prime's own status word is kept, not reinterpreted");
assert.equal(kid.model, "anthropic/claude-opus-5");
assert.ok(kid.sessionDir.endsWith("sub-ce91ee5c"), "session dir enables the read-only view");
assert.equal(kid.cell, 1, "attributed to the cell that was in flight");
assert.equal(kid.cost, 0, "a status update must not invent spend");
// A later usage event accumulates cost without duplicating the child.
const paid = reduce(spawned, {
  t: "event",
  e: { type: "child_usage_attributed", childId: "sub-ce91ee5c", childUsage: { cost: { total: 0.21 } } },
});
assert.equal(Object.keys(paid.children).length, 1, "same child, not a second row");
assert.equal(paid.children["sub-ce91ee5c"].cost, 0.21);
assert.equal(paid.children["sub-ce91ee5c"].status, "queued", "usage does not reset the status");
assert.equal(childrenForCell(Object.values(paid.children), paid.tools[call.id]).length, 1);

const withKids = {
  ...inflight,
  children: { a: { id: "a", name: "lane-1", status: "running", cost: 0.2, cell: 7 } },
};
assert.match(statusSentence(withKids), /^Running lane-1; cell 7 in flight/);
const waiting = {
  ...inflight,
  children: { a: { id: "a", name: "lane-2", status: "queued", cost: 0, cell: 7 } },
};
assert.match(statusSentence(waiting), /^lane-2 queued; cell 7 in flight/);

// Quiet turn: nothing ran, nothing spawned — the rail and the meters vanish.
assert.ok(isQuiet(empty), "a fresh session is quiet");
assert.ok(!isQuiet(state), "a session that ran a cell is not");

console.log("reducer.check: OK");
