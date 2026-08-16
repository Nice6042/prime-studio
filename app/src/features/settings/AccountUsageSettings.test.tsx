import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../../rpc";
import type { Account } from "../../types";
import type { SubscriptionQuotaProjection } from "../../quotaProjection";
import { AccountUsageSettings, buildAccountUsageCsv } from "./AccountUsageSettings";

vi.mock("../../rpc", () => ({ accountUsageSeriesStrict: vi.fn() }));

const accounts: Account[] = [
  { id: "work", label: "Work", provider: "openai-codex", agentDir: "C:\\profiles\\shared", createdAt: 1 },
  { id: "claude", label: "Claude", provider: "anthropic", agentDir: "C:\\profiles\\claude", createdAt: 2 },
];

const quota: SubscriptionQuotaProjection = {
  accountFacts: [{
    scope: "account", accountId: "work", provider: "openai-codex", source: "codex_cli_snapshot",
    availability: "available", percent: 42.5, windowMinutes: 300, planType: "pro", observedAt: 1_799_999_000_000,
  }, {
    scope: "account", accountId: "claude", provider: "anthropic", source: "anthropic_rate_limits",
    availability: "unavailable", reason: "anthropic_not_reported",
  }],
  providerFacts: [],
};

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

  it("only enables daily chart dimensions that the ledger can attribute", async () => {
    render(<AccountUsageSettings accounts={accounts} />);
    await screen.findByRole("img", { name: /Daily cost over 7 days/i });

    const accountHistory = screen.getByRole("button", { name: "Account history" });
    expect(accountHistory).toBeEnabled();
    expect(screen.getByRole("button", { name: "Subagents unavailable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tools unavailable" })).toBeDisabled();

    const subagentPolicy = screen.getByRole("note", { name: "Subagent daily series unavailable" });
    const toolPolicy = screen.getByRole("note", { name: "Tool daily series unavailable" });
    expect(subagentPolicy).toHaveAttribute("tabindex", "0");
    expect(toolPolicy).toHaveAttribute("tabindex", "0");
    accountHistory.focus();
    await userEvent.tab();
    expect(subagentPolicy).toHaveFocus();
    expect(subagentPolicy).toHaveTextContent(/does not report subagent attribution/i);
  });

  it("keeps unsupported chat, task, model, project, and attribution facts explicit while rendering quota separately", async () => {
    render(<AccountUsageSettings accounts={accounts} quota={quota} quotaStatus="ready" />);
    await screen.findByRole("img", { name: /Daily cost over 7 days/ });

    for (const name of ["Chats", "Tasks", "Model breakdown", "Project breakdown"]) {
      const unavailable = screen.getByRole("note", { name: `${name} unavailable` });
      expect(unavailable).toHaveAttribute("tabindex", "0");
      expect(unavailable).toHaveTextContent(/not reported|does not report/i);
    }

    expect(screen.getByRole("heading", { name: "Subscription quota" })).toBeVisible();
    expect(screen.getByText("42.5%")).toBeVisible();
    expect(screen.getByText(/not reported by this prime build/i)).toBeVisible();
    expect(screen.getByText("API-equivalent cost")).toBeVisible();

    const subagents = screen.getByRole("button", { name: "Subagents unavailable" });
    const tools = screen.getByRole("button", { name: "Tools unavailable" });
    expect(subagents).toBeDisabled();
    expect(tools).toBeDisabled();
  });

  it("refreshes cost and quota together while retaining proven quota after a failed refresh", async () => {
    const onRefreshQuota = vi.fn(async () => ({ status: "preserved" as const, message: "Quota refresh failed; showing the last proven snapshot." }));
    render(<AccountUsageSettings accounts={accounts} quota={quota} quotaStatus="ready" onRefreshQuota={onRefreshQuota} />);

    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onRefreshQuota).toHaveBeenCalledOnce());
    expect(screen.getByText("42.5%")).toBeVisible();
    expect(await screen.findByRole("status")).toHaveTextContent(/last proven snapshot/i);
  });

  it("does not present invented zero totals when no account ledger can be queried", async () => {
    render(<AccountUsageSettings accounts={[]} />);
    expect(await screen.findByRole("status", { name: "Account usage unavailable" })).toHaveTextContent(/No account ledger is available/i);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });

  it("does not flash a zero total while the first verified ledger read is pending", async () => {
    let resolveUsage!: (rows: []) => void;
    const loadUsage = vi.fn(() => new Promise<[]>((resolve) => { resolveUsage = resolve; }));
    render(<AccountUsageSettings accounts={[accounts[0]]} loadUsage={loadUsage} />);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    resolveUsage([]);
    await waitFor(() => expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0));
  });

  it("reconciles a failed ledger read as unavailable rather than zero usage", async () => {
    vi.mocked(rpc.accountUsageSeriesStrict).mockRejectedValueOnce(new Error("ledger unavailable"));
    render(<AccountUsageSettings accounts={[accounts[0]]} />);
    expect(await screen.findByRole("status", { name: "Account usage unavailable" })).toHaveTextContent(/could not be read/i);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
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

  it("fails closed when the local ledger returns an invalid row", async () => {
    const loadUsage = vi.fn(async () => [{ ts: -1, provider: "openai-codex", cost: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]);
    render(<AccountUsageSettings accounts={[accounts[0]]} loadUsage={loadUsage} />);

    expect(await screen.findByRole("status", { name: "Account usage unavailable" })).toHaveTextContent(/could not be read/i);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("does not duplicate same-provider shared-ledger totals across account rows", async () => {
    const shared = [accounts[0], { ...accounts[0], id: "work-copy", label: "Work copy" }];
    render(<AccountUsageSettings accounts={shared} />);

    await screen.findByRole("img", { name: /Daily cost over 7 days/i });
    expect(screen.getAllByText("Shared ledger · attribution unavailable")).toHaveLength(2);
    expect(screen.getByLabelText("Work usage attribution unavailable")).toBeVisible();
    expect(screen.getByLabelText("Work copy usage attribution unavailable")).toBeVisible();
  });
});
