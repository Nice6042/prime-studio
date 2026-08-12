import { describe, expect, it } from "vitest";

import { MonotonicEpochClock } from "./monotonicClock";

describe("MonotonicEpochClock", () => {
  it("never moves elapsed-time presentation backward when wall time regresses", () => {
    const clock = new MonotonicEpochClock(10_000, 1_000);
    expect(clock.read(900, 9_700)).toBe(10_000);
    expect(clock.read(1_250, 10_100)).toBe(10_250);
  });

  it("retains a forward wall-clock correction after the wall clock normalizes", () => {
    const clock = new MonotonicEpochClock(10_000, 1_000);
    expect(clock.read(1_100, 20_000)).toBe(20_000);
    expect(clock.read(1_200, 10_200)).toBe(20_000);
  });
});
