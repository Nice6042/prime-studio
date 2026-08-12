import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  it("searches commands, executes enabled results, and restores focus on close", async () => {
    const run = vi.fn();
    const close = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    render(<CommandPalette admissionConnected={false} onRun={run} onClose={close} restoreFocusTo={opener} />);

    const input = screen.getByRole("combobox", { name: "Search commands, chats, and messages" });
    expect(input).toHaveFocus();
    await userEvent.type(input, "settings");
    await userEvent.click(screen.getByRole("option", { name: /Open settings/ }));
    expect(run).toHaveBeenCalledWith("settings.open");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not execute disabled commands and explains why", async () => {
    const run = vi.fn();
    render(<CommandPalette admissionConnected={false} onRun={run} onClose={() => undefined} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Search commands, chats, and messages" }), "new chat");
    const option = screen.getByRole("option", { name: /New chat/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(option);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText("New chat activation is not connected yet.")).toBeVisible();
  });

  it("closes on Escape", async () => {
    const close = vi.fn();
    render(<CommandPalette admissionConnected={false} onRun={() => undefined} onClose={close} />);
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
  });

  it("groups bounded chat and parent-message search and executes the keyboard-selected result", async () => {
    const onOpenChat = vi.fn();
    const onOpenMessage = vi.fn();
    render(<CommandPalette admissionConnected={true} onRun={() => undefined} onClose={() => undefined}
      chats={[{ id: "chat-1", title: "Harness architecture", project: "Prime Studio" }]}
      messages={[{ id: "message-1", chatId: "chat-1", project: "Prime Studio", excerpt: "The adapter verifies runtime identity", channel: "parent" }]}
      onOpenChat={onOpenChat} onOpenMessage={onOpenMessage} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Search commands, chats, and messages" }), "runtime identity");
    expect(screen.getByRole("group", { name: "Messages" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onOpenMessage).toHaveBeenCalledWith("chat-1", "message-1");
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it("never indexes private child-agent transcripts", async () => {
    render(<CommandPalette admissionConnected={true} onRun={() => undefined} onClose={() => undefined}
      messages={[{ id: "private", chatId: "chat-1", project: "Prime Studio", excerpt: "private child secret", channel: "child" }]} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Search commands, chats, and messages" }), "private child secret");
    expect(screen.getByText("No results")).toBeVisible();
  });
});
