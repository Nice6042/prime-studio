import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { WorkspaceFooter } from "./WorkspaceFooter";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";

const configured: WorkspaceIdentityProjection = {
  status: "configured",
  workspaceId: "D:\\Clients\\Prime Studio",
  name: "Prime Studio",
  detail: "D:\\Clients\\Prime Studio",
  initials: "PS",
};

function ControlledFooter({
  execute,
  identity = configured,
  variant = "expanded",
}: {
  readonly execute: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly identity?: WorkspaceIdentityProjection;
  readonly variant?: "expanded" | "rail";
}) {
  const [open, setOpen] = useState(false);
  const onExecute = async (operation: StudioOperation) => {
    const outcome = await execute(operation);
    if (operation.action === "surface.popover.toggle" && outcome.status === "updated") {
      setOpen(operation.payload.popoverId === `workspace-footer-${variant}`);
    }
    return outcome;
  };
  return <WorkspaceFooter identity={identity} variant={variant} open={open} onExecute={onExecute} />;
}

describe("WorkspaceFooter", () => {
  it("shows the configured identity without a fabricated account or email", () => {
    render(<ControlledFooter execute={async () => ({ status: "updated", revision: 1 })} />);

    expect(screen.getByRole("button", { name: "Prime Studio workspace menu" })).toHaveTextContent("Prime Studio");
    expect(screen.getByRole("button", { name: "Prime Studio workspace menu" })).toHaveTextContent("D:\\Clients\\Prime Studio");
    expect(screen.queryByText("Local workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("local@workspace")).not.toBeInTheDocument();
  });

  it("opens through the dispatcher, focuses the menu, supports arrow keys, and restores focus on Escape", async () => {
    const execute = vi.fn(async (): Promise<StudioOperationOutcome> => ({ status: "updated", revision: 1 }));
    const user = userEvent.setup();
    render(<ControlledFooter execute={execute} />);
    const trigger = screen.getByRole("button", { name: "Prime Studio workspace menu" });

    await user.click(trigger);

    expect(execute).toHaveBeenNthCalledWith(1, { action: "surface.popover.toggle", payload: { popoverId: "workspace-footer-expanded" } });
    expect(screen.getByRole("menu", { name: "Workspace actions" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Switch workspace" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(execute).toHaveBeenLastCalledWith({ action: "surface.popover.toggle", payload: { popoverId: null } });
    expect(screen.queryByRole("menu", { name: "Workspace actions" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(["expanded", "rail"] as const)("preserves native Tab order when the %s menu closes", async (variant) => {
    const user = userEvent.setup();
    render(<><button type="button">Before workspace</button><ControlledFooter variant={variant} execute={async () => ({ status: "updated", revision: 1 })} /><button type="button">After workspace</button></>);
    const trigger = screen.getByRole("button", { name: "Prime Studio workspace menu" });

    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu", { name: "Workspace actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "After workspace" })).toHaveFocus();

    await user.click(trigger);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.queryByRole("menu", { name: "Workspace actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Before workspace" })).toHaveFocus();
  });

  it("routes switch, Settings, and sign-out with the exact configured workspace identity and reports unavailable outcomes", async () => {
    const execute = vi.fn(async (operation: StudioOperation): Promise<StudioOperationOutcome> => (
      operation.action === "workspace.switch" || operation.action === "workspace.sign-out"
        ? { status: "unavailable", reason: `${operation.action} is not configured.` }
        : { status: "updated", revision: 1 }
    ));
    const user = userEvent.setup();
    render(<ControlledFooter execute={execute} />);

    await user.click(screen.getByRole("button", { name: "Prime Studio workspace menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Switch workspace" }));
    expect(execute).toHaveBeenCalledWith({ action: "workspace.switch", payload: { workspaceId: "D:\\Clients\\Prime Studio" } });
    expect(screen.getByRole("status")).toHaveTextContent("workspace.switch is not configured.");

    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(execute).toHaveBeenCalledWith({ action: "workspace.sign-out", payload: { workspaceId: "D:\\Clients\\Prime Studio" } });
    expect(screen.getByRole("status")).toHaveTextContent("workspace.sign-out is not configured.");

    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(execute).toHaveBeenCalledWith({ action: "route.settings.open", payload: {} });
  });

  it("renders a truthful unavailable state and keeps identity-bound actions disabled", async () => {
    render(<ControlledFooter
      identity={{ status: "unavailable", reason: "No default workspace is configured." }}
      execute={async () => ({ status: "updated", revision: 1 })}
    />);
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "Workspace unavailable workspace menu" })).toHaveTextContent("Workspace unavailable");
    await user.click(screen.getByRole("button", { name: "Workspace unavailable workspace menu" }));
    expect(screen.getByRole("menuitem", { name: "Switch workspace" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeDisabled();
    expect(screen.getAllByText("No default workspace is configured.")).toHaveLength(2);
  });

  it("preserves the same workspace menu in the collapsed rail", async () => {
    const user = userEvent.setup();
    render(<ControlledFooter variant="rail" execute={async () => ({ status: "updated", revision: 1 })} />);

    const trigger = screen.getByRole("button", { name: "Prime Studio workspace menu" });
    expect(trigger).toHaveTextContent("PS");
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Workspace actions" })).toBeVisible();
  });
});
