import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../rpc";
import type { Account } from "../types";
import { Fleet } from "./Fleet";

vi.mock("../rpc", () => ({
  fleetList: vi.fn(),
  accountStatuses: vi.fn(),
  stopAgent: vi.fn(),
  renameAgent: vi.fn(),
}));

const accounts: Account[] = [
  {
    id: "claude-work",
    label: "Claude work",
    provider: "anthropic",
    agentDir: "C:\\profiles\\claude-work",
    createdAt: 1,
  },
  {
    id: "chatgpt-work",
    label: "ChatGPT work",
    provider: "openai-codex",
    agentDir: "C:\\profiles\\chatgpt-work",
    createdAt: 2,
  },
];

describe("Fleet account status snapshot", () => {
  beforeEach(() => {
    vi.mocked(rpc.fleetList).mockReset().mockResolvedValue({
      agents: [],
      daemon: false,
      error: null,
    });
    vi.mocked(rpc.accountStatuses).mockReset().mockResolvedValue([
      {
        accountId: accounts[0].id,
        available: true,
        status: {
          authed: true,
          expires: null,
          provider: accounts[0].provider,
          health: "signedIn",
          expiresInMs: null,
        },
      },
      { accountId: accounts[1].id, available: false, status: null },
    ]);
  });

  it("uses one bounded batch and keeps unavailable truth out of signed-out bookkeeping", async () => {
    render(
      <Fleet
        accounts={accounts}
        onAttach={vi.fn()}
        onRead={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(rpc.accountStatuses).toHaveBeenCalledOnce());
    expect(rpc.accountStatuses).toHaveBeenCalledWith(accounts.map((account) => account.id));
  });
});
