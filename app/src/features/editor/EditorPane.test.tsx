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
});
