import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import { ParentConversation } from "./ParentConversation";

const session: RootSessionProjection = {
  sessionId: "session-1",
  accountId: null,
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

  it("opens and renders exact display-only Canvas revisions without exposing activity", async () => {
    const onOpenCanvas = vi.fn();
    const { rerender } = render(<ParentConversation title="Harness architecture" session={session} archived={false} onOpenCanvas={onOpenCanvas} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit answer in Canvas" }));
    expect(onOpenCanvas).toHaveBeenCalledWith("a1", "The adapter is versioned.");

    rerender(<ParentConversation title="Harness architecture" session={session} archived={false} onOpenCanvas={onOpenCanvas} displayRevisions={{ a1: { revision: 2, content: "The adapter remains versioned." } }} />);
    expect(screen.getByText("The adapter remains versioned.")).toBeVisible();
    expect(screen.queryByText("The adapter is versioned.")).not.toBeInTheDocument();
    expect(screen.getByText("Display revision 2")).toBeVisible();
  });
});
