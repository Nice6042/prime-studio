export type HarnessIconKind = "back" | "close" | "collapse" | "queue" | "tools" | "context" | "output" | "source" | "lock";

const paths: Record<HarnessIconKind, readonly string[]> = {
  back: ["M19 12H5", "M12 19l-7-7 7-7"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  collapse: ["M13 17l5-5-5-5", "M6 17l5-5-5-5"],
  queue: ["M12 2l10 6-10 6L2 8z", "M2 13l10 6 10-6"],
  tools: ["M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3", "M1 14h6M9 8h6M17 16h6"],
  context: ["M21 5c0 1.7-4 3-9 3S3 6.7 3 5s4-3 9-3 9 1.3 9 3z", "M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5", "M3 12c0 1.7 4 3 9 3s9-1.3 9-3"],
  output: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M9 15h6M12 12v6"],
  source: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
};

export function HarnessIcon({ kind, size = 15 }: { readonly kind: HarnessIconKind; readonly size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[kind].map((path) => <path d={path} key={path} />)}</svg>;
}
