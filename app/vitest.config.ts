import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    clearMocks: true,
    // The sidecar owns a separate compiled Node test command. Letting Vitest
    // discover its node:test sources (and generated dist copies) runs them in
    // jsdom with the wrong fixture root and reports false "no suite" failures.
    exclude: [...configDefaults.exclude, "e2e/**", "harness-sidecar/**"],
  },
});
