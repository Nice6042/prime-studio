import assert from "node:assert/strict";
import test from "node:test";

import {
  StudioHarnessOperationDispatcher,
  dispatchStudioHarnessOperation,
  type StudioHarnessOperation,
  type StudioHarnessOperationPort,
} from "../src/studioHarnessOperations.js";

const expectedCursor = Object.freeze({ runtimeGeneration: "generation-1", sequence: 9 });

function child(id: string, status: string, activeSessionId = `session-${id}`): Readonly<Record<string, unknown>> {
  return Object.freeze({ id, status, activeSessionId, label: `Task ${id}` });
}

function snapshot(children: readonly Readonly<Record<string, unknown>>[], generation = "generation-1", sequence = 4): Readonly<Record<string, unknown>> {
  return Object.freeze({
    state: Object.freeze({ activeSessionId: "root-a" }),
    children: Object.freeze([...children]),
    lastEventCursor: Object.freeze({ generation, sequence }),
  });
}

function operation(operationId: string, childId = "child-a", idempotencyKey = operationId): StudioHarnessOperation {
  return Object.freeze({
    operationId,
    action: "harness.child.stop",
    payload: Object.freeze({ sessionId: "root-a", childId }),
    expectedCursor,
    idempotencyKey,
  });
}

function cancellationPort(options: Readonly<{
  before: unknown;
  after: unknown;
  onCancel?: (childId: string) => void;
  cancelError?: Error;
  projection?: unknown;
}>): StudioHarnessOperationPort {
  return {
    connection: {
      async cancelRlmChild(childId: string) {
        options.onCancel?.(childId);
        if (options.cancelError) throw options.cancelError;
      },
      async getInitialSnapshot() { return options.after; },
    },
    currentCursor: expectedCursor,
    preOperationSnapshot: options.before,
    async publishPostconditionSnapshot(source: unknown) {
      assert.equal(source, options.after);
      return options.projection ?? Object.freeze({ sessionId: "root-a", children: [] });
    },
  } as StudioHarnessOperationPort;
}

test("child cancellation stays unknown when Prime resolves but the exact child remains running", async () => {
  let cancellations = 0;
  const before = snapshot([child("child-a", "running")]);
  const result = await dispatchStudioHarnessOperation(cancellationPort({
    before,
    after: snapshot([child("child-a", "running")], "generation-1", 5),
    onCancel: () => { cancellations += 1; },
  }), operation("cancel-running-child"));

  assert.deepEqual(result, {
    status: "unknown_outcome",
    operationId: "cancel-running-child",
    reason: "Prime acknowledged child cancellation, but the exact child is still non-terminal.",
  });
  assert.equal(cancellations, 1);
});

test("child cancellation succeeds only from the exact child disappearance and carries that authoritative projection", async () => {
  let cancelledChild = "";
  const sibling = child("child-a-copy", "running");
  const before = snapshot([child("child-a", "running"), sibling]);
  const after = snapshot([sibling], "generation-1", 5);
  const projection = Object.freeze({ sessionId: "root-a", children: [{ id: "child-a-copy", status: "running" }] });
  const result = await dispatchStudioHarnessOperation(cancellationPort({
    before,
    after,
    projection,
    onCancel: (childId) => { cancelledChild = childId; },
  }), operation("cancel-exact-child"));

  assert.equal(cancelledChild, "child-a");
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  assert.equal(result.data, projection);
});

test("child cancellation accepts a retained exact child only when Prime reports a closed terminal status", async () => {
  for (const status of ["done", "error", "cancelled"] as const) {
    const exact = child("child-a", "running");
    const result = await dispatchStudioHarnessOperation(cancellationPort({
      before: snapshot([exact]),
      after: snapshot([child("child-a", status)], "generation-1", 5),
    }), operation(`cancel-terminal-${status}`));
    assert.equal(result.status, "updated", status);
  }
});

test("child cancellation rejects an absent, terminal, ambiguous, or wrong-root pre-child without invoking Prime", async () => {
  let cancellations = 0;
  const invalidPreconditions = [
    snapshot([]),
    snapshot([child("child-a", "done")]),
    snapshot([child("child-a", "running"), child("child-a", "running", "replacement-session")]),
    Object.freeze({ ...snapshot([child("child-a", "running")]), state: Object.freeze({ activeSessionId: "root-b" }) }),
  ];
  for (const [index, before] of invalidPreconditions.entries()) {
    const result = await dispatchStudioHarnessOperation(cancellationPort({
      before,
      after: snapshot([]),
      onCancel: () => { cancellations += 1; },
    }), operation(`cancel-invalid-pre-${index}`));
    assert.equal(result.status, "rejected");
  }
  assert.equal(cancellations, 0);
});

test("child cancellation never succeeds across a runtime generation or replacement-child identity", async () => {
  const before = snapshot([child("child-a", "running")]);
  const generationChanged = await dispatchStudioHarnessOperation(cancellationPort({
    before,
    after: snapshot([], "generation-2", 1),
  }), operation("cancel-generation-change"));
  assert.equal(generationChanged.status, "unknown_outcome");

  const replacement = await dispatchStudioHarnessOperation(cancellationPort({
    before,
    after: snapshot([child("child-a", "cancelled", "replacement-session")], "generation-1", 5),
  }), operation("cancel-replacement-child"));
  assert.equal(replacement.status, "unknown_outcome");
});

test("child cancellation reports an unknown outcome when Prime fails after command admission", async () => {
  let cancellations = 0;
  const result = await dispatchStudioHarnessOperation(cancellationPort({
    before: snapshot([child("child-a", "running")]),
    after: snapshot([], "generation-1", 5),
    onCancel: () => { cancellations += 1; },
    cancelError: new Error("transport closed"),
  }), operation("cancel-admission-unknown"));

  assert.deepEqual(result, {
    status: "unknown_outcome",
    operationId: "cancel-admission-unknown",
    reason: "Prime child cancellation was admitted, but its authoritative postcondition could not be proven.",
  });
  assert.equal(cancellations, 1);
});

test("child cancellation idempotency invokes Prime once and rejects identity reuse for another child", async () => {
  let cancellations = 0;
  const dispatcher = new StudioHarnessOperationDispatcher();
  const port = cancellationPort({
    before: snapshot([child("child-a", "running")]),
    after: snapshot([], "generation-1", 5),
    onCancel: () => { cancellations += 1; },
  });
  const first = operation("cancel-idempotent", "child-a", "cancel-key");
  const replay = await dispatcher.dispatch(port, first);
  assert.equal(replay.status, "updated");
  assert.equal((await dispatcher.dispatch(port, first)).status, "updated");
  assert.equal(cancellations, 1);

  const conflict = await dispatcher.dispatch(port, operation("cancel-idempotent-reused", "child-b", "cancel-key"));
  assert.deepEqual(conflict, { status: "rejected", reason: "Operation identity was reused with different input.", retryable: false });
  assert.equal(cancellations, 1);
});
