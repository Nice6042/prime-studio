import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

describe("Composer", () => {
  it("keeps draft editing available while explaining why send is unavailable", () => {
    const onDraftChange = vi.fn();
    render(<Composer
      draft="Plan the adapter"
      state={{ kind: "unavailable", reason: "Prompt admission is not connected.", draft: "Plan the adapter" }}
      onDraftChange={onDraftChange}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);

    expect(screen.getByRole("textbox", { name: "Message Prime Studio" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Prompt admission is not connected.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Prime Studio" }), { target: { value: "Updated" } });
    expect(onDraftChange).toHaveBeenCalledWith("Updated");
  });

  it("submits with Enter, inserts a newline with Shift+Enter, and opens usage from slash command", () => {
    const onSubmit = vi.fn();
    const onOpenUsage = vi.fn();
    const view = render(<Composer
      draft="Hello"
      state={{ kind: "idle", draft: "Hello", canSend: true }}
      onDraftChange={vi.fn()}
      onSubmit={onSubmit}
      onAbort={vi.fn()}
      onOpenUsage={onOpenUsage}
    />);
    const textbox = screen.getByRole("textbox", { name: "Message Prime Studio" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    view.rerender(<Composer
      draft="/usage"
      state={{ kind: "idle", draft: "/usage", canSend: true }}
      onDraftChange={vi.fn()}
      onSubmit={onSubmit}
      onAbort={vi.fn()}
      onOpenUsage={onOpenUsage}
    />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Prime Studio" }), { key: "Enter" });
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });
});
