import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const sourceBoundaries = [
  "app/src/styles.css",
  "app/src/components/TopBar.tsx",
  "app/src/components/Sidebar.tsx",
  "app/src/components/ChatPane.tsx",
  "app/src/components/Settings.tsx",
  "app/src/components/RightRail.tsx",
];

test("publishable interface sources do not claim an unresolved design dependency", () => {
  for (const relativePath of sourceBoundaries) {
    assert.doesNotMatch(
      read(relativePath),
      /(?:\b(?:handoff|mockup)\b|\bpriority\s+\d+\b|\bround\s+\d+\b)/iu,
      `${relativePath} must describe only project-owned behavior and design decisions`,
    );
  }
});

test("project design notes contain no reproduction instructions", () => {
  for (const relativePath of ["DESIGN_CHANGES.md", "T3CODE_RESEARCH.md"]) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /\b(?:copy|copied|copying|mockup|wholesale)\b/iu, relativePath);
    assert.doesNotMatch(source, /\bdesign\s+tool\b/iu, relativePath);
  }
});

test("the interface stylesheet records its independent project-owned basis", () => {
  const source = read("app/src/styles.css");
  assert.match(source, /independently authored/iu);
  assert.match(source, /woven-aperture/iu);
});
