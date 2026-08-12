import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";
import { deriveSlashCommands } from "./composerModel";

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

  it("honors the persisted Ctrl+Enter send preference", () => {
    const onSubmit = vi.fn();
    render(<Composer
      draft="Hello"
      state={{ kind: "idle", draft: "Hello", canSend: true }}
      sendShortcut="ctrl-enter"
      onDraftChange={vi.fn()}
      onSubmit={onSubmit}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);
    const textbox = screen.getByRole("textbox", { name: "Message Prime Studio" });

    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("omits model and thinking controls until verified choices are supplied", () => {
    render(<Composer
      draft=""
      state={{ kind: "idle", draft: "", canSend: false }}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);

    expect(screen.queryByText("Model unavailable")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Thinking/ })).not.toBeInTheDocument();
  });

  it("routes every enabled exact slash command and consumes the command draft", () => {
    const onDraftChange = vi.fn();
    const onSlashCommand = vi.fn();
    const commands = deriveSlashCommands({ model: true, effort: true, compact: true, fork: true, new: true, usage: true, export: true });
    const view = render(<Composer
      draft="/compact"
      state={{ kind: "idle", draft: "/compact", canSend: true }}
      slashCommands={commands}
      onDraftChange={onDraftChange}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
      onSlashCommand={onSlashCommand}
    />);

    for (const id of ["model", "effort", "compact", "fork", "new", "export"] as const) {
      view.rerender(<Composer
        draft={`/${id}`}
        state={{ kind: "idle", draft: `/${id}`, canSend: true }}
        slashCommands={commands}
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
        onAbort={vi.fn()}
        onOpenUsage={vi.fn()}
        onSlashCommand={onSlashCommand}
      />);
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Prime Studio" }), { key: "Enter" });
    }

    expect(onSlashCommand.mock.calls.map(([id]) => id)).toEqual(["model", "effort", "compact", "fork", "new", "export"]);
    expect(onDraftChange).toHaveBeenCalledWith("");
  });
});
