// Probe prime-agent --mode rpc: confirms the JSONL contract the Tauri app will speak.
// Usage: node probe-rpc.mjs
import { spawn } from "node:child_process";

import { primeArgs } from "./prime-paths.mjs";

const child = spawn(process.execPath, [...primeArgs(), "--mode", "rpc", "--provider", "anthropic", "--model", "claude-opus-5"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const seen = new Map();
let buf = "";
let usage = null;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const key = ev.type === "event" ? `event:${ev.event?.type ?? "?"}` : ev.type;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const u = ev.event?.message?.usage;
    if (u && (u.output || u.cacheRead)) usage = u;
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString().slice(0, 300)));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = {};
await wait(3000);
send({ id: "1", type: "get_state" });
send({ id: "2", type: "get_available_models" });
await wait(2000);
send({ id: "3", type: "prompt", message: "Reply with exactly: RPCOK" });
await wait(25000);
send({ id: "4", type: "get_session_stats" });
await wait(3000);

results.eventTypes = [...seen.entries()].sort((a, b) => b[1] - a[1]);
results.usageSample = usage;
console.log(JSON.stringify(results, null, 1));
child.kill();
process.exit(0);
