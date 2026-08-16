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
  await expect(shellPage.getByRole("group", { name: "Quick model switcher" })).toHaveCount(0);
  await expect(shellPage.getByText("Prompt admission is not connected.")).toHaveCount(0);
  await shellPage.screenshot({ path: testInfo.outputPath("canonical-desktop.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-workspace");
});

test("project groups expose durable keyboard disclosures without changing chat truth", async ({ shellPage }, testInfo) => {
  const disclosure = shellPage.getByRole("button", { name: "Personal project" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const groupId = await disclosure.getAttribute("aria-controls");
  expect(groupId).toBeTruthy();
  const group = shellPage.locator(`[id="${groupId}"]`);
  await expect(group).toBeVisible();
  await expect(group.getByRole("button", { name: /Prime Harness architecture.*status: Working/i })).toBeVisible();

  await disclosure.focus();
  await shellPage.keyboard.press("ArrowLeft");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(group).toBeHidden();
  await shellPage.keyboard.press("ArrowRight");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(group).toBeVisible();
  const durableWrites = await shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_BROWSER_INVOKES__?: string[] }).__PRIME_STUDIO_BROWSER_INVOKES__?.filter((command) => command === "set_layout_preferences").length ?? 0);
  expect(durableWrites).toBeGreaterThanOrEqual(2);

  await shellPage.screenshot({ path: testInfo.outputPath("project-tree-wide.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "project-tree-wide");
});

test("configured workspace footer owns a keyboard menu with explicit operation outcomes", async ({ shellPage }, testInfo) => {
  const trigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
  await expect(trigger).toContainText("D:\\fixture\\Prime Studio");
  await trigger.click();
  const menu = shellPage.getByRole("menu", { name: "Workspace actions" });
  await expect(menu.getByRole("menuitem", { name: "Switch workspace" })).toBeFocused();
  await menu.getByRole("menuitem", { name: "Switch workspace" }).click();
  const outcome = shellPage.locator(".workspace-menu-status");
  await expect(outcome).toContainText("Workspace switching is unavailable");
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(outcome).toContainText("configured folders do not own an authenticated session");
  await shellPage.screenshot({ path: testInfo.outputPath("workspace-footer-wide.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-workspace-footer");
  await menu.getByRole("menuitem", { name: "Settings" }).click();
  await expect(shellPage.getByRole("main", { name: "Settings" })).toBeVisible();
});

test("typed failure toasts deduplicate, stay outside the inspector, and dismiss through the dispatcher", async ({ shellPage }) => {
  const trigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
  await trigger.click();
  const switchWorkspace = shellPage.getByRole("menuitem", { name: "Switch workspace" });
  await switchWorkspace.click();
  await switchWorkspace.click();

  const toast = shellPage.getByRole("alert", { name: "Studio data operation failed" });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Workspace switching is unavailable");
  await expect(toast).toContainText("Occurred 2 times");
  await expect(shellPage.getByRole("complementary", { name: "Harness" }).getByRole("alert", { name: "Studio data operation failed" })).toHaveCount(0);
  const dismiss = toast.getByRole("button", { name: "Dismiss Studio data operation failed" });
  await expect(dismiss).toHaveAttribute("data-studio-action", "toast.dismiss");
  await dismiss.click();
  await expect(toast).toHaveCount(0);
  await expect.poll(() => shellPage.evaluate(() => document.activeElement?.getAttribute("data-control-id")))
    .toMatch(/^(rail-workspace-menu|sidebar-workspace-menu|workspace-switch|title-action\.inspector\.toggle)$/u);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-typed-toast-wide");
});

test("retryable toast Retry retains Chromium keyboard focus after another dispatcher rejection", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("button", { name: "Retry", exact: true }).click();

  const toast = shellPage.getByRole("alert", { name: "Harness request failed" });
  const retry = toast.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await retry.focus();
  await shellPage.keyboard.press("Enter");

  await expect(retry).toHaveAttribute("aria-disabled", "false");
  await expect(retry).toBeFocused();
});

test("collapsed rail preserves one dispatcher-owned keyboard action set and adaptive focus", async ({ shellPage }, testInfo) => {
  await shellPage.getByRole("button", { name: "Collapse sidebar" }).click();
  const rail = shellPage.getByRole("toolbar", { name: "Collapsed navigation" });
  await expect(rail).toBeVisible();
  const expected = [
    ["rail.sidebar.toggle", "Expand sidebar", "Expand sidebar (Ctrl+B)"],
    ["rail.chat.new", "New chat", /^New chat (?:\(Ctrl\+N\)|unavailable:)/],
    ["rail.palette.open", "Search", "Search (Ctrl+K)"],
    ["rail.settings.open", "Settings", "Settings (Ctrl+,)"],
    ["rail-workspace-menu", "Prime Studio workspace menu", "Prime Studio: D:\\fixture\\Prime Studio"],
  ] as const;
  for (const [controlId, label, description] of expected) {
    const control = shellPage.locator(`[data-control-id="${controlId}"]`);
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAccessibleName(label);
    await expect(control).toHaveAccessibleDescription(description);
  }
  await expect(shellPage.locator('[data-control-id="rail.sidebar.toggle"]')).toBeFocused();
  await shellPage.keyboard.press("ArrowDown");
  await expect(shellPage.locator('[data-control-id="rail.chat.new"]')).toBeFocused();
  await shellPage.keyboard.press("ArrowDown");
  const search = shellPage.locator('[data-control-id="rail.palette.open"]');
  await expect(search).toBeFocused();
  await expect(search.locator("xpath=following-sibling::*[@role='tooltip']")).toHaveCSS("opacity", "1");
  await shellPage.keyboard.press("Enter");
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shellPage.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await shellPage.screenshot({ path: testInfo.outputPath("collapsed-rail-wide.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "collapsed-rail-wide");

  await shellPage.locator('[data-control-id="rail.sidebar.toggle"]').focus();
  await shellPage.keyboard.press("Enter");
  await expect(shellPage.locator('[data-control-id="sidebar.collapse"]')).toBeFocused();
  await shellPage.setViewportSize({ width: 820, height: 640 });
  await expect(shellPage.locator('[data-control-id="rail.sidebar.toggle"]')).toBeFocused();
  await shellPage.keyboard.press("Enter");
  const sheet = shellPage.locator('[data-studio-sheet="sidebar"]');
  await expect(sheet.locator('[data-control-id="sidebar.collapse"]')).toBeFocused();
  await expect(shellPage.locator('.studio-sidebar[data-mode="rail"]')).toHaveAttribute("inert", "");
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await expect(shellPage.getByRole("navigation", { name: "Projects and chats" })).toHaveAttribute("data-mode", "pane");
  const expandedCollapse = shellPage.locator('[data-control-id="sidebar.collapse"]');
  await expect(expandedCollapse).toBeFocused();
  await expandedCollapse.press("Enter");
  await expect(shellPage.locator('[data-control-id="rail.sidebar.toggle"]')).toBeFocused();
});

test("sidebar reports admitted chat lifecycle without starting an inactive chat", async ({ shellPage }, testInfo) => {
  const working = shellPage.getByRole("button", { name: /Prime Harness architecture.*status: Working/i });
  await expect(working.first()).toHaveAttribute("data-session-status", "working");
  await expect(working.first()).toHaveAccessibleDescription("Working: Harness is processing this chat.");
  await expect(working.first().locator(".chat-lifecycle")).toHaveAttribute("title", "Working: Harness is processing this chat.");
  const idle = shellPage.getByRole("button", { name: /Inactive planning notes.*status: Idle/i });
  await expect(idle).toHaveAttribute("data-session-status", "idle");
  await expect(idle).toHaveAccessibleDescription("Idle: No Harness session has been started for this chat.");
  await expect(idle.locator(".chat-lifecycle")).toHaveAttribute("title", "Idle: No Harness session has been started for this chat.");
  const providerStarts = await shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_BROWSER_INVOKES__?: string[] }).__PRIME_STUDIO_BROWSER_INVOKES__?.filter((command) => command === "start_session").length ?? -1);
  expect(providerStarts).toBe(0);
  await shellPage.screenshot({ path: testInfo.outputPath("chat-lifecycle-wide.png"), fullPage: true });
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-chat-lifecycle-wide");
});

test("workspace menu transfers focus across pane and rail replacements without reopening", async ({ shellPage }) => {
  const trigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
  await trigger.click();
  await shellPage.keyboard.press("Tab");
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.getByRole("separator", { name: "Resize project sidebar" })).toBeFocused();

  await trigger.click();
  await shellPage.keyboard.press("Shift+Tab");
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.locator(".project-settings")).toBeFocused();

  await trigger.click();
  await shellPage.setViewportSize({ width: 700, height: 800 });
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  const railTrigger = shellPage.locator('[data-control-id="rail-workspace-menu"]');
  await expect(railTrigger).toBeFocused();
  await expect(railTrigger).toHaveAttribute("aria-expanded", "false");

  await railTrigger.click();
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  const expandedTrigger = shellPage.locator('[data-control-id="sidebar-workspace-menu"]');
  await expect(expandedTrigger).toBeFocused();
  await expect(expandedTrigger).toHaveAttribute("aria-expanded", "false");

  await shellPage.setViewportSize({ width: 700, height: 800 });
  await shellPage.getByRole("button", { name: "Projects" }).click();
  const sheet = shellPage.locator('[data-studio-sheet="sidebar"]');
  const sheetTrigger = sheet.locator('[data-control-id="sidebar-workspace-menu"]');
  await sheetTrigger.click();
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  const replacementPaneTrigger = shellPage.locator('[data-control-id="sidebar-workspace-menu"]');
  await expect(replacementPaneTrigger).toBeFocused();
  await expect(replacementPaneTrigger).toHaveAttribute("aria-expanded", "false");

  await replacementPaneTrigger.click();
  await shellPage.setViewportSize({ width: 700, height: 800 });
  await expect(shellPage.getByRole("menu", { name: "Workspace actions" })).toHaveCount(0);
  await expect(shellPage.locator('[data-studio-sheet="sidebar"]')).toHaveCount(0);
  const replacementRailTrigger = shellPage.locator('[data-control-id="rail-workspace-menu"]');
  await expect(replacementRailTrigger).toBeFocused();
  await expect(replacementRailTrigger).toHaveAttribute("aria-expanded", "false");
});

test("Harness keeps child work, activity, and current-chat usage out of the parent chat", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("button", { name: /Verify runtime compatibility/ }).click();
  await expect(harness.getByRole("heading", { name: "Verify runtime compatibility" })).toBeVisible();
  await expect(harness.getByText("gpt-5.6-sol")).toBeVisible();
  await expect(harness.getByRole("status", { name: "Child chat unavailable" })).toContainText("Deterministic fixtures do not supply authoritative child paging evidence.");
  await harness.getByRole("button", { name: "Back to Harness" }).click();
  await harness.getByRole("tab", { name: "Activity" }).click();
  await expect(harness.getByRole("button", { name: /Redacted shell command/ })).toBeVisible();
  await expect(harness.getByText("Attention ledger unavailable.")).toHaveCount(0);
  await expect(harness.getByText("workspace.inspect")).toHaveCount(0);
  await harness.getByRole("tab", { name: "Usage" }).click();
  await expect(harness.getByText("Current chat", { exact: true })).toBeVisible();
  await expect(harness.getByText("2,400")).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-harness");
});

