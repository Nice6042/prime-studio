import { describe, expect, it } from "vitest";
import { createMarkdownLoader } from "./markdownLoader";

describe("Markdown loader", () => {
  it("caches a preload without invoking the Markdown renderer", async () => {
    let imports = 0;
    let renders = 0;
    let resolveModule: ((module: { Markdown: () => null }) => void) | undefined;
    const Markdown = () => {
      renders += 1;
      return null;
    };
    const loader = createMarkdownLoader(
      () =>
        new Promise<{ Markdown: () => null }>((resolve) => {
          imports += 1;
          resolveModule = resolve;
        }),
    );

    loader.preloadMarkdown();
    loader.preloadMarkdown();
    expect(imports).toBe(1);
    expect(renders).toBe(0);

    resolveModule?.({ Markdown });
    const module = await loader.loadMarkdown();
    expect(module.default).toBe(Markdown);
    expect(renders).toBe(0);
  });
});
