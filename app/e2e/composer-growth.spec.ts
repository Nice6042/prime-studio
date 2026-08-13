import { expectNoDocumentOverflow } from "./support/acceptance-matrix";
import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

const PACKAGE_MAX_HEIGHT = 140;

async function readGeometry(textbox: import("@playwright/test").Locator) {
  return textbox.evaluate((element) => {
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
}

test("composer grows naturally, caps at the package bound, and scrolls internally across desktop widths", async ({ shellPage }) => {
  const textbox = shellPage.getByRole("textbox", { name: "Message Prime Studio" });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 400 }]) {
    await shellPage.setViewportSize(viewport);
    await textbox.fill("one line");
    const oneLine = await readGeometry(textbox);

    await textbox.fill("one\ntwo\nthree\nfour");
    const multiline = await readGeometry(textbox);
    expect(multiline.fieldSizing).toBe("content");
    expect(multiline.maxBlockSize).toBe(`${PACKAGE_MAX_HEIGHT}px`);
    expect(multiline.height).toBeGreaterThan(oneLine.height);
    expect(multiline.height).toBeLessThan(PACKAGE_MAX_HEIGHT);

    await textbox.fill(Array.from({ length: 30 }, (_, index) => `bounded line ${index + 1}`).join("\n"));
    const bounded = await readGeometry(textbox);
    expect(bounded.height).toBeCloseTo(PACKAGE_MAX_HEIGHT, 0);
    expect(bounded.scrollHeight).toBeGreaterThan(bounded.clientHeight);
    expect(bounded.overflowY).toBe("auto");

    await textbox.fill("short again");
    const shrunk = await readGeometry(textbox);
    expect(shrunk.height).toBeCloseTo(oneLine.height, 0);
    await expectNoDocumentOverflow(shellPage);
  }

  await textbox.fill("first line");
  await textbox.press("Shift+Enter");
  await textbox.type("second line");
  await expect(textbox).toHaveValue("first line\nsecond line");

  const operationsBeforeImeEnter = await shellPage.evaluate(() =>
    (window as typeof window & { __PRIME_STUDIO_BROWSER_INVOKES__?: string[] })
      .__PRIME_STUDIO_BROWSER_INVOKES__?.filter((command) => command === "harness_studio_operation").length ?? 0,
  );
  await textbox.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await expect(textbox).toHaveValue("first line\nsecond line");
  const operationsAfterImeEnter = await shellPage.evaluate(() =>
    (window as typeof window & { __PRIME_STUDIO_BROWSER_INVOKES__?: string[] })
      .__PRIME_STUDIO_BROWSER_INVOKES__?.filter((command) => command === "harness_studio_operation").length ?? 0,
  );
  expect(operationsAfterImeEnter).toBe(operationsBeforeImeEnter);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-composer-growth");
});
