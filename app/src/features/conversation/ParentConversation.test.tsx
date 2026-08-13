import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import { ParentConversation } from "./ParentConversation";

const session: RootSessionProjection = {
  sessionId: "session-1",
  accountId: null,
  provider: "openai-codex",
  projectId: "project:personal",
  chatId: "chat-1",
  cursor: { runtimeGeneration: "g1", sequence: 4 },
  state: "idle",
  parentMessages: [
    { channel: "parent", kind: "user", id: "u1", text: "Map the runtime", emittedAtMs: 1 },
    {
      channel: "parent",
      kind: "assistant",
      id: "a1",
      blocks: [
        { kind: "thinking", text: "private activity", redacted: false },
        { kind: "text", text: "The adapter is versioned." },
        { kind: "tool_call", toolCallId: "t1", toolId: "inspect", status: "succeeded" },
      ],
      streaming: false,
      emittedAtMs: 2,
    },
  ],
  children: [], queue: [], tools: [], resources: [],
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId: "session-1", cursor: { runtimeGeneration: "g1", sequence: 4 }, reason: "event_chronology_unavailable" },
  freshness: "live",
};

describe("ParentConversation", () => {
  it("renders the familiar parent chat while keeping reasoning and tools out of the center", () => {
    render(<ParentConversation title="Harness architecture" session={session} archived={false} />);

    expect(screen.getByRole("log", { name: "Harness architecture conversation" })).toBeVisible();
    expect(screen.getByText("Map the runtime")).toBeVisible();
    expect(screen.getByText("The adapter is versioned.")).toBeVisible();
    expect(screen.queryByText("private activity")).not.toBeInTheDocument();
    expect(screen.queryByText("inspect")).not.toBeInTheDocument();
  });

  it("states empty and archived truth without inventing a session", () => {
    const { rerender } = render(<ParentConversation title="New chat" session={null} archived={false} />);
    expect(screen.getByText("Start a conversation when the verified Harness is available.")).toBeVisible();

    rerender(<ParentConversation title="Archived chat" session={session} archived />);
    expect(screen.getByText("Archived chat. This conversation is read-only.")).toBeVisible();
  });

  it("removes project suggestions when the persisted preference is disabled", () => {
    render(<ParentConversation title="New chat" session={null} archived={false} showSuggestions={false} />);

    expect(screen.queryByRole("button", { name: "Explore this codebase" })).not.toBeInTheDocument();
    expect(screen.getByText("Start a conversation when the verified Harness is available.")).toBeVisible();
  });

  it("dispatches exactly one identity-and-revision-bound Canvas-open operation before rendering the Canvas", async () => {
    const executeOperation = vi.fn(async () => ({ status: "updated" as const, revision: 1 }));
    const { rerender } = render(<ParentConversation title="Harness architecture" canvasChatId="studio-chat-1" session={session} archived={false} onExecuteOperation={executeOperation} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit answer in Canvas" }));
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(executeOperation).toHaveBeenCalledWith({
      action: "conversation.canvas.open",
      payload: { chatId: "studio-chat-1", messageId: "a1", expectedRevision: 1, content: "The adapter is versioned." },
    });

    rerender(<ParentConversation title="Harness architecture" canvasChatId="studio-chat-1" session={session} archived={false} onExecuteOperation={executeOperation} displayRevisions={{ a1: { revision: 2, content: "The adapter remains versioned." } }} />);
    expect(screen.getByText("The adapter remains versioned.")).toBeVisible();
    expect(screen.queryByText("The adapter is versioned.")).not.toBeInTheDocument();
    expect(screen.getByText("Display revision 2")).toBeVisible();
  });

  it("routes each response copy through the shared operation executor with an identity-qualified control", async () => {
    const executeOperation = vi.fn(async () => ({ status: "updated" as const, revision: 1 }));
    const twoResponses: RootSessionProjection = {
      ...session,
      parentMessages: [
        ...session.parentMessages,
        { channel: "parent", kind: "assistant", id: "a2", blocks: [{ kind: "text", text: "A distinct answer." }], streaming: false, emittedAtMs: 3 },
      ],
    };
    render(<ParentConversation title="Harness architecture" canvasChatId="chat-1" session={twoResponses} archived={false} onExecuteOperation={executeOperation} />);

    expect(screen.getAllByRole("button", { name: /^Copy$/ })[0]).toHaveAttribute("data-control-id", "conversation-copy-a1");
    expect(screen.getAllByRole("button", { name: /^Edit answer in Canvas$/ })[0]).toHaveAttribute("data-control-id", "conversation-canvas-a1");
    expect(screen.getAllByRole("button", { name: /^Copy$/ })[1]).toHaveAttribute("data-control-id", "conversation-copy-a2");
    expect(screen.getAllByRole("button", { name: /^Edit answer in Canvas$/ })[1]).toHaveAttribute("data-control-id", "conversation-canvas-a2");

    await userEvent.click(screen.getAllByRole("button", { name: /^Copy$/ })[1]!);

    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(executeOperation).toHaveBeenCalledWith({
      action: "conversation.response.copy",
      payload: { messageId: "a2", text: "A distinct answer." },
    });
    expect(screen.getByText("Message copied.", { selector: "span[role=status]" })).toBeVisible();
  });

  it("reports copied only after an accepted copy outcome", async () => {
    const executeOperation = vi.fn(async () => ({ status: "accepted" as const, commandId: "copy-1" }));
    render(<ParentConversation title="Harness architecture" session={session} archived={false} onExecuteOperation={executeOperation} />);

    await userEvent.click(screen.getByRole("button", { name: /^Copy$/ }));

    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Message copied.", { selector: "span[role=status]" })).toBeVisible();
  });

  it.each([
    ["unavailable", { status: "unavailable" as const, reason: "Clipboard access is unavailable." }, "Clipboard access is unavailable."],
    ["rejected", { status: "rejected" as const, reason: "Clipboard permission was denied.", retryable: false }, "Clipboard permission was denied."],
    ["unknown", { status: "unknown_outcome" as const, operationId: "copy-1", reason: "Clipboard result could not be verified." }, "Clipboard result could not be verified."],
  ])("reports a truthful non-success message when copy is %s", async (_name, outcome, message) => {
    const executeOperation = vi.fn(async () => outcome);
    render(<ParentConversation title="Harness architecture" session={session} archived={false} onExecuteOperation={executeOperation} />);

    await userEvent.click(screen.getByRole("button", { name: /^Copy$/ }));

    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(screen.getByText(message, { selector: "span[role=status]" })).toBeVisible();
    expect(screen.queryByText("Message copied.", { selector: "span[role=status]" })).not.toBeInTheDocument();
  });

  it("routes versions, editing, branching, regeneration, work details, and edited files", async () => {
    const onEditUserMessage = vi.fn();
    const onBranchFrom = vi.fn();
    const onSelectUserVersion = vi.fn();
    const onSelectAssistantVersion = vi.fn();
    const onRegenerate = vi.fn();
    const onUndoEditedFiles = vi.fn();
    const onReviewEditedFiles = vi.fn();
    const onOpenEditedFile = vi.fn();
    render(<ParentConversation
      title="Harness architecture"
      session={session}
      archived={false}
      presentations={{
        u1: { userVersions: [{ text: "Map the runtime" }, { text: "Map every runtime" }], selectedUserVersion: 0 },
        a1: {
          assistantVersions: [{ text: "The adapter is versioned." }, { text: "The adapter is capability negotiated." }],
          selectedAssistantVersion: 0,
          workedFor: "12s",
          workSteps: ["Mapped the daemon protocol", "Validated the renderer boundary"],
          editedFiles: [{ path: "app/src/runtime.ts", additions: 18, deletions: 2 }],
        },
      }}
      onEditUserMessage={onEditUserMessage}
      onBranchFrom={onBranchFrom}
      onSelectUserVersion={onSelectUserVersion}
      onSelectAssistantVersion={onSelectAssistantVersion}
      onRegenerate={onRegenerate}
      onUndoEditedFiles={onUndoEditedFiles}
      onReviewEditedFiles={onReviewEditedFiles}
      onOpenEditedFile={onOpenEditedFile}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Next user version" }));
    expect(onSelectUserVersion).toHaveBeenCalledWith("u1", 1);
    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const edit = screen.getByRole("textbox", { name: "Edit message text" });
    await userEvent.clear(edit);
    await userEvent.type(edit, "Map the verified runtime");
    await userEvent.click(screen.getByRole("button", { name: "Send edited message" }));
    expect(onEditUserMessage).toHaveBeenCalledWith("u1", "Map the verified runtime");
    await userEvent.click(screen.getByRole("button", { name: "Branch chat from message" }));
    expect(onBranchFrom).toHaveBeenCalledWith("u1");
    await userEvent.click(screen.getByRole("button", { name: "Next assistant version" }));
    expect(onSelectAssistantVersion).toHaveBeenCalledWith("a1", 1);
    await userEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    expect(onRegenerate).toHaveBeenCalledWith("a1");
    await userEvent.click(screen.getByRole("button", { name: "Worked for 12s" }));
    expect(screen.getByText("Mapped the daemon protocol")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Undo edited files" }));
    await userEvent.click(screen.getByRole("button", { name: "Review edited files" }));
    await userEvent.click(screen.getByRole("button", { name: "Open app/src/runtime.ts" }));
    expect(onUndoEditedFiles).toHaveBeenCalledWith("a1");
    expect(onReviewEditedFiles).toHaveBeenCalledWith("a1");
    expect(onOpenEditedFile).toHaveBeenCalledWith("a1", "app/src/runtime.ts");
  }, 20_000);

  it("fills the composer from the canonical empty-state suggestions", async () => {
    const onSuggestionFill = vi.fn();
    render(<ParentConversation title="New chat" session={null} archived={false} onSuggestionFill={onSuggestionFill} />);
    await userEvent.click(screen.getByRole("button", { name: "Explore this codebase" }));
    expect(onSuggestionFill).toHaveBeenCalledWith("Explore this codebase and explain its architecture.");
  });

  it("bounds worked-for and edited-file disclosures without changing their claimed totals", async () => {
    const files = Array.from({ length: 66 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
    const steps = Array.from({ length: 66 }, (_, index) => `Step ${index}`);
    render(<ParentConversation title="Bounded" session={session} archived={false} presentations={{ a1: { workedFor: "1s", workSteps: steps, editedFiles: files } }} />);

    expect(screen.getByRole("region", { name: "Edited 66 files" })).toBeVisible();
    expect(screen.getByText("2 additional paths are not shown in this bounded view.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Worked for 1s" }));
    expect(screen.getByText("2 additional steps are not shown in this bounded view.")).toBeVisible();
  });

  it("disables edited-file controls when no identity-bound artifact callback exists", async () => {
    render(<ParentConversation title="No artifact authority" session={session} archived={false} presentations={{
      a1: { editedFiles: [{ path: "app/src/runtime.ts", additions: 1, deletions: 0 }] },
    }} />);

    const review = screen.getByRole("button", { name: "Review edited files" });
    const open = screen.getByRole("button", { name: "Open app/src/runtime.ts" });
    expect(review).toBeDisabled();
    expect(open).toBeDisabled();
    expect(review.title).toMatch(/identity-bound/i);
    expect(open.title).toMatch(/identity-bound/i);
    const reason = screen.getByText(/No identity-bound Harness artifact is available/i);
    expect(reason).toHaveAttribute("tabindex", "0");
    reason.focus();
    expect(reason).toHaveFocus();
    await userEvent.click(review);
    await userEvent.click(open);
  });

  it("describes only the missing edited-file authority when one callback exists", () => {
    const onOpenEditedFile = vi.fn();
    const { rerender } = render(<ParentConversation title="Open only" session={session} archived={false} presentations={{
      a1: { editedFiles: [{ path: "app/src/runtime.ts", additions: 1, deletions: 0 }] },
    }} onOpenEditedFile={onOpenEditedFile} />);

    expect(screen.getByRole("button", { name: "Review edited files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open app/src/runtime.ts" })).toBeEnabled();
    expect(screen.getByText(/No identity-bound Harness review action/i)).toBeVisible();
    expect(screen.queryByText(/No identity-bound Harness artifact is available/i)).not.toBeInTheDocument();

    rerender(<ParentConversation title="Review only" session={session} archived={false} presentations={{
      a1: { editedFiles: [{ path: "app/src/runtime.ts", additions: 1, deletions: 0 }] },
    }} onReviewEditedFiles={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Review edited files" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open app/src/runtime.ts" })).toBeDisabled();
    expect(screen.getByText(/No identity-bound Harness file-open action/i)).toBeVisible();
    expect(screen.queryByText(/No identity-bound Harness artifact is available/i)).not.toBeInTheDocument();
  });

  it("does not offer unavailable history paging without a Harness cursor", () => {
    render(<ParentConversation title="No history cursor" session={session} archived={false} />);

    expect(screen.queryByRole("button", { name: /load earlier messages/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/history page cursor/i)).not.toBeInTheDocument();
  });

  it("loads older parent turns with bounded chronology, focus, and scroll anchoring", async () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(<ParentConversation title="History" session={session} archived={false}
      history={{ status: "idle", sessionId: session.sessionId, snapshotCursor: session.cursor, messages: [] }}
      onLoadOlder={onLoadOlder} />);
    const log = screen.getByRole("log", { name: "History conversation" });
    let height = 500;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 90;

    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    height = 700;
    rerender(<ParentConversation title="History" session={session} archived={false}
      history={{ status: "available", sessionId: session.sessionId, snapshotCursor: session.cursor,
        messages: [{ channel: "parent", kind: "user", id: "older-1", text: "Earlier prompt", emittedAtMs: 0 }],
        totalMessages: 3, omittedBefore: 0, omittedAfter: 2, olderCursor: null, truncatedByBytes: false }}
      onLoadOlder={onLoadOlder} />);

    expect(log.scrollTop).toBe(290);
    const earlier = screen.getByText("Earlier prompt").closest("article");
    expect(earlier).toHaveFocus();
    expect(screen.getByText("Beginning of conversation · 3 messages")).toBeVisible();
  });

  it("keeps load-older keyboard accessible and states explicit unavailability", async () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(<ParentConversation title="History" session={session} archived={false}
      history={{ status: "idle", sessionId: session.sessionId, snapshotCursor: session.cursor, messages: [] }}
      onLoadOlder={onLoadOlder} />);
    const button = screen.getByRole("button", { name: "Load earlier messages" });
    expect(button).toHaveAttribute("data-control-id", "conversation-history-load-older");
    expect(button).toHaveAttribute("data-studio-action", "conversation.history.page");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    rerender(<ParentConversation title="History" session={session} archived={false}
      history={{ status: "unavailable", sessionId: session.sessionId, snapshotCursor: session.cursor, messages: [], reason: "The verified Harness could not prove an atomic older-history page for this snapshot." }}
      onLoadOlder={onLoadOlder} />);
    const reason = screen.getByText(/could not prove an atomic older-history page/i);
    expect(reason).toHaveAttribute("tabindex", "0");
    reason.focus();
    expect(reason).toHaveFocus();
  });

  it("does not apply a pending history anchor after navigating to another session", async () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(<ParentConversation title="History A" session={session} archived={false}
      history={{ status: "idle", sessionId: session.sessionId, snapshotCursor: session.cursor, messages: [] }}
      onLoadOlder={onLoadOlder} />);
    const log = screen.getByRole("log", { name: "History A conversation" });
    let height = 500;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
    log.scrollTop = 90;
    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));

    const sessionB: RootSessionProjection = {
      ...session,
      sessionId: "session-2",
      chatId: "chat-2",
      cursor: { runtimeGeneration: "g2", sequence: 1 },
      parentMessages: [
        { channel: "parent", kind: "user", id: "b1", text: "Session B prompt", emittedAtMs: 3 },
        { channel: "parent", kind: "assistant", id: "b2", blocks: [{ kind: "text", text: "Session B answer" }], streaming: false, emittedAtMs: 4 },
      ],
    };
    height = 900;
    rerender(<ParentConversation title="History B" session={sessionB} archived={false}
      history={{ status: "available", sessionId: sessionB.sessionId, snapshotCursor: sessionB.cursor, messages: [], totalMessages: 2, omittedBefore: 0, omittedAfter: 2, olderCursor: null, truncatedByBytes: false }}
      onLoadOlder={onLoadOlder} />);

    expect(log.scrollTop).toBe(90);
    expect(screen.getByText("Session B prompt").closest("article")).not.toHaveFocus();
  });

});
