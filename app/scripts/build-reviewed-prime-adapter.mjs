import { statSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootArgument = process.argv[2];
if (!rootArgument || !isAbsolute(rootArgument)) {
  throw new Error("usage: node scripts/build-reviewed-prime-adapter.mjs <absolute-prime-agent-package-root>");
}
const packageRoot = await realpath(rootArgument);
const manifestBytes = await readFile(resolve(packageRoot, "package.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.name !== "prime-agent" || manifest.version !== "0.7.1") {
  throw new Error("Prime package identity is not the reviewed prime-agent 0.7.1 release");
}
const publicRoot = await realpath(resolve(packageRoot, "dist", "index.js"));
if (relative(packageRoot, publicRoot).startsWith("..")) throw new Error("Prime public root escaped its package");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
if (digest(manifestBytes) !== "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900"
  || digest(await readFile(publicRoot)) !== "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b") {
  throw new Error("Prime package bytes do not match the reviewed 0.7.1 profile");
}
const outputPath = fileURLToPath(new URL("../harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs", import.meta.url));

await build({
  stdin: {
    contents: `export { AuthStorage, DAEMON_PROTOCOL_INFO, DaemonAgentConnection, DaemonClient, ModelRegistry, defaultDaemonSocketPath } from ${JSON.stringify(publicRoot)};`,
    loader: "js",
    resolveDir: packageRoot,
  },
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
  minify: true,
  define: { "import.meta.url": JSON.stringify("file:///C:/prime-studio-owned/prime-daemon-adapter-v0.7.1.mjs") },
  legalComments: "external",
  banner: { js: "import { builtinModules as __psBuiltinModules, createRequire as __psCreateRequire } from 'node:module'; const __psNativeRequire = __psCreateRequire(process.execPath); const __psBuiltins = new Set(__psBuiltinModules.map((value) => value.replace(/^node:/, ''))); const require = (specifier) => { if (typeof specifier !== 'string' || !__psBuiltins.has(specifier.replace(/^node:/, ''))) throw new Error('reviewed adapter refused non-builtin dynamic import'); return __psNativeRequire(specifier); };" },
  plugins: [{
    name: "reviewed-prime-public-root",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, async (arguments_) => {
        if (!isAbsolute(arguments_.path) && !arguments_.path.startsWith(".")) return;
        const unresolved = isAbsolute(arguments_.path) ? arguments_.path : resolve(arguments_.resolveDir, arguments_.path);
        const candidates = [unresolved, `${unresolved}.js`, resolve(unresolved, "index.js")];
        const path = candidates.find((candidate) => {
          try { return statSync(candidate).isFile(); } catch { return false; }
        });
        if (!path) return;
        const pathWithinPackage = relative(packageRoot, path);
        if (pathWithinPackage !== "" && !pathWithinPackage.startsWith("..") && !isAbsolute(pathWithinPackage)) {
          return { path, sideEffects: false };
        }
      });
    },
  }],
});

if (digest(await readFile(outputPath)) !== "sha256:8097d080916562ffb8c1c80e2cc4a0640418fa5ec8e09456077d3cffb9c785e3") {
  throw new Error("generated adapter bytes do not match the reviewed bundle");
}

const legalPath = `${outputPath}.LEGAL.txt`;
const legalNotice = (await readFile(legalPath, "utf8")).replaceAll("Wärtling", "Warting");
await writeFile(legalPath, legalNotice, "utf8");
