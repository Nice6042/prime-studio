import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

if (mode !== "baseline" && mode !== "strict") {
  throw new Error("Usage: node e2e/run-browser-shell.mjs <baseline|strict>");
}

const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [playwrightCli, "test", "--config=playwright.config.mjs"], {
  env: { ...process.env, PRIME_STUDIO_AXE_MODE: mode },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
