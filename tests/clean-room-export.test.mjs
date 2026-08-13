import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exporter = resolve(repoRoot, "tools/clean-room-export.mjs");
const scratchRoots = [];

test.after(() => {
  for (const path of scratchRoots) rmSync(path, { recursive: true, force: true });
});

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function scratch() {
  const path = mkdtempSync(join(tmpdir(), "prime-studio-clean-room-test-"));
  scratchRoots.push(path);
  return path;
}

function writeTree(root, entries) {
  for (const [path, contents] of Object.entries(entries)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function makeSource(entries = { "README.md": "# Safe fixture\n" }) {
  const root = scratch();
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "--initial-branch=private-main"]);
  git(source, ["config", "user.name", "Private Historical Person"]);
  git(source, ["config", "user.email", "private-history@example.test"]);
  writeTree(source, { "old.txt": "private history that is absent from the candidate\n" });
  git(source, ["add", "-A"]);
  git(source, ["commit", "-m", "private history"]);
  const privateCommit = git(source, ["rev-parse", "HEAD"]);
  rmSync(join(source, "old.txt"));
  writeTree(source, entries);
  git(source, ["add", "-A"]);
  git(source, ["commit", "-m", "approved candidate"]);
  return { root, source, candidate: git(source, ["rev-parse", "HEAD"]), privateCommit };
}

