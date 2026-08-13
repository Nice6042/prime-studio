import { describe, expect, it } from "vitest";

import { acceptAttachmentMetadata, composerSubmitAvailability, deriveComposerState, deriveSlashCommands, filterSlashCommands, keyboardComposerAction } from "./composerModel";

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
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false }, "ctrl-enter")).toBe("newline");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false }, "ctrl-enter")).toBe("submit");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: true, isComposing: false }, "ctrl-enter")).toBe("submit");
  });

  it("resolves configured submit and newline chords through the shared typed shortcut registry", () => {
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false }, "ctrl-enter")).toBe("newline");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false }, "ctrl-enter")).toBe("submit");
    expect(keyboardComposerAction({ key: "Enter", shiftKey: true, ctrlKey: false, metaKey: false, isComposing: false }, "ctrl-enter")).toBe("newline");
  });

  it("shares the exact submit availability used by the Composer and shortcut Settings row", () => {
    expect(composerSubmitAvailability({ kind: "idle", draft: "", canSend: false }, "")).toEqual({ enabled: false, reason: "Write a message before sending." });
    expect(composerSubmitAvailability({ kind: "idle", draft: "hello", canSend: true }, "hello")).toEqual({ enabled: true });
    expect(composerSubmitAvailability({ kind: "unavailable", reason: "Prompt admission is not connected.", draft: "hello" }, "hello")).toEqual({ enabled: false, reason: "Prompt admission is not connected." });
    expect(composerSubmitAvailability({ kind: "read_only", draft: "" }, "")).toEqual({ enabled: false, reason: "Archived conversations are read-only." });
  });

  it("enables slash commands only when their real route is available", () => {
    const commands = deriveSlashCommands({
      model: false,
      effort: false,
      compact: true,
      fork: false,
      new: true,
      usage: true,
      export: false,
    });

    expect(commands.find((command) => command.id === "compact")).toMatchObject({ enabled: true });
    expect(commands.find((command) => command.id === "model")).toMatchObject({
      enabled: false,
      unavailableReason: "The verified Harness did not provide a model catalog.",
    });
    expect(commands.find((command) => command.id === "fork")).toMatchObject({
      enabled: false,
      unavailableReason: "The verified Harness cannot branch this chat.",
    });
    expect(filterSlashCommands("/", commands)).toHaveLength(7);
  });

  it("bounds attachments and filters typed slash commands", () => {
    const accepted = acceptAttachmentMetadata([], Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, name: `file-${index}.txt`, size: 10, mediaType: "text/plain" })));
    expect(accepted.attachments).toHaveLength(8);
    expect(accepted.rejected).toBe(2);
    expect(filterSlashCommands("/us").map((command) => command.id)).toEqual(["usage"]);
  });
});
