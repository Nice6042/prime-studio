import { expect, it } from "vitest";

import type { RuntimeIdentity } from "../ipc/harness.generated";
import { initialStudioState, reduceStudio } from "./store";

const runtime: RuntimeIdentity = {
  packageName: "prime-agent",
  packageVersion: "0.7.1",
  packageDigest: `sha256:${"c".repeat(64)}`,
  entrypointDigest: `sha256:${"d".repeat(64)}`,
  protocolName: "prime-agent-daemon",
  protocolVersion: 7,
  schemaRevision: 13,
  schemaId: "prime-agent.schema.json",
  capabilities: ["attach_snapshot", "event_sequence"],
};

it("retains the exact verified runtime identity delivered by native bootstrap", () => {
  const projection = {
    compatibility: { status: "ready" as const, profile: "verified", capabilities: runtime.capabilities },
    runtime,
    sessions: [],
  };

  const state = reduceStudio(initialStudioState(), { type: "harness/bootstrap-loaded", projection });

  expect((state as typeof state & { runtime: RuntimeIdentity | null }).runtime).toEqual(runtime);
  expect(Object.isFrozen((state as typeof state & { runtime: RuntimeIdentity | null }).runtime)).toBe(true);
});
