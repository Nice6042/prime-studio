import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    clearMocks: true,
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
