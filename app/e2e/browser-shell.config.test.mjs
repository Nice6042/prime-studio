import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import config from "../playwright.config.mjs";
import { isLoopbackRequestUrl } from "./support/network.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const axeBaseline = JSON.parse(
  await readFile(new URL("./axe-baseline.json", import.meta.url), "utf8"),
);

test("browser-shell runner keeps deterministic evidence and a loopback-only preview", () => {
  const expectedPort = process.env.PRIME_STUDIO_BROWSER_PORT ?? "4173";
  assert.equal(packageJson.devDependencies["@playwright/test"].startsWith("^"), false);
  assert.equal(packageJson.devDependencies["@axe-core/playwright"].startsWith("^"), false);
  assert.equal(packageJson.scripts["test:browser-shell"], "npm run test:browser-shell:strict");
  assert.equal(
    packageJson.scripts["test:browser-shell:strict"],
    "npm run test:browser-shell:config && node e2e/run-browser-shell.mjs strict",
  );
  assert.equal(
    packageJson.scripts["test:browser-shell:baseline"],
    "npm run test:browser-shell:config && node e2e/run-browser-shell.mjs baseline",
  );
  assert.equal(config.retries, 0);
  assert.equal(config.use.serviceWorkers, "block");
  assert.equal(config.use.screenshot, "only-on-failure");
  assert.equal(config.use.trace, "retain-on-failure");
  assert.equal(config.use.baseURL, `http://127.0.0.1:${expectedPort}`);
  assert.match(
    config.webServer.command,
    new RegExp(
      `^npm run build && npm run preview -- --host 127\\.0\\.0\\.1 --port ${expectedPort} --strictPort$`,
    ),
  );
  assert.deepEqual(
    config.projects.map((project) => project.name),
    ["browser-shell-chromium", "browser-shell-chromium-narrow"],
  );
  assert.equal(isLoopbackRequestUrl("http://127.0.0.1:4173/assets/app.js"), true);
  assert.equal(isLoopbackRequestUrl("http://localhost:4173/assets/app.js"), true);
  assert.equal(isLoopbackRequestUrl("https://[::1]/assets/app.js"), true);
  assert.equal(isLoopbackRequestUrl("https://example.com/telemetry"), false);
  assert.equal(isLoopbackRequestUrl("data:text/plain,blocked"), false);
  assert.deepEqual(Object.keys(axeBaseline).sort(), [
    "active-transcript-tool-error",
    "command-palette",
    "first-run",
    "narrow-first-run",
    "session-tabs",
    "settings-appearance",
  ]);
  assert.equal(
    Object.values(axeBaseline).every((violations) => violations.length === 0),
    true,
    "the checked-in baseline must reflect the zero serious/critical release gate",
  );
});

test("browser-shell preview accepts an isolated loopback port", () => {
  const script = [
    'import config from "./playwright.config.mjs";',
    'process.stdout.write(JSON.stringify({ baseURL: config.use.baseURL, command: config.webServer.command }));',
  ].join("");
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PRIME_STUDIO_BROWSER_PORT: "43173" },
    encoding: "utf8",
  });

  assert.deepEqual(JSON.parse(output), {
    baseURL: "http://127.0.0.1:43173",
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 43173 --strictPort",
  });
});

test("browser-shell preview rejects unsafe port input before building a command", () => {
  const script = 'await import("./playwright.config.mjs");';

  assert.throws(
    () =>
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PRIME_STUDIO_BROWSER_PORT: "4173;whoami" },
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.match(String(error.stderr), /PRIME_STUDIO_BROWSER_PORT must be an integer from 1024 to 65535/);
      return true;
    },
  );
});
