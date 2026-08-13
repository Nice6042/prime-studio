import { useId } from "react";

import type { RootSessionProjection } from "../../entities/harness/types";
import { compactTokenCount, type HarnessRuntimeStatusProjection } from "../harness/adapter";

const PERFORMANCE_REASONS = {
  event_chronology_unavailable: "Verified parent event chronology is unavailable.",
  event_chronology_incomplete: "Verified parent event chronology is incomplete.",
  event_chronology_invalid: "Verified parent event chronology is invalid.",
  generation_changed: "The runtime generation changed before performance could be bound.",
} as const;

export interface RuntimeComposerStatusProjection {
  readonly sessionId: string;
  readonly cursor: RootSessionProjection["cursor"];
  readonly model: string | null;
  readonly thinking: string | null;
}

function identityMatches(
  session: RootSessionProjection,
  projection: Readonly<{ sessionId: string; cursor: RootSessionProjection["cursor"] }>,
): boolean {
  return projection.sessionId === session.sessionId
    && projection.cursor.runtimeGeneration === session.cursor.runtimeGeneration
    && projection.cursor.sequence === session.cursor.sequence;
}

export function RuntimeStatusBar({ session, composer = null, inspector = null }: {
  readonly session: RootSessionProjection | null;
  readonly composer?: RuntimeComposerStatusProjection | null;
  readonly inspector?: HarnessRuntimeStatusProjection | null;
}) {
  const detailId = useId();
  if (!session) return <div className="studio-statusbar" role="status" aria-label="Runtime status: Harness unavailable" tabIndex={0}><span>Harness unavailable</span></div>;

  const exactComposer = composer && identityMatches(session, composer) ? composer : null;
  const exactInspector = inspector && identityMatches(session, inspector) ? inspector : null;
  const context = exactInspector?.status === "available" ? exactInspector.context : null;
  const validContext = context
    && Number.isSafeInteger(context.usedTokens)
    && context.usedTokens >= 0
    && Number.isSafeInteger(context.capacityTokens)
    && context.capacityTokens > 0
    && context.usedTokens <= context.capacityTokens
    ? context
    : null;
  const contextPercent = validContext ? Math.round(validContext.usedTokens / validContext.capacityTokens * 100) : null;
  const exactPerformance = identityMatches(session, session.performance) ? session.performance : null;
  const performanceReason = exactPerformance?.status === "unavailable"
    ? PERFORMANCE_REASONS[exactPerformance.reason]
    : exactPerformance ? null : "Performance evidence does not match this session snapshot.";
  const composerReason = exactComposer
    ? exactComposer.model === null || exactComposer.thinking === null
      ? "The verified composer supplied no selected model or thinking level for this snapshot."
      : null
    : "Verified model and thinking evidence does not match this session snapshot.";
  const contextReason = exactInspector?.status === "available" && exactInspector.context === null
    ? "The verified inspector supplied no context window for this snapshot."
    : exactInspector?.status === "available" && !validContext
      ? "Context evidence is invalid for this status snapshot."
      : null;
  const overloadReason = exactInspector?.status === "unavailable"
    ? exactInspector.reason
    : exactInspector ? null : "Overload evidence does not match this session snapshot.";
  const inspectorReason = exactInspector?.status === "unavailable"
    ? exactInspector.reason
    : exactInspector ? null : "Inspector evidence does not match this session snapshot.";
  const detail = [performanceReason, composerReason, inspectorReason, contextReason, overloadReason].filter(Boolean).join(" ");
  const modelText = exactComposer?.model ?? "model unavailable";
  const thinkingText = exactComposer?.thinking ? `thinking ${exactComposer.thinking}` : "thinking unavailable";
  const contextText = validContext ? `ctx ${contextPercent}%` : "ctx unavailable";
  const contextDetail = validContext ? `${compactTokenCount(validContext.usedTokens)} / ${compactTokenCount(validContext.capacityTokens)}` : null;
  const latencyText = exactPerformance?.status === "available" ? `${exactPerformance.firstTokenLatencyMs.toLocaleString()}ms first token` : "first token unavailable";
  const throughputText = exactPerformance?.status === "available" ? `${exactPerformance.tokensPerSecond.toFixed(1)} tok/s` : "throughput unavailable";
  const connection = session.freshness === "live" && session.state !== "disconnected"
    ? "connected"
    : session.freshness === "disconnected" || session.state === "disconnected"
      ? "disconnected"
      : session.freshness === "stale" ? "stale" : "outcome unknown";
  const runtimeText = `${session.state} · ${connection}`;
  const overloadText = exactInspector?.status === "available"
    ? exactInspector.overload
    : "overload unavailable";
  const accessibleText = [session.accountId ?? "local", modelText, thinkingText, contextText, contextDetail, latencyText, throughputText, runtimeText, overloadText].filter(Boolean).join(" · ");

  return <div className="studio-statusbar" role="status" aria-label={`Runtime status: ${accessibleText}`} aria-describedby={detail ? detailId : undefined} tabIndex={0}>
    <span className="studio-statusbar-identity" title={composerReason ?? undefined}>{session.accountId ?? "local"}{" · "}{modelText}{" · "}{thinkingText}</span>
    <span className="studio-statusbar-spacer" />
    <span className="studio-statusbar-context" data-compact={contextText} title={contextReason ?? [contextText, contextDetail].filter(Boolean).join(" · ")}>{contextText}{contextDetail ? ` · ${contextDetail}` : null}{validContext && <i className="studio-context-meter" aria-hidden="true"><b style={{ inlineSize: `${contextPercent}%` }} /></i>}</span>
    <span className="studio-statusbar-latency" title={performanceReason ?? latencyText}>{latencyText}</span>
    <span title={performanceReason ?? throughputText} data-compact={exactPerformance?.status === "available" ? `${exactPerformance.tokensPerSecond.toFixed(1)}/s` : "rate ?"} className={exactPerformance?.status === "available" && session.state === "working" ? "studio-statusbar-throughput is-streaming" : "studio-statusbar-throughput"}>{throughputText}</span>
    <span className="studio-statusbar-runtime" title={runtimeText} data-compact={`${session.state} · ${connection === "connected" ? "online" : connection}`}>{runtimeText}</span>
    {overloadText && <span title={overloadReason ?? overloadText} data-compact={overloadText === "server_is_overloaded" ? "overload!" : "ovl ?"} className={overloadText === "server_is_overloaded" ? "studio-status-error studio-statusbar-overload" : "studio-statusbar-overload"}>{overloadText}</span>}
    {detail && <span id={detailId} className="sr-only">{detail}</span>}
  </div>;
}
