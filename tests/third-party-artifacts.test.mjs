import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("checked-in third-party artifacts exactly match the locked Windows production graphs", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-third-party-artifacts.mjs", "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(
    result.status,
    0,
    `artifact check failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const sbom = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "sbom", "prime-studio-windows-x86_64.spdx.json"),
      "utf8",
    ),
  );
  const packages = new Map(sbom.packages.map((component) => [component.name, component]));

  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.equal(sbom.documentDescribes.length, 1);
  assert.ok(packages.has("create-tauri-app"), "the retained scaffold must be attributed");
  assert.equal(packages.get("create-tauri-app").versionInfo, "4.6.2");
  assert.equal(packages.get("caniuse-lite").versionInfo, "1.0.30001809");
  assert.equal(packages.has("prime-agent"), false, "a separately installed runtime is not shipped");
  assert.equal(
    packages.get("tauri-build").primaryPackagePurpose,
    "OTHER",
    "Cargo build dependencies must not be represented as shipped runtime libraries",
  );
  assert.match(packages.get("tauri-build").sourceInfo, /Build-only dependency/);

  const rootId = sbom.documentDescribes[0];
  const caniuseId = packages.get("caniuse-lite").SPDXID;
  assert.ok(
    sbom.relationships.some(
      (edge) =>
        edge.spdxElementId === caniuseId &&
        edge.relationshipType === "BUILD_DEPENDENCY_OF" &&
        edge.relatedSpdxElement === rootId,
    ),
    "caniuse-lite must be classified as a build input, not a shipped runtime dependency",
  );
  assert.equal(
    sbom.relationships.some(
      (edge) =>
        edge.spdxElementId === rootId &&
        edge.relationshipType === "DEPENDS_ON" &&
        edge.relatedSpdxElement === caniuseId,
    ),
    false,
  );

  const reachable = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of sbom.relationships) {
      const candidate =
        edge.relationshipType === "BUILD_DEPENDENCY_OF" &&
        reachable.has(edge.relatedSpdxElement)
          ? edge.spdxElementId
          : ["DEPENDS_ON", "GENERATED_FROM"].includes(edge.relationshipType) &&
              reachable.has(edge.spdxElementId)
            ? edge.relatedSpdxElement
            : null;
      if (candidate && !reachable.has(candidate)) {
        reachable.add(candidate);
        changed = true;
      }
    }
  }
  assert.deepEqual(
    sbom.packages
      .map((component) => component.SPDXID)
      .filter((id) => !reachable.has(id)),
    [],
    "every inventoried package must be connected to the described application graph",
  );

  const notices = readFileSync(
    path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  const bundledNoticePath = path.join(
    repositoryRoot,
    "app",
    "public",
    "THIRD_PARTY_NOTICES.md",
  );
  assert.ok(existsSync(bundledNoticePath), "the bundled third-party notice is missing");
  assert.equal(
    readFileSync(bundledNoticePath, "utf8"),
    notices,
    "the notice embedded through the frontend public assets must stay byte-identical",
  );
  for (const required of [
    "Mozilla Public License 2.0 source availability",
    "Unicode License v3",
    "caniuse-lite",
    "create-tauri-app",
    "Prime Agent is not distributed",
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "ISC",
    "Zlib",
  ]) {
    assert.ok(notices.includes(required), `notice is missing ${required}`);
  }
});
