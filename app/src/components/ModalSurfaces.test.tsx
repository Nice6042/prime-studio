import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../rpc";
import type { FleetAgent } from "../types";
import { Fleet } from "./Fleet";
import { Settings } from "./Settings";
import { Usage } from "./Usage";

vi.mock("../rpc", () => ({
  accountStatuses: vi.fn(),
  accountUsageSeries: vi.fn(),
  codexSubscriptionUsage: vi.fn(),
  fleetList: vi.fn(),
  renameAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

const agent: FleetAgent = {
  id: "agent-1",
  name: "Alpha",
  activity: "idle",
  lifecycle: "running",
  cwd: "C:\\workspace",
  provider: "anthropic",
  model: "claude",
  thinking: null,
  contextWindow: null,
  messages: 3,
  clients: 0,
  created: null,
  modified: null,
  lastActivity: null,
  sessionId: "session-1",
  sessionFile: "C:\\sessions\\session-1.jsonl",
  firstMessage: "Help",
  summary: null,
  streaming: false,
  runningTools: false,
  runningChildren: false,
  queued: 0,
  depth: 0,
  accountId: null,
  cost: 0,
  tokens: 0,
  attachedHere: false,
};

beforeEach(() => {
  vi.mocked(rpc.accountStatuses).mockReset().mockResolvedValue([]);
  vi.mocked(rpc.accountUsageSeries).mockReset().mockResolvedValue([]);
  vi.mocked(rpc.codexSubscriptionUsage).mockReset().mockResolvedValue(null);
  vi.mocked(rpc.fleetList).mockReset().mockResolvedValue({
    agents: [agent],
    daemon: true,
    error: null,
  });
  vi.mocked(rpc.stopAgent).mockReset().mockResolvedValue("stopped");
});

describe("modal surface accessibility", () => {
  it("contains Settings focus, makes the background inert, and restores its opener", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main data-testid="background">
            <button onClick={() => setOpen(true)}>Open settings</button>
          </main>
          {open && (
            <Settings
              section="appearance"
              onSection={vi.fn()}
              onClose={() => setOpen(false)}
              accounts={[]}
              onAccountsChanged={vi.fn()}
              onUse={vi.fn()}
              cli={null}
              onCli={vi.fn()}
              models={[]}
              settings={{ theme: "dark" }}
              onSetting={vi.fn()}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("background")).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "Close settings" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "System" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByTestId("background")).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
  });

  it("names Usage, focuses its close action, and restores focus after Escape", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main data-testid="background">
            <button onClick={() => setOpen(true)}>Open usage</button>
          </main>
          {open && <Usage accounts={[]} onClose={() => setOpen(false)} />}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open usage" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Usage" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("background")).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "Close usage" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("gives the nested stop dialog topmost focus and Escape ownership", async () => {
    const user = userEvent.setup();
    const closeFleet = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main data-testid="background">
            <button onClick={() => setOpen(true)}>Open fleet</button>
          </main>
          {open && (
            <Fleet
              accounts={[]}
              onAttach={vi.fn()}
              onRead={vi.fn()}
              onClose={() => {
                closeFleet();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open fleet" });
    await user.click(opener);

    const fleetDialog = screen.getByRole("dialog", { name: "Fleet" });
    expect(fleetDialog).toHaveAttribute("aria-modal", "true");
    expect(within(fleetDialog).getByRole("button", { name: "Close" })).toHaveFocus();

    const stopOpener = await within(fleetDialog).findByRole("button", { name: "STOP" });
    await user.click(stopOpener);

    let stopDialog = screen.getByRole("dialog", { name: "Stop Alpha?" });
    expect(stopDialog).toHaveAttribute("aria-modal", "true");
    expect(within(stopDialog).getByRole("button", { name: "Keep it running" })).toHaveFocus();
    expect(fleetDialog.closest("[inert]")).not.toBeNull();

    await user.click(within(stopDialog).getByRole("button", { name: "Keep it running" }));
    expect(screen.queryByRole("dialog", { name: "Stop Alpha?" })).not.toBeInTheDocument();
    expect(stopOpener).toHaveFocus();
    expect(fleetDialog.closest("[inert]")).toBeNull();

    await user.click(stopOpener);
    stopDialog = screen.getByRole("dialog", { name: "Stop Alpha?" });
    fireEvent.keyDown(stopDialog, { key: "Tab" });
    expect(within(stopDialog).getByRole("button", { name: "Stop agent" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Stop Alpha?" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Fleet" })).toBeInTheDocument();
    expect(closeFleet).not.toHaveBeenCalled();
    expect(stopOpener).toHaveFocus();
    expect(fleetDialog.closest("[inert]")).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fleet" })).not.toBeInTheDocument());
    expect(closeFleet).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it("keeps focus in Fleet when confirming Stop disables the dialog opener", async () => {
    const user = userEvent.setup();
    let finishStop!: (result: string) => void;
    const pendingStop = new Promise<string>((resolve) => {
      finishStop = resolve;
    });
    vi.mocked(rpc.stopAgent).mockReturnValueOnce(pendingStop);

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open fleet</button>
          {open && (
            <Fleet
              accounts={[]}
              onAttach={vi.fn()}
              onRead={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open fleet" }));

    const fleetDialog = screen.getByRole("dialog", { name: "Fleet" });
    const closeFleet = within(fleetDialog).getByRole("button", { name: "Close" });
    const stopOpener = await within(fleetDialog).findByRole("button", { name: "STOP" });
    await user.click(stopOpener);
    await user.click(
      within(screen.getByRole("dialog", { name: "Stop Alpha?" })).getByRole("button", {
        name: "Stop agent",
      }),
    );

    expect(screen.queryByRole("dialog", { name: "Stop Alpha?" })).not.toBeInTheDocument();
    expect(stopOpener).toBeDisabled();
    expect(closeFleet).toHaveFocus();
    expect(fleetDialog.closest("[inert]")).toBeNull();

    finishStop("stopped");
    await waitFor(() => expect(stopOpener).not.toBeDisabled());
  });
});
