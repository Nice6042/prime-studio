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

test("320px at 2x keeps the complete rail unique, described, and sheet-safe", async ({ shellPage }, testInfo) => {
  const rail = shellPage.getByRole("toolbar", { name: "Collapsed navigation" });
  const controls = rail.getByRole("button");
  await expect(controls).toHaveCount(5);
  const expectedDescriptions = {
    "rail-expand": "Expand sidebar (Ctrl+B)",
    "rail-new-chat": /^New chat (?:\(Ctrl\+N\)|unavailable:)/,
    "rail-search": "Search (Ctrl+K)",
    "rail-settings": "Settings (Ctrl+,)",
    "rail-workspace-menu": "Prime Studio: D:\\fixture\\Prime Studio",
  } as const;
  for (const [controlId, description] of Object.entries(expectedDescriptions)) {
    const control = shellPage.locator(`[data-control-id="${controlId}"]`);
    await expect(control).toHaveCount(1);
    await expect(control).toBeVisible();
    await expect(control).toHaveAccessibleDescription(description);
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(40);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(176);
  }
  await shellPage.locator('[data-control-id="rail-expand"]').focus();
  await shellPage.keyboard.press("End");
  await expect(shellPage.locator('[data-control-id="rail-workspace-menu"]')).toBeFocused();
  await shellPage.keyboard.press("Home");
  await shellPage.keyboard.press("Enter");
  const sheet = shellPage.locator('[data-studio-sheet="sidebar"]');
  await expect(sheet.locator('[data-control-id="sidebar-collapse"]')).toBeFocused();
  await expect(shellPage.locator('.studio-sidebar[data-mode="rail"]')).toHaveAttribute("inert", "");
  await expect(shellPage.locator('[data-control-id="rail-expand"]')).not.toBeFocused();
  await shellPage.keyboard.press("Escape");
  await expect(shellPage.locator('[data-control-id="rail-expand"]')).toBeFocused();
  await shellPage.screenshot({ path: testInfo.outputPath("collapsed-rail-320-2x.png"), fullPage: true });
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "collapsed-rail-320-2x");
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

test("200 percent project sheet preserves keyboard expansion and grouping", async ({ shellPage }, testInfo) => {
  await shellPage.setViewportSize({ width: 320, height: 600 });
  await shellPage.getByRole("button", { name: "Projects" }).click();
  const sheet = shellPage.locator('[data-studio-sheet="sidebar"]');
  const disclosure = sheet.getByRole("button", { name: "Personal project" });
  const groupId = await disclosure.getAttribute("aria-controls");
  expect(groupId).toBeTruthy();
  const group = sheet.locator(`[id="${groupId}"]`);
  await disclosure.focus();
  await shellPage.keyboard.press("ArrowLeft");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(group).toBeHidden();
  await shellPage.keyboard.press("ArrowRight");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(group).toBeVisible();
  await expect(disclosure).toBeFocused();
  await shellPage.screenshot({ path: testInfo.outputPath("project-tree-narrow.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "project-tree-narrow");

  await shellPage.setViewportSize({ width: 320, height: 200 });
  await disclosure.scrollIntoViewIfNeeded();
  await expect(disclosure).toBeFocused();
  await shellPage.screenshot({ path: testInfo.outputPath("project-tree-320-2x.png"), fullPage: true });
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "project-tree-320-2x");
});

test("child composer stays locked, focusable, and in-view at 320 by 200", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "Harness" }).click();
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("textbox", { name: "Extension instructions" }).press("Escape");
  await shellPage.getByRole("button", { name: "Harness" }).click();
  await harness.getByRole("textbox", { name: "Extension note" }).press("Escape");
  await shellPage.getByRole("button", { name: "Harness" }).click();
  await harness.getByRole("button", { name: "Verify runtime compatibility, running" }).click();

  const childComposer = harness.getByRole("textbox", { name: "Child message" });
  await expect(childComposer).toBeVisible();
  await expect(childComposer).toHaveAttribute("readonly", "");
  await expect(childComposer).toHaveValue("Child tasks are managed by the harness");
  await childComposer.focus();
  await expect(childComposer).toBeFocused();
  await childComposer.press("Enter");
  await expect(childComposer).toHaveValue("Child tasks are managed by the harness");
  await expect(harness.getByRole("textbox", { name: "Message Prime Studio" })).toHaveCount(0);
  await expectWithinViewport(childComposer, shellPage);
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-child-composer-narrow");
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
  await expect(shellPage.locator('[data-control-id="rail-settings"]')).toBeFocused();
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

test("composer remains bounded and internally scrollable in the 200 percent reflow project", async ({ shellPage }) => {
  const textbox = shellPage.getByRole("textbox", { name: "Message Prime Studio" });
  await textbox.fill("one line");
  const initialHeight = await textbox.evaluate((element) => element.getBoundingClientRect().height);

  await textbox.fill(Array.from({ length: 30 }, (_, index) => `zoom line ${index + 1}`).join("\n"));
  const geometry = await textbox.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    return {
      height: textarea.getBoundingClientRect().height,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      fieldSizing: style.getPropertyValue("field-sizing"),
      maxBlockSize: style.maxBlockSize,
      overflowY: style.overflowY,
    };
  });

  expect(geometry.fieldSizing).toBe("content");
  expect(geometry.maxBlockSize).toBe("140px");
  expect(geometry.height).toBeCloseTo(140, 0);
  expect(geometry.height).toBeGreaterThan(initialHeight);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.overflowY).toBe("auto");
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-composer-growth-200-percent");
});