function invoke({ root, source, candidate, extra = [] }) {
  const quarantine = join(root, "quarantine");
  const destination = join(root, "public");
  const literals = join(root, "private-literals.json");
  const bindingKey = join(root, "private-literals-hmac.key");
  writeFileSync(
    literals,
    JSON.stringify([
      "Private Historical Person",
      "private-history@example.test",
      `${"C:"}${"\\Users\\"}PrivateHistoricalPerson`,
    ]),
  );
  writeFileSync(bindingKey, Buffer.alloc(32, 0xa5), { flag: "wx" });
  const result = spawnSync(
    process.execPath,
    [
      exporter,
      "--source",
      source,
      "--candidate",
      candidate,
      "--quarantine",
      quarantine,
      "--destination",
      destination,
      "--private-literals-file",
      literals,
      "--private-literals-hmac-key-file",
      bindingKey,
      "--author-name",
      "Prime Studio Contributors",
      "--author-email",
      "contributors@prime-studio.invalid",
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { ...result, quarantine, destination, literals, bindingKey };
}

function invokeWithPaths({
  source,
  candidate,
  quarantine,
  destination,
  literals,
  bindingKey = join(dirname(literals), "private-literals-hmac.key"),
  authorName = "Prime Studio Contributors",
  authorEmail = "contributors@prime-studio.invalid",
  extra = [],
  environment = process.env,
}) {
  if (!existsSync(bindingKey)) writeFileSync(bindingKey, Buffer.alloc(32, 0xa5), { flag: "wx" });
  return spawnSync(
    process.execPath,
    [
      exporter,
      "--source",
      source,
      "--candidate",
      candidate,
      "--quarantine",
      quarantine,
      "--destination",
      destination,
      "--private-literals-file",
      literals,
      "--private-literals-hmac-key-file",
      bindingKey,
      "--author-name",
      authorName,
      "--author-email",
      authorEmail,
      ...extra,
    ],
    { encoding: "utf8", env: environment },
  );
}

function exporterArguments({
  source,
  candidate,
  quarantine,
  destination,
  literals,
  bindingKey = join(dirname(literals), "private-literals-hmac.key"),
}) {
  if (!existsSync(bindingKey)) writeFileSync(bindingKey, Buffer.alloc(32, 0xa5), { flag: "wx" });
  return [
    exporter,
    "--source",
    source,
    "--candidate",
    candidate,
    "--quarantine",
    quarantine,
    "--destination",
    destination,
    "--private-literals-file",
    literals,
    "--private-literals-hmac-key-file",
    bindingKey,
    "--author-name",
    "Prime Studio Contributors",
    "--author-email",
    "contributors@prime-studio.invalid",
  ];
}

function spawnExporter(options, environment) {
  const child = spawn(process.execPath, exporterArguments(options), {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once("error", rejectCompleted);
    child.once("close", (status, signal) => resolveCompleted({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function waitForStaging(root, destinationName, completed) {
  const prefix = `.${destinationName}.clean-room-`;
  const deadline = Date.now() + 20_000;
  let completion;
  completed.then((result) => { completion = result; });
  while (Date.now() < deadline) {
    const name = readdirSync(root).find((entry) => entry.startsWith(prefix));
    if (name) return join(root, name);
    if (completion) {
      throw new Error(`exporter exited before owned staging appeared: ${completion.stderr}${completion.stdout}`);
    }
    await delay(10);
  }
  throw new Error("timed out waiting for owned destination staging");
}

async function waitForEntry(path, completed) {
  const deadline = Date.now() + 20_000;
  let completion;
  completed.then((result) => { completion = result; });
  while (Date.now() < deadline) {
    if (pathEntryExistsForTest(path)) return;
    if (completion) throw new Error(`exporter exited before ${path} appeared: ${completion.stderr}${completion.stdout}`);
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function pathEntryExistsForTest(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("exports one exact tree as one neutral root commit without private history", () => {
  const fixture = makeSource({
    "README.md": "# Public fixture\n",
    "src/value.txt": "deterministic content\n",
  });
  git(fixture.source, ["branch", "private-history", fixture.privateCommit]);
  git(fixture.source, ["tag", "private-tag", fixture.privateCommit]);
  git(fixture.source, ["remote", "add", "origin", "https://example.invalid/private.git"]);
  execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixture.source,
    input: "unreachable private object\n",
    encoding: "utf8",
  });

  const result = invoke(fixture);
  assert.equal(result.status, 0, result.stderr);

  const sourceTree = git(fixture.source, ["rev-parse", `${fixture.candidate}^{tree}`]);
  const publicTree = git(result.destination, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(publicTree, sourceTree);
  assert.equal(git(result.destination, ["rev-list", "--all", "--count"]), "1");
  assert.equal(
    git(result.destination, ["for-each-ref", "--format=%(refname)"]),
    "refs/heads/main",
  );
  assert.equal(git(result.destination, ["rev-list", "--parents", "-1", "HEAD"]).split(" ").length, 1);
  assert.equal(
    git(result.destination, ["show", "-s", "--format=%B", "HEAD"]),
    "Initial public source snapshot",
  );
  assert.equal(git(result.destination, ["show", "-s", "--format=%an <%ae>", "HEAD"]), "Prime Studio Contributors <contributors@prime-studio.invalid>");
  assert.equal(git(result.destination, ["show", "-s", "--format=%aI%n%cI", "HEAD"]), "2000-01-01T00:00:00Z\n2000-01-01T00:00:00Z");
  assert.equal(git(result.destination, ["remote"]), "");
  assert.equal(git(result.destination, ["reflog", "show", "--all"]), "");
  assert.equal(git(result.destination, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.equal(git(result.destination, ["rev-parse", "--is-bare-repository"]), "true");
  assert.equal(existsSync(join(result.destination, "objects", "info", "alternates")), false);
  assert.doesNotMatch(git(result.destination, ["fsck", "--full", "--no-reflogs", "--unreachable"]), /unreachable|dangling/iu);
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", fixture.privateCommit], {
      cwd: result.destination,
      encoding: "utf8",
    }).status,
    0,
  );
  assert.equal(git(result.destination, ["show", "HEAD:README.md"]), "# Public fixture");
  assert.equal(existsSync(join(result.destination, "README.md")), false);
  assert.equal(existsSync(join(result.destination, "src")), false);

  const inventory = git(result.destination, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ]).split(/\r?\n/u);
  assert.equal(inventory.filter((line) => line.endsWith(" commit")).length, 1);
  assert.equal(inventory.filter((line) => line.endsWith(" tag")).length, 0);

  const report = JSON.parse(
    readFileSync(join(result.quarantine, "public-export-audit.json"), "utf8"),
  );
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.candidate, fixture.candidate);
  assert.equal(report.sourceTree, sourceTree);
  assert.equal(report.destinationTree, sourceTree);
  assert.equal(report.findings.total, 0);
  assert.equal(report.topology.commitCount, 1);
  assert.equal(report.topology.rootCommitCount, 1);
  assert.equal(report.topology.objectInventory.total, inventory.length);
  assert.equal(report.topology.objectInventory.commits, 1);
  assert.equal(report.topology.objectInventory.tags, 0);
  assert.deepEqual(report.topology.refs, ["refs/heads/main"]);
  assert.equal(JSON.stringify(report).includes(fixture.source), false);
  assert.equal(JSON.stringify(report).includes("Private Historical Person"), false);
});

test("exports an exact empty candidate tree as one neutral root commit", () => {
  const fixture = makeSource({});

  const result = invoke(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(result.destination, ["rev-list", "--all", "--count"]), "1");
  assert.equal(git(result.destination, ["ls-tree", "-r", "--name-only", "HEAD"]), "");
  const report = JSON.parse(readFileSync(join(result.quarantine, "public-export-audit.json"), "utf8"));
  assert.equal(report.fileCount, 0);
  assert.equal(report.candidateBytes, 0);
});

test("refuses an abbreviated candidate before creating output", () => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({
    ...fixture,
    candidate: fixture.candidate.slice(0, 12),
    quarantine,
    destination,
    literals,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full object ID/iu);
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(destination), false);
});

test("refuses a source repository configured as a promisor clone", () => {
  const fixture = makeSource();
  git(fixture.source, ["config", "remote.origin.promisor", "true"]);

  const result = invoke(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /partial-clone or promisor/iu);
  assert.equal(existsSync(result.quarantine), false);
  assert.equal(existsSync(result.destination), false);
});

test("refuses promisor configuration stored in config.worktree", () => {
  const fixture = makeSource();
  git(fixture.source, ["config", "extensions.worktreeConfig", "true"]);
  git(fixture.source, ["config", "--worktree", "remote.origin.promisor", "true"]);

  const result = invoke(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /partial-clone or promisor/iu);
  assert.equal(existsSync(result.quarantine), false);
  assert.equal(existsSync(result.destination), false);
});

test("refuses a source repository with a missing reachable ancestor", () => {
  const fixture = makeSource();
  const missingObject = join(
    fixture.source,
    ".git",
    "objects",
    fixture.privateCommit.slice(0, 2),
    fixture.privateCommit.slice(2),
  );
  rmSync(missingObject);

  const result = invoke(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /connectivity check failed/iu);
  assert.equal(existsSync(result.quarantine), false);
  assert.equal(existsSync(result.destination), false);
});

test("requires every explicit option exactly once", () => {
  const fixture = makeSource();
  const result = spawnSync(
    process.execPath,
    [exporter, "--source", fixture.source, "--candidate", fixture.candidate],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required option/iu);
  assert.deepEqual(readdirSync(fixture.root).sort(), ["source"]);
});

test("refuses a potentially real contributor email before creating output", () => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
  const result = invokeWithPaths({
    ...fixture,
    quarantine,
    destination,
    literals,
    authorEmail: "person@example.com",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /neutral \.invalid domain/iu);
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(destination), false);
});

test("preserves a nonempty destination byte-for-byte", () => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  mkdirSync(destination);
  writeFileSync(join(destination, "sentinel.txt"), "must survive\n");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /destination must not already exist/iu);
  assert.equal(readFileSync(join(destination, "sentinel.txt"), "utf8"), "must survive\n");
  assert.equal(existsSync(quarantine), false);
});

test("refuses pre-created empty quarantine and destination directories", () => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  mkdirSync(quarantine);
  mkdirSync(destination);
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not already exist/iu);
  assert.deepEqual(readdirSync(quarantine), []);
  assert.deepEqual(readdirSync(destination), []);
});

test("refuses a pre-created dangling destination link without replacing it", (context) => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const missingTarget = join(fixture.root, "missing-target");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
  try {
    symlinkSync(missingTarget, destination, "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      context.skip("directory symlinks are unavailable on this Windows host");
      return;
    }
    throw error;
  }

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not already exist/iu);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  assert.equal(existsSync(missingTarget), false);
});

