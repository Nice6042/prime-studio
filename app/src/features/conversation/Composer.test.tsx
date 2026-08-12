import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("honors token-estimate visibility while keeping voice explicitly unavailable", () => {
    render(<Composer
      draft="A bounded draft"
      state={{ kind: "idle", draft: "A bounded draft", canSend: true }}
      showTokenEstimate={false}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);

    expect(screen.queryByTitle("Approximate draft tokens")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voice input" })).toBeDisabled();
  });

  it("closes the thinking menu with Escape and restores its trigger", async () => {
    render(<Composer
      draft=""
      state={{ kind: "idle", draft: "", canSend: false }}
      thinking="low"
      thinkingLevels={["low", "high"]}
      onSelectThinking={vi.fn()}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);
    const trigger = screen.getByRole("button", { name: "Thinking low" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Thinking level" })).toBeVisible();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Thinking level" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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

  it("navigates slash choices from the keyboard without submitting the draft", () => {
    const onSlashCommand = vi.fn();
    render(<Composer
      draft="/co"
      state={{ kind: "idle", draft: "/co", canSend: true }}
      slashCommands={deriveSlashCommands({ model: false, effort: false, compact: true, fork: false, new: false, usage: false, export: false })}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
      onSlashCommand={onSlashCommand}
    />);

    const input = screen.getByRole("textbox", { name: "Message Prime Studio" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "slash-option-compact");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith("compact");
  });

  it("shows the active keyboard slash choice with its selected state", () => {
    render(<Composer
      draft="/co"
      state={{ kind: "idle", draft: "/co", canSend: true }}
      slashCommands={deriveSlashCommands({ model: false, effort: false, compact: true, fork: false, new: false, usage: false, export: false })}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
      onSlashCommand={vi.fn()}
    />);

    const option = screen.getByRole("option", { name: /\/compact/i });
    expect(option).toHaveAttribute("aria-selected", "true");
  });

  it("offers the verified model catalog with accessible selection", async () => {
    const onSelectModel = vi.fn();
    render(<Composer
      draft=""
      state={{ kind: "idle", draft: "", canSend: false }}
      models={[
        { id: "model-a", label: "Model A", enabled: true },
        { id: "model-b", label: "Model B", enabled: false, disabledReason: "Not admitted" },
      ]}
      selectedModel="model-a"
      onSelectModel={onSelectModel}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Choose model Model A" }));
    expect(screen.getByRole("menu", { name: "Verified models" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Model A" }));
    expect(onSelectModel).toHaveBeenCalledWith("model-a");
  });

  it("uses menu-button keyboard navigation and restores focus when the model catalog closes", async () => {
    render(<Composer
      draft=""
      state={{ kind: "idle", draft: "", canSend: false }}
      models={[
        { id: "model-a", label: "Model A", enabled: true },
        { id: "model-b", label: "Model B", enabled: false, disabledReason: "Not admitted" },
        { id: "model-c", label: "Model C", enabled: true },
      ]}
      selectedModel="model-a"
      onSelectModel={vi.fn()}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />);

    const trigger = screen.getByRole("button", { name: "Choose model Model A" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Model A" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Model C" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitemradio", { name: "Model A" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitemradio", { name: "Model C" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
