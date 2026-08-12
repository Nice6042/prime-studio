import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";

test("production workspace presents the complete three-region shell", async ({ shellPage }, testInfo) => {
  await expect(shellPage.getByRole("navigation", { name: "Projects and chats" })).toBeVisible();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Switch chat" })).toContainText("Prime Harness architecture");
  await expect(shellPage.getByText(/The parent conversation stays focused on decisions and final results/)).toBeVisible();
  await expect(shellPage.getByText("Checking protocol identity and capability closure.")).toHaveCount(0);
  await expect(shellPage.getByText("workspace.inspect")).toHaveCount(0);
  await expect(shellPage.getByPlaceholder("Message Prime Studio — try / for commands")).toBeEditable();
  await expect(shellPage.getByRole("button", { name: "Model unavailable" })).toBeDisabled();
  await expect(shellPage.getByText("Prompt admission is not connected.")).toHaveCount(0);
  await shellPage.screenshot({ path: testInfo.outputPath("canonical-desktop.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-workspace");
});

test("Harness keeps child work, activity, and current-chat usage out of the parent chat", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("button", { name: /Verify runtime compatibility/ }).click();
  await expect(harness.getByRole("heading", { name: "Verify runtime compatibility" })).toBeVisible();
  await expect(harness.getByText("gpt-5.6-sol")).toBeVisible();
  await expect(harness.getByText(/No verified child transcript entries are available/)).toBeVisible();
  await harness.getByRole("button", { name: "Back to Harness" }).click();
  await harness.getByRole("tab", { name: "Activity" }).click();
  await expect(harness.getByText("Checking protocol identity and capability closure.")).toBeVisible();
  await expect(harness.getByText("workspace.inspect")).toBeVisible();
  await harness.getByRole("tab", { name: "Usage" }).click();
  await expect(harness.getByText("Current chat only")).toBeVisible();
  await expect(harness.getByText("2,400")).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-harness");
});

test("composer admits a cursor-bound command and replaces the live projection", async ({ shellPage }) => {
  const composer = shellPage.getByPlaceholder("Message Prime Studio — try / for commands");
  await composer.fill("Verify the typed command path");
  await composer.press("Enter");
  await expect(shellPage.getByText("Synthetic Harness response admitted through the verified Studio protocol.")).toBeVisible();
  await expect(composer).toHaveValue("");
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("tab", { name: "Usage" }).click();
  await expect(harness.getByText("2,420")).toBeVisible();
});

test("account usage routes to Settings and remains truthfully distinct", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("tab", { name: "Usage" }).click();
  await harness.getByRole("button", { name: "Open account-wide usage in Settings" }).click();
  await expect(shellPage.getByRole("main", { name: "Settings" })).toBeVisible();
  await expect(shellPage.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await expect(shellPage.getByText(/No verified usage in this window/)).toBeVisible();
  await expect(shellPage.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await shellPage.getByRole("button", { name: "Back to chat" }).click();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
});

test("command palette, settings search, theme, and editor are keyboard reachable", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+K");
  const query = shellPage.getByRole("combobox", { name: "Search commands" });
  await expect(query).toBeFocused();
  await query.fill("settings");
  await shellPage.getByRole("option", { name: /Open settings/ }).click();
  await shellPage.getByRole("searchbox", { name: "Search settings" }).fill("theme");
  await shellPage.getByRole("button", { name: /Appearance/ }).click();
  await expect(shellPage.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  await shellPage.getByRole("button", { name: "Back to chat" }).click();
  await shellPage.getByRole("button", { name: "Open editor" }).click();
  await expect(shellPage.getByRole("region", { name: "Editor" })).toBeVisible();
  await expect(shellPage.getByText(/No verified file or Canvas revision/)).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-settings-editor");
});

test("resizable project and Harness panes preserve a usable conversation", async ({ shellPage }) => {
  const center = shellPage.getByRole("main", { name: "Prime Harness architecture" });
  const before = await center.evaluate((element) => element.getBoundingClientRect().width);
  const separator = shellPage.getByRole("separator", { name: "Resize Harness inspector" });
  await separator.focus();
  await shellPage.keyboard.press("ArrowRight");
  const after = await center.evaluate((element) => element.getBoundingClientRect().width);
  expect(after).not.toBe(before);
  expect(after).toBeGreaterThanOrEqual(340);
});

test("Canvas creates a display revision without rewriting Harness history", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "Edit answer in Canvas" }).click();
  const editor = shellPage.getByRole("region", { name: "Editor" });
  const canvas = editor.getByRole("textbox", { name: "Canvas content" });
  await canvas.fill("A concise Studio-only display revision.");
  await editor.getByRole("button", { name: "Apply display revision" }).click();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" }).getByText("A concise Studio-only display revision.")).toBeVisible();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" }).getByText("Display revision 2")).toBeVisible();
  await expect(editor.getByText(/does not rewrite Harness history/)).toBeVisible();
});

test("forced colors and reduced motion keep controls operable", async ({ shellPage }) => {
  await shellPage.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const trigger = shellPage.getByRole("button", { name: "Open command palette" });
  await trigger.focus();
  const styles = await trigger.evaluate((element) => ({ outline: getComputedStyle(element).outlineStyle, width: Number.parseFloat(getComputedStyle(element).outlineWidth) }));
  expect(styles.outline).not.toBe("none");
  expect(styles.width).toBeGreaterThanOrEqual(2);
});
