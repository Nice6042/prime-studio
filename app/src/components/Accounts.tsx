import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as rpc from "../rpc";
import {
  HEALTH_PILL,
  PROVIDERS,
  PROVIDER_NAME,
  health,
  healthLabel,
  localMidnight,
  money,
} from "../accounts";
import { visualizeUntrustedText } from "../accounts/delete";
import { rateLimitsSnapshot } from "../rateLimits";
import { projectSubscriptionQuota, type SubscriptionQuotaProjection } from "../quotaProjection";
import { QuotaFactView } from "./SubscriptionQuota";
import { AccountRemovalDialog } from "./AccountRemovalDialog";
import type {
  Account,
  AccountStatus,
  UsageReport,
} from "../types";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function expiryText(status?: AccountStatus | null): string {
  const ms = Number(status?.expires);
  if (!status?.authed || !Number.isFinite(ms) || ms <= 0) return "";
  return `${ms < Date.now() ? "expired" : "valid until"} ${dateFmt.format(new Date(ms))}`;
}

/**
 * Accounts pane. Each account is a separate prime agent home
 * (`PRIME_AGENT_CODING_AGENT_DIR`), which is the whole reason two Claude and two
 * ChatGPT subscriptions can be signed in at once.
 */
export function Accounts({
  accounts,
  onChanged,
  onUse,
  newSessionDisabledReason,
  defaultAccount,
  onDefaultAccount,
  quota = projectSubscriptionQuota(accounts, null, rateLimitsSnapshot()),
}: {
  accounts: Account[];
  /** Registry changed. A strict refreshed list can be applied without another bridge read. */
  onChanged: (refreshed?: Account[]) => void;
  /** Open a new session on this account (a session's account is fixed at spawn). */
  onUse: (id: string) => void;
  newSessionDisabledReason?: string;
  defaultAccount: string | null;
  onDefaultAccount: (id: string | null) => void;
  quota?: SubscriptionQuotaProjection;
}) {
  const [status, setStatus] = useState<Record<string, AccountStatus>>({});
  const [unavailableStatus, setUnavailableStatus] = useState<Set<string>>(() => new Set());
  const [usage, setUsage] = useState<Record<string, UsageReport>>({});
  const [newLabel, setNewLabel] = useState("");
  const [newProvider, setNewProvider] = useState(PROVIDERS[0]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [removing, setRemoving] = useState<{
    account: Account;
    opener: HTMLButtonElement;
  } | null>(null);
  const providerHeadingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const fallbackFocusRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRemovalRef = useRef<{ accountId: string; provider: string } | null>(null);
  const reconciliationRef = useRef({ defaultAccount, onDefaultAccount, onChanged });
  const statusPollRef = useRef<ReturnType<typeof rpc.accountStatuses> | null>(null);
  /** Off Windows the backend hands back the command to run — show it, don't toast it. */
  const [hint, setHint] = useState<Record<string, string>>({});

  useLayoutEffect(() => {
    reconciliationRef.current = { defaultAccount, onDefaultAccount, onChanged };
  }, [defaultAccount, onDefaultAccount, onChanged]);

  const ids = accounts.map((a) => a.id).join(",");

  useEffect(() => {
    const pending = focusAfterRemovalRef.current;
    if (!pending || removing || accounts.some((candidate) => candidate.id === pending.accountId)) {
      return;
    }
    const heading = providerHeadingRefs.current.get(pending.provider) ?? fallbackFocusRef.current;
    if (!heading) return;
    focusAfterRemovalRef.current = null;
    heading.focus();
  }, [accounts, removing]);

  // Poll while the pane is open: a `/login` finishing in the console window has
  // no way to notify us, so presence in auth.json is the signal. The next poll
  // is scheduled only after this one settles, and a prop change waits for the
  // preceding generation so the renderer never has two status polls in flight.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestedIds = accounts.map((account) => account.id);
    const requested = new Set(requestedIds);

    const retainRequested = (current: Record<string, AccountStatus>) =>
      Object.fromEntries(
        Object.entries(current).filter(([accountId]) => requested.has(accountId)),
      );

    const tick = async (): Promise<void> => {
      if (statusPollRef.current) {
        try {
          await statusPollRef.current;
        } catch {
          // The owning generation records the failure. This generation only
          // waits so it cannot overlap the previous native read.
        }
        if (!alive) return;
      }

      const poll = rpc.accountStatuses(requestedIds);
      statusPollRef.current = poll;
      try {
        const rows = await poll;
        if (!alive) return;
        setStatus((current) => {
          const next: Record<string, AccountStatus> = {};
          for (const row of rows) {
            if (row.available) next[row.accountId] = row.status;
            else if (current[row.accountId]) next[row.accountId] = current[row.accountId];
          }
          return next;
        });
        setUnavailableStatus(new Set(
          rows.filter((row) => !row.available).map((row) => row.accountId),
        ));
      } catch {
        if (!alive) return;
        setStatus(retainRequested);
        setUnavailableStatus(new Set(requestedIds));
      } finally {
        if (statusPollRef.current === poll) statusPollRef.current = null;
        if (alive) timer = setTimeout(() => void tick(), 2_000);
      }
    };

    if (requestedIds.length === 0) {
      setStatus({});
      setUnavailableStatus(new Set());
    } else {
      void tick();
    }
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  const loadUsage = useCallback(async () => {
    const since = localMidnight();
    const rows = await Promise.all(
      accounts.map(async (a) => [a.id, await rpc.accountUsage(a.id, since)] as const),
    );
    setUsage(Object.fromEntries(rows.filter(([, u]) => u)) as Record<string, UsageReport>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const grouped = useMemo(() => {
    const by = new Map<string, Account[]>();
    for (const p of PROVIDERS) by.set(p, []);
    for (const a of accounts) by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
    return [...by.entries()];
  }, [accounts]);

  const login = async (id: string) => {
    try {
      await rpc.beginAccountLogin(id);
      setHint((h) => ({ ...h, [id]: "" }));
    } catch (e) {
      setHint((h) => ({ ...h, [id]: e instanceof Error ? e.message : String(e) }));
    }
  };

  const add = async () => {
    if (!newLabel.trim()) return;
    const created = await rpc.addAccount(newLabel.trim(), newProvider);
    setNewLabel("");
    onChanged();
    // A fresh profile has no credentials at all, so go straight to the login handoff.
    if (created) await login(created.id);
  };

  const rename = async (id: string) => {
    if (editLabel.trim()) await rpc.renameAccount(id, editLabel.trim());
    setEditing(null);
    onChanged();
  };

  return (
    <>
      <p className="muted small">
        Each account is a separate Prime agent home, so two Claude and two ChatGPT subscriptions
        can be signed in at once. Sessions on different accounts run in parallel, and an account
        is fixed for the life of a session.
      </p>

      {accounts.length === 0 && (
        <div className="empty-state">
          <strong>No accounts yet.</strong> Add one below: give it a name, pick the provider, and
          Prime Studio opens prime's interactive login for it. Nothing works until at least one
          account is signed in.
        </div>
      )}

      {grouped.map(([provider, list]) => (
        <section key={provider} className="acct-group">
          <h3
            ref={(heading) => {
              if (heading) providerHeadingRefs.current.set(provider, heading);
              else providerHeadingRefs.current.delete(provider);
            }}
            tabIndex={-1}
          >
            {PROVIDER_NAME[provider] ?? provider}
            <span className="muted small"> · {provider}</span>
          </h3>

          {list.length === 0 && (
            <div className="muted small pad">
              No {PROVIDER_NAME[provider] ?? provider} accounts yet — add one below.
            </div>
          )}

          {list.map((a) => {
            const st = status[a.id];
            const state = health(st);
            const unavailable = !st || unavailableStatus.has(a.id);
            const u = usage[a.id];
            return (
              <div key={a.id} className="acct">
                <div className="acct-main">
                  {editing === a.id ? (
                    <input
                      className="search acct-edit"
                      aria-label={`Rename ${visualizeUntrustedText(a.label)}`}
                      autoFocus
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(a.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <bdi className="acct-label" dir="ltr">
                      {visualizeUntrustedText(a.label)}
                    </bdi>
                  )}
                  <span className={`pill pill-${unavailable ? "unauthed" : HEALTH_PILL[state]}`}>
                    {unavailable ? "Status unavailable" : healthLabel(st)}
                  </span>
                  {defaultAccount === a.id && <span className="pill pill-default">Default</span>}
                  <span className="muted small">
                    {unavailable
                      ? st ? `Last known: ${healthLabel(st)} · stale` : ""
                      : expiryText(st)}
                  </span>
                </div>

                <div className="acct-usage muted small">
                  today {money(u?.today.cost ?? 0)} · 7d {money(u?.week.cost ?? 0)} · all{" "}
                  {money(u?.all.cost ?? 0)} · {u?.all.sessions ?? 0} sessions
                </div>

                {quota.accountFacts.find((fact) => fact.accountId === a.id) && <QuotaFactView
                  fact={quota.accountFacts.find((fact) => fact.accountId === a.id)!}
                  label={a.label}
                />}

                <div className="acct-actions">
                      <button
                        data-control-id={`account-login-${a.id}`}
                        className={`btn ${state === "expired" || state === "signedOut" ? "btn-send" : ""}`}
                        onClick={() => void login(a.id)}
                        title="Opens a console window — run /login there and finish in the browser"
                      >
                        {!unavailable && state === "signedOut" ? "Log in" : "Re-login"}
                      </button>
                      <button data-control-id={`account-use-${a.id}`} data-studio-action="account.use" className="btn" onClick={() => onUse(a.id)} disabled={Boolean(newSessionDisabledReason)} title={newSessionDisabledReason ?? "Use for new sessions"}>
                        Use for new sessions
                      </button>
                      <button
                        data-control-id={`account-rename-${a.id}`}
                        className="btn"
                        onClick={() => {
                          setEditing(a.id);
                          setEditLabel(a.label);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        data-control-id={`account-default-${a.id}`}
                        data-studio-action="account.set-default"
                        className="btn"
                        disabled={defaultAccount === a.id}
                        title="New tabs open on this account"
                        onClick={() => onDefaultAccount(a.id)}
                      >
                        Set as default
                      </button>
                      <button
                        data-control-id={`account-remove-${a.id}`}
                        data-studio-action="account.remove"
                        className="btn"
                        onClick={(event) => setRemoving({ account: a, opener: event.currentTarget })}
                      >
                        Remove
                      </button>
                </div>

                {hint[a.id] && (
                  <pre className="cli-error acct-hint">
                    {hint[a.id]}
                  </pre>
                )}
              </div>
            );
          })}

          {provider === "openai-codex" && quota.providerFacts.map((fact) => <QuotaFactView key={fact.provider} fact={fact} />)}
        </section>
      ))}

      <section className="acct-group">
        <h3 ref={fallbackFocusRef} tabIndex={-1}>Add account</h3>
        <div className="acct-actions">
          <input
            data-control-id="account-add-name"
            data-studio-action="account.add"
            className="search acct-edit"
            aria-label="Account name"
            placeholder="Name it, e.g. Claude work"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <select
            data-control-id="account-add-provider"
            data-studio-action="account.add"
            aria-label="Account provider"
            className="picker"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAME[p] ?? p}
              </option>
            ))}
          </select>
          <button data-control-id="account-add-submit" data-studio-action="account.add" className="btn btn-send" onClick={() => void add()} disabled={!newLabel.trim()}>
            Add &amp; log in
          </button>
        </div>
        <p className="muted small">
          prime's <code>/login</code> is an interactive OAuth flow with no RPC equivalent, so it
          runs in a real terminal. On Windows the app opens one for you; elsewhere it prints the
          exact command. Finish in the browser and the row above flips to “Signed in” on its own.
        </p>
      </section>

      <p className="muted small">
        Costs are API-equivalent — subscription logins bill $0 marginal. Accounts sharing one agent
        directory (the migrated defaults) report the same underlying history.
      </p>

      {removing && (
        <AccountRemovalDialog
          account={removing.account}
          opener={removing.opener}
          onClose={() => {
            if (!accounts.some((candidate) => candidate.id === removing.account.id)) {
              focusAfterRemovalRef.current = {
                accountId: removing.account.id,
                provider: removing.account.provider,
              };
            }
            setRemoving(null);
          }}
          onRemoved={(refreshed) => {
            const removedId = removing.account.id;
            const latest = reconciliationRef.current;
            focusAfterRemovalRef.current = {
              accountId: removedId,
              provider: removing.account.provider,
            };
            setRemoving(null);
            if (latest.defaultAccount === removedId) latest.onDefaultAccount(null);
            latest.onChanged(refreshed);
          }}
          onCleanupPending={(refreshed) => {
            const removedId = removing.account.id;
            const latest = reconciliationRef.current;
            focusAfterRemovalRef.current = {
              accountId: removedId,
              provider: removing.account.provider,
            };
            if (latest.defaultAccount === removedId) latest.onDefaultAccount(null);
            latest.onChanged(refreshed);
          }}
        />
      )}
    </>
  );
}
