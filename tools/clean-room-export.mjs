#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const FIXED_GIT_DATE = "946684800 +0000";
const FIXED_COMMIT_MESSAGE = "Initial public source snapshot\n";
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024 * 1024;
const MAX_PRIVATE_POLICY_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + ((MAX_FILES + 32) * 2048);
const MAX_REPOSITORY_ENTRIES = (MAX_FILES * 4) + 4096;
const ARGUMENTS = new Set([
  "--source",
  "--candidate",
  "--quarantine",
  "--destination",
  "--private-literals-file",
  "--private-literals-hmac-key-file",
  "--author-name",
  "--author-email",
]);

const DENIED_PATH_RULES = [
  ["git-metadata", /(^|\/)\.git(?:\/|$)/iu],
  ["linked-worktree", /(^|\/)\.worktrees(?:\/|$)/iu],
  ["environment-file", /(^|\/)\.env(?:\.[^/]*)?$/iu],
  ["credential-file", /(^|\/)(?:\.npmrc|\.pypirc|\.netrc|credentials\.json|service-account[^/]*\.json|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|\/)/iu],
  ["private-key-file", /\.(?:key|pem|p12|pfx)$/iu],
  ["generated-directory", /(^|\/)(?:node_modules|dist|build|target|coverage|out|\.next|\.turbo|\.cache|__pycache__|playwright-report|test-results)(?:\/|$)/iu],
  ["generated-debug-log", /(^|\/)(?:npm-debug|yarn-debug|yarn-error|debug)\.log$/iu],
];

const CONTENT_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["provider-secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["absolute-home-path", /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s"'<>\0]+/iu],
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ARGUMENTS.has(name) || value === undefined || value.length === 0) {
      fail("usage: every supported option must be supplied once with a nonempty value");
    }
    if (values.has(name)) fail(`duplicate option: ${name}`);
    values.set(name, value);
  }
  for (const name of ARGUMENTS) {
    if (!values.has(name)) fail(`missing required option: ${name}`);
  }
  return Object.fromEntries([...values].map(([name, value]) => [name.slice(2), value]));
}

function cleanGitEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return { ...environment, ...extra };
}

function run(command, args, { cwd, input, encoding = "utf8", allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding,
    maxBuffer: MAX_COMMAND_BYTES,
    windowsHide: true,
    env: command === "git" ? cleanGitEnvironment(env) : { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? "").trim();
    fail(`${command} failed (${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  const result = run("git", args, { cwd, ...options });
  if (options.encoding === null) return result.stdout;
  const output = String(result.stdout ?? "");
  return options.trim === false ? output : output.trim();
}

function canonicalFuturePath(path) {
  if (!isAbsolute(path)) fail("source, quarantine, destination, and private-literals paths must be absolute");
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail("path has no existing parent");
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return suffix.reduce((base, part) => join(base, part), realpathSync(cursor));
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function pathContains(parent, child) {
  const delta = relative(parent, child);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}

function directoryIdentity(path, label) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch {
    fail(`${label} identity is unavailable`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must remain a non-reparse directory`);
  }
  const canonical = realpathSync(path);
  if (!samePath(canonical, path)) {
    fail(`${label} must not be a symlink, junction, mount redirect, or reparse path`);
  }
  return { path: canonical, dev: info.dev.toString(), ino: info.ino.toString() };
}

function assertDirectoryIdentity(expected, label) {
  const actual = directoryIdentity(expected.path, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || !samePath(actual.path, expected.path)) {
    fail(`${label} identity changed during export`);
  }
}

function assertSeparatePaths(source, quarantine, destination, privateFiles, gitMetadataRoots) {
  if (
    pathContains(source, quarantine)
    || pathContains(quarantine, source)
    || pathContains(source, destination)
    || pathContains(destination, source)
  ) {
    fail("quarantine and destination must be outside the source repository");
  }
  if (pathContains(quarantine, destination) || pathContains(destination, quarantine)) {
    fail("quarantine and destination must not overlap");
  }
  for (const privateFile of privateFiles) {
    if (pathContains(source, privateFile)) {
      fail("private policy files must be outside the source repository");
    }
  }
  for (const metadataRoot of gitMetadataRoots) {
    for (const [label, target] of [
      ["quarantine", quarantine],
      ["destination", destination],
      ...privateFiles.map((privateFile) => ["private policy file", privateFile]),
    ]) {
      if (pathContains(metadataRoot, target) || pathContains(target, metadataRoot)) {
        fail(`${label} must not overlap source Git metadata`);
      }
    }
  }
}

