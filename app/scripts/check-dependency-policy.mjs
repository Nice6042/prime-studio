import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = resolve(appDir, "..");
const policy = JSON.parse(
  readFileSync(join(repositoryDir, "dependency-policy.json"), "utf8"),
);

function command(
  binary,
  args,
  { allowFailure = false, cwd = repositoryDir, env = process.env } = {},
) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${binary} ${args.join(" ")} failed (${result.status})\n${details}`);
  }
  return result;
}

function exactVersion(label, output, expected) {
  const found = output.trim().match(/(\d+\.\d+\.\d+)$/)?.[1];
  if (found !== expected) {
    throw new Error(`${label} ${expected} is required; found ${found ?? "unknown"}`);
  }
}

export function assertSupportedNode(version = process.versions.node) {
  if (/^\d+\.\d+\.\d+[-+]/.test(version)) {
    throw new Error(`Node version ${version} is not a validated stable semantic version`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Node version ${version} is not a valid semantic version`);
  const [, major, minor] = match.map(Number);
  if (major !== 22 || minor < 12) {
    throw new Error(`Node 22.12.0 or newer on the Node 22 release line is required; found ${version}`);
  }
}

export function npmInvocation({
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.execPath,
  workingDirectory = appDir,
} = {}) {
  if (!npmExecPath) {
    throw new Error("The dependency policy must be run through an npm script");
  }
  return { binary: nodeExecPath, prefixArgs: [npmExecPath], cwd: workingDirectory };
}

export function assertNpmLockSynchronized({ workingDirectory = appDir } = {}) {
  const npm = npmInvocation({ workingDirectory });
  const result = command(
    npm.binary,
    [
      ...npm.prefixArgs,
      "ci",
      "--dry-run",
      "--ignore-scripts",
      "--audit=false",
      "--fund=false",
    ],
    { allowFailure: true, cwd: npm.cwd },
  );
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`npm manifest and lockfile are not synchronized\n${details}`);
  }
}

function advisoryItems(report) {
  const items = [];
  for (const item of report.vulnerabilities?.list ?? []) {
    items.push({ category: "vulnerability", item });
  }
  for (const [category, warnings] of Object.entries(report.warnings ?? {})) {
    for (const item of warnings ?? []) items.push({ category, item });
  }
  return items;
}

function exceptionKey(entry) {
  return `${entry.category}:${entry.advisory}:${entry.crate}@${entry.version}`;
}

function reviewDeadline(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const deadline = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(deadline.getTime()) || deadline.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return deadline;
}

export function evaluateRustSecReport({ report, activePackages, exceptions, now = new Date() }) {
  const exceptionMap = new Map();
  const seen = new Set();
  const blockers = [];
  const approvedExceptions = [];
  for (const entry of exceptions) {
    const key = exceptionKey(entry);
    if (exceptionMap.has(key)) {
      blockers.push(`duplicate exception ${entry.advisory} ${entry.crate}@${entry.version}`);
    } else {
      exceptionMap.set(key, entry);
    }
  }

  for (const { category, item } of advisoryItems(report)) {
    const crate = item.package?.name;
    const version = item.package?.version;
    const advisory = item.advisory?.id;
    const packageKey = `${crate}@${version}`;
    if (!activePackages.has(packageKey)) continue;

    const key = exceptionKey({ category, advisory, crate, version });
    if (category === "vulnerability") {
      seen.add(key);
      blockers.push(`vulnerability ${advisory} ${packageKey} cannot be dispositioned`);
      continue;
    }
    const disposition = exceptionMap.get(key);
    if (!disposition) {
      blockers.push(`${category} ${advisory} ${packageKey} has no exact disposition`);
      continue;
    }
    seen.add(key);
    const reviewBy = reviewDeadline(disposition.reviewBy);
    if (!reviewBy) {
      blockers.push(`${advisory} ${packageKey} has invalid review date ${disposition.reviewBy}`);
      continue;
    }
    if (now > reviewBy) {
      blockers.push(`${advisory} ${packageKey} disposition expired on ${disposition.reviewBy}`);
      continue;
    }
    if (!disposition.ownerRole || !disposition.reason) {
      blockers.push(`${advisory} ${packageKey} disposition is missing an owner role or reason`);
      continue;
    }
    approvedExceptions.push(disposition);
  }

  for (const entry of exceptions) {
    const key = exceptionKey(entry);
    if (!seen.has(key)) blockers.push(`stale exception ${entry.advisory} ${entry.crate}@${entry.version}`);
  }

  return { approvedExceptions, blockers };
}

