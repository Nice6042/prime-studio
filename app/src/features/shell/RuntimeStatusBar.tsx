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
    <span>{session.accountId ?? "local"}{model ? ` · ${model}` : ""}{thinking ? ` · thinking ${thinking}` : ""}</span>
    <span className="studio-statusbar-spacer" />
    {contextLimit && <span>{session.usage.totalTokens.toLocaleString("en-US")} / {contextLimit.toLocaleString("en-US")} tokens <i className="studio-context-meter" aria-hidden="true"><b style={{ inlineSize: `${contextPercent ?? 0}%` }} /></i></span>}
    {firstTokenMs !== undefined && <span>{firstTokenMs.toLocaleString()}ms first token</span>}
    {tokensPerSecond !== undefined && <span className={session.state === "working" ? "is-streaming" : undefined}>{tokensPerSecond.toFixed(1)} tok/s</span>}
    <span>{session.state} · {session.freshness}</span>
    {error && <span className="studio-status-error">{error}</span>}
  </div>;
}
