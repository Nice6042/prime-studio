import { describe, expect, it } from "vitest";

import { routeSlashCommand } from "./conversationRouting";

const context = { chatId: "chat-1", sessionId: "session-1", messageId: "message-1" } as const;

describe("conversation slash routing", () => {
  it("maps every slash command to a real UI route or typed operation", () => {
    expect(routeSlashCommand("model", context)).toEqual({ kind: "model-picker" });
    expect(routeSlashCommand("effort", context)).toEqual({ kind: "effort-picker" });
    expect(routeSlashCommand("new", context)).toEqual({ kind: "new-chat" });
    expect(routeSlashCommand("usage", context)).toEqual({ kind: "usage" });
    expect(routeSlashCommand("compact", context)).toEqual({
      kind: "operation",
      operation: { action: "harness.session.compact", payload: { sessionId: "session-1" } },
    });
    expect(routeSlashCommand("fork", context)).toEqual({
      kind: "operation",
      operation: { action: "conversation.branch.create", payload: { sessionId: "session-1", messageId: "message-1" } },
    });
    expect(routeSlashCommand("export", context)).toEqual({
      kind: "operation",
      operation: { action: "harness.session.export", payload: { sessionId: "session-1", format: "html" } },
    });
  });

  it("does not invent session-bound routes when no exact root target exists", () => {
    expect(routeSlashCommand("compact", { chatId: "chat-1", sessionId: null, messageId: null })).toBeNull();
    expect(routeSlashCommand("fork", { chatId: "chat-1", sessionId: "session-1", messageId: null })).toBeNull();
    expect(routeSlashCommand("export", { chatId: "chat-1", sessionId: null, messageId: null })).toBeNull();
  });
});
