import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("uses canonical desktop menus and dispatches exact Studio operations", async () => {
    const onCommand = vi.fn();
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "File" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
    expect(onCommand).toHaveBeenCalledWith("chat.new");
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Toggle Harness" }));
    expect(onCommand).toHaveBeenCalledWith("inspector.toggle");
    await userEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(onCommand).toHaveBeenCalledWith("window.close");
  });

  it("derives the complete executable menu from registered command placements", async () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />);
    const expected = {
      File: ["New chat", "Settings"],
      Edit: ["Undo", "Redo"],
      View: ["Toggle sidebar", "Toggle Harness"],
      Window: ["Minimize", "Maximize"],
      Help: ["Prime Agent documentation", "Support"],
    } as const;
    for (const [menu, items] of Object.entries(expected)) {
      await userEvent.click(screen.getByRole("button", { name: menu }));
      expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual(items);
      await userEvent.click(screen.getByRole("button", { name: menu }));
    }
  });

  it("opens and navigates enabled menu items with directional keys", async () => {
    const onCommand = vi.fn();
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={onCommand} />);
    const file = screen.getByRole("button", { name: "File" });

    file.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu", { name: "File menu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "New chat" })).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "New chat" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "New chat" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{Enter}");

    expect(onCommand).toHaveBeenCalledWith("settings.open");
    expect(screen.queryByRole("menu", { name: "File menu" })).not.toBeInTheDocument();
  });

  it("focuses the first enabled item when keyboard activation opens a menu", async () => {
    render(<TitleBar
      title="Harness architecture"
      availability={{ admissionConnected: true, disabledActions: { "catalog.chat.create": "Choose a default account first." } }}
      onCommand={vi.fn()}
    />);
    const file = screen.getByRole("button", { name: "File" });

    file.focus();
    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("menuitem", { name: "New chat" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(file).toHaveFocus();
  });

  it("moves keyboard focus into a menu that pointer activation already opened", async () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />);
    const file = screen.getByRole("button", { name: "File" });

    await userEvent.click(file);
    expect(file).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");

    expect(screen.getByRole("menuitem", { name: "New chat" })).toHaveFocus();
  });

  it("switches sibling menus with Left and Right and restores the active trigger", async () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />);
    const file = screen.getByRole("button", { name: "File" });

    file.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    expect(screen.queryByRole("menu", { name: "File menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Edit menu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Undo" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { name: "View menu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Toggle sidebar" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menu", { name: "Edit menu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Undo" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  });

  it("keeps keyboard focus when pointer hover switches an open sibling menu", async () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />);
    const file = screen.getByRole("button", { name: "File" });
    const view = screen.getByRole("button", { name: "View" });

    file.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "New chat" })).toHaveFocus();
    await userEvent.hover(view);

    expect(screen.getByRole("menu", { name: "View menu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Toggle sidebar" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Toggle Harness" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(view).toHaveFocus();
  });

  it("uses one capability result to disable unavailable placements without dispatching", async () => {
    const onCommand = vi.fn();
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true, disabledActions: { "route.external-docs.open": "Documentation is unavailable." } }} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    const support = screen.getByRole("menuitem", { name: "Support" });
    expect(support).toBeDisabled();
    expect(support).toHaveAttribute("title", "Documentation is unavailable.");
    await userEvent.click(support);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("renders encoding-safe vector window controls", () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={() => undefined} />);
    for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).toHaveTextContent("");
    }
  });

  it("gives Escape to the open menu and restores its trigger", async () => {
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "File" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "File menu" })).toBeVisible();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "File menu" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
