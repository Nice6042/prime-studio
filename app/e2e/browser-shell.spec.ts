import {
  expect,
  expectNoSeriousOrCriticalAxeViolations,
  test,
} from "./support/browser-shell";

test("first-run browser shell presents a workspace prompt and a usable composer", async ({ shellPage }) => {
  await expect(
    shellPage.getByRole("heading", { name: "Ready. Pick a folder and say what you want done." }),
  ).toBeVisible();
  await expect(shellPage.getByPlaceholder("Message Prime, or / for commands")).toBeEditable();
  await expect(shellPage.getByRole("button", { name: "SEND" })).toBeDisabled();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "first-run");
});

test("session tab strip remains axe-clean with multiple open tabs", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+N");

  const tablist = shellPage.getByRole("tablist", { name: "Open sessions" });
  await expect(tablist.getByRole("tab")).toHaveCount(2);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "session-tabs");
});

test("active transcript browser shell keeps a failed tool cell expanded", async ({ shellPage }) => {
  const composer = shellPage.getByPlaceholder("Message Prime, or / for commands");
  await composer.fill("Investigate the failing cell");
  await composer.press("Enter");

  await expect(shellPage.getByRole("main").getByText("Investigate the failing cell")).toBeVisible();
  const failedCell = shellPage.locator(".cell-error");
  await expect(failedCell).toBeVisible();
  await expect(failedCell.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(failedCell.locator(".cell-out")).toContainText("python: command not found");
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "active-transcript-tool-error");
});

test("settings browser shell opens the appearance controls without losing the session", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+,");

  await expect(shellPage.getByText("Settings", { exact: true })).toBeVisible();
  await shellPage.getByRole("button", { name: "Appearance" }).click();
  await expect(shellPage.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Light" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "settings-appearance");
});

test("command palette browser shell can invoke Open settings", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+K");

  const query = shellPage.getByPlaceholder("Search sessions, models, accounts, actions…");
  await expect(query).toBeFocused();
  await query.fill("Open settings");
  await expect(shellPage.getByText("Open settings", { exact: true })).toBeVisible();
  await query.press("Enter");

  await expect(shellPage.getByText("Settings", { exact: true })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "command-palette");
});

test("forced colors and reduced motion keep keyboard focus explicit", async ({ shellPage }) => {
  await shellPage.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });

  const newSession = shellPage.getByRole("button", { name: "New session" });
  await newSession.focus();
  await shellPage.locator(".kernel-pill").evaluate((element) => {
    element.classList.add("child-running");
    element.querySelector(".dot")?.classList.add("child-dot");
  });
  const styles = await newSession.evaluate((element) => {
    const computed = getComputedStyle(element);
    const statusDot = document.querySelector<HTMLElement>(".kernel-pill .dot");
    const dotStyle = statusDot ? getComputedStyle(statusDot) : null;
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth),
      animationDuration: dotStyle?.animationDuration ?? "",
      forcedColorAdjust: dotStyle?.forcedColorAdjust ?? "",
    };
  });

  expect(styles.outlineStyle).not.toBe("none");
  expect(styles.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(Number.parseFloat(styles.animationDuration)).toBeLessThanOrEqual(0.001);
  expect(styles.forcedColorAdjust).toBe("none");
});
