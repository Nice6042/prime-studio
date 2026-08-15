#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path


def replace_once(path_text: str, old: str, new: str, label: str) -> str:
    count = path_text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return path_text.replace(old, new, 1)

policy = Path("app/src/features/navigation/residentCreationPolicy.ts")
policy.write_text('''import type { AppSettings } from "../../types";

export const RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON =
  "The reviewed Prime daemon resident-create contract accepts workspace and title only; it does not accept an account or profile identity.";

export function residentCreationDisabledReason(settings: AppSettings): string | null {
  const selected = [
    settings.defaultAccount ? "account" : null,
    settings.defaultProvider ? "provider" : null,
    settings.defaultModel ? "model" : null,
    settings.defaultThinking ? "thinking" : null,
  ].filter((value): value is string => value !== null);
  if (selected.length === 0) return null;
  const upstream = selected.includes("account")
    ? `${RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON} `
    : "";
  return `${upstream}New chat is disabled because the verified resident creation route cannot bind the selected ${selected.join(", ")}. Reset ${selected.length === 1 ? "it" : "them"} to Harness default before creating a chat.`;
}
''', encoding="utf-8")

policy_test = Path("app/src/features/navigation/residentCreationPolicy.test.ts")
policy_test.write_text('''import { describe, expect, it } from "vitest";

import {
  RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON,
  residentCreationDisabledReason,
} from "./residentCreationPolicy";

describe("resident creation preference policy", () => {
  it("allows creation only when every unsupported selection is at Harness default", () => {
    expect(residentCreationDisabledReason({})).toBeNull();
    expect(residentCreationDisabledReason({ defaultAccount: null, defaultModel: null, defaultThinking: null })).toBeNull();
  });

  it("names the exact upstream account-selection boundary", () => {
    const reason = residentCreationDisabledReason({ defaultAccount: "account-1" });
    expect(reason).toContain(RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON);
    expect(reason).toContain("Harness default");
  });

  it.each([
    [{ defaultProvider: "openai-codex" }, "provider"],
    [{ defaultModel: "gpt-real" }, "model"],
    [{ defaultThinking: "high" }, "thinking"],
  ] as const)("gives a precise disabled reason for an unverifiable selection", (settings, selection) => {
    expect(residentCreationDisabledReason(settings)).toContain(selection);
    expect(residentCreationDisabledReason(settings)).toContain("Harness default");
  });
});
''', encoding="utf-8")

accounts_path = Path("app/src/components/Accounts.tsx")
accounts = accounts_path.read_text(encoding="utf-8")
accounts = replace_once(
    accounts,
'''  /** Open a new session on this account (a session's account is fixed at spawn). */
  onUse: (id: string) => void;
''',
'''  /** Request a new-session account only when the verified runtime supports that selector. */
  onUse: (id: string) => void;
''',
    "accounts onUse contract",
)
accounts = replace_once(
    accounts,
'''      <p className="muted small">
        Each account is a separate Prime agent home, so two Claude and two ChatGPT subscriptions
        can be signed in at once. Sessions on different accounts run in parallel, and an account
        is fixed for the life of a session.
      </p>
''',
'''      {newSessionDisabledReason && <p className="studio-setting-unavailable" role="status">
        <strong>New-session account selection unavailable.</strong> {newSessionDisabledReason} Account login, status, quota, and local usage remain available.
      </p>}
      <p className="muted small">
        Each account is a separate Prime agent home, so multiple Claude and ChatGPT subscriptions
        can be signed in, monitored, and reported independently without exposing credential values.
      </p>
''',
    "accounts capability notice",
)
accounts = replace_once(
    accounts,
'''                        disabled={defaultAccount === a.id}
                        title="New tabs open on this account"
''',
'''                        disabled={defaultAccount === a.id || Boolean(newSessionDisabledReason)}
                        title={newSessionDisabledReason ?? "New tabs open on this account"}
''',
    "default account authority",
)
accounts_path.write_text(accounts, encoding="utf-8")

