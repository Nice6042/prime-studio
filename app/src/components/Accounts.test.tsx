import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as rpc from "../rpc";
import type { Account, AccountRemovalPlan, AccountStatusSnapshot } from "../types";
import { Accounts } from "./Accounts";
import "../styles.css";

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
  };
});

const account: Account = {
  id: "claude-work",
  label: "Claude work",
  provider: "anthropic",
  agentDir: "C:\\stored-hostile\\token=do-not-render",
  createdAt: 1,
};

const survivor: Account = {
  ...account,
  id: "claude-personal",
  label: "Claude personal",
  agentDir: "C:\\stored-hostile\\survivor-do-not-render",
  createdAt: 2,
};

const removalPlan = (
  deleteData: boolean,
  overrides: Partial<AccountRemovalPlan> = {},
): AccountRemovalPlan => ({
  planId: deleteData ? "data-plan" : "entry-plan",
  accountLabel: account.label,
  targetPath: "C:\\Users\\operator\\.prime\\profiles\\claude-work",
  deleteData,
  expiresAtMs: Date.now() + 60_000,
  registryGeneration: "generation",
  targetIdentity: { volume: 4, file: 7 },
  estimate: { items: 12, bytes: 34_000, truncated: false },
  checks: {
    activeSession: false,
    sharedProfile: false,
    defaultOrMigrated: false,
    storedPathMatches: true,
    directChild: true,
    reparsePoint: false,
    dataDeletionAllowed: true,
  },
  blockers: [],
  ...overrides,
});

const accountStatusesMock = vi.mocked(rpc.accountStatuses);
const accountUsageMock = vi.mocked(rpc.accountUsage);
const codexUsageMock = vi.mocked(rpc.codexSubscriptionUsage);
const prepareMock = vi.mocked(rpc.prepareRemoveAccount);
const commitMock = vi.mocked(rpc.commitRemoveAccount);
const listAccountsStrictMock = vi.mocked(rpc.listAccountsStrict);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderAccounts(defaultAccount: string | null = null) {
  const onChanged = vi.fn();
  const onDefaultAccount = vi.fn();
  render(
    <Accounts
      accounts={[account]}
      onChanged={onChanged}
      onUse={vi.fn()}
      defaultAccount={defaultAccount}
      onDefaultAccount={onDefaultAccount}
    />,
  );
  return { onChanged, onDefaultAccount };
}

function StatefulAccounts({
  initialDefault = null,
  initialAccounts = [account],
}: {
  initialDefault?: string | null;
  initialAccounts?: Account[];
}) {
  const [rows, setRows] = useState<Account[]>(initialAccounts);
  const [defaultAccount, setDefaultAccount] = useState<string | null>(initialDefault);
  const reconcile = (refreshed?: Account[]) => setRows(refreshed ?? []);

  return (
    <>
      <Accounts
        accounts={rows}
        onChanged={reconcile}
        onUse={vi.fn()}
        defaultAccount={defaultAccount}
        onDefaultAccount={setDefaultAccount}
      />
      <output aria-label="Current default account">{defaultAccount ?? "none"}</output>
    </>
  );
}

let updateRaceDefault: ((id: string) => void) | undefined;

function DefaultRaceAccounts({ initialDefault }: { initialDefault: string }) {
  const [rows, setRows] = useState<Account[]>([account, survivor]);
  const [defaultAccount, setDefaultAccount] = useState<string | null>(initialDefault);
  const [callbackVersion, setCallbackVersion] = useState("initial");
  const [changedBy, setChangedBy] = useState("none");
  const [clearedBy, setClearedBy] = useState("none");

  updateRaceDefault = (id: string) => {
    setDefaultAccount(id);
    setCallbackVersion("latest");
  };

  return (
    <>
      <Accounts
        accounts={rows}
        onChanged={(refreshed) => {
          setRows(refreshed ?? []);
          setChangedBy(callbackVersion);
        }}
        onUse={vi.fn()}
        defaultAccount={defaultAccount}
        onDefaultAccount={(id) => {
          setDefaultAccount(id);
          if (id === null) setClearedBy(callbackVersion);
        }}
      />
      <output aria-label="Current default account">{defaultAccount ?? "none"}</output>
      <output aria-label="Changed callback version">{changedBy}</output>
      <output aria-label="Cleared callback version">{clearedBy}</output>
    </>
  );
}

