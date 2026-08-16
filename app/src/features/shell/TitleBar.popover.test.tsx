import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

describe("TitleBar popover contract", () => {
  it("dismisses the active menu outside and leaves the clicked control focused", async () => {
    render(<div>
      <TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={vi.fn()} />
      <button type="button">Outside title bar</button>
    </div>);
    await userEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByRole("menu", { name: "File menu" })).toBeVisible();

    const outside = screen.getByRole("button", { name: "Outside title bar" });
    await userEvent.click(outside);

    expect(screen.queryByRole("menu", { name: "File menu" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("moves directly between title menus without dispatching an underlying command", async () => {
    const onCommand = vi.fn();
    render(<TitleBar title="Harness architecture" availability={{ admissionConnected: true }} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "File" }));
    await userEvent.hover(screen.getByRole("button", { name: "View" }));

    expect(screen.queryByRole("menu", { name: "File menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "View menu" })).toBeVisible();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
