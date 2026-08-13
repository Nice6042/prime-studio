import { describe, expect, it } from "vitest";

import { createEditorState, reduceEditorState } from "./editorStore";

describe("editor store", () => {
  const artifact = { brokerId: "broker-1", rootSessionId: "session-1", artifactId: "artifact-1", revision: 2 } as const;

  it("isolates bounded buffers by native-minted artifact identity", () => {
    let state = reduceEditorState(createEditorState(), { type: "artifact/open", ref: artifact, label: "src/App.tsx", content: "original", identity: "sha256:abc", writable: false });
    state = reduceEditorState(state, { type: "buffer/change", tabId: state.activeTabId!, content: "changed" });
    expect(state.tabs[0]).toMatchObject({ label: "src/App.tsx", dirty: true, writable: false, content: "changed" });
    expect(state.tabs[0]?.ref).toEqual(artifact);
  });

  it("rejects oversized content and stale save results", () => {
    let state = reduceEditorState(createEditorState(), { type: "artifact/open", ref: artifact, label: "file.txt", content: "a", identity: "sha256:abc", writable: true });
    const unchanged = reduceEditorState(state, { type: "buffer/change", tabId: state.activeTabId!, content: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(unchanged).toBe(state);
    state = reduceEditorState(state, { type: "buffer/change", tabId: state.activeTabId!, content: "b" });
    expect(reduceEditorState(state, { type: "save/succeeded", tabId: state.activeTabId!, expectedRevision: 1, revision: 3, identity: "sha256:def" })).toBe(state);
  });

  it("keeps Canvas display revisions separate from filesystem authority", () => {
    const state = reduceEditorState(createEditorState(), { type: "canvas/open", chatId: "chat-1", messageId: "message-1", displayRevision: 1, content: "draft" });
    expect(state.tabs[0]).toMatchObject({ kind: "canvas", writable: true, brokerRef: null });
  });

  it("restores a draft only for its exact resident session and artifact identity", () => {
    let state = reduceEditorState(createEditorState(), { type: "artifact/open", ref: artifact, label: "file.ts", content: "first", identity: "sha256:one", writable: true });
    state = reduceEditorState(state, { type: "buffer/change", tabId: state.activeTabId!, content: "first draft" });
    state = reduceEditorState(state, { type: "artifact/open", ref: { ...artifact, rootSessionId: "session-2" }, label: "file.ts", content: "second", identity: "sha256:two", writable: true });
    const artifacts = state.tabs.filter((tab) => tab.kind === "artifact");
    expect(artifacts.find((tab) => tab.ref.rootSessionId === "session-1")?.content).toBe("first draft");
    expect(artifacts.find((tab) => tab.ref.rootSessionId === "session-2")?.content).toBe("second");
  });
});
