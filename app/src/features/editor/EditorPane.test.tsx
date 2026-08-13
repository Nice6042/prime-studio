import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { StudioOperation } from "../../contracts/studioOperations";
import type { ArtifactDocument } from "../../entities/editor/types";
import { EditorPane, type EditorMode } from "./EditorPane";

type EditorPaneProps = ComponentProps<typeof EditorPane>;

function ControlledEditorPane(props: Omit<EditorPaneProps, "documentId" | "mode" | "onExecute"> & {
  readonly initialMode?: EditorMode;
  readonly onExecute?: (operation: StudioOperation) => void;
}) {
  const { initialMode, onExecute, ...paneProps } = props;
  const [mode, setMode] = useState<EditorMode>(initialMode ?? (paneProps.artifact ? "diff" : "edit"));
  const documentId = paneProps.artifact
    ? JSON.stringify([paneProps.artifact.ref.brokerId, paneProps.artifact.ref.rootSessionId, paneProps.artifact.ref.artifactId, paneProps.artifact.ref.revision, paneProps.artifact.identity])
    : paneProps.canvas ? JSON.stringify(["canvas", paneProps.canvas.chatId, paneProps.canvas.messageId, paneProps.canvas.displayRevision]) : null;
  return <EditorPane
    {...paneProps}
    documentId={documentId}
    mode={mode}
    onExecute={async (operation) => {
      onExecute?.(operation);
      if (operation.action === "editor.mode.select") setMode(operation.payload.mode);
      return { status: "updated", revision: documentId ?? "empty" };
    }}
  />;
}

