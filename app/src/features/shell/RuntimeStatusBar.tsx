import { useId } from "react";

import type { RootSessionProjection } from "../../entities/harness/types";

const PERFORMANCE_REASONS = {
  event_chronology_unavailable: "Verified parent event chronology is unavailable.",
  event_chronology_incomplete: "Verified parent event chronology is incomplete.",
  event_chronology_invalid: "Verified parent event chronology is invalid.",
  generation_changed: "The runtime generation changed before performance could be bound.",
} as const;

export function RuntimeStatusBar({ session, model, thinking, contextLimit, error }: {
  readonly session: RootSessionProjection | null;
  readonly model?: string;
  readonly thinking?: string;
  readonly contextLimit?: number;
  readonly error?: string | null;
}) {
  const performanceDetailId = useId();
  if (!session) return <div className="studio-statusbar" role="status"><span>Harness unavailable</span></div>;
  const contextPercent = contextLimit && contextLimit > 0 ? Math.min(100, session.usage.totalTokens / contextLimit * 100) : null;
  const exactPerformance = session.performance && session.performance.sessionId === session.sessionId
    && session.performance.cursor.runtimeGeneration === session.cursor.runtimeGeneration
    && session.performance.cursor.sequence === session.cursor.sequence
    ? session.performance
    : null;
  const performanceReason = exactPerformance?.status === "unavailable"
    ? PERFORMANCE_REASONS[exactPerformance.reason]
    : exactPerformance ? null : "Performance evidence does not match this session snapshot.";
  return <div className="studio-statusbar" role="status" aria-label="Runtime status" aria-describedby={performanceReason ? performanceDetailId : undefined} tabIndex={0}>
    <span>{session.accountId ?? "local"}{" \u00b7 "}{model ?? "model unavailable"}{" \u00b7 "}{thinking ? `thinking ${thinking}` : "thinking unavailable"}</span>
    <span className="studio-statusbar-spacer" />
    {contextLimit && contextLimit > 0
      ? <span>ctx {session.usage.totalTokens.toLocaleString("en-US")} / {contextLimit.toLocaleString("en-US")} tokens <i className="studio-context-meter" aria-hidden="true"><b style={{ inlineSize: `${contextPercent ?? 0}%` }} /></i></span>
      : <span>ctx unavailable</span>}
    <span>{exactPerformance?.status === "available" ? `${exactPerformance.firstTokenLatencyMs.toLocaleString()}ms first token` : "first token unavailable"}</span>
    <span className={exactPerformance?.status === "available" && session.state === "working" ? "is-streaming" : undefined}>{exactPerformance?.status === "available" ? `${exactPerformance.tokensPerSecond.toFixed(1)} tok/s` : "throughput unavailable"}</span>
    <span>{session.state}{" \u00b7 "}{session.freshness}</span>
    {error && <span className="studio-status-error">{error}</span>}
    {performanceReason && <span id={performanceDetailId} className="sr-only">{performanceReason}</span>}
  </div>;
}
