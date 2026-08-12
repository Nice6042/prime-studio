import { describe, expect, it } from "vitest";

import {
  appendDisplayVersion,
  createConversationDisplay,
  reconcileParentDisplay,
  selectDisplayVersion,
} from "./conversationDisplay";

describe("conversation display versions", () => {
  it("appends a user edit without rewriting the source version or prior state", () => {
    const initial = reconcileParentDisplay(createConversationDisplay(), [
      { channel: "parent", kind: "user", id: "u1", text: "Original prompt", emittedAtMs: 1 },
    ]);

    const edited = appendDisplayVersion(initial, "u1", "user", "Edited prompt");

    expect(initial.messages.u1).toEqual({ kind: "user", versions: [{ text: "Original prompt" }], selected: 0 });
    expect(edited.messages.u1).toEqual({
      kind: "user",
      versions: [{ text: "Original prompt" }, { text: "Edited prompt" }],
      selected: 1,
    });
    expect(Object.isFrozen(edited.messages.u1?.versions)).toBe(true);
  });

  it("keeps completed assistant alternatives selectable while ignoring streaming deltas", () => {
    const streaming = reconcileParentDisplay(createConversationDisplay(), [{
      channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "Part" }], streaming: true, emittedAtMs: 2,
    }]);
    const first = reconcileParentDisplay(streaming, [{
      channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "First answer" }], streaming: false, emittedAtMs: 2,
    }]);
    const second = reconcileParentDisplay(first, [{
      channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "Second answer" }], streaming: false, emittedAtMs: 3,
    }]);
    const selected = selectDisplayVersion(second, "a1", "assistant", 0);

    expect(streaming.messages.a1).toBeUndefined();
    expect(second.messages.a1).toEqual({
      kind: "assistant",
      versions: [{ text: "First answer" }, { text: "Second answer" }],
      selected: 1,
    });
    expect(selected.messages.a1?.selected).toBe(0);
    expect(second.messages.a1?.selected).toBe(1);
  });

  it("rejects kind mismatches, duplicates, and out-of-range selection", () => {
    const initial = reconcileParentDisplay(createConversationDisplay(), [
      { channel: "parent", kind: "user", id: "u1", text: "Prompt", emittedAtMs: 1 },
    ]);

    expect(appendDisplayVersion(initial, "u1", "assistant", "Wrong kind")).toBe(initial);
    expect(appendDisplayVersion(initial, "u1", "user", "Prompt")).toBe(initial);
    expect(selectDisplayVersion(initial, "u1", "user", 4)).toBe(initial);
  });
});
