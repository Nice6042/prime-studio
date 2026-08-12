import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ResidentBindingRecovery } from "./ResidentBindingRecovery";

describe("ResidentBindingRecovery", () => {
  it("offers visible retry and rollback actions for a preserved unbound chat", async () => {
    const onRetry = vi.fn();
    const onRollback = vi.fn();
    render(<ResidentBindingRecovery reason="The resident bind failed." pending={false} onRetry={onRetry} onRollback={onRollback} />);

    expect(screen.getByRole("alert")).toHaveTextContent("The resident bind failed.");
    await userEvent.click(screen.getByRole("button", { name: "Retry resident binding" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove unbound chat" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRollback).toHaveBeenCalledOnce();
  });
});
