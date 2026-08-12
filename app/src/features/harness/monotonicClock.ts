import { useEffect, useRef, useState } from "react";

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.now()) ? performance.now() : Date.now();
}

/** Keeps elapsed presentation forward-only across both wall-clock regressions and normalization. */
export class MonotonicEpochClock {
  private lastEpochMs: number;

  constructor(private readonly baseEpochMs: number, private readonly baseMonotonicMs: number) {
    this.lastEpochMs = baseEpochMs;
  }

  read(currentMonotonicMs: number, wallEpochMs: number): number {
    const elapsed = Math.max(0, currentMonotonicMs - this.baseMonotonicMs);
    this.lastEpochMs = Math.max(this.lastEpochMs, this.baseEpochMs + elapsed, wallEpochMs);
    return this.lastEpochMs;
  }
}

/** One inspector-level clock avoids per-row timers for elapsed values. */
export function useMonotonicNow(intervalMs = 1_000): number {
  const clock = useRef<MonotonicEpochClock | null>(null);
  if (clock.current === null) clock.current = new MonotonicEpochClock(Date.now(), readMonotonicNow());
  const [now, setNow] = useState(() => clock.current!.read(readMonotonicNow(), Date.now()));

  useEffect(() => {
    const tick = () => setNow(clock.current!.read(readMonotonicNow(), Date.now()));
    const handle = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);

  return now;
}