function assertNewPath(path, label) {
  if (pathEntryExists(path)) fail(`${label} must not already exist`);
  if (!existsSync(dirname(path)) || !lstatSync(dirname(path)).isDirectory()) {
    fail(`${label} parent must be an existing directory`);
  }
}

function resolveGitDirectory(source, value) {
  return canonicalFuturePath(isAbsolute(value) ? value : resolve(source, value));
}

function sourceGitMetadataRoots(source) {
  return [...new Set([
    resolveGitDirectory(source, git(source, ["rev-parse", "--absolute-git-dir"])),
    resolveGitDirectory(source, git(source, ["rev-parse", "--git-common-dir"])),
  ])];
}

function assertCompleteSourceRepository(source, gitMetadataRoots) {
  if (git(source, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    fail("source repository must not be shallow");
  }
  const promisor = run(
    "git",
    ["config", "--get-regexp", "^(remote\\..*\\.promisor|extensions\\.partialclone)$"],
    { cwd: source, allowFailure: true },
  );
  if (promisor.status !== 0 && promisor.status !== 1) fail("could not verify source clone configuration");
  if (promisor.status === 0 || String(promisor.stdout ?? "").trim() !== "") {
    fail("source repository must not contain partial-clone or promisor configuration");
  }
  const commonDirectory = gitMetadataRoots.at(-1);
  if (existsSync(join(commonDirectory, "objects", "info", "alternates"))) {
    fail("source repository must not use an alternate object database");
  }
  const connectivity = run("git", ["fsck", "--full", "--strict", "--no-reflogs"], {
    cwd: source,
    allowFailure: true,
  });
  if (connectivity.status !== 0) fail("source repository connectivity check failed");
}

function createNewDirectory(path, label) {
  try {
    mkdirSync(path, { recursive: false });
  } catch (error) {
    fail(`${label} could not be created exclusively: ${error instanceof Error ? error.message : String(error)}`);
  }
  return directoryIdentity(path, label);
}

function createOwnedDestinationStaging(destination) {
  assertNewPath(destination, "destination");
  const parent = dirname(destination);
  const parentIdentity = directoryIdentity(parent, "destination parent");
  let staging;
  try {
    staging = mkdtempSync(join(parentIdentity.path, `.${basename(destination)}.clean-room-`));
  } catch (error) {
    fail(`destination staging could not be created exclusively: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    parentIdentity,
    staging,
    stagingIdentity: directoryIdentity(staging, "destination staging"),
  };
}

function captureGitRoots(destination, stagingIdentity) {
  assertDirectoryIdentity(stagingIdentity, "destination staging");
  return {
    git: stagingIdentity,
    objects: directoryIdentity(join(destination, "objects"), "staged Git object directory"),
    refs: directoryIdentity(join(destination, "refs"), "staged Git refs directory"),
    heads: directoryIdentity(join(destination, "refs", "heads"), "staged Git heads directory"),
  };
}

function assertGitRoots(stagingIdentity, gitRoots) {
  assertDirectoryIdentity(stagingIdentity, "destination staging");
  assertDirectoryIdentity(gitRoots.git, "staged Git directory");
  assertDirectoryIdentity(gitRoots.objects, "staged Git object directory");
  assertDirectoryIdentity(gitRoots.refs, "staged Git refs directory");
  assertDirectoryIdentity(gitRoots.heads, "staged Git heads directory");
}

function assertRepositoryFilesystem(repositoryIdentity, gitRoots, label) {
  assertGitRoots(repositoryIdentity, gitRoots);
  let entryCount = 0;
  const visit = (directoryPath) => {
    const identity = directoryIdentity(directoryPath, `${label} directory`);
    if (!pathContains(repositoryIdentity.path, identity.path)) {
      fail(`${label} contains a directory outside its verified root`);
    }
    for (const name of readdirSync(identity.path)) {
      entryCount += 1;
      if (entryCount > MAX_REPOSITORY_ENTRIES) fail(`${label} contains too many filesystem entries`);
      const entryPath = join(identity.path, name);
      const info = lstatSync(entryPath, { bigint: true });
      if (info.isSymbolicLink()) fail(`${label} contains a reparse entry`);
      if (info.isDirectory()) visit(entryPath);
      else if (!info.isFile()) fail(`${label} contains an unsupported filesystem entry`);
    }
    assertDirectoryIdentity(identity, `${label} directory`);
  };
  visit(repositoryIdentity.path);
  assertGitRoots(repositoryIdentity, gitRoots);
}

function relocateGitRoots(stagingIdentity, finalIdentity, gitRoots) {
  const relocate = (identity, label) => {
    const suffix = relative(stagingIdentity.path, identity.path);
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      fail(`${label} was not contained by destination staging`);
    }
    const relocated = directoryIdentity(join(finalIdentity.path, suffix), label);
    if (relocated.dev !== identity.dev || relocated.ino !== identity.ino) {
      fail(`${label} identity changed during atomic placement`);
    }
    return relocated;
  };
  return {
    git: finalIdentity,
    objects: relocate(gitRoots.objects, "destination Git object directory"),
    refs: relocate(gitRoots.refs, "destination Git refs directory"),
    heads: relocate(gitRoots.heads, "destination Git heads directory"),
  };
}

function placeDestinationAtomically({ destination, parentIdentity, staging, stagingIdentity, gitRoots }) {
  assertDirectoryIdentity(parentIdentity, "destination parent");
  assertRepositoryFilesystem(stagingIdentity, gitRoots, "destination staging");
  if (pathEntryExists(destination)) fail("destination appeared before atomic placement and was not overwritten");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) fail("trusted Windows system root is unavailable");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const moveEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PRIME_CLEAN_ROOM_STAGING: staging,
    PRIME_CLEAN_ROOM_DESTINATION: destination,
  };
  const move = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; [System.IO.Directory]::Move($env:PRIME_CLEAN_ROOM_STAGING, $env:PRIME_CLEAN_ROOM_DESTINATION)",
    ],
    { encoding: "utf8", env: moveEnvironment, windowsHide: true, maxBuffer: MAX_COMMAND_BYTES },
  );
  if (move.error || move.status !== 0) {
    const detail = String(move.stderr ?? "").trim();
    fail(`destination atomic no-replace placement failed${detail ? `: ${detail}` : ""}`);
  }
  const finalIdentity = directoryIdentity(destination, "destination");
  if (finalIdentity.dev !== stagingIdentity.dev || finalIdentity.ino !== stagingIdentity.ino) {
    fail("destination identity differs from the verified staging directory after atomic placement");
  }
  if (existsSync(staging)) fail("destination staging still exists after atomic placement");
  assertDirectoryIdentity(parentIdentity, "destination parent");
  const finalGitRoots = relocateGitRoots(stagingIdentity, finalIdentity, gitRoots);
  assertRepositoryFilesystem(finalIdentity, finalGitRoots, "destination");
  return { finalIdentity, finalGitRoots };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedFile(path, maximumBytes, label, exactBytes) {
  const descriptor = openSync(path, "r");
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximumBytes || (exactBytes !== undefined && info.size !== exactBytes)) {
      fail(`${label} has an invalid type or byte length`);
    }
    assertFileDescriptorPath(path, info, label);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed during its bounded read`);
      offset += count;
    }
    const finalInfo = fstatSync(descriptor);
    if (finalInfo.size !== info.size || finalInfo.dev !== info.dev || finalInfo.ino !== info.ino) {
      fail(`${label} identity changed during its bounded read`);
    }
    assertFileDescriptorPath(path, finalInfo, label);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function assertFileDescriptorPath(path, descriptorInfo, label) {
  let pathInfo;
  try {
    pathInfo = lstatSync(path);
  } catch {
    fail(`${label} path identity is unavailable`);
  }
  if (
    !pathInfo.isFile()
    || pathInfo.isSymbolicLink()
    || pathInfo.dev !== descriptorInfo.dev
    || pathInfo.ino !== descriptorInfo.ino
  ) {
    fail(`${label} path differs from its held file descriptor`);
  }
}

function readPrivateLiterals(path, hmacKeyPath) {
  const rawBytes = readBoundedFile(path, MAX_PRIVATE_POLICY_BYTES, "private literals file");
  const raw = rawBytes.toString("utf8");
  const hmacKey = readBoundedFile(hmacKeyPath, 32, "private literals HMAC key file", 32);
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    fail("private literals file must contain valid JSON");
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > 256) {
    fail("private literals file must be a nonempty JSON array of at most 256 strings");
  }
  const unique = new Map();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 3 || value.length > 256 || /[\r\n\0]/u.test(value)) {
      fail("each private literal must be a 3-256 character single-line string");
    }
    unique.set(value.toLocaleLowerCase("en-US"), value);
  }
  return {
    binding: createHmac("sha256", hmacKey)
      .update("prime-studio-private-denylist-v1\0", "utf8")
      .update(rawBytes)
      .digest("hex"),
    rules: [...unique.values()].map((value, index) => ({
      value,
      folded: value.toLocaleLowerCase("en-US"),
      rule: `private-literal-${String(index + 1).padStart(3, "0")}`,
    })),
  };
}

