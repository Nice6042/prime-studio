import type { ComponentType } from "react";

type MarkdownProps = { children: string };
type MarkdownModule = { Markdown: ComponentType<MarkdownProps> };
type LazyMarkdownModule = { default: ComponentType<MarkdownProps> };

export function createMarkdownLoader(load: () => Promise<MarkdownModule>) {
  let pending: Promise<LazyMarkdownModule> | undefined;

  const loadMarkdown = () => {
    pending ??= load().then(({ Markdown }) => ({ default: Markdown }));
    return pending;
  };

  return {
    loadMarkdown,
    preloadMarkdown: () => {
      void loadMarkdown();
    },
  };
}

const markdown = createMarkdownLoader(() =>
  import("./Markdown").then(({ Markdown }) => ({
    Markdown: Markdown as ComponentType<MarkdownProps>,
  })),
);

export const { loadMarkdown, preloadMarkdown } = markdown;
