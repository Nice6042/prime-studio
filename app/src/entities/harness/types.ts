import type {
  HarnessCompatibility,
  RootSessionSnapshot,
  RuntimeIdentity,
} from "../../shared/ipc/harness.generated";

export type ProjectionFreshness = "live" | "stale" | "disconnected" | "unknown_outcome";

export interface RootSessionProjection extends RootSessionSnapshot {
  readonly freshness: ProjectionFreshness;
}

export interface BootProjection {
  readonly compatibility: HarnessCompatibility;
  readonly runtime: RuntimeIdentity | null;
  readonly sessions: readonly RootSessionProjection[];
}

export interface HarnessProjectionEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly type: "session_projection";
  readonly session: RootSessionProjection;
}
