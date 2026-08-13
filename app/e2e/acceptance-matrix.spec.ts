import { activateWithKeyboard, expectMinimumTarget, expectNoDocumentOverflow, expectWithinViewport, settingsDestinations } from "./support/acceptance-matrix";
import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";
import { STUDIO_ACTIONS } from "../src/contracts/studioOperations";

test("all thirteen Settings destinations are keyboard reachable and expose their real page", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+,");
  const settings = shellPage.getByRole("main", { name: "Settings" });
  const navigation = settings.getByRole("navigation", { name: "Settings sections" });
  await expect(settings).toBeVisible();

  for (const destination of settingsDestinations) {
    const button = navigation.getByRole("button", { name: new RegExp(`^${destination.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u") });
    await activateWithKeyboard(button);
    await expect(settings.getByRole("heading", { name: destination.label, exact: true, level: 1 })).toBeVisible();
    await expect(destination.signature(settings)).toBeVisible();
    await expect(button).toHaveAttribute("aria-current", "page");
  }

  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-settings-matrix");
});

test("archive route and parent conversation remain distinct from Harness child detail", async ({ shellPage }) => {
  const parent = shellPage.getByRole("main", { name: "Prime Harness architecture" });
  await expect(parent.getByText("Map the Prime Harness boundary and keep the parent chat concise.")).toBeVisible();
  await expect(parent.getByText(/The parent conversation stays focused on decisions and final results/)).toBeVisible();
  await expect(parent.getByText("Checking protocol identity and capability closure.")).toHaveCount(0);
  await expect(parent.getByText("workspace.inspect")).toHaveCount(0);

  await activateWithKeyboard(shellPage.getByRole("button", { name: "Archived chats" }));
  const archive = shellPage.getByRole("main", { name: "Archived chats" });
  await expect(archive.getByRole("heading", { name: "Archived chats", level: 1 })).toBeVisible();
  await expect(archive.getByText("No archived projects or chats.")).toBeVisible();
  await activateWithKeyboard(archive.getByRole("button", { name: "Back to chat" }));
  await expect(parent).toBeVisible();

  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  const content = harness.getByRole("region", { name: "Harness inspector content" });
  await expect(content.getByRole("region", { name: "Main agent" })).toBeVisible();
  await expect(content.getByRole("region", { name: "This chat" })).toContainText("15.2k");
  await expect(harness.getByRole("button", { name: "Verify runtime compatibility, running" })).toBeVisible();
  await expect(harness.getByRole("button", { name: "Map project navigation, done" })).toBeVisible();

  for (const disclosure of ["Queue", "Tools", "Context", "Outputs", "Sources"] as const) {
    await harness.locator("summary").filter({ hasText: new RegExp(`^${disclosure}`) }).click();
  }
  await expect(harness.getByText("Summarize verification", { exact: true })).toBeVisible();
  await expect(harness.getByRole("switch", { name: "Workspace inspect" })).toBeChecked();
  await expect(harness.getByRole("button", { name: /Synthetic project/ })).toBeDisabled();
  await expect(harness.getByRole("button", { name: /Harness report/ })).toBeEnabled();
  await expect(harness.getByRole("button", { name: /Harness contract/ })).toBeEnabled();

  const runningChild = harness.getByRole("button", { name: "Verify runtime compatibility, running" });
  await activateWithKeyboard(runningChild);
  await expect(harness.getByRole("heading", { name: "Verify runtime compatibility" })).toBeVisible();
  await expect(harness.getByText("gpt-5.6-sol")).toBeVisible();
  await expect(harness.getByText("Verified child task details are unavailable.")).toBeVisible();
  const childComposer = harness.getByRole("textbox", { name: "Child message" });
  await expect(childComposer).toHaveAttribute("readonly", "");
  await expect(childComposer).toHaveValue("Child tasks are managed by the harness");
  await childComposer.focus();
  await childComposer.press("Enter");
  await expect(childComposer).toHaveValue("Child tasks are managed by the harness");
  await expect(parent.getByText("Child tasks are managed by the harness")).toHaveCount(0);
  await expect(harness.getByRole("textbox", { name: "Message Prime Studio" })).toHaveCount(0);
  const chatTab = harness.getByRole("tab", { name: "Chat" });
  await expect(chatTab).toHaveAttribute("aria-selected", "true");
  await expect(harness.getByRole("status", { name: "Child chat unavailable" })).toContainText("Deterministic fixtures do not supply authoritative child paging evidence.");
  await chatTab.focus();
  await chatTab.press("ArrowRight");
  await expect(harness.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(harness.getByRole("status", { name: "Child activity unavailable" })).toContainText("Deterministic fixtures do not supply authoritative child paging evidence.");
  await harness.getByRole("tab", { name: "Activity" }).press("ArrowRight");
  await expect(harness.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(harness.getByRole("status", { name: "Child files unavailable" })).toContainText("Deterministic fixtures do not supply authoritative child paging evidence.");
  await activateWithKeyboard(harness.getByRole("button", { name: "Back to Harness" }));
  await expect(harness.getByRole("tab", { name: "Harness" })).toHaveAttribute("aria-selected", "true");
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-archive-parent-child-harness");
});

test("runtime extension editor is inspector-only, focused, keyboard cancellable, and accessible", async ({ shellPage }) => {
  const parent = shellPage.getByRole("main", { name: "Prime Harness architecture" });
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  const editor = harness.getByRole("textbox", { name: "Extension instructions" });
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(parent.getByText("Private runtime prompt")).toHaveCount(0);
  await editor.press("Escape");
  await expect(harness.getByRole("heading", { name: "Extension instructions" })).toHaveCount(0);
  const nextInput = harness.getByRole("textbox", { name: "Extension note" });
  await expect(nextInput).toBeFocused();
  await nextInput.press("Escape");
  await expect(harness.getByRole("heading", { name: "Extension note" })).toHaveCount(0);
  await expect(harness.getByRole("tab", { name: "Harness" })).toBeFocused();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-runtime-extension-editor");
});

test("child detail receives focus after its final runtime extension prompt", async ({ shellPage }) => {
  const parent = shellPage.getByRole("main", { name: "Prime Harness architecture" });
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await activateWithKeyboard(harness.getByRole("button", { name: "Verify runtime compatibility, running" }));
  await expect(harness.getByRole("heading", { name: "Verify runtime compatibility" })).toBeVisible();

  const editor = harness.getByRole("textbox", { name: "Extension instructions" });
  await editor.focus();
  await editor.press("Escape");
  await expect(harness.getByRole("textbox", { name: "Extension note" })).toBeFocused();
  await harness.getByRole("textbox", { name: "Extension note" }).press("Escape");

  await expect(harness.getByRole("button", { name: "Back to Harness" })).toBeFocused();
  await expect(parent.getByText("Private runtime prompt")).toHaveCount(0);
  await expect(parent.getByText("Private follow-up")).toHaveCount(0);
});

test("Harness overview, usage, and activity expose every truthful fixture projection", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  const tabs = harness.getByRole("tablist", { name: "Harness views" });
  const overview = tabs.getByRole("tab", { name: "Harness" });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Usage" })).toBeFocused();
  await expect(harness.getByText("Current chat", { exact: true })).toBeVisible();
  await expect(harness.getByText("2,400", { exact: true })).toBeVisible();
  await expect(harness.getByRole("img", { name: "Tokens by turn" })).toBeVisible();
  const turnTable = harness.getByRole("table", { name: "Tokens by turn data" });
  await expect(turnTable).toBeVisible();
  await expect(turnTable.getByRole("columnheader", { name: "Cache read" })).toBeVisible();
  await expect(turnTable.getByRole("rowheader", { name: "3" })).toBeVisible();
  await expect(harness.getByText("Context history is unavailable.")).toBeVisible();
  await expect(harness.getByText("Parent and child attribution is unavailable. Totals are not guessed.")).toBeVisible();
  await tabs.getByRole("tab", { name: "Usage" }).press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Activity" })).toBeFocused();
  await expect(harness.getByText("No activity matches this filter.")).toBeVisible();
  await expect(harness.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await activateWithKeyboard(harness.getByRole("button", { name: "Tools" }));
  await expect(harness.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-pressed", "true");
  await expect(harness.getByText("No activity matches this filter.")).toBeVisible();
  await tabs.getByRole("tab", { name: "Activity" }).press("Home");
  await expect(tabs.getByRole("tab", { name: "Harness" })).toBeFocused();
  await expect(harness.getByRole("region", { name: "Main agent" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-harness-route-matrix");
});

test("editor covers empty, Canvas edit, and conflict-safe authority-unavailable states", async ({ shellPage }) => {
  await activateWithKeyboard(shellPage.getByRole("button", { name: "Open editor" }));
  const editor = shellPage.getByRole("region", { name: "Editor" });
  await expect(editor.getByText("No verified file or Canvas revision")).toBeVisible();
  await expect(editor.getByText(/Open an identity-bound candidate from Harness/)).toBeVisible();
  await expect(editor.getByRole("tab", { name: "Diff" })).toHaveCount(0);
  await expect(editor.getByRole("tab", { name: "Edit" })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();

  await shellPage.getByRole("button", { name: "Edit answer in Canvas" }).click();
  await expect(editor.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  const canvas = editor.getByRole("textbox", { name: "Canvas content" });
  await canvas.fill("Browser acceptance display revision.");
  await expect(editor.getByText("Unsaved changes", { exact: true })).toHaveCount(2);
  await activateWithKeyboard(editor.getByRole("button", { name: "Apply display revision" }));
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" }).getByText("Browser acceptance display revision.")).toBeVisible();
  await expect(editor.getByText("Display revision 2", { exact: true })).toBeVisible();
  await expect(editor.getByText(/does not rewrite Harness history/)).toBeVisible();
});

test("Canvas editor metadata meets the strict contrast gate", async ({ shellPage }) => {
  await shellPage.getByRole("button", { name: "Edit answer in Canvas" }).click();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-editor-authority-matrix");
});

test("wide 1280 and 1600 layouts keep all attached panes ordered and usable", async ({ shellPage }) => {
  for (const width of [1280, 1600] as const) {
    await shellPage.setViewportSize({ width, height: width === 1280 ? 800 : 900 });
    const sidebar = shellPage.getByRole("navigation", { name: "Projects and chats" });
    const conversation = shellPage.getByRole("main", { name: "Prime Harness architecture" });
    const harness = shellPage.getByRole("complementary", { name: "Harness" });
    await expect(sidebar).toHaveAttribute("data-mode", "pane");
    const [left, center, right] = await Promise.all([sidebar.boundingBox(), conversation.boundingBox(), harness.boundingBox()]);
    expect(left).not.toBeNull();
    expect(center).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.x + left!.width).toBeLessThanOrEqual(center!.x);
    expect(center!.x + center!.width).toBeLessThanOrEqual(right!.x);
    expect(center!.width).toBeGreaterThanOrEqual(340);
    await expectWithinViewport(sidebar, shellPage);
    await expectWithinViewport(conversation, shellPage);
    await expectWithinViewport(harness, shellPage);
  }
  await expectMinimumTarget(shellPage.getByRole("button", { name: "Open command palette" }));
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-wide-geometry");
});

test("820 and 640 compact layouts preserve keyboard surfaces without page overflow", async ({ shellPage }) => {
  await shellPage.setViewportSize({ width: 820, height: 640 });
  const sidebar = shellPage.getByRole("navigation", { name: "Projects and chats" });
  await expect(sidebar).toHaveAttribute("data-mode", "rail");
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toBeVisible();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();

  await shellPage.setViewportSize({ width: 640, height: 400 });
  await expect(shellPage.getByRole("navigation", { name: "Projects and chats" })).toHaveAttribute("data-mode", "rail");
  const runtimeStatus = shellPage.locator(".studio-statusbar");
  await expect(runtimeStatus).toBeVisible();
  await expect(runtimeStatus).toHaveAccessibleName(/Runtime status:.*gpt-5\.6-sol.*ctx unavailable.*142ms first token.*18\.4 tok\/s/i);
  const statusGeometry = await runtimeStatus.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    width: element.getBoundingClientRect().width,
    scrollWidth: element.scrollWidth,
  }));
  expect(statusGeometry.height).toBe(24);
  expect(statusGeometry.scrollWidth).toBeLessThanOrEqual(statusGeometry.width + 1);
  const harnessButton = shellPage.getByRole("button", { name: "Harness" });
  await activateWithKeyboard(harnessButton);
  const sheet = shellPage.locator('[data-studio-sheet="inspector"]');
  await expectWithinViewport(sheet, shellPage);
  await shellPage.keyboard.press("Escape");
  await shellPage.keyboard.press("Control+K");
  const palette = shellPage.getByRole("dialog", { name: "Command palette" });
  await expectWithinViewport(palette, shellPage);
  await shellPage.keyboard.press("Escape");
  await expectNoDocumentOverflow(shellPage);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-compact-geometry");
});

test("window controls remain inside the viewport at attached-pane widths", async ({ shellPage }) => {
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await expectNoDocumentOverflow(shellPage);
});

test("production Harness adapter exposes only identity-bound Output and Source candidates", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.locator("summary").filter({ hasText: /^Outputs/u }).click();
  await harness.locator("summary").filter({ hasText: /^Sources/u }).click();
  await expect(harness.getByRole("button", { name: /Harness report/ })).toBeEnabled();
  await expect(harness.getByRole("button", { name: /Harness contract/ })).toBeEnabled();
  await expect(harness.getByText(/\\|\/Users|C:/u)).toHaveCount(0);
});

test("identity-bound Harness artifact opens Diff/Edit and reconciles save conflicts", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.locator("summary").filter({ hasText: /^Outputs/u }).click();
  await activateWithKeyboard(harness.getByRole("button", { name: /Harness report/ }));
  const editor = shellPage.getByRole("region", { name: "Editor" });
  await expect(editor.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
  await activateWithKeyboard(editor.getByRole("tab", { name: "Edit" }));
  const content = editor.getByRole("textbox", { name: "File content" });
  await content.fill("saved through authority");
  await activateWithKeyboard(editor.getByRole("button", { name: "Save" }));
  await expect(editor.getByText("Saved revision 2")).toBeVisible();
  await content.fill("external conflict");
  await activateWithKeyboard(editor.getByRole("button", { name: "Save" }));
  await expect(editor.getByRole("alert")).toContainText("changed on disk");
});

test("every rendered product control has a stable identity and declared actions stay closed", async ({ shellPage }) => {
  const assertBoundControls = async (surface: string) => {
    const missing = await shellPage.locator('button, input, select, textarea, summary, a[href]').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .filter((element) => !element.hasAttribute("data-control-id"))
        .map((element) => ({
          tag: element.tagName.toLocaleLowerCase(),
          label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? "",
          id: element.getAttribute("data-control-id"),
          action: element.getAttribute("data-action"),
        })),
    );
    expect(missing, `${surface} contains rendered controls without a stable control identity`).toEqual([]);
    const duplicates = await shellPage.locator('[data-control-id]').evaluateAll((elements) => {
      const counts = new Map<string, number>();
      for (const element of elements) {
        const id = element.getAttribute("data-control-id");
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return [...counts].filter(([, count]) => count > 1);
    });
    expect(duplicates, `${surface} contains duplicate rendered control identities`).toEqual([]);
    const renderedActions = await shellPage.locator('[data-studio-action]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-studio-action")),
    );
    expect(
      renderedActions.filter((action) => !action || !(action in STUDIO_ACTIONS)),
      `${surface} advertises actions outside the closed operation contract`,
    ).toEqual([]);
  };

  await assertBoundControls("workspace");
  await shellPage.keyboard.press("Control+,");
  const settings = shellPage.getByRole("main", { name: "Settings" });
  const navigation = settings.getByRole("navigation", { name: "Settings sections" });
  for (const destination of settingsDestinations) {
    await navigation.getByRole("button", { name: new RegExp(`^${destination.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u") }).click();
    await assertBoundControls(`settings.${destination.id}`);
  }
});
