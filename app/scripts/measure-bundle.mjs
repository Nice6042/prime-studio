import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const BUNDLE_BUDGETS = Object.freeze({
  initialRawBytes: 500000,
  initialGzipBytes: 194560,
  lazyGzipBytes: 122880,
});

function chunkFor(manifest, key) {
  const chunk = manifest[key];
  if (!chunk || typeof chunk.file !== "string") {
    throw new Error("Manifest chunk is missing for " + key);
  }
  return chunk;
}

function staticClosure(manifest, entry) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = chunkFor(manifest, key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entry);
  return [...seen];
}

function reachableDynamicEntries(manifest, entry) {
  const seen = new Set();
  const dynamic = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = chunkFor(manifest, key);
    for (const imported of chunk.imports ?? []) visit(imported);
    for (const imported of chunk.dynamicImports ?? []) {
      dynamic.add(imported);
      visit(imported);
    }
  };
  visit(entry);
  return [...dynamic];
}

async function bytesFor(distDir, manifest, chunks) {
  const files = [];
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const key of chunks) {
    const file = chunkFor(manifest, key).file;
    if (!file.endsWith(".js")) continue;
    const content = await readFile(join(distDir, file));
    files.push(file);
    rawBytes += content.length;
    gzipBytes += gzipSync(content).length;
  }
  return { files, rawBytes, gzipBytes };
}

function withinBudget(label, actual, budget, kind) {
  if (actual > budget) {
    throw new Error(
      label + " exceeds " + kind + " budget: " + actual + " > " + budget + " bytes",
    );
  }
}

/**
 * Measures the JavaScript browser loads for the Vite HTML entry and for each
 * reachable lazy-import entry. Static imports stay in the initial closure;
 * dynamic imports begin separate lazy closures.
 */
export async function measureBundle({
  distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist"),
  initialRawBudget = BUNDLE_BUDGETS.initialRawBytes,
  initialGzipBudget = BUNDLE_BUDGETS.initialGzipBytes,
  lazyGzipBudget = BUNDLE_BUDGETS.lazyGzipBytes,
} = {}) {
  const manifest = JSON.parse(await readFile(join(distDir, ".vite", "manifest.json"), "utf8"));
  const entry = Object.entries(manifest).find(
    ([key, chunk]) => key === "index.html" || (chunk.isEntry && chunk.src === "index.html"),
  )?.[0];
  if (!entry) throw new Error("Vite manifest has no HTML entry");

  const initialChunks = staticClosure(manifest, entry);
  const initial = await bytesFor(distDir, manifest, initialChunks);
  withinBudget("Initial entry closure", initial.rawBytes, initialRawBudget, "raw");
  withinBudget("Initial entry closure", initial.gzipBytes, initialGzipBudget, "gzip");

  const initialSet = new Set(initialChunks);
  const lazy = [];
  for (const lazyEntry of reachableDynamicEntries(manifest, entry)) {
    const chunks = staticClosure(manifest, lazyEntry).filter((key) => !initialSet.has(key));
    const measured = await bytesFor(distDir, manifest, chunks);
    withinBudget("Lazy entry " + lazyEntry, measured.gzipBytes, lazyGzipBudget, "gzip");
    lazy.push({ entry: lazyEntry, ...measured });
  }

  return { initial, lazy };
}

async function main() {
  const distDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const report = await measureBundle({ distDir });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
