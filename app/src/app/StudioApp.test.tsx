import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState } from "../domain/projectChats";
import { createStudioStore, initialStudioState, reduceStudio } from "../shared/state/store";
import { AppProviders } from "./AppProviders";
import { StudioApp } from "./StudioApp";

const chat = {
  id: "chat-1",
  projectId: "project-1",
  accountId: "account-1",
  title: "Harness architecture",
} as const;

describe("Studio application state", () => {
  it("keeps the account and project ownership of an open chat immutable", () => {
    const initial = initialStudioState({ chats: [chat] });
    const opened = reduceStudio(initial, { type: "chat/open", chatId: chat.id });
    const changedDefault = reduceStudio(opened, {
      type: "account/default-selected",
      accountId: "account-2",
    });

    expect(changedDefault.chats[chat.id]).toEqual(chat);
    expect(changedDefault.navigation.selectedChatId).toBe(chat.id);
    expect(changedDefault.defaultAccountId).toBe("account-2");
  });

  it("rejects stale async results by request generation", () => {
    const loading = reduceStudio(initialStudioState(), {
      type: "async/started",
      key: "bootstrap",
      generation: 2,
    });
    const stale = reduceStudio(loading, {
      type: "async/resolved",
      key: "bootstrap",
      generation: 1,
      value: "stale",
    });

    expect(stale).toBe(loading);
    expect(stale.async.bootstrap).toEqual({ generation: 2, status: "loading" });
  });

  it("notifies subscribers only when state changes", () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    store.dispatch({ type: "chat/open", chatId: chat.id });
    store.dispatch({ type: "chat/open", chatId: chat.id });
    unsubscribe();

    expect(notifications).toBe(1);
  });

  it("keeps bounded drafts isolated by chat while switching", () => {
    const second = { ...chat, id: "chat-2", title: "Second" };
    let state = initialStudioState({ chats: [chat, second] });
    state = reduceStudio(state, { type: "draft/change", chatId: chat.id, draft: "first draft" });
    state = reduceStudio(state, { type: "draft/change", chatId: second.id, draft: "second draft" });
    state = reduceStudio(state, { type: "attachments/change", chatId: chat.id, attachments: [{ id: "a1", name: "plan.txt", size: 12, mediaType: "text/plain" }] });
    state = reduceStudio(state, { type: "chat/open", chatId: second.id });

    expect(state.drafts).toEqual({ "chat-1": "first draft", "chat-2": "second draft" });
    expect(state.attachments[chat.id]).toHaveLength(1);
    expect(state.navigation.selectedChatId).toBe("chat-2");
  });

  it("adopts a revision-bound native project catalog snapshot", () => {
    const created = transitionProjectChatState(createInitialProjectChatState(), {
      type: "chat.create", projectId: "project:personal", chatId: chat.id, title: chat.title,
    });
    const state = reduceStudio(initialStudioState(), {
      type: "project-catalog/loaded",
      snapshot: { revision: 7, state: created.state },
    });
    expect(state.catalogRevision).toBe(7);
    expect(state.navigation.selectedChatId).toBe(chat.id);
    expect(state.chats[chat.id]?.title).toBe(chat.title);
  });

  it("renders the selected normalized chat through providers", () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(
      <AppProviders store={store}>
        <StudioApp />
      </AppProviders>,
    );

    expect(screen.getByRole("main")).toHaveAccessibleName("Harness architecture");
    expect(screen.getByRole("heading", { name: "Harness architecture" })).toBeVisible();
    for (const name of ["Projects", "Harness", "Open editor", "Open command palette"]) {
      expect(screen.getByRole("button", { name }).querySelector("svg")).not.toBeNull();
    }
  });

  it("projects the durable project catalog into the real sidebar", () => {
    const created = transitionProjectChatState(createInitialProjectChatState(), {
      type: "chat.create",
      projectId: "project:personal",
      chatId: chat.id,
      title: chat.title,
    });
    expect(created.status).toBe("applied");
    const store = createStudioStore(initialStudioState({ projectCatalog: created.state }));

    render(
      <AppProviders store={store}>
        <StudioApp />
      </AppProviders>,
    );

    expect(screen.getByRole("navigation", { name: "Projects and chats" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Harness architecture" })).toBeVisible();
    expect(screen.getByRole("main", { name: "Harness architecture" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("renders routed settings and preserves the selected chat when returning", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    store.dispatch({ type: "route/settings", section: "security" });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    expect(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(store.getSnapshot().navigation.selectedChatId).toBe(chat.id);
    expect(screen.getByRole("main", { name: "Harness architecture" })).toBeVisible();
  });

  it("opens the centralized command palette and routes enabled commands", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await userEvent.type(screen.getByRole("combobox", { name: "Search commands" }), "account usage");
    await userEvent.click(screen.getByRole("option", { name: /Open account usage/ }));
    expect(screen.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  });
});
