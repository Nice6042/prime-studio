import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { NavigationProject } from "./navigationSelectors";
import { ProjectSidebar } from "./ProjectSidebar";

const projects: readonly NavigationProject[] = [{
  id: "project-a",
  name: "Prime Studio",
  expanded: true,
  pinned: true,
  chats: [
    { id: "chat-1", projectId: "project-a", title: "Harness integration", pinned: false, selected: true, unread: false, status: "working", lastActivityMs: 2 },
    { id: "chat-2", projectId: "project-a", title: "Release checks", pinned: false, selected: false, unread: true, status: "idle", lastActivityMs: 1 },
  ],
}];

describe("ProjectSidebar", () => {
  it("exposes project disclosure, current chat, unread and working states", async () => {
    const onSelectChat = vi.fn();
    const onToggleProject = vi.fn();
    render(<ProjectSidebar projects={projects} onSelectChat={onSelectChat} onToggleProject={onToggleProject} onNewChat={() => undefined} onOpenSettings={() => undefined} />);

    expect(screen.getByRole("button", { name: /Prime Studio/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Harness integration.*working/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Release checks.*unread/i })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Release checks.*unread/i }));
    expect(onSelectChat).toHaveBeenCalledWith("chat-2");
    await userEvent.click(screen.getByRole("button", { name: /Prime Studio/i }));
    expect(onToggleProject).toHaveBeenCalledWith("project-a");
  });

  it("focuses bounded search with Ctrl+F and routes global actions", async () => {
    const onSearch = vi.fn();
    const onNewChat = vi.fn();
    const onOpenSettings = vi.fn();
    render(<ProjectSidebar projects={projects} query="" onSearch={onSearch} onSelectChat={() => undefined} onToggleProject={() => undefined} onNewChat={onNewChat} onOpenSettings={onOpenSettings} />);

    await userEvent.keyboard("{Control>}f{/Control}");
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    expect(search).toHaveFocus();
    await userEvent.type(search, "x".repeat(220));
    expect(onSearch).toHaveBeenLastCalledWith("x".repeat(200));
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
