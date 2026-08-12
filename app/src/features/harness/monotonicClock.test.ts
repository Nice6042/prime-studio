import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MonotonicEpochClock, useMonotonicNow } from "./monotonicClock";

afterEach(() => vi.restoreAllMocks());

describe("MonotonicEpochClock", () => {
  it.each([1, 9_000_000_000_000])("ignores renderer wall-clock skew at %d", (rendererNow) => {
    vi.spyOn(Date, "now").mockReturnValue(rendererNow);
    vi.spyOn(performance, "now").mockReturnValue(500);

    const { result } = renderHook(() => useMonotonicNow(10_000, 60_000));

    expect(result.current).toBe(10_000);
  });

  it("advances from daemon observations without moving backward across refreshes or sessions", () => {
    const clock = new MonotonicEpochClock();
    expect(clock.observe(10_000, 1_000)).toBe(10_000);
    expect(clock.read(1_500)).toBe(10_500);
    expect(clock.observe(10_200, 1_600)).toBe(10_600);
    expect(clock.observe(9_000, 1_700)).toBe(10_700);
    expect(clock.observe(20_000, 1_800)).toBe(20_000);
    expect(clock.read(1_900)).toBe(20_100);
  });
});
