import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("uses canonical desktop menus and dispatches exact Studio operations", async () => {
    const onOperation = vi.fn();
    render(<TitleBar title="Harness architecture" onOperation={onOperation} />);
    await userEvent.click(screen.getByRole("button", { name: "File" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
    expect(onOperation).toHaveBeenCalledWith({ action: "catalog.chat.create", payload: { projectId: "" } });
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Toggle Harness" }));
    expect(onOperation).toHaveBeenCalledWith({ action: "layout.inspector.toggle", payload: {} });
    await userEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(onOperation).toHaveBeenCalledWith({ action: "window.close", payload: {} });
  });

  it("renders encoding-safe vector window controls", () => {
    render(<TitleBar title="Harness architecture" onOperation={() => undefined} />);
    for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).toHaveTextContent("");
    }
  });
});