settings_path = Path("app/src/features/settings/SettingsPages.tsx")
settings = settings_path.read_text(encoding="utf-8")
settings = replace_once(
    settings,
'''import type { HarnessComposerProjection } from "../harness/adapter";
''',
'''import type { HarnessComposerProjection } from "../harness/adapter";
import { RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON } from "../navigation/residentCreationPolicy";
''',
    "settings account policy import",
)
settings = replace_once(
    settings,
'''export function AccountsSettings({ accounts, defaultAccount, onChanged, onDefaultAccount, quota }: { readonly accounts: readonly Account[]; readonly defaultAccount: string | null; readonly onChanged: (accounts?: Account[]) => void; readonly onDefaultAccount: (accountId: string | null) => void; readonly quota?: SubscriptionQuotaProjection }) {
  return <div className="studio-accounts-settings">
    <Unavailable>Selecting an account saves the durable new-session preference. The verified resident creation route cannot pass an account identity during resident creation, so new chat stays disabled until you reset to Harness default.</Unavailable>
    {defaultAccount && <button type="button" className="btn" data-control-id="settings.defaultAccount.reset" data-action="settings.preference.reset" onClick={() => onDefaultAccount(null)}>Use Harness default</button>}
    <Accounts accounts={[...accounts]} onChanged={onChanged} onUse={onDefaultAccount} defaultAccount={defaultAccount} onDefaultAccount={onDefaultAccount} quota={quota} />
  </div>;
}
''',
'''export function AccountsSettings({ accounts, defaultAccount, onChanged, onDefaultAccount, quota }: { readonly accounts: readonly Account[]; readonly defaultAccount: string | null; readonly onChanged: (accounts?: Account[]) => void; readonly onDefaultAccount: (accountId: string | null) => void; readonly quota?: SubscriptionQuotaProjection }) {
  return <div className="studio-accounts-settings">
    <Unavailable>{RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON} Account login, status, quota, local usage, rename, and removal remain available.</Unavailable>
    {defaultAccount && <button type="button" className="btn" data-control-id="settings.defaultAccount.reset" data-action="settings.preference.reset" onClick={() => onDefaultAccount(null)}>Clear unsupported account preference</button>}
    <Accounts accounts={[...accounts]} onChanged={onChanged} onUse={onDefaultAccount} newSessionDisabledReason={RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON} defaultAccount={defaultAccount} onDefaultAccount={onDefaultAccount} quota={quota} />
  </div>;
}
''',
    "accounts settings capability boundary",
)
settings_path.write_text(settings, encoding="utf-8")

accounts_test_path = Path("app/src/components/Accounts.test.tsx")
accounts_test = accounts_test_path.read_text(encoding="utf-8")
accounts_test = replace_once(
    accounts_test,
'''  it("names account text fields independently of placeholder text", async () => {
    const user = userEvent.setup();
    renderAccounts();

    expect(screen.getByRole("textbox", { name: "Account name" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Rename Claude work" })).toBeInTheDocument();
  });
});
''',
'''  it("names account text fields independently of placeholder text", async () => {
    const user = userEvent.setup();
    renderAccounts();

    expect(screen.getByRole("textbox", { name: "Account name" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Rename Claude work" })).toBeInTheDocument();
  });

  it("keeps account management available while disabling an unsupported session selector", async () => {
    const reason = "The reviewed runtime cannot select an account during resident creation.";
    render(
      <Accounts
        accounts={[account]}
        onChanged={vi.fn()}
        onUse={vi.fn()}
        newSessionDisabledReason={reason}
        defaultAccount={null}
        onDefaultAccount={vi.fn()}
      />,
    );

    expect(await screen.findByRole("status")).toHaveTextContent(reason);
    expect(screen.getByRole("button", { name: "Use for new sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set as default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /log in|re-login/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  });
});
''',
    "accounts capability regression",
)
accounts_test_path.write_text(accounts_test, encoding="utf-8")

