import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  resolvePrimeCli: vi.fn().mockResolvedValue({
    path: null,
    source: null,
    shim: false,
    configured: null,
    daemon: false,
    daemonSocket: null,
    error: "unavailable",
  }),
  listAccounts: vi.fn().mockResolvedValue([]),
  getAppSettings: vi.fn().mockResolvedValue({ theme: "dark" }),
  listDiskSessions: vi.fn().mockResolvedValue([]),
  schedulerProjection: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    revision: 0,
    status: "planned",
    dispatchAvailable: false,
  }),
  setAppSetting: vi.fn(),
  openExternal: vi.fn().mockResolvedValue(null),
}));

const paneInstances = vi.hoisted(() => ({ next: 0 }));

vi.mock("./rpc", () => rpcMock);
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/ChatPane", () => ({
  ChatPane: ({
    active,
    accountId,
    panelId,
    tabId,
    theme,
    onTheme,
    onAccount,
  }: {
    active: boolean;
    accountId: string | null;
    panelId: string;
    tabId: string;
    theme: string;
    onTheme: () => void;
    onAccount: (id: string) => void;
  }) => {
    const [instance] = useState(() => ++paneInstances.next);
    return (
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        hidden={!active}
        data-account-id={accountId ?? "default"}
        data-instance={instance}
      >
        <main>
          <button type="button" data-testid="theme-toggle" data-theme={theme} onClick={onTheme}>
            toggle theme
          </button>
          {active && (
            <button type="button" onClick={() => onAccount("account-chatgpt")}>
              Open ChatGPT account
            </button>
          )}
        </main>
      </div>
    );
  },
}));
vi.mock("./components/Settings", () => ({
  Settings: () => null,
  isSection: () => false,
}));
vi.mock("./components/Usage", () => ({ Usage: () => null }));
vi.mock("./components/Fleet", () => ({ Fleet: () => null }));
vi.mock("./components/Toasts", () => ({ Toasts: () => null }));

import App from "./App";

describe("transactional application settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.connect.mockResolvedValue(undefined);
    rpcMock.resolvePrimeCli.mockResolvedValue({
      path: null,
      source: null,
      shim: false,
      configured: null,
      daemon: false,
      daemonSocket: null,
      error: "unavailable",
    });
    rpcMock.listAccounts.mockResolvedValue([]);
    rpcMock.getAppSettings.mockResolvedValue({ theme: "dark" });
    rpcMock.listDiskSessions.mockResolvedValue([]);
    rpcMock.schedulerProjection.mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      status: "planned",
      dispatchAvailable: false,
    });
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    paneInstances.next = 0;
  });

  it("never reads or writes a WebView theme cache during startup", async () => {
    localStorage.setItem("prime-theme", "light");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "dark"));
    expect(getItem).not.toHaveBeenCalledWith("prime-theme");
    expect(setItem).not.toHaveBeenCalledWith("prime-theme", expect.anything());
  });

  it("waits for startup account binding before scanning disk sessions", async () => {
    const resolvedCli = {
      path: null,
      source: null,
      shim: false,
      configured: null,
      daemon: false,
      daemonSocket: null,
      error: "unavailable",
    };
    let resolveCli!: (value: typeof resolvedCli) => void;
    rpcMock.resolvePrimeCli.mockImplementationOnce(
      () => new Promise<typeof resolvedCli>((resolve) => (resolveCli = resolve)),
    );
    rpcMock.listAccounts.mockResolvedValueOnce([
      {
        id: "work",
        label: "Work",
        provider: "anthropic",
        agentDir: "C:\\prime\\profiles\\work",
        createdAt: 1,
      },
    ]);

    render(<App />);

    await waitFor(() => expect(rpcMock.listDiskSessions).toHaveBeenCalledWith("work"));
    expect(rpcMock.listDiskSessions).toHaveBeenCalledTimes(1);
    expect(rpcMock.listDiskSessions).not.toHaveBeenCalledWith(null);

    await act(async () => resolveCli(resolvedCli));
    expect(rpcMock.listDiskSessions).toHaveBeenCalledTimes(1);
  });

  it("does not change the rendered theme when Rust denies the write", async () => {
    const user = userEvent.setup();
    rpcMock.setAppSetting.mockRejectedValueOnce(
      new Error("authority denied LocalConfigurationWrite"),
    );
    render(<App />);
    const toggle = await screen.findByTestId("theme-toggle");
    expect(toggle).toHaveAttribute("data-theme", "dark");

    await user.click(toggle);

    await waitFor(() => expect(rpcMock.setAppSetting).toHaveBeenCalledWith("theme", "light"));
    expect(toggle).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders only the native scheduler availability and never a dispatch control", async () => {
    render(<App />);

    const status = screen.getByRole("status", { name: "Scheduler status" });
    await waitFor(() => expect(status).toHaveTextContent("Scheduler: planned"));
    expect(screen.queryByRole("button", { name: /dispatch|run schedule/i })).not.toBeInTheDocument();
  });

  it("renders scheduler transport failure as unavailable instead of planned state", async () => {
    rpcMock.schedulerProjection.mockRejectedValueOnce(new Error("bridge unavailable"));

    render(<App />);

    await waitFor(() => expect(rpcMock.schedulerProjection).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status", { name: "Scheduler status" })).toHaveTextContent(
      "Scheduler: unavailable",
    );
  });
});

