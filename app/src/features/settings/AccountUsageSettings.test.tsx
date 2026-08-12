import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../../rpc";
import type { Account } from "../../types";
import { AccountUsageSettings, buildAccountUsageCsv } from "./AccountUsageSettings";

vi.mock("../../rpc", () => ({ accountUsageSeriesStrict: vi.fn() }));

const accounts: Account[] = [
  { id: "work", label: "Work", provider: "openai-codex", agentDir: "C:\\profiles\\shared", createdAt: 1 },
  { id: "claude", label: "Claude", provider: "anthropic", agentDir: "C:\\profiles\\claude", createdAt: 2 },
];

describe("AccountUsageSettings", () => {
  beforeEach(() => {
    vi.mocked(rpc.accountUsageSeriesStrict).mockImplementation(async (id, days) => id === "work" ? [
      { ts: Date.now(), provider: "openai-codex", cost: days, input: 100, output: 20, cacheRead: 30, cacheWrite: 0 },
    ] : [
      { ts: Date.now(), provider: "anthropic", cost: 2, input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it("renders verified account-wide rows without calling them current-chat usage", async () => {
    render(<AccountUsageSettings accounts={accounts} />);
    await waitFor(() => expect(screen.getAllByText("$9.00").length).toBeGreaterThan(0));
    expect(screen.getByText("140")).toBeVisible();
    expect(screen.getByRole("img", { name: /Daily cost over 7 days/ })).toBeVisible();
    expect(screen.getAllByRole("row", { name: /ChatGPT/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("row", { name: /Claude/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Current chat$/i)).not.toBeInTheDocument();
  });

  it("reloads the native accounting window and can switch to tokens", async () => {
    render(<AccountUsageSettings accounts={accounts} />);
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(rpc.accountUsageSeriesStrict).toHaveBeenCalledWith("work", 30));
    await userEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getAllByText("200").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("does not double count accounts that share one agent directory", async () => {
    render(<AccountUsageSettings accounts={[accounts[0], { ...accounts[0], id: "work-copy", label: "Work copy" }]} />);
    await waitFor(() => expect(rpc.accountUsageSeriesStrict).toHaveBeenCalledTimes(1));
  });

  it("renders an accessible SVG chart and exports a formula-safe truth table", async () => {
    const onExportCsv = vi.fn(async (_csv: string, _range: 7 | 30 | 90) => ({ status: "saved" as const, path: "chosen.csv", rows: 2, bytes: 120 }));
    render(<AccountUsageSettings accounts={accounts} onExportCsv={onExportCsv} />);
    expect(await screen.findByRole("img", { name: /Daily cost over 7 days/ })).toHaveAttribute("data-chart", "account-usage");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(onExportCsv).toHaveBeenCalledOnce());
    expect(onExportCsv.mock.calls[0]?.[0]).toContain("timestamp,provider,cost,input,output,cache_read,cache_write");

    expect(buildAccountUsageCsv([{ ts: 1, provider: "=HYPERLINK(\"x\")", cost: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }]))
      .toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });

  it("reports native save-dialog cancellation explicitly", async () => {
    const onExportCsv = vi.fn(async () => ({ status: "cancelled" as const }));
    render(<AccountUsageSettings accounts={accounts} onExportCsv={onExportCsv} />);
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Export cancelled");
  });
});
