import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CurrentChatUsage } from "../../shared/ipc/harness.generated";
import type { HarnessPanelDetails } from "./adapter";
import { ChatUsage } from "./ChatUsage";

const usage: CurrentChatUsage = { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165, cost: null };

const details: HarnessPanelDetails = {
  observedAtMs: Date.UTC(2026, 7, 12, 12, 10),
  startedAtMs: Date.UTC(2026, 7, 12, 12, 0),
  context: { usedTokens: 15_200, capacityTokens: 40_000, turns: 3, samples: [0.2, 0.28, 0.38] },
  turnUsage: [
    { turn: 1, input: 20, output: 10, totalTokens: 30 },
    { turn: 2, input: 35, output: 15, totalTokens: 50 },
    { turn: 3, input: 45, output: 15, totalTokens: 60 },
  ],
  contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {},
};

describe("ChatUsage", () => {
  it("renders evidence-backed turn and context charts with an accessible data table", () => {
    render(<ChatUsage usage={usage} details={details} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByRole("img", { name: "Tokens by turn" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Context utilization history" })).toBeVisible();
    const table = screen.getByRole("table", { name: "Tokens by turn data" });
    expect(within(table).getByRole("columnheader", { name: "Turn" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "60" })).toBeVisible();
    expect(screen.getByText("10m")).toBeVisible();
  });

  it("states which evidence is unavailable instead of drawing zero-value charts", () => {
    render(<ChatUsage usage={usage} details={{ ...details, startedAtMs: null, context: null, turnUsage: undefined }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.queryByRole("img", { name: "Tokens by turn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Context utilization history" })).not.toBeInTheDocument();
    expect(screen.getByText("Per-turn token history is unavailable.")).toBeVisible();
    expect(screen.getByText("Context history is unavailable.")).toBeVisible();
    expect(screen.getByText("Elapsed unavailable")).toBeVisible();
  });

  it("normalizes observed token-count context samples against the real capacity", () => {
    render(<ChatUsage usage={usage} details={{ ...details, context: { usedTokens: 15_200, capacityTokens: 40_000, samples: [4_000, 8_000, 12_000] } }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByRole("img", { name: "Context utilization history" })).toBeVisible();
    expect(screen.getByText("30% latest")).toBeVisible();
  });

  it("marks current-chat totals unavailable when the daemon reports no usage evidence", () => {
    const unavailable: CurrentChatUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null };
    render(<ChatUsage usage={unavailable} details={null} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText("Chat usage unavailable")).toBeVisible();
    expect(screen.getByText("Token-type usage is unavailable.")).toBeVisible();
    expect(screen.queryByText("0%")) .not.toBeInTheDocument();
  });
});
