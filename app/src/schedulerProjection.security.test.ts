import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function reactSourcesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return reactSourcesUnder(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("scheduler UI authority boundary", () => {
  it("keeps every React surface independent of the TypeScript scheduler authority", () => {
    for (const path of reactSourcesUnder(sourceRoot)) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*scheduler["']/i);
    }
  });
});
