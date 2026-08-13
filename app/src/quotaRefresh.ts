import type { CodexSubscription } from "./types";

export type CodexQuotaState = Readonly<{
  status: "loading" | "ready" | "unavailable";
  snapshot: CodexSubscription | null;
}>;

type RefreshResult = Readonly<{ status: "success"; snapshot: CodexSubscription | null }> | Readonly<{ status: "failure" }>;
type RefreshResponse = Readonly<{ status: "updated" | "preserved" | "unavailable"; message?: string }>;

export function reconcileCodexQuotaRefresh(
  generation: number,
  latestGeneration: number,
  previous: CodexQuotaState,
  result: RefreshResult,
): Readonly<{ state: CodexQuotaState; response: RefreshResponse }> | null {
  if (generation !== latestGeneration) return null;
  if (result.status === "success") {
    return {
      state: { status: "ready", snapshot: result.snapshot },
      response: { status: "updated", ...(result.snapshot ? {} : { message: "No Codex CLI snapshot is available; quota remains unavailable." }) },
    };
  }
  if (previous.snapshot) {
    return {
      state: { status: "ready", snapshot: previous.snapshot },
      response: { status: "preserved", message: "Quota refresh failed; showing the last proven Codex CLI snapshot." },
    };
  }
  return {
    state: { status: "unavailable", snapshot: null },
    response: { status: "unavailable", message: "Quota refresh failed and no proven snapshot is available." },
  };
}