test("Harness renders only authoritative child progress without per-row estimates", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  const running = harness.getByRole("button", { name: /Verify runtime compatibility, running/ });
  const completed = harness.getByRole("button", { name: /Map project navigation, done/ });

  await expect(running.getByLabel("72% complete")).toBeVisible();
  await expect(completed.getByLabel("100% complete")).toBeVisible();
  await expect(harness.locator('.harness-agent-row [aria-label$="% complete"]')).toHaveCount(2);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-harness-authoritative-progress");
});

test("Activity exposes only the redacted command and opens its exact opaque artifact", async ({ shellPage }) => {
  const harness = shellPage.getByRole("complementary", { name: "Harness" });
  await harness.getByRole("tab", { name: "Activity" }).click();
  await harness.getByRole("button", { name: /Redacted shell command/ }).click();
  const command = "[escaped] curl [REDACTED_SECRET] [REDACTED_PROFILE_PATH] \\n \\u{202E}";
  await expect(harness.getByTitle(command)).toContainText(command);
  await expect(harness.getByText("Redacted", { exact: true })).toBeVisible();
  await expect(harness.getByText("Unavailable", { exact: true })).toBeVisible();
  await harness.getByRole("button", { name: "Copy command" }).click();
  await expect(harness.getByText("Command copied.", { exact: true })).toHaveAttribute("role", "status");
  await expect.poll(() => shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_CLIPBOARD__?: string[] }).__PRIME_STUDIO_CLIPBOARD__)).toEqual([command]);
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-activity-redacted-wide");
  await harness.getByRole("button", { name: "Open activity-report.md" }).click();
  await expect(shellPage.getByRole("region", { name: "Editor" })).toContainText("activity-report.md");
  await expect(shellPage.locator("body")).not.toContainText("secret-token");
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
  await expect(shellPage.getByText("API-equivalent cost", { exact: true })).toBeVisible();
  await expect(shellPage.getByText("$1.25", { exact: true }).first()).toBeVisible();
  await expect(shellPage.getByText(/Codex CLI snapshot · pro/)).toBeVisible();
  await expect(shellPage.getByText("42.5%")).toBeVisible();
  await expect(shellPage.getByText("70.0%")).toBeVisible();
  await expect(shellPage.getByText(/As of/)).toBeVisible();
  await expect(shellPage.getByText(/^Current chat$/i)).toHaveCount(0);
  await expect(shellPage.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-settings-usage-wide");
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

test("appearance and composer preferences persist through the native settings authority", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+,");
  await shellPage.getByRole("button", { name: /^Appearance/ }).click();
  await shellPage.getByRole("combobox", { name: "Accent" }).selectOption("ember");
  await shellPage.getByRole("combobox", { name: "Font size" }).selectOption("large");
  await shellPage.getByRole("switch", { name: "Show timestamps" }).click();
  await shellPage.getByRole("switch", { name: "Compact message bubbles" }).click();

  await shellPage.getByRole("button", { name: /^Composer/ }).click();
  await shellPage.getByRole("switch", { name: "Voice control" }).click();
  await shellPage.getByRole("switch", { name: "Spell check" }).click();
  await shellPage.getByRole("button", { name: "Back to chat" }).click();

  await expect(shellPage.locator("html")).toHaveAttribute("data-accent", "ember");
  await expect(shellPage.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(shellPage.locator("html")).toHaveAttribute("data-bubbles", "compact");
  await expect(shellPage.locator(".parent-turn time")).toHaveCount(0);
  await expect(shellPage.getByRole("textbox", { name: "Message Prime Studio" })).toHaveAttribute("spellcheck", "false");
  await expect(shellPage.getByRole("button", { name: "Voice input" })).toHaveCount(0);

  const settingWrites = await shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string; args: Record<string, unknown> }> }).__PRIME_STUDIO_BROWSER_REQUESTS__
    ?.filter((request) => request.command === "set_app_setting")
    .map((request) => request.args.key) ?? []);
  expect(settingWrites).toEqual(expect.arrayContaining(["accent", "fontSize", "timestamps", "bubbles", "voice", "spell"]));
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-local-preferences");
});

