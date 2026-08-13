import { expect, type Locator, type Page } from "@playwright/test";

export type SettingsDestination = Readonly<{
  id: string;
  label: string;
  signature: (settings: Locator) => Locator;
}>;

export const settingsDestinations: readonly SettingsDestination[] = [
  { id: "general", label: "General", signature: (settings) => settings.getByLabel("Default file open destination") },
  { id: "appearance", label: "Appearance", signature: (settings) => settings.getByRole("radiogroup", { name: "Theme" }) },
  { id: "composer", label: "Composer", signature: (settings) => settings.getByLabel("Send shortcut") },
  { id: "harness", label: "Harness", signature: (settings) => settings.getByLabel("Maximum concurrent agents") },
  { id: "usage", label: "Usage", signature: (settings) => settings.getByRole("button", { name: "Export CSV" }) },
  { id: "models", label: "Models", signature: (settings) => settings.getByLabel("Default model") },
  { id: "accounts", label: "Accounts", signature: (settings) => settings.getByText("Browser shell", { exact: true }) },
  { id: "tools", label: "Tools", signature: (settings) => settings.getByRole("switch", { name: "Enable configurable tools" }) },
  { id: "git", label: "Git", signature: (settings) => settings.getByRole("switch", { name: "Automatic Git status refresh" }) },
  { id: "environments", label: "Environments", signature: (settings) => settings.getByLabel("Agent environment") },
  { id: "privacy", label: "Privacy & security", signature: (settings) => settings.getByRole("switch", { name: "Telemetry" }) },
  { id: "shortcuts", label: "Keyboard shortcuts", signature: (settings) => settings.getByText("Open command palette", { exact: true }) },
  { id: "about", label: "About", signature: (settings) => settings.getByText("0.1.0", { exact: true }) },
] as const;

export async function activateWithKeyboard(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  await locator.press("Enter");
}

export async function expectNoDocumentOverflow(page: Page, slack = 1): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName.toLocaleLowerCase(), className: element.className, controlId: element.dataset.controlId, left: rect.left, right: rect.right };
    }).filter((candidate) => candidate.left < -1 || candidate.right > window.innerWidth + 1).slice(0, 12),
  }));
  expect(geometry.documentWidth, `the application must not create page-level horizontal overflow; offenders=${JSON.stringify(geometry.offenders)}`).toBeLessThanOrEqual(geometry.viewportWidth + slack);
  expect(geometry.documentHeight, "the application shell must remain bounded to the viewport").toBeLessThanOrEqual(geometry.viewportHeight + slack);
}

export async function expectMinimumTarget(locator: Locator, minimum = 24): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "interactive target has measurable geometry").not.toBeNull();
  expect(box!.width, "interactive target width").toBeGreaterThanOrEqual(minimum);
  expect(box!.height, "interactive target height").toBeGreaterThanOrEqual(minimum);
}

export async function expectWithinViewport(locator: Locator, page: Page, slack = 1.25): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map(async (animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      if (iterations === Infinity) return;
      try { await animation.finished; } catch { /* A cancelled entrance animation is already settled. */ }
    }));
  });
  const [box, viewport] = await Promise.all([locator.boundingBox(), page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))]);
  expect(box, "visible region has measurable geometry").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-slack);
  expect(box!.y).toBeGreaterThanOrEqual(-slack);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + slack);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + slack);
}
