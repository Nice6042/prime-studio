import { describe, expect, it } from "vitest";

import { createInitialProjectChatState, transitionProjectChatState } from "../../domain/projectChats";
import { initialStudioState, reduceStudio } from "./store";

function catalogWithChat() {
  const result = transitionProjectChatState(createInitialProjectChatState(), { type: "chat.create", projectId: "project:personal", chatId: "chat:one", title: "Canvas chat" });
  if (result.status !== "applied") throw new Error("test catalog creation failed");
  return result.state;
}

describe("Canvas persistence hydration", () => {
  it("hydrates a fresh store from exact durable chat-message revisions", () => {
    const initial = initialStudioState({ projectCatalog: catalogWithChat() });
    const hydrated = reduceStudio(initial, { type: "conversation/canvas-loaded", records: [
      { chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "persisted" },
    ] });
    expect(hydrated.canvasRevisions).toEqual({ "chat:one": { "answer:one": { revision: 2, sourceContent: "original", content: "persisted" } } });
  });

  it("fails closed on unknown chats, duplicate keys, invalid revisions, and controls", () => {
    const initial = initialStudioState({ projectCatalog: catalogWithChat() });
    for (const records of [
      [{ chatId: "chat:missing", messageId: "answer:one", revision: 2, sourceContent: "original", content: "x" }],
      [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "x" }, { chatId: "chat:one", messageId: "answer:one", revision: 3, sourceContent: "original", content: "y" }],
      [{ chatId: "chat:one", messageId: "answer:one", revision: 1, sourceContent: "original", content: "x" }],
      [{ chatId: "chat:one", messageId: "answer:\u0000one", revision: 2, sourceContent: "original", content: "x" }],
      [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "hostile \u202e source", content: "x" }],
      [{ chatId: "chat:one", messageId: "answer:one", revision: 2, sourceContent: "original", content: "hostile \u202e content" }],
    ]) {
      expect(reduceStudio(initial, { type: "conversation/canvas-loaded", records })).toBe(initial);
    }
  });
});