describe("EditorPane", () => {
  it("renders a truthful empty editor when no identity-bound artifact is selected", () => {
    render(<ControlledEditorPane onClose={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(screen.getByText(/No verified file or Canvas revision/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("edits Canvas presentation without claiming a filesystem save", async () => {
    const onCanvasApply = vi.fn();
    render(<ControlledEditorPane onClose={() => undefined} canvas={{ chatId: "chat-1", messageId: "message-1", displayRevision: 2, content: "Original answer" }} onCanvasApply={onCanvasApply} />);
    const editor = screen.getByRole("textbox", { name: "Canvas content" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Edited answer");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Apply display revision" }));
    expect(onCanvasApply).toHaveBeenCalledWith("Edited answer");
    expect(screen.getByText(/does not rewrite Harness history/)).toBeVisible();
  });

  it("switches an identity-bound artifact between structured diff and edit, then saves through its adapter", async () => {
    const onArtifactSave = vi.fn(async () => ({ kind: "saved" as const, revision: 8, identity: "sha256:new" }));
    render(<ControlledEditorPane onClose={() => undefined} artifact={{
      label: "src/app.ts", ref: { brokerId: "broker", rootSessionId: "root", artifactId: "artifact", revision: 7 },
      identity: "sha256:old", content: "const next = true;", writable: true,
      diff: [
        { kind: "delete", oldLine: 4, newLine: null, text: "const next = false;" },
        { kind: "add", oldLine: null, newLine: 4, text: "const next = true;" },
      ],
    }} onArtifactSave={onArtifactSave} />);
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("const next = false;")).toHaveAttribute("data-diff-kind", "delete");
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "File content" });
    await userEvent.type(editor, "\nexport default next;");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onArtifactSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7, expectedIdentity: "sha256:old", content: expect.stringContaining("export default") }));
    expect(await screen.findByText("Saved revision 8")).toBeVisible();
  });

  it("emits exactly one identity-bound mode operation without changing the admitted artifact", async () => {
    const operations: StudioOperation[] = [];
    const artifact = {
      label: "src/app.ts",
      ref: { brokerId: "broker", rootSessionId: "root", artifactId: "artifact", revision: 7 },
      identity: "sha256:old",
      content: "const next = true;",
      writable: true,
      diff: [],
    } as const;
    render(<ControlledEditorPane onClose={() => undefined} artifact={artifact} onExecute={(operation) => operations.push(operation)} />);

    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));

    expect(operations).toEqual([{
      action: "editor.mode.select",
      payload: {
        documentId: JSON.stringify(["broker", "root", "artifact", 7, "sha256:old"]),
        mode: "edit",
      },
    }]);
    expect(artifact).toEqual(expect.objectContaining({ ref: expect.objectContaining({ revision: 7 }), identity: "sha256:old" }));
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  });

  it("replaces content when a newly admitted identity reuses the same artifact ref and revision", async () => {
    const ref = { brokerId: "broker", rootSessionId: "root", artifactId: "artifact", revision: 7 } as const;
    const first = { label: "a.md", ref, identity: "sha256:first", content: "artifact A", writable: true, diff: [] } as const;
    const second = { label: "b.md", ref, identity: "sha256:second", content: "artifact B", writable: true, diff: [] } as const;
    const view = render(<ControlledEditorPane onClose={() => undefined} artifact={first} initialMode="edit" />);
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("artifact A");

    view.rerender(<ControlledEditorPane onClose={() => undefined} artifact={second} initialMode="edit" />);

    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("artifact B");
  });

  it("keeps the save acknowledgement when the parent echoes the committed revision", async () => {
    const artifact: ArtifactDocument = { label: "notes.md", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 1 }, identity: "sha256:first", content: "first", writable: true, diff: [] };
    const onArtifactSave = vi.fn(async () => ({ kind: "saved" as const, revision: 2, identity: "sha256:second" }));
    let view: ReturnType<typeof render>;
    const pane = (current: ArtifactDocument) => <ControlledEditorPane
      onClose={() => undefined}
      artifact={current}
      onArtifactSave={onArtifactSave}
      onArtifactSaved={(saved) => view.rerender(pane(saved))}
    />;
    view = render(pane(artifact));
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "File content" }), " changed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved revision 2")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps dirty content visible when the native save reports a conflict", async () => {
    const onArtifactReload = vi.fn(async () => ({ kind: "opened" as const, document: { label: "README.md", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 2 }, identity: "sha256:reloaded", content: "external", writable: true, diff: [], diffTruncated: false } }));
    const onArtifactSaveCopy = vi.fn(async () => ({ kind: "saved_copy" as const, label: "README.prime-copy.md" }));
    render(<ControlledEditorPane onClose={() => undefined} artifact={{ label: "README.md", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 1 }, identity: "old", content: "old", writable: true, diff: [] }}
      onArtifactSave={async () => ({ kind: "conflict", message: "The file changed on disk. Reopen it before saving." })}
      onArtifactReload={onArtifactReload}
      onArtifactSaveCopy={onArtifactSaveCopy} />);
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "File content" }), " changed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk");
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("old changed");
    expect(screen.getByRole("button", { name: "Reload from disk" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save a copy" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(onArtifactSaveCopy).toHaveBeenCalledWith(expect.objectContaining({ content: "old changed" }));
    expect(await screen.findByText("Saved copy as README.prime-copy.md")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    expect(onArtifactReload).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("external");
  });

  it("restores an artifact-scoped draft after the editor is unmounted", async () => {
    const drafts = new Map<string, string>();
    const artifact = { label: "notes.md", ref: { brokerId: "b", rootSessionId: "session-one", artifactId: "a", revision: 1 }, identity: "old", content: "original", writable: true, diff: [] } as const;
    const first = render(<ControlledEditorPane onClose={() => undefined} artifact={artifact} draftContent={drafts.get("draft")} onDraftChange={(content) => drafts.set("draft", content)} />);
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "File content" }), " retained");
    first.unmount();
    render(<ControlledEditorPane onClose={() => undefined} artifact={artifact} draftContent={drafts.get("draft")} onDraftChange={(content) => drafts.set("draft", content)} />);
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("original retained");
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2);
  });

  it("advances the expected native revision and identity after each exact save", async () => {
    const onArtifactSave = vi.fn()
      .mockResolvedValueOnce({ kind: "saved", revision: 2, identity: "sha256:second" })
      .mockResolvedValueOnce({ kind: "saved", revision: 3, identity: "sha256:third" });
    render(<ControlledEditorPane onClose={() => undefined} artifact={{ label: "notes.txt", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 1 }, identity: "sha256:first", content: "first", writable: true, diff: [] }} onArtifactSave={onArtifactSave} />);
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "File content" });
    await userEvent.type(editor, " second");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.type(editor, " third");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onArtifactSave).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRevision: 2,
      expectedIdentity: "sha256:second",
      content: "first second third",
    }));
  });
});