function validateIdentity(name, email, privateLiterals) {
  if (name.length > 128 || /[<>\r\n\0@]/u.test(name) || name.trim() !== name) {
    fail("author name must be a trimmed neutral display name without email syntax");
  }
  if (email.length > 160 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.invalid$/u.test(email)) {
    fail("author email must use a neutral .invalid domain");
  }
  const metadata = `${name}\n${email}`.toLocaleLowerCase("en-US");
  if (privateLiterals.some(({ folded }) => metadata.includes(folded))) {
    fail("author identity matches a private literal");
  }
}

function parseTreeEntries(source, candidate) {
  const output = git(source, ["ls-tree", "-r", "-z", "-l", candidate], { trim: false });
  const records = output.split("\0").filter(Boolean);
  if (records.length > MAX_FILES) fail(`candidate exceeds ${MAX_FILES} files`);
  return records.map((record) => {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/u.exec(record);
    if (!match) fail("candidate contains an unparseable tree entry");
    const [, mode, type, oid, sizeText, path] = match;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      fail("candidate contains a symlink, submodule, or unsupported Git entry mode");
    }
    if (/[\u0000-\u001f\u007f]/u.test(path) || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail("candidate contains an unsafe path");
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      fail(`candidate contains a file outside the ${MAX_FILE_BYTES}-byte limit`);
    }
    return { mode, oid, path, size };
  });
}

