import { describe, expect, it } from "vitest";

import {
  completeBrowserOperation,
  createBrowserOperation,
  failBrowserOperation,
  recoverBrowserOperation,
  transitionBrowserOperation,
  expireBrowserOperation,
} from "./lifecycle";

const inspectAction = {
  type: "selector",
  pageUrl: "https://example.com/settings",
  selector: "#status",
  operation: "inspect",
} as const;

const clickAction = {
  type: "selector",
  pageUrl: "https://example.com/settings",
  selector: "#purchase",
  operation: "click",
} as const;

describe("browser operation lifecycle hostile inputs", () => {
  it("starts with an attempt and generation and rejects stale completions", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });

    expect(state).toMatchObject({ status: "running", attempt: 1, generation: 1 });
    expect(
      completeBrowserOperation(state, 120, { generation: 2, attempt: 1 }),
    ).toEqual(state);
    expect(completeBrowserOperation(state, 120, { generation: 1, attempt: 1 })).toMatchObject({
      status: "succeeded",
      completedAtMs: 120,
    });
  });

  it("increments generation and attempt only through recoverable recovery", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const recoverable = failBrowserOperation(state, "connection dropped", true);
    const recovered = recoverBrowserOperation(recoverable, 200, 75);

    expect(recovered).toMatchObject({ status: "running", attempt: 2, generation: 2, startedAtMs: 200 });
    expect(
      completeBrowserOperation(recovered, 210, { generation: 1, attempt: 1 }),
    ).toEqual(recovered);
  });

  it("uses an explicit uncertain terminal and keeps terminal states unchanged", () => {
    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const uncertain = transitionBrowserOperation(state, {
      type: "uncertain",
      generation: 1,
      attempt: 1,
      error: "browser completion could not be confirmed",
    });

    expect(uncertain).toMatchObject({ status: "uncertain", lastError: "browser completion could not be confirmed" });
    expect(
      transitionBrowserOperation(uncertain, {
        type: "complete",
        nowMs: 200,
        generation: 1,
        attempt: 1,
      }),
    ).toEqual(uncertain);
  });

  it("fails closed without throwing for malformed state and event input", () => {
    expect(() => transitionBrowserOperation(null, null)).not.toThrow();
    expect(transitionBrowserOperation(null, null)).toMatchObject({ status: "uncertain" });

    const state = createBrowserOperation({ operationId: "operation-1", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    expect(transitionBrowserOperation(state, { type: "complete", nowMs: "later" })).toMatchObject({
      status: "uncertain",
      lastError: "invalid-operation-event",
    });
  });

  it("marks an ambiguous selector click timeout outcome_unknown and never retries it", () => {
    const state = createBrowserOperation({ operationId: "operation-click", action: clickAction, startedAtMs: 100, timeoutMs: 50 });
    const timedOut = transitionBrowserOperation(state, {
      type: "tick",
      nowMs: 150,
      generation: 1,
      attempt: 1,
    });

    expect(timedOut).toMatchObject({
      status: "outcome_unknown",
      retryClass: "non_idempotent",
      lastError: "operation outcome is unknown after timeout",
    });
    expect(recoverBrowserOperation(timedOut, 200, 75)).toEqual(timedOut);
  });

  it("marks a recoverable transport failure outcome_unknown for non-idempotent coordinates", () => {
    const state = createBrowserOperation({
      operationId: "operation-coordinate-click",
      action: {
        type: "coordinate",
        pageUrl: "https://example.com/settings",
        operation: "click",
        x: 50,
        y: 40,
        viewport: { width: 800, height: 600 },
      },
      startedAtMs: 100,
      timeoutMs: 50,
    });

    expect(failBrowserOperation(state, "worker connection dropped", true)).toMatchObject({
      status: "outcome_unknown",
      retryClass: "non_idempotent",
      lastError: "worker connection dropped",
    });
  });

  it("keeps observational timeouts recoverable as an explicit new attempt", () => {
    const state = createBrowserOperation({ operationId: "operation-inspect", action: inspectAction, startedAtMs: 100, timeoutMs: 50 });
    const timedOut = transitionBrowserOperation(state, {
      type: "tick",
      nowMs: 150,
      generation: 1,
      attempt: 1,
    });
    const recovered = recoverBrowserOperation(timedOut, 200, 75);

    expect(timedOut).toMatchObject({ status: "timed_out", retryClass: "idempotent" });
    expect(recovered).toMatchObject({ status: "running", generation: 2, attempt: 2, retryClass: "idempotent" });
  });

  it("never executes accessors or revoked proxies at the lifecycle boundary", () => {
    const hostile = Object.defineProperty({}, "operationId", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    const target = {};
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();

    expect(() => createBrowserOperation(hostile as never)).not.toThrow();
    expect(createBrowserOperation(hostile as never)).toMatchObject({ status: "uncertain" });
    expect(() => transitionBrowserOperation(proxy, proxy)).not.toThrow();
    expect(transitionBrowserOperation(proxy, proxy)).toMatchObject({ status: "uncertain" });
    expect(() => expireBrowserOperation(proxy as never, 150)).not.toThrow();
  });
});