function advisoryDatabasePath() {
  if (process.env.RUSTSEC_ADVISORY_DB) return resolve(process.env.RUSTSEC_ADVISORY_DB);
  const cargoHome = process.env.CARGO_HOME
    ? resolve(process.env.CARGO_HOME)
    : join(homedir(), ".cargo");
  return join(cargoHome, "advisory-db");
}

function cargoDeny(args, options) {
  if (process.env.CARGO_DENY_BIN) {
    return command(resolve(process.env.CARGO_DENY_BIN), args, options);
  }
  return command("cargo", ["deny", ...args], options);
}

function checkAdvisoryDatabase(databasePath) {
  const revision = command("git", ["-C", databasePath, "rev-parse", "HEAD"]).stdout.trim();
  if (revision !== policy.rustSecAdvisoryDatabase.revision) {
    throw new Error(
      `RustSec advisory database must be pinned to ${policy.rustSecAdvisoryDatabase.revision}; found ${revision}`,
    );
  }
  const dirty = unexpectedDatabaseChanges(
    command("git", ["-C", databasePath, "status", "--porcelain"]).stdout,
  );
  if (dirty.length) {
    throw new Error(
      `RustSec advisory database has local changes: ${databasePath}\n${dirty.join("\n")}`,
    );
  }
}

export function unexpectedDatabaseChanges(status) {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => line !== "?? db.lock");
}

export function stageCargoDenyDatabase({
  source,
  directoryName,
  temporaryRoot,
}) {
  const root = temporaryRoot ?? mkdtempSync(join(tmpdir(), "prime-cargo-deny-db-"));
  mkdirSync(root, { recursive: true });
  cpSync(source, join(root, directoryName), { recursive: true, errorOnExist: true });
  return { root };
}

export function main() {
  assertSupportedNode();

  exactVersion(
    "cargo-deny",
    cargoDeny(["--version"]).stdout,
    policy.cargoDenyVersion,
  );
  exactVersion(
    "cargo-audit",
    command("cargo", ["audit", "--version"]).stdout,
    policy.cargoAuditVersion,
  );

  const npm = npmInvocation();
  assertNpmLockSynchronized();
  command(npm.binary, [...npm.prefixArgs, "audit", "--audit-level=low", "--json"], {
    cwd: npm.cwd,
  });

  const manifestPath = join(appDir, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(appDir, "src-tauri", "Cargo.lock");
  const metadata = JSON.parse(
    command("cargo", [
      "metadata",
      "--locked",
      "--filter-platform",
      policy.supportedCargoTarget,
      "--manifest-path",
      manifestPath,
      "--format-version",
      "1",
    ]).stdout,
  );
  const activePackages = new Set(
    metadata.packages.map((entry) => `${entry.name}@${entry.version}`),
  );

  const databasePath = advisoryDatabasePath();
  checkAdvisoryDatabase(databasePath);
  const stagedDatabase = stageCargoDenyDatabase({
    source: databasePath,
    directoryName: policy.cargoDenyAdvisoryDirectory,
  });
  let evaluated;
  try {
    cargoDeny(
      [
        "--locked",
        "--offline",
        "--manifest-path",
        manifestPath,
        "--config",
        join(repositoryDir, "deny.toml"),
        "check",
        "advisories",
        "bans",
        "licenses",
        "sources",
      ],
      {
        env: { ...process.env, PRIME_STUDIO_ADVISORY_ROOT: stagedDatabase.root },
      },
    );

    const audit = command("cargo", [
      "audit",
      "--file",
      cargoLockPath,
      "--db",
      databasePath,
      "--no-fetch",
      "--target-os",
      "windows",
      "--target-arch",
      "x86_64",
      "--json",
    ]);
    evaluated = evaluateRustSecReport({
      report: JSON.parse(audit.stdout),
      activePackages,
      exceptions: policy.informationalExceptions,
    });
    if (evaluated.blockers.length) {
      throw new Error(`RustSec policy blocked:\n- ${evaluated.blockers.join("\n- ")}`);
    }
  } finally {
    rmSync(stagedDatabase.root, { recursive: true, force: true });
  }

  for (const entry of evaluated.approvedExceptions) {
    console.warn(
      `TIME-BOUNDED ${entry.category}: ${entry.advisory} ${entry.crate}@${entry.version}; ` +
        `owner=${entry.ownerRole}; review-by=${entry.reviewBy}`,
    );
  }
  console.log(
    `Dependency policy passed for ${policy.supportedCargoTarget} with pinned RustSec database ${policy.rustSecAdvisoryDatabase.revision}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
