import type { Locator, Page } from "@playwright/test";

import { expect, expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";
import { activateWithKeyboard, settingsDestinations } from "./support/acceptance-matrix";
import {
  PRODUCT_REFLOW_GEOMETRIES,
  PRODUCT_REFLOW_SCENARIOS,
  validateProductReflowAcceptance,
  type ProductReflowGeometry,
} from "../src/contracts/productReflowAcceptance";
import {
  expectHorizontalContainment,
  expectProductViewport,
  expectSurfaceContained,
  resetProductAtGeometry,
} from "./support/product-reflow";

const STREAMING_REFLOW_FIXTURE = "PRIME_STUDIO_REFLOW_STREAMING_FIXTURE";

const geometry = (id: ProductReflowGeometry["id"]) => {
  const found = PRODUCT_REFLOW_GEOMETRIES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing reflow geometry ${id}.`);
  return found;
};

const wideGeometries = [geometry("desktop-1280"), geometry("desktop-1600")];
const compactGeometries = [geometry("compact-820"), geometry("compact-640"), geometry("zoom-200-equivalent")];
const allGeometries = [...wideGeometries, ...compactGeometries];

async function exerciseStreamingConversation(
  page: Page,
  workspace: Locator,
  target: ProductReflowGeometry,
): Promise<void> {
  const composer = page.getByPlaceholder("Message Prime Studio — try / for commands");
  await page.evaluate(() => {
    const global = window as typeof window & { __PRIME_STUDIO_REFLOW_STREAMING__?: boolean };
    global.__PRIME_STUDIO_REFLOW_STREAMING__ = true;
  });
  await composer.fill(STREAMING_REFLOW_FIXTURE);
  await composer.press("Enter");
  const streamingTurn = workspace.locator('.parent-assistant-turn[aria-busy="true"]').last();
  await expect(streamingTurn).toContainText("Synthetic streaming response retained for deterministic reflow evidence.");
  await expect(streamingTurn.getByRole("status")).toHaveText("Responding");
  await expect(composer).toHaveValue("");
  await expectProductViewport(page, `${target.id} streaming conversation`);
}

async function exerciseInspectorAndEditorScreens(
  page: Page,
  workspace: Locator,
  harness: Locator,
  target: ProductReflowGeometry,
): Promise<void> {
  await expect(harness.getByRole("tab", { name: "Harness" })).toHaveAttribute("aria-selected", "true");
  await expectProductViewport(page, `${target.id} inspector overview`);

  await harness.getByRole("tab", { name: "Usage" }).click();
  await expect(harness.getByText("Current chat", { exact: true })).toBeVisible();
  await expectProductViewport(page, `${target.id} current-chat usage`);

  await harness.getByRole("tab", { name: "Activity" }).click();
  await expect(harness.getByRole("button", { name: /Redacted shell command/ })).toBeVisible();
  await expectProductViewport(page, `${target.id} activity`);

  await harness.getByRole("tab", { name: "Harness" }).click();
  await harness.getByRole("button", { name: "Verify runtime compatibility, running" }).click();
  for (const tab of ["Chat", "Activity", "Files"] as const) {
    await harness.getByRole("tab", { name: tab }).click();
    await expect(harness.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await expectProductViewport(page, `${target.id} child ${tab.toLocaleLowerCase()}`);
  }
  await harness.getByRole("button", { name: "Back to Harness" }).click();

  const outputs = harness.locator("summary").filter({ hasText: /^Outputs/u });
  await outputs.click();
  await harness.getByRole("button", { name: /Harness report/ }).click();
  const editor = page.getByRole("region", { name: "Editor" });
  await expect(editor.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
  await expectProductViewport(page, `${target.id} editor diff`);
  await editor.getByRole("tab", { name: "Edit" }).click();
  await expect(editor.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  await expectProductViewport(page, `${target.id} editor edit`);
  await editor.getByRole("button", { name: "Close editor" }).click();

  await workspace.getByRole("button", { name: "Edit answer in Canvas" }).click();
  const canvasEditor = page.getByRole("region", { name: "Editor" });
  await expect(canvasEditor.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  await expectProductViewport(page, `${target.id} editor canvas`);
  await canvasEditor.getByRole("button", { name: "Close editor" }).click();
}

async function exerciseEmptyConversation(page: Page, target: ProductReflowGeometry): Promise<void> {
  await page.keyboard.press("Control+N");
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Prime Studio" })).toBeVisible();
  await expectProductViewport(page, `${target.id} empty conversation`);
}

test.describe.configure({ timeout: 180_000 });

test("the executable reflow scenarios cover every applicable package-screen and geometry cell", () => {
  expect(validateProductReflowAcceptance()).toEqual({
    valid: true,
    packageScreenCount: 29,
    coveredScreenCount: 29,
    geometryCount: 5,
    evidenceCellCount: 140,
    errors: [],
  });
  expect(PRODUCT_REFLOW_SCENARIOS.map((scenario) => scenario.id)).toEqual([
    "workspace-wide",
    "workspace-compact",
    "settings-all",
    "overlays-all",
  ]);
});

test("workspace, inspector, child, and editor screen families reflow at 1280 and 1600", async ({ shellPage }) => {
  for (const target of wideGeometries) {
    await resetProductAtGeometry(shellPage, target);
    const workspace = shellPage.getByRole("main", { name: "Prime Harness architecture" });
    const sidebar = shellPage.getByRole("navigation", { name: "Projects and chats" });
    const harness = shellPage.getByRole("complementary", { name: "Harness" });

    await expect(sidebar).toHaveAttribute("data-mode", "pane");
    await expect(sidebar.getByRole("button", { name: /Prime Harness architecture.*status: Working/i }).first()).toHaveAttribute("data-session-status", "working");
    await expect(workspace.getByText("The parent conversation stays focused on decisions and final results.", { exact: false })).toBeVisible();
    await expectProductViewport(shellPage, `${target.id} active conversation`);

    await exerciseStreamingConversation(shellPage, workspace, target);
    await exerciseInspectorAndEditorScreens(shellPage, workspace, harness, target);
    await exerciseEmptyConversation(shellPage, target);

    await expectNoSeriousOrCriticalAxeViolations(shellPage, `product-reflow-${target.id}-workspace-wide`);
  }
});

test("workspace, inspector, child, editor, and rail screen families reflow at compact geometries", async ({ shellPage }) => {
  for (const target of compactGeometries) {
    await resetProductAtGeometry(shellPage, target);
    const sidebar = shellPage.getByRole("navigation", { name: "Projects and chats" });
    const workspace = shellPage.getByRole("main", { name: "Prime Harness architecture" });
    await expect(sidebar).toHaveAttribute("data-mode", "rail");
    await expect(workspace.getByText("The parent conversation stays focused on decisions and final results.", { exact: false })).toBeVisible();
    await expectProductViewport(shellPage, `${target.id} active conversation and rail`);

    await exerciseStreamingConversation(shellPage, workspace, target);

    const projectsButton = shellPage.getByRole("button", { name: "Projects" });
    await projectsButton.click();
    const projectSheet = shellPage.locator('[data-studio-sheet="sidebar"]');
    await expectSurfaceContained(projectSheet, shellPage, `${target.id} project sheet`);
    await expectHorizontalContainment(projectSheet, `${target.id} project sheet`);
    await projectsButton.click();
    await expect(projectSheet).toHaveCount(0);

    await shellPage.getByRole("button", { name: "Harness" }).click();
    const harness = shellPage.getByRole("complementary", { name: "Harness" });
    await expectSurfaceContained(harness, shellPage, `${target.id} Harness sheet`);
    await exerciseInspectorAndEditorScreens(shellPage, workspace, harness, target);
    await exerciseEmptyConversation(shellPage, target);

    await expectNoSeriousOrCriticalAxeViolations(shellPage, `product-reflow-${target.id}-workspace-compact`);
  }
});

test("all thirteen Settings destinations reflow at every required geometry", async ({ shellPage }) => {
  for (const target of allGeometries) {
    await resetProductAtGeometry(shellPage, target);
    await shellPage.keyboard.press("Control+,");
    const settings = shellPage.getByRole("main", { name: "Settings" });
    const navigation = settings.getByRole("navigation", { name: "Settings sections" });
    await expectSurfaceContained(settings, shellPage, `${target.id} Settings shell`);

    for (const destination of settingsDestinations) {
      const button = navigation.getByRole("button", { name: new RegExp(`^${destination.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u") });
      await button.scrollIntoViewIfNeeded();
      await activateWithKeyboard(button);
      await expect(settings.getByRole("heading", { name: destination.label, exact: true, level: 1 })).toBeVisible();
      await expect(destination.signature(settings)).toBeVisible();
      await expectHorizontalContainment(settings.locator(".studio-settings-content"), `${target.id} ${destination.id} content`);
      await expectProductViewport(shellPage, `${target.id} settings ${destination.id}`);
    }

    await expectNoSeriousOrCriticalAxeViolations(shellPage, `product-reflow-${target.id}-settings`);
    await settings.getByRole("button", { name: "Back to chat" }).click();
  }
});