test("ignores hostile TAR_OPTIONS because archive inspection is in-process", () => {
  const fixture = makeSource({ "README.md": "# No external tar\n" });
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({
    ...fixture,
    quarantine,
    destination,
    literals,
    environment: { ...process.env, TAR_OPTIONS: "--definitely-invalid-clean-room-option" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(quarantine, "payload")), false);
});

test(
  "rejects archive pathname replacement while holding the reviewed descriptor",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = makeSource({ "large-safe.txt": Buffer.alloc(8 * 1024 * 1024, 0x61) });
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    const displacedArchive = join(fixture.root, "descriptor-bound-candidate.tar");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
    const running = spawnExporter({ ...fixture, quarantine, destination, literals }, process.env);
    const archive = join(quarantine, "candidate.tar");
    await waitForEntry(archive, running.completed);

    const deadline = Date.now() + 20_000;
    let swapped = false;
    while (!swapped && Date.now() < deadline) {
      try {
        renameSync(archive, displacedArchive);
        writeFileSync(archive, "attacker replacement bytes\n", { flag: "wx" });
        swapped = true;
      } catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
        await delay(5);
      }
    }
    assert.equal(swapped, true, "the hostile test must replace the archive pathname");

    const result = await running.completed;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive path differs|archive identity changed/iu);
    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(archive, "utf8"), "attacker replacement bytes\n");
  },
);

