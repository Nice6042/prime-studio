// Records exact RPC payload shapes (truncated) for local app development.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { primeArgs } from "./prime-paths.mjs";

const child = spawn(process.execPath, [...primeArgs(), "--mode", "rpc", "--provider", "anthropic", "--model", "claude-opus-5"], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});

const samples = {};
const raw = [];
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    raw.push(line.slice(0, 1500));
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const key = ev.type === "response" ? `response:${ev.id ?? "?"}` : ev.type;
    if (!samples[key]) samples[key] = JSON.parse(JSON.stringify(ev, (k, v) =>
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v));
  }
});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(3000);
send({ id: "state", type: "get_state" });
send({ id: "models", type: "get_available_models" });
send({ id: "cmds", type: "get_commands" });
await wait(2500);
send({ id: "p", type: "prompt", message: "Create a file fixture.txt containing OK, then say done." });
await wait(30000);
send({ id: "stats", type: "get_session_stats" });
await wait(3000);

writeFileSync(new URL("rpc-shapes.local.json", import.meta.url), JSON.stringify(samples, null, 1));
writeFileSync(new URL("rpc-raw.local.log", import.meta.url), raw.join("\n"));
console.log("keys:", Object.keys(samples).join(", "));
child.kill(); process.exit(0);
