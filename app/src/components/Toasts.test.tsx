import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { enqueueToast, type StudioToast } from "./toastQueue";
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
      setToasts([]);
      return outcome;
    }} execute={async (operation) => {
      const outcome = await execute(operation);
      setToasts([]);
      return outcome;
    }} />
  </>;
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