test("General settings persist applied defaults and own workspace and panel layout changes", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+,");
  await shellPage.getByRole("button", { name: /^General/ }).click();
  await shellPage.getByRole("combobox", { name: "Theme" }).selectOption("light");
  await shellPage.getByRole("combobox", { name: "Density" }).selectOption("compact");
  await shellPage.getByRole("combobox", { name: "Send shortcut" }).selectOption("ctrl-enter");
  await shellPage.getByRole("switch", { name: "Reduced motion" }).click();
  await shellPage.getByRole("button", { name: "Browse default workspace" }).click();
  await expect(shellPage.getByText("D:\fixture\Selected Workspace", { exact: true })).toBeVisible();
  await shellPage.getByRole("button", { name: "Back to chat" }).click();
  await shellPage.getByRole("button", { name: "New project" }).click();
  await expect(shellPage.getByRole("textbox", { name: "Folder path" })).toHaveValue("D:\\fixture\\Selected Workspace");
  await expect(shellPage.getByRole("button", { name: "Create project" })).toBeDisabled();
  await shellPage.keyboard.press("Escape");
  await shellPage.keyboard.press("Control+,");
  await shellPage.getByRole("button", { name: /^General/ }).click();

  const setRange = async (name: string, value: number) => {
    await shellPage.getByRole("slider", { name }).evaluate((element, next) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, String(next));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };
  await setRange("Projects panel width", 320);
  await setRange("Harness panel width", 470);
  await setRange("Editor panel width", 510);
  await expect(shellPage.getByText("320px", { exact: true })).toBeVisible();
  await expect(shellPage.getByText("470px", { exact: true })).toBeVisible();
  await expect(shellPage.getByText("510px", { exact: true })).toBeVisible();
  await shellPage.getByRole("button", { name: "Restore defaults" }).click();
  await expect(shellPage.getByText("264px", { exact: true })).toBeVisible();
  await expect(shellPage.getByText("384px", { exact: true })).toBeVisible();
  await expect(shellPage.getByText("400px", { exact: true })).toBeVisible();
  await shellPage.getByRole("button", { name: "Back to chat" }).click();

  await expect(shellPage.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(shellPage.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(shellPage.locator("html")).toHaveAttribute("data-reduced-motion", "true");

  const requests = await shellPage.evaluate(() => (window as typeof window & {
    __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string; args: Record<string, unknown> }>;
  }).__PRIME_STUDIO_BROWSER_REQUESTS__ ?? []);
  const settingKeys = requests.filter((request) => request.command === "set_app_setting").map((request) => request.args.key);
  expect(settingKeys).toEqual(expect.arrayContaining(["theme", "density", "sendShortcut", "reducedMotion", "defaultCwd"]));
  expect(requests.filter((request) => request.command === "pick_directory")).toHaveLength(1);
  const layoutWrites = requests.filter((request) => request.command === "set_layout_preferences").map((request) => request.args.preferences as Record<string, unknown>);
  expect(layoutWrites).toEqual(expect.arrayContaining([
    expect.objectContaining({ sidebarWidth: 320 }),
    expect.objectContaining({ inspectorWidth: 470 }),
    expect.objectContaining({ editorWidth: 510 }),
    expect.objectContaining({ sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400 }),
  ]));

  await shellPage.keyboard.press("Control+,");
  await shellPage.getByRole("button", { name: /^General/ }).click();
  await expect(shellPage.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  await expect(shellPage.getByRole("combobox", { name: "Density" })).toHaveValue("compact");
  await expect(shellPage.getByRole("combobox", { name: "Send shortcut" })).toHaveValue("ctrl-enter");
  await expect(shellPage.getByRole("switch", { name: "Reduced motion" })).toHaveAttribute("aria-checked", "true");
  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-general-settings-owned-controls");
});

test("registry keeps Ctrl+N K comma B J in parity with visible commands and Settings rows", async ({ shellPage }) => {
  const requestCount = (command: string) => shellPage.evaluate((name) => {
    const requests = (window as typeof window & { __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string }> }).__PRIME_STUDIO_BROWSER_REQUESTS__ ?? [];
    return requests.filter((request) => request.command === name).length;
  }, command);

  const beforeNew = await requestCount("project_catalog_apply");
  const newChat = shellPage.getByRole("button", { name: "New chat" });
  await expect(newChat).toBeDisabled();
  const newChatDisabledReason = await newChat.getAttribute("title");
  expect(newChatDisabledReason).toBeTruthy();
  await shellPage.keyboard.press("Control+N");
  await expect.poll(() => requestCount("project_catalog_apply")).toBe(beforeNew);
  await newChat.click({ force: true });
  await expect.poll(() => requestCount("project_catalog_apply")).toBe(beforeNew);

  await shellPage.keyboard.press("Control+K");
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shellPage.keyboard.press("Escape");
  await shellPage.getByRole("button", { name: "Search" }).click();
  await expect(shellPage.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shellPage.keyboard.press("Escape");

  await shellPage.keyboard.press("Control+,");
  await expect(shellPage.getByRole("main", { name: "Settings" })).toBeVisible();
  await shellPage.getByRole("button", { name: "Back to chat" }).click();
  await shellPage.getByRole("button", { name: "Settings" }).click();
  await shellPage.getByRole("button", { name: /^Keyboard shortcuts/ }).click();
  const application = shellPage.getByRole("heading", { name: "Application" }).locator("..");
  const shortcutRows = application.getByRole("listitem");
  await expect(shortcutRows).toHaveCount(5);
  for (const row of [["New chat", "Ctrl+N"], ["Open command palette", "Ctrl+K"], ["Toggle projects", "Ctrl+B"], ["Toggle Harness", "Ctrl+J"], ["Open settings", "Ctrl+,"]] as const) {
    await expect(application).toContainText(row[0]);
    await expect(application).toContainText(row[1]);
  }
  const newChatShortcut = shortcutRows.filter({ hasText: "New chat" });
  await expect(newChatShortcut).toHaveAttribute("aria-disabled", "true");
  await expect(newChatShortcut).toContainText("Unavailable");
  await expect(newChatShortcut).toContainText(newChatDisabledReason!);
  const composerShortcuts = shellPage.getByRole("heading", { name: "Composer" }).locator("..").getByRole("listitem");
  await expect(composerShortcuts).toHaveCount(2);
  await expect(composerShortcuts.nth(0)).toContainText("Send message");
  await expect(composerShortcuts.nth(1)).toContainText("New line");
  await expect(composerShortcuts.nth(1)).toContainText("Shift+Enter");

  await shellPage.setViewportSize({ width: 520, height: 800 });
  const narrowGeometry = await shellPage.getByRole("main", { name: "Settings" }).evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(narrowGeometry.scrollWidth).toBeLessThanOrEqual(narrowGeometry.width + 1);
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await shellPage.getByRole("button", { name: "Back to chat" }).click();

  const beforeSidebar = await requestCount("set_layout_preferences");
  await shellPage.keyboard.press("Control+B");
  await expect(shellPage.getByRole("toolbar", { name: "Collapsed navigation" })).toBeVisible();
  await expect.poll(() => requestCount("set_layout_preferences")).toBe(beforeSidebar + 1);
  await shellPage.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(shellPage.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect.poll(() => requestCount("set_layout_preferences")).toBe(beforeSidebar + 2);

  const beforeHarness = await requestCount("set_layout_preferences");
  await shellPage.keyboard.press("Control+J");
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toHaveCount(0);
  await expect.poll(() => requestCount("set_layout_preferences")).toBe(beforeHarness + 1);
  await shellPage.getByRole("button", { name: "View" }).click();
  await shellPage.getByRole("menuitem", { name: "Toggle Harness" }).click();
  await expect(shellPage.getByRole("complementary", { name: "Harness" })).toBeVisible();
  await expect.poll(() => requestCount("set_layout_preferences")).toBe(beforeHarness + 2);

  await expectNoSeriousOrCriticalAxeViolations(shellPage, "studio-command-registry-parity");
});

test("wide settings renders every registered destination without horizontal page overflow", async ({ shellPage }) => {
  await shellPage.keyboard.press("Control+,");
  const labels = ["General", "Appearance", "Composer", "Harness", "Usage", "Models", "Accounts", "Tools", "Git", "Environments", "Privacy & security", "Keyboard shortcuts", "About"];
  for (const label of labels) {
    await shellPage.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await expect(shellPage.getByRole("heading", { name: label, level: 1 })).toBeVisible();
  }
  const geometry = await shellPage.getByRole("main", { name: "Settings" }).evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
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