usage_path = Path("app/src/features/settings/AccountUsageSettings.tsx")
usage = usage_path.read_text(encoding="utf-8")
usage = replace_once(
    usage,
'''function boundedRows(value: readonly UsageRow[]): UsageRow[] {
  if (value.length > MAX_RENDERED_ROWS) return [];
  return value.filter((row) => Number.isSafeInteger(row.ts) && row.ts >= 0 && typeof row.provider === "string" && row.provider.length <= 64 && [row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].every((candidate) => Number.isFinite(candidate) && candidate >= 0));
}
''',
'''function boundedRows(value: readonly UsageRow[]): UsageRow[] {
  if (value.length > MAX_RENDERED_ROWS) throw new Error("Account usage row limit exceeded.");
  const rows = value.filter((row) => Number.isSafeInteger(row.ts) && row.ts >= 0 && typeof row.provider === "string" && row.provider.length <= 64 && [row.cost, row.input, row.output, row.cacheRead, row.cacheWrite].every((candidate) => Number.isFinite(candidate) && candidate >= 0));
  if (rows.length !== value.length) throw new Error("Account usage contains an invalid row.");
  return rows;
}
''',
    "fail-closed usage rows",
)
usage = replace_once(
    usage,
'''  const accountTotals = useMemo(() => accounts.map((account) => { const directoryRows = rowsByDirectory.get(account.agentDir) ?? []; const shared = accounts.filter((candidate) => candidate.agentDir === account.agentDir).length > 1; return { account, totals: sum(shared ? directoryRows.filter((row) => row.provider === account.provider) : directoryRows) }; }), [accounts, rowsByDirectory]);
''',
'''  const accountTotals = useMemo(() => accounts.map((account) => {
    const directoryRows = rowsByDirectory.get(account.agentDir) ?? [];
    const peers = accounts.filter((candidate) => candidate.agentDir === account.agentDir);
    const shared = peers.length > 1;
    const sameProviderPeers = peers.filter((candidate) => candidate.provider === account.provider);
    const scopedRows = shared ? directoryRows.filter((row) => row.provider === account.provider) : directoryRows;
    return { account, totals: sum(scopedRows), ambiguous: sameProviderPeers.length > 1 };
  }), [accounts, rowsByDirectory]);
''',
    "account ledger attribution",
)
usage = replace_once(
    usage,
'''<tbody>{accountTotals.map(({ account, totals: accountValue }) => <tr key={account.id}><td>{account.label}</td><td>{PROVIDER_NAME[account.provider] ?? account.provider}</td><td>{available ? display(accountValue) : "Unavailable"}</td></tr>)}</tbody>''',
'''<tbody>{accountTotals.map(({ account, totals: accountValue, ambiguous }) => <tr key={account.id}><td>{account.label}</td><td>{PROVIDER_NAME[account.provider] ?? account.provider}</td><td>{ambiguous ? <span aria-label={`${account.label} usage attribution unavailable`}>Shared ledger · attribution unavailable</span> : available ? display(accountValue) : "Unavailable"}</td></tr>)}</tbody>''',
    "account usage ambiguity presentation",
)
usage_path.write_text(usage, encoding="utf-8")

usage_test_path = Path("app/src/features/settings/AccountUsageSettings.test.tsx")
usage_test = usage_test_path.read_text(encoding="utf-8")
usage_test = replace_once(
    usage_test,
'''  it("reports native save-dialog cancellation explicitly", async () => {
    const onExportCsv = vi.fn(async () => ({ status: "cancelled" as const }));
    render(<AccountUsageSettings accounts={accounts} onExportCsv={onExportCsv} />);
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Export cancelled");
  });
});
''',
'''  it("reports native save-dialog cancellation explicitly", async () => {
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
''',
    "account usage truth regressions",
)
usage_test_path.write_text(usage_test, encoding="utf-8")

