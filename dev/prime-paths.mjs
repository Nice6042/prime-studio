// Locates the installed prime-agent, the same layering the app's Rust side uses:
// PRIME_STUDIO_CLI / PRIME_AGENT_CLI, then the per-OS default global-npm root.
//
// Override when prime lives elsewhere:
//   PRIME_STUDIO_CLI=/path/to/prime-agent/dist node probe-rpc.mjs
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const NPM_PKG = join("node_modules", "prime-agent", "dist");

function defaultDist() {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", NPM_PKG);
  }
  return ["/usr/local/lib", "/opt/homebrew/lib", join(homedir(), ".npm-global", "lib")]
    .map((p) => join(p, NPM_PKG))
    .find((p) => existsSync(join(p, "bundle", "cli.js")));
}

/** dist dir, whether given as the dist itself or as bundle/cli.js. */
function distFrom(override) {
  if (!override) return defaultDist();
  return override.endsWith("cli.js") ? join(override, "..", "..") : override;
}

const dist = distFrom(process.env.PRIME_STUDIO_CLI ?? process.env.PRIME_AGENT_CLI);
if (!dist) throw new Error("prime-agent not found — set PRIME_STUDIO_CLI to its dist directory");

export const CLI = join(dist, "bundle", "cli.js");

/** The Windows console-hide shim, when this install has it. Optional. */
const SHIM = join(dist, "windowshide-shim.cjs");

/** node argv prefix: `[--require <shim>,] <cli.js>`. */
export const primeArgs = () => (existsSync(SHIM) ? ["--require", SHIM, CLI] : [CLI]);
