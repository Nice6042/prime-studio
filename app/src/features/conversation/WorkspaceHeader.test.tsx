import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "./WorkspaceHeader";

const shared = {
  projectName: "Personal",
  chat: { id: "chat-1", title: "Catalog parity", pinned: false },
  chats: [{ id: "chat-1", title: "Catalog parity" }],
  operation: { phase: "idle" } as const,
  onSelectChat: () => undefined,
  onSetPinned: () => undefined,
  onRename: () => undefined,
  onDuplicate: () => undefined,
  onMove: () => undefined,
  onArchive: () => undefined,
  onDelete: () => undefined,
  onOpenInspector: () => undefined,
};

describe("WorkspaceHeader", () => {
  it("keeps pinning available from the compact-safe chat menu", async () => {
    const onSetPinned = vi.fn();
    render(<WorkspaceHeader {...shared} onSetPinned={onSetPinned} />);

    await userEvent.click(screen.getByRole("button", { name: "Chat options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin chat" }));

    expect(onSetPinned).toHaveBeenCalledWith(true);
  });

  it("switches between independent chat popovers and closes them before another header action", async () => {
    const onSetPinned = vi.fn();
    render(<WorkspaceHeader {...shared} onSetPinned={onSetPinned} />);
    const switcher = screen.getByRole("button", { name: "Switch chat" });
    const options = screen.getByRole("button", { name: "Chat options" });
    const pin = screen.getByRole("button", { name: "Pin chat" });

    await userEvent.click(switcher);
    expect(screen.getByRole("menu", { name: "Chats" })).toBeVisible();
    await userEvent.click(options);
    expect(screen.queryByRole("menu", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Chat options" })).toBeVisible();
    expect(options).toHaveFocus();

    await userEvent.click(pin);
    expect(screen.queryByRole("menu", { name: "Chat options" })).not.toBeInTheDocument();
    expect(pin).toHaveFocus();
    expect(onSetPinned).toHaveBeenCalledWith(true);
  });

  it("requires an explicit destination before moving a chat", async () => {
    const onMove = vi.fn();
    render(<WorkspaceHeader {...shared} moveTargets={[
      { id: "project-alpha", name: "Alpha" },
      { id: "project-beta", name: "Beta" },
    ]} onMove={onMove} />);

    await userEvent.click(screen.getByRole("button", { name: "Chat options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to project" }));
    const move = screen.getByRole("dialog", { name: "Move chat" });
    expect(screen.getByRole("button", { name: "Move chat" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Destination project" }), "project-beta");
    await userEvent.click(screen.getByRole("button", { name: "Move chat" }));

    expect(onMove).toHaveBeenCalledWith("project-beta");
    expect(move).not.toBeInTheDocument();
  });

  it("closes only the topmost chat surface on Escape and restores its opener", async () => {
    render(<WorkspaceHeader {...shared} moveTargets={[{ id: "project-alpha", name: "Alpha" }]} onMove={() => undefined} />);
    const options = screen.getByRole("button", { name: "Chat options" });
    await userEvent.click(options);
    expect(screen.getByRole("menu", { name: "Chat options" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Chat options" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();

    await userEvent.click(options);
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to project" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Destination project" })).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Move chat" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();
  });
});