test(
  "keeps the final destination absent until atomic placement and preserves a late empty directory",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = makeSource(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `src/value-${String(index).padStart(3, "0")}.txt`,
        `value ${index}\n`,
      ]),
    ));
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
    const running = spawnExporter(
      { ...fixture, quarantine, destination, literals },
      process.env,
    );

    await waitForStaging(fixture.root, "public", running.completed);
    assert.equal(existsSync(destination), false);
    mkdirSync(destination);
    const result = await running.completed;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /atomic placement|atomic.*no-replace|already exists|exclusively/iu);
    assert.equal(lstatSync(destination).isDirectory(), true);
    assert.deepEqual(readdirSync(destination), []);
  },
);

test(
  "rejects a junction swap of its owned destination staging",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = makeSource(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `src/entry-${String(index).padStart(3, "0")}.txt`,
        `entry ${index}\n`,
      ]),
    ));
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    const attacker = join(fixture.root, "attacker-controlled");
    const displaced = join(fixture.root, "displaced-owned-staging");
    mkdirSync(attacker);
    writeFileSync(join(attacker, "sentinel.txt"), "attacker bytes must survive\n");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
    const running = spawnExporter(
      { ...fixture, quarantine, destination, literals },
      process.env,
    );

    const staging = await waitForStaging(fixture.root, "public", running.completed);
    const deadline = Date.now() + 10_000;
    let swapped = false;
    while (!swapped && Date.now() < deadline) {
      try {
        renameSync(staging, displaced);
        symlinkSync(attacker, staging, "junction");
        swapped = true;
      } catch (error) {
        if (existsSync(displaced) && !existsSync(staging)) {
          symlinkSync(attacker, staging, "junction");
          swapped = true;
          break;
        }
        if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
        await delay(20);
      }
    }
    assert.equal(swapped, true, "the hostile test must complete the junction swap");

    const result = await running.completed;
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(destination), false);
    assert.equal(
      readFileSync(join(attacker, "sentinel.txt"), "utf8"),
      "attacker bytes must survive\n",
    );
  },
);

