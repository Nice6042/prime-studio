import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";
import { activateWithKeyboard, expectMinimumTarget, expectNoDocumentOverflow, expectWithinViewport } from "./support/acceptance-matrix";

test("compact workspace keeps the parent conversation and composer visible", async ({ shellPage }, testInfo) => {
  expect(shellPage.viewportSize()).toEqual({ width: 320, height: 200 });
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
  await expect(shellPage.getByPlaceholder("Message Prime Studio — try / for commands")).toBeVisible();
  const pinTarget = shellPage.locator('[data-control-id="chat-pin-toggle"]');
  await expect(pinTarget).toBeHidden();
  const compactMenu = shellPage.getByRole("button", { name: "Chat options" });
  const menuGeometry = await compactMenu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { width: rect.width, height: rect.height, display: style.display, padding: style.padding };
  });
  expect(menuGeometry, "the compact chat menu hit target remains at least 36 CSS pixels").toMatchObject({
    width: expect.any(Number),
    height: expect.any(Number),
  });
  expect(menuGeometry.width).toBeGreaterThanOrEqual(36);
  expect(menuGeometry.height).toBeGreaterThanOrEqual(36);
  await compactMenu.click();
  await expect(shellPage.getByRole("menuitem", { name: "Unpin chat" })).toBeVisible();
  await compactMenu.click();
  const geometry = await shellPage.getByRole("main", { name: "Prime Harness architecture" }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, scrollWidth: element.scrollWidth };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThanOrEqual(80);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  await shellPage.screenshot({ path: testInfo.outputPath("canonical-narrow.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-narrow-workspace");
});

test("projects, Harness, and editor become controlled sheets", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "Projects" }).click();
  await expect(shellPage.locator('[data-studio-sheet="sidebar"]')).toBeVisible();
  await shellPage.getByRole("button", { name: "Projects" }).click();
  await shellPage.getByRole("button", { name: "Harness" }).click();
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toBeVisible();
  await shellPage.getByRole("button", { name: "Harness" }).click();
  await shellPage.getByRole("button", { name: "Open editor" }).click();
  await expect(shellPage.getByRole("region", { name: "Editor" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-narrow-sheets");
});

test("narrow project sheet keeps lifecycle labels and tooltips readable", async ({ shellPage }, testInfo) => {
  await shellPage.setViewportSize({ width: 320, height: 600 });
  await shellPage.getByRole("button", { name: "Projects" }).click();
  const sheet = shellPage.locator('[data-studio-sheet="sidebar"]');
  const working = sheet.getByRole("button", { name: /Prime Harness architecture.*status: Working/i }).first();
  const idle = sheet.getByRole("button", { name: /Inactive planning notes.*status: Idle/i });
  await expect(working).toBeVisible();
  await expect(working).toHaveAttribute("data-session-status", "working");
  await expect(idle).toBeVisible();
  await expect(idle).toHaveAttribute("data-session-status", "idle");
  const geometry = await sheet.locator(".project-list").evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  await shellPage.screenshot({ path: testInfo.outputPath("chat-lifecycle-narrow.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-chat-lifecycle-narrow");
});

test("collapsed workspace footer keeps its menu in-view and restores keyboard focus", async ({ shellPage }, testInfo) => {
  const trigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
  await activateWithKeyboard(trigger);
  const menu = shellPage.getByRole("menu", { name: "Workspace actions" });
  await expectWithinViewport(menu, shellPage);
  await expectNoDocumentOverflow(shellPage);
  expect(await shellPage.getByRole("navigation", { name: "Projects and chats" }).evaluate((element) => element.scrollLeft)).toBe(0);
  await expect(menu.getByRole("menuitem", { name: "Switch workspace" })).toBeFocused();
  await shellPage.screenshot({ path: testInfo.outputPath("workspace-footer-narrow.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-narrow-workspace-footer");
  await shellPage.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await activateWithKeyboard(trigger);
  await shellPage.keyboard.press("Tab");
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.getByRole("button", { name: "Switch chat" })).toBeFocused();

  await trigger.click();
  await shellPage.keyboard.press("Shift+Tab");
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.locator('.collapsed-sidebar [data-control-id="rail-settings"]')).toBeFocused();
});

test("settings and palette use compact responsive surfaces", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+K");
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shellPage.keyboard.press("Escape");
  await shellPage.keyboard.press("Control+,");
  await expect(shellPage.getByRole("main", { name: "Settings" })).toBeVisible();
  await expect(shellPage.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
  await shellPage.getByRole("button", { name: /^Usage/ }).click();
  await expect(shellPage.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await shellPage.getByRole("note", { name: "Project breakdown unavailable" }).focus();
  await expect(shellPage.getByRole("note", { name: "Project breakdown unavailable" })).toBeFocused();
  const geometry = await shellPage.getByRole("main", { name: "Settings" }).evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
});

test("200 percent equivalent geometry keeps sheets and keyboard controls inside the physical screen", async ({ shellPage }) => {
  const scaling = await shellPage.evaluate(() => ({
    css: { width: window.innerWidth, height: window.innerHeight },
    physicalPixels: { width: window.innerWidth * window.devicePixelRatio, height: window.innerHeight * window.devicePixelRatio },
    devicePixelRatio: window.devicePixelRatio,
  }));
  expect(scaling).toEqual({
    css: { width: 320, height: 200 },
    physicalPixels: { width: 640, height: 400 },
    devicePixelRatio: 2,
  });

  const paletteTrigger = shellPage.getByRole("button", { name: "Open command palette" });
  await activateWithKeyboard(paletteTrigger);
  const palette = shellPage.getByRole("dialog", { name: "Command palette" });
  await expectWithinViewport(palette, shellPage);
  await shellPage.keyboard.press("Escape");
  await expect(paletteTrigger).toBeFocused();

  const harnessTrigger = shellPage.getByRole("button", { name: "Harness" });
  await activateWithKeyboard(harnessTrigger);
  await expectWithinViewport(shellPage.locator('[data-studio-sheet="inspector"]'), shellPage);
  await shellPage.keyboard.press("Escape");
  await expect(harnessTrigger).toBeFocused();
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-200-percent-equivalent");
});

test("200 percent equivalent titlebar controls retain a minimum accessible target", async ({ shellPage }) => {
  await expectMinimumTarget(shellPage.getByRole("button", { name: "Open command palette" }));
});
