import { describe, expect, it } from "vitest";

import {
  cancelBrowserOperation,
  completeBrowserOperation,
  createBrowserOperation,
  expireBrowserOperation,
  failBrowserOperation,
  recoverBrowserOperation,
} from "./lifecycle";

const inspectAction = {
  type: "selector",
  pageUrl: "https://example.com/settings",
  selector: "#status",
  operation: "inspect",
} as const;

describe("browser operation lifecycle", () => {
  it("starts a deterministic running operation with an explicit deadline", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });

    expect(state).toMatchObject({
      operationId: "operation-1",
      status: "running",
      attempt: 1,
      startedAtMs: 100,
      deadlineAtMs: 150,
    });
  });

  it("times out at the deadline and leaves an early observation running", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });

    expect(expireBrowserOperation(state, 149)).toMatchObject({ status: "running" });
    expect(expireBrowserOperation(state, 150)).toMatchObject({
      status: "timed_out",
      operationId: "operation-1",
    });
  });

  it("cancels a running operation with a visible reason", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });

    expect(cancelBrowserOperation(state, "operator cancelled the request")).toMatchObject({
      status: "cancelled",
      cancelReason: "operator cancelled the request",
    });
  });

  it("does not change a completed operation when a late cancel arrives", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const completed = completeBrowserOperation(state, 120);

    expect(cancelBrowserOperation(completed, "too late")).toEqual(completed);
    expect(expireBrowserOperation(completed, 999)).toEqual(completed);
  });

  it("marks recoverable failures and starts recovery as a new attempt", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const failed = failBrowserOperation(state, "browser connection dropped", true);

    expect(failed).toMatchObject({
      status: "recoverable",
      lastError: "browser connection dropped",
      attempt: 1,
    });
    expect(recoverBrowserOperation(failed, 200, 75)).toMatchObject({
      status: "running",
      attempt: 2,
      startedAtMs: 200,
      deadlineAtMs: 275,
      lastError: undefined,
    });
  });

  it("keeps non-recoverable failures terminal", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const failed = failBrowserOperation(state, "policy denied retry", false);

    expect(failed).toMatchObject({ status: "failed", lastError: "policy denied retry" });
    expect(recoverBrowserOperation(failed, 200, 75)).toEqual(failed);
  });
});
