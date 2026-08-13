import { describe, expect, it } from "vitest";

import { reconcileCodexQuotaRefresh } from "./quotaRefresh";
import type { CodexSubscription } from "./types";

const snapshot = (usedPercent: number): CodexSubscription => ({ usedPercent, windowMinutes: 300, resetsAt: 1, staleAsOf: 1 });

describe("reconcileCodexQuotaRefresh", () => {
  it("ignores an older settlement after a newer refresh has started", () => {
    expect(reconcileCodexQuotaRefresh(1, 2, { status: "ready", snapshot: snapshot(10) }, { status: "success", snapshot: snapshot(20) })).toBeNull();
    expect(reconcileCodexQuotaRefresh(1, 2, { status: "ready", snapshot: snapshot(10) }, { status: "failure" })).toBeNull();
  });

  it("preserves the last proven snapshot on the current failure and stays explicit without one", () => {
    expect(reconcileCodexQuotaRefresh(2, 2, { status: "ready", snapshot: snapshot(10) }, { status: "failure" }))
      .toEqual(expect.objectContaining({ state: { status: "ready", snapshot: snapshot(10) }, response: expect.objectContaining({ status: "preserved" }) }));
    expect(reconcileCodexQuotaRefresh(2, 2, { status: "unavailable", snapshot: null }, { status: "failure" }))
      .toEqual(expect.objectContaining({ state: { status: "unavailable", snapshot: null }, response: expect.objectContaining({ status: "unavailable" }) }));
  });
});