test(
  "rejects a nested Git object-directory junction before writing outside staging",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = makeSource(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `src/object-${String(index).padStart(3, "0")}.txt`,
        `object ${index}\n`,
      ]),
    ));
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    const attacker = join(fixture.root, "object-attacker");
    const displaced = join(fixture.root, "displaced-objects");
    mkdirSync(attacker);
    writeFileSync(join(attacker, "sentinel.txt"), "must remain the only attacker entry\n");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
    const running = spawnExporter({ ...fixture, quarantine, destination, literals }, process.env);

    const staging = await waitForStaging(fixture.root, "public", running.completed);
    const objects = join(staging, "objects");
    await waitForEntry(objects, running.completed);
    renameSync(objects, displaced);
    symlinkSync(attacker, objects, "junction");

    const result = await running.completed;
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(attacker).sort(), ["sentinel.txt"]);
  },
);

test(
  "rejects a late refs junction after the main ref exists",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = makeSource(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `src/late-${String(index).padStart(3, "0")}.txt`,
        `late identity ${index}\n`,
      ]),
    ));
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    const displacedRefs = join(fixture.root, "late-external-refs");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
    const running = spawnExporter({ ...fixture, quarantine, destination, literals }, process.env);

    const staging = await waitForStaging(fixture.root, "public", running.completed);
    const mainRef = join(staging, "refs", "heads", "main");
    await waitForEntry(mainRef, running.completed);
    const refs = join(staging, "refs");
    const deadline = Date.now() + 10_000;
    let swapped = false;
    while (!swapped && Date.now() < deadline) {
      try {
        renameSync(refs, displacedRefs);
        symlinkSync(displacedRefs, refs, "junction");
        swapped = true;
      } catch (error) {
        if (existsSync(displacedRefs) && !existsSync(refs)) {
          symlinkSync(displacedRefs, refs, "junction");
          swapped = true;
          break;
        }
        if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
        await delay(10);
      }
    }
    assert.equal(swapped, true, "the hostile test must complete the late refs junction swap");

    const result = await running.completed;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:refs|heads) directory|reparse entry|identity changed/iu);
    assert.equal(existsSync(destination), false);
    assert.equal(pathEntryExistsForTest(join(displacedRefs, "heads", "main")), true);
  },
);

test("does not materialize a pathname-based worktree beside the verified object store", () => {
  const fixture = makeSource({ "src/value.txt": "raw object bytes\n" });

  const result = invoke(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(result.destination, ["rev-parse", "--is-bare-repository"]), "true");
  assert.equal(git(result.destination, ["show", "HEAD:src/value.txt"]), "raw object bytes");
  assert.equal(existsSync(join(result.destination, "src")), false);
});

