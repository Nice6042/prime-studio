import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import {
  deletionErrorMessage,
  formatRemovalEstimate,
  isUnsafeAccountLabel,
  isRemovalPlanExpired,
  removalBlockerRows,
  visualizeUntrustedText,
} from "../accounts/delete";
import * as rpc from "../rpc";
import type { Account, AccountDeletionErrorCode, AccountRemovalPlan } from "../types";

type CommitOutcome =
  | {
      kind: "retryable";
      code: AccountDeletionErrorCode;
    }
  | {
      kind: "terminal";
      code: AccountDeletionErrorCode | "unknown" | "refreshFailed" | "refreshMismatch";
    }
  | null;

const RETRYABLE_COMMIT_ERROR_CODES: ReadonlySet<AccountDeletionErrorCode> = new Set([
  "accountNotFound",
  "invalidAccountId",
  "planNotFound",
  "planExpired",
  "planReplayed",
  "planBlocked",
  "planRequired",
  "registryChanged",
  "targetChanged",
  "labelMismatch",
  "registryInvalid",
  "unsafeTarget",
]);

export function AccountRemovalDialog({
  account,
  opener,
  onClose,
  onRemoved,
  onCleanupPending,
}: {
  account: Account;
  opener: HTMLButtonElement;
  onClose: () => void;
  onRemoved: (refreshed: Account[]) => void;
  onCleanupPending: (refreshed: Account[]) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [mode, setMode] = useState<"entry" | "data">("entry");
  const [stage, setStage] = useState<"choice" | "review">("choice");
  const [plan, setPlan] = useState<AccountRemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitOutcome, setCommitOutcome] = useState<CommitOutcome>(null);
  const [error, setError] = useState<string | null>(null);
  const [typedLabel, setTypedLabel] = useState("");
  const [composing, setComposing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    if (stage !== "review" || !plan) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    const expiryTimer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, plan.expiresAtMs - Date.now()),
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [plan, stage]);

  const blockerRows = plan ? removalBlockerRows(plan) : [];
  const preparedLabelUnsafe = !!plan && isUnsafeAccountLabel(plan.accountLabel);
  const dataBlocked =
    !!plan?.deleteData &&
    (!plan.checks.dataDeletionAllowed ||
      plan.blockers.length > 0 ||
      blockerRows.some((row) => row.blocked));
  const expired = plan ? isRemovalPlanExpired(plan, now) : false;
  const labelMatches = !!plan && typedLabel === plan.accountLabel;
  const remainingSeconds = plan ? Math.max(0, Math.ceil((plan.expiresAtMs - now) / 1_000)) : 0;
  const dataCommitAllowed =
    !!plan?.deleteData &&
    !busy &&
    !commitOutcome &&
    !expired &&
    !dataBlocked &&
    !preparedLabelUnsafe &&
    labelMatches &&
    !composing;
  const terminal = commitOutcome?.kind === "terminal";

  useEffect(() => {
    if (stage !== "review" || busy) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (terminal) {
      cancelRef.current?.focus();
    } else if (commitOutcome?.kind === "retryable" || (!commitOutcome && expired)) {
      retryRef.current?.focus();
    } else if (!dialog.contains(document.activeElement)) {
      cancelRef.current?.focus();
    }
  }, [busy, commitOutcome, expired, stage, terminal]);

  const errorCode = (value: unknown) =>
    value instanceof rpc.AccountDeletionError ? value.code : "unknown";

  const prepare = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const prepared = await rpc.prepareRemoveAccount(account.id, mode === "data");
      setPlan(prepared);
      setCommitOutcome(null);
      setTypedLabel("");
      setComposing(false);
      setNow(Date.now());
      setStage("review");
    } catch (failure: unknown) {
      setError(deletionErrorMessage(errorCode(failure)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!plan || commitOutcome || busyRef.current) {
      return;
    }
    const clickedAt = Date.now();
    if (expired || isRemovalPlanExpired(plan, clickedAt)) {
      setNow(clickedAt);
      return;
    }
    if (plan.deleteData && (dataBlocked || preparedLabelUnsafe || !labelMatches || composing)) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await rpc.commitRemoveAccount(plan.planId, plan.deleteData ? typedLabel : "");
      let refreshed: Account[];
      try {
        refreshed = await rpc.listAccountsStrict();
      } catch {
        setCommitOutcome({ kind: "terminal", code: "refreshFailed" });
        setError(
          "Prime Studio could not confirm the refreshed account list. Restart Prime Studio before changing this account.",
        );
        return;
      }
      if (refreshed.some((candidate) => candidate.id === account.id)) {
        setCommitOutcome({ kind: "terminal", code: "refreshMismatch" });
        setError(
          "Prime Studio could not confirm that the account entry is gone. Restart Prime Studio before changing this account.",
        );
        return;
      }
      onRemoved(refreshed);
    } catch (failure: unknown) {
      const code = errorCode(failure);
      if (code === "cleanupPending") {
        let refreshed: Account[];
        try {
          refreshed = await rpc.listAccountsStrict();
        } catch {
          setCommitOutcome({ kind: "terminal", code });
          setError(
            "Profile cleanup is pending, and Prime Studio could not refresh accounts. Restart Prime Studio before changing this account.",
          );
          return;
        }

        setCommitOutcome({ kind: "terminal", code });
        if (refreshed.some((candidate) => candidate.id === account.id)) {
          setError(
            "Profile cleanup is pending, but the refreshed list still contains this account. Restart Prime Studio before changing it.",
          );
          return;
        }
        onCleanupPending(refreshed);
        setError(deletionErrorMessage(code));
        return;
      }

      if (code !== "unknown" && RETRYABLE_COMMIT_ERROR_CODES.has(code)) {
        setCommitOutcome({ kind: "retryable", code });
        setError(deletionErrorMessage(code));
        return;
      }

      setCommitOutcome({ kind: "terminal", code });
      if (code === "outcomeUnknown" || code === "recoveryRequired") {
        setError(deletionErrorMessage(code));
      } else if (code === "quarantineConflict") {
        setError(
          "Prime Studio found an unresolved removal transaction. Restart Prime Studio before changing this account.",
        );
      } else {
        setError(
          "Prime Studio could not verify whether removal changed this account. Restart Prime Studio before changing it.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const keepFocusInside = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="account-delete-dialog"
      aria-labelledby={titleId}
      aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busyRef.current) onClose();
      }}
      onClose={() => {
        if (!busyRef.current) onClose();
      }}
      onKeyDown={keepFocusInside}
    >
      <div className="account-delete-head">
        <h2 id={titleId}>
          Remove <bdi className="account-delete-safe-text" dir="ltr">{visualizeUntrustedText(account.label)}</bdi>?
        </h2>
      </div>
      <p id={descriptionId} className="account-delete-lede">
        Choose whether to keep or permanently delete this account&apos;s profile data. Nothing
        changes until you confirm.
      </p>
      {stage === "choice" ? (
        <fieldset className="account-delete-choices" disabled={busy}>
          <legend>What should Prime Studio remove?</legend>
          <label className="account-delete-choice">
            <input
              type="radio"
              name="account-removal-mode"
              value="entry"
              checked={mode === "entry"}
              onChange={() => setMode("entry")}
            />
            <span>
              <strong>Remove entry only</strong>
              <small>Keep the profile and its files on this device.</small>
            </span>
          </label>
          <label className="account-delete-choice">
            <input
              type="radio"
              name="account-removal-mode"
              value="data"
              checked={mode === "data"}
              onChange={() => setMode("data")}
            />
            <span>
              <strong>Remove entry and profile data</strong>
              <small>Prepare a verified target before permanently deleting files.</small>
            </span>
          </label>
        </fieldset>
      ) : (
        plan && (
          <section className="account-delete-review" aria-label="Prepared removal">
            <h3>{plan.deleteData ? "Review profile-data removal" : "Review entry removal"}</h3>
            <dl>
              <div>
                <dt>Account</dt>
                <dd className="account-delete-safe-text" dir="ltr">
                  {visualizeUntrustedText(plan.accountLabel)}
                </dd>
              </div>
              {plan.deleteData && (
                <>
                  <div>
                    <dt>Derived target</dt>
                    <dd>
                      <code className="account-delete-target">
                        {visualizeUntrustedText(plan.targetPath)}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Bounded estimate</dt>
                    <dd>{formatRemovalEstimate(plan.estimate)}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>Confirmation</dt>
                <dd>
                  {expired ? (
                    "This confirmation has expired."
                  ) : (
                    <time dateTime={new Date(plan.expiresAtMs).toISOString()}>
                      Expires in {remainingSeconds} seconds.
                    </time>
                  )}
                </dd>
              </div>
            </dl>
            {!plan.deleteData && (
              <p>The account entry will be removed. Its profile and files stay on this device.</p>
            )}
            {plan.deleteData && (
              <>
                <ul className="account-delete-checks" aria-label="Profile deletion safety checks">
                  {blockerRows.map((row) => (
                    <li key={row.key} data-blocked={row.blocked}>
                      <span>{row.label}</span>
                      <strong>{row.blocked ? "Blocked" : "Clear"}</strong>
                      <small>{row.detail}</small>
                    </li>
                  ))}
                </ul>
                {preparedLabelUnsafe ? (
                  <p className="account-delete-legacy-warning">
                    This legacy label contains hidden formatting or control characters. Rename
                    this account before deleting profile data.
                  </p>
                ) : (
                  <label className="account-delete-label-confirmation">
                    <span>
                      Type <strong>{plan.accountLabel}</strong> to confirm
                    </span>
                    <input
                      className="search"
                      value={typedLabel}
                      onChange={(event) => setTypedLabel(event.target.value)}
                      onCompositionStart={() => setComposing(true)}
                      onCompositionEnd={() => setComposing(false)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.nativeEvent.isComposing &&
                          dataCommitAllowed
                        ) {
                          event.preventDefault();
                          void commit();
                        }
                      }}
                      aria-invalid={typedLabel.length > 0 && !labelMatches}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <small>Match the account label exactly. Profile deletion cannot be undone.</small>
                  </label>
                )}
              </>
            )}
          </section>
        )
      )}

      {error && (
        <div id={errorId} className="account-delete-error" role="alert">
          {error}
        </div>
      )}
      <div className="account-delete-actions">
        <button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={busy}>
          {terminal ? "Close" : "Cancel"}
        </button>
        {stage === "choice" ? (
          <button type="button" className="btn btn-danger" onClick={() => void prepare()} disabled={busy}>
            {busy ? "Checking..." : "Continue"}
          </button>
        ) : (
          <>
            {!commitOutcome && !expired && plan && !plan.deleteData && (
              <button type="button" className="btn btn-danger" onClick={() => void commit()} disabled={busy}>
                {busy ? "Removing..." : "Remove entry"}
              </button>
            )}
            {!commitOutcome && !expired && plan?.deleteData && !preparedLabelUnsafe && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void commit()}
                disabled={!dataCommitAllowed}
              >
                {busy ? "Removing..." : "Remove profile data"}
              </button>
            )}
            {(commitOutcome?.kind === "retryable" || (!commitOutcome && expired)) && (
              <button
                ref={retryRef}
                type="button"
                className="btn"
                onClick={() => void prepare()}
                disabled={busy}
              >
                {busy ? "Checking..." : "Prepare again"}
              </button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