describe("session tab accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.connect.mockResolvedValue(undefined);
    rpcMock.resolvePrimeCli.mockResolvedValue({
      path: null,
      source: null,
      shim: false,
      configured: null,
      daemon: false,
      daemonSocket: null,
      error: "unavailable",
    });
    rpcMock.listAccounts.mockResolvedValue([]);
    rpcMock.getAppSettings.mockResolvedValue({ theme: "dark" });
    rpcMock.listDiskSessions.mockResolvedValue([]);
    rpcMock.schedulerProjection.mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      status: "planned",
      dispatchAvailable: false,
    });
    paneInstances.next = 0;
  });

  async function renderTabs(count: number) {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("tab");
    for (let index = 1; index < count; index += 1) {
      await user.click(screen.getByTitle("New tab (Ctrl+N)"));
    }
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(count));
    return user;
  }

  it("links each tab to exactly one owned panel and exposes only the active panel", async () => {
    await renderTabs(2);

    const tablist = screen.getByRole("tablist", { name: "Open sessions" });
    const tabs = within(tablist).getAllByRole("tab");
    const panels = screen.getAllByRole("tabpanel", { hidden: true });

    expect(Array.from(tablist.children)).toEqual(tabs);
    expect(within(tablist).queryByRole("button", { name: /close/i })).not.toBeInTheDocument();

    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
    tabs.forEach((tab, index) => {
      expect(panels[index]).toHaveAttribute("id", tab.getAttribute("aria-controls"));
      expect(panels[index]).toHaveAttribute("aria-labelledby", tab.id);
    });
    expect(panels[0]).not.toHaveAttribute("data-instance", panels[1].dataset.instance);
    expect(panels[0]).not.toBeVisible();
    expect(panels[1]).toBeVisible();
  });

  it("uses account and session titles to distinguish cross-account tabs and close controls", async () => {
    rpcMock.listAccounts.mockResolvedValueOnce([
      {
        id: "account-claude",
        label: "Claude work",
        provider: "anthropic",
        agentDir: "C:\\profiles\\claude",
        createdAt: 1,
      },
      {
        id: "account-chatgpt",
        label: "ChatGPT work",
        provider: "openai-codex",
        agentDir: "C:\\profiles\\chatgpt",
        createdAt: 2,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open ChatGPT account" }));

    expect(screen.getByRole("tab", { name: "Claude work — New chat" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "ChatGPT work — New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Claude work — New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close ChatGPT work — New chat" })).toBeInTheDocument();
  });

  it("moves roving focus with arrows, Home, and End, then activates with Enter or Space", async () => {
    const user = await renderTabs(3);
    let tabs = screen.getAllByRole("tab");
    tabs[2].focus();

    await user.keyboard("{ArrowRight}");
    tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard(" ");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2]).toHaveFocus();
  });

  it("focuses and activates the adjacent tab after closing without remounting surviving panes", async () => {
    const user = await renderTabs(3);
    let tabs = screen.getAllByRole("tab");
    await user.click(tabs[1]);
    const firstPanel = screen.getAllByRole("tabpanel", { hidden: true })[0];
    const firstInstance = firstPanel.dataset.instance;

    await user.click(screen.getAllByRole("button", { name: "Close Default — New chat" })[1]);

    tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tabpanel", { hidden: true })[0]).toHaveAttribute(
      "data-instance",
      firstInstance,
    );

    await user.click(screen.getAllByRole("button", { name: "Close Default — New chat" })[1]);
    tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Close Default — New chat" }));
    const replacement = screen.getByRole("tab");
    expect(replacement).toHaveFocus();
    expect(replacement).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-account-id", "default");
  });
});
