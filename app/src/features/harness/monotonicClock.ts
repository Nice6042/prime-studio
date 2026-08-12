import { useEffect, useRef, useState } from "react";

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.now()) ? performance.now() : Date.now();
}

/** Keeps elapsed presentation forward-only when the host wall clock regresses. */
export function monotonicEpoch(baseEpochMs: number, baseMonotonicMs: number, currentMonotonicMs: number, wallEpochMs: number): number {
  const elapsed = Math.max(0, currentMonotonicMs - baseMonotonicMs);
  return Math.max(baseEpochMs + elapsed, wallEpochMs);
}

/** One inspector-level clock avoids per-row timers for elapsed values. */
export function useMonotonicNow(intervalMs = 1_000): number {
  const baseEpochMs = useRef(Date.now());
  const baseMonotonicMs = useRef(readMonotonicNow());
  const [now, setNow] = useState(baseEpochMs.current);

  useEffect(() => {
    const tick = () => setNow(monotonicEpoch(baseEpochMs.current, baseMonotonicMs.current, readMonotonicNow(), Date.now()));
    const handle = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);

  return now;
}
