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
