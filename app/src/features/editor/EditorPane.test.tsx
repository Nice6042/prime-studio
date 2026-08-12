import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditorPane } from "./EditorPane";

describe("EditorPane", () => {
  it("renders a truthful empty editor when no identity-bound artifact is selected", () => {
    render(<EditorPane onClose={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(screen.getByText(/No verified file or Canvas revision/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("edits Canvas presentation without claiming a filesystem save", async () => {
    const onCanvasApply = vi.fn();
    render(<EditorPane onClose={() => undefined} canvas={{ chatId: "chat-1", messageId: "message-1", displayRevision: 2, content: "Original answer" }} onCanvasApply={onCanvasApply} />);
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
    render(<EditorPane onClose={() => undefined} artifact={{
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

  it("keeps dirty content visible when the native save reports a conflict", async () => {
    render(<EditorPane onClose={() => undefined} artifact={{ label: "README.md", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 1 }, identity: "old", content: "old", writable: true, diff: [] }}
      onArtifactSave={async () => ({ kind: "conflict", message: "The file changed on disk. Reopen it before saving." })} />);
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "File content" }), " changed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk");
    expect(screen.getByRole("textbox", { name: "File content" })).toHaveValue("old changed");
  });

  it("advances the expected native revision and identity after each exact save", async () => {
    const onArtifactSave = vi.fn()
      .mockResolvedValueOnce({ kind: "saved", revision: 2, identity: "sha256:second" })
      .mockResolvedValueOnce({ kind: "saved", revision: 3, identity: "sha256:third" });
    render(<EditorPane onClose={() => undefined} artifact={{ label: "notes.txt", ref: { brokerId: "b", rootSessionId: "s", artifactId: "a", revision: 1 }, identity: "sha256:first", content: "first", writable: true, diff: [] }} onArtifactSave={onArtifactSave} />);
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
