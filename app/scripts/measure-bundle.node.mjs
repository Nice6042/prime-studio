import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { measureBundle } from "./measure-bundle.mjs";

async function fixture() {
  const distDir = await mkdtemp(join(tmpdir(), "prime-bundle-"));
  await mkdir(join(distDir, ".vite"), { recursive: true });
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), '<script type="module" src="/assets/index.js"></script>');
  await writeFile(join(distDir, "assets", "index.js"), "initial");
  await writeFile(join(distDir, "assets", "vendor.js"), "vendor");
  await writeFile(join(distDir, "assets", "markdown.js"), "markdown");
  await writeFile(join(distDir, "assets", "markdown-vendor.js"), "markdown-vendor");
  await writeFile(
    join(distDir, ".vite", "manifest.json"),
    JSON.stringify({
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["assets/vendor.js"],
        dynamicImports: ["src/Markdown.tsx"],
      },
      "assets/vendor.js": { file: "assets/vendor.js" },
      "src/Markdown.tsx": {
        file: "assets/markdown.js",
        isDynamicEntry: true,
        imports: ["assets/markdown-vendor.js"],
      },
      "assets/markdown-vendor.js": { file: "assets/markdown-vendor.js" },
    }),
  );
  return distDir;
}

const byteLength = (text) => Buffer.byteLength(text);
const gzipLength = (text) => gzipSync(text).length;

test("measures the static Rollup entry closure and keeps dynamic imports out of it", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { recursive: true, force: true }));

  const report = await measureBundle({ distDir });

  assert.deepEqual(report.initial.files, ["assets/index.js", "assets/vendor.js"]);
  assert.equal(report.initial.rawBytes, byteLength("initial") + byteLength("vendor"));
  assert.equal(report.initial.gzipBytes, gzipLength("initial") + gzipLength("vendor"));
  assert.deepEqual(report.lazy, [
    {
      entry: "src/Markdown.tsx",
      files: ["assets/markdown.js", "assets/markdown-vendor.js"],
      rawBytes: byteLength("markdown") + byteLength("markdown-vendor"),
      gzipBytes: gzipLength("markdown") + gzipLength("markdown-vendor"),
    },
  ]);
});

test("rejects a lazy entry closure that exceeds its gzip budget", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { recursive: true, force: true }));

  await assert.rejects(
    measureBundle({ distDir, lazyGzipBudget: 1 }),
    /Lazy entry src\/Markdown\.tsx exceeds gzip budget: \d+ > 1 bytes/,
  );
});
