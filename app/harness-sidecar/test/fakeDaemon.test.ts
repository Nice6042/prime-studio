import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { encodeFrame, FrameStreamDecoder } from "../src/framing.js";
import { decideCompatibility } from "../src/compatibility.js";
import { loadFakeDaemonScenario, replyToFakeDaemonRequest } from "../src/fakeDaemonScenario.js";

const scenarioPath = join(import.meta.dirname, "..", "..", "test", "fixtures", "fake-daemon", "scenario-manifest.json");

test("loads one closed bounded credential-free fake daemon scenario", async () => {
  const scenario = await loadFakeDaemonScenario(scenarioPath);
  assert.equal(scenario.name, "resident-parent-with-child");
  assert.equal(scenario.sessions.length, 1);
  assert.equal(scenario.sessions[0]?.children[0]?.id, "child-security");
  assert.equal(scenario.sessions[0]?.parentMessages.some((message) => message.kind === "assistant"), true);
  assert.equal(decideCompatibility(scenario.runtime).status, "ready");
  assert.equal(JSON.stringify(scenario).includes("Ayush"), false);
});

test("fake daemon replies to discovery and bootstrap without granting any other command", async () => {
  const scenario = await loadFakeDaemonScenario(scenarioPath);
  assert.deepEqual(replyToFakeDaemonRequest(scenario, { type: "discover_runtime" }), {
    type: "discover_runtime_result",
    runtime: scenario.runtime,
    compatibility: decideCompatibility(scenario.runtime),
  });
  assert.deepEqual(replyToFakeDaemonRequest(scenario, { type: "bootstrap" }), {
    type: "bootstrap_result",
    compatibility: decideCompatibility(scenario.runtime),
    sessions: scenario.sessions,
  });
  assert.deepEqual(replyToFakeDaemonRequest(scenario, { type: "prompt" } as never), {
    type: "error",
    code: "unsupported_command",
    message: "Fake daemon command is not implemented",
  });
});

test("scenario transport rejects duplicate fields, unknown fields, and impossible usage", async (context) => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "prime-studio-fake-daemon-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(scenarioPath, "utf8");
  const duplicate = join(root, "duplicate.json");
  await writeFile(duplicate, source.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'));
  await assert.rejects(loadFakeDaemonScenario(duplicate), /duplicate JSON key/);

  const unknown = JSON.parse(source) as Record<string, unknown>;
  unknown.extra = true;
  const unknownPath = join(root, "unknown.json");
  await writeFile(unknownPath, JSON.stringify(unknown));
  await assert.rejects(loadFakeDaemonScenario(unknownPath), /scenario is invalid/);

  const impossible = JSON.parse(source) as { sessions: Array<{ usage: { totalTokens: number } }> };
  impossible.sessions[0]!.usage.totalTokens = 1;
  const impossiblePath = join(root, "impossible.json");
  await writeFile(impossiblePath, JSON.stringify(impossible));
  await assert.rejects(loadFakeDaemonScenario(impossiblePath), /scenario is invalid/);
});

test("compiled sidecar serves discovery and bootstrap from the deterministic fake daemon", async (context) => {
  const entry = join(import.meta.dirname, "..", "src", "index.js");
  const child = spawn(process.execPath, [entry, "--fixture-scenario", scenarioPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => child.kill());
  const decoder = new FrameStreamDecoder();
  const responses: unknown[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => responses.push(...decoder.push(chunk)));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  const request = async (requestId: string, type: "discover_runtime" | "bootstrap") => {
    child.stdin.write(encodeFrame({ studioProtocol: 1, requestId, payload: { type } }));
    const deadline = Date.now() + 3_000;
    while (responses.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.notEqual(responses.length, 0, stderr);
    return responses.shift() as { requestId: string; payload: { type: string; sessions?: unknown[] } };
  };

  const discovery = await request("request_discover_0001", "discover_runtime");
  assert.equal(discovery.requestId, "request_discover_0001");
  assert.equal(discovery.payload.type, "discover_runtime_result");
  const bootstrap = await request("request_bootstrap_0001", "bootstrap");
  assert.equal(bootstrap.requestId, "request_bootstrap_0001");
  assert.equal(bootstrap.payload.type, "bootstrap_result");
  assert.equal(bootstrap.payload.sessions?.length, 1);
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`sidecar exited ${code}: ${stderr}`)));
  });
});
