import { defineConfig } from "@playwright/test";

const portText = process.env.PRIME_STUDIO_BROWSER_PORT ?? "4173";
if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) {
  throw new Error("PRIME_STUDIO_BROWSER_PORT must be an integer from 1024 to 65535");
}
const port = Number(portText);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: "test-results/browser-shell",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "browser-shell-chromium",
      testIgnore: "**/narrow.spec.ts",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "browser-shell-chromium-narrow",
      testMatch: "**/narrow.spec.ts",
      use: {
        viewport: { width: 320, height: 200 },
        screen: { width: 640, height: 400 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command:
      `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
