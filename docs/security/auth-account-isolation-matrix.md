# Prime Studio authentication and account-isolation matrix

**Scope:** current public source tree; no historical commit identity grants authority
**Initial providers:** Claude (`anthropic`) and ChatGPT/Codex (`openai-codex`)
**Core rule:** a provider account is an egress principal; local read permission never implies permission to transmit to every account/provider.

**Status vocabulary:** `implemented` means directly evidenced; `planned` means required but not present or proven; `blocked` means the capability must remain unavailable until its identity and negative-oracle gates pass. Auth health values and implementation status are separate vocabularies.

## Isolation matrix

| Boundary/object | Stable identity | Allowed contents | Must not contain/cross | Baseline status |
|---|---|---|---|---|
| Account registry row | `account.id` + provider; display label is not authority | ID, label, provider, profile reference, creation time | Credential values, arbitrary deletion paths, secret/error text | **implemented**. `app/src/types.ts:187-194`; `ACCOUNTS.md:25-38`. |
| Prime profile/auth home | Validated account ID → `%USERPROFILE%\\.prime\\profiles\\<id>` | Prime-owned auth/session/settings/log files for that profile | Cross-profile credential/session reads; persisted `agentDir` as deletion authority | **implemented** for profile plumbing; deletion guards tested. |
| Credential boundary | Prime profile/provider key; only presence/expiry metadata crosses Studio IPC | `authed`, expiry, health, provider | Token/password/refresh/API-key bytes in Studio, logs, exports, memory, diagnostics | **implemented** as a type/API rule; full runtime audit still required. |
| Provider account principal | `provider + account.id + profile identity` | Requests explicitly approved for this principal | Consent inferred from another provider/account; automatic cross-provider widening | **planned; blocked**. |
| Prime session | Process/session ID + profile directory + provider/model | Session state, bounded events, usage and transcript records for that profile | Session attachment to an unverified/changed profile; wrong-account history | **implemented** for selected-account spawn plumbing; durable replay and secure reattach remain **planned; blocked**. `useSession.ts` and `PROTOCOL.md` bind account/profile for current sessions. |
| Daemon session reattach | Daemon agent ID plus authoritative `sessionFile`/profile identity | Only history/state whose daemon-reported session file maps to the selected validated account | Agent ID alone, caller-supplied account ID, or a display label as profile authority | **planned; blocked.** `attach_session` accepts the ID and optional account context but does not yet verify the daemon row's `sessionFile` before restoring messages/state. |
| Chat / orchestration run | Stable Chat and `OrchestrationRun` IDs; lead/child graph | Messages, tool results, approvals, usage, source records for one project/account grant | Sibling-agent authority or cross-chat memory inferred from shared UI | **planned; blocked**. Current app has session tabs, not the approved durable model. |
| Agent attempt | Immutable attempt ID + provider account + Prime session + execution root | One provider/model actor’s bounded attempt and usage | Reusing a worktree, approval, or non-idempotent action from another attempt | **planned; blocked**. |
| Git worktree / non-Git working copy | Chat/run/attempt + base revision + root identity | Changes for that attempt | Shared writable root or silent direct main-folder mutation | **planned; blocked**. |
| Brokered connector secret | Opaque secret handle bound to connector/account/operation | Worker use without exposing the value to model/Studio | Secret value in prompt, transcript, memory, log, export, or generic Prime UI | **planned; blocked**. No broker. |
| Built-in browser profile | Run/attempt + ephemeral profile + origin grants | Isolated page state and selected redacted results | Cookies/passwords/OTP/payment/clipboard values in durable Studio state | **planned; blocked**. No browser worker. |
| Existing Chrome bridge | Explicit connection + profile/origin grant | Only approved origins/actions while visible control is active | Implicit reuse of logged-in Chrome or grant transfer across origins | **planned; blocked**. No bridge. |
| Windows desktop controller | Application package/AUMID or canonical path + signer/hash + PID creation identity | Approved foreground app primitives | Title, bare exe name, PID, HWND, secure desktop/UAC/higher-integrity target as authority | **planned; blocked**. No worker. |
| Usage/diagnostic record | Response/agent/chat/project/account/time + source/observation ID | Reported/reliably derived tokens, context, cost, health facts | Invented quota/zero values, credential values, ambiguous cross-account aggregation | **implemented** for prototype display; provenance ledger is **planned; blocked**. |
| Account removal transaction | Single-use plan ID + registry generation + target volume/file identity | Credential-free plan, bounded estimate, blockers, recovery evidence | Persisted path as authority, shared/default profile, reparse/hardlink target, replayed plan | **implemented** as a narrow, enforced Windows transaction; 71 Rust tests pass. |

