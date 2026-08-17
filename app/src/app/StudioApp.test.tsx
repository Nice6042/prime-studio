import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState } from "../domain/projectChats";
import { createStudioStore, initialStudioState, reduceStudio } from "../shared/state/store";
import { AppProviders } from "./AppProviders";
import { StudioApp } from "./StudioApp";
import type { RootSessionProjection } from "../entities/harness/types";
import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import * as operationDispatcher from "../contracts/dispatcher/studioOperationDispatcher";
import type { HarnessInspectorAdapter } from "../features/harness/adapter";
import * as rpc from "../rpc";
import * as projectCatalogClient from "../features/navigation/projectCatalogClient";
import * as chatDisplayClient from "../features/editor/chatDisplayClient";

const nativeDocs = vi.hoisted(() => ({ getVersion: vi.fn(async () => "0.1.0") }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: nativeDocs.getVersion }));

const chat = {
  id: "chat-1",
  projectId: "project-1",
  accountId: "account-1",
  title: "Harness architecture",
} as const;

const rootSession: RootSessionProjection = {
  sessionId: "session-1", accountId: "account-1", provider: "openai-codex", projectId: "daemon-project-1", chatId: "daemon-chat-1",
  cursor: { runtimeGeneration: "g1", sequence: 2 }, state: "idle", freshness: "live",
  parentMessages: [
    { channel: "parent", kind: "user", id: "u1", text: "Original prompt", emittedAtMs: 1 },
    { channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "Original answer" }], streaming: false, emittedAtMs: 2 },
  ],
  children: [], queue: [], tools: [], resources: [],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId: "session-1", cursor: { runtimeGeneration: "g1", sequence: 2 }, reason: "event_chronology_unavailable" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function mockAvailableLayoutPersistence() {
  vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValue({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: ["project:personal"] });
  vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async (next) => next);
}

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
    load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {} }),
    execute: async (operation) => {
      operations.push(operation);
      return { status: "accepted", commandId: `command-${operations.length}` };
    },
  };
}

function catalogBoundToRootSession() {
  const created = transitionProjectChatState(createInitialProjectChatState(), {
    type: "chat.create", projectId: "project:personal", chatId: chat.id, title: chat.title,
  });
  if (created.status !== "applied") throw new Error("test catalog create failed");
  const bound = transitionProjectChatState(created.state, {
    type: "chat.bind-prime-session", projectId: "project:personal", chatId: chat.id,
    binding: { kind: "prime-session", accountId: rootSession.accountId, sessionId: rootSession.sessionId, sessionFile: `${rootSession.chatId}.jsonl`, agentId: rootSession.chatId },
  });
  if (bound.status !== "applied") throw new Error("test catalog bind failed");
  return bound.state;
}

afterEach(() => {
  localStorage.clear();
});