async function openRemovalDialog(user: ReturnType<typeof userEvent.setup>) {
  const opener = screen.getByRole("button", { name: "Remove" });
  await user.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: "Remove Claude work?" }) };
}

async function openRemovalDialogFor(
  user: ReturnType<typeof userEvent.setup>,
  target: Account,
) {
  const label = screen.getByText(target.label, { selector: ".acct-label" });
  const row = label.closest(".acct");
  if (!row) throw new Error(`Account row not found for ${target.id}`);
  const opener = within(row as HTMLElement).getByRole("button", { name: "Remove" });
  await user.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: `Remove ${target.label}?` }) };
}

async function prepareDataRemoval(user: ReturnType<typeof userEvent.setup>) {
  const opened = await openRemovalDialog(user);
  await user.click(
    within(opened.dialog).getByRole("radio", { name: /remove entry and profile data/i }),
  );
  await user.click(within(opened.dialog).getByRole("button", { name: "Continue" }));
  await within(opened.dialog).findByRole("heading", { name: "Review profile-data removal" });
  return opened;
}

function selectedCopyText(element: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const copied = selection?.toString() ?? "";
  selection?.removeAllRanges();
  return copied;
}

async function captureLegacyRemovalCopy(
  user: ReturnType<typeof userEvent.setup>,
  legacy: Account,
  targetPath: string,
) {
  prepareMock.mockResolvedValueOnce(
    removalPlan(true, { accountLabel: legacy.label, targetPath }),
  );
  const view = render(
    <Accounts
      accounts={[legacy]}
      onChanged={vi.fn()}
      onUse={vi.fn()}
      defaultAccount={null}
      onDefaultAccount={vi.fn()}
    />,
  );
  const rowLabel = screen.getByText((_content, element) => element?.className === "acct-label");
  const row = selectedCopyText(rowLabel);

  await user.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = screen.getByRole("dialog");
  const title = within(dialog).getByRole("heading", { level: 2 });
  const prompt = selectedCopyText(title);
  await user.click(within(dialog).getByRole("radio", { name: /profile data/i }));
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await within(dialog).findByRole("heading", { name: "Review profile-data removal" });
  const target = selectedCopyText(within(dialog).getByText((_content, element) =>
    element?.className === "account-delete-target",
  ));
  view.unmount();
  return { row, prompt, target };
}

