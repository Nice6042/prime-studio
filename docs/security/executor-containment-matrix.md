# Prime Studio Windows executor-containment matrix

**Scope:** current public source tree; no historical commit identity grants authority
**Implementation-status vocabulary:** `implemented` is directly evidenced; `planned` is required but not present or proven; `blocked` must remain unavailable until the readiness and effect-specific oracle pass. Readiness and implementation status are separate fields in [`readiness-oracle-record.schema.json`](./readiness-oracle-record.schema.json).
**Readiness vocabulary:** `unavailable` → no route; `admission_only` → intent/approval can be rendered but cannot authorize an effect; `enforced` → broker, final host gate, contained executor, epoch handshakes, self-test, and independent negative-oracle evidence all pass.

Approval is not containment. Trusted Auto changes prompting defaults; it never removes the Windows boundary. Unknown, unbrokered, full-trust in-process, or ticket-incapable implementations are unavailable in contained modes.

## Matrix

| Executor/effect | Required boundary | Cautious | Trusted Auto | Current baseline |
|---|---|---:|---:|---|
| Prompt-only / planning | No host effect; static metadata only | Eligible after capability metadata checks | Eligible after same checks | **implemented** as chat/planning only. |
| Prime session read/export | Account/profile-scoped Prime process; bounded transport; source identity; no effect dispatch | `enforced` only for the selected read/export profile | Same | **implemented** as a prototype; secure readiness **blocked**. |
| Brokered project read/index | Non-elevated broker; canonical root; opened-handle identity; byte/range bounds; secret/exclusion policy | Planned `enforced` | Same | **planned; blocked**. |
| Brokered project/worktree write | Distinct attempt root; Git worktree or journaled copy-on-write; preimage/commit revalidation | Planned `enforced` | Auto only within a finite, current grant; never outside root | **planned; blocked**. |
| Account registry/profile deletion | Identity-bound plan, mutation lock, Windows journal/quarantine, no-follow cleanup, recovery | Current narrow `enforced` transaction | Same transaction; no Trusted Auto widening | **implemented** and tested; narrow exception. |
| Shell/process worker | Non-elevated broker; allowlisted operation; Job Object; restricted token; explicit handle set; bounded runtime/output | Planned `enforced` | Same containment; grant may avoid a prompt for enumerated low-risk rules | **planned; blocked**. |
| Opaque Python/PowerShell/IPython | AppContainer + Job Object + restricted-token defense in depth; minimal env; staged filesystem; brokered HTTP; secure self-test | Planned `enforced` | Same; whole command/cell remains high-consequence unless an enumerated safe operation exists | **implemented** as an uncontained prototype; secure release **blocked**. |
| Brokered HTTP/search | Proxy/egress broker; canonical destination; DNS/rebinding policy; data-category grant; no ambient credentials | Planned `enforced` | Same; no unbounded domain trust | **planned; blocked**. |
| Typed remote connector | Out-of-process/remote typed binding for account, operation, destination, data classes, secret handle | Planned `enforced` | Same | **planned; blocked**. Current HTTP/MCP notes do not establish containment. |
| Isolated Chromium/Playwright | Ephemeral profile; brokered proxy; origin rechecks through redirects/frames/popups/DNS; download quarantine; redaction; takeover | Planned `enforced` | Same; automatic actions only from versioned low-risk class | **planned; blocked**. |
| Existing Chrome bridge | Explicit connection; profile/domain grant; visible controller; canonical origin target; synchronous takeover | Planned `enforced` | Same | **planned; blocked**. |
| Windows UI Automation worker | Job Object; app package/AUMID or executable signer/hash + PID creation identity; foreground-only; takeover; no secure desktop/UAC | Planned `enforced` | Same | **planned; blocked**. |
| Artifact renderer/preview | Separate resource-bounded worker; no network/credentials/project writes/active content/host IPC; sanitized formats | Planned `enforced` | Same | **implemented** as an unsafe preview; secure release **blocked**. |
| Scheduler worker | Resident leader/fencing epoch; occurrence key; finite task grant; isolated worktree; `blocked-before-action`; no replay | Planned `enforced` | Same | **planned; blocked**. |
| Update/activation worker | Signed closure; immutable path; archive safety; exclusive runtime lock; migration/recovery gate | Planned `enforced` | Same | **planned; blocked**. |

## Non-bypassable dispatch sequence

Every effectful executor must implement the same sequence, with effect-specific identity checks, and publish a record conforming to [`readiness-oracle-record.schema.json`](./readiness-oracle-record.schema.json). The record's `status` is one of `implemented`, `planned`, or `blocked`; its `readiness` is one of `unavailable`, `admission_only`, or `enforced`.

1. Validate raw arguments and reject unknown/unsafe shapes.
2. Apply ordinary transformations.
3. Revalidate, canonicalize, and freeze the final arguments.
4. Invoke the reserved, non-overridable Studio security slot.
5. Have the broker evaluate current policy and issue a ticket bound to final digest, principal, operation, resource identity, cwd/root, policy version, expiry/use count, and broker epoch.
6. Verify that ticket in Prime’s final host hook immediately before dispatch. No extension-supplied principal/cwd/resource/digest is trusted.
7. Atomically consume the one-shot ticket in the independent executor while changing `LEASED → STARTED`.
8. Emit distinct requested, blocked, started, completed, failed, cancelled, or outcome-unknown records. A blocked request is not running or failed.

If secure transport, self-test, attestation, epoch match, or final-ticket verification fails, deny. Never fall back silently to the user’s full token or to an unbrokered path.

## Identity rules by effect

- **Filesystem:** opened-handle volume serial/file ID, canonical final path, link count, root membership, and expected preimage; revalidate immediately before commit. Hardlink/multiple-link alias sets require explicit grant.
- **Content-addressed blobs:** digest is integrity metadata, not bearer authority. Reads require an opaque database reference or short-lived capability bound to principal/project/chat/source/operation/epoch.
- **Browser:** canonical scheme/host/port plus origin, redirect, frame, popup, DNS/rebinding, and target-replacement checks.
- **Windows app:** AUMID/package or canonical executable plus signer/hash and PID creation identity; title, bare name, PID, or HWND alone is insufficient.
- **Scheduler:** unique `(schedule, task revision, scheduled instant)` occurrence plus fencing epoch; at-most-once dispatch is the guarantee, not exactly-once external effects.

## Explicitly unsupported

Secure desktop, UAC elevation, lock/logon screens, higher-integrity applications, arbitrary post-crash actions with unknown outcome, unbrokered MCP/custom native tools, third-party in-process extensions, and full-trust code are not contained-mode capabilities. Full-trust developer behavior must be visibly named `Unrestricted`.

## Current evidence boundary

The account-removal code proves a narrow Windows transaction using the same identity-oriented ideas: `app/src-tauri/src/accounts/delete.rs:27-46,216-260` and the 25/27-test transaction groups. That evidence supports the account row only. It does not attest an AppContainer, Job Object, restricted-token worker, brokered network, browser, Chrome, UI Automation, artifact, or scheduler executor.

The account-removal transaction is the explicit enforced exception to the general read/export-only posture. The current `export_html` transcript path is not a lossless backup/source-closure export; that future path is `planned`/`blocked`.
