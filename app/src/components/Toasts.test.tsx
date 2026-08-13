import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { enqueueToast, removeToastAction, type StudioToast } from "./toastQueue";
import { Toasts } from "./Toasts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function failure(actionId = "operation-1") {
  return enqueueToast([], {
    owner: "studio_durable",
    scope: "workspace.switch",
    severity: "error",
    title: "Studio data operation failed",
    message: "Workspace switching failed.",
    action: { id: actionId, label: "Retry", action: "workspace.switch" },
  });
}

function Harness({
  initial,
  retry,
  execute,
}: {
  readonly initial: readonly StudioToast[];
  readonly retry: (actionId: string) => Promise<StudioOperationOutcome>;
  readonly execute: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
}) {
  const [toasts, setToasts] = useState(initial);
  return <>
    <button type="button">Outside control</button>
    <Toasts toasts={toasts} retry={async (actionId) => {
      const outcome = await retry(actionId);
      setToasts((current) => current.slice(1));
      return outcome;
    }} execute={async (operation) => {
      const outcome = await execute(operation);
      if (operation.action === "toast.dismiss") {
        setToasts((current) => current.filter((toast) => toast.id !== operation.payload.toastId));
      }
      return outcome;
    }} />
  </>;
}

function RetainedHarness({ retry }: { readonly retry: (actionId: string) => Promise<StudioOperationOutcome> }) {
  return <>
    <button type="button">Outside control</button>
    <Toasts
      toasts={failure()}
      retry={retry}
      execute={async () => ({ status: "updated", revision: 1 })}
    />
  </>;
}

function AdvancingHarness() {
  const [toasts, setToasts] = useState(() => enqueueToast(failure("operation-1"), {
    owner: "studio_durable",
    scope: "workspace.switch",
    severity: "error",
    title: "Studio data operation failed",
    message: "Another workspace switch failed.",
    action: { id: "operation-2", label: "Retry", action: "workspace.switch" },
  }));
  return <Toasts
    toasts={toasts}
    retry={async (actionId) => {
      setToasts((current) => removeToastAction(current, current[0]!, actionId));
      return { status: "updated", revision: 1 };
    }}
    execute={async () => ({ status: "updated", revision: 1 })}
  />;
}

describe("typed toasts", () => {
  it("routes toast.dismiss through the dispatcher and hands focus to a safe outside control", async () => {
    const operations: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<Harness
      initial={failure()}
      retry={async () => ({ status: "updated", revision: 1 })}
      execute={async (operation) => {
        operations.push(operation);
        return { status: "updated", revision: 1 };
      }}
    />);

    const dismiss = screen.getByRole("button", { name: "Dismiss Studio data operation failed" });
    dismiss.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(operations).toEqual([{ action: "toast.dismiss", payload: { toastId: expect.any(String) } }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Outside control" })).toHaveFocus());
  });

  it("async settlement does not steal focus if the user moved outside the resolving toast", async () => {
    const settlement = deferred<StudioOperationOutcome>();
    const user = userEvent.setup();
    render(<Harness
      initial={failure()}
      retry={() => settlement.promise}
      execute={async () => ({ status: "updated", revision: 1 })}
    />);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    expect(outside).toHaveFocus();

    await act(async () => settlement.resolve({ status: "updated", revision: 2 }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(outside).toHaveFocus();
  });

  it("hands focus off when a nonretryable settlement removes the focused Retry", async () => {
    const user = userEvent.setup();
    render(<Harness
      initial={failure()}
      retry={async () => ({ status: "rejected", reason: "Stale operation.", retryable: false })}
      execute={async () => ({ status: "updated", revision: 1 })}
    />);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Outside control" })).toHaveFocus());
  });

  it("keeps a retained retryable action keyboard-focused without native disabling", async () => {
    const settlement = deferred<StudioOperationOutcome>();
    const user = userEvent.setup();
    render(<RetainedHarness retry={() => settlement.promise} />);
    const retry = screen.getByRole("button", { name: "Retry" });

    await user.click(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();
    await act(async () => settlement.resolve({ status: "rejected", reason: "Retry again.", retryable: true }));

    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "false"));
    expect(retry).toHaveFocus();
  });

  it("hands focus to the next distinct coalesced action when the first settles", async () => {
    const user = userEvent.setup();
    render(<AdvancingHarness />);
    const first = screen.getByRole("button", { name: "Retry (2)" });
    await user.click(first);

    const next = await screen.findByRole("button", { name: "Retry" });
    expect(next).not.toBe(first);
    await waitFor(() => expect(next).toHaveFocus());
  });

  it("cancels deferred focus handoff when the user moves after settlement but before animation frame", async () => {
    const settlement = deferred<StudioOperationOutcome>();
    let frame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const user = userEvent.setup();
    const anotherToast = enqueueToast(failure(), {
      owner: "runtime",
      scope: "another-failure",
      severity: "error",
      title: "Another failure",
      message: "This toast remains visible.",
    });
    render(<Harness
      initial={anotherToast}
      retry={() => settlement.promise}
      execute={async () => ({ status: "updated", revision: 1 })}
    />);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => settlement.resolve({ status: "updated", revision: 2 }));
    await waitFor(() => expect(frame).toBeDefined());
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    act(() => frame?.(performance.now()));

    expect(outside).toHaveFocus();
    expect(screen.getByRole("alert", { name: "Another failure" })).toBeInTheDocument();
    requestFrame.mockRestore();
  });

  it("auto-dismisses passive status at 2.4 seconds through toast.dismiss", async () => {
    vi.useFakeTimers();
    const operations: StudioOperation[] = [];
    const status = enqueueToast([], {
      owner: "runtime",
      scope: "runtime.connected",
      severity: "success",
      title: "Runtime connected",
      message: "Prime is ready.",
    }, Date.now());
    render(<Harness
      initial={status}
      retry={async () => ({ status: "updated", revision: 1 })}
      execute={async (operation) => {
        operations.push(operation);
        return { status: "updated", revision: 1 };
      }}
    />);

    expect(screen.getByRole("status", { name: "Runtime connected" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2_399));
    expect(operations).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(operations).toEqual([{ action: "toast.dismiss", payload: { toastId: status[0]!.id } }]);
    vi.useRealTimers();
  });
});
