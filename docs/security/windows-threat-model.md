# Prime Studio Windows threat model

**Status:** normative security boundary; general effectful execution is `planned`/`blocked`, with one narrow `implemented` account-removal exception
**Scope:** current public source tree; no historical commit identity grants authority
**Platform scope:** Windows-first, one local user and one machine

This document describes what Prime Studio must protect and the boundary at which a capability may be called secure. It does not turn the current prototype into a security boundary. `implemented` means directly evidenced in the current tree; `planned` means documented but not present or proven; `blocked` means the capability must remain unavailable until its named prerequisite passes.

## Security release posture

| Area | Current status | Evidence and consequence |
|---|---|---|
| Account registry/profile removal | **implemented** (narrow, enforced exception) | Windows transaction, identity checks, quarantine cleanup, recovery, and 71 Rust tests are present. This protects one destructive account-management path; it is not a general executor broker. |
| Prime pre-tool denial hook | **implemented** (audit evidence only) | The installed Prime 0.7.1 hook can block a tool body, but Prime still emits `tool_execution_start` for a blocked call. The UI must not treat that hook as an OS sandbox. |
| Cautious and Trusted Auto execution | **blocked** | The baseline has no Windows permission broker, final host gate, contained executor, or negative-side-effect suite. Approval UI is admission-test UI only. |
| Project filesystem/index | **planned; blocked** | The broker must establish canonical handle identity and provenance before production file browsing/search is enabled. |
| Browser, Chrome, and Windows computer use | **planned; blocked** | Dedicated isolated workers, target identity checks, takeover, and containment are absent. Arbitrary Python is not a substitute. |
| Runtime/update trust | **planned; blocked** | No checked-in compatibility manifest, signed artifact closure, updater trust chain, or exact-byte release evidence exists in this baseline. |

For every effect class without executor-specific `enforced` readiness, the security-claim posture is chat plus read/export behavior. The current prototype can still reach Prime's uncontained tool effect; that path is a known `blocked` release capability, not a safe execution boundary. The narrow, enforced account-removal transaction is an explicit exception under its own account identity, transaction, and recovery invariants. The current `export_html` command is a presentational HTML transcript export only; it is not the future lossless backup/source-closure export, which remains `planned`/`blocked`. A UI label, Prime extension response, dev preview, or successful prompt is not proof of an allowed effect.

## Assets and required properties

| Asset | Required property |
|---|---|
| Provider credentials and refresh state | Never copied into Studio state, logs, exports, diagnostics, memories, or IPC payloads. |
| Account registry and profile trees | Account-scoped; deletion can affect only the verified account-owned target and must recover deterministically after interruption. |
| Prime sessions, transcripts, usage, and source journals | Durable identity, account attribution, bounded provenance, and no cross-account projection. Unknown outcomes must not be silently retried. |
| Project files, Git worktrees, and generated artifacts | Root- and identity-bound; writes are recoverable; generated artifacts stay outside source roots until explicitly applied. |
| Browser profiles, cookies, downloads, screenshots, and page content | Ephemeral by default, origin-scoped, never treated as trusted instructions, and redacted before durable Studio activity storage. |
| Windows applications and desktop state | Targeted by stable package/signer/hash identity, not a title, bare executable name, PID, or HWND alone. Secure desktop and higher-integrity targets are unsupported. |
| Policies, grants, leases, epochs, and approval records | Final-argument-bound, one-shot where effectful, revocable, auditable, and invalidated by policy/broker/session changes. |
| Runtime, native workers, security extension, and updater | One authenticated, compatible artifact closure; no silent mixing with an external Prime install. |
| Logs, diagnostics, telemetry, and release evidence | Least-sensitive by default, telemetry off unless separately opted in, credential-free, retention-limited, and bound to the exact tested bytes. |

## Actors and trust assumptions

The following inputs are untrusted unless a separate control says otherwise:

- A model, Prime session, prompt, tool argument, generated code, or agent-to-agent message.
- Project files, repository content, web pages, DOM/UI Automation labels, screenshots, clipboard contents, downloaded files, and connector responses. These may contain prompt injection or misleading instructions.
- Third-party skills, plugins, MCP servers, native tools, remote connectors, and their manifests. Static metadata describes requested permissions; it does not establish trust.
- A provider or remote endpoint. Provider authentication identifies an egress principal but does not make returned content safe to execute.
- A local process, user-controlled path, reparse point, hardlink, symlink, alternate stream, or race between authorization and commit.
- A stale/resumed Prime worker, old approval response, replayed event, crashed scheduler leader, or detached process.
- An update, archive, dependency, signature, key rotation, or version string that has not passed the managed trust chain.

The authenticated local user is the policy author, but the application must not treat a user-visible label as proof that an effect target is the intended object. The Windows broker and independently contained executors are the enforcement authority; the UI and generic Prime extension UI are policy/admission surfaces, not authority.

## Trust boundaries