accounts_doc_path = Path("ACCOUNTS.md")
accounts_doc = accounts_doc_path.read_text(encoding="utf-8")
accounts_doc = replace_once(
    accounts_doc,
'''# Multi-account design (verified against prime-agent 0.7.1)
''',
'''# Multi-account design (reviewed against prime-agent 0.7.1 and 0.7.2)
''',
    "accounts review identity",
)
accounts_doc = replace_once(
    accounts_doc,
'''## Concurrency (multiple accounts at once)

Prime Studio spawns `--mode rpc` per session — no daemon involved — so N sessions on N different
profiles run in parallel; each child just gets its own `PRIME_AGENT_CODING_AGENT_DIR`. (Only the
`--mode daemon` path would need distinct `--daemon-socket` values.)
''',
'''## Resident-session account selection

The hardened account registry, isolated agent homes, interactive login handoff, status polling,
quota projection, local usage ledger, rename, and removal flows are available independently of
session creation.

The reviewed Prime daemon resident-create command currently accepts only lifecycle, title/name,
and `config.cwd`. It does not accept an account ID, profile ID, agent directory, provider, model,
or thinking default. Prime Studio therefore does not claim that an account row can select the
identity used by a new resident session. The corresponding controls are disabled with a shared
upstream reason, and any stale persisted account preference must be cleared before New chat is
admitted.

The older direct-process foundation can construct a per-profile environment, but that dormant path
is not production authority and is not used as an unverified fallback. Multi-account resident
execution remains unavailable until a reviewed daemon contract exposes an identity-bound account
selector and the native broker verifies the returned principal.
''',
    "resident account boundary",
)
accounts_doc = replace_once(
    accounts_doc,
'''Prime does not expose subscription quota. What is available, per profile:
''',
'''Prime does not expose one uniform subscription-quota API. What is available, per profile:
''',
    "quota wording",
)
accounts_doc_path.write_text(accounts_doc, encoding="utf-8")

capabilities_doc = Path("docs/product/provider-session-capabilities.md")
capabilities_doc.write_text('''# Provider and session capability truth

This matrix separates account-registry capabilities from verified resident-session capabilities.
A visible account or successful OAuth login is not evidence that the current daemon can select
that account for a new resident session.

| Capability | Authority | Current result |
|---|---|---|
| Add, rename, remove, and list account profiles | Native account registry | Available through bounded credential-free metadata |
| Interactive Claude or ChatGPT/Codex login | Prime CLI in a visible terminal | Available; credential values never enter renderer projections |
| Account auth health | Native bounded auth metadata read | Available or explicitly unavailable/stale |
| Local account usage and API-equivalent cost | Native bounded session ledger | Available when the ledger validates; invalid or oversized rows fail closed |
| Subscription quota | Provider-specific observed evidence | Available only when reported; otherwise explicit unavailable |
| Select account/provider for resident creation | Prime daemon resident-create contract | Upstream unavailable: the reviewed contract accepts workspace and title only |
| Select model and thinking for the current admitted session | Verified daemon model catalog and session operations | Available when the attached session reports the option and returns an authoritative snapshot |
| Persist model/thinking/account defaults for future residents | Prime daemon resident-create contract | Upstream unavailable until creation accepts and proves these identities |

Shared account directories are read once. Provider-separated rows can be attributed by provider;
multiple account rows for the same provider and directory remain explicitly unattributed rather
than repeating one ledger total under each account.
''', encoding="utf-8")

Path(".branch-patches/wave-2-marker").unlink(missing_ok=True)
PY

cd app
npm ci
npm test -- src/features/navigation/residentCreationPolicy.test.ts src/components/Accounts.test.tsx src/features/settings/AccountUsageSettings.test.tsx src/features/harness/productionAdapter.test.ts --maxWorkers=1 --no-file-parallelism
npm run build
