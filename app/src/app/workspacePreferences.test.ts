import { describe, expect, it, vi } from "vitest";

import { installWorkspacePreferences } from "./workspacePreferences";

function media(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
    dispatch: () => listeners.forEach((listener) => listener()),
  };
}

describe("workspace preferences", () => {
  it("applies theme, density, and reduced-motion truth and follows system changes", () => {
    const color = media(false);
    const motion = media(false);
    const matchMedia = vi.fn((query: string) => query.includes("color-scheme") ? color : motion);

    const cleanup = installWorkspacePreferences(
      { theme: "system", density: "compact", reducedMotion: "disabled", accent: "ember", fontSize: "large", bubbles: "enabled" },
      document.documentElement,
      matchMedia,
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-density", "compact");
    expect(document.documentElement).toHaveAttribute("data-reduced-motion", "false");
    expect(document.documentElement).toHaveAttribute("data-accent", "ember");
    expect(document.documentElement).toHaveAttribute("data-font-size", "large");
    expect(document.documentElement).toHaveAttribute("data-bubbles", "compact");

    color.matches = true;
    motion.matches = true;
    color.dispatch();
    motion.dispatch();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute("data-reduced-motion", "true");

    cleanup();
  });

  it("normalizes unknown appearance values to safe defaults", () => {
    const mediaQuery = media(false);
    const cleanup = installWorkspacePreferences(
      { accent: "unknown", fontSize: "huge", bubbles: "unknown" },
      document.documentElement,
      () => mediaQuery,
    );

    expect(document.documentElement).toHaveAttribute("data-accent", "prime-violet");
    expect(document.documentElement).toHaveAttribute("data-font-size", "medium");
    expect(document.documentElement).toHaveAttribute("data-bubbles", "comfortable");

    cleanup();
  });
});
