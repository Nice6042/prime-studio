# Prime Studio Windows effect-surface inventory

**Scope:** current public source tree; no historical commit identity grants authority
**Readiness rule:** only `enforced` may dispatch an effect in Cautious or Trusted Auto. `unavailable` cannot be called; `admission_only` can describe or test a request but cannot authorize it.

This inventory is the security boundary for advertised capabilities. “Implemented” below means the baseline contains the narrow behavior named in the row. “Release status: blocked” means the behavior must not be represented as a secure milestone-one capability until its executor and negative-oracle evidence pass.

Status vocabulary: `implemented` is directly evidenced; `planned` is documented but not present or proven; `blocked` is unavailable until its prerequisite and effect-specific negative oracle pass.

The current `export_html` path is an implemented presentational transcript export, not a lossless backup or source-closure export. The future lossless source-closure path is `planned`/`blocked`. The narrow enforced account-removal transaction is an explicit implemented exception to the general read/export-only posture; it does not make project, shell, browser, connector, or update effects safe.

## Inventory

| Effect class | Examples and reachable resources | Required identity/containment | Baseline status | Release status / evidence gate |
|---|---|---|---|---|
| Account metadata | List, add, rename, status, provider label, default profile selection | Account ID, provider, profile namespace; credential presence/expiry only | **implemented** | Allowed only for credential-free metadata. `types.ts:187-269`, `ACCOUNTS.md:25-38`. |
| Account profile removal | Remove registry entry or profile data | Prepared single-use plan; registry generation; volume/file identity; direct-child/root/reparse/link checks; Windows journal/quarantine/recovery | **implemented** (narrow) | Windows transaction tests pass. It is not a reusable project filesystem broker. `PROTOCOL.md:59-107`. |
| Prime session read/export | State, messages, usage, model discovery, session history | Account-scoped process/profile, bounded framing, correlation, source identity | **implemented** as prototype; secure release **blocked** | Secure release remains **blocked** until the pinned transport profile has durable replay identity, bounded transfer, and read/export-only fallback for unsupported runtimes. |
| Daemon session reattach | Attach by daemon agent ID and restore messages/state | Authoritative daemon `sessionFile` mapped to the validated account/profile; caller-supplied account ID is not authority | **planned; blocked** | The current route can attach by ID but does not verify profile identity before restoring state. |
| Project filesystem read/index | File bytes, paths, directory structure, search results | Brokered handles; canonical root; reparse/UNC/device/ADS rejection; exact identity/digest/range provenance; secret/exclusion policy | **planned; blocked** | Broker and index negative tests must pass before production file browsing/search. |
| Project/worktree write | Create/edit/rename/apply patches, Git writes | Per-attempt execution root; isolated worktree or journaled copy-on-write; preimage and commit identity | **planned; blocked** | Recoverable worktree/journal and crash tests must pass. |
| Destructive project mutation | Delete, overwrite, destructive Git, apply generated artifact | Explicit high-consequence confirmation plus same broker identity and recovery boundary | **planned; blocked** | Current account deletion is the only implemented destructive transaction and has its own protocol. |
| Shell/process execution | Child processes, PowerShell, arbitrary commands | Brokered process worker, allowlist/argument digest, Job Object, restricted token, minimal environment, explicit handles | **implemented** as an unsafe prototype; secure release **blocked** | A Prime tool call or UI approval is not containment. |
| Opaque Python/IPython | Arbitrary Python, filesystem/network/process effects in one cell | AppContainer + Job Object + restricted token + staged filesystem + brokered HTTP; whole-cell approval; self-test | **implemented** as an unsafe prototype; secure release **blocked** | Current UI says the kernel is Prime’s tool and that no approval gate exists. |
| Provider/model inference egress | Send prompt, files, tool results, summaries to Claude or ChatGPT/Codex | Provider-account egress principal; data-category grant; destination/purpose; telemetry-off verification | **implemented** as a prototype; policy **planned; blocked** | Current account/session plumbing does not implement data-class grants. |
| Search/connector egress | Web search, typed connector/API call, remote MCP | Typed broker binding for account, operation, destination, data classes, secret handles | **planned; blocked** | Unknown/unbrokered connectors remain unavailable in contained modes. |
| Built-in browser | Navigate, inspect, click, type, download, screenshot | Isolated Chromium profile, brokered proxy, canonical origin checks, quarantine downloads, redaction, takeover | **planned; blocked** | Deterministic local-fixture and negative tests are required. |
| Existing Chrome bridge | Control a logged-in Chrome session | Explicit connection, profile/domain grant, origin/redirect/frame/popup/DNS checks, visible control, takeover | **planned; blocked** | Existing Chrome is never implied by project read permission. |
| Windows computer use | Foreground app discovery, UI Automation, click/type, screenshots | App identity (AUMID/package or executable signer/hash + PID creation), Job Object, visible controller, takeover | **planned; blocked** | Secure desktop, UAC, lock screen, and higher-integrity targets are unsupported. |
| Browser/computer capture persistence | DOM/UIA labels, screenshots, action history, clipboard/download metadata | Untrusted input classification; versioned redaction before Studio storage; sensitive origins may disable persistence | **planned; blocked** | Ephemeral browser disk may still contain secrets; redaction is not retroactive. |
| Artifact generation/apply | Documents, images, PDFs, spreadsheets, previews, diffs | Content-addressed staging outside source roots; contained renderer; no active content/network/credentials/host IPC | **implemented** as an unsafe preview; secure release **blocked** | Current `Artifacts.tsx` preview is not proof of a hardened renderer. |
| Scheduled/unattended work | Local schedule, catch-up, child chat, worktree, notifications | Scheduler leader/occurrence key/fencing epoch; finite task grant; worktree; `blocked-before-action`; no replay | **planned; blocked** | Scheduler and restart/crash tests must pass. |
| Backup/export/restore | Database, source journals, blobs, settings, memory, artifacts | Immutable fence/manifest; digest/length/schema/reachability/semantic round trip; auth excluded | **planned; blocked** | No application database or lossless source-closure pipeline exists. |
| Delete all Studio data | DB, indexes, caches, managed profiles, unreferenced artifacts, Studio-owned Prime profiles | Explicit review and truthful scope; report provider-side/external/backups/forensics separately | **planned; blocked** | Storage ownership and deletion evidence do not exist. |
| Telemetry/crash analytics | Studio/Prime analytics, crash reports, diagnostics | Off by default; separate opt-in; named destination/fields; local-only refuses unverifiable resident worker | **planned; blocked** | Runtime telemetry state and export redaction are not attestable. |
| Runtime/update activation | Install, spawn, upgrade, rollback, managed Prime ownership | Signed complete closure; compatibility/profile/security/broker epochs; immutable content-addressed path; anti-rollback | **implemented** as bundle wiring only; secure release **blocked** | `tauri.conf.json` bundles the app but does not establish this trust chain. |

