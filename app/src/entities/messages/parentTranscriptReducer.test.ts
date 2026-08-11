import { describe, expect, it } from "vitest";

import type { ParentMessage } from "../../shared/ipc/harness.generated";
import {
  MAX_PARENT_MESSAGES,
  createEmptyParentTranscript,
  reduceParentTranscript,
} from "./parentTranscriptReducer";

const user = (id: string, text = id): ParentMessage => ({
  channel: "parent",
  kind: "user",
  id,
  text,
  emittedAtMs: 1,
});

describe("parent transcript reducer", () => {
  it("rejects child-channel content at the center-chat boundary", () => {
    const initial = createEmptyParentTranscript();
    const result = reduceParentTranscript(initial, {
      type: "message",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      message: { channel: "child", kind: "reasoning", id: "secret", text: "must not render" } as never,
    });

    expect(result).toBe(initial);
  });

  it("accepts only strictly increasing cursors and replaces a streaming message by identity", () => {
    const first = reduceParentTranscript(createEmptyParentTranscript(), {
      type: "snapshot",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      messages: [user("u1")],
      omittedBefore: 0,
    });
    const duplicate = reduceParentTranscript(first, {
      type: "message",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      message: user("ignored"),
    });
    const streamed = reduceParentTranscript(first, {
      type: "message",
      cursor: { runtimeGeneration: "g1", sequence: 2 },
      message: { channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "hel" }], streaming: true, emittedAtMs: 2 },
    });
    const completed = reduceParentTranscript(streamed, {
      type: "message",
      cursor: { runtimeGeneration: "g1", sequence: 3 },
      message: { channel: "parent", kind: "assistant", id: "a1", blocks: [{ kind: "text", text: "hello" }], streaming: false, emittedAtMs: 3 },
    });

    expect(duplicate).toBe(first);
    expect(completed.messages).toHaveLength(2);
    expect(completed.messages[1]).toMatchObject({ id: "a1", streaming: false });
  });

  it("keeps at most the latest bounded parent messages with truthful omission", () => {
    const messages = Array.from({ length: MAX_PARENT_MESSAGES + 17 }, (_, index) => user(`u${index}`));
    const state = reduceParentTranscript(createEmptyParentTranscript(), {
      type: "snapshot",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      messages,
      omittedBefore: 4,
    });

    expect(state.messages).toHaveLength(MAX_PARENT_MESSAGES);
    expect(state.messages[0]?.id).toBe("u17");
    expect(state.omittedBefore).toBe(21);
  });

  it("clips hostile text while preserving a truthful clipped flag", () => {
    const state = reduceParentTranscript(createEmptyParentTranscript(), {
      type: "snapshot",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      messages: [user("u1", "x".repeat(200_000))],
      omittedBefore: 0,
    });

    expect(state.messages[0]?.kind === "user" && state.messages[0].text.length).toBeLessThanOrEqual(131_072);
    expect(state.payloadClipped).toBe(true);
  });

  it("bounds aggregate resident text instead of granting the cap to every message", () => {
    const state = reduceParentTranscript(createEmptyParentTranscript(), {
      type: "snapshot",
      cursor: { runtimeGeneration: "g1", sequence: 1 },
      messages: Array.from({ length: 200 }, (_, index) => user(`u${index}`, "x".repeat(2_000))),
      omittedBefore: 0,
    });
    const residentCharacters = state.messages.reduce(
      (total, message) => total + (message.kind === "assistant"
        ? message.blocks.reduce((blockTotal, block) => blockTotal + (block.kind === "text" ? block.text.length : 0), 0)
        : message.text.length),
      0,
    );

    expect(residentCharacters).toBeLessThanOrEqual(131_072);
    expect(state.payloadClipped).toBe(true);
  });

  it("rejects malformed cursors without advancing chronology", () => {
    const initial = createEmptyParentTranscript();
    const result = reduceParentTranscript(initial, {
      type: "snapshot",
      cursor: { runtimeGeneration: "g1", sequence: Number.NaN },
      messages: [user("u1")],
      omittedBefore: 0,
    });
    expect(result).toBe(initial);
  });
});
