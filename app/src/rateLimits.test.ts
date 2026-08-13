import { describe, expect, it, vi } from "vitest";

describe("rateLimits transient evidence", () => {
  it("publishes only attributable valid session evidence to passive readers", async () => {
    vi.resetModules();
    const store = await import("./rateLimits");
    const listener = vi.fn();
    const unsubscribe = store.subscribeRateLimits(listener);

    store.note(null, { utilization: 0.5 });
    store.note("claude", { utilization: "0.5" });
    expect(listener).not.toHaveBeenCalled();
    expect(store.rateLimitsSnapshot()).toEqual(new Map());

    store.note("claude", { utilization: 0.5, representativeWindow: "seven_day" });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.rateLimitsSnapshot().get("claude")).toEqual(expect.objectContaining({
      utilization: 0.5,
      representativeWindow: "seven_day",
    }));

    unsubscribe();
    store.note("claude", { utilization: 0.6 });
    expect(listener).toHaveBeenCalledOnce();
  });
});
