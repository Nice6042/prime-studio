import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalizeIcns(input) {
  const file = Buffer.from(input);
  if (file.length < 8 || file.toString("ascii", 0, 4) !== "icns") {
    throw new Error("expected an ICNS file");
  }
  if (file.readUInt32BE(4) !== file.length) {
    throw new Error("ICNS header length does not match the file length");
  }

  const chunks = [];
  for (let offset = 8; offset < file.length; ) {
    if (offset + 8 > file.length) {
      throw new Error("ICNS chunk header extends past the file boundary");
    }
    const length = file.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > file.length) {
      throw new Error("ICNS chunk extends past the file boundary");
    }
    chunks.push(file.subarray(offset, offset + length));
    offset += length;
  }

  chunks.sort((left, right) => {
    const typeOrder = left.subarray(0, 4).compare(right.subarray(0, 4));
    return typeOrder || left.compare(right);
  });
  return Buffer.concat([file.subarray(0, 8), ...chunks]);
}

async function main() {
  const [path] = process.argv.slice(2);
  if (!path || process.argv.length !== 3) {
    throw new Error("usage: node canonicalize-icns.mjs <icon.icns>");
  }
  const icon = await readFile(path);
  await writeFile(path, canonicalizeIcns(icon));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
