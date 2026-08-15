import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const REQUIRED_EXPORT_MARKERS = Object.freeze([
  "AuthStorage",
  "DAEMON_PROTOCOL_INFO",
  "DaemonAgentConnection",
  "DaemonClient",
  "ModelRegistry",
  "defaultDaemonSocketPath",
]);

function usage() {
  throw new Error("usage: node audit-prime-release-profile.mjs <release-url> <version> <sha256-hex>");
}

const [releaseUrlText, expectedVersion, expectedArchiveDigest] = process.argv.slice(2);
if (!releaseUrlText || !expectedVersion || !expectedArchiveDigest) usage();
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || !/^[a-f0-9]{64}$/.test(expectedArchiveDigest)) usage();

const releaseUrl = new URL(releaseUrlText);
const expectedPath = `/PrimeIntellect-ai/prime-agent/releases/download/v${expectedVersion}/prime-agent-${expectedVersion}.tgz`;
if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com" || releaseUrl.pathname !== expectedPath || releaseUrl.search || releaseUrl.hash) {
  throw new Error("release URL is not the exact official Prime package asset");
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decodeText = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const readCString = (header, start, length) => {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return decodeText(end === -1 ? field : field.subarray(0, end)).trim();
};
const readOctal = (header, start, length) => {
  const value = readCString(header, start, length).replaceAll("\0", "").trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("tar numeric field is not canonical octal");
  const parsed = value === "" ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("tar numeric field is out of range");
  return parsed;
};
const verifyHeaderChecksum = (header) => {
  const expected = readOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index];
  if (actual !== expected) throw new Error("tar header checksum mismatch");
};
const safeArchivePath = (value) => {
  if (!value || value.length > 4096 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments[0] === "package" && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
};
const parsePax = (bytes) => {
  const text = decodeText(bytes);
  const records = new Map();
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) throw new Error("invalid PAX record length");
    const lengthText = text.slice(offset, space);
    if (!/^[1-9]\d*$/.test(lengthText)) throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > text.length) throw new Error("PAX record is out of range");
    const record = text.slice(space + 1, offset + length - 1);
    const separator = record.indexOf("=");
    if (separator <= 0) throw new Error("invalid PAX record");
    records.set(record.slice(0, separator), record.slice(separator + 1));
    offset += length;
  }
  return records;
};

const response = await fetch(releaseUrl, {
  redirect: "follow",
  headers: { "user-agent": "Prime-Studio-runtime-profile-audit" },
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`release download failed with HTTP ${response.status}`);
const declaredLength = Number(response.headers.get("content-length") ?? "0");
if (declaredLength && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_COMPRESSED_BYTES)) throw new Error("release archive is too large");
const archive = new Uint8Array(await response.arrayBuffer());
if (archive.byteLength === 0 || archive.byteLength > MAX_COMPRESSED_BYTES) throw new Error("release archive size is invalid");
const archiveDigest = digest(archive);
if (archiveDigest !== expectedArchiveDigest) throw new Error("release archive digest mismatch");

const tar = new Uint8Array(gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }));
const files = new Map();
let offset = 0;
let entryCount = 0;
let regularBytes = 0;
let pendingPath = null;
while (offset + 512 <= tar.byteLength) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  verifyHeaderChecksum(header);
  entryCount += 1;
  if (entryCount > MAX_ENTRIES) throw new Error("release archive has too many entries");
  const name = readCString(header, 0, 100);
  const prefix = readCString(header, 345, 155);
  const headerPath = prefix ? `${prefix}/${name}` : name;
  const size = readOctal(header, 124, 12);
  const type = String.fromCharCode(header[156] || 0x30);
  const dataStart = offset + 512;
  const dataEnd = dataStart + size;
  if (dataEnd > tar.byteLength) throw new Error("tar entry exceeds the archive");
  const data = tar.subarray(dataStart, dataEnd);
  offset = dataStart + Math.ceil(size / 512) * 512;

  if (type === "x") {
    const pax = parsePax(data);
    const path = pax.get("path");
    for (const key of pax.keys()) if (key !== "path" && key !== "size" && key !== "mtime") throw new Error(`unsupported PAX key: ${key}`);
    if (path !== undefined) pendingPath = path;
    continue;
  }
  if (type === "L") {
    const terminator = data.indexOf(0);
    pendingPath = decodeText(terminator === -1 ? data : data.subarray(0, terminator));
    continue;
  }
  const path = pendingPath ?? headerPath;
  pendingPath = null;
  if (!safeArchivePath(path)) throw new Error(`unsafe release archive path: ${path}`);
  if (type === "5") continue;
  if (type !== "0" && type !== "\0") throw new Error(`unsupported archive entry type ${JSON.stringify(type)} at ${path}`);
  if (files.has(path)) throw new Error(`duplicate release archive path: ${path}`);
  regularBytes += size;
  if (!Number.isSafeInteger(regularBytes) || regularBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("release archive regular-file budget exceeded");
  files.set(path, data);
}
if (pendingPath !== null) throw new Error("release archive ended with an unresolved path extension");

const manifestBytes = files.get("package/package.json");
if (!manifestBytes) throw new Error("release package manifest is missing");
const manifest = JSON.parse(decodeText(manifestBytes));
if (manifest.name !== "prime-agent" || manifest.version !== expectedVersion) throw new Error("release package identity mismatch");
const publicExport = manifest.exports?.["."]?.import ?? manifest.exports?.["."] ?? manifest.module ?? "./dist/index.js";
if (typeof publicExport !== "string" || !publicExport.startsWith("./")) throw new Error("release public export is unsupported");
const publicPath = `package/${publicExport.slice(2)}`;
if (!safeArchivePath(publicPath)) throw new Error("release public export escaped the package");
const publicBytes = files.get(publicPath);
if (!publicBytes) throw new Error("release public export is missing");
const daemonPath = "package/dist/bundle/cli.js";
const daemonBytes = files.get(daemonPath);
if (!daemonBytes) throw new Error("release daemon CLI entry is missing");
const publicText = decodeText(publicBytes);
const exportMarkers = Object.fromEntries(REQUIRED_EXPORT_MARKERS.map((marker) => [marker, publicText.includes(marker)]));

const result = Object.freeze({
  source: releaseUrl.toString(),
  archive: { bytes: archive.byteLength, sha256: archiveDigest },
  package: {
    name: manifest.name,
    version: manifest.version,
    files: files.size,
    regularBytes,
    manifest: { path: "package/package.json", bytes: manifestBytes.byteLength, sha256: digest(manifestBytes) },
    publicEntrypoint: { path: publicPath.slice("package/".length), bytes: publicBytes.byteLength, sha256: digest(publicBytes) },
    daemonEntrypoint: { path: daemonPath.slice("package/".length), bytes: daemonBytes.byteLength, sha256: digest(daemonBytes) },
    reviewedExportMarkers: exportMarkers,
  },
});
console.log(JSON.stringify(result, null, 2));
