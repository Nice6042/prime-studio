import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedNode,
  assertNpmLockSynchronized,
  evaluateRustSecReport,
  npmInvocation,
  stageCargoDenyDatabase,
  unexpectedDatabaseChanges,
} from "./check-dependency-policy.mjs";

const approved = [
  {
    advisory: "RUSTSEC-2025-0081",
    category: "unmaintained",
    crate: "unic-char-property",
    version: "0.9.0",
    ownerRole: "Release manager (currently vacant)",
    reviewBy: "2026-09-10",
    reason: "Locked transitive dependency with no direct maintained replacement.",
  },
];

test("accepts only the validated Node 22 release line from 22.12 onward", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.12.0"));
  assert.doesNotThrow(() => assertSupportedNode("22.99.7"));
  assert.throws(() => assertSupportedNode("22.11.9"), /Node 22\.12\.0 or newer/);
  assert.throws(() => assertSupportedNode("23.0.0"), /Node 22\.12\.0 or newer/);
  assert.throws(() => assertSupportedNode("22.12.0-rc.1"), /stable semantic version/);
  assert.throws(() => assertSupportedNode("not-a-version"), /valid semantic version/);
});

test("locks the Node policy and test DOM to the validated Node 22.12 line", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.engines.node, ">=22.12.0 <23");
  assert.equal(manifest.devDependencies.jsdom, "28.1.0");
  assert.equal(lock.packages["node_modules/jsdom"].version, "28.1.0");
  assert.equal(lock.packages["node_modules/jsdom"].engines.node, "^20.19.0 || ^22.12.0 || >=24.0.0");
});

test("runs npm through its JavaScript entry point without enabling a shell", () => {
  assert.deepEqual(
    npmInvocation({
      npmExecPath: "C:\\npm\\npm-cli.js",
      nodeExecPath: "C:\\node.exe",
      workingDirectory: "C:\\repo\\app",
    }),
    {
      binary: "C:\\node.exe",
      prefixArgs: ["C:\\npm\\npm-cli.js"],
      cwd: "C:\\repo\\app",
    },
  );
  assert.throws(
    () => npmInvocation({ npmExecPath: "", nodeExecPath: "C:\\node.exe" }),
    /must be run through an npm script/,
  );
});

test("rejects npm manifest and lockfile drift without creating node_modules", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "prime-npm-lock-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "policy-fixture",
      version: "1.0.0",
      dependencies: { "deliberately-missing-package": "1.0.0" },
    }),
  );
  const lockText = JSON.stringify({
    name: "policy-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "policy-fixture", version: "1.0.0" } },
  });
  await writeFile(join(fixture, "package-lock.json"), lockText);

  assert.throws(
    () => assertNpmLockSynchronized({ workingDirectory: fixture }),
    /npm manifest and lockfile are not synchronized/i,
  );
  await assert.rejects(access(join(fixture, "node_modules")));
  assert.equal(await readFile(join(fixture, "package-lock.json"), "utf8"), lockText);
});

test("stages the pinned RustSec clone in cargo-deny's deterministic database directory", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "prime-policy-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(join(source, "README.md"), "pinned database");

  const staged = stageCargoDenyDatabase({
    source,
    directoryName: "advisory-db-fixed",
    temporaryRoot: join(fixture, "staging"),
  });

  assert.equal(staged.root, join(fixture, "staging"));
  assert.equal(
    await readFile(join(staged.root, "advisory-db-fixed", "README.md"), "utf8"),
    "pinned database",
  );
});

test("permits cargo-audit's lock file but rejects every other advisory database change", () => {
  assert.deepEqual(unexpectedDatabaseChanges("?? db.lock\n"), []);
  assert.deepEqual(unexpectedDatabaseChanges(" M crates/example.md\n?? injected.md\n"), [
    " M crates/example.md",
    "?? injected.md",
  ]);
});

test("ignores advisories outside the supported Windows Cargo graph", () => {
  const report = {
    vulnerabilities: {
      list: [
        {
          advisory: { id: "RUSTSEC-2024-0429" },
          package: { name: "glib", version: "0.18.5" },
        },
      ],
    },
    warnings: {
      unmaintained: [
        {
          advisory: { id: "RUSTSEC-2025-0081" },
          package: { name: "unic-char-property", version: "0.9.0" },
        },
      ],
    },
  };

  const result = evaluateRustSecReport({
    report,
    activePackages: new Set(["unic-char-property@0.9.0"]),
    exceptions: approved,
    now: new Date("2026-08-10T00:00:00Z"),
  });

  assert.deepEqual(result.approvedExceptions, approved);
  assert.deepEqual(result.blockers, []);
});

