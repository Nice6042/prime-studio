import { afterEach, describe, expect, it } from "vitest";

import "./styles.css";

const SECONDARY_TEXT_TOKENS = ["--fg-dim", "--muted-2", "--dim", "--dimmer"] as const;
const TEXT_SURFACE_TOKENS = [
  "--bg",
  "--bg-2",
  "--bg-3",
  "--surface",
  "--inset",
  "--user",
] as const;

type Color = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

function parseColor(value: string): Color {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (hex) {
    const [, red, green, blue] = hex;
    return {
      red: Number.parseInt(red, 16),
      green: Number.parseInt(green, 16),
      blue: Number.parseInt(blue, 16),
      alpha: 1,
    };
  }

  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
    value,
  );
  if (rgb) {
    const [, red, green, blue, alpha = "1"] = rgb;
    return {
      red: Number(red),
      green: Number(green),
      blue: Number(blue),
      alpha: Number(alpha),
    };
  }

  throw new Error(`Expected a hex, rgb, or rgba color, received ${value}`);
}

function composite(foreground: Color, background: Color): Color {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  const channel = (front: number, back: number) =>
    (front * foreground.alpha + back * background.alpha * (1 - foreground.alpha)) / alpha;
  return {
    red: channel(foreground.red, background.red),
    green: channel(foreground.green, background.green),
    blue: channel(foreground.blue, background.blue),
    alpha,
  };
}

function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Color): number {
  return (
    0.2126 * channelToLinear(color.red) +
    0.7152 * channelToLinear(color.green) +
    0.0722 * channelToLinear(color.blue)
  );
}

function contrastRatio(first: Color, second: Color): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenValue(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function tokenColor(token: string): Color {
  return parseColor(tokenValue(token));
}

function resolvedColor(value: string): Color {
  const customProperty = /^var\((--[\w-]+)\)$/.exec(value);
  return customProperty ? tokenColor(customProperty[1]) : parseColor(value);
}

function reachableTextBackgrounds(): Array<[string, Color]> {
  const background = tokenColor("--bg");
  const sidebar = tokenColor("--bg-2");
  const wash = tokenColor("--wash");
  const accent = tokenColor("--accent");
  return [
    ...TEXT_SURFACE_TOKENS.map((token) => [token, tokenColor(token)] as [string, Color]),
    ["--wash over --bg", composite(wash, background)],
    ["--wash over --bg-2", composite(wash, sidebar)],
    [
      "12% --accent over --bg-2",
      composite({ ...accent, alpha: 0.12 }, sidebar),
    ],
  ];
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.body.replaceChildren();
});

describe.each(["dark", "light"] as const)("%s theme secondary text contrast", (theme) => {
  it.each(SECONDARY_TEXT_TOKENS)("keeps %s at WCAG AA contrast in every reachable state", (token) => {
    document.documentElement.dataset.theme = theme;
    const foreground = tokenColor(token);

    for (const [backgroundName, background] of reachableTextBackgrounds()) {
      expect(
        contrastRatio(foreground, background),
        `${theme} ${token} ${tokenValue(token)} on ${backgroundName}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the four secondary text tiers visually ordered", () => {
    document.documentElement.dataset.theme = theme;
    const background = tokenColor("--bg-2");
    const ratios = SECONDARY_TEXT_TOKENS.map((token) => contrastRatio(tokenColor(token), background));

    for (let index = 0; index < ratios.length - 1; index += 1) {
      expect(ratios[index], `${SECONDARY_TEXT_TOKENS[index]} should remain stronger`).toBeGreaterThan(
        ratios[index + 1],
      );
    }
  });

  it.each([
    ["--err-label", ["--bg"]],
    ["--err-text", ["--bg", "--inset"]],
    ["--err-dim", ["--bg", "--inset"]],
  ] as const)("keeps %s at WCAG AA contrast on its error surfaces", (token, surfaceTokens) => {
    document.documentElement.dataset.theme = theme;

    for (const surfaceToken of surfaceTokens) {
      expect(
        contrastRatio(tokenColor(token), tokenColor(surfaceToken)),
        `${theme} ${token} ${tokenValue(token)} on ${surfaceToken}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the active segmented-button foreground at WCAG AA contrast", () => {
    document.documentElement.dataset.theme = theme;
    const button = document.createElement("button");
    button.className = "seg-btn on";
    document.body.append(button);

    expect(
      contrastRatio(resolvedColor(getComputedStyle(button).color), tokenColor("--accent")),
      `${theme} .seg-btn.on foreground on --accent`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
