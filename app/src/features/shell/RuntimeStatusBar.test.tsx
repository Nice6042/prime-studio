import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import { RuntimeStatusBar } from "./RuntimeStatusBar";

const session: RootSessionProjection = {
  sessionId: "session-1", accountId: "openai-codex", projectId: "p", chatId: "c",
  cursor: { runtimeGeneration: "g", sequence: 1 }, state: "working", parentMessages: [], children: [], queue: [], tools: [], resources: [],
  usage: { input: 1200, output: 340, cacheRead: 20, cacheWrite: 0, totalTokens: 1560, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null }, freshness: "live",
};

describe("RuntimeStatusBar", () => {
  it("shows only truthful current-session runtime and usage status", () => {
    render(<RuntimeStatusBar session={session} model="gpt-5.6-sol" thinking="high" contextLimit={272_000} tokensPerSecond={18.4} firstTokenMs={142} />);
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
    render(<RuntimeStatusBar session={session} model="gpt-5.6-sol" thinking="high" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("ctx unavailable");
    expect(status).toHaveTextContent("first token unavailable");
    expect(status).toHaveTextContent("throughput unavailable");
    expect(status).not.toHaveTextContent("0 tok/s");
  });
});
