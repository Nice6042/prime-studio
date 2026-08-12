import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState, type ProjectChatCommand, type ProjectChatState } from "../domain/projectChats";
import { createStudioStore, initialStudioState } from "../shared/state/store";
import { AppProviders } from "./AppProviders";

const applyCatalog = vi.hoisted(() => vi.fn());
const loadCatalog = vi.hoisted(() => vi.fn(() => new Promise(() => undefined)));
vi.mock("../features/navigation/projectCatalogClient", async (original) => ({
  ...await original<typeof import("../features/navigation/projectCatalogClient")>(),
  applyProjectCatalogCommand: applyCatalog,
  loadProjectCatalog: loadCatalog,
}));

import { StudioApp } from "./StudioApp";

function catalog(...commands: readonly ProjectChatCommand[]): ProjectChatState {
  return commands.reduce((state, command) => transitionProjectChatState(state, command).state, createInitialProjectChatState());
}

function renderCatalog(initial: ProjectChatState) {
  applyCatalog.mockImplementation(async (revision: number, command: ProjectChatCommand) => ({
    revision: revision + 1,
    state: transitionProjectChatState(initial, command).state,
  }));
  const store = createStudioStore(initialStudioState({ projectCatalog: initial }));
  render(<AppProviders store={store}><StudioApp /></AppProviders>);
  return store;
}

describe("Studio durable catalog workflows", () => {
  beforeEach(() => applyCatalog.mockReset());

  it("creates a catalog project from the sidebar without creating a Harness session", async () => {
    renderCatalog(createInitialProjectChatState());
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Prime source" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Folder path" }), { target: { value: "C:\\src\\prime" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(applyCatalog).toHaveBeenCalledWith(0, expect.objectContaining({
      type: "project.create", name: "Prime source", folderPath: "C:\\src\\prime",
    })));
  });

  it("moves the active chat to the chosen durable project", async () => {
    const initial = catalog(
      { type: "chat.create", projectId: "project:personal", chatId: "chat:one", title: "One" },
      { type: "project.create", projectId: "project:beta", name: "Beta", folderPath: "C:\\src\\beta" },
      { type: "selection.select-chat", projectId: "project:personal", chatId: "chat:one" },
    );
    renderCatalog(initial);
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to project" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Destination project" }), { target: { value: "project:beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Move chat" }));

    await waitFor(() => expect(applyCatalog).toHaveBeenCalledWith(0, {
      type: "chat.move", projectId: "project:personal", chatId: "chat:one", targetProjectId: "project:beta",
    }));
  });

  it("opens the archived route from the palette and restores its real catalog chat", async () => {
    const initial = catalog(
      { type: "chat.create", projectId: "project:personal", chatId: "chat:current", title: "Current" },
      { type: "chat.create", projectId: "project:personal", chatId: "chat:old", title: "Old chat" },
      { type: "chat.archive", projectId: "project:personal", chatId: "chat:old" },
    );
    renderCatalog(initial);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands, chats, and messages" }), { target: { value: "archived chats" } });
    fireEvent.click(screen.getByRole("option", { name: /Archived chats/ }));
    expect(screen.getByRole("heading", { name: "Archived chats", level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore chat Old chat" }));

    await waitFor(() => expect(applyCatalog).toHaveBeenCalledWith(0, {
      type: "chat.restore", projectId: "project:personal", chatId: "chat:old",
    }));
  });
});