test(
  "scrubs mixed-case Git environment variables on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = makeSource();
    const decoy = join(fixture.root, "decoy");
    mkdirSync(decoy);
    git(decoy, ["init", "--initial-branch=decoy"]);
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

    const result = invokeWithPaths({
      ...fixture,
      quarantine,
      destination,
      literals,
      environment: {
        ...process.env,
        git_dir: join(decoy, ".git"),
        git_work_tree: decoy,
        git_index_file: join(fixture.root, "redirected-index"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(destination, ["rev-list", "--all", "--count"]), "1");
    assert.equal(existsSync(join(fixture.root, "redirected-index")), false);
    assert.equal(git(decoy, ["for-each-ref", "--format=%(refname)"]), "");
  },
);

test("rejects private literals with only redacted finding details", () => {
  const privateValue = "Confidential Person 987654";
  const fixture = makeSource({ "notes.txt": `owned by ${privateValue}\n` });
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify([privateValue]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /redacted scanner finding/iu);
  assert.doesNotMatch(result.stderr, new RegExp(privateValue, "u"));
  assert.equal(existsSync(destination), false);
  const reportText = readFileSync(join(quarantine, "public-export-audit.json"), "utf8");
  assert.equal(reportText.includes(privateValue), false);
  const report = JSON.parse(reportText);
  assert.equal(report.status, "rejected");
  assert.equal(report.findings.total, 1);
  assert.equal(Object.keys(report.findings.byRule)[0], "private-literal-001");
  assert.deepEqual(report.findings.redacted[0], { rule: "private-literal-001" });
  assert.equal("path" in report.findings.redacted[0], false);
});

test("binds the private denylist with HMAC without recording values or key bytes", () => {
  const fixture = makeSource({ "README.md": "# Policy binding\n" });
  const firstRoot = join(fixture.root, "first-policy");
  const secondRoot = join(fixture.root, "second-policy");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const firstLiterals = join(fixture.root, "first-private-literals.json");
  const secondLiterals = join(fixture.root, "second-private-literals.json");
  const bindingKey = join(fixture.root, "review-only-hmac.key");
  const firstValue = "Reviewed private value alpha";
  const secondValue = "Reviewed private value bravo";
  writeFileSync(firstLiterals, JSON.stringify([firstValue]));
  writeFileSync(secondLiterals, JSON.stringify([secondValue]));
  writeFileSync(bindingKey, Buffer.alloc(32, 0x5c));

  const first = invokeWithPaths({
    ...fixture,
    quarantine: join(firstRoot, "quarantine"),
    destination: join(firstRoot, "public"),
    literals: firstLiterals,
    bindingKey,
  });
  const second = invokeWithPaths({
    ...fixture,
    quarantine: join(secondRoot, "quarantine"),
    destination: join(secondRoot, "public"),
    literals: secondLiterals,
    bindingKey,
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstReportText = readFileSync(join(firstRoot, "quarantine", "public-export-audit.json"), "utf8");
  const secondReportText = readFileSync(join(secondRoot, "quarantine", "public-export-audit.json"), "utf8");
  const firstReport = JSON.parse(firstReportText);
  const secondReport = JSON.parse(secondReportText);
  assert.match(firstReport.scanners.privateDenylistHmacSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    firstReport.scanners.privateDenylistHmacSha256,
    secondReport.scanners.privateDenylistHmacSha256,
  );
  for (const secret of [firstValue, secondValue, Buffer.alloc(32, 0x5c).toString("hex")]) {
    assert.equal(firstReportText.includes(secret), false);
    assert.equal(secondReportText.includes(secret), false);
  }
});

test("rejects a private literal embedded only in a tracked path", () => {
  const privateValue = "Confidential Person 246810";
  const fixture = makeSource({ [`docs/${privateValue}/notes.txt`]: "safe contents\n" });
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify([privateValue]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(destination), false);
  const reportText = readFileSync(join(quarantine, "public-export-audit.json"), "utf8");
  assert.equal(reportText.includes(privateValue), false);
  const report = JSON.parse(reportText);
  assert.equal(report.findings.byRule["private-literal-001"], 1);
});

test("rejects private literals encoded as UTF-16 text", () => {
  const privateValue = "Confidential Unicode Name 13579";
  const littleEndian = Buffer.from(privateValue, "utf16le");
  const bigEndian = Buffer.from(littleEndian);
  for (let index = 0; index + 1 < bigEndian.length; index += 2) {
    [bigEndian[index], bigEndian[index + 1]] = [bigEndian[index + 1], bigEndian[index]];
  }
  for (const [name, bytes] of [
    ["utf16le.txt", littleEndian],
    ["utf16be.txt", bigEndian],
    ["odd-prefix-utf16le.txt", Buffer.concat([Buffer.from([0xff]), littleEndian])],
    ["odd-prefix-utf16be.txt", Buffer.concat([Buffer.from([0xff]), bigEndian])],
  ]) {
    const fixture = makeSource({ [name]: bytes });
    const quarantine = join(fixture.root, "quarantine");
    const destination = join(fixture.root, "public");
    const literals = join(fixture.root, "private-literals.json");
    writeFileSync(literals, JSON.stringify([privateValue]));

    const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

    assert.notEqual(result.status, 0, name);
    assert.equal(existsSync(destination), false, name);
    const report = JSON.parse(
      readFileSync(join(quarantine, "public-export-audit.json"), "utf8"),
    );
    assert.equal(report.findings.byRule["private-literal-001"], 1, name);
  }
});

test("rejects built-in secret signatures and absolute home paths", () => {
  const cases = [
    [
      "token.txt",
      `${"github_"}${"pat_"}1234567890abcdefghijklmnopqrstuv\n`,
      "github-token",
    ],
    [
      "config.txt",
      `${"cache=C:"}${"\\Users\\"}SensitiveAccount\\cache\n`,
      "absolute-home-path",
    ],
  ];
  for (const [path, contents, rule] of cases) {
    const fixture = makeSource({ [path]: contents });
    const result = invoke(fixture);
    assert.notEqual(result.status, 0, rule);
    assert.equal(existsSync(result.destination), false, rule);
    const report = JSON.parse(
      readFileSync(join(result.quarantine, "public-export-audit.json"), "utf8"),
    );
    assert.equal(report.findings.byRule[rule], 1, rule);
    assert.equal(JSON.stringify(report).includes(contents.trim()), false, rule);
  }
});

test("rejects credential-like and generated paths", () => {
  const cases = [".env.production", "dist/bundle.js", "nested/node_modules/pkg/index.js"];
  for (const path of cases) {
    const fixture = makeSource({ [path]: "synthetic value\n" });
    const result = invoke(fixture);
    assert.notEqual(result.status, 0, path);
    assert.equal(existsSync(result.destination), false, path);
    const report = JSON.parse(
      readFileSync(join(result.quarantine, "public-export-audit.json"), "utf8"),
    );
    assert.ok(report.findings.total >= 1, path);
    assert.equal(JSON.stringify(report).includes(path), false, path);
  }
});

test("rejects symlink-mode entries before creating quarantine", () => {
  const fixture = makeSource();
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixture.source,
    input: "README.md",
    encoding: "utf8",
  }).trim();
  git(fixture.source, ["update-index", "--add", "--cacheinfo", `120000,${oid},unsafe-link`]);
  git(fixture.source, ["commit", "-m", "add symlink-mode entry"]);
  fixture.candidate = git(fixture.source, ["rev-parse", "HEAD"]);

  const result = invoke(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink, submodule, or unsupported Git entry mode/iu);
  assert.equal(existsSync(result.quarantine), false);
  assert.equal(existsSync(result.destination), false);
});

test("rejects control characters in tracked paths before archive extraction", () => {
  const fixture = makeSource();
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixture.source,
    input: "value\n",
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["mktree", "-z"], {
    cwd: fixture.source,
    input: `100644 blob ${oid}\tunsafe\nname.txt\0`,
    encoding: "utf8",
  }).trim();
  fixture.candidate = execFileSync("git", ["commit-tree", tree], {
    cwd: fixture.source,
    input: "unsafe tree\n",
    encoding: "utf8",
  }).trim();

  const result = invoke(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe path/iu);
  assert.equal(existsSync(result.quarantine), false);
  assert.equal(existsSync(result.destination), false);
});

test("scans raw candidate blobs when export-subst transforms the archive", () => {
  const fixture = makeSource({
    ".gitattributes": "version.txt export-subst\n",
    "version.txt": "$Format:%s$",
  });
  git(fixture.source, ["commit", "--amend", "-m", "abcdefghijk"]);
  fixture.candidate = git(fixture.source, ["rev-parse", "HEAD"]);
  const quarantine = join(fixture.root, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["$Format:%s$"]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /redacted scanner finding/iu);
  assert.equal(existsSync(destination), false);
  const report = JSON.parse(
    readFileSync(join(quarantine, "public-export-audit.json"), "utf8"),
  );
  assert.equal(report.findings.byRule["private-literal-001"], 1);
});

test("rejects overlapping work areas before creating either one", () => {
  const fixture = makeSource();
  const quarantine = join(fixture.root, "output");
  const destination = join(quarantine, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not overlap/iu);
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(destination), false);
});

