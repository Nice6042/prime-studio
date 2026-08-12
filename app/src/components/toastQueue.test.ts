import { describe, expect, it } from "vitest";

import { enqueueToast, dismissToast } from "./toastQueue";

describe("toast queue", () => {
  it("deduplicates equivalent failures and retains actionable notices until dismissed", () => {
    const first = enqueueToast([], { kind: "failure", text: "Catalog unavailable", actionLabel: "Retry" });
    const deduplicated = enqueueToast(first, { kind: "failure", text: "Catalog unavailable", actionLabel: "Retry" });
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]).toMatchObject({ kind: "failure", persistent: true, occurrences: 2 });
    expect(dismissToast(deduplicated, deduplicated[0]!.id)).toEqual([]);
  });

  it("never evicts persistent failures when capacity is exceeded by failures or statuses", () => {
    let queue = [] as readonly ReturnType<typeof enqueueToast>[number][];
    for (const text of ["A", "B", "C", "D", "E"]) queue = enqueueToast(queue, { kind: "failure", text });
    for (const text of ["one", "two", "three", "four", "five"]) queue = enqueueToast(queue, { kind: "status", text });

    expect(queue.filter((toast) => toast.kind === "failure").map((toast) => toast.text)).toEqual(["A", "B", "C", "D", "E"]);
    expect(queue.filter((toast) => toast.kind === "status").map((toast) => toast.text)).toEqual(["two", "three", "four", "five"]);
  });

  it("keeps distinct transient notices together while deduplicating a repeated notice", () => {
    let queue = enqueueToast([], { kind: "status", text: "Connected" });
    queue = enqueueToast(queue, { kind: "status", text: "Refreshing" });
    queue = enqueueToast(queue, { kind: "status", text: "Connected" });

    expect(queue).toHaveLength(2);
    expect(queue.find((toast) => toast.text === "Connected")).toMatchObject({ occurrences: 2, persistent: false });
    expect(queue.find((toast) => toast.text === "Refreshing")).toBeDefined();
  });
});
