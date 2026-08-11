import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../../rpc";
import type { Account } from "../../types";
import { AccountUsageSettings } from "./AccountUsageSettings";

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
    await waitFor(() => expect(screen.getByText("$9.00")).toBeVisible());
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
    expect(screen.getByText("200")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("does not double count accounts that share one agent directory", async () => {
    render(<AccountUsageSettings accounts={[accounts[0], { ...accounts[0], id: "work-copy", label: "Work copy" }]} />);
    await waitFor(() => expect(rpc.accountUsageSeriesStrict).toHaveBeenCalledTimes(1));
  });
});
