import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense, useState, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../rpc";
import { nativeBrowserAdmissionClient } from "../browser/nativeClient";
import { SurfaceFallback } from "../lazyBoundaries";
import type { Account } from "../types";
import { Settings } from "./Settings";

vi.mock("../rpc", () => {
  class AccountDeletionError extends Error {
    readonly code: string;

    constructor(code: string) {
      super("Account removal failed.");
      this.name = "AccountDeletionError";
      this.code = code;
    }
  }

  return {
    AccountDeletionError,
    accountStatuses: vi.fn(),
    accountUsage: vi.fn(),
    codexSubscriptionUsage: vi.fn(),
    addAccount: vi.fn(),
    beginAccountLogin: vi.fn(),
    renameAccount: vi.fn(),
    prepareRemoveAccount: vi.fn(),
    commitRemoveAccount: vi.fn(),
    listAccountsStrict: vi.fn(),
    setPrimeCli: vi.fn(),
    checkPrimeCli: vi.fn(),
    kernelStatus: vi.fn(),
    pickDirectory: vi.fn(),
    openExternal: vi.fn(),
  };
});

vi.mock("../browser/nativeClient", () => ({
  NATIVE_BROWSER_UNAVAILABLE: {
    contractVersion: 1,
    authority: "native",
    admissionReadiness: "unavailable",
    executorReadiness: "unavailable",
    authorityGateReadiness: "unavailable",
    dispatchAvailable: false,
    reason: "native_browser_status_unavailable",
  },
  nativeBrowserAdmissionClient: {
    readSecurityStatus: vi.fn(),
    checkReadOnlyIntent: vi.fn(),
  },
}));

const account: Account = {
  id: "claude-work",
  label: "Claude work",
  provider: "anthropic",
  agentDir: "C:\\stored-hostile\\token=do-not-render",
  createdAt: 1,
};

describe("Settings with account removal open", () => {
  beforeEach(() => {
    vi.mocked(rpc.accountStatuses).mockReset().mockResolvedValue([]);
    vi.mocked(rpc.accountUsage).mockReset().mockResolvedValue(null);
    vi.mocked(rpc.codexSubscriptionUsage).mockReset().mockResolvedValue(null);
  });

  it("lets the native deletion dialog own Escape instead of closing Settings", async () => {
    const user = userEvent.setup();
    const closeSettings = vi.fn();
    render(
      <Settings
        section="accounts"
        onSection={vi.fn()}
        onClose={closeSettings}
        accounts={[account]}
        onAccountsChanged={vi.fn()}
        onUse={vi.fn()}
        cli={null}
        onCli={vi.fn()}
        models={[]}
        settings={{}}
        onSetting={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("dialog", { name: "Remove Claude work?" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Remove Claude work?" })).not.toBeInTheDocument();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("lets a topmost unresolved Usage close before loaded Settings", async () => {
    const user = userEvent.setup();
    const closeSettings = vi.fn();
    const closeUsage = vi.fn();
    const onAbort = vi.fn();
    let resolveUsage: ((module: { default: ComponentType }) => void) | undefined;
    const DeferredUsage = lazy(
      () =>
        new Promise<{ default: ComponentType }>((resolve) => {
          resolveUsage = resolve;
        }),
    );

    function Harness() {
      const [settingsOpen, setSettingsOpen] = useState(true);
      const [usageOpen, setUsageOpen] = useState(true);
      return (
        <>
          <button>Surface opener</button>
          {settingsOpen && (
            <Settings
              section="accounts"
              onSection={vi.fn()}
              onClose={() => {
                closeSettings();
                setSettingsOpen(false);
              }}
              accounts={[account]}
              onAccountsChanged={vi.fn()}
              onUse={vi.fn()}
              cli={null}
              onCli={vi.fn()}
              models={[]}
              settings={{}}
              onSetting={vi.fn()}
            />
          )}
          {usageOpen && (
            <Suspense
              fallback={
                <SurfaceFallback
                  surface="modal"
                  label="Loading usage"
                  onClose={() => {
                    closeUsage();
                    setUsageOpen(false);
                  }}
                />
              }
            >
              <DeferredUsage />
            </Suspense>
          )}
        </>
      );
    }

    window.addEventListener("keydown", onAbort);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Surface opener" });
      opener.focus();

      await user.keyboard("{Escape}");
      expect(closeUsage).toHaveBeenCalledTimes(1);
      expect(closeSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole("status", { name: "Loading usage" })).not.toBeInTheDocument();
      expect(screen.getByText("Settings")).toBeInTheDocument();
      expect(onAbort).not.toHaveBeenCalled();
      expect(opener).toHaveFocus();

      await act(async () =>
        resolveUsage?.({
          default: () => <input aria-label="Usage loaded" autoFocus />,
        }),
      );
      expect(screen.queryByRole("textbox", { name: "Usage loaded" })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(closeSettings).toHaveBeenCalledTimes(1);
      expect(onAbort).not.toHaveBeenCalled();
      expect(opener).toHaveFocus();
    } finally {
      window.removeEventListener("keydown", onAbort);
    }
  });
});

describe("Settings connected tools", () => {
  beforeEach(() => {
    vi.mocked(nativeBrowserAdmissionClient.readSecurityStatus).mockReset();
  });

  const renderTools = () =>
    render(
      <Settings
        section="tools"
        onSection={vi.fn()}
        onClose={vi.fn()}
        accounts={[]}
        onAccountsChanged={vi.fn()}
        onUse={vi.fn()}
        cli={null}
        onCli={vi.fn()}
        models={[]}
        settings={{}}
        onSetting={vi.fn()}
      />,
    );

  it("renders admission_only separately from the unavailable executor", async () => {
    vi.mocked(nativeBrowserAdmissionClient.readSecurityStatus).mockResolvedValue({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "admission_only",
      executorReadiness: "unavailable",
      authorityGateReadiness: "unavailable",
      dispatchAvailable: false,
      reason: "native_browser_executor_unavailable",
    });

    renderTools();

    expect(await screen.findByText("admission_only")).toBeInTheDocument();
    expect(screen.getByText("unavailable", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/no browser effect dispatch route is installed/i)).toBeInTheDocument();
    expect(screen.queryByText(/^enabled$/i)).not.toBeInTheDocument();
  });

  it("renders unavailable when the native status projection cannot be read", async () => {
    vi.mocked(nativeBrowserAdmissionClient.readSecurityStatus).mockRejectedValue(
      new Error("native bridge unavailable"),
    );

    renderTools();

    expect(await screen.findByText("unavailable", { selector: ".pill" })).toBeInTheDocument();
    expect(screen.queryByText(/^enabled$/i)).not.toBeInTheDocument();
  });
});

describe("Settings form labels", () => {
  it("associates every new-session picker with its visible row label", () => {
    render(
      <Settings
        section="defaults"
        onSection={vi.fn()}
        onClose={vi.fn()}
        accounts={[account]}
        onAccountsChanged={vi.fn()}
        onUse={vi.fn()}
        cli={null}
        onCli={vi.fn()}
        models={[]}
        settings={{}}
        onSetting={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Provider & model" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Thinking level" })).toBeInTheDocument();
  });
});
