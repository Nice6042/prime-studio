import { describe, expect, it } from "vitest";

import { monotonicEpoch } from "./monotonicClock";

describe("monotonicEpoch", () => {
  it("never moves elapsed-time presentation backward when wall time regresses", () => {
    expect(monotonicEpoch(10_000, 1_000, 900, 9_700)).toBe(10_000);
    expect(monotonicEpoch(10_000, 1_000, 1_250, 10_100)).toBe(10_250);
  });
});
