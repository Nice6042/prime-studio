import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState } from "../domain/projectChats";
import { createStudioStore, initialStudioState, reduceStudio } from "../shared/state/store";
import { AppProviders } from "./AppProviders";
import { StudioApp } from "./StudioApp";
import type { RootSessionProjection } from "../entities/harness/types";
import type { StudioOperation } from "../contracts/studioOperations";
import type { HarnessInspectorAdapter } from "../features/harness/adapter";
import * as rpc from "../rpc";

const chat = {
  id: "chat-1",
  projectId: "project-1",
  accountId: "account-1",
  title: "Harness architecture",
} as const;

const rootSession: RootSessionProjection = {
  sessionId: "session-1", accountId: "account-1", projectId: "project-1", chatId: "chat-1",
  cursor: { runtimeGeneration: "g1", sequence: 2 }, state: "idle", freshness: "live",
  parentMessages: [
    { channel: "parent", kind: "user", id: "u1", text: "Original prompt", emittedAtMs: 1 },
    { channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "Original answer" }], streaming: false, emittedAtMs: 2 },
  ],
  children: [], queue: [], tools: [], resources: [],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: null },
};

function conversationAdapter(operations: StudioOperation[]): HarnessInspectorAdapter {
  return {
    availability: { status: "available" },
    composer: {
      models: [{ id: "verified-model", label: "Verified model", enabled: true }],
      selectedModel: "verified-model",
      thinkingLevels: ["low", "high"],
      selectedThinking: "low",
      supportedCommands: ["model", "effort", "compact", "fork", "export"],
    },
    load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {} }),
    execute: async (operation) => {
      operations.push(operation);
      return { status: "accepted", commandId: `command-${operations.length}` };
    },
  };
}

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

  it("keeps immutable display versions isolated by chat", () => {
    const second = { ...chat, id: "chat-2", title: "Second" };
    let state = initialStudioState({ chats: [chat, second] });
    state = reduceStudio(state, { type: "conversation/version-appended", chatId: chat.id, messageId: "u1", kind: "user", text: "Original" });
    const original = state;
    state = reduceStudio(state, { type: "conversation/version-appended", chatId: chat.id, messageId: "u1", kind: "user", text: "Edited" });
    state = reduceStudio(state, { type: "conversation/version-appended", chatId: second.id, messageId: "u1", kind: "user", text: "Other chat" });
    state = reduceStudio(state, { type: "conversation/version-selected", chatId: chat.id, messageId: "u1", kind: "user", version: 0 });

    expect(original.conversationDisplay[chat.id]?.messages.u1?.versions).toEqual([{ text: "Original" }]);
    expect(state.conversationDisplay[chat.id]?.messages.u1).toMatchObject({ selected: 0, versions: [{ text: "Original" }, { text: "Edited" }] });
    expect(state.conversationDisplay[second.id]?.messages.u1?.versions).toEqual([{ text: "Other chat" }]);
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
    expect(screen.getByRole("button", { name: "Switch chat" })).toHaveTextContent("Harness architecture");
    for (const name of ["Projects", "Harness", "Open editor", "Open command palette"]) {
      expect(screen.getByRole("button", { name }).querySelector("svg")).not.toBeNull();
    }
  });

  it("projects verified composer identity into the current-chat runtime status", () => {
    const store = createStudioStore(initialStudioState({
      chats: [chat],
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);

    expect(screen.getByText(/account-1 · verified-model · thinking low/)).toBeVisible();
  });

  it("moves focus into the narrow Harness drawer and restores its opener on Escape", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    const opener = screen.getByRole("button", { name: "Harness" });
    await userEvent.click(opener);
    const drawer = screen.getByRole("complementary", { name: "Harness" });
    await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement | null));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Harness" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    fireEvent(window, new Event("resize"));
  });

  it("opens the full project sheet from the persistent narrow navigation rail", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    expect(screen.getByRole("navigation", { name: "Projects and chats" })).toHaveAttribute("data-mode", "rail");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await waitFor(() => expect(document.querySelector("[data-studio-sheet='sidebar']")).not.toBeNull());

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    fireEvent(window, new Event("resize"));
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
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });

  it("renders routed settings and preserves the selected chat when returning", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    store.dispatch({ type: "route/settings", section: "privacy" });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    expect(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Privacy & security", level: 1 })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(store.getSnapshot().navigation.selectedChatId).toBe(chat.id);
    expect(screen.getByRole("main", { name: "Harness architecture" })).toBeVisible();
  });

  it("applies persisted workspace preferences before the settings route is opened", async () => {
    const settingsSpy = vi.spyOn(rpc, "getAppSettings").mockResolvedValue({
      theme: "light",
      density: "compact",
      reducedMotion: "enabled",
      promptSuggestions: "disabled",
      tokenEstimate: "disabled",
    });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));
    expect(document.documentElement).toHaveAttribute("data-density", "compact");
    expect(document.documentElement).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.queryByRole("button", { name: "Explore this codebase" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Approximate draft tokens")).not.toBeInTheDocument();
    settingsSpy.mockRestore();
  });

  it("routes Harness-owned settings through the verified adapter before persistence", async () => {
    const operations: StudioOperation[] = [];
    const store = createStudioStore(initialStudioState({
      chats: [chat],
      compatibility: { status: "ready", profile: "verified", capabilities: ["attach_snapshot", "event_sequence"] },
    }));
    store.dispatch({ type: "route/settings", section: "harness" });
    const adapter = { ...conversationAdapter(operations), settings: { harnessPolicy: true, toolPolicy: true } };
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum concurrent agents" }), { target: { value: "8" } });

    await waitFor(() => expect(operations).toContainEqual({
      action: "settings.harness-policy.set",
      payload: { key: "maxConcurrentAgents", value: "8" },
    }));
  });

  it("does not treat general inspector availability as verified settings authority", () => {
    const store = createStudioStore(initialStudioState({
      chats: [chat],
      compatibility: { status: "ready", profile: "verified", capabilities: ["attach_snapshot", "event_sequence"] },
    }));
    store.dispatch({ type: "route/settings", section: "harness" });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);

    expect(screen.getByRole("spinbutton", { name: "Maximum concurrent agents" })).toBeDisabled();
    expect(screen.getByText(/verified settings adapter/i)).toBeVisible();
  });

  it("wires Settings usage export to the native user-selected save boundary", async () => {
    const exportSpy = vi.spyOn(rpc, "exportAccountUsageCsv").mockResolvedValue({ status: "cancelled" });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "route/settings", section: "usage" });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(expect.stringMatching(/^timestamp,provider/), 7));
    expect(await screen.findByRole("status")).toHaveTextContent("Export cancelled");
    exportSpy.mockRestore();
  });

  it("keeps the editor explicitly unsupported when no identity-bound artifact ref exists", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(screen.getByRole("button", { name: "Open editor" }));
    expect(screen.getByText(/No identity-bound native or Harness artifact reference/i)).toBeVisible();
  });

  it("opens the centralized command palette and routes enabled commands", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await userEvent.type(screen.getByRole("combobox", { name: "Search commands, chats, and messages" }), "account usage");
    await userEvent.click(screen.getByRole("option", { name: /Open account usage/ }));
    expect(screen.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  });

  it("does not dispatch global shortcuts through the topmost title menu", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(screen.getByRole("button", { name: "File" }));

    await userEvent.keyboard("{Control>},{/Control}");

    expect(screen.getByRole("menu", { name: "File menu" })).toBeVisible();
    expect(store.getSnapshot().navigation.route).toBe("workspace");
  });

  it("routes immutable edits, branches, regeneration, and Harness slash commands through the verified adapter", async () => {
    const operations: StudioOperation[] = [];
    const store = createStudioStore(initialStudioState({
      chats: [chat],
      sessions: [rootSession],
      compatibility: {
        status: "ready", profile: "verified",
        capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
      },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter(operations)} /></AppProviders>);

    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edit message text" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Edited prompt");
    await userEvent.click(screen.getByRole("button", { name: "Send edited message" }));
    await waitFor(() => expect(operations).toContainEqual({
      action: "conversation.user-version.create",
      payload: { chatId: "chat-1", messageId: "u1", text: "Edited prompt" },
    }));
    expect(store.getSnapshot().conversationDisplay[chat.id]?.messages.u1?.versions).toEqual([{ text: "Original prompt" }, { text: "Edited prompt" }]);

    await userEvent.click(screen.getByRole("button", { name: "Branch chat from message" }));
    await userEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    await userEvent.click(screen.getByRole("button", { name: "Use Verified model" }));
    await userEvent.click(screen.getByRole("button", { name: "Thinking low" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(operations).toEqual(expect.arrayContaining([
      { action: "conversation.branch.create", payload: { sessionId: "session-1", messageId: "u1" } },
      { action: "conversation.response.regenerate", payload: { sessionId: "session-1", messageId: "a1" } },
      { action: "composer.model.select", payload: { chatId: "chat-1", modelId: "verified-model" } },
      { action: "composer.thinking.select", payload: { chatId: "chat-1", level: "high" } },
    ]));

    act(() => store.dispatch({ type: "draft/change", chatId: chat.id, draft: "/compact" }));
    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await waitFor(() => expect(composer).toHaveValue("/compact"));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(operations).toContainEqual({ action: "harness.session.compact", payload: { sessionId: "session-1" } }));
  }, 20_000);

  it("keeps renderer-owned Harness navigation out of the Harness adapter", async () => {
    const operations: StudioOperation[] = [];
    const store = createStudioStore(initialStudioState({
      chats: [chat],
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["attach_snapshot", "event_sequence"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter(operations)} /></AppProviders>);

    await userEvent.click(await screen.findByRole("tab", { name: "Usage" }));

    expect(screen.getByText("Current chat")).toBeVisible();
    expect(operations).not.toContainEqual(expect.objectContaining({ action: "harness.tab.select" }));
  });

  it("shows an explicit product-level failure when a rendered operation is unavailable", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Undo" }));

    expect(await screen.findByRole("alert", { name: "Studio operation failed" })).toHaveTextContent(/Undo|execCommand/i);
  });
});
