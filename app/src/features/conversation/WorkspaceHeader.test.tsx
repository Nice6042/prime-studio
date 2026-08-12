import { render, screen } from "@testing-library/react";
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
  onArchive: () => undefined,
  onDelete: () => undefined,
  onOpenInspector: () => undefined,
};

describe("WorkspaceHeader", () => {
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
});
