import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REVIEWED_PRIME_ADAPTER_DIGEST,
  loadReviewedPrimeAdapter,
  loadReviewedPrimeAdapterBytes,
} from "../src/reviewedPrimeAdapter.js";

test("the reviewed adapter loads the reviewed public Prime exports from verified owned bytes", async () => {
  const adapter = await loadReviewedPrimeAdapter();

  assert.equal(typeof adapter.DaemonClient, "function");
  assert.equal(typeof adapter.DaemonAgentConnection, "function");
  assert.equal(typeof adapter.AuthStorage, "function");
  assert.equal(typeof adapter.ModelRegistry, "function");
  assert.deepEqual(adapter.DAEMON_PROTOCOL_INFO, { name: "prime-agent.daemon", version: 7 });
  assert.equal(typeof adapter.defaultDaemonSocketPath, "function");
  assert.equal(typeof adapter.defaultDaemonSocketPath(), "string");
});

test("adapter integrity failure is rejected before executable bytes are evaluated", async () => {
  const source = await readFile(new URL("../src/vendor/prime-daemon-adapter-v0.7.1.mjs", import.meta.url));
  const altered = Buffer.concat([source, Buffer.from("\nthrow new Error('unreviewed bytes executed');\n")]);

  await assert.rejects(
    loadReviewedPrimeAdapterBytes(altered, REVIEWED_PRIME_ADAPTER_DIGEST),
    /integrity mismatch/,
  );
});

test("the owned adapter has no executable dependency on the mutable installed package", async () => {
  const source = await readFile(new URL("../src/vendor/prime-daemon-adapter-v0.7.1.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/(?:^|[;\n])import\s*(?:\{[^}]*\}|\*\s+as\s+\w+)\s*from\s*["']([^"']+)["']/gu)].map((match) => match[1]);

  assert.ok(imports.length > 0, "the bundle should retain explicit Node builtin imports");
  assert.ok(imports.every((specifier) => specifier?.startsWith("node:") || ["child_process", "crypto", "fs", "fs/promises", "module", "os", "path", "url"].includes(specifier ?? "")));
  assert.match(source, /reviewed adapter refused non-builtin dynamic import/u);
  assert.doesNotMatch(source, /(?:Ayush|C:[\\/]Users[\\/]|node_modules[\\/]prime-agent|prime-agent[\\/]dist)/iu);
});
