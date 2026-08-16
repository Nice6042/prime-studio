import type { AppSettings } from "../types";

type MediaQueryLike = Readonly<{
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}>;

type MatchMediaLike = (query: string) => MediaQueryLike;

const fallbackMediaQuery: MediaQueryLike = {
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const systemMatchMedia: MatchMediaLike = (query) => typeof window.matchMedia === "function"
  ? window.matchMedia(query)
  : fallbackMediaQuery;

/** Apply persisted workspace preferences to the semantic document tokens. */
export function installWorkspacePreferences(
  settings: AppSettings,
  root: HTMLElement = document.documentElement,
  matchMedia: MatchMediaLike = systemMatchMedia,
): () => void {
  const colorScheme = matchMedia("(prefers-color-scheme: light)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const apply = () => {
    const theme = settings.theme === "light" || settings.theme === "dark" ? settings.theme : (colorScheme.matches ? "light" : "dark");
    root.dataset.theme = theme;
    root.dataset.density = settings.density === "compact" ? "compact" : "comfortable";
    root.dataset.reducedMotion = settings.reducedMotion === "enabled" || reducedMotion.matches ? "true" : "false";
    root.dataset.accent = settings.accent === "slate" || settings.accent === "ember" ? settings.accent : "prime-violet";
    root.dataset.fontSize = settings.fontSize === "small" || settings.fontSize === "large" ? settings.fontSize : "medium";
    root.dataset.bubbles = settings.bubbles === "enabled" ? "compact" : "comfortable";
  };

  apply();
  colorScheme.addEventListener("change", apply);
  reducedMotion.addEventListener("change", apply);
  return () => {
    colorScheme.removeEventListener("change", apply);
    reducedMotion.removeEventListener("change", apply);
  };
}
