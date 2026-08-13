import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { CollapsedSidebar } from "./CollapsedSidebar";

const workspace = { status: "configured" as const, workspaceId: "D:\\work", name: "work", detail: "D:\\work", initials: "WO" };

function setup(outcome: StudioOperationOutcome = { status: "updated", revision: 1 }, newChatDisabledReason?: string) {
  const operations: StudioOperation[] = [];
  const execute = vi.fn(async (operation: StudioOperation) => { operations.push(operation); return outcome; });
  render(<CollapsedSidebar
    selectedProjectId="project:personal"
    newChatDisabledReason={newChatDisabledReason}
    workspace={workspace}
    workspaceMenuOpen={false}
    onExecute={execute}
  />);
  return { execute, operations };
}

describe("CollapsedSidebar", () => {
  it("routes every primary rail action through the closed owner-aware executor", async () => {
    const { operations } = setup();
    for (const name of ["Expand sidebar", "New chat", "Search", "Settings"]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    expect(operations).toEqual([
      { action: "layout.sidebar.toggle", payload: {} },
      { action: "catalog.chat.create", payload: { projectId: "project:personal" } },
      { action: "palette.open", payload: {} },
      { action: "route.settings.open", payload: {} },
    ]);
    expect(screen.getByRole("button", { name: "work workspace menu" })).toHaveTextContent("WO");
  });

  it("exposes the exact five-action rail once, with authored accessible tooltips", () => {
    setup();
    const toolbar = screen.getByRole("toolbar", { name: "Collapsed navigation" });
    const actions = within(toolbar).getAllByRole("button");
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Expand sidebar", "New chat", "Search", "Settings", "work workspace menu",
    ]);
    expect(actions.map((button) => button.getAttribute("data-control-id"))).toEqual([
      "rail-expand", "rail-new-chat", "rail-search", "rail-settings", "rail-workspace-menu",
    ]);
    for (const button of actions) {
      expect(button).toHaveAccessibleDescription();
      const tooltipId = button.getAttribute("aria-describedby");
      expect(tooltipId).toBeTruthy();
      expect(document.getElementById(tooltipId!)).toHaveAttribute("role", "tooltip");
    }
  });

  it("uses one roving Tab stop and Arrow/Home/End order across all rail actions", async () => {
    setup();
    const actions = screen.getAllByRole("button");
    expect(actions.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    actions[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(actions[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(actions[4]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(actions[3]).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(actions[0]).toHaveFocus();
    expect(actions.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it("keeps unavailable New chat focusable and explains why without dispatching", async () => {
    const { execute } = setup({ status: "updated", revision: 1 }, "Choose a default account first.");
    const button = screen.getByRole("button", { name: "New chat" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("New chat unavailable: Choose a default account first.");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(execute).not.toHaveBeenCalled();
  });
});
