import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CollapsedSidebar } from "./CollapsedSidebar";

describe("CollapsedSidebar", () => {
  it("preserves every primary navigation route in the 52px rail", async () => {
    const onExpand = vi.fn();
    const onNewChat = vi.fn();
    const onOpenSearch = vi.fn();
    const onOpenSettings = vi.fn();
    render(<CollapsedSidebar onExpand={onExpand} onNewChat={onNewChat} onOpenSearch={onOpenSearch} onOpenSettings={onOpenSettings} workspaceInitials="LW" />);
    for (const name of ["Expand sidebar", "New chat", "Search", "Settings"]) await userEvent.click(screen.getByRole("button", { name }));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getByTitle("Local workspace")).toHaveTextContent("LW");
  });
});
