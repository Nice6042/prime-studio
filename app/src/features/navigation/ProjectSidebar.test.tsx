import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: /Harness integration.*working/i })).toHaveAttribute("data-session-status", "working");
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

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "x".repeat(220) } });
    expect(onSearch).toHaveBeenLastCalledWith("x".repeat(200));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("collects a project name and folder before requesting durable creation", async () => {
    const onNewProject = vi.fn();
    render(<ProjectSidebar projects={projects} onSelectChat={() => undefined} onToggleProject={() => undefined}
      onNewChat={() => undefined} onOpenSettings={() => undefined} onNewProject={onNewProject} />);

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "Create project" });
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Studio source" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Folder path" }), { target: { value: "C:\\src\\prime-studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(onNewProject).toHaveBeenCalledWith("Studio source", "C:\\src\\prime-studio");
    expect(dialog).not.toBeInTheDocument();
  });

  it("traps project-dialog focus, makes its background inert, and restores the trigger on Escape", async () => {
    render(<ProjectSidebar projects={projects} onSelectChat={() => undefined} onToggleProject={() => undefined}
      onNewChat={() => undefined} onOpenSettings={() => undefined} onNewProject={() => undefined} />);
    const opener = screen.getByRole("button", { name: "New project" });
    await userEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Create project" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "New chat" }).closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Create project" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
