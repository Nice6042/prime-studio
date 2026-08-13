import assert from "node:assert/strict";
import test from "node:test";

import { decideCompatibility } from "../src/compatibility.js";
import { DAEMON_V7_SCHEMA13_PROFILE } from "../src/profiles/daemon-v7-schema13.js";
import type { RuntimeIdentity } from "../src/runtimeDiscovery.js";

function knownRuntime(): RuntimeIdentity {
  return {
    packageName: "prime-agent",
    packageVersion: DAEMON_V7_SCHEMA13_PROFILE.packageVersion,
    packageDigest: DAEMON_V7_SCHEMA13_PROFILE.packageDigest,
    entrypointDigest: DAEMON_V7_SCHEMA13_PROFILE.entrypointDigest,
    protocolName: DAEMON_V7_SCHEMA13_PROFILE.protocolName,
    protocolVersion: DAEMON_V7_SCHEMA13_PROFILE.protocolVersion,
    schemaRevision: DAEMON_V7_SCHEMA13_PROFILE.schemaRevision,
    schemaId: DAEMON_V7_SCHEMA13_PROFILE.schemaId,
    capabilities: [...DAEMON_V7_SCHEMA13_PROFILE.supportedCapabilities],
  };
}

test("an exact complete runtime is ready", () => {
  const result = decideCompatibility(knownRuntime());
  assert.equal(result.status, "ready");
  assert.equal(result.profile, DAEMON_V7_SCHEMA13_PROFILE.id);
});

test("missing optional capability degrades only that feature", () => {
  const runtime = knownRuntime();
  runtime.capabilities = runtime.capabilities.filter((capability) => capability !== "extension_ui");
  const result = decideCompatibility(runtime);
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.unavailable, [{ capability: "extension_ui", reason: "missing_mandatory_capability" }]);
});

test("missing mandatory chronology capability is read only", () => {
  const runtime = knownRuntime();
  runtime.capabilities = runtime.capabilities.filter((capability) => capability !== "event_sequence");
  const result = decideCompatibility(runtime);
  assert.equal(result.status, "read_only");
  assert.equal(result.reason, "missing_mandatory_capability");
});

test("unknown schema, hashes, and version labels never become ready", () => {
  for (const mutate of [
    (runtime: RuntimeIdentity) => { runtime.schemaRevision += 1; },
    (runtime: RuntimeIdentity) => { runtime.entrypointDigest = `sha256:${"0".repeat(64)}`; },
    (runtime: RuntimeIdentity) => { runtime.packageVersion = "0.7.2"; },
  ]) {
    const runtime = knownRuntime();
    mutate(runtime);
    assert.equal(decideCompatibility(runtime).status, "unavailable");
  }
});