test("command palette, menus, dialogs, and toasts reflow at every required geometry", async ({ shellPage }) => {
  for (const target of allGeometries) {
    await resetProductAtGeometry(shellPage, target);

    await shellPage.keyboard.press("Control+K");
    const palette = shellPage.getByRole("dialog", { name: "Command palette" });
    await expectSurfaceContained(palette, shellPage, `${target.id} command palette`);
    await shellPage.keyboard.press("Escape");

    const chatOptions = shellPage.getByRole("button", { name: "Chat options" });
    await chatOptions.click();
    const chatMenu = shellPage.getByRole("menu", { name: "Chat options" });
    await expectSurfaceContained(chatMenu, shellPage, `${target.id} chat menu`);
    await chatMenu.getByRole("menuitem", { name: "Rename" }).click();
    const renameDialog = shellPage.getByRole("dialog", { name: "Rename chat" });
    await expectSurfaceContained(renameDialog, shellPage, `${target.id} rename dialog`);
    await shellPage.keyboard.press("Escape");

    const workspaceMenuTrigger = shellPage.getByRole("button", { name: "Prime Studio workspace menu" });
    await workspaceMenuTrigger.click();
    const workspaceMenu = shellPage.getByRole("menu", { name: "Workspace actions" });
    await expectSurfaceContained(workspaceMenu, shellPage, `${target.id} workspace menu`);
    await workspaceMenu.getByRole("menuitem", { name: "Switch workspace" }).click();
    const toast = shellPage.getByRole("alert", { name: "Studio data operation failed" });
    await expectSurfaceContained(toast, shellPage, `${target.id} failure toast`);
    await shellPage.keyboard.press("Escape");
    await toast.getByRole("button", { name: "Dismiss Studio data operation failed" }).click();
    await expect(toast).toHaveCount(0);

    if (target.width >= 1280) {
      await shellPage.getByRole("button", { name: "File", exact: true }).click();
      const titleMenu = shellPage.getByRole("menu", { name: "File menu" });
      await expectSurfaceContained(titleMenu, shellPage, `${target.id} title menu`);
      await shellPage.keyboard.press("Escape");
    }

    await expectProductViewport(shellPage, `${target.id} overlays closed`);
    await expectNoSeriousOrCriticalAxeViolations(shellPage, `product-reflow-${target.id}-overlays`);
  }
});