describe("Studio application state", () => {
  it("opens packaged license notices through the native document owner", async () => {
    const openPackagedLicenseNotices = vi.spyOn(rpc, "openPackagedLicenseNotices").mockResolvedValueOnce(undefined);
    const runtime = {
      packageName: "prime-agent" as const,
      packageVersion: "0.7.1",
      packageDigest: `sha256:${"a".repeat(64)}`,
      entrypointDigest: `sha256:${"b".repeat(64)}`,
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "protocol-7-schema-13-816309b1cd50",
      capabilities: ["attach_snapshot", "event_sequence"] as const,
    };
    const store = createStudioStore(initialStudioState({
      compatibility: { status: "ready", profile: "verified", capabilities: runtime.capabilities },
      runtime,
    }));
    store.dispatch({ type: "route/settings", section: "about" });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(await screen.findByRole("button", { name: "Open license notices" }));

    await waitFor(() => expect(openPackagedLicenseNotices).toHaveBeenCalledOnce());
    expect(openPackagedLicenseNotices).toHaveBeenCalledWith();
    openPackagedLicenseNotices.mockRestore();
  });

  it("reports remote documentation denial instead of claiming native success", async () => {
    const openExternalStrict = vi.spyOn(rpc, "openExternalStrict").mockRejectedValueOnce(new Error("native navigation denied"));
    const store = createStudioStore(initialStudioState());

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Support" }));

    expect(await screen.findByRole("alert", { name: "System operation failed" })).toHaveTextContent("native navigation denied");
    expect(openExternalStrict).toHaveBeenCalledWith("https://github.com/Nice6042/prime-studio/blob/main/SUPPORT.md");
    openExternalStrict.mockRestore();
  });

  it("projects daemon messages under the separately bound Studio chat identity", () => {
    const state = initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] });
    expect(state.navigation.selectedChatId).toBe("chat-1");
    expect(state.sessions["session-1"]?.chatId).toBe("daemon-chat-1");
    expect(state.projectCatalog.projects[0]?.id).toBe("project:personal");
    expect(state.conversationDisplay["chat-1"]?.messages.u1?.versions).toEqual([{ text: "Original prompt" }]);
  });

  it("admits a newly created daemon projection only after its catalog binding exists", () => {
    const boundCatalog = catalogBoundToRootSession();
    const empty = initialStudioState({ projectCatalog: boundCatalog });
    const admitted = reduceStudio(empty, { type: "harness/session-projected", session: rootSession });
    expect(admitted.sessions[rootSession.sessionId]).toEqual(rootSession);
    expect(admitted.conversationDisplay[chat.id]?.messages.u1?.versions).toEqual([{ text: "Original prompt" }]);

    const rejected = reduceStudio(initialStudioState(), { type: "harness/session-projected", session: rootSession });
    expect(rejected.sessions[rootSession.sessionId]).toBeUndefined();
  });

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

  it("admits bounded immutable history pages only for the exact bound session snapshot", () => {
    const initial = initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] });
    const loading = reduceStudio(initial, {
      type: "conversation/history-requested", chatId: chat.id, sessionId: rootSession.sessionId,
      expectedCursor: rootSession.cursor, before: null,
    });
    expect(loading.conversationHistory[chat.id]?.status).toBe("loading");

    const wrongRequest = reduceStudio(loading, {
      type: "conversation/history-page-loaded", chatId: chat.id, before: "different-window",
      page: {
        sessionId: rootSession.sessionId, snapshotCursor: rootSession.cursor,
        messages: [{ channel: "parent", kind: "user", id: "older-1", text: "Earlier", emittedAtMs: 0 }],
        totalMessages: 3, omittedBefore: 0, omittedAfter: 2, olderCursor: null, truncatedByBytes: false,
      },
    } as never);
    expect(wrongRequest).toBe(loading);

    const loaded = reduceStudio(loading, {
      type: "conversation/history-page-loaded", chatId: chat.id, before: null,
      page: {
        sessionId: rootSession.sessionId, snapshotCursor: rootSession.cursor,
        messages: [{ channel: "parent", kind: "user", id: "older-1", text: "Earlier", emittedAtMs: 0 }],
        totalMessages: 3, omittedBefore: 0, omittedAfter: 2, olderCursor: null, truncatedByBytes: false,
      },
    });
    expect(loaded.conversationHistory[chat.id]).toMatchObject({ status: "available", totalMessages: 3, omittedBefore: 0 });
    expect(loaded.conversationHistory[chat.id]?.messages.map((message) => message.id)).toEqual(["older-1"]);
    expect(Object.isFrozen(loaded.conversationHistory[chat.id]?.messages)).toBe(true);

    const stale = reduceStudio(loading, {
      type: "conversation/history-page-loaded", chatId: chat.id, before: null,
      page: { ...loaded.conversationHistory[chat.id]!, snapshotCursor: { ...rootSession.cursor, sequence: 1 }, status: undefined, reason: undefined, requestedBefore: undefined },
    } as never);
    expect(stale).toBe(loading);

    const advanced = reduceStudio(loaded, {
      type: "harness/session-projected", session: { ...rootSession, cursor: { ...rootSession.cursor, sequence: 3 } },
    });
    expect(advanced.conversationHistory[chat.id]).toBeUndefined();
  });

  it("prepends opaque pages in exact chronology and stops at the 300-row renderer bound", () => {
    let state = initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] });
    const pageRows = (from: number) => Array.from({ length: 100 }, (_, offset) => ({
      channel: "parent" as const, kind: "user" as const, id: `older-${from + offset}`, text: `Earlier ${from + offset}`, emittedAtMs: from + offset,
    }));
    const pages = [
      { messages: pageRows(200), omittedBefore: 200, omittedAfter: 2, olderCursor: "cursor-2" },
      { messages: pageRows(100), omittedBefore: 100, omittedAfter: 102, olderCursor: "cursor-1" },
      { messages: pageRows(0), omittedBefore: 0, omittedAfter: 202, olderCursor: null },
    ] as const;
    let before: string | null = null;
    for (const page of pages) {
      state = reduceStudio(state, { type: "conversation/history-requested", chatId: chat.id, sessionId: rootSession.sessionId, expectedCursor: rootSession.cursor, before });
      state = reduceStudio(state, { type: "conversation/history-page-loaded", chatId: chat.id, before, page: {
        sessionId: rootSession.sessionId, snapshotCursor: rootSession.cursor, totalMessages: 302,
        truncatedByBytes: false, ...page,
      } });
      before = page.olderCursor;
    }
    expect(state.conversationHistory[chat.id]?.messages).toHaveLength(300);
    expect(state.conversationHistory[chat.id]?.messages[0]?.id).toBe("older-0");
    expect(state.conversationHistory[chat.id]?.messages[299]?.id).toBe("older-299");
    const bounded = reduceStudio(state, { type: "conversation/history-requested", chatId: chat.id, sessionId: rootSession.sessionId, expectedCursor: rootSession.cursor, before: null });
    expect(bounded).toBe(state);
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

  it("adopts only monotonic durable attention snapshots and fails closed when native evidence is unavailable", () => {
    let state = reduceStudio(initialStudioState(), {
      type: "attention/loaded",
      snapshot: { revision: 7, records: [{ chatId: "chat-1", chatSeen: { runtimeGeneration: "g1", marker: "answer-2", occurredAtMs: 2 }, activitySeen: null }] },
    });
    expect(state.attention).toMatchObject({ status: "available", revision: 7 });
    const stale = reduceStudio(state, { type: "attention/loaded", snapshot: { revision: 6, records: [] } });
    expect(stale).toBe(state);
    state = reduceStudio(state, { type: "attention/unavailable", reason: "native ledger denied" });
    expect(state.attention).toEqual({ status: "unavailable", reason: "native ledger denied" });
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

  it("does not project an unbound adapter-wide composer default into current-chat runtime status", () => {
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(),
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);

    const status = screen.getByRole("status", { name: /Runtime status/ });
    expect(status).toHaveTextContent(/openai-codex · model unavailable · thinking unavailable/);
    expect(status).not.toHaveTextContent("verified-model");
  });

  it("mounts load-older through the exact native paging authority and never reports a rejected call as success", async () => {
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["attach_snapshot", "event_sequence"] },
    }));
    const page = vi.spyOn(rpc, "pageHarnessConversationHistory").mockResolvedValueOnce({
      sessionId: rootSession.sessionId, snapshotCursor: rootSession.cursor,
      messages: [{ channel: "parent", kind: "user", id: "older-1", text: "Earlier production turn", emittedAtMs: 0 }],
      totalMessages: 3, omittedBefore: 0, omittedAfter: 2, olderCursor: null, truncatedByBytes: false,
    }).mockRejectedValueOnce(new Error("history_unavailable"));
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);

    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(page).toHaveBeenCalledWith(rootSession.sessionId, rootSession.cursor, null));
    expect(await screen.findByText("Earlier production turn")).toBeVisible();
    expect(screen.getByText("Beginning of conversation · 3 messages")).toBeVisible();

    store.dispatch({ type: "harness/session-projected", session: { ...rootSession, cursor: { ...rootSession.cursor, sequence: 3 } } });
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText(/could not prove an atomic older-history page/i)).toBeVisible();
    expect(store.getSnapshot().conversationHistory[chat.id]?.status).toBe("unavailable");
    page.mockRestore();
  }, 30_000);

  it("hydrates composer choices from the selected admitted session", async () => {
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(),
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    const loadComposer = vi.fn(async () => ({
      models: [{ id: "openai/gpt-live", label: "GPT Live", enabled: true }],
      selectedModel: "openai/gpt-live",
      thinkingLevels: ["low", "high"] as const,
      selectedThinking: "high" as const,
      supportedCommands: ["model", "effort", "compact", "fork", "export"] as const,
    }));
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      loadComposer,
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: { usedTokens: 10_000, capacityTokens: 40_000 }, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [{ id: "overload-1", kind: "warning", title: "Busy", detail: "server_is_overloaded", retryable: true, dismissible: true }], activity: [], outputs: [], sources: [], children: {} }),
      execute: async () => ({ status: "accepted", commandId: "command-1" }),
    };

    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    expect(await screen.findByRole("button", { name: "Use GPT Live" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Thinking high" })).toBeVisible();
    expect(loadComposer).toHaveBeenCalledWith(rootSession.sessionId);
    const runtimeStatus = await screen.findByRole("status", { name: /Runtime status:.*openai\/gpt-live.*ctx 25%.*server_is_overloaded/i });
    expect(runtimeStatus).toHaveTextContent("10k / 40k");
  }, 15_000);

  it("never leaks an earlier cursor's deferred composer result into runtime status", async () => {
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    type ComposerProjection = Awaited<ReturnType<NonNullable<HarnessInspectorAdapter["loadComposer"]>>>;
    const resolvers: ((projection: ComposerProjection) => void)[] = [];
    const loadComposer = vi.fn(() => new Promise<ComposerProjection>((resolve) => resolvers.push(resolve)));
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" }, loadComposer,
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {} }),
      execute: async () => ({ status: "accepted", commandId: "command-1" }),
    };
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
    await waitFor(() => expect(loadComposer).toHaveBeenCalledTimes(1));
    const nextCursor = { ...rootSession.cursor, sequence: 3 };
    const nextSession = { ...rootSession, cursor: nextCursor, performance: { ...rootSession.performance, cursor: nextCursor } } as RootSessionProjection;
    act(() => store.dispatch({ type: "harness/session-projected", session: nextSession }));
    await waitFor(() => expect(loadComposer).toHaveBeenCalledTimes(2));
    await act(async () => resolvers[0]?.({ models: [], selectedModel: "stale-model", thinkingLevels: [], selectedThinking: "max", supportedCommands: [] }));
    expect(screen.getByRole("status", { name: /Runtime status/ })).not.toHaveTextContent("stale-model");
    await act(async () => resolvers[1]?.({ models: [], selectedModel: "current-model", thinkingLevels: [], selectedThinking: "high", supportedCommands: [] }));
    expect(await screen.findByRole("status", { name: /Runtime status:.*current-model.*thinking high/i })).toBeVisible();
  });

  it("clears mounted inspector facts when compatibility authority is lost", async () => {
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: { usedTokens: 10_000, capacityTokens: 40_000 }, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [{ id: "overload", kind: "warning", title: "Busy", detail: "server_is_overloaded", retryable: true, dismissible: true }], activity: [], outputs: [], sources: [], children: {} }),
      execute: async () => ({ status: "accepted", commandId: "command-1" }),
    };
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
    expect(await screen.findByRole("status", { name: /Runtime status:.*ctx 25%.*server_is_overloaded/i })).toBeVisible();
    act(() => store.dispatch({ type: "harness/bootstrap-loaded", projection: { compatibility: { status: "unavailable", reason: "security_verification_failed" }, runtime: null, sessions: [rootSession] } }));
    await waitFor(() => expect(screen.getByRole("status", { name: /Runtime status/ })).toHaveTextContent("ctx unavailable"));
    expect(screen.getByRole("status", { name: /Runtime status/ })).toHaveTextContent("overload unavailable");
    expect(screen.getByRole("status", { name: /Runtime status/ })).not.toHaveTextContent("server_is_overloaded");
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus());
    expect(document.querySelector('.studio-sidebar[data-mode="rail"]')).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-studio-sheet='sidebar']")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveFocus());

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    fireEvent(window, new Event("resize"));
  }, 15_000);

  it("opens the narrow sheet in one activation when the persisted pane preference is collapsed", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    const persisted = {
      schemaVersion: 1 as const,
      sidebarOpen: false,
      sidebarWidth: 264,
      inspectorOpen: true,
      inspectorWidth: 384,
      editorOpen: false,
      editorWidth: 400,
      expandedProjectIds: ["project:personal"],
    };
    const load = vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValueOnce(persisted);
    const save = vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async (next) => next);
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await waitFor(() => expect(load).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await waitFor(() => expect(document.querySelector("[data-studio-sheet='sidebar']")).not.toBeNull());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sidebarOpen: true }));

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    fireEvent(window, new Event("resize"));
  }, 15_000);

  it("transfers focus between the wide pane collapse control and the replacement rail", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });

    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    await userEvent.click(collapse);
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus());

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    fireEvent(window, new Event("resize"));
  }, 15_000);

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
    expect(screen.getByRole("button", { name: /Harness architecture.*status: Idle/i })).toBeVisible();
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

  it("projects the configured workspace footer and routes every menu action through explicit dispatcher outcomes", async () => {
    const settingsSpy = vi.spyOn(rpc, "getAppSettings").mockResolvedValue({ defaultCwd: "D:\\Clients\\Prime Studio" });
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    const user = userEvent.setup();
    render(<AppProviders store={store}><StudioApp /></AppProviders>);

    const trigger = await screen.findByRole("button", { name: "Prime Studio workspace menu" });
    expect(trigger).toHaveTextContent("D:\\Clients\\Prime Studio");
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Switch workspace" }));
    expect(within(screen.getByRole("menu", { name: "Workspace actions" }).parentElement!).getByRole("status")).toHaveTextContent("Workspace switching is unavailable because no workspace catalog authority is configured.");
    const failureToast = screen.getByRole("alert", { name: "Studio data operation failed" });
    expect(failureToast).toHaveTextContent("Workspace switching is unavailable");
    expect(within(failureToast).getByRole("button", { name: "Dismiss Studio data operation failed" }))
      .toHaveAttribute("data-studio-action", "toast.dismiss");

    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(within(screen.getByRole("menu", { name: "Workspace actions" }).parentElement!).getByRole("status")).toHaveTextContent("Workspace sign-out is unavailable because configured folders do not own an authenticated session.");

    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General", level: 1 })).toBeVisible();
    settingsSpy.mockRestore();
  }, 15_000);

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

    await waitFor(() => expect(operations).toContainEqual(expect.objectContaining({
      action: "settings.harness-policy.set",
      payload: { key: "maxConcurrentAgents", value: "8" },
    })));
  });

  it("automatically retries one observed silent-worker failure exactly once", async () => {
    const observationId = "worker-recovery-0123456789abcdef012345";
    const failed: RootSessionProjection = {
      ...rootSession,
      state: "failed",
      workerRecovery: { status: "retryable_failure", closureReason: "supervisor_recovery_exhausted", observationId, automaticRetryCount: 0, detail: "Supervisor recovery exhausted" },
    };
    const retry = vi.fn(async () => ({ outcome: "recovered" as const, session: {
      ...rootSession,
      cursor: { ...rootSession.cursor, sequence: 3 },
      workerRecovery: { status: "recovered" as const, closureReason: "supervisor_recovery_exhausted" as const, observationId, automaticRetryCount: 1 as const, detail: null },
    } }));
    const settingsSpy = vi.spyOn(rpc, "getAppSettings").mockResolvedValue({ retrySilentWorkers: "enabled" });
    const adapter: HarnessInspectorAdapter = {
      ...conversationAdapter([]),
      workerRecovery: { status: "available", maximumAutomaticRetries: 1, retry },
    };
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [failed] }));
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    await waitFor(() => expect(retry).toHaveBeenCalledWith(rootSession.sessionId, observationId));
    store.dispatch({ type: "harness/session-projected", session: { ...failed, cursor: { ...failed.cursor, sequence: 3 } } });
    await act(async () => { await Promise.resolve(); });
    expect(retry).toHaveBeenCalledOnce();
    settingsSpy.mockRestore();
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
    expect(await screen.findByText("Export cancelled.")).toBeVisible();
    exportSpy.mockRestore();
  });

  it("keeps the editor explicitly unsupported when no identity-bound artifact ref exists", async () => {
    const store = createStudioStore(initialStudioState({ chats: [chat] }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp /></AppProviders>);
    await userEvent.click(screen.getByRole("button", { name: "Open editor" }));
    expect(screen.getByText(/Open an identity-bound candidate from Harness/i)).toBeVisible();
  });

  it("routes response copy through the shared dispatcher and native clipboard executor exactly once", async () => {
    const writeText = vi.fn(async () => undefined);
    const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
    try {
      render(<AppProviders store={store}><StudioApp /></AppProviders>);

      await userEvent.click(await screen.findByRole("button", { name: /^Copy$/ }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Original answer"));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Message copied.", { selector: "span[role=status]" })).toBeVisible();
    } finally {
      if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("copies only the sanitized activity command through the native clipboard boundary", async () => {
    const writeText = vi.fn(async () => undefined);
    const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const sanitized = "[escaped] run [REDACTED_SECRET] \\u{202E}";
    const adapter = conversationAdapter([]);
    adapter.load = async () => ({
      observedAtMs: Date.UTC(2026, 7, 13, 12), startedAtMs: null, context: null,
      extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], outputs: [], sources: [], children: {},
      activity: [{ id: "activity-safe", occurredAtMs: Date.UTC(2026, 7, 13, 11), group: "Tools", kind: "tool", title: "Shell", detail: "Done", tool: { command: sanitized, redacted: true, status: "succeeded", durationMs: null, files: [] } }],
    });
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
    try {
      render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
      await userEvent.click(await screen.findByRole("tab", { name: "Activity" }));
      await userEvent.click(await screen.findByRole("button", { name: /Shell/ }));
      await userEvent.click(screen.getByRole("button", { name: "Copy command" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(sanitized));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("Command copied.")).toHaveAttribute("role", "status");
    } finally {
      if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("owns Canvas open/apply through exact operations with CAS replay and no Harness-history rewrite", async () => {
    const operations: StudioOperation[] = [];
    const loadLayout = vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValue({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: ["project:personal"] });
    const saveLayout = vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async (next) => next);
    const { createStudioOperationDispatcher: createDispatcher } = await vi.importActual<typeof operationDispatcher>("../contracts/dispatcher/studioOperationDispatcher");
    let activeDispatch: ((operation: StudioOperation) => Promise<StudioOperationOutcome>) | null = null;
    const dispatcherSpy = vi.spyOn(operationDispatcher, "createStudioOperationDispatcher").mockImplementation((routes) => {
      const execute = createDispatcher(routes);
      activeDispatch = execute;
      return async (operation) => { operations.push(operation); return execute(operation); };
    });
    const loadDisplay = vi.spyOn(chatDisplayClient, "loadChatDisplayRevisions").mockResolvedValue({ schemaVersion: 1, records: [] });
    const applyDisplay = vi.spyOn(chatDisplayClient, "applyChatDisplayRevision").mockImplementation(async (request) => ({
      chatId: request.chatId, messageId: request.messageId, revision: request.expectedRevision + 1, sourceContent: request.sourceContent, content: request.content,
    }));
    try {
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      const view = render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
      await waitFor(() => expect(loadLayout).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole("button", { name: "Edit answer in Canvas" }));
      expect(operations.filter((operation) => operation.action === "conversation.canvas.open")).toEqual([expect.objectContaining({
        action: "conversation.canvas.open",
        payload: { chatId: chat.id, messageId: "a1", expectedRevision: 1, content: "Original answer" },
      })]);
      const editor = await screen.findByRole("textbox", { name: "Canvas content" });
      await userEvent.clear(editor);
      await userEvent.type(editor, "Studio-only revision");
      await userEvent.click(screen.getByRole("button", { name: "Apply display revision" }));
      const apply = operations.find((operation) => operation.action === "editor.canvas.apply");
      expect(apply).toEqual(expect.objectContaining({ payload: { documentId: JSON.stringify(["canvas", rootSession.sessionId, chat.id, "a1", 0, 1]), chatId: chat.id, messageId: "a1", expectedRevision: 1, content: "Studio-only revision" } }));
      expect((await screen.findAllByText("Display revision 2")).length).toBe(2);
      expect(screen.getByText("Studio-only revision", { selector: ".parent-assistant-copy p" })).toBeVisible();

      const successorDraft = screen.getByRole("textbox", { name: "Canvas content" });
      await userEvent.type(successorDraft, " successor draft");
      expect(successorDraft).toHaveValue("Studio-only revision successor draft");
      store.dispatch({ type: "conversation/version-appended", chatId: chat.id, messageId: "a1", kind: "assistant", text: "Alternate answer" });
      store.dispatch({ type: "conversation/version-selected", chatId: chat.id, messageId: "a1", kind: "assistant", version: 0 });
      let replay: StudioOperationOutcome | undefined;
      let foreignIdentity: StudioOperationOutcome | undefined;
      let stale: StudioOperationOutcome | undefined;
      let changedSourceVersion: StudioOperationOutcome | undefined;
      let sourceVersionReplay: StudioOperationOutcome | undefined;
      await act(async () => {
        if (!activeDispatch || !apply) throw new Error("Studio dispatcher was not installed");
        replay = await activeDispatch(apply);
        foreignIdentity = await activeDispatch({ action: "editor.canvas.apply", payload: { documentId: JSON.stringify(["canvas", rootSession.sessionId, chat.id, "a1", 1, 1]), chatId: chat.id, messageId: "a1", expectedRevision: 1, content: "Studio-only revision" } });
        stale = await activeDispatch({ action: "editor.canvas.apply", payload: { documentId: JSON.stringify(["canvas", rootSession.sessionId, chat.id, "a1", 0, 1]), chatId: chat.id, messageId: "a1", expectedRevision: 1, content: "stale overwrite" } });
        changedSourceVersion = await activeDispatch({ action: "conversation.assistant-version.select", payload: { chatId: chat.id, messageId: "a1", version: 1 } });
        sourceVersionReplay = await activeDispatch(apply);
      });
      expect(replay).toEqual({ status: "updated", revision: 2 });
      expect(foreignIdentity).toEqual({ status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false });
      expect(stale).toEqual({ status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false });
      expect(changedSourceVersion).toEqual({ status: "updated", revision: 1 });
      expect(sourceVersionReplay).toEqual({ status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false });
      expect(screen.queryByText("stale overwrite")).not.toBeInTheDocument();
      expect(await screen.findByText("No verified file or Canvas revision")).toBeVisible();
      expect(rootSession.parentMessages[1]).toEqual(expect.objectContaining({ id: "a1", blocks: [{ kind: "text", text: "Original answer" }] }));
      expect(store.getSnapshot().sessions[rootSession.sessionId]?.parentMessages[1]).toEqual(rootSession.parentMessages[1]);
      expect(store.getSnapshot().canvasRevisions[chat.id]?.a1).toEqual({ revision: 2, sourceContent: "Original answer", content: "Studio-only revision" });
      expect(applyDisplay).toHaveBeenCalledTimes(1);
      expect(applyDisplay).toHaveBeenCalledWith({ chatId: chat.id, messageId: "a1", expectedRevision: 1, sourceContent: "Original answer", content: "Studio-only revision" });

      await act(async () => {
        if (!activeDispatch) throw new Error("Studio dispatcher was not installed");
        await activeDispatch({ action: "conversation.assistant-version.select", payload: { chatId: chat.id, messageId: "a1", version: 0 } });
      });
      await userEvent.click(screen.getByRole("button", { name: "Edit answer in Canvas" }));
      expect(await screen.findByRole("textbox", { name: "Canvas content" })).toHaveValue("Studio-only revision successor draft");
      view.unmount();
      render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
      expect(await screen.findByText("Studio-only revision", { selector: ".parent-assistant-copy p" })).toBeVisible();
    } finally {
      saveLayout.mockRestore();
      loadLayout.mockRestore();
      dispatcherSpy.mockRestore();
      loadDisplay.mockRestore();
      applyDisplay.mockRestore();
    }
  }, 20_000);

  it("hydrates persisted Canvas revisions into a fresh store at startup", async () => {
    mockAvailableLayoutPersistence();
    const loadDisplay = vi.spyOn(chatDisplayClient, "loadChatDisplayRevisions").mockResolvedValue({
      schemaVersion: 1,
      records: [{ chatId: chat.id, messageId: "a1", revision: 4, sourceContent: "Original answer", content: "Persisted after restart" }],
    });
    try {
      const freshStore = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={freshStore}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
      expect(await screen.findByText("Persisted after restart", { selector: ".parent-assistant-copy p" })).toBeVisible();
      expect(freshStore.getSnapshot().canvasRevisions[chat.id]?.a1).toEqual({ revision: 4, sourceContent: "Original answer", content: "Persisted after restart" });
      expect(loadDisplay).toHaveBeenCalledOnce();
    } finally {
      loadDisplay.mockRestore();
    }
  });

  it("opens Canvas from the visibly selected assistant version", async () => {
    mockAvailableLayoutPersistence();
    const applyDisplay = vi.spyOn(chatDisplayClient, "applyChatDisplayRevision").mockImplementation(async (request) => ({
      chatId: request.chatId, messageId: request.messageId, revision: request.expectedRevision + 1, sourceContent: request.sourceContent, content: request.content,
    }));
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
    store.dispatch({ type: "conversation/canvas-loaded", records: [
      { chatId: chat.id, messageId: "a1", revision: 4, sourceContent: "Original answer", content: "Canvas revision of original" },
    ] });
    store.dispatch({ type: "conversation/version-appended", chatId: chat.id, messageId: "a1", kind: "assistant", text: "Alternate answer" });
    store.dispatch({ type: "conversation/version-selected", chatId: chat.id, messageId: "a1", kind: "assistant", version: 1 });

    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
    expect(await screen.findByText("Alternate answer", { selector: ".parent-assistant-copy p" })).toBeVisible();
    expect(screen.queryByText("Canvas revision of original")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit answer in Canvas" }));

    const editor = await screen.findByRole("textbox", { name: "Canvas content" });
    expect(editor).toHaveValue("Alternate answer");
    fireEvent.change(editor, { target: { value: "Canvas revision of alternate" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply display revision" }));
    expect(applyDisplay).toHaveBeenCalledWith({
      chatId: chat.id, messageId: "a1", expectedRevision: 4, sourceContent: "Alternate answer", content: "Canvas revision of alternate",
    });
    expect(store.getSnapshot().canvasRevisions[chat.id]?.a1).toEqual({ revision: 5, sourceContent: "Alternate answer", content: "Canvas revision of alternate" });
    applyDisplay.mockRestore();
  }, 20_000);

  it("does not open a delayed Canvas outcome after the selected chat identity changes", async () => {
    const secondSession: RootSessionProjection = {
      ...rootSession, sessionId: "session-2", chatId: "daemon-chat-2", cursor: { runtimeGeneration: "g2", sequence: 1 },
      parentMessages: [{ channel: "parent", kind: "assistant", id: "b1", blocks: [{ kind: "text", text: "Second answer" }], streaming: false, emittedAtMs: 3 }],
      performance: { status: "unavailable", sessionId: "session-2", cursor: { runtimeGeneration: "g2", sequence: 1 }, reason: "event_chronology_unavailable" },
    };
    const firstCatalog = catalogBoundToRootSession();
    const created = transitionProjectChatState(firstCatalog, { type: "chat.create", projectId: "project:personal", chatId: "chat-2", title: "Second" });
    if (created.status !== "applied") throw new Error("second test chat create failed");
    const bound = transitionProjectChatState(created.state, { type: "chat.bind-prime-session", projectId: "project:personal", chatId: "chat-2", binding: { kind: "prime-session", accountId: secondSession.accountId, sessionId: secondSession.sessionId, sessionFile: "second.jsonl", agentId: secondSession.chatId } });
    if (bound.status !== "applied") throw new Error("second test chat bind failed");
    const pendingLayout = deferred<Parameters<typeof rpc.setLayoutPreferences>[0]>();
    const loadLayout = vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValue({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: ["project:personal"] });
    let layoutWrites = 0;
    const saveLayout = vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async (next) => {
      layoutWrites += 1;
      return layoutWrites === 1 ? pendingLayout.promise : next;
    });
    try {
      const store = createStudioStore(initialStudioState({ projectCatalog: bound.state, sessions: [rootSession, secondSession] }));
      store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: "project:personal", chatId: chat.id } });
      render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
      await waitFor(() => expect(loadLayout).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole("button", { name: "Edit answer in Canvas" }));
      expect(screen.queryByRole("textbox", { name: "Canvas content" })).not.toBeInTheDocument();
      act(() => { store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: "project:personal", chatId: "chat-2" } }); });
      await act(async () => { pendingLayout.resolve({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: true, editorWidth: 400, expandedProjectIds: ["project:personal"] }); await pendingLayout.promise; });

      expect(await screen.findByText("Second answer")).toBeVisible();
      expect(screen.queryByRole("textbox", { name: "Canvas content" })).not.toBeInTheDocument();
      expect(screen.queryByText("Original answer", { selector: "textarea" })).not.toBeInTheDocument();
      await waitFor(() => expect(saveLayout).toHaveBeenLastCalledWith(expect.objectContaining({ editorOpen: false })));
      expect(screen.getByRole("button", { name: "Open editor" })).toBeVisible();
    } finally {
      saveLayout.mockRestore();
      loadLayout.mockRestore();
    }
  }, 20_000);

  it("does not let an older Canvas completion close an editor acquired by a newer open", async () => {
    const pendingLayout = deferred<Parameters<typeof rpc.setLayoutPreferences>[0]>();
    const loadLayout = vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValue({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: ["project:personal"] });
    const saveLayout = vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async () => pendingLayout.promise);
    try {
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);
      await waitFor(() => expect(loadLayout).toHaveBeenCalled());
      const open = await screen.findByRole("button", { name: "Edit answer in Canvas" });
      await userEvent.click(open);
      await userEvent.click(open);
      expect(await screen.findByRole("textbox", { name: "Canvas content" })).toHaveValue("Original answer");

      await act(async () => { pendingLayout.resolve({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: true, editorWidth: 400, expandedProjectIds: ["project:personal"] }); await pendingLayout.promise; });

      expect(screen.getByRole("textbox", { name: "Canvas content" })).toHaveValue("Original answer");
      expect(saveLayout).toHaveBeenCalledTimes(1);
    } finally {
      saveLayout.mockRestore();
      loadLayout.mockRestore();
    }
  }, 20_000);

  it("hydrates an opaque Harness candidate through the centralized dispatcher and opens the editor", async () => {
    mockAvailableLayoutPersistence();
    const openArtifact = vi.fn(async () => ({
      kind: "opened" as const,
      document: {
        label: "report.md",
        ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "candidate-1", revision: 1 },
        identity: `sha256:${"a".repeat(64)}`,
        content: "verified content",
        writable: true,
        diff: [],
      },
    }));
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-1", kind: "file" }], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact,
    };
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
    await userEvent.click(await screen.findByText("Outputs"));
    await userEvent.click(await screen.findByRole("button", { name: /Report/ }));
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith(rootSession.sessionId, "candidate-1"));
    await userEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("verified content");
  });

  it("rejects an artifact-open completion after the owning chat changes", async () => {
    const pendingLayout = deferred<Parameters<typeof rpc.setLayoutPreferences>[0]>();
    const loadLayout = vi.spyOn(rpc, "getLayoutPreferences").mockResolvedValue({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: ["project:personal"] });
    const saveLayout = vi.spyOn(rpc, "setLayoutPreferences").mockImplementation(async () => pendingLayout.promise);
    const staleDocument = { label: "stale.md", ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "candidate-1", revision: 1 }, identity: `sha256:${"a".repeat(64)}`, content: "stale", writable: true, diff: [] } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-1", kind: "file" }], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async () => ({ kind: "opened", document: staleDocument }),
    };
    const secondSession: RootSessionProjection = { ...rootSession, sessionId: "session-2", chatId: "daemon-chat-2", cursor: { runtimeGeneration: "g2", sequence: 1 } };
    const created = transitionProjectChatState(catalogBoundToRootSession(), { type: "chat.create", projectId: "project:personal", chatId: "chat-2", title: "Second" });
    if (created.status !== "applied") throw new Error("second test chat create failed");
    const bound = transitionProjectChatState(created.state, { type: "chat.bind-prime-session", projectId: "project:personal", chatId: "chat-2", binding: { kind: "prime-session", accountId: secondSession.accountId, sessionId: secondSession.sessionId, sessionFile: "second.jsonl", agentId: secondSession.chatId } });
    if (bound.status !== "applied") throw new Error("second test chat bind failed");
    const store = createStudioStore(initialStudioState({ projectCatalog: bound.state, sessions: [rootSession, secondSession] }));
    store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: "project:personal", chatId: chat.id } });
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
    try {
      await userEvent.click(await screen.findByText("Outputs"));
      await userEvent.click(await screen.findByRole("button", { name: /Report/ }));
      act(() => { store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: "project:personal", chatId: "chat-2" } }); });
      await act(async () => { pendingLayout.resolve({ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: true, editorWidth: 400, expandedProjectIds: ["project:personal"] }); await pendingLayout.promise; });
      expect(screen.queryByRole("heading", { name: "stale.md" })).not.toBeInTheDocument();
    } finally {
      saveLayout.mockRestore();
      loadLayout.mockRestore();
    }
  });

  it("lets the renderer owner visibly select an identity-bound editor mode", async () => {
    mockAvailableLayoutPersistence();
    const document = {
      label: "report.md",
      ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "candidate-1", revision: 7 },
      identity: `sha256:${"a".repeat(64)}`,
      content: "verified content",
      writable: true,
      diff: [],
    } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-1", kind: "file" }], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async () => ({ kind: "opened", document }),
    };
    const { createStudioOperationDispatcher: createDispatcher } = await vi.importActual<typeof operationDispatcher>("../contracts/dispatcher/studioOperationDispatcher");
    let activeDispatch: ((operation: StudioOperation) => Promise<StudioOperationOutcome>) | null = null;
    const dispatcherSpy = vi.spyOn(operationDispatcher, "createStudioOperationDispatcher").mockImplementation((routes) => {
      const execute = createDispatcher(routes);
      activeDispatch = execute;
      return execute;
    });
    try {
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
      await userEvent.click(await screen.findByText("Outputs"));
      await userEvent.click(await screen.findByRole("button", { name: /Report/ }));
      expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");

      await act(async () => {
        if (!activeDispatch) throw new Error("Studio dispatcher was not installed");
        await activeDispatch({
          action: "editor.mode.select",
          payload: {
            documentId: JSON.stringify(["artifact", "broker-1", rootSession.sessionId, "candidate-1", 7, document.identity]),
            mode: "edit",
          },
        });
      });

      expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("verified content");
    } finally {
      dispatcherSpy.mockRestore();
    }
  }, 15_000);

  it("dispatches exactly one editor mode operation for each tab transition", async () => {
    mockAvailableLayoutPersistence();
    const document = {
      label: "report.md",
      ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "candidate-1", revision: 7 },
      identity: `sha256:${"a".repeat(64)}`,
      content: "verified content",
      writable: true,
      diff: [],
    } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-1", kind: "file" }], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async () => ({ kind: "opened", document }),
    };
    const operations: StudioOperation[] = [];
    const { createStudioOperationDispatcher: createDispatcher } = await vi.importActual<typeof operationDispatcher>("../contracts/dispatcher/studioOperationDispatcher");
    const dispatcherSpy = vi.spyOn(operationDispatcher, "createStudioOperationDispatcher").mockImplementation((routes) => {
      const execute = createDispatcher(routes);
      return async (operation) => {
        operations.push(operation);
        return execute(operation);
      };
    });
    try {
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
      await userEvent.click(await screen.findByText("Outputs"));
      await userEvent.click(await screen.findByRole("button", { name: /Report/ }));
      operations.length = 0;

      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));

      expect(operations.filter((operation) => operation.action === "editor.mode.select")).toEqual([expect.objectContaining({
        action: "editor.mode.select",
        operationId: expect.any(String),
        payload: {
          documentId: JSON.stringify(["artifact", "broker-1", rootSession.sessionId, "candidate-1", 7, document.identity]),
          mode: "edit",
        },
      })]);
      expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    } finally {
      dispatcherSpy.mockRestore();
    }
  }, 15_000);

  it("never carries artifact A content or save identity into newly admitted artifact B", async () => {
    mockAvailableLayoutPersistence();
    const identityA = `sha256:${"a".repeat(64)}`;
    const identityB = `sha256:${"b".repeat(64)}`;
    const documents = {
      "candidate-a": { label: "report.md", ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "shared-artifact", revision: 3 }, identity: identityA, content: "artifact A", writable: true, diff: [] },
      "candidate-b": { label: "report.md", ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "shared-artifact", revision: 11 }, identity: identityB, content: "artifact B", writable: true, diff: [] },
    } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [
        { id: "output-a", label: "Artifact A", candidateId: "candidate-a", kind: "file" },
        { id: "output-b", label: "Artifact B", candidateId: "candidate-b", kind: "file" },
      ], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async (_sessionId, candidateId) => ({ kind: "opened", document: documents[candidateId as keyof typeof documents] }),
    };
    const save = vi.spyOn(rpc, "saveEditorArtifact").mockResolvedValue({ kind: "saved", revision: 12, identity: `sha256:${"c".repeat(64)}` });
    const previousWidth = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
      await userEvent.click(await screen.findByText("Outputs"));
      await userEvent.click(await screen.findByRole("button", { name: /Artifact A/ }));
      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
      fireEvent.change(screen.getByRole("textbox", { name: "File content" }), { target: { value: "artifact A unsaved" } });

      await userEvent.click(screen.getByRole("button", { name: /Artifact B/ }));
      expect(screen.getByRole("heading", { name: "report.md" })).toBeVisible();
      expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
      const content = screen.getByRole("textbox", { name: "File content" });
      expect(content).toHaveValue("artifact B");
      expect(content).not.toHaveValue(expect.stringContaining("artifact A"));
      fireEvent.change(content, { target: { value: "artifact B saved" } });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith({
        ref: documents["candidate-b"].ref,
        expectedRevision: 11,
        expectedIdentity: identityB,
        content: "artifact B saved",
      });
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
      save.mockRestore();
    }
  }, 30_000);

  it("isolates an in-flight native save from a replacement artifact identity", async () => {
    mockAvailableLayoutPersistence();
    const identityA = `sha256:${"a".repeat(64)}`;
    const identityB = `sha256:${"b".repeat(64)}`;
    const documents = {
      "candidate-a": { label: "a.md", ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "artifact-a", revision: 3 }, identity: identityA, content: "artifact A", writable: true, diff: [] },
      "candidate-b": { label: "b.md", ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "artifact-b", revision: 11 }, identity: identityB, content: "artifact B", writable: true, diff: [] },
    } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [
        { id: "output-a", label: "Artifact A", candidateId: "candidate-a", kind: "file" },
        { id: "output-b", label: "Artifact B", candidateId: "candidate-b", kind: "file" },
      ], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async (_sessionId, candidateId) => ({ kind: "opened", document: documents[candidateId as keyof typeof documents] }),
    };
    const pending = deferred<Awaited<ReturnType<typeof rpc.saveEditorArtifact>>>();
    const save = vi.spyOn(rpc, "saveEditorArtifact").mockImplementation(async () => pending.promise);
    const previousWidth = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
      const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
      render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
      await userEvent.click(await screen.findByText("Outputs"));
      await userEvent.click(await screen.findByRole("button", { name: /Artifact A/ }));
      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
      fireEvent.change(screen.getByRole("textbox", { name: "File content" }), { target: { value: "artifact A changed" } });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      await userEvent.click(screen.getByRole("button", { name: /Artifact B/ }));
      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
      expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("artifact B");
      await act(async () => { pending.resolve({ kind: "saved", revision: 4, identity: `sha256:${"c".repeat(64)}` }); await pending.promise; });

      expect(screen.getByRole("heading", { name: "b.md" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("artifact B");
      expect(screen.queryByText("Saved revision 4")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
      save.mockRestore();
    }
  }, 30_000);

  it("wires editor conflict recovery to native reload and save-copy authority", async () => {
    mockAvailableLayoutPersistence();
    const document = {
      label: "report.md",
      ref: { brokerId: "broker-1", rootSessionId: rootSession.sessionId, artifactId: "candidate-1", revision: 1 },
      identity: `sha256:${"a".repeat(64)}`,
      content: "verified content",
      writable: true,
      diff: [],
    } as const;
    const adapter: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: async () => ({ observedAtMs: 1, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], activity: [], outputs: [{ id: "output-1", label: "Report", candidateId: "candidate-1", kind: "file" }], sources: [], children: {} }),
      execute: async () => ({ status: "rejected", reason: "wrong route", retryable: false }),
      openArtifact: async () => ({ kind: "opened", document }),
    };
    const save = vi.spyOn(rpc, "saveEditorArtifact").mockResolvedValue({ kind: "conflict", message: "changed on disk" });
    const saveCopy = vi.spyOn(rpc, "saveEditorArtifactCopy").mockResolvedValue({ kind: "saved_copy", label: "report.prime-copy.md" });
    const reload = vi.spyOn(rpc, "reloadEditorArtifact").mockResolvedValue({ kind: "opened", document: { ...document, ref: { ...document.ref, revision: 2 }, identity: `sha256:${"b".repeat(64)}`, content: "external" } });
    const store = createStudioStore(initialStudioState({ projectCatalog: catalogBoundToRootSession(), sessions: [rootSession] }));
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);
    await userEvent.click(await screen.findByText("Outputs"));
    await userEvent.click(await screen.findByRole("button", { name: /Report/ }));
    await userEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "File content" }), " changed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save a copy" }));
    expect(saveCopy).toHaveBeenCalledWith(expect.objectContaining({ content: "verified content changed" }));
    await userEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    expect(reload).toHaveBeenCalledWith(document.ref);
    await userEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "File content" })).toHaveValue("external");
    save.mockRestore(); saveCopy.mockRestore(); reload.mockRestore();
  }, 15_000);

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

  it("creates and selects a distinct native-bound catalog chat when branching from a message", async () => {
    const operations: StudioOperation[] = [];
    const branchSession: RootSessionProjection = {
      ...rootSession,
      sessionId: "session-branch",
      chatId: "daemon-chat-branch",
      cursor: { runtimeGeneration: "g-branch", sequence: 1 },
      parentMessages: [rootSession.parentMessages[0]!],
    };
    const sourceCatalog = catalogBoundToRootSession();
    const createdBranch = transitionProjectChatState(sourceCatalog, {
      type: "chat.create", projectId: "project:personal", chatId: "chat-branch", title: "Branch of Harness architecture",
    });
    if (createdBranch.status !== "applied") throw new Error("test branch create failed");
    const boundBranch = transitionProjectChatState(createdBranch.state, {
      type: "chat.bind-prime-session", projectId: "project:personal", chatId: "chat-branch",
      binding: { kind: "prime-session", accountId: branchSession.accountId, sessionId: branchSession.sessionId, sessionFile: "branch.jsonl", agentId: branchSession.chatId },
    });
    if (boundBranch.status !== "applied") throw new Error("test branch bind failed");
    const branchSpy = vi.spyOn(projectCatalogClient, "branchResidentCatalogChat").mockResolvedValue({
      branchChatId: "chat-branch",
      catalog: { revision: 3, state: boundBranch.state },
      session: branchSession,
    });
    const store = createStudioStore(initialStudioState({
      projectCatalog: sourceCatalog,
      sessions: [rootSession],
      compatibility: {
        status: "ready", profile: "verified",
        capabilities: ["attach_snapshot", "event_sequence", "resident_sessions", "session_input_admission", "model_catalog"],
      },
    }));
    store.dispatch({ type: "project-catalog/loaded", snapshot: { revision: 2, state: sourceCatalog } });
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter(operations)} /></AppProviders>);

    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edit message text" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Edited prompt");
    await userEvent.click(screen.getByRole("button", { name: "Send edited message" }));
    await waitFor(() => expect(operations).toContainEqual(expect.objectContaining({
      action: "conversation.user-version.create",
      payload: { chatId: "chat-1", messageId: "u1", text: "Edited prompt" },
    })));
    expect(store.getSnapshot().conversationDisplay[chat.id]?.messages.u1?.versions).toEqual([{ text: "Original prompt" }, { text: "Edited prompt" }]);

    await userEvent.click(screen.getByRole("button", { name: "Branch chat from message" }));
    await waitFor(() => expect(store.getSnapshot().navigation.selectedChatId).toBe("chat-branch"));
    expect(store.getSnapshot().sessions["session-branch"]?.chatId).toBe("daemon-chat-branch");
    expect(branchSpy).toHaveBeenCalledWith({
      expectedRevision: 2,
      projectId: "project:personal",
      sourceChatId: "chat-1",
      sourceSessionId: "session-1",
      messageId: "u1",
      expectedCursor: { runtimeGeneration: "g1", sequence: 2 },
    });
    act(() => store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: "project:personal", chatId: "chat-1" } }));
    await waitFor(() => expect(store.getSnapshot().navigation.selectedChatId).toBe("chat-1"));
    await userEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    await userEvent.click(screen.getByRole("button", { name: "Use Verified model" }));
    await userEvent.click(screen.getByRole("button", { name: "Thinking low" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "conversation.response.regenerate", payload: { sessionId: "session-1", messageId: "a1" } }),
      expect.objectContaining({ action: "composer.model.select", payload: { chatId: "chat-1", modelId: "verified-model" } }),
      expect.objectContaining({ action: "composer.thinking.select", payload: { chatId: "chat-1", level: "high" } }),
    ]));

    act(() => store.dispatch({ type: "draft/change", chatId: chat.id, draft: "/compact" }));
    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await waitFor(() => expect(composer).toHaveValue("/compact"));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(operations).toContainEqual(expect.objectContaining({ action: "harness.session.compact", payload: { sessionId: "session-1" } })));
    branchSpy.mockRestore();
  }, 30_000);

  it("routes /fork through the same native resident branch transaction", async () => {
    const operations: StudioOperation[] = [];
    const sourceCatalog = catalogBoundToRootSession();
    const branchSession: RootSessionProjection = {
      ...rootSession,
      sessionId: "session-slash-branch",
      chatId: "daemon-chat-slash-branch",
      cursor: { runtimeGeneration: "g-slash-branch", sequence: 1 },
    };
    const created = transitionProjectChatState(sourceCatalog, {
      type: "chat.create", projectId: "project:personal", chatId: "chat-slash-branch", title: "Branch of Harness architecture",
    });
    if (created.status !== "applied") throw new Error("test branch create failed");
    const bound = transitionProjectChatState(created.state, {
      type: "chat.bind-prime-session", projectId: "project:personal", chatId: "chat-slash-branch",
      binding: { kind: "prime-session", accountId: branchSession.accountId, sessionId: branchSession.sessionId, sessionFile: "slash-branch.jsonl", agentId: branchSession.chatId },
    });
    if (bound.status !== "applied") throw new Error("test branch bind failed");
    const branchSpy = vi.spyOn(projectCatalogClient, "branchResidentCatalogChat").mockResolvedValue({
      branchChatId: "chat-slash-branch",
      catalog: { revision: 3, state: bound.state },
      session: branchSession,
    });
    const store = createStudioStore(initialStudioState({
      projectCatalog: sourceCatalog,
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["resident_sessions", "model_catalog"] },
    }));
    store.dispatch({ type: "project-catalog/loaded", snapshot: { revision: 2, state: sourceCatalog } });
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter(operations)} /></AppProviders>);

    act(() => store.dispatch({ type: "draft/change", chatId: chat.id, draft: "/fork" }));
    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await waitFor(() => expect(composer).toHaveValue("/fork"));
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(store.getSnapshot().navigation.selectedChatId).toBe("chat-slash-branch"));
    expect(branchSpy).toHaveBeenCalledWith(expect.objectContaining({ messageId: "a1", sourceChatId: "chat-1", sourceSessionId: "session-1" }));
    expect(operations).not.toContainEqual(expect.objectContaining({ action: "conversation.branch.create" }));
    branchSpy.mockRestore();
  }, 20_000);

  it("opens the exact verified model picker for /model and retains the command draft", async () => {
    const operations: StudioOperation[] = [];
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter(operations)} /></AppProviders>);

    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await userEvent.type(composer, "/model");
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(await screen.findByRole("menu", { name: "Verified models" })).toBeVisible();
    expect(composer).toHaveValue("/model");
    expect(operations).not.toContainEqual(expect.objectContaining({ action: "composer.model.select" }));
  }, 15_000);

  it("keeps the parent selected and reports failure when a resident branch cannot be reconciled", async () => {
    const sourceCatalog = catalogBoundToRootSession();
    const loadSpy = vi.spyOn(projectCatalogClient, "loadProjectCatalog").mockResolvedValue({ revision: 2, state: sourceCatalog });
    const branchSpy = vi.spyOn(projectCatalogClient, "branchResidentCatalogChat").mockRejectedValue(new Error("daemon branch outcome is unknown"));
    const store = createStudioStore(initialStudioState({
      projectCatalog: sourceCatalog,
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["resident_sessions"] },
    }));
    store.dispatch({ type: "project-catalog/loaded", snapshot: { revision: 2, state: sourceCatalog } });
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={conversationAdapter([])} /></AppProviders>);

    await userEvent.click(screen.getByRole("button", { name: "Branch chat from message" }));

    expect(await screen.findByRole("alert", { name: "Harness request failed" })).toHaveTextContent(/could not be verified.*parent chat remains selected/i);
    expect(store.getSnapshot().navigation.selectedChatId).toBe("chat-1");
    expect(Object.keys(store.getSnapshot().sessions)).toEqual(["session-1"]);
    expect(branchSpy).toHaveBeenCalledTimes(2);
    branchSpy.mockRestore();
    loadSpy.mockRestore();
  }, 20_000);

  it("keeps renderer-owned Harness navigation out of the Harness adapter", async () => {
    const operations: StudioOperation[] = [];
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(),
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

    expect(await screen.findByRole("alert", { name: "System operation failed" })).toHaveTextContent(/Undo|execCommand/i);
  });

  it("binds Retry to the same dispatcher operation and removes it after an unavailable settlement", async () => {
    const operations: StudioOperation[] = [];
    const adapter: HarnessInspectorAdapter = {
      ...conversationAdapter(operations),
      execute: async (operation) => {
        operations.push(operation);
        return operations.length === 1
          ? { status: "rejected", reason: "Model update can be retried.", retryable: true }
          : { status: "unavailable", reason: "Model authority is now unavailable." };
      },
    };
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(),
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    await userEvent.click(await screen.findByRole("button", { name: "Use Verified model" }));
    const toast = await screen.findByRole("alert", { name: "Harness request failed" });
    await userEvent.click(within(toast).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(toast).toHaveTextContent("Model authority is now unavailable."));
    expect(within(toast).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(operations).toHaveLength(2);
    expect(operations[0]?.operationId).toBeTruthy();
    expect(operations[1]?.operationId).toBe(operations[0]?.operationId);
  }, 15_000);

  it("routes an admitted prompt through its operation identity and never offers Retry after uncertain transport reconciliation", async () => {
    const directCommand = vi.spyOn(rpc, "sendHarnessCommand").mockRejectedValue(new Error("uncertain direct command transport"));
    const promptOperations: StudioOperation[] = [];
    const adapter: HarnessInspectorAdapter = {
      ...conversationAdapter([]),
      execute: async (operation) => {
        if (operation.action === "harness.session.prompt") {
          promptOperations.push(operation);
          throw new Error("Harness operation failed: deadline_exceeded");
        }
        return { status: "updated", revision: 1 };
      },
    };
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(),
      sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["session_input_admission", "model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await userEvent.type(composer, "perform this mutation once");
    fireEvent.keyDown(composer, { key: "Enter" });

    const toast = await screen.findByRole("alert", { name: "Harness request outcome unknown" });
    expect(within(toast).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(promptOperations).toHaveLength(1);
    expect(promptOperations[0]?.operationId).toMatch(/^[!-~]{1,128}$/u);
    expect(directCommand).not.toHaveBeenCalled();

    act(() => store.dispatch({ type: "harness/session-projected", session: {
      ...rootSession,
      cursor: { ...rootSession.cursor, sequence: rootSession.cursor.sequence + 1 },
      parentMessages: [...rootSession.parentMessages, { channel: "parent", kind: "user", id: "u-reconciled", text: "perform this mutation once", emittedAtMs: 3 }],
    } }));
    expect(within(toast).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(promptOperations).toHaveLength(1);
    directCommand.mockRestore();
  }, 15_000);

  it("reuses the exact admitted prompt operation identity after a safe retryable rejection", async () => {
    const directCommand = vi.spyOn(rpc, "sendHarnessCommand").mockRejectedValue(new Error("direct command path must stay closed"));
    const promptOperations: StudioOperation[] = [];
    const adapter: HarnessInspectorAdapter = {
      ...conversationAdapter([]),
      execute: async (operation) => {
        if (operation.action !== "harness.session.prompt") return { status: "updated", revision: 1 };
        promptOperations.push(operation);
        return promptOperations.length === 1
          ? { status: "rejected", reason: "Cursor changed before admission.", retryable: true }
          : { status: "accepted", commandId: operation.operationId! };
      },
    };
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["session_input_admission", "model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await userEvent.type(composer, "retry only if safe");
    fireEvent.keyDown(composer, { key: "Enter" });
    const toast = await screen.findByRole("alert", { name: "Harness request failed" });
    await userEvent.clear(composer);
    await userEvent.type(composer, "new draft written after rejection");
    await userEvent.click(within(toast).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(promptOperations).toHaveLength(2));
    expect(promptOperations[0]?.operationId).toMatch(/^[!-~]{1,128}$/u);
    expect(promptOperations[1]?.operationId).toBe(promptOperations[0]?.operationId);
    expect(promptOperations[1]?.payload).toEqual(promptOperations[0]?.payload);
    expect(composer).toHaveValue("new draft written after rejection");
    expect(directCommand).not.toHaveBeenCalled();
    directCommand.mockRestore();
  }, 30_000);

  it("does not erase an ABA-authored draft when a safe Retry settles after edit-away and edit-back", async () => {
    const settlement = deferred<StudioOperationOutcome>();
    let prompts = 0;
    const adapter: HarnessInspectorAdapter = {
      ...conversationAdapter([]),
      execute: async (operation) => {
        if (operation.action !== "harness.session.prompt") return { status: "updated", revision: 1 };
        prompts += 1;
        return prompts === 1
          ? { status: "rejected", reason: "Safe to retry.", retryable: true }
          : settlement.promise;
      },
    };
    const store = createStudioStore(initialStudioState({
      projectCatalog: catalogBoundToRootSession(), sessions: [rootSession],
      compatibility: { status: "ready", profile: "verified", capabilities: ["session_input_admission", "model_catalog"] },
    }));
    store.dispatch({ type: "chat/open", chatId: chat.id });
    render(<AppProviders store={store}><StudioApp harnessAdapter={adapter} /></AppProviders>);

    const composer = screen.getByRole("textbox", { name: "Message Prime Studio" });
    await userEvent.type(composer, "same visible text");
    fireEvent.keyDown(composer, { key: "Enter" });
    const toast = await screen.findByRole("alert", { name: "Harness request failed" });
    await userEvent.click(within(toast).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(prompts).toBe(2));

    await userEvent.clear(composer);
    await userEvent.type(composer, "different authored draft");
    await userEvent.clear(composer);
    await userEvent.type(composer, "same visible text");
    await act(async () => settlement.resolve({ status: "accepted", commandId: "stable-command" }));

    expect(composer).toHaveValue("same visible text");
  }, 15_000);
});
