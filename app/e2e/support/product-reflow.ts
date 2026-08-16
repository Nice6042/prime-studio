import { expect, type Locator, type Page } from "@playwright/test";

import type { ProductReflowGeometry } from "../../src/contracts/productReflowAcceptance";
import { expectNoDocumentOverflow } from "./acceptance-matrix";

const TOP_LEVEL_SURFACE_SELECTOR = [
  ".studio-titlebar",
  ".studio-statusbar",
  "main",
  "nav[aria-label='Projects and chats']",
  "aside[aria-label='Harness']",
  "[data-studio-sheet]",
  "[data-studio-overlay]",
  ".toasts",
].join(",");

export async function resetProductAtGeometry(page: Page, geometry: ProductReflowGeometry): Promise<void> {
  await page.setViewportSize({ width: geometry.width, height: geometry.height });
  await page.reload();
  await expect(page.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
  await expectProductViewport(page, `initial ${geometry.id}`);
}

export async function expectProductViewport(page: Page, label: string): Promise<void> {
  await expectNoDocumentOverflow(page);
  const surfaces = page.locator(TOP_LEVEL_SURFACE_SELECTOR);
  await surfaces.evaluateAll(async (elements) => {
    await Promise.all(elements.flatMap((element) => element.getAnimations({ subtree: true })).map(async (animation) => {
      if (animation.effect?.getTiming().iterations === Infinity) return;
      try { await animation.finished; } catch { /* A cancelled transition is already settled. */ }
    }));
  });
  const result = await page.evaluate((selector) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden
        && element.getAttribute("aria-hidden") !== "true"
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const offenders = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLocaleLowerCase(),
          role: element.getAttribute("role"),
          label: element.getAttribute("aria-label"),
          controlId: element.dataset.controlId,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      })
      .filter((surface) => surface.left < -1.25
        || surface.top < -1.25
        || surface.right > viewport.width + 1.25
        || surface.bottom > viewport.height + 1.25);
    return { viewport, offenders };
  }, TOP_LEVEL_SURFACE_SELECTOR);
  expect(result.offenders, `${label} contains a visible top-level surface outside ${result.viewport.width}x${result.viewport.height}`).toEqual([]);
}

export async function expectSurfaceContained(locator: Locator, page: Page, label: string): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const [box, viewport] = await Promise.all([
    locator.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  expect(box, `${label} has measurable geometry`).not.toBeNull();
  expect(box!.x, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(-1.25);
  expect(box!.y, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(-1.25);
  expect(box!.x + box!.width, `${label} ends inside the viewport`).toBeLessThanOrEqual(viewport.width + 1.25);
  expect(box!.y + box!.height, `${label} ends inside the viewport`).toBeLessThanOrEqual(viewport.height + 1.25);
}

export async function expectHorizontalContainment(locator: Locator, label: string): Promise<void> {
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth, `${label} must not require horizontal scrolling`).toBeLessThanOrEqual(geometry.clientWidth + 1);
}
