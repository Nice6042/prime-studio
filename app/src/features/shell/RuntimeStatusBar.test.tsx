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
    render(<RuntimeStatusBar
      session={session}
      composer={{ sessionId: session.sessionId, cursor: session.cursor, model: "gpt-5.6-sol", thinking: "high" }}
      inspector={{ status: "available", sessionId: session.sessionId, cursor: session.cursor, context: { usedTokens: 15_200, capacityTokens: 40_000 }, overload: null }}
    />);
    expect(screen.getByText(/openai-codex · gpt-5.6-sol · thinking high/)).toBeVisible();
    expect(screen.getByText(/ctx 38%/)).toBeVisible();
    expect(screen.getByText(/15.2k \/ 40k/)).toBeVisible();
    expect(screen.getByText(/142ms first token/)).toBeVisible();
    expect(screen.getByText(/18.4 tok\/s/)).toBeVisible();
    expect(screen.getByText(/working · connected/)).toBeVisible();
  });

  it("states unavailable instead of fabricating telemetry", () => {
    render(<RuntimeStatusBar session={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Harness unavailable");
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it("labels absent per-chat evidence unavailable", () => {
    const unavailable: RootSessionProjection = {
      ...session,
      performance: { status: "unavailable", sessionId: session.sessionId, cursor: session.cursor, reason: "event_chronology_incomplete" },
    };
    render(<RuntimeStatusBar session={unavailable}
      composer={{ sessionId: unavailable.sessionId, cursor: unavailable.cursor, model: "gpt-5.6-sol", thinking: "high" }}
      inspector={{ status: "unavailable", sessionId: unavailable.sessionId, cursor: unavailable.cursor, reason: "Inspector evidence is unavailable." }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("ctx unavailable");
    expect(status).toHaveTextContent("overload unavailable");
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

  it("rejects stale composer and inspector identities and never renders their values", () => {
    render(<RuntimeStatusBar
      session={session}
      composer={{ sessionId: session.sessionId, cursor: { ...session.cursor, sequence: 9 }, model: "stale-model", thinking: "max" }}
      inspector={{ status: "available", sessionId: "other-session", cursor: session.cursor, context: { usedTokens: 1, capacityTokens: 2 }, overload: "server_is_overloaded" }}
    />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("model unavailable");
    expect(status).toHaveTextContent("thinking unavailable");
    expect(status).toHaveTextContent("ctx unavailable");
    expect(status).toHaveTextContent("overload unavailable");
    expect(status).not.toHaveTextContent("stale-model");
    expect(status).not.toHaveTextContent("server_is_overloaded");
  });

  it("shows exact overload truth and treats an admitted zero-token context as zero, not unavailable", () => {
    render(<RuntimeStatusBar session={{ ...session, state: "idle" }}
      inspector={{ status: "available", sessionId: session.sessionId, cursor: session.cursor, context: { usedTokens: 0, capacityTokens: 40_000 }, overload: "server_is_overloaded" }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("ctx 0%");
    expect(status).toHaveTextContent("0 / 40k");
    expect(status).toHaveTextContent("server_is_overloaded");
    expect(status).not.toHaveTextContent("ctx unavailable");
  });

  it("fails hostile context bounds closed with an explicit reason", () => {
    render(<RuntimeStatusBar session={session} inspector={{ status: "available", sessionId: session.sessionId, cursor: session.cursor, context: { usedTokens: 50_000, capacityTokens: 40_000 }, overload: null }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("ctx unavailable");
    expect(status).not.toHaveTextContent("125%");
    expect(status).toHaveAccessibleDescription(/context evidence is invalid/i);
  });

  it("keeps stale and unknown-outcome connection truth distinct", () => {
    const view = render(<RuntimeStatusBar session={{ ...session, freshness: "stale" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("working · stale");
    view.rerender(<RuntimeStatusBar session={{ ...session, freshness: "unknown_outcome" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("working · outcome unknown");
    expect(screen.getByRole("status")).not.toHaveTextContent("working · stale");
  });

  it("describes verified null composer selections and titles compactable exact values", () => {
    render(<RuntimeStatusBar session={session}
      composer={{ sessionId: session.sessionId, cursor: session.cursor, model: null, thinking: null }}
      inspector={{ status: "available", sessionId: session.sessionId, cursor: session.cursor, context: { usedTokens: 15_200, capacityTokens: 40_000 }, overload: "server_is_overloaded" }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAccessibleDescription(/no selected model or thinking level/i);
    expect(screen.getByText(/ctx 38%/)).toHaveAttribute("title", "ctx 38% · 15.2k / 40k");
    expect(screen.getByText("18.4 tok/s")).toHaveAttribute("title", "18.4 tok/s");
    expect(screen.getByText("server_is_overloaded")).toHaveAttribute("title", "server_is_overloaded");
  });
});
