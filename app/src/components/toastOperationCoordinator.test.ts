import { describe, expect, it } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { MAX_ACTIONABLE_OPERATIONS, MAX_VISIBLE_TOASTS, ToastOperationCoordinator } from "./toastOperationCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function operation(index: number): StudioOperation {
  return { action: "workspace.switch", payload: { workspaceId: `workspace-${index}` } };
}

describe("toast operation coordinator", () => {
  it.each([
    ["unknown_outcome", { status: "unknown_outcome", operationId: "wire-unknown", reason: "Settlement is unknown." }],
    ["unavailable", { status: "unavailable", reason: "Authority is unavailable." }],
    ["nonretryable", { status: "rejected", reason: "The request is stale.", retryable: false }],
  ] as const)("after Retry settles %s, obsolete Retry is removed before it can replay a non-idempotent operation", async (_label, settled) => {
    let calls = 0;
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => "operation-sensitive",
      dispatch: async () => {
        calls += 1;
        return calls === 1
          ? { status: "rejected", reason: "Try once more.", retryable: true }
          : settled;
      },
    });

    await coordinator.execute({ action: "workspace.switch", payload: { workspaceId: "non-idempotent-target" } });
    const presentationId = coordinator.getSnapshot()[0]!.id;
    expect(coordinator.getSnapshot().flatMap((toast) => toast.actions)).toEqual([
      { id: "operation-sensitive:1", label: "Retry", action: "workspace.switch" },
    ]);

    expect(await coordinator.retry("operation-sensitive:1")).toEqual(settled);
    expect(coordinator.getSnapshot().flatMap((toast) => toast.actions)).toEqual([]);
    expect(coordinator.getSnapshot()[0]?.id).toBe(presentationId);

    const staleReplay = await coordinator.retry("operation-sensitive:1");
    expect(staleReplay).toMatchObject({ status: "unavailable" });
    expect(calls).toBe(2);
  });

  it("same-tick admitted retry reservations cannot be lost", async () => {
    const settlements = Array.from({ length: MAX_ACTIONABLE_OPERATIONS }, () => deferred<StudioOperationOutcome>());
    const dispatched: StudioOperation[] = [];
    let id = 0;
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => `operation-${++id}`,
      dispatch: (admitted) => {
        dispatched.push(admitted);
        return settlements[dispatched.length - 1]!.promise;
      },
    });

    const admitted = settlements.map((_, index) => coordinator.execute(operation(index)));
    const blocked = await coordinator.execute(operation(99));

    expect(blocked).toMatchObject({ status: "unavailable" });
    expect(dispatched).toHaveLength(MAX_ACTIONABLE_OPERATIONS);
    expect(coordinator.getSnapshot()[coordinator.getSnapshot().length - 1]).toMatchObject({
      scope: "queue.hard-capacity",
      message: expect.stringMatching(/No operation was started/),
    });

    settlements.forEach((settlement, index) => settlement.resolve({
      status: "rejected",
      reason: `Retryable ${index}`,
      retryable: true,
    }));
    await Promise.all(admitted);

    expect(coordinator.getSnapshot().flatMap((toast) => toast.actions)).toHaveLength(MAX_ACTIONABLE_OPERATIONS);
  });

  it("caller operationId collisions cannot merge reservations, overwrite actions, or replay the wrong operation", async () => {
    const first = deferred<StudioOperationOutcome>();
    const second = deferred<StudioOperationOutcome>();
    const dispatched: StudioOperation[] = [];
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => "internal",
      dispatch: (admitted) => {
        dispatched.push(admitted);
        return dispatched.length === 1 ? first.promise : second.promise;
      },
    });
    const collision = "caller-supplied-collision";
    const firstPending = coordinator.execute({ operationId: collision, action: "workspace.switch", payload: { workspaceId: "one" } });
    const secondPending = coordinator.execute({ operationId: collision, action: "workspace.switch", payload: { workspaceId: "two" } });

    expect(dispatched.map((item) => item.operationId)).toEqual(["internal:1", "internal:2"]);
    second.resolve({ status: "rejected", reason: "Second retryable.", retryable: true });
    first.resolve({ status: "rejected", reason: "First retryable.", retryable: true });
    await Promise.all([firstPending, secondPending]);

    expect(coordinator.getSnapshot().flatMap((toast) => toast.actions.map((action) => action.id)).sort())
      .toEqual(["internal:1", "internal:2"]);
    expect(coordinator.hasAction("internal:1")).toBe(true);
    expect(coordinator.hasAction("internal:2")).toBe(true);
  });

  it("dismissal during a pending Retry permanently suppresses its late retryable presentation", async () => {
    const retrySettlement = deferred<StudioOperationOutcome>();
    let calls = 0;
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => "internal-retry",
      dispatch: async (admitted) => {
        calls += 1;
        if (admitted.action === "toast.dismiss") return { status: "updated", revision: 1 };
        if (calls === 1) return { status: "rejected", reason: "Retry safely.", retryable: true };
        return retrySettlement.promise;
      },
    });
    await coordinator.execute(operation(1));
    const toastId = coordinator.getSnapshot()[0]!.id;
    const retrying = coordinator.retry("internal-retry:1");

    expect(await coordinator.execute({ action: "toast.dismiss", payload: { toastId } })).toMatchObject({ status: "updated" });
    expect(coordinator.getSnapshot()).toEqual([]);
    retrySettlement.resolve({ status: "rejected", reason: "Still retryable.", retryable: true });
    await retrying;

    expect(coordinator.getSnapshot()).toEqual([]);
    expect(coordinator.hasAction("internal-retry:1")).toBe(false);
  });

  it("stale toast.dismiss is an explicit non-success and never reaches the dispatcher", async () => {
    let dispatches = 0;
    const coordinator = new ToastOperationCoordinator({
      dispatch: async () => {
        dispatches += 1;
        return { status: "updated", revision: 1 };
      },
    });

    expect(await coordinator.execute({ action: "toast.dismiss", payload: { toastId: "stale-toast" } }))
      .toEqual({ status: "unavailable", reason: "This notification is already resolved." });
    expect(dispatches).toBe(0);
  });

  it("same-tick concurrent toast.dismiss reserves ownership so only one reaches the dispatcher", async () => {
    const dismissal = deferred<StudioOperationOutcome>();
    let dispatches = 0;
    const coordinator = new ToastOperationCoordinator({
      dispatch: async () => {
        dispatches += 1;
        return dismissal.promise;
      },
    });
    coordinator.notify({ owner: "runtime", scope: "failure", severity: "error", title: "Failure", message: "Failed." });
    const toastId = coordinator.getSnapshot()[0]!.id;

    const first = coordinator.execute({ action: "toast.dismiss", payload: { toastId } });
    const second = await coordinator.execute({ action: "toast.dismiss", payload: { toastId } });

    expect(second).toEqual({ status: "unavailable", reason: "This notification is already resolving." });
    expect(dispatches).toBe(1);
    dismissal.resolve({ status: "updated", revision: 1 });
    expect(await first).toMatchObject({ status: "updated" });
    expect(coordinator.getSnapshot()).toEqual([]);
  });

  it("in-flight toast.dismiss preserves a later accepted actionable failure coalesced into the presentation", async () => {
    const dismissal = deferred<StudioOperationOutcome>();
    const dispatched: StudioOperation[] = [];
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => "generation",
      dispatch: async (admitted) => {
        dispatched.push(admitted);
        if (admitted.action === "toast.dismiss") return dismissal.promise;
        return { status: "rejected", reason: "Retry safely.", retryable: true };
      },
    });
    await coordinator.execute(operation(1));
    const toastId = coordinator.getSnapshot()[0]!.id;

    const dismissing = coordinator.execute({ action: "toast.dismiss", payload: { toastId } });
    await coordinator.execute(operation(2));
    expect(coordinator.getSnapshot()[0]?.actions.map((action) => action.id)).toEqual([
      "generation:1",
      "generation:3",
    ]);

    dismissal.resolve({ status: "updated", revision: 1 });
    expect(await dismissing).toMatchObject({ status: "updated" });
    expect(coordinator.getSnapshot()).toHaveLength(1);
    expect(coordinator.getSnapshot()[0]?.actions.map((action) => action.id)).toEqual(["generation:3"]);
    expect(coordinator.hasAction("generation:1")).toBe(false);
    expect(coordinator.hasAction("generation:3")).toBe(true);

    expect(await coordinator.retry("generation:3")).toMatchObject({ status: "rejected", retryable: true });
    expect(dispatched[dispatched.length - 1]).toMatchObject({
      operationId: "generation:3",
      payload: { workspaceId: "workspace-2" },
    });
  });

  it("stable equivalent presentation dedupe coexists with a distinct privacy-safe per-operation action ledger", async () => {
    let id = 0;
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => `prompt-${++id}`,
      dispatch: async () => ({ status: "rejected", reason: "Admission failed.", retryable: true }),
    });

    await coordinator.execute({ action: "harness.session.prompt", payload: { sessionId: "session-1", text: "private first prompt" } });
    await coordinator.execute({ action: "harness.session.prompt", payload: { sessionId: "session-1", text: "private second prompt" } });

    const snapshot = coordinator.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.actions.map((action) => action.id)).toEqual(["prompt-1:1", "prompt-2:2"]);
    expect(JSON.stringify(snapshot)).not.toContain("private first prompt");
    expect(JSON.stringify(snapshot)).not.toContain("private second prompt");
    expect(coordinator.hasAction("prompt-1:1")).toBe(true);
    expect(coordinator.hasAction("prompt-2:2")).toBe(true);
  });

  it("max visible queue/DOM is bounded and no accepted actionable operation is silently evicted", async () => {
    let id = 0;
    const coordinator = new ToastOperationCoordinator({
      createOperationId: () => `accepted-${++id}`,
      dispatch: async (_operation) => ({ status: "rejected", reason: "Retry is safe.", retryable: true }),
    });

    for (let index = 0; index < MAX_VISIBLE_TOASTS + 3; index += 1) {
      coordinator.notify({
        owner: "runtime",
        scope: `passive-${index}`,
        severity: "error",
        title: "Runtime failure",
        message: `Passive ${index}`,
      });
    }
    await Promise.all(Array.from({ length: MAX_ACTIONABLE_OPERATIONS }, (_, index) => coordinator.execute(operation(index))));

    const snapshot = coordinator.getSnapshot();
    expect(snapshot).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(snapshot.flatMap((toast) => toast.actions).map((action) => action.id).sort()).toEqual([
      "accepted-1:1", "accepted-2:2", "accepted-3:3", "accepted-4:4", "accepted-5:5",
    ]);
    expect(Array.from({ length: MAX_ACTIONABLE_OPERATIONS }, (_, index) => coordinator.hasAction(`accepted-${index + 1}:${index + 1}`))).toEqual([
      true, true, true, true, true,
    ]);
  });
});
