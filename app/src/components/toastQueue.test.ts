import { describe, expect, it } from "vitest";

import {
  MAX_VISIBLE_TOASTS,
  dismissToast,
  enqueueToast,
  removeToastAction,
  type StudioToast,
  type ToastInput,
} from "./toastQueue";

const failure = (scope: string, actionId?: string): ToastInput => ({
  owner: "studio_durable",
  scope,
  severity: "error",
  title: "Studio data operation failed",
  message: `${scope} failed.`,
  action: actionId ? { id: actionId, label: "Retry", action: "workspace.switch" } : undefined,
});

describe("typed toast queue", () => {
  it("deduplicates by stable owner and scope while retaining typed severity", () => {
    const first = enqueueToast([], failure("workspace.switch"), 1_000);
    const repeated = enqueueToast(first, { ...failure("workspace.switch"), message: "Still unavailable." }, 2_000);

    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      id: first[0]!.id,
      owner: "studio_durable",
      scope: "workspace.switch",
      severity: "error",
      message: "Still unavailable.",
      occurrences: 2,
      persistent: true,
      expiresAtMs: null,
    });
  });

  it("expires passive status presentation after exactly 2.4 seconds", () => {
    const queue = enqueueToast([], {
      owner: "runtime",
      scope: "connection.ready",
      severity: "success",
      title: "Runtime connected",
      message: "Prime is ready.",
    }, 10_000);

    expect(queue[0]).toMatchObject({ persistent: false, expiresAtMs: 12_400 });
  });

  it("passive overflow never falsely says operations are blocked, while hard capacity remains truthful", () => {
    let queue: readonly StudioToast[] = [];
    for (let index = 0; index < MAX_VISIBLE_TOASTS + 4; index += 1) {
      queue = enqueueToast(queue, failure(`passive-${index}`), index);
    }

    expect(queue).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(queue.map((toast) => toast.scope)).toEqual([
      "passive-4", "passive-5", "passive-6", "passive-7", "passive-8", "passive-9",
    ]);
    expect(queue.map((toast) => `${toast.title} ${toast.message}`).join(" ")).not.toMatch(/blocked|resolve.*before starting/i);

    queue = enqueueToast(queue, {
      owner: "renderer",
      scope: "queue.hard-capacity",
      severity: "warning",
      title: "Retry queue full",
      message: "No operation was started. Resolve or dismiss a retryable failure before starting another operation.",
    }, 20_000);

    expect(queue).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(queue[queue.length - 1]).toMatchObject({ scope: "queue.hard-capacity", severity: "warning" });
    expect(queue[queue.length - 1]?.message).toMatch(/No operation was started/);
  });

  it("coalesces equivalent presentations without collapsing distinct action references", () => {
    const first = enqueueToast([], failure("harness.prompt:session-1", "operation-1"), 1_000);
    const second = enqueueToast(first, failure("harness.prompt:session-1", "operation-2"), 1_001);

    expect(second).toHaveLength(1);
    expect(second[0]?.actions).toEqual([
      { id: "operation-1", label: "Retry", action: "workspace.switch" },
      { id: "operation-2", label: "Retry", action: "workspace.switch" },
    ]);
    expect(removeToastAction(second, second[0]!, "operation-1")[0]?.actions).toEqual([
      { id: "operation-2", label: "Retry", action: "workspace.switch" },
    ]);
    expect(dismissToast(second, second[0]!.id)).toEqual([]);
  });
});