function pathFinding(_path, rule) {
  return { rule };
}

function scanPaths(entries, privateLiterals) {
  const findings = [];
  for (const { path } of entries) {
    for (const [rule, pattern] of DENIED_PATH_RULES) {
      if (pattern.test(path)) findings.push(pathFinding(path, rule));
    }
    const foldedPath = path.toLocaleLowerCase("en-US");
    for (const literal of privateLiterals) {
      if (foldedPath.includes(literal.folded)) findings.push(pathFinding(path, literal.rule));
    }
  }
  return findings;
}

function sameStringList(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} does not match the candidate file closure`);
  }
}

function decodedTextViews(bytes) {
  const views = [bytes.toString("utf8"), bytes.toString("latin1")];
  for (const offset of [0, 1]) {
    const available = bytes.length - offset;
    const evenLength = available - (available % 2);
    const aligned = bytes.subarray(offset, offset + evenLength);
    const swapped = Buffer.allocUnsafe(evenLength);
    for (let index = 0; index < evenLength; index += 2) {
      swapped[index] = aligned[index + 1];
      swapped[index + 1] = aligned[index];
    }
    views.push(aligned.toString("utf16le"), swapped.toString("utf16le"));
  }
  return views;
}

function scanPayload(source, archiveMembers, entries, privateLiterals) {
  const findings = [];
  let archivePayloadBytes = 0;
  let candidateBytes = 0;
  for (const entry of entries) {
    const archiveBytes = archiveMembers.get(entry.path);
    if (!archiveBytes) fail("archive is missing a candidate file");
    archivePayloadBytes += archiveBytes.length;
    if (archivePayloadBytes > MAX_TOTAL_BYTES) fail(`archive payload exceeds ${MAX_TOTAL_BYTES} total bytes`);
    const blobBytes = git(source, ["cat-file", "blob", entry.oid], { encoding: null });
    if (blobBytes.length !== entry.size) fail("candidate blob size differs from its tree entry");
    candidateBytes += blobBytes.length;
    const textViews = [...decodedTextViews(archiveBytes), ...decodedTextViews(blobBytes)];
    for (const [rule, pattern] of CONTENT_RULES) {
      if (textViews.some((text) => pattern.test(text))) findings.push(pathFinding(entry.path, rule));
    }
    const foldedViews = textViews.map((text) => text.toLocaleLowerCase("en-US"));
    for (const literal of privateLiterals) {
      if (foldedViews.some((text) => text.includes(literal.folded))) {
        findings.push(pathFinding(entry.path, literal.rule));
      }
    }
  }
  return { findings, candidateBytes, archivePayloadBytes };
}

function findingSummary(findings) {
  const byRule = {};
  for (const { rule } of findings) byRule[rule] = (byRule[rule] ?? 0) + 1;
  return { total: findings.length, byRule, redacted: findings };
}

function writeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

function tarText(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarNumber(block, offset, length, label) {
  const field = block.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) fail(`archive ${label} uses unsupported base-256 encoding`);
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) fail(`archive ${label} is not a bounded octal value`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`archive ${label} is outside safe bounds`);
  return parsed;
}

function parsePax(bytes) {
  const values = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) fail("archive contains malformed PAX metadata");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("archive contains malformed PAX record length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      fail("archive contains out-of-bounds PAX metadata");
    }
    const record = bytes.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("archive contains malformed PAX key/value metadata");
    values.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return values;
}

function parseArchive(archiveBytes, entries) {
  if (archiveBytes.length > MAX_ARCHIVE_BYTES || archiveBytes.length % 512 !== 0) {
    fail("archive exceeds its bounded size or block alignment");
  }
  const expected = new Set(entries.map(({ path }) => path));
  const members = new Map();
  let offset = 0;
  let pendingPax = new Map();
  let sawEnd = false;
  while (offset + 512 <= archiveBytes.length) {
    const header = archiveBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      if (!archiveBytes.subarray(offset).every((byte) => byte === 0)) {
        fail("archive contains data after its end marker");
      }
      break;
    }
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (tarNumber(header, 148, 8, "checksum") !== checksum) fail("archive header checksum differs");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = tarText(header, 345, 155);
    const headerName = tarText(header, 0, 100);
    let path = pendingPax.get("path") ?? (prefix ? `${prefix}/${headerName}` : headerName);
    let size = tarNumber(header, 124, 12, "member size");
    if (pendingPax.has("size")) {
      const paxSize = pendingPax.get("size");
      if (!/^(?:0|[1-9][0-9]*)$/u.test(paxSize)) fail("archive PAX size is invalid");
      size = Number(paxSize);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      fail("archive member exceeds the per-file size limit");
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + (Math.ceil(size / 512) * 512);
    if (dataEnd > archiveBytes.length || paddedEnd > archiveBytes.length) {
      fail("archive member extends beyond the archive bounds");
    }
    const data = archiveBytes.subarray(dataStart, dataEnd);
    if (type === "x" || type === "g") {
      const pax = parsePax(data);
      pendingPax = type === "x" ? pax : new Map();
      offset = paddedEnd;
      continue;
    }
    if (type === "5" && path.endsWith("/")) path = path.slice(0, -1);
    if (/[\u0000-\u001f\u007f\\\\]/u.test(path) || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail("archive contains an unsafe member path");
    }
    if (type === "0") {
      if (!expected.has(path) || members.has(path)) fail("archive contains an unexpected or duplicate file member");
      members.set(path, data);
    } else if (type === "5") {
      if (size !== 0 || ![...expected].some((candidatePath) => candidatePath.startsWith(`${path}/`))) {
        fail("archive contains an unexpected directory member");
      }
    } else {
      fail(`archive contains unsupported member type ${JSON.stringify(type)}`);
    }
    pendingPax = new Map();
    offset = paddedEnd;
  }
  if (!sawEnd) fail("archive is missing its zero-block end marker");
  sameStringList([...members.keys()].sort(), [...expected].sort(), "archive member list");
  return members;
}

function createArchive(source, candidate, quarantine, entries) {
  const quarantineIdentity = createNewDirectory(quarantine, "quarantine");
  const archive = join(quarantine, "candidate.tar");
  assertDirectoryIdentity(quarantineIdentity, "quarantine");
  const archiveDescriptor = openSync(archive, "wx+");
  try {
    const result = spawnSync("git", ["archive", "--format=tar", candidate], {
      cwd: source,
      stdio: ["ignore", archiveDescriptor, "pipe"],
      windowsHide: true,
      env: cleanGitEnvironment(),
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_BYTES,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`git archive failed (${result.status}): ${String(result.stderr ?? "").trim()}`);
    assertDirectoryIdentity(quarantineIdentity, "quarantine");
    const archiveInfo = fstatSync(archiveDescriptor);
    if (!archiveInfo.isFile() || archiveInfo.size > MAX_ARCHIVE_BYTES) {
      fail("archive has an invalid type or exceeds its bounded size limit");
    }
    assertFileDescriptorPath(archive, archiveInfo, "candidate archive");
    const archiveBytes = Buffer.alloc(archiveInfo.size);
    let offset = 0;
    while (offset < archiveBytes.length) {
      const count = readSync(archiveDescriptor, archiveBytes, offset, archiveBytes.length - offset, offset);
      if (count === 0) fail("candidate archive changed during its bounded read");
      offset += count;
    }
    const finalArchiveInfo = fstatSync(archiveDescriptor);
    if (
      finalArchiveInfo.size !== archiveInfo.size
      || finalArchiveInfo.dev !== archiveInfo.dev
      || finalArchiveInfo.ino !== archiveInfo.ino
    ) {
      fail("candidate archive identity changed during its bounded read");
    }
    assertFileDescriptorPath(archive, finalArchiveInfo, "candidate archive");
    const members = parseArchive(archiveBytes, entries);
    assertFileDescriptorPath(archive, finalArchiveInfo, "candidate archive");
    assertDirectoryIdentity(quarantineIdentity, "quarantine");
    return { archive, archiveBytes, members, quarantineIdentity };
  } finally {
    closeSync(archiveDescriptor);
  }
}

function treeObjectIds(source, candidate, sourceTree) {
  const output = git(source, ["ls-tree", "-r", "-t", "-z", candidate], { trim: false });
  const trees = new Set([sourceTree]);
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t[\s\S]+$/u.exec(record);
    if (!match) fail("candidate contains an unparseable recursive tree entry");
    if (match[2] === "tree") trees.add(match[3]);
  }
  return [...trees].sort();
}

function writeObject(source, destination, stagingIdentity, gitRoots, type, oid) {
  assertGitRoots(stagingIdentity, gitRoots);
  const bytes = git(source, ["cat-file", type, oid], { encoding: null });
  const written = git(destination, ["hash-object", "-t", type, "-w", "--stdin"], {
    input: bytes,
    encoding: null,
  }).toString("utf8").trim();
  assertGitRoots(stagingIdentity, gitRoots);
  if (written !== oid) fail(`destination ${type} hash differs from candidate object hash`);
}

function buildDestination({ source, candidate, destination, stagingIdentity, entries, sourceTree, objectFormat, name, email }) {
  assertDirectoryIdentity(stagingIdentity, "destination staging");
  git(destination, ["init", "--bare", "--initial-branch=main", `--object-format=${objectFormat}`]);
  const gitRoots = captureGitRoots(destination, stagingIdentity);
  git(destination, ["config", "core.logAllRefUpdates", "false"]);
  assertGitRoots(stagingIdentity, gitRoots);
  git(destination, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  assertGitRoots(stagingIdentity, gitRoots);

  for (const entry of entries) writeObject(source, destination, stagingIdentity, gitRoots, "blob", entry.oid);
  for (const treeOid of treeObjectIds(source, candidate, sourceTree)) {
    writeObject(source, destination, stagingIdentity, gitRoots, "tree", treeOid);
  }
  const destinationTree = sourceTree;
  const identityEnvironment = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  };
  const commit = git(destination, ["commit-tree", destinationTree], {
    input: FIXED_COMMIT_MESSAGE,
    env: identityEnvironment,
  });
  assertGitRoots(stagingIdentity, gitRoots);
  git(destination, ["update-ref", "refs/heads/main", commit]);
  assertGitRoots(stagingIdentity, gitRoots);
  assertRepositoryFilesystem(stagingIdentity, gitRoots, "destination staging");
  return { commit, destinationTree, gitRoots };
}

function readObjectInventory(destination) {
  const records = git(destination, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ]).split(/\r?\n/u).filter(Boolean);
  const inventoryIds = records.map((record) => record.split(" ", 1)[0]).sort();
  const reachableIds = git(destination, ["rev-list", "--objects", "--all"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((record) => record.split(" ", 1)[0])
    .sort();
  sameStringList(inventoryIds, reachableIds, "destination object inventory");
  const counts = { commits: 0, trees: 0, blobs: 0, tags: 0 };
  for (const record of records) {
    const type = record.slice(record.lastIndexOf(" ") + 1);
    const field = `${type}s`;
    if (!(field in counts)) fail(`destination contains an unsupported object type: ${type}`);
    counts[field] += 1;
  }
  if (counts.commits !== 1 || counts.tags !== 0) {
    fail("destination object inventory must contain one commit and no tag objects");
  }
  return { total: records.length, ...counts };
}

function verifyDestination({ source, destination, repositoryIdentity, gitRoots, entries, sourceTree, commit, name, email }) {
  assertRepositoryFilesystem(repositoryIdentity, gitRoots, "verified repository");
  const refs = git(destination, ["for-each-ref", "--format=%(refname)"])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (refs.length !== 1 || refs[0] !== "refs/heads/main") fail("destination has unapproved refs");
  if (git(destination, ["rev-list", "--all", "--count"]) !== "1") fail("destination must contain exactly one reachable commit");
  if (git(destination, ["rev-list", "--all", "--max-parents=0", "--count"]) !== "1") fail("destination must contain exactly one root commit");
  if (git(destination, ["rev-list", "--parents", "-1", commit]).split(" ").length !== 1) fail("destination commit must be parentless");
  if (git(destination, ["rev-parse", `${commit}^{tree}`]) !== sourceTree) fail("destination commit tree changed");
  if (git(destination, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>", commit]) !== `${name} <${email}>\n${name} <${email}>`) fail("destination identity differs from requested neutral identity");
  if (git(destination, ["show", "-s", "--format=%at %ai%n%ct %ci", commit]) !== "946684800 2000-01-01 00:00:00 +0000\n946684800 2000-01-01 00:00:00 +0000") fail("destination contains a non-neutral commit timestamp");
  if (git(destination, ["remote"]) !== "") fail("destination must not contain remotes");
  if (git(destination, ["reflog", "show", "--all"]) !== "") fail("destination must not contain reflogs");
  if (git(destination, ["rev-parse", "--is-shallow-repository"]) !== "false") fail("destination must not be shallow");
  for (const relativePath of ["objects/info/alternates", "shallow", "info/grafts", "logs"]) {
    if (pathEntryExists(join(destination, ...relativePath.split("/")))) fail(`destination contains forbidden Git state: ${relativePath}`);
  }
  const partialCloneConfig = run(
    "git",
    ["config", "--local", "--get-regexp", "^(remote\\..*\\.promisor|extensions\\.partialclone)$"],
    { cwd: destination, allowFailure: true },
  );
  if (partialCloneConfig.status === 0 || String(partialCloneConfig.stdout ?? "").trim() !== "") fail("destination contains partial-clone or promisor configuration");
  const fsck = git(destination, ["fsck", "--full", "--no-reflogs", "--unreachable"]);
  if (fsck !== "") fail("destination object closure verification failed");
  for (const entry of entries) {
    const destinationBytes = git(destination, ["cat-file", "blob", entry.oid], { encoding: null });
    const sourceBytes = git(source, ["cat-file", "blob", entry.oid], { encoding: null });
    if (!destinationBytes.equals(sourceBytes) || destinationBytes.length !== entry.size) {
      fail("destination raw blob bytes differ from the committed candidate");
    }
  }
  const objectInventory = readObjectInventory(destination);
  assertRepositoryFilesystem(repositoryIdentity, gitRoots, "verified repository");
  return { refs, objectInventory };
}

function manifestDigest(entries) {
  return sha256(entries.map(({ mode, oid, size, path }) => `${mode}\0${oid}\0${size}\0${path}\n`).join(""));
}

function main() {
  if (process.platform !== "win32") fail("clean-room export is supported only on Windows");
  const args = parseArguments(process.argv.slice(2));
  const source = canonicalFuturePath(args.source);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail("source must be an existing repository directory");
  const quarantine = canonicalFuturePath(args.quarantine);
  const destination = canonicalFuturePath(args.destination);
  const literalsFile = canonicalFuturePath(args["private-literals-file"]);
  const literalsHmacKeyFile = canonicalFuturePath(args["private-literals-hmac-key-file"]);
  if (!existsSync(literalsFile) || !lstatSync(literalsFile).isFile()) fail("private literals file must exist");
  if (!existsSync(literalsHmacKeyFile) || !lstatSync(literalsHmacKeyFile).isFile()) fail("private literals HMAC key file must exist");
  const sourceRoot = canonicalFuturePath(git(source, ["rev-parse", "--show-toplevel"]));
  if (source !== sourceRoot) fail("source must name the repository root exactly");
  const gitMetadataRoots = sourceGitMetadataRoots(source);
  assertCompleteSourceRepository(source, gitMetadataRoots);
  assertSeparatePaths(source, quarantine, destination, [literalsFile, literalsHmacKeyFile], gitMetadataRoots);
  assertNewPath(quarantine, "quarantine");
  assertNewPath(destination, "destination");

  const objectFormat = git(source, ["rev-parse", "--show-object-format"]);
  const expectedLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (expectedLength === 0 || !new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(args.candidate)) {
    fail("candidate must be a lowercase full object ID for the source repository");
  }
  const candidate = git(source, ["rev-parse", "--verify", `${args.candidate}^{commit}`]);
  if (candidate !== args.candidate) fail("candidate must resolve exactly to the supplied commit object ID");

  const privatePolicy = readPrivateLiterals(literalsFile, literalsHmacKeyFile);
  const privateLiterals = privatePolicy.rules;
  validateIdentity(args["author-name"], args["author-email"], privateLiterals);
  const entries = parseTreeEntries(source, candidate);
  const candidateTotalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (!Number.isSafeInteger(candidateTotalBytes) || candidateTotalBytes > MAX_TOTAL_BYTES) {
    fail(`candidate exceeds ${MAX_TOTAL_BYTES} total bytes`);
  }
  const sourceTree = git(source, ["rev-parse", `${candidate}^{tree}`]);
  const pathFindings = scanPaths(entries, privateLiterals);
  const { archiveBytes, members, quarantineIdentity } = createArchive(source, candidate, quarantine, entries);
  const payloadScan = scanPayload(source, members, entries, privateLiterals);
  if (payloadScan.candidateBytes !== candidateTotalBytes) fail("candidate byte closure differs from the candidate tree");
  const findings = [...pathFindings, ...payloadScan.findings];
  const baseReport = {
    schemaVersion: 1,
    status: findings.length === 0 ? "approved-for-local-object-store-construction" : "rejected",
    candidate,
    sourceTree,
    objectFormat,
    archiveSha256: sha256(archiveBytes),
    fileManifestSha256: manifestDigest(entries),
    fileCount: entries.length,
    candidateBytes: payloadScan.candidateBytes,
    archivePayloadBytes: payloadScan.archivePayloadBytes,
    scanners: {
      builtInPathRuleCount: DENIED_PATH_RULES.length,
      builtInContentRuleCount: CONTENT_RULES.length,
      privateLiteralRuleIds: privateLiterals.map(({ rule }) => rule).sort(),
      privateDenylistHmacSha256: privatePolicy.binding,
    },
    findings: findingSummary(findings),
  };
  const reportPath = join(quarantine, "public-export-audit.json");
  if (findings.length > 0) {
    writeReport(reportPath, baseReport);
    fail(`candidate rejected by ${findings.length} redacted scanner finding(s)`);
  }

  assertDirectoryIdentity(quarantineIdentity, "quarantine");
  const ownedDestination = createOwnedDestinationStaging(destination);
  const { commit, destinationTree, gitRoots } = buildDestination({
    source,
    candidate,
    destination: ownedDestination.staging,
    stagingIdentity: ownedDestination.stagingIdentity,
    entries,
    sourceTree,
    objectFormat,
    name: args["author-name"],
    email: args["author-email"],
  });
  assertDirectoryIdentity(ownedDestination.stagingIdentity, "destination staging");
  const verifiedStaging = verifyDestination({
    source,
    destination: ownedDestination.staging,
    repositoryIdentity: ownedDestination.stagingIdentity,
    gitRoots,
    entries,
    sourceTree,
    commit,
    name: args["author-name"],
    email: args["author-email"],
  });
  assertDirectoryIdentity(ownedDestination.stagingIdentity, "destination staging");
  assertDirectoryIdentity(quarantineIdentity, "quarantine");
  const { finalIdentity, finalGitRoots } = placeDestinationAtomically({
    destination,
    gitRoots,
    ...ownedDestination,
  });
  const verifiedDestination = verifyDestination({
    source,
    destination,
    repositoryIdentity: finalIdentity,
    gitRoots: finalGitRoots,
    entries,
    sourceTree,
    commit,
    name: args["author-name"],
    email: args["author-email"],
  });
  if (JSON.stringify(verifiedDestination) !== JSON.stringify(verifiedStaging)) {
    fail("destination verification changed during atomic placement");
  }
  assertDirectoryIdentity(quarantineIdentity, "quarantine");
  writeReport(reportPath, {
    ...baseReport,
    status: "verified-local-candidate",
    destinationTree,
    destinationCommit: commit,
    topology: {
      commitCount: 1,
      rootCommitCount: 1,
      refs: verifiedDestination.refs,
      remotes: 0,
      reflogs: 0,
      alternates: 0,
      unreachableObjects: 0,
      objectInventory: verifiedDestination.objectInventory,
    },
    publication: "not-authorized",
  });
  process.stdout.write(`${JSON.stringify({ status: "verified-local-candidate", candidate, sourceTree, destinationTree, commit })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`clean-room export failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
