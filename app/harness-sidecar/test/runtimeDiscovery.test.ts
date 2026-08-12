import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";
import { decodeFrame, encodeFrame, parseClosedJson } from "../src/framing.js";
import { sanitizeDiagnostic } from "../src/redaction.js";
import { RuntimeDiscoveryError, discoverRuntime } from "../src/runtimeDiscovery.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");

async function fixture(name: string): Promise<{ root: string; dispose(): Promise<void> }> {
  const parent = await mkdtemp(join(tmpdir(), "prime-studio-harness-discovery-"));
  const root = join(parent, "runtime");
  await cp(join(fixtures, name), root, { recursive: true });
  return { root, dispose: () => rm(parent, { recursive: true, force: true }) };
}

async function fixtureProfile(root: string) {
  const manifest = await readFile(join(root, "package.json"));
  const entrypoint = await readFile(join(root, "dist", "index.js"));
  return {
    packageName: "prime-agent" as const,
    packageVersion: "0.7.1",
    packageDigest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
    entrypointDigest: `sha256:${createHash("sha256").update(entrypoint).digest("hex")}`,
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    schemaRevision: 13,
    schemaId: "protocol-7-schema-13-816309b1cd50",
    supportedCapabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"] as const,
  };
}

test("discovers a credential-free closed runtime identity", async (context) => {
  const ready = await fixture("runtime-ready");
  context.after(ready.dispose);

  const identity = await discoverRuntime(ready.root, await fixtureProfile(ready.root));
  assert.deepEqual(identity.capabilities, [
    "attach_snapshot",
    "event_sequence",
    "model_catalog",
    "resident_sessions",
    "session_input_admission",
  ]);
  assert.equal(identity.packageName, "prime-agent");
  assert.equal(identity.protocolName, "prime-agent.daemon");
  assert.equal(identity.protocolVersion, 7);
  assert.equal(identity.schemaRevision, 13);
  assert.match(identity.packageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(identity.entrypointDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(identity).sort(), [
    "capabilities", "entrypointDigest", "packageDigest", "packageName", "packageVersion",
    "protocolName", "protocolVersion", "schemaId", "schemaRevision",
  ]);
});

test("rejects a runtime package root reached through a reparse point", async (context) => {
  const ready = await fixture("runtime-ready");
  const link = join(dirname(ready.root), "runtime-link");
  await symlink(ready.root, link, "junction");
  context.after(ready.dispose);

  await assert.rejects(discoverRuntime(link, await fixtureProfile(ready.root)), (error: unknown) =>
    error instanceof RuntimeDiscoveryError && error.code === "runtime_path_untrusted");
});

test("rejects wrong package identity and oversized metadata", async (context) => {
  const wrongName = await fixture("runtime-ready");
  const huge = await fixture("runtime-ready");
  context.after(async () => Promise.all([wrongName.dispose(), huge.dispose()]));

  const manifest = JSON.parse(await readFile(join(wrongName.root, "package.json"), "utf8"));
  manifest.name = "lookalike-agent";
  await writeFile(join(wrongName.root, "package.json"), JSON.stringify(manifest));
  await assert.rejects(discoverRuntime(wrongName.root), (error: unknown) =>
    error instanceof RuntimeDiscoveryError && error.code === "runtime_identity_mismatch");

  await writeFile(join(huge.root, "package.json"), " ".repeat(256 * 1024 + 1));
  await assert.rejects(discoverRuntime(huge.root), (error: unknown) =>
    error instanceof RuntimeDiscoveryError && error.code === "runtime_metadata_too_large");
});

test("discovery never evaluates the mutable installed package entrypoint", async (context) => {
  const ready = await fixture("runtime-ready");
  context.after(ready.dispose);
  const marker = join(dirname(ready.root), "imported.txt");
  await writeFile(join(ready.root, "dist", "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`);

  const identity = await discoverRuntime(ready.root, await fixtureProfile(ready.root));

  assert.equal(identity.protocolVersion, 7);
  await assert.rejects(stat(marker), /ENOENT/);
});

test("rejects tampered runtime bytes before importing executable exports", async (context) => {
  const ready = await fixture("runtime-ready");
  context.after(ready.dispose);
  const expected = await fixtureProfile(ready.root);
  const marker = join(dirname(ready.root), "imported.txt");
  await writeFile(join(ready.root, "dist", "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`);
  await assert.rejects(discoverRuntime(ready.root, expected), (error: unknown) =>
    error instanceof RuntimeDiscoveryError && error.code === "runtime_identity_mismatch");
  await assert.rejects(stat(marker), /ENOENT/);
});

test("closed JSON and framing reject duplicate keys, noise, and oversized frames", () => {
  assert.throws(() => parseClosedJson('{"type":"bootstrap","type":"discover_runtime"}'), /duplicate JSON key/);
  const encoded = encodeFrame({ studioProtocol: 1, requestId: "request_12345678", payload: { type: "bootstrap" } });
  assert.deepEqual(decodeFrame(encoded), {
    studioProtocol: 1,
    requestId: "request_12345678",
    payload: { type: "bootstrap" },
  });
  assert.throws(() => decodeFrame(Buffer.concat([Buffer.from("noise"), encoded])), /frame length/);
  assert.throws(() => encodeFrame({ payload: "x".repeat(4 * 1024 * 1024) }), /frame exceeds/);
});

test("diagnostics redact secrets and local profile paths", () => {
  const diagnostic = sanitizeDiagnostic(
    "Bearer secret-token apiKey=private-value C:" + "\\Users\\Person\\AppData\\Local\\prime",
  );
  assert.equal(diagnostic.includes("secret-token"), false);
  assert.equal(diagnostic.includes("private-value"), false);
  assert.equal(diagnostic.includes("Person"), false);
  assert.match(diagnostic, /\[REDACTED/);
});

test("the compiled credential-free sidecar is declared as a Tauri resource", async () => {
  const compiledEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
  assert.equal((await stat(compiledEntry)).isFile(), true);

  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src-tauri", "tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    bundle?: { resources?: string[] };
  };
  assert.deepEqual(config.bundle?.resources, ["../harness-sidecar/dist/src"]);
});
