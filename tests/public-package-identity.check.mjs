import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const description = "A Windows-first Tauri and React development snapshot exploring a desktop interface for a separately installed prime-agent runtime.";
const contributors = "Prime Studio Contributors";
const copyright = `Copyright (c) 2026 ${contributors}`;

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function section(toml, name) {
  const match = toml.match(new RegExp(`^\\[${name.replaceAll(".", "\\.")}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
  assert.ok(match, `missing [${name}] section`);
  return match[1];
}

test("Cargo package, library, and lock root use the public identity", () => {
  const manifest = read("app/src-tauri/Cargo.toml");
  const packageSection = section(manifest, "package");
  assert.match(packageSection, /^name = "prime-studio"$/m);
  assert.match(packageSection, /^default-run = "prime-studio"$/m);
  assert.match(packageSection, new RegExp(`^description = ${JSON.stringify(description)}$`, "m"));
  assert.match(packageSection, /^authors = \["Prime Studio Contributors"\]$/m);
  assert.match(packageSection, /^license = "MIT"$/m);
  assert.match(packageSection, /^publish = false$/m);
  assert.doesNotMatch(packageSection, /^(?:repository|homepage)\s*=/m);

  const librarySection = section(manifest, "lib");
  assert.match(librarySection, /^name = "prime_studio_lib"$/m);
  assert.match(read("app/src-tauri/Cargo.lock"), /\[\[package\]\]\r?\nname = "prime-studio"\r?\nversion = "0\.1\.0"/);
});

test("npm package and lock root use the same private public identity", () => {
  const packageJson = JSON.parse(read("app/package.json"));
  assert.equal(packageJson.name, "prime-studio");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.description, description);
  assert.equal(packageJson.author, contributors);
  assert.equal(packageJson.license, "MIT");
  for (const forbidden of ["repository", "homepage", "bugs"]) {
    assert.equal(packageJson[forbidden], undefined, `${forbidden} must remain unset`);
  }

  const lock = JSON.parse(read("app/package-lock.json"));
  assert.equal(lock.name, "prime-studio");
  assert.equal(lock.packages[""].name, "prime-studio");
  assert.equal(lock.packages[""].license, "MIT");
});

test("Tauri bundle metadata is explicit, honest, and compatibility-stable", () => {
  const config = JSON.parse(read("app/src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "Prime Studio");
  assert.equal(config.identifier, "dev.primestudio.app");
  assert.equal(config.bundle.publisher, contributors);
  assert.equal(config.bundle.copyright, copyright);
  assert.equal(config.bundle.license, "MIT");
  assert.equal(config.bundle.licenseFile, "../../LICENSE");
  assert.equal(config.bundle.category, "DeveloperTool");
  assert.equal(config.bundle.shortDescription, description);
  assert.match(config.bundle.longDescription, /development snapshot/i);
  assert.match(config.bundle.longDescription, /not a supported product or release candidate/i);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.equal(config.bundle.windows.wix.upgradeCode, "876b9e7d-e060-59f1-acc2-629b8f60957a");
  assert.equal(config.bundle.homepage, undefined);
  for (const forbidden of ["certificateThumbprint", "digestAlgorithm", "timestampUrl", "signCommand"]) {
    assert.equal(config.bundle.windows[forbidden], undefined, `${forbidden} must remain unset`);
  }
  assert.equal(config.plugins?.updater, undefined, "updater endpoints must remain unset");
});

test("legal identity consistently names the contributor collective without individuals", () => {
  const license = read("LICENSE");
  const escapedCopyright = copyright.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(license, new RegExp(`^${escapedCopyright}$`, "m"));
  assert.equal((license.match(/^Copyright \(c\).*$/gm) ?? []).length, 1);

  const releaseManifest = JSON.parse(read("docs/open-source-release-readiness.manifest.json"));
  assert.equal(releaseManifest.provenance.project.copyrightNotice, copyright);

  const authors = read("AUTHORS");
  assert.match(authors, /^# Prime Studio Contributors$/m);
  assert.match(authors, /collectively/i);
  assert.match(authors, /published snapshot/i);
  assert.doesNotMatch(authors, /version history/i);
  assert.match(authors, /does not identify a company/i);
  assert.match(authors, /does not .*claim.*transferred copyright ownership/is);
  assert.doesNotMatch(authors, /@|https?:\/\//i);
});

test("tracked source and documentation contain no stale crate or executable identity", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const textExtensions = new Set([".json", ".lock", ".md", ".mjs", ".rs", ".toml", ".ts", ".tsx", ".yaml", ".yml"]);
  const staleCrate = ["app", "lib"].join("_");
  const staleExecutable = ["app", "exe"].join(".");
  const offenders = [];
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (!textExtensions.has(extname(path)) && path !== "AUTHORS") continue;
    const contents = read(path);
    if (contents.includes(staleCrate) || contents.toLowerCase().includes(staleExecutable)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});
