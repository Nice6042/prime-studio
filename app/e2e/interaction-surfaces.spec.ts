import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

test("topmost menus own global shortcuts without leaking workspace commands", async ({ shellPage }) => {
  const file = shellPage.getByRole("button", { name: "File", exact: true });
  await file.click();
  const menu = shellPage.getByRole("menu", { name: "File menu" });
  await expect(menu).toBeVisible();
  const before = await shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_BROWSER_REQUESTS__?: unknown[] }).__PRIME_STUDIO_BROWSER_REQUESTS__?.length ?? 0);

  const dispatchResults = await shellPage.evaluate(() => ["n", "k", ",", "b", "j"].map((key) => {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    const dispatched = window.dispatchEvent(event);
    return { key, dispatched, defaultPrevented: event.defaultPrevented };
  }));

  expect(dispatchResults).toEqual(["n", "k", ",", "b", "j"].map((key) => ({ key, dispatched: false, defaultPrevented: true })));
  await expect(menu).toBeVisible();
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(shellPage.getByRole("main", { name: "Settings" })).toHaveCount(0);
  await expect(shellPage.getByRole("navigation", { name: "Projects and chats" })).toBeVisible();
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toBeVisible();
  const after = await shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_BROWSER_REQUESTS__?: unknown[] }).__PRIME_STUDIO_BROWSER_REQUESTS__?.length ?? 0);
  expect(after).toBe(before);

  await shellPage.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(file).toBeFocused();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-topmost-shortcut-ownership");
});

test("application menus support directional navigation and restore the active trigger", async ({ shellPage }) => {
  const file = shellPage.getByRole("button", { name: "File", exact: true });
  await file.focus();
  await shellPage.keyboard.press("ArrowDown");

  const newChat = shellPage.getByRole("menuitem", { name: "New chat" });
  await expect(newChat).toBeDisabled();
  await expect(shellPage.getByRole("menuitem", { name: "Settings" })).toBeFocused();

  await shellPage.keyboard.press("ArrowRight");
  await expect(shellPage.getByRole("menu", { name: "Edit menu" })).toBeVisible();
  await expect(shellPage.getByRole("menuitem", { name: "Undo" })).toBeFocused();
  await shellPage.keyboard.press("ArrowRight");
  await expect(shellPage.getByRole("menuitem", { name: "Toggle sidebar" })).toBeFocused();
  await shellPage.keyboard.press("ArrowLeft");
  await expect(shellPage.getByRole("menuitem", { name: "Undo" })).toBeFocused();

  await shellPage.keyboard.press("Escape");
  await expect(shellPage.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-title-menu-keyboard-navigation");
});

test("composer and title popovers dismiss outside without stealing the clicked target", async ({ shellPage }) => {
  const composer = shellPage.getByRole("textbox", { name: "Message Prime Studio" });
  const file = shellPage.getByRole("button", { name: "File", exact: true });

  await file.click();
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toBeVisible();
  await composer.click();
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toHaveCount(0);
  await expect(composer).toBeFocused();

  const model = shellPage.getByRole("button", { name: /Choose model/ });
  await model.click();
  await expect(shellPage.getByRole("menu", { name: "Verified models" })).toBeVisible();
  await composer.click();
  await expect(shellPage.getByRole("menu", { name: "Verified models" })).toHaveCount(0);
  await expect(composer).toBeFocused();

  const thinking = shellPage.getByRole("button", { name: /^Thinking / });
  await thinking.click();
  const thinkingMenu = shellPage.getByRole("menu", { name: "Thinking level" });
  await expect(thinkingMenu).toBeVisible();
  await expect(thinkingMenu.getByRole("menuitemradio", { checked: true })).toBeFocused();
  await file.click();
  await expect(thinkingMenu).toHaveCount(0);
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toBeVisible();
  await expect(file).toBeFocused();
  await shellPage.keyboard.press("Escape");
  await expect(shellPage.getByRole("menu", { name: "File menu" })).toHaveCount(0);
  await expect(file).toBeFocused();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-shared-popover-dismissal");
});
