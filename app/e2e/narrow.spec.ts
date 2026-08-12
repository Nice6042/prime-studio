import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

test("compact workspace keeps the parent conversation and composer visible", async ({ shellPage }, testInfo) => {
  expect(shellPage.viewportSize()).toEqual({ width: 320, height: 200 });
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
  await expect(shellPage.getByPlaceholder("Message Prime Studio — try / for commands")).toBeVisible();
  const geometry = await shellPage.getByRole("main", { name: "Prime Harness architecture" }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, scrollWidth: element.scrollWidth };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  await shellPage.screenshot({ path: testInfo.outputPath("canonical-narrow.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-narrow-workspace");
});

test("projects, Harness, and editor become controlled sheets", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "Projects" }).click();
  await expect(shellPage.getByRole("navigation", { name: "Projects and chats" })).toBeVisible();
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
});
