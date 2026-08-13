import { describe, expect, it, vi } from "vitest";

import type { StudioOperation, StudioOperationOutcome } from "../studioOperations";
import { createStudioOperationDispatcher } from "./studioOperationDispatcher";

const updated: StudioOperationOutcome = { status: "updated", revision: 1 };

describe("createStudioOperationDispatcher", () => {
  it.each([
    ["harness", { action: "harness.session.compact", payload: { sessionId: "session-1" } }],
    ["studioDurable", { action: "catalog.chat.rename", payload: { chatId: "chat-1", title: "Renamed" } }],
    ["renderer", { action: "layout.sidebar.toggle", payload: {} }],
    ["native", { action: "window.minimize", payload: {} }],
  ] as const)("routes %s-owned operations only to that authority", async (owner, operation) => {
    const routes = {
      harness: vi.fn(async () => updated),
      studioDurable: vi.fn(async () => updated),
      renderer: vi.fn(async () => updated),
      native: vi.fn(async () => updated),
    };
    const dispatch = createStudioOperationDispatcher(routes);

    await expect(dispatch(operation as StudioOperation)).resolves.toEqual(updated);

    expect(routes[owner]).toHaveBeenCalledOnce();
    for (const [name, route] of Object.entries(routes)) {
      if (name !== owner) expect(route).not.toHaveBeenCalled();
    }
  });

  it("returns an explicit unavailable outcome when an authority route is absent", async () => {
    const dispatch = createStudioOperationDispatcher({});

    await expect(dispatch({ action: "palette.open", payload: {} })).resolves.toEqual({
      status: "unavailable",
      reason: "No renderer executor is registered for palette.open.",
    });
  });

  it("returns the action's declared reason for unsupported operations", async () => {
    const dispatch = createStudioOperationDispatcher({
      harness: vi.fn(async () => updated),
    });

    await expect(dispatch({ action: "composer.voice.start", payload: {} })).resolves.toEqual({
      status: "unavailable",
      reason: "Voice capture has no implemented privacy and native-audio contract.",
    });
  });

  it("turns executor failures into explicit rejected outcomes", async () => {
    const dispatch = createStudioOperationDispatcher({
      native: async () => { throw new Error("window host disconnected"); },
    });

    await expect(dispatch({ action: "window.close", payload: {} })).resolves.toEqual({
      status: "rejected",
      reason: "window host disconnected",
      retryable: true,
    });
  });

  it("classifies a thrown executor settlement after stable admission as unknown_outcome, never retryable rejection", async () => {
    const dispatch = createStudioOperationDispatcher({
      harness: async () => { throw new Error("Harness operation failed: deadline_exceeded"); },
    });

    await expect(dispatch({
      operationId: "operation-admitted-1",
      action: "harness.session.prompt",
      payload: { sessionId: "session-1", text: "perform once" },
    })).resolves.toEqual({
      status: "unknown_outcome",
      operationId: "operation-admitted-1",
      reason: "Harness operation failed: deadline_exceeded",
    });
  });

  it("rejects an executor that silently returns no outcome", async () => {
    const dispatch = createStudioOperationDispatcher({
      renderer: async () => undefined as never,
    });

    await expect(dispatch({ action: "palette.close", payload: {} })).resolves.toEqual({
      status: "rejected",
      reason: "Executor for palette.close returned no outcome; interactive no-ops are forbidden.",
      retryable: false,
    });
  });

  it("reconciles every explicit outcome through one observer", async () => {
    const onOutcome = vi.fn();
    const operation = { action: "layout.sidebar.toggle", payload: {} } as const;
    const dispatch = createStudioOperationDispatcher({ renderer: async () => updated, onOutcome });

    await dispatch(operation);

    expect(onOutcome).toHaveBeenCalledWith(operation, updated);
  });
});
