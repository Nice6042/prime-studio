import type { Page } from "@playwright/test";

import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

const settingLabels = [
  "General",
  "Appearance",
  "Composer",
  "Harness",
  "Usage",
  "Models",
  "Accounts",
  "Tools",
  "Git",
  "Environments",
  "Privacy & security",
  "Keyboard shortcuts",
  "About",
] as const;

function requestCount(shellPage: Page, command: string) {
  return shellPage.evaluate((name: string) => {
    const requests = (window as typeof window & { __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string }> }).__PRIME_STUDIO_BROWSER_REQUESTS__ ?? [];
    return requests.filter((request) => request.command === name).length;
  }, command);
}

test("topmost menus and modals own Ctrl+N K comma B J until they close", async ({ shellPage }) => {
  const beforeLayout = await requestCount(shellPage, "set_layout_preferences");
  const beforeCatalog = await requestCount(shellPage, "project_catalog_apply");

  await shellPage.getByRole("button", { name: "File" }).click();
  const fileMenu = shellPage.getByRole("menu", { name: "File menu" });
  await expect(fileMenu).toBeVisible();
  for (const shortcut of ["Control+N", "Control+K", "Control+,", "Control+B", "Control+J"]) {
    await shellPage.keyboard.press(shortcut);
    await expect(fileMenu).toBeVisible();
  }
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(shellPage.getByRole("main", { name: "Settings" })).toHaveCount(0);
  await expect.poll(() => requestCount(shellPage, "set_layout_preferences")).toBe(beforeLayout);
  await expect.poll(() => requestCount(shellPage, "project_catalog_apply")).toBe(beforeCatalog);

  await shellPage.keyboard.press("Escape");
  await expect(fileMenu).toHaveCount(0);
  await expect(shellPage.getByRole("button", { name: "File" })).toBeFocused();

  await shellPage.keyboard.press("Control+K");
  const palette = shellPage.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  for (const shortcut of ["Control+N", "Control+K", "Control+,", "Control+B", "Control+J"]) {
    await shellPage.keyboard.press(shortcut);
    await expect(palette).toBeVisible();
  }
  await expect(shellPage.getByRole("main", { name: "Settings" })).toHaveCount(0);
  await expect.poll(() => requestCount(shellPage, "set_layout_preferences")).toBe(beforeLayout);
  await expect.poll(() => requestCount(shellPage, "project_catalog_apply")).toBe(beforeCatalog);
  await shellPage.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-topmost-shortcut-priority");
});

test("popover pointer and focus transfer close exactly one surface without stale restoration", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "File" }).click();
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toBeVisible();
  const editorButton = shellPage.getByRole("button", { name: "Open editor" });
  await editorButton.focus();
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toHaveCount(0);
  await expect(editorButton).toBeFocused();

  const workspaceMenuTrigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
  await workspaceMenuTrigger.click();
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toBeVisible();
  await shellPage.getByRole("button", { name: "Open command palette" }).click();
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shellPage.keyboard.press("Escape");

  const chatOptions = shellPage.getByRole("button", { name: "Chat options" });
  await chatOptions.click();
  await shellPage.getByRole("menuitem", { name: "Rename" }).click();
  const rename = shellPage.getByRole("dialog", { name: "Rename chat" });
  await expect(rename).toBeVisible();
  await expect(shellPage.getByRole("textbox", { name: "Chat name" })).toBeFocused();
  await expect(shellPage.getByRole("menu", { name: "Chat options" })).toHaveCount(0);
  await shellPage.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(chatOptions).toBeFocused();

  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-shared-popover-ownership");
});

test("every registered Settings destination and primary workspace escape route reflows across the complete geometry matrix", async ({ shellPage }) => {
  const geometries = [
    { width: 640, height: 400 },
    { width: 820, height: 640 },
    { width: 1280, height: 800 },
    { width: 1600, height: 900 },
  ] as const;

  for (const geometry of geometries) {
    await shellPage.setViewportSize(geometry);
    await shellPage.keyboard.press("Control+,");
    const settings = shellPage.getByRole("main", { name: "Settings" });
    await expect(settings).toBeVisible();

    for (const label of settingLabels) {
      await shellPage.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      await expect(shellPage.getByRole("heading", { name: label, level: 1 })).toBeVisible();
      const pageGeometry = await settings.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(pageGeometry.scrollWidth).toBeLessThanOrEqual(pageGeometry.width + 1);
      expect(pageGeometry.right).toBeLessThanOrEqual(geometry.width + 1);
    }

    await shellPage.getByRole("button", { name: "Back to chat" }).click();
    await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
    await expect(shellPage.getByRole("textbox", { name: "Message Prime Studio" })).toBeVisible();
    const documentGeometry = await shellPage.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(documentGeometry.scrollWidth).toBeLessThanOrEqual(documentGeometry.width + 1);
  }

  await shellPage.setViewportSize({ width: 320, height: 200 });
  await expect(shellPage.getByRole("textbox", { name: "Message Prime Studio" })).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Projects" })).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Harness" })).toBeVisible();
  await shellPage.keyboard.press("Control+,");
  await expect(shellPage.getByRole("main", { name: "Settings" })).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Back to chat" })).toBeVisible();
  const zoomGeometry = await shellPage.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(zoomGeometry.scrollWidth).toBeLessThanOrEqual(zoomGeometry.width + 1);

  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-complete-reflow-matrix");
});