## Account lifecycle and auth-health matrix

`AuthHealth` in `app/src/types.ts:254-269` has exactly four source states: `signedIn`, `expiringSoon`, `expired`, and `signedOut`. `not installed`, `rate limited`, and `unavailable` are provider/runtime/readiness observations, not additional `AuthHealth` values. They must not be serialized as if they were the source type.

| State | State kind | Meaning | Allowed Studio behavior | Blocked behavior | Implementation status |
|---|---|---|---|---|---|
| `signedIn` | Source `AuthHealth` | Profile key presence/expiry indicates usable auth metadata | Show account-scoped health; egress still needs data-category grant | Treat auth as permission to transmit all local data | **implemented** |
| `expiringSoon` | Source `AuthHealth` | Provider expiry runway is below the configured health threshold | Warn and allow explicit re-login | Copy or refresh token in Studio | **implemented** |
| `expired` | Source `AuthHealth` | Provider auth metadata is expired | Read/export existing local records; prompt re-login | Dispatch inference as healthy | **implemented** |
| `signedOut` | Source `AuthHealth` | Profile exists but provider credential key is absent | Show login action using the visible, profile-scoped Prime flow | Read credential values or pretend inference is available | **implemented** |
| `not installed` | Provider/runtime overlay, not an `AuthHealth` value | Provider CLI/runtime is absent or unsupported | Show setup guidance; remain read/export-only | Spawn or claim provider health | **planned; blocked** |
| `rate limited` | Provider/runtime overlay, not an `AuthHealth` value | Provider/Prime reports a limit | Show provider-reported status and preserve source attribution | Invent quota or silently switch accounts/providers | **planned; blocked** |
| `unavailable` | Readiness/transport overlay, not an `AuthHealth` value | Runtime, protocol, account, or service cannot be verified | Fail closed to read/export with an actionable reason | Fall back to a different unapproved auth path | **planned; blocked** |

## Invariants

1. Every provider request has exactly one provider-account principal at admission; switching provider/account starts a fresh egress evaluation.
2. Credential presence/expiry is the maximum authentication detail crossing the Studio bridge; credential bytes never become Studio data.
3. `agentDir` is a profile association, not filesystem authority. Account deletion re-derives the target from the validated ID and rechecks identity under the mutation lock.
4. A default/migrated/shared profile is never eligible for profile-data deletion; entry-only removal cannot be represented as profile deletion.
5. An account removal plan is opaque, credential-free, expiring, single-use, and consumed on expiry, blocker, mismatch, race, or commit attempt; retry requires a new plan.
6. A local read grant, memory scope, tool result, attachment, or sibling-agent result does not widen egress to another provider/account.
7. An account/chat/worktree/attempt deletion or retry never silently deletes or reuses evidence belonging to another principal.
8. A daemon agent ID is not profile authority. Before a reattach can restore history or state, an authoritative daemon listing must provide `sessionFile`; Studio must derive the account/profile identity from the validated path and compare it with the selected account. Missing, changed, or mismatched identity is `planned`/`blocked` and remains read/export-only.
9. The narrow enforced account-removal transaction is an explicit exception to the general read/export-only posture. It cannot widen into project deletion, shell execution, egress, or daemon reattach authority.

## Evidence and gaps

- `ACCOUNTS.md:3-38` documents the one-credential-per-provider constraint, profile relocation, registry shape, and credential-value prohibition.
- `ACCOUNTS.md:40-87` and `PROTOCOL.md:59-107` document the implemented removal transaction and fail-closed paths.
- `app/src/types.ts:221-269` defines the credential-free plan and presence/expiry health shape.
- `app/src/useSession.ts:82-93,241-268` fixes the selected account for a spawned session; this is session plumbing, not complete egress authorization.
- `app/src-tauri/src/lib.rs:1543-1576` accepts `agent` plus optional `account_id` for attach; the current implementation does not compare the daemon-reported `sessionFile` with the selected account before restoring state, so reattach isolation is **planned; blocked**.
- Separate egress principals, durable AgentRuns/attempts, provider consent, worktree isolation, and brokered secret handles remain **planned/blocked**.
