import { describe, expect, it } from "vitest";

import { projectOperationToast } from "./operationToasts";

describe("operation toast projection", () => {
  it("offers Retry only for retryable rejected outcomes and never for uncertain or unavailable outcomes", () => {
    const operation = { action: "harness.session.prompt" as const, payload: { sessionId: "session-1", text: "private prompt" }, operationId: "operation-1" };

    expect(projectOperationToast(operation, { status: "rejected", reason: "Retry safely.", retryable: true }).toast?.action)
      .toEqual({ id: "operation-1", label: "Retry", action: "harness.session.prompt" });
    expect(projectOperationToast(operation, { status: "rejected", reason: "Stale.", retryable: false }).toast?.action).toBeUndefined();
    expect(projectOperationToast(operation, { status: "unavailable", reason: "Offline." }).toast?.action).toBeUndefined();
    expect(projectOperationToast(operation, { status: "unknown_outcome", operationId: "wire-1", reason: "Unknown." }).toast?.action).toBeUndefined();
  });

  it("derives a stable privacy-safe scope without retaining private payload values", () => {
    const first = projectOperationToast(
      { action: "harness.session.prompt", payload: { sessionId: "session-1", text: "private first" }, operationId: "operation-1" },
      { status: "rejected", reason: "Failed.", retryable: true },
    );
    const second = projectOperationToast(
      { action: "harness.session.prompt", payload: { sessionId: "session-1", text: "private second" }, operationId: "operation-2" },
      { status: "rejected", reason: "Failed.", retryable: true },
    );

    expect(first.identity).toEqual(second.identity);
    expect(JSON.stringify(first.toast)).not.toContain("private first");
    expect(JSON.stringify(second.toast)).not.toContain("private second");
  });
});
