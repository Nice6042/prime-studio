import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const SOURCE_SCOPES = ["src/app", "src/entities", "src/features", "src/shared"];

async function filesUnder(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.[cm]?[jt]sx?$/u.test(entry.name)) output.push(target);
    }
  }
  if ((await stat(root).catch(() => null))?.isDirectory()) await visit(root);
  return output;
}

function relative(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

export async function findHarnessBoundaryViolations(appRoot) {
  const violations = [];
  const entry = await readFile(path.join(appRoot, "src/App.tsx"), "utf8");
  if (/LegacyApp|VITE_PRIME_STUDIO_WORKSPACE/u.test(entry)) {
    violations.push("src/App.tsx: the legacy session shell must not be a selectable app entry");
  }

  for (const scope of SOURCE_SCOPES) {
    for (const file of await filesUnder(path.join(appRoot, scope))) {
      const body = await readFile(file, "utf8");
      const name = relative(appRoot, file);
      if (/invoke\s*\(\s*["']send_rpc["']/u.test(body)) violations.push(`${name}: raw send_rpc invoke is forbidden`);
      if (/from\s*["']prime-agent["']|import\s*\(\s*["']prime-agent["']/u.test(body)) violations.push(`${name}: renderer cannot import the Harness runtime`);
      if (/type\s*:\s*string\s*;\s*\[\s*k\s*:\s*string\s*\]/u.test(body)) violations.push(`${name}: open command unions are forbidden`);
      if (/\b(?:child_process|node:fs|node:net|node:tls)\b/u.test(body)) violations.push(`${name}: renderer cannot access process, filesystem, or socket primitives`);
    }
  }

  const distAssets = path.join(appRoot, "dist/assets");
  for (const file of await filesUnder(distAssets)) {
    const body = await readFile(file, "utf8");
    if (/send_rpc|--background|legacyHarnessBridge/u.test(body)) {
      violations.push(`${relative(appRoot, file)}: production bundle contains a legacy Harness marker`);
    }
  }
  return violations.sort();
}

export async function main(appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const violations = await findHarnessBoundaryViolations(appRoot);
  if (violations.length > 0) {
    throw new Error(`Harness boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  }
  process.stdout.write("Harness boundary check passed.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
