import {
  expect,
  expectNoSeriousOrCriticalAxeViolations,
  test,
} from "./support/browser-shell";
import type { Page } from "@playwright/test";

async function expectHitTestable(shellPage: Page, selector: string) {
  const locator = shellPage.locator(selector);
  await expect(locator).toBeVisible();
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return target === element || element.contains(target);
  });
  expect(hit, `${selector} must own its visible centre point`).toBe(true);
}

test("640x400 at 200% keeps the first-run composer and sidebar usable", async ({ shellPage }) => {
  expect(shellPage.viewportSize()).toEqual({ width: 320, height: 200 });
  await expect(shellPage.getByPlaceholder("Message Prime, or / for commands")).toBeEditable();
  await expect(
    shellPage.getByRole("heading", { name: "Ready. Pick a folder and say what you want done." }),
  ).toBeVisible();
  await expectHitTestable(shellPage, ".sidebar");
  await expect(shellPage.locator(".sidebar")).toHaveCSS("overflow-y", /auto|scroll/);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "narrow-first-run");
});

test("640x400 at 200% preserves transcript, composer, and artifact geometry", async ({ shellPage }) => {
  const composer = shellPage.getByPlaceholder("Message Prime, or / for commands");
  await composer.fill("Inspect the compact workspace");
  await composer.press("Enter");
  await expect(shellPage.locator(".messages")).toBeVisible();

  await shellPage.keyboard.press("Control+K");
  const query = shellPage.getByPlaceholder("Search sessions, models, accounts, actions…");
  await query.fill("Toggle artifact pane");
  await query.press("Enter");

  const geometry = await shellPage.locator(".column").evaluate((column) => {
    const transcript = column.querySelector<HTMLElement>(".messages")?.getBoundingClientRect();
    const composerBox = column.querySelector<HTMLElement>(".composer")?.getBoundingClientRect();
    return {
      transcript: transcript && { width: transcript.width, height: transcript.height },
      composer: composerBox && { width: composerBox.width, height: composerBox.height },
    };
  });
  expect(geometry.transcript?.width).toBeGreaterThan(0);
  expect(geometry.transcript?.height).toBeGreaterThan(0);
  expect(geometry.composer?.width).toBeGreaterThan(0);
  expect(geometry.composer?.height).toBeGreaterThan(0);

  await expectHitTestable(shellPage, ".artifacts");
  await expect(shellPage.locator(".artifacts")).toHaveCSS("overflow-y", /auto|scroll/);
  await shellPage.getByTitle("Refresh").click();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "narrow-artifacts-transcript");
});
