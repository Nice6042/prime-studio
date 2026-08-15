import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../harness-sidecar/dist/src/", import.meta.url));

async function collect(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolute, relative));
    else if (entry.isFile()) files.push([relative, absolute]);
    else throw new Error(`Unsupported Harness resource type: ${relative}`);
  }
  return files;
}

const resources = {};
for (const [relative, absolute] of await collect(root)) {
  const bytes = await readFile(absolute);
  resources[relative] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

process.stdout.write(`${JSON.stringify({ version: 1, resources })}\n`);
