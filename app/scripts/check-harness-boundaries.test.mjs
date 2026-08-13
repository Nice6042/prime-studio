import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findHarnessBoundaryViolations } from "./check-harness-boundaries.mjs";

const roots = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(entry, feature = "export const safe = true;") {
  const root = await mkdtemp(path.join(tmpdir(), "prime-studio-boundary-"));
  roots.push(root);
  await mkdir(path.join(root, "src/features"), { recursive: true });
  await mkdir(path.join(root, "dist/assets"), { recursive: true });
  await writeFile(path.join(root, "src/App.tsx"), entry);
  await writeFile(path.join(root, "src/features/example.ts"), feature);
  await writeFile(path.join(root, "dist/assets/index.js"), "console.log('typed Studio');");
  return root;
}

describe("Harness production boundary checker", () => {
  it("accepts a typed Studio-only renderer closure", async () => {
    const root = await fixture("export default function App() { return null; }");
    await expect(findHarnessBoundaryViolations(root)).resolves.toEqual([]);
  });

  it.each([
    ["legacy entry", "export function LegacyApp() {}", "export const safe = true;"],
    ["raw invoke", "export default function App() { return null; }", "invoke('send_rpc', {});"],
    ["runtime import", "export default function App() { return null; }", "import('prime-agent');"],
    ["open union", "export default function App() { return null; }", "type Open = { type: string; [k: string]: unknown };"],
  ])("rejects %s", async (_case, entry, feature) => {
    const root = await fixture(entry, feature);
    expect(await findHarnessBoundaryViolations(root)).not.toEqual([]);
  });
});
