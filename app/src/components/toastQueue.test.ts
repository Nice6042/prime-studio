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
});
