import { describe, expect, it } from "vitest";

import {
  MAX_EDITOR_BUFFER_CODE_UNITS,
  MAX_EDITOR_BUFFER_ENTRIES,
  MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS,
  artifactEditorDocumentId,
  canvasEditorDocumentId,
  createEditorBufferState,
  readEditorBuffer,
  removeEditorBuffer,
  writeEditorBuffer,
} from "./editorBufferStore";

describe("identity-keyed editor buffers", () => {
  it("binds file and Canvas buffers to their exact owning identities", () => {
    const artifact = artifactEditorDocumentId({
      label: "notes.md",
      ref: { brokerId: "broker", rootSessionId: "session-a", artifactId: "artifact", revision: 3 },
      identity: "sha256:exact",
      content: "native",
      writable: true,
      diff: [],
    });
    const canvasA = canvasEditorDocumentId({
      sessionId: "session-a",
      chatId: "chat",
      messageId: "message",
      sourceVersion: 0,
      displayRevision: 1,
    });
    const canvasB = canvasEditorDocumentId({
      sessionId: "session-b",
      chatId: "chat",
      messageId: "message",
      sourceVersion: 0,
      displayRevision: 1,
    });
    const canvasVersion = canvasEditorDocumentId({
      sessionId: "session-a",
      chatId: "chat",
      messageId: "message",
      sourceVersion: 1,
      displayRevision: 1,
    });

    expect(new Set([artifact, canvasA, canvasB, canvasVersion])).toHaveSize(4);

    let state = createEditorBufferState();
    state = writeEditorBuffer(state, artifact, "file draft");
    state = writeEditorBuffer(state, canvasA, "canvas draft");
    state = writeEditorBuffer(state, canvasB, "other session");
    state = writeEditorBuffer(state, canvasVersion, "other source version");

    expect(readEditorBuffer(state, artifact)).toBe("file draft");
    expect(readEditorBuffer(state, canvasA)).toBe("canvas draft");
    expect(readEditorBuffer(state, canvasB)).toBe("other session");
    expect(readEditorBuffer(state, canvasVersion)).toBe("other source version");
    expect(state.totalCodeUnits).toBe(
      "file draft".length
      + "canvas draft".length
      + "other session".length
      + "other source version".length,
    );
  });

  it("keeps a bounded recency order and evicts only the oldest identity", () => {
    let state = createEditorBufferState();
    for (let index = 0; index < MAX_EDITOR_BUFFER_ENTRIES; index += 1) {
      state = writeEditorBuffer(state, `document-${index}`, `draft-${index}`);
    }
    state = writeEditorBuffer(state, "document-0", "updated oldest");
    state = writeEditorBuffer(state, "document-new", "newest");

    expect(state.order).toHaveLength(MAX_EDITOR_BUFFER_ENTRIES);
    expect(readEditorBuffer(state, "document-0")).toBe("updated oldest");
    expect(readEditorBuffer(state, "document-1")).toBeUndefined();
    expect(readEditorBuffer(state, "document-new")).toBe("newest");
  });

  it("enforces a total memory budget in addition to the per-buffer cap", () => {
    const fullBuffer = "x".repeat(MAX_EDITOR_BUFFER_CODE_UNITS);
    let state = createEditorBufferState();
    const admitted = Math.floor(MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS / MAX_EDITOR_BUFFER_CODE_UNITS);
    for (let index = 0; index <= admitted; index += 1) {
      state = writeEditorBuffer(state, `large-${index}`, fullBuffer);
    }

    expect(state.totalCodeUnits).toBeLessThanOrEqual(MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS);
    expect(state.order).toHaveLength(admitted);
    expect(readEditorBuffer(state, "large-0")).toBeUndefined();
    expect(readEditorBuffer(state, `large-${admitted}`)).toHaveLength(MAX_EDITOR_BUFFER_CODE_UNITS);
  });

  it("preserves an intentional empty draft, bounds content without splitting a surrogate pair, and clears one identity", () => {
    let state = createEditorBufferState();
    state = writeEditorBuffer(state, "document-empty", "");
    state = writeEditorBuffer(
      state,
      "document-large",
      `${"x".repeat(MAX_EDITOR_BUFFER_CODE_UNITS - 1)}😀`,
    );

    expect(readEditorBuffer(state, "document-empty")).toBe("");
    const bounded = readEditorBuffer(state, "document-large")!;
    expect(bounded).toHaveLength(MAX_EDITOR_BUFFER_CODE_UNITS - 1);
    expect(bounded.endsWith("\ud83d")).toBe(false);

    const cleared = removeEditorBuffer(state, "document-empty");
    expect(readEditorBuffer(cleared, "document-empty")).toBeUndefined();
    expect(readEditorBuffer(cleared, "document-large")).toBe(bounded);
    expect(cleared.totalCodeUnits).toBe(bounded.length);
    expect(removeEditorBuffer(cleared, "document-empty")).toBe(cleared);
  });

  it("uses own properties so prototype names cannot forge a buffer", () => {
    let state = createEditorBufferState();
    expect(readEditorBuffer(state, "toString")).toBeUndefined();
    state = writeEditorBuffer(state, "toString", "owned draft");
    expect(readEditorBuffer(state, "toString")).toBe("owned draft");
    expect(Object.getPrototypeOf(state.values)).toBeNull();
  });

  it("rejects forged or unbounded internal document identities", () => {
    const state = createEditorBufferState();
    expect(() => writeEditorBuffer(state, "", "draft")).toThrow(TypeError);
    expect(() => writeEditorBuffer(state, "bad\nidentity", "draft")).toThrow(TypeError);
    expect(() => writeEditorBuffer(state, "x".repeat(2_049), "draft")).toThrow(TypeError);
    expect(() => readEditorBuffer(state, "bad\u007fidentity")).toThrow(TypeError);
  });
});