test("rejects output inside a separate source Git directory", () => {
  const fixture = makeSource();
  const metadata = join(fixture.root, "separate-git-metadata");
  git(fixture.source, ["init", "--separate-git-dir", metadata]);
  const quarantine = join(metadata, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({ ...fixture, quarantine, destination, literals });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git metadata/iu);
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(destination), false);
});

test("rejects output inside a linked worktree Git directory", () => {
  const fixture = makeSource();
  const linkedSource = join(fixture.root, "linked-source");
  git(fixture.source, ["worktree", "add", "--detach", linkedSource, fixture.candidate]);
  const linkedGitDirectory = git(linkedSource, ["rev-parse", "--absolute-git-dir"]);
  const quarantine = join(linkedGitDirectory, "quarantine");
  const destination = join(fixture.root, "public");
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));

  const result = invokeWithPaths({
    ...fixture,
    source: linkedSource,
    quarantine,
    destination,
    literals,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git metadata/iu);
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(destination), false);
});

test("exports executable index modes on Windows without a dirty worktree", () => {
  const fixture = makeSource({ "run.sh": "#!/bin/sh\nexit 0\n" });
  git(fixture.source, ["update-index", "--chmod=+x", "run.sh"]);
  git(fixture.source, ["commit", "-m", "mark script executable"]);
  fixture.candidate = git(fixture.source, ["rev-parse", "HEAD"]);

  const result = invoke(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(git(result.destination, ["ls-tree", "HEAD", "run.sh"]), /^100755 blob /u);
  assert.equal(git(result.destination, ["rev-parse", "--is-bare-repository"]), "true");
});

test("stores canonical blob bytes without attribute filters", () => {
  const fixture = makeSource({
    ".gitattributes": "*.txt text eol=crlf\n",
    "value.txt": "line one\nline two\n",
  });

  const result = invoke(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    execFileSync("git", ["cat-file", "blob", "HEAD:value.txt"], {
      cwd: result.destination,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    Buffer.from("line one\nline two\n"),
  );
});

test("repeated exports of one candidate produce identical commits and reports", () => {
  const fixture = makeSource({ "README.md": "# Repeatable\n" });
  const firstRoot = join(fixture.root, "first");
  const secondRoot = join(fixture.root, "second");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const literals = join(fixture.root, "private-literals.json");
  writeFileSync(literals, JSON.stringify(["Private Historical Person"]));
  const first = {
    quarantine: join(firstRoot, "quarantine"),
    destination: join(firstRoot, "public"),
  };
  const second = {
    quarantine: join(secondRoot, "quarantine"),
    destination: join(secondRoot, "public"),
  };

  const firstResult = invokeWithPaths({ ...fixture, ...first, literals });
  const secondResult = invokeWithPaths({ ...fixture, ...second, literals });

  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.equal(git(first.destination, ["rev-parse", "HEAD"]), git(second.destination, ["rev-parse", "HEAD"]));
  assert.equal(
    readFileSync(join(first.quarantine, "public-export-audit.json"), "utf8"),
    readFileSync(join(second.quarantine, "public-export-audit.json"), "utf8"),
  );
});

test("ignores source replacement refs when resolving the explicit candidate", () => {
  const fixture = makeSource({ "README.md": "# Original candidate\n" });
  writeTree(fixture.source, { "replacement-only.txt": "must not export\n" });
  git(fixture.source, ["add", "-A"]);
  git(fixture.source, ["commit", "-m", "replacement commit"]);
  const replacement = git(fixture.source, ["rev-parse", "HEAD"]);
  git(fixture.source, ["replace", fixture.candidate, replacement]);

  const result = invoke(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(result.destination, ["show", "HEAD:README.md"]), "# Original candidate");
  assert.doesNotMatch(git(result.destination, ["ls-tree", "-r", "--name-only", "HEAD"]), /replacement-only/u);
});
