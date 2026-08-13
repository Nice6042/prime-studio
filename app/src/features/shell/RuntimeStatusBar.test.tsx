import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import { RuntimeStatusBar } from "./RuntimeStatusBar";

const session: RootSessionProjection = {
  sessionId: "session-1", accountId: "openai-codex", projectId: "p", chatId: "c",
  cursor: { runtimeGeneration: "g", sequence: 1 }, state: "working", parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 1200, output: 340, cacheRead: 20, cacheWrite: 0, totalTokens: 1560, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null }, freshness: "live",
  performance: { status: "available", sessionId: "session-1", cursor: { runtimeGeneration: "g", sequence: 1 }, firstTokenLatencyMs: 142, outputTokens: 368, generationDurationMs: 20_000, tokensPerSecond: 18.4 },
};

describe("RuntimeStatusBar", () => {
  it("shows only truthful current-session runtime and usage status", () => {
    render(<RuntimeStatusBar session={session} model="gpt-5.6-sol" thinking="high" contextLimit={272_000} />);
    expect(screen.getByText(/openai-codex · gpt-5.6-sol · thinking high/)).toBeVisible();
    expect(screen.getByText(/1,560 \/ 272,000 tokens/)).toBeVisible();
    expect(screen.getByText(/142ms first token/)).toBeVisible();
    expect(screen.getByText(/18.4 tok\/s/)).toBeVisible();
  });

  it("states unavailable instead of fabricating telemetry", () => {
    render(<RuntimeStatusBar session={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Harness unavailable");
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it("labels absent per-chat performance fields unavailable", () => {
    const unavailable: RootSessionProjection = {
      ...session,
      performance: { status: "unavailable", sessionId: session.sessionId, cursor: session.cursor, reason: "event_chronology_incomplete" },
    };
    render(<RuntimeStatusBar session={unavailable} model="gpt-5.6-sol" thinking="high" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("ctx unavailable");
    expect(status).toHaveTextContent("first token unavailable");
    expect(status).toHaveTextContent("throughput unavailable");
    expect(status).not.toHaveTextContent("0 tok/s");
    expect(status).toHaveAccessibleDescription(/verified parent event chronology is incomplete/i);
  });

  it("rejects performance that is not bound to the displayed session cursor", () => {
    const stale = { ...session, cursor: { runtimeGeneration: "g", sequence: 2 } };
    render(<RuntimeStatusBar session={stale} />);
    expect(screen.getByRole("status")).toHaveTextContent("first token unavailable");
    expect(screen.getByRole("status")).toHaveAccessibleDescription(/does not match this session snapshot/i);
  });
});
