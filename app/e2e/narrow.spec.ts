import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

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
