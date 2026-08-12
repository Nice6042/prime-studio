import type { RootSessionProjection } from "../../entities/harness/types";

export function RuntimeStatusBar({ session, model, thinking, contextLimit, tokensPerSecond, firstTokenMs, error }: {
  readonly session: RootSessionProjection | null;
  readonly model?: string;
  readonly thinking?: string;
  readonly contextLimit?: number;
  readonly tokensPerSecond?: number;
  readonly firstTokenMs?: number;
  readonly error?: string | null;
}) {
  if (!session) return <div className="studio-statusbar" role="status"><span>Harness unavailable</span></div>;
  const contextPercent = contextLimit && contextLimit > 0 ? Math.min(100, session.usage.totalTokens / contextLimit * 100) : null;
  return <div className="studio-statusbar" role="status">
    <span>{session.accountId ?? "local"} · {model ?? "model unavailable"} · {thinking ? `thinking ${thinking}` : "thinking unavailable"}</span>
    <span className="studio-statusbar-spacer" />
    {contextLimit && contextLimit > 0
      ? <span>ctx {session.usage.totalTokens.toLocaleString("en-US")} / {contextLimit.toLocaleString("en-US")} tokens <i className="studio-context-meter" aria-hidden="true"><b style={{ inlineSize: `${contextPercent ?? 0}%` }} /></i></span>
      : <span>ctx unavailable</span>}
    <span>{firstTokenMs !== undefined ? `${firstTokenMs.toLocaleString()}ms first token` : "first token unavailable"}</span>
    <span className={tokensPerSecond !== undefined && session.state === "working" ? "is-streaming" : undefined}>{tokensPerSecond !== undefined ? `${tokensPerSecond.toFixed(1)} tok/s` : "throughput unavailable"}</span>
    <span>{session.state} · {session.freshness}</span>
    {error && <span className="studio-status-error">{error}</span>}
  </div>;
}
