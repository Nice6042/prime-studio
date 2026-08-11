import { describe, expect, it } from "vitest";

import { acceptAttachmentMetadata, deriveComposerState, filterSlashCommands, keyboardComposerAction } from "./composerModel";

const ready = {
  status: "ready" as const,
  profile: "fixture",
  capabilities: ["session_input_admission", "prompt_admission_cancellation", "queue_management"] as const,
};

describe("composer model", () => {
  it("fails closed until prompt admission is connected", () => {
    expect(deriveComposerState({ compatibility: ready, sessionState: "idle", archived: false, draft: "hello", phase: "idle", admissionConnected: false }))
      .toEqual({ kind: "unavailable", reason: "Prompt admission is not connected.", draft: "hello" });
  });

  it("derives idle, working, submitting, aborting, and archived states", () => {
    expect(deriveComposerState({ compatibility: ready, sessionState: "idle", archived: false, draft: "hello", phase: "idle", admissionConnected: true }))
      .toMatchObject({ kind: "idle", canSend: true });
    expect(deriveComposerState({ compatibility: ready, sessionState: "working", archived: false, draft: "follow up", phase: "idle", admissionConnected: true }))
      .toMatchObject({ kind: "working", canQueue: true, canSteer: true, canAbort: true });
    expect(deriveComposerState({ compatibility: ready, sessionState: "idle", archived: false, draft: "hello", phase: "submitting", admissionConnected: true }).kind).toBe("submitting");
    expect(deriveComposerState({ compatibility: ready, sessionState: "working", archived: false, draft: "", phase: "aborting", admissionConnected: true }).kind).toBe("aborting");
    expect(deriveComposerState({ compatibility: ready, sessionState: "idle", archived: true, draft: "lost", phase: "idle", admissionConnected: true }))
      .toEqual({ kind: "read_only", draft: "" });
  });

  it("respects Enter, modified Enter, Shift+Enter, and composition", () => {
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false })).toBe("submit");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false })).toBe("submit");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: true, ctrlKey: false, metaKey: false, isComposing: false })).toBe("newline");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: true })).toBe("newline");
  });

  it("bounds attachments and filters typed slash commands", () => {
    const accepted = acceptAttachmentMetadata([], Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, name: `file-${index}.txt`, size: 10, mediaType: "text/plain" })));
    expect(accepted.attachments).toHaveLength(8);
    expect(accepted.rejected).toBe(2);
    expect(filterSlashCommands("/us").map((command) => command.id)).toEqual(["usage"]);
  });
});
