import { useEffect, useReducer, useRef } from "react";

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.now()) ? performance.now() : 0;
}

/** Advances daemon epoch observations without consulting the renderer wall clock. */
export class MonotonicEpochClock {
  private anchorEpochMs: number | null = null;
  private anchorMonotonicMs: number | null = null;
  private lastEpochMs = 0;

  observe(observedAtMs: number, currentMonotonicMs: number): number {
    if (!Number.isFinite(observedAtMs) || observedAtMs < 0) return this.read(currentMonotonicMs);
    const projected = this.read(currentMonotonicMs);
    const next = this.anchorEpochMs === null ? observedAtMs : Math.max(projected, observedAtMs);
    this.anchorEpochMs = next;
    this.anchorMonotonicMs = currentMonotonicMs;
    this.lastEpochMs = next;
    return next;
  }

  read(currentMonotonicMs: number): number {
    if (this.anchorEpochMs === null || this.anchorMonotonicMs === null) return this.lastEpochMs;
    const elapsed = Math.max(0, currentMonotonicMs - this.anchorMonotonicMs);
    this.lastEpochMs = Math.max(this.lastEpochMs, this.anchorEpochMs + elapsed);
    return this.lastEpochMs;
  }
}

/** One daemon-anchored inspector clock avoids per-row timers and mixed clock authorities. */
export function useMonotonicNow(observedAtMs: number | null | undefined, intervalMs = 1_000): number {
  const clock = useRef<MonotonicEpochClock | null>(null);
  if (clock.current === null) clock.current = new MonotonicEpochClock();
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const monotonicNow = readMonotonicNow();
  const now = observedAtMs === null || observedAtMs === undefined
    ? clock.current.read(monotonicNow)
    : clock.current.observe(observedAtMs, monotonicNow);

  useEffect(() => {
    const handle = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);

  return now;
}
