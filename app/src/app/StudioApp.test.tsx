import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("renders the selected normalized chat through providers", () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(
      <AppProviders store={store}>
        <StudioApp />
      </AppProviders>,
    );

    expect(screen.getByRole("main")).toHaveAccessibleName("Harness architecture");
    expect(screen.getByText("Harness architecture")).toBeVisible();
  });
});
