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
  turnUsage: {
    totalTurns: 3,
    omittedTurns: 0,
    rows: [
      { turn: 1, occurredAtMs: 1, input: 20, output: 10, cacheRead: 4, cacheWrite: 1, totalTokens: 35 },
      { turn: 2, occurredAtMs: 2, input: 35, output: 15, cacheRead: 3, cacheWrite: 2, totalTokens: 55 },
      { turn: 3, occurredAtMs: 3, input: 45, output: 15, cacheRead: 5, cacheWrite: 0, totalTokens: 65 },
    ],
  },
  contributions: [], notices: [], activity: [], outputs: [], sources: [], children: {},
};

describe("ChatUsage", () => {
  it("renders evidence-backed turn and context charts with an accessible data table", () => {
    render(<ChatUsage usage={usage} details={details} onRefresh={vi.fn()} refreshing={false} />);

    const turnChart = screen.getByRole("img", { name: "Tokens by turn" });
    expect(turnChart).toBeVisible();
    expect(turnChart.querySelectorAll("rect")).toHaveLength(12);
    expect(screen.getByRole("img", { name: "Context utilization history" })).toBeVisible();
    const table = screen.getByRole("table", { name: "Tokens by turn data" });
    expect(within(table).getByRole("columnheader", { name: "Turn" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "65" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Cache read" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Cache write" })).toBeVisible();
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

  it("withholds a contribution breakdown when categories cannot reconcile without double counting", () => {
    render(<ChatUsage usage={usage} details={{ ...details, contributions: [
      { id: "main", label: "Main chat", tokens: 165 },
      { id: "children", label: "Subagents", tokens: 40 },
    ] }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText("Parent and child attribution is unavailable. Totals are not guessed.")).toBeVisible();
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
  });

  it("does not treat coincident child context occupancy as a current-chat token partition", () => {
    render(<ChatUsage usage={usage} details={{ ...details, contributions: [
      { id: "child-context", label: "Subagents", tokens: 165 },
    ] }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText("Parent and child attribution is unavailable. Totals are not guessed.")).toBeVisible();
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
  });

  it("renders attribution only from an explicitly projected current-chat token partition", () => {
    render(<ChatUsage usage={usage} details={{ ...details, contributionPartition: {
      unit: "current_chat_tokens", totalTokens: 165,
      contributions: [{ id: "parent", label: "Main chat", tokens: 115 }, { id: "children", label: "Subagents", tokens: 40 }, { id: "tools", label: "Tools", tokens: 10 }],
    } }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText("Main chat")).toBeVisible();
    expect(screen.getByText("Subagents")).toBeVisible();
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

  it("labels a bounded series without presenting retained rows as the full chat", () => {
    render(<ChatUsage usage={usage} details={{ ...details, turnUsage: { ...details.turnUsage!, totalTurns: 8, omittedTurns: 5, rows: details.turnUsage!.rows.map((row) => ({ ...row, turn: row.turn + 5 })) } }} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText("8 turns · last 3 shown")).toBeVisible();
    expect(screen.getByText("5 earlier turns are omitted from this bounded view.")).toBeVisible();
  });

  it("makes the horizontally scrollable turn table keyboard reachable", () => {
    render(<ChatUsage usage={usage} details={details} onRefresh={vi.fn()} refreshing={false} />);

    const region = screen.getByRole("region", { name: "Scrollable tokens by turn data" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(screen.getByRole("table", { name: "Tokens by turn data" }));
  });
});