## Effect admission contract

For every effect class, the implementation must publish an executor-specific readiness record:

1. `unavailable`: no route exists, or the runtime/worker is unsupported.
2. `admission_only`: the UI/core can render an intent, capability, or approval request, but the request cannot authorize a side effect.
3. `enforced`: the pinned Prime extension, final host gate, broker, executor, and independent negative-oracle suite all agree on the same security/broker/session epochs.

An attached or resumed agent without matching epochs is read/export-only. Unknown protocol records, replayed approval/tool-start records, stale leases, ticket-incapable executors, self-test failure, and outcome-unknown non-idempotent actions fail closed.

## Current implementation boundary

The account-removal transaction is the only baseline feature that demonstrates a complete identity-bound destructive state machine. Its tests cover registry races, target substitution, reparse/hardlink defenses, quarantine cleanup, recovery, and ambiguous outcomes. Those guarantees must not be generalized to project writes, shell, Python, browser, computer, connector, scheduler, or updater effects until each class has its own brokered implementation and positive-control negative oracle.

## References

- The public security requirements documented in this directory.
- `PROTOCOL.md:109-207` for the current RPC surface, account-removal IPC, and Prime extension-gate correction.
- `app/src/components/Settings.tsx:32-42,227-230` for the current absence of browser/computer and approval enforcement.
- `app/src-tauri/capabilities/default.json` for the current broad Tauri `fs:default` capability; it is not a project-root broker.