test("blocks unexpected, mismatched, and expired active advisories", () => {
  const activePackages = new Set([
    "unic-char-property@0.9.0",
    "new-risk@1.2.3",
  ]);
  const report = {
    vulnerabilities: {
      list: [
        {
          advisory: { id: "RUSTSEC-2099-0001" },
          package: { name: "new-risk", version: "1.2.3" },
        },
      ],
    },
    warnings: {
      unmaintained: [
        {
          advisory: { id: "RUSTSEC-2025-0081" },
          package: { name: "unic-char-property", version: "0.9.0" },
        },
      ],
    },
  };

  const result = evaluateRustSecReport({
    report,
    activePackages,
    exceptions: approved,
    now: new Date("2026-09-11T00:00:00Z"),
  });

  assert.equal(result.blockers.length, 2);
  assert.match(result.blockers.join("\n"), /RUSTSEC-2099-0001 new-risk@1\.2\.3/);
  assert.match(result.blockers.join("\n"), /RUSTSEC-2025-0081 unic-char-property@0\.9\.0.*expired/);
});

test("rejects calendar-normalized review dates", () => {
  const invalid = [{ ...approved[0], reviewBy: "2026-02-30" }];
  const result = evaluateRustSecReport({
    report: {
      vulnerabilities: { list: [] },
      warnings: {
        unmaintained: [
          {
            advisory: { id: approved[0].advisory },
            package: { name: approved[0].crate, version: approved[0].version },
          },
        ],
      },
    },
    activePackages: new Set(["unic-char-property@0.9.0"]),
    exceptions: invalid,
    now: new Date("2026-02-01T00:00:00Z"),
  });

  assert.match(result.blockers.join("\n"), /invalid review date 2026-02-30/i);
});

test("never permits a vulnerability through the informational exception mechanism", () => {
  const vulnerability = {
    advisory: "RUSTSEC-2099-0001",
    category: "vulnerability",
    crate: "active-risk",
    version: "1.0.0",
    ownerRole: "Release manager (currently vacant)",
    reviewBy: "2099-12-31",
    reason: "This must not be accepted.",
  };
  const result = evaluateRustSecReport({
    report: {
      vulnerabilities: {
        list: [
          {
            advisory: { id: vulnerability.advisory },
            package: { name: vulnerability.crate, version: vulnerability.version },
          },
        ],
      },
      warnings: {},
    },
    activePackages: new Set(["active-risk@1.0.0"]),
    exceptions: [vulnerability],
    now: new Date("2026-08-10T00:00:00Z"),
  });

  assert.deepEqual(result.approvedExceptions, []);
  assert.match(result.blockers.join("\n"), /vulnerability.*cannot be dispositioned/i);
});

test("rejects stale exception entries when the advisory is no longer reported", () => {
  const result = evaluateRustSecReport({
    report: { vulnerabilities: { list: [] }, warnings: {} },
    activePackages: new Set(["unic-char-property@0.9.0"]),
    exceptions: approved,
    now: new Date("2026-08-10T00:00:00Z"),
  });

  assert.deepEqual(result.approvedExceptions, []);
  assert.match(result.blockers.join("\n"), /stale exception.*RUSTSEC-2025-0081/i);
});

test("rejects duplicate exception keys instead of silently shadowing a disposition", () => {
  const result = evaluateRustSecReport({
    report: {
      vulnerabilities: { list: [] },
      warnings: {
        unmaintained: [
          {
            advisory: { id: approved[0].advisory },
            package: { name: approved[0].crate, version: approved[0].version },
          },
        ],
      },
    },
    activePackages: new Set(["unic-char-property@0.9.0"]),
    exceptions: [approved[0], { ...approved[0], reason: "shadow" }],
    now: new Date("2026-08-10T00:00:00Z"),
  });

  assert.match(result.blockers.join("\n"), /duplicate exception.*RUSTSEC-2025-0081/i);
});
