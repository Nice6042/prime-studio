# Multi-account design (verified against prime-agent 0.7.1)

## The constraint

`~/.prime/agent/auth.json` is `Record<providerId, AuthCredential>` — **exactly one credential per
provider**. So a single Prime home cannot hold 2 Claude + 2 ChatGPT logins.

## The mechanism

`getAgentDir()` in the bundle:

```js
function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR];   // PRIME_AGENT_CODING_AGENT_DIR
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), ".prime/agent");
}
```

So **`PRIME_AGENT_CODING_AGENT_DIR` relocates the whole agent home** — `auth.json`, `sessions/`,
`settings.json`, `logs/`. One dir per account = fully isolated credentials, history and settings.

Profiles live at: `~/.prime/profiles/<profileId>/`

## Account model

| Field | Notes |
|---|---|
| `id` | slug, e.g. `claude-personal`, `chatgpt-work` |
| `label` | user-facing name |
| `provider` | `anthropic` \| `openai-codex` (which credential the profile is for) |
| `agentDir` | `~/.prime/profiles/<id>` |
| `authed` | derived: does `<agentDir>/auth.json` contain the provider key? |
| `expires` | from that credential (surface "needs re-login") |

Registry file (app-owned, no secrets): `~/.prime/profiles/accounts.json`.

**Never read or log credential values** — only key presence and `expires`.

## Removing an account

The Accounts UI has two separate actions:

- **Remove entry only** removes the registry row and leaves the profile tree byte-for-byte
  untouched.
- **Remove entry and profile data** permanently removes only the verified account-owned profile.
  The review shows the exact absolute target and a bounded item/byte estimate, and the action
  stays disabled until the account label is typed exactly (ordinal and case-sensitive).

Both actions use `prepare_remove_account(id, deleteData)` followed by
`commit_remove_account(planId, typedLabel)`. Preparation is read-only and returns a
credential-free, opaque authority that expires after five minutes. A known plan is single-use:
expiry, mismatch, blockers, registry races, and commit attempts consume it, so retry starts with
a fresh review. Cancel and Escape never commit the plan.

The only possible profile target is re-derived as
`%USERPROFILE%\.prime\profiles\<validated-account-id>`. Persisted `agentDir` is never a rename,
quarantine, traversal, or deletion target. Profile-data removal is blocked for an active
session, a default/migrated or shared profile, a stored-path mismatch, a target that is not the
verified direct child, any reparse point in the target ancestry/tree, or an operating system
without the identity-bound profile transaction. The same facts are revalidated while the
registry mutation lock is held at commit.

On Windows, both choices retain the approved journal and identity-bound proposed-registry
transaction. Profile-data mode first renames a verified profile into Studio-owned same-volume
`.trash`, then the proposed registry replaces `accounts.json`, then quarantine is removed without
following reparses. A failure before registry commit restores the exact quarantine or reports an
unknown outcome; a failure after commit never puts the account row back.

On macOS and Linux, a prepared entry-only commit remains supported. It performs the same
single-use plan, registry identity/generation, account, and label revalidation under the account
mutation lock, then uses the account registry's durable atomic replacement without creating a
journal or touching the profile. Profile-data removal is not approximated there: preparation
returns an `unsupportedPlatform` blocker, the review labels the operating system as blocked and
directs the user to entry-only removal, and commit fails closed.

`cleanupPending` means the account entry committed but quarantine or transaction-record cleanup
still needs a restart. `recoveryRequired` and `outcomeUnknown` also require a restart before any
further account mutation; the UI does not issue a second commit. Startup recovery uses the
journal plus exact registry generations to restore a pre-commit profile or finish committed
cleanup deterministically.

New and renamed labels reject control and bidirectional-formatting characters before mutation.
Legacy labels containing them remain visible through an injective `[escaped] ...` rendering and
can still be renamed or removed entry-only, but profile-data deletion requires renaming to a safe
label first. Backend error text, blocker payloads, credential values, and persisted `agentDir`
values are never reflected into deletion failure copy.

## Login / logout

OAuth login is an interactive TUI flow (`/login`, `/logout` — confirmed in the bundle's slash
command table); there is no RPC login command. So:

- **Add / re-login an account**: launch the interactive CLI in a *visible* terminal with that
  profile's env, and let the user complete the browser OAuth. This is the one place a console
  window is intentional. On Windows the app does this for you
  (`cmd /c start "<title>" cmd /k node <cli.js>` with `PRIME_AGENT_CODING_AGENT_DIR` on the
  spawned process — not as a `set X=… &&` string, which folds the trailing space into the value).
  On other platforms the app cannot portably drive a terminal emulator, so it returns the
  command to run instead: `PRIME_AGENT_CODING_AGENT_DIR=<dir> prime-agent`, then `/login`.
- Poll `<agentDir>/auth.json` for the provider key to flip the account to "authed".

## Concurrency (multiple accounts at once)

Prime Studio spawns `--mode rpc` per session — no daemon involved — so N sessions on N different
profiles run in parallel; each child just gets its own `PRIME_AGENT_CODING_AGENT_DIR`. (Only the
`--mode daemon` path would need distinct `--daemon-socket` values.)

## Per-account usage

Prime does not expose subscription quota. What is available, per profile:

- Live session: `get_session_stats` → `tokens`, `cost`, `contextUsage`.
- Historical: sum assistant `message.usage` + `child_usage_attributed.childUsage` across
  `<agentDir>/sessions/*.jsonl` (same method as the harness benchmark).

Report per account: today / 7-day / all-time cost + tokens, and session count. Label it
**API-equivalent cost** — subscription logins bill $0 marginal.

## Migration

The existing `~/.prime/agent` stays as-is and is registered as the default profile for each
provider credential it already holds, so nothing the user already has is disturbed. Those
migrated/default rows can be removed from the registry, but their shared original profile is
never eligible for profile-data deletion.
