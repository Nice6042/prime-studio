import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState } from "../../domain/projectChats";
import { ArchivedCatalogSettings } from "./ArchivedCatalogSettings";

function archivedCatalog() {
  let state = createInitialProjectChatState();
  for (const command of [
    { type: "project.create", projectId: "project:alpha", name: "Alpha", folderPath: "C:\\src\\alpha" },
    { type: "chat.create", projectId: "project:alpha", chatId: "chat:alpha", title: "Alpha chat" },
    { type: "project.archive", projectId: "project:alpha" },
    { type: "chat.create", projectId: "project:personal", chatId: "chat:old", title: "Old chat" },
    { type: "chat.archive", projectId: "project:personal", chatId: "chat:old" },
  ] as const) {
    state = transitionProjectChatState(state, command).state;
  }
  return state;
}

describe("ArchivedCatalogSettings", () => {
  it("lists durable archived projects and chats and restores the selected record", async () => {
    const onRestoreProject = vi.fn();
    const onRestoreChat = vi.fn();
    render(<ArchivedCatalogSettings catalog={archivedCatalog()} operation={{ phase: "idle" }}
      onRestoreProject={onRestoreProject} onRestoreChat={onRestoreChat} />);

    expect(screen.getByRole("heading", { name: "Archived projects" })).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Archived chats" })).toBeVisible();
    expect(screen.getByText("Old chat")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Restore project Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Restore chat Old chat" }));

    expect(onRestoreProject).toHaveBeenCalledWith("project:alpha");
    expect(onRestoreChat).toHaveBeenCalledWith("project:personal", "chat:old");
  });

  it("invokes the admitted archive-fork handler without restoring the source chat", async () => {
    const onForkChat = vi.fn();
    render(<ArchivedCatalogSettings catalog={archivedCatalog()} operation={{ phase: "idle" }}
      onRestoreProject={vi.fn()} onRestoreChat={vi.fn()} onForkChat={onForkChat} />);

    await userEvent.click(screen.getByRole("button", { name: "Fork archived chat Old chat" }));

    expect(onForkChat).toHaveBeenCalledWith("chat:old");
  });

  it("keeps archive fork visible but disabled when the verified Harness has no atomic archive-fork authority", () => {
    render(<ArchivedCatalogSettings catalog={archivedCatalog()} operation={{ phase: "idle" }}
      onRestoreProject={vi.fn()} onRestoreChat={vi.fn()}
      archiveForkReason="The verified Harness exposes fork and new-session independently, but no atomic archive-and-fork command." />);

    const fork = screen.getByRole("button", { name: "Fork archived chat Old chat" });
    expect(fork).toBeDisabled();
    expect(fork).toHaveAttribute("data-studio-action", "conversation.archive-fork");
    expect(fork.title).toMatch(/no atomic archive-and-fork command/i);
  });
});
