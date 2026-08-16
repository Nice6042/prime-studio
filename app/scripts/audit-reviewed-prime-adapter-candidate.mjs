import { statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { build } from "esbuild";

const [rootArgument, expectedVersion, expectedManifestDigest, expectedPublicDigest, outputArgument, dependencyRootArgument] = process.argv.slice(2);
if (!rootArgument || !expectedVersion || !expectedManifestDigest || !expectedPublicDigest || !outputArgument || !dependencyRootArgument
  || !isAbsolute(rootArgument) || !isAbsolute(outputArgument) || !isAbsolute(dependencyRootArgument)
  || !/^\d+\.\d+\.\d+$/.test(expectedVersion)
  || !/^sha256:[a-f0-9]{64}$/.test(expectedManifestDigest)
  || !/^sha256:[a-f0-9]{64}$/.test(expectedPublicDigest)) {
  throw new Error("usage: node audit-reviewed-prime-adapter-candidate.mjs <absolute-package-root> <version> <manifest-digest> <public-digest> <absolute-output> <absolute-dependency-root>");
}

const packageRoot = await realpath(rootArgument);
const dependencyRoot = await realpath(dependencyRootArgument);
const dependencyModules = await realpath(resolve(dependencyRoot, "node_modules"));
if (relative(dependencyRoot, dependencyModules).startsWith("..")) throw new Error("dependency modules escaped the locked source root");
const manifestBytes = await readFile(resolve(packageRoot, "package.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
if (manifest.name !== "prime-agent" || manifest.version !== expectedVersion || digest(manifestBytes) !== expectedManifestDigest) {
  throw new Error("Prime package identity does not match the audited candidate");
}
const publicRoot = await realpath(resolve(packageRoot, "dist", "index.js"));
if (relative(packageRoot, publicRoot).startsWith("..") || digest(await readFile(publicRoot)) !== expectedPublicDigest) {
  throw new Error("Prime public entry point does not match the audited candidate");
}

await build({
  stdin: {
    contents: `export { AuthStorage, DAEMON_PROTOCOL_INFO, DaemonAgentConnection, DaemonClient, ModelRegistry, defaultDaemonSocketPath } from ${JSON.stringify(publicRoot)};`,
    loader: "js",
    resolveDir: packageRoot,
  },
  outfile: outputArgument,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  nodePaths: [dependencyModules],
  minify: true,
  define: { "import.meta.url": JSON.stringify("file:///C:/prime-studio-owned/prime-daemon-adapter-v0.7.1.mjs") },
  legalComments: "external",
  banner: { js: "import { builtinModules as __psBuiltinModules, createRequire as __psCreateRequire } from 'node:module'; const __psNativeRequire = __psCreateRequire(process.execPath); const __psBuiltins = new Set(__psBuiltinModules.map((value) => value.replace(/^node:/, ''))); const require = (specifier) => { if (typeof specifier !== 'string' || !__psBuiltins.has(specifier.replace(/^node:/, ''))) throw new Error('reviewed adapter refused non-builtin dynamic import'); return __psNativeRequire(specifier); };" },
  plugins: [{
    name: "reviewed-prime-public-root",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (arguments_) => {
        if (!isAbsolute(arguments_.path) && !arguments_.path.startsWith(".")) return;
        const unresolved = isAbsolute(arguments_.path) ? arguments_.path : resolve(arguments_.resolveDir, arguments_.path);
        const candidates = [unresolved, `${unresolved}.js`, resolve(unresolved, "index.js")];
        const path = candidates.find((candidate) => {
          try { return statSync(candidate).isFile(); } catch { return false; }
        });
        if (!path) return;
        const pathWithinPackage = relative(packageRoot, path);
        if (pathWithinPackage !== "" && !pathWithinPackage.startsWith("..") && !isAbsolute(pathWithinPackage)) return { path, sideEffects: false };
      });
    },
  }],
});

const outputBytes = await readFile(outputArgument);
let legal = null;
try {
  const legalBytes = await readFile(`${outputArgument}.LEGAL.txt`);
  legal = { bytes: legalBytes.byteLength, digest: digest(legalBytes) };
} catch { /* Candidate has no external legal comments. */ }
console.log(JSON.stringify({
  packageVersion: expectedVersion,
  manifestDigest: digest(manifestBytes),
  publicDigest: digest(await readFile(publicRoot)),
  adapter: { bytes: outputBytes.byteLength, digest: digest(outputBytes) },
  legal,
}, null, 2));