describe("Accounts status polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    accountStatusesMock.mockReset();
    accountUsageMock.mockReset().mockResolvedValue(null);
    codexUsageMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps at most one batch poll in flight and schedules the next after completion", async () => {
    let resolveFirst: ((value: Awaited<ReturnType<typeof rpc.accountStatuses>>) => void) | undefined;
    accountStatusesMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue([
        {
          accountId: account.id,
          available: true,
          status: {
            authed: true,
            expires: null,
            provider: account.provider,
            health: "signedIn",
            expiresInMs: null,
          },
        },
        {
          accountId: survivor.id,
          available: true,
          status: {
            authed: false,
            expires: null,
            provider: survivor.provider,
            health: "signedOut",
            expiresInMs: null,
          },
        },
      ]);

    render(
      <Accounts
        accounts={[account, survivor]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    expect(accountStatusesMock).toHaveBeenCalledTimes(1);
    expect(accountStatusesMock).toHaveBeenLastCalledWith([account.id, survivor.id]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(accountStatusesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.([
        {
          accountId: account.id,
          available: true,
          status: {
            authed: true,
            expires: null,
            provider: account.provider,
            health: "signedIn",
            expiresInMs: null,
          },
        },
        {
          accountId: survivor.id,
          available: false,
          status: null,
        },
      ]);
      await Promise.resolve();
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(accountStatusesMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(accountStatusesMock).toHaveBeenCalledTimes(2);
  });

  it("marks a failed refresh unavailable while retaining clearly stale last-known truth", async () => {
    accountStatusesMock
      .mockResolvedValueOnce([
        {
          accountId: account.id,
          available: true,
          status: {
            authed: true,
            expires: null,
            provider: account.provider,
            health: "signedIn",
            expiresInMs: null,
          },
        },
      ])
      .mockRejectedValueOnce(new Error("bridge unavailable"));

    renderAccounts();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Signed in")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.getByText(/last known: signed in.*stale/i)).toBeInTheDocument();
    expect(screen.queryByText("Not signed in")).not.toBeInTheDocument();
  });

  it("waits for the prior prop generation and polls only the latest account ids", async () => {
    const first = deferred<AccountStatusSnapshot[]>();
    const second = deferred<AccountStatusSnapshot[]>();
    accountStatusesMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const view = render(
      <Accounts
        accounts={[account]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );
    view.rerender(
      <Accounts
        accounts={[survivor]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    expect(accountStatusesMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve([{ accountId: account.id, available: false, status: null }]);
      await Promise.resolve();
    });

    expect(accountStatusesMock).toHaveBeenCalledTimes(2);
    expect(accountStatusesMock).toHaveBeenLastCalledWith([survivor.id]);
    second.resolve([{ accountId: survivor.id, available: false, status: null }]);
    await act(async () => { await second.promise; });
  });

  it("suppresses a stale success callback after account props change", async () => {
    const stale = deferred<AccountStatusSnapshot[]>();
    const current = deferred<AccountStatusSnapshot[]>();
    accountStatusesMock
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    const view = render(
      <Accounts
        accounts={[account]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );
    view.rerender(
      <Accounts
        accounts={[survivor]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    await act(async () => {
      stale.resolve([{
        accountId: account.id,
        available: true,
        status: {
          authed: true,
          expires: null,
          provider: account.provider,
          health: "signedIn",
          expiresInMs: null,
        },
      }]);
      await Promise.resolve();
    });

    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    current.resolve([{ accountId: survivor.id, available: false, status: null }]);
    await act(async () => { await current.promise; });
  });

  it("does not update or reschedule after unmounting with a request pending", async () => {
    const pending = deferred<AccountStatusSnapshot[]>();
    accountStatusesMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <Accounts
        accounts={[account]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    expect(accountStatusesMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      pending.resolve([{ accountId: account.id, available: false, status: null }]);
      await pending.promise;
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(accountStatusesMock).toHaveBeenCalledTimes(1);
  });
});

describe("Accounts accessible controls", () => {
  beforeEach(() => {
    accountStatusesMock.mockReset().mockResolvedValue([]);
    accountUsageMock.mockReset().mockResolvedValue(null);
    codexUsageMock.mockReset().mockResolvedValue(null);
  });

  it("names the Add-account provider picker", async () => {
    renderAccounts();

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Account provider" })).toBeInTheDocument();
    });
  });

  it("names account text fields independently of placeholder text", async () => {
    const user = userEvent.setup();
    renderAccounts();

    expect(screen.getByRole("textbox", { name: "Account name" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Rename Claude work" })).toBeInTheDocument();
  });
});

describe("Accounts removal confirmation", () => {
  beforeEach(() => {
    accountStatusesMock.mockReset().mockResolvedValue([]);
    accountUsageMock.mockReset().mockResolvedValue(null);
    codexUsageMock.mockReset().mockResolvedValue(null);
    prepareMock.mockReset();
    commitMock.mockReset();
    listAccountsStrictMock.mockReset();
  });

  afterEach(() => {
    updateRaceDefault = undefined;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  it("opens a named native modal with explicit choices and safe initial focus", async () => {
    const user = userEvent.setup();
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);

    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAccessibleDescription(/nothing changes until you confirm/i);
    expect(within(dialog).getByRole("radio", { name: /remove entry only/i })).toBeChecked();
    expect(
      within(dialog).getByRole("radio", { name: /remove entry and profile data/i }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Cancel and Escape close without preparing or committing and restore opener focus", async () => {
    const user = userEvent.setup();
    renderAccounts();

    let opened = await openRemovalDialog(user);
    await user.click(within(opened.dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opened.opener).toHaveFocus();

    opened = await openRemovalDialog(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opened.opener).toHaveFocus();
    expect(prepareMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("a native dialog close performs no mutation and restores opener focus", async () => {
    const user = userEvent.setup();
    renderAccounts();

    const { dialog, opener } = await openRemovalDialog(user);
    act(() => (dialog as HTMLDialogElement).close());

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(prepareMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("cycles Tab within the modal instead of leaking focus to the account row", async () => {
    const user = userEvent.setup();
    renderAccounts();

    const { dialog, opener } = await openRemovalDialog(user);
    const entryChoice = within(dialog).getByRole("radio", { name: /remove entry only/i });
    const continueButton = within(dialog).getByRole("button", { name: "Continue" });

    entryChoice.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(continueButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(entryChoice).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it("removes only the entry, then closes after a strict refresh confirms it is gone", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockResolvedValueOnce([]);
    const { onChanged, onDefaultAccount } = renderAccounts(account.id);

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const removeEntry = await within(dialog).findByRole("button", { name: "Remove entry" });
    await user.click(removeEntry);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(prepareMock).toHaveBeenCalledWith(account.id, false);
    expect(commitMock).toHaveBeenCalledWith("entry-plan", "");
    expect(listAccountsStrictMock).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onDefaultAccount).toHaveBeenCalledWith(null);
  });

  it("focuses a stable provider heading after a stateful parent removes the successful row", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockResolvedValueOnce([]);
    render(<StatefulAccounts />);

    const opener = screen.getByRole("button", { name: "Remove" });
    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    await waitFor(() => expect(opener.isConnected).toBe(false));
    const stableHeading = screen.getByRole("heading", { name: /claude.*anthropic/i });
    expect(stableHeading).toHaveFocus();
  });

  it("falls back to the always-present Add account heading when the removed provider group disappears", async () => {
    const user = userEvent.setup();
    const legacyProviderAccount = { ...account, provider: "legacy-provider" };
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockResolvedValueOnce([]);
    render(<StatefulAccounts initialAccounts={[legacyProviderAccount]} />);

    const opener = screen.getByRole("button", { name: "Remove" });
    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    await waitFor(() => expect(opener.isConnected).toBe(false));
    expect(screen.queryByRole("heading", { name: /legacy-provider/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add account" })).toHaveFocus();
  });

  it("keeps the dialog and account visible when entry-only commit fails", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    const hostile = "token=secret C:\\outside\\victim";
    const failure = new rpc.AccountDeletionError("registryChanged");
    Object.defineProperty(failure, "message", { value: hostile });
    commitMock.mockRejectedValueOnce(failure);
    const { onChanged, onDefaultAccount } = renderAccounts(account.id);

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/prepare again/i);
    const retry = within(dialog).getByRole("button", { name: "Prepare again" });
    expect(retry).toBeEnabled();
    expect(retry).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByText(account.label, { selector: ".acct-label" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(hostile);
    expect(document.body).not.toHaveTextContent(account.agentDir);
    expect(listAccountsStrictMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onDefaultAccount).not.toHaveBeenCalled();
  });

  it("returns focus inside the review after a retryable commit prepares a fresh plan", async () => {
    const user = userEvent.setup();
    prepareMock
      .mockResolvedValueOnce(removalPlan(false))
      .mockResolvedValueOnce(removalPlan(false, { planId: "fresh-entry-plan" }));
    commitMock.mockRejectedValueOnce(new rpc.AccountDeletionError("registryChanged"));
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));
    const retry = await within(dialog).findByRole("button", { name: "Prepare again" });
    expect(retry).toHaveFocus();

    await user.click(retry);
    await within(dialog).findByRole("button", { name: "Remove entry" });

    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("does not report success when refresh still contains the committed account", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockResolvedValueOnce([account]);
    const { onChanged } = renderAccounts();

    const { dialog, opener } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("keeps a resolved commit terminal when strict refresh rejects", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockRejectedValueOnce(new Error("bridge unavailable"));
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm/i);
    expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(screen.getByText(account.label, { selector: ".acct-label" })).toBeInTheDocument();
  });

  it("shows the exact prepared target, estimate, label, and every blocker", async () => {
    const user = userEvent.setup();
    const blocked = removalPlan(true, {
      checks: {
        activeSession: true,
        sharedProfile: true,
        defaultOrMigrated: true,
        storedPathMatches: false,
        directChild: false,
        reparsePoint: true,
        dataDeletionAllowed: false,
      },
      blockers: [
        "activeSession",
        "sharedProfile",
        "defaultOrMigrated",
        "storedPathMismatch",
        "unsafeTarget",
        "reparsePoint",
      ],
    });
    prepareMock.mockResolvedValueOnce(blocked);
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);

    expect(within(dialog).getByText(blocked.targetPath)).toBeInTheDocument();
    expect(within(dialog).getByText(/12 items/i)).toBeInTheDocument();
    expect(within(dialog).getByText(account.label, { selector: "dd" })).toBeInTheDocument();
    for (const name of [
      "Active session",
      "Shared profile",
      "Default or migrated",
      "Profile path",
      "Reparse points",
    ]) {
      expect(within(dialog).getByText(name)).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("button", { name: "Remove profile data" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(account.agentDir);
  });

  it("requires the exact plan label and keeps commit disabled during IME composition", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(true));
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    const input = within(dialog).getByRole("textbox", { name: /type claude work to confirm/i });
    const commit = within(dialog).getByRole("button", { name: "Remove profile data" });

    await user.type(input, account.label.toLowerCase());
    expect(commit).toBeDisabled();
    await user.clear(input);
    await user.type(input, `${account.label} `);
    expect(commit).toBeDisabled();
    await user.clear(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: account.label } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(commitMock).not.toHaveBeenCalled();
    expect(commit).toBeDisabled();
    fireEvent.compositionEnd(input);
    expect(commit).toBeEnabled();
  });

  it.each(["backend flag", "blocker"] as const)(
    "disables profile commit for an independent %s",
    async (caseName) => {
      const user = userEvent.setup();
      const base = removalPlan(true);
      const blocked =
        caseName === "backend flag"
          ? removalPlan(true, {
              checks: { ...base.checks, dataDeletionAllowed: false },
              blockers: [],
            })
          : removalPlan(true, {
              checks: { ...base.checks, activeSession: true, dataDeletionAllowed: true },
              blockers: ["activeSession"],
            });
      prepareMock.mockResolvedValueOnce(blocked);
      renderAccounts();

      const { dialog } = await prepareDataRemoval(user);
      const input = within(dialog).getByRole("textbox", { name: /type claude work to confirm/i });
      fireEvent.change(input, { target: { value: account.label } });

      expect(within(dialog).getByRole("button", { name: "Remove profile data" })).toBeDisabled();
      expect(commitMock).not.toHaveBeenCalled();
    },
  );

  it("marks an expired plan unusable and prepares a fresh retry", async () => {
    const user = userEvent.setup();
    prepareMock
      .mockResolvedValueOnce(removalPlan(true, { expiresAtMs: Date.now() - 1 }))
      .mockResolvedValueOnce(removalPlan(true, { planId: "fresh-plan", expiresAtMs: Date.now() + 60_000 }));
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    expect(within(dialog).getByText(/confirmation has expired/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove profile data" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Prepare again" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Prepare again" }));
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(prepareMock).toHaveBeenLastCalledWith(account.id, true);
    expect(await within(dialog).findByText(/expires in/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("submits profile deletion once and waits for refresh-confirmed removal", async () => {
    const user = userEvent.setup();
    let resolveCommit: (() => void) | undefined;
    prepareMock.mockResolvedValueOnce(removalPlan(true));
    commitMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    listAccountsStrictMock.mockResolvedValueOnce([]);
    const { onChanged } = renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    const input = within(dialog).getByRole("textbox", { name: /type claude work to confirm/i });
    fireEvent.change(input, { target: { value: account.label } });
    const removeData = within(dialog).getByRole("button", { name: "Remove profile data" });
    fireEvent.click(removeData);
    fireEvent.click(removeData);

    expect(commitMock).toHaveBeenCalledOnce();
    expect(commitMock).toHaveBeenCalledWith("data-plan", account.label);
    expect(listAccountsStrictMock).not.toHaveBeenCalled();

    resolveCommit?.();
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(listAccountsStrictMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["normal success", account.id, survivor.id, survivor.id, "none"],
    ["normal success", survivor.id, account.id, "none", "latest"],
    ["cleanup pending", account.id, survivor.id, survivor.id, "none"],
    ["cleanup pending", survivor.id, account.id, "none", "latest"],
  ] as const)(
    "reconciles the latest default and callback for %s from %s to %s",
    async (outcome, initialDefault, nextDefault, expectedDefault, expectedClearedBy) => {
      const user = userEvent.setup();
      let resolveCommit: (() => void) | undefined;
      let rejectCommit: ((reason: unknown) => void) | undefined;
      prepareMock.mockResolvedValueOnce(removalPlan(false));
      commitMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveCommit = resolve;
            rejectCommit = reject;
          }),
      );
      listAccountsStrictMock.mockResolvedValueOnce([survivor]);
      render(<DefaultRaceAccounts initialDefault={initialDefault} />);

      const { dialog } = await openRemovalDialogFor(user, account);
      await user.click(within(dialog).getByRole("button", { name: "Continue" }));
      await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalledOnce());

      act(() => updateRaceDefault?.(nextDefault));
      expect(screen.getByRole("status", { name: "Current default account" })).toHaveTextContent(
        nextDefault,
      );

      await act(async () => {
        if (outcome === "cleanup pending") {
          rejectCommit?.(new rpc.AccountDeletionError("cleanupPending"));
        } else {
          resolveCommit?.();
        }
      });

      if (outcome === "cleanup pending") {
        expect(await within(dialog).findByRole("alert")).toHaveTextContent(/cleanup is pending/i);
      } else {
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      }
      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Current default account" })).toHaveTextContent(
          expectedDefault,
        ),
      );
      expect(screen.getByRole("status", { name: "Changed callback version" })).toHaveTextContent(
        "latest",
      );
      expect(screen.getByRole("status", { name: "Cleared callback version" })).toHaveTextContent(
        expectedClearedBy,
      );
    },
  );

  it("submits an exact profile label with Enter outside IME composition", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(true));
    commitMock.mockResolvedValueOnce();
    listAccountsStrictMock.mockResolvedValueOnce([]);
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    const input = within(dialog).getByRole("textbox", { name: /type claude work/i });
    fireEvent.change(input, { target: { value: account.label } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });

    await waitFor(() => expect(commitMock).toHaveBeenCalledOnce());
    expect(commitMock).toHaveBeenCalledWith("data-plan", account.label);
  });

  it("expires a prepared plan while the dialog remains open", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(true, { expiresAtMs: Date.now() + 750 }));
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    expect(within(dialog).getByRole("button", { name: "Remove profile data" })).toBeDisabled();

    expect(await within(dialog).findByText(/confirmation has expired/i, {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove profile data" })).not.toBeInTheDocument();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("focuses Prepare again when a live entry plan expires and removes the focused commit", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false, { expiresAtMs: Date.now() + 750 }));
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const removeEntry = await within(dialog).findByRole("button", { name: "Remove entry" });
    removeEntry.focus();
    expect(removeEntry).toHaveFocus();

    await within(dialog).findByText(/confirmation has expired/i, {}, { timeout: 2_000 });
    const retry = within(dialog).getByRole("button", { name: "Prepare again" });
    expect(retry).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("rechecks expiry at click time before invoking commit", async () => {
    const user = userEvent.setup();
    const prepared = removalPlan(true, { expiresAtMs: Date.now() + 60_000 });
    prepareMock.mockResolvedValueOnce(prepared);
    renderAccounts();

    const { dialog } = await prepareDataRemoval(user);
    const input = within(dialog).getByRole("textbox", { name: /type claude work to confirm/i });
    fireEvent.change(input, { target: { value: account.label } });
    const removeData = within(dialog).getByRole("button", { name: "Remove profile data" });
    expect(removeData).toBeEnabled();
    removeData.focus();
    expect(removeData).toHaveFocus();

    const now = vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAtMs);
    fireEvent.click(removeData);
    now.mockRestore();

    expect(commitMock).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/confirmation has expired/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove profile data" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Prepare again" })).toHaveFocus();
  });

  it("keeps prepare failures non-mutating and never reflects backend credentials or paths", async () => {
    const user = userEvent.setup();
    const hostile = "credential=secret C:\\outside\\target";
    const failure = new rpc.AccountDeletionError("unsafeTarget");
    Object.defineProperty(failure, "message", { value: hostile });
    prepareMock.mockRejectedValueOnce(failure);
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);
    await user.click(
      within(dialog).getByRole("radio", { name: /remove entry and profile data/i }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/not safe/i);
    expect(within(dialog).getByRole("radio", { name: /profile data/i })).toBeInTheDocument();
    expect(commitMock).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(hostile);
    expect(document.body).not.toHaveTextContent(account.agentDir);
  });

  it.each([
    ["line break", "Claude\nwork", "[escaped] Claude\\nwork"],
    ["bidi override", "invoice\u202Ecod.exe", "[escaped] invoice\\u{202E}cod.exe"],
  ])("visibly escapes a legacy %s in the account row and deletion prompt", async (_case, label, visible) => {
    const user = userEvent.setup();
    const legacy = { ...account, label };
    render(
      <Accounts
        accounts={[legacy]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    expect(screen.getByText(visible, { selector: ".acct-label" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(label);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(within(screen.getByRole("dialog")).getByRole("heading", { level: 2 })).toHaveTextContent(
      `Remove ${visible}?`,
    );
  });

  it.each([
    [
      "line break",
      "Claude\nwork",
      "Claude\\nwork",
      "C:\\profiles\\Claude\nwork",
      "C:\\profiles\\Claude\\nwork",
      "[escaped] Claude\\nwork",
      "[escaped] C:\\\\profiles\\\\Claude\\nwork",
    ],
    [
      "bidi override",
      "invoice\u202Ecod.exe",
      "invoice\\u{202E}cod.exe",
      "C:\\profiles\\invoice\u202Ecod.exe",
      "C:\\profiles\\invoice\\u{202E}cod.exe",
      "[escaped] invoice\\u{202E}cod.exe",
      "[escaped] C:\\\\profiles\\\\invoice\\u{202E}cod.exe",
    ],
  ] as const)(
    "keeps unsafe and literal %s copy distinct in the row, dialog, and prepared target",
    async (
      _case,
      unsafeLabel,
      literalLabel,
      unsafeTarget,
      literalTarget,
      escapedLabel,
      escapedTarget,
    ) => {
      const user = userEvent.setup();
      const unsafe = await captureLegacyRemovalCopy(
        user,
        { ...account, id: "unsafe-copy", label: unsafeLabel },
        unsafeTarget,
      );
      const literal = await captureLegacyRemovalCopy(
        user,
        { ...account, id: "literal-copy", label: literalLabel },
        literalTarget,
      );

      expect.soft(unsafe.row).toBe(escapedLabel);
      expect.soft(literal.row).toBe(literalLabel);
      expect.soft(unsafe.row).not.toBe(literal.row);
      expect.soft(unsafe.prompt).toBe(`Remove ${escapedLabel}?`);
      expect.soft(literal.prompt).toBe(`Remove ${literalLabel}?`);
      expect.soft(unsafe.prompt).not.toBe(literal.prompt);
      expect.soft(unsafe.target).toBe(escapedTarget);
      expect.soft(literal.target).toBe(literalTarget);
      expect.soft(unsafe.target).not.toBe(literal.target);
    },
  );

  it("requires a dangerous legacy label to be renamed before profile deletion", async () => {
    const user = userEvent.setup();
    const legacyLabel = "Invoice\u202Ecod.exe\nnext";
    const visibleLabel = "[escaped] Invoice\\u{202E}cod.exe\\nnext";
    const targetPath = "C:\\Users\\operator\\\u202Eprofile";
    const visibleTarget = String.raw`[escaped] C:\\Users\\operator\\\u{202E}profile`;
    const legacy = { ...account, label: legacyLabel };
    prepareMock.mockResolvedValueOnce(
      removalPlan(true, { accountLabel: legacyLabel, targetPath }),
    );
    render(
      <Accounts
        accounts={[legacy]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /profile data/i }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await within(dialog).findByRole("heading", { name: "Review profile-data removal" });

    expect(within(dialog).getByText(visibleLabel, { selector: "dd" })).toBeInTheDocument();
    expect(within(dialog).getByText(visibleTarget, { selector: "code" })).toBeInTheDocument();
    expect(within(dialog).getByText(/rename this account before deleting profile data/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove profile data" })).not.toBeInTheDocument();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("keeps a long unbroken label wrap-safe at a narrow app viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 420 });
    const user = userEvent.setup();
    const longLabel = "A".repeat(320);
    const longAccount = { ...account, label: longLabel };
    render(
      <Accounts
        accounts={[longAccount]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    const rowLabel = screen.getByText(longLabel, { selector: ".acct-label" });
    expect(getComputedStyle(rowLabel).overflowWrap).toBe("anywhere");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const title = within(screen.getByRole("dialog")).getByRole("heading", { level: 2 });
    expect(title).toHaveTextContent(longLabel);
    expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
  });

  it("reconciles cleanupPending, removes a confirmed-stale row/default, and offers only Close", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(true));
    commitMock.mockRejectedValueOnce(new rpc.AccountDeletionError("cleanupPending"));
    listAccountsStrictMock.mockResolvedValueOnce([]);
    render(<StatefulAccounts initialDefault={account.id} />);

    const { dialog } = await prepareDataRemoval(user);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /type claude work/i }), {
      target: { value: account.label },
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove profile data" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/cleanup is pending/i);
    await waitFor(() => expect(screen.queryByText(account.label, { selector: ".acct-label" })).not.toBeInTheDocument());
    expect(screen.getByRole("status", { name: "Current default account" })).toHaveTextContent("none");
    expect(listAccountsStrictMock).toHaveBeenCalledOnce();
    expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();

    await user.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /claude.*anthropic/i })).toHaveFocus();
  });

  it.each(["outcomeUnknown", "recoveryRequired"] as const)(
    "keeps %s terminal with restart/Close actions and no prepare or refresh",
    async (code) => {
      const user = userEvent.setup();
      prepareMock.mockResolvedValueOnce(removalPlan(true));
      commitMock.mockRejectedValueOnce(new rpc.AccountDeletionError(code));
      renderAccounts();

      const { dialog } = await prepareDataRemoval(user);
      fireEvent.change(within(dialog).getByRole("textbox", { name: /type claude work/i }), {
        target: { value: account.label },
      });
      await user.click(within(dialog).getByRole("button", { name: "Remove profile data" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(/restart/i);
      expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Remove profile data" })).not.toBeInTheDocument();
      const close = within(dialog).getByRole("button", { name: "Close" });
      expect(close).toBeEnabled();
      expect(close).toHaveFocus();
      expect(listAccountsStrictMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a primitive bridge rejection", "bridge disconnected"],
    ["a quarantine conflict", new rpc.AccountDeletionError("quarantineConflict")],
  ])("fails closed for %s with restart/Close actions", async (_case, failure) => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(false));
    commitMock.mockRejectedValueOnce(failure);
    renderAccounts();

    const { dialog } = await openRemovalDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(await within(dialog).findByRole("button", { name: "Remove entry" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/restart/i);
    expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove entry" })).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(listAccountsStrictMock).not.toHaveBeenCalled();
  });

  it("keeps cleanupPending terminal when strict reconciliation fails", async () => {
    const user = userEvent.setup();
    prepareMock.mockResolvedValueOnce(removalPlan(true));
    commitMock.mockRejectedValueOnce(new rpc.AccountDeletionError("cleanupPending"));
    listAccountsStrictMock.mockRejectedValueOnce(new Error("bridge unavailable"));
    renderAccounts(account.id);

    const { dialog } = await prepareDataRemoval(user);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /type claude work/i }), {
      target: { value: account.label },
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove profile data" }));

    await within(dialog).findByRole("alert");
    expect(listAccountsStrictMock).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/could not refresh accounts/i);
    expect(screen.getByText(account.label, { selector: ".acct-label" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
  });
});
