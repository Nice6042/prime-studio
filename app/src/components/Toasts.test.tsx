import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import * as rpc from "../rpc";
import { Toasts } from "./Toasts";

vi.mock("../rpc", () => ({
  onError: vi.fn(),
  onStderr: vi.fn(),
}));

it("announces errors and lets keyboard users dismiss them", async () => {
  let reportError: ((text: string) => void) | undefined;
  vi.mocked(rpc.onError).mockImplementation((handler) => {
    reportError = handler;
    return vi.fn();
  });
  vi.mocked(rpc.onStderr).mockReturnValue(vi.fn());
  const user = userEvent.setup();
  render(<Toasts />);

  act(() => reportError?.("Prime disconnected"));

  expect(screen.getByRole("alert")).toHaveTextContent("Prime disconnected");
  const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
  dismiss.focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