| Boundary | Required crossing rule | Current posture |
|---|---|---|
| UI ↔ application core | UI issues typed intent; it cannot grant authority by rendering an approval or accepting a model-supplied decision. | **planned; blocked**. Current UI is a prototype surface. |
| Application core ↔ security broker | Broker receives authenticated policy/grant context and the frozen final argument digest; it evaluates current policy and persists the decision. | **planned; blocked**; no broker exists. |
| Prime extension ↔ final Prime host gate | The pinned first-party extension may forward/deny, but the final host gate revalidates a broker ticket immediately before dispatch. Extension-supplied identity is untrusted. | **planned; blocked**; the audit only proves the first hook can deny. |
| Broker ↔ executor | A contained executor verifies and atomically consumes a one-shot ticket while moving `LEASED → STARTED`. Ticket-incapable executors fail closed. | **planned; blocked**. |
| Project root ↔ filesystem object | Authorization uses opened-handle identity, canonical final path, volume/file ID, link count, root membership, and expected preimage; path strings alone are insufficient. | **implemented** for account-profile deletion only; **planned; blocked** for project effects. |
| Studio ↔ provider/connector/browser destination | Egress is per provider account/connector principal, destination, purpose, and data category. Local read is not outbound consent. | **planned; blocked**. |
| Managed runtime ↔ update artifact | A signed manifest authenticates the complete tested closure, compatibility profile, channel, epoch, and schema range before activation/spawn. | **planned; blocked**. |
| Durable projection ↔ Prime source | A projection advances only from a verified source closure/cursor and matching generation. Duplicate, truncated, replaced, malformed, or missing evidence is quarantined. | **planned; blocked**; current prototype has no application database/source-closure importer. |

## Threats, controls, and status

| Threat | Required control | Status in `090d527` |
|---|---|---|
| Prompt injection causes an agent to exfiltrate or mutate data | Treat model/page/file/screenshot text as data; broker final effects and egress independently. | **blocked** for effectful execution. |
| Approval dialog is shown after the effect or is bypassed by a custom tool | Pre-tool admission plus final host verification plus independent executor; no generic UI response as authority. | **blocked**. Current UI explicitly says it has no approval gate. |
| Python/IPython, PowerShell, or shell escapes a project boundary | AppContainer + Job Object, restricted token, minimal environment, staged filesystem, brokered HTTP, self-test, and fail-closed launch. | **blocked**; current Prime IPython is opaque/full-effect execution. |
| TOCTOU, reparse, hardlink, UNC/device, or alternate-stream substitution | Handle-based identity and immediate revalidation before commit. | **implemented** for account deletion; **planned; blocked** for the broker. |
| Cross-account or cross-chat transcript/credential exposure | Separate profile/environment, account principal on every egress, stable chat/AgentRun/worktree identity, credential-free IPC/export. | **planned; blocked** beyond the implemented account-profile plumbing. |
| Browser redirect, popup, DNS rebinding, target replacement, or cookie capture | Canonical origin rechecks; ephemeral profile; redaction-before-persistence; takeover invalidates lease. | **planned; blocked**. |
| Desktop controller targets the wrong application or elevated surface | AUMID/package or canonical executable + signer/hash + PID creation identity; deny secure desktop/UAC/higher integrity. | **planned; blocked**. |
| Stale approval, scheduler lease, or replayed event authorizes a new action | Broker/policy/session epochs, one-shot tickets, current snapshot proof, occurrence uniqueness, and no automatic replay of uncertain effects. | **planned; blocked**. |
| Malicious or downgraded update runs a different closure | Signed canonical envelope, monotonic sequence, channel/expiry checks, anti-rollback floor outside backups, immutable content-addressed launch paths. | **planned; blocked**. |
| Crash causes duplicate non-idempotent effect or false success | Persist intent/outcome, preserve `outcome-unknown`, never retry non-idempotent actions automatically, and recover from durable evidence. | **implemented** for the account-removal transaction; **planned; blocked** elsewhere. |
| Diagnostic/export path leaks secrets or overclaims deletion | Classify records, exclude auth, redact diagnostics, disclose provider-side/external/backups/forensic retention. | **planned; blocked**; current prototype is not a complete privacy pipeline. |

## Explicitly unsupported in contained modes

The following are not “trusted” merely because the user enabled Trusted Auto:

- Unbrokered third-party in-process extensions, custom native tools, MCP processes, and remote connectors.
- Full-trust opaque interpreters without a proved contained worker.
- Secure desktop, UAC, lock/logon screens, higher-integrity applications, and arbitrary actions after an outcome-unknown crash.
- An external or mismatched Prime installation silently mixed with the managed compatibility set.

Enabling full-trust developer behavior must switch the session visibly to `Unrestricted`; it must not be mislabeled Cautious or Trusted Auto.

## Evidence references

- `PROTOCOL.md:188-207` records the corrected Prime extension gate and the distinct blocked-tool state, but also documents that the hook is not a sandbox.
- `PROTOCOL.md:59-107` and `ACCOUNTS.md:40-87` describe the credential-free, identity-bound account-removal protocol.
- `app/src/components/Settings.tsx:32-42,227-230` states that browser/computer use and approval/permission gating are not present in the current UI.
- `app/src-tauri/src/accounts/delete.rs:21-168,216-260` defines the narrow removal plan, identity checks, blockers, and transaction fault points.
- `app/src-tauri/src/lib.rs:1543-1576` shows that daemon attach accepts an agent ID plus caller-supplied account context; it does not yet verify the daemon row's `sessionFile` against that account before restoring state. Daemon reattach account/profile isolation is therefore **planned; blocked**.
- `docs/security/readiness-oracle-record.schema.json` defines the machine-readable evidence fields required before an effect can be promoted.
- The fresh baseline run on this branch passed 50 frontend tests, the reducer check, and 71 Rust tests; those tests cover account deletion and existing prototype behavior, not the missing broker/containment gates.
