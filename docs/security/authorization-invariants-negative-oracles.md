# Prime Studio authorization invariants and negative oracles

**Scope:** current public source tree; no historical commit identity grants authority
**Purpose:** make security claims falsifiable. Each invariant requires a test that observes the real effect boundary, not only a UI state or the absence of a marker file.

## Status contract

- `implemented`: evidence exists for the named account-removal path.
- `planned`: the invariant is required for the general broker/executor architecture but its implementation or independent test is absent.
- `blocked`: the corresponding effect must not be enabled until the invariant and its oracle pass for that effect class.

## Machine-readable readiness/oracle record

Every readiness or negative-oracle result must pass the portable Draft 2020-12 shape in [`readiness-oracle-record.schema.json`](./readiness-oracle-record.schema.json) and the normative cross-field checks in [`validate-readiness-oracle-records.py`](./validate-readiness-oracle-records.py). The root record carries stable `effectId`, `oracleId`, and `fixtureId` values; structured `expectedEffect` and `observedEffect`; `sourceIdentity` and `closureIdentity`; policy/broker/session/worker `epochs` plus their observed epoch evidence; a terminal state; and an explicit `environmentBoundaryOracle`. A record marked `implemented` or `enforced` additionally requires a Windows build/OS identity, `testId`, real 64-hex SHA-256 source/artifact digests, known nonempty epochs, complete observed effects, and an observed independent boundary. Its expected and observed effect IDs, operations, and targets must match the root effect; each root epoch must match its evidence, with broker and worker epochs also bound to the modeled broker and executor closure epochs. `enforced` is limited to `implemented` records whose expected/observed results and terminal state are `completed`; blocked, unknown, mismatched, or outcome-uncertain evidence cannot be promoted.

The environment-boundary oracle must name a stable boundary, a positive-control ID, and an observer with its own source and artifact-closure identities. The validator rejects an observer that reuses the subject source location/digest or the Studio component/artifact digest. A UI state, self-authored marker, or missing toast is not an independent oracle. Draft 2020-12 cannot portably compare sibling instance values, so a raw schema-only pass is insufficient for an `implemented` or `enforced` claim. Install the pinned validator dependency with `python -m pip install -r docs/security/readiness-validation.requirements.txt`, then run `python docs/security/validate-readiness-oracle-records.py`; the command validates the positive record and proves every negative mutation is rejected through the same authoritative path.

## Authorization invariants

| ID | Invariant | Required proof | Current status |
|---|---|---|---|
| `AUTH-01` | **Deny-before-effect.** A denied or unavailable request produces no executor effect, no network request, no file/registry mutation, no clipboard change, and no desktop action. | Independent positive control demonstrates the oracle can observe the effect; denied run leaves it unchanged. | **planned; blocked** for general effects; account-deletion blockers are **implemented**. |
| `AUTH-02` | **Final arguments are authoritative.** Authorization binds the post-transform, canonicalized, frozen digest; raw/model/extension arguments cannot alter target, cwd, resource, or principal after the decision. | Mutate arguments between UI approval and dispatch; final-host/broker digest mismatch denies. | **planned; blocked**. |
| `AUTH-03` | **Least-authority intersection.** Child agent authority is the intersection of parent scope, child scope, current policy, resource grant, and current broker epoch; a child cannot widen its parent. | Attempt wider path/domain/app/account and assert denial with no side effect. | **planned; blocked**. |
| `AUTH-04` | **One-shot lease.** A lease is bound to principal, operation, resource identity, cwd/root, final digest, policy version, expiry/use count, session/broker epoch; replay or second use fails. | Reuse the same ticket after success, expiry, restart, policy change, or epoch change. | **planned; blocked**. Account-removal plans have the analogous single-use property and are **implemented**. |
| `AUTH-05` | **Revocation/takeover is visible and bounded.** Revocation invalidates every unconsumed old-generation lease; an already running indivisible primitive stops at its tested boundary; non-acknowledging workers are terminated and remain `revocation-pending`/`takeover-pending` until confirmed. | Revoke/take over at each worker boundary; observe no later primitive and correct terminal state. | **planned; blocked**. |
| `AUTH-06` | **Identity is not a string.** Filesystem grants use handle identity/root/preimage/link state; blobs use opaque capabilities, not digests; browser grants use canonical origins; desktop grants use package/signer/hash/PID creation identity. | Reparse, symlink, hardlink, UNC/device/ADS, redirect, DNS rebinding, target replacement, and same-title app substitutions all deny. | **implemented** for account deletion; **planned; blocked** for other classes. |
| `AUTH-07` | **No implicit egress.** Local read, attachment, tool result, memory, or provider switch is not permission to send data to another account/provider/connector. | Attempt cross-provider delegation and inspect the outbound request/category record. | **planned; blocked**. |
| `AUTH-08` | **Secrets do not cross the Studio data plane.** Credential values, passwords, cookies, OTPs, payment values, and secret clipboard content never enter model context, Studio DB, memory, logs, diagnostics, or default export. | Seed canary secrets in auth/profile/browser/clipboard sources and inspect every boundary with secret-aware assertions. | **planned; blocked**; the current account types intentionally expose presence/expiry only. |
| `AUTH-09` | **Readiness fails closed.** `unavailable` and `admission_only` cannot dispatch; missing/unknown/mismatched runtime, security extension, broker, executor, or epoch forces read/export-only. | Start with each missing/mismatched component and assert no effectful process/worker starts. | **planned; blocked**. |
| `AUTH-10` | **Replay is not action.** Replayed extension UI, approval, tool-start, delta, or stale scheduled records never become newly actionable without a current snapshot proving the same pending transaction and matching epochs. | Replay each record after restart/session switch/epoch change; assert tombstone/cancel/read-only. | **planned; blocked**. |
| `AUTH-11` | **Outcome-unknown is not success or automatic retry.** A crash after dispatch and before result preserves the uncertain attempt; non-idempotent actions are never replayed automatically. | Kill at every dispatch boundary and compare external positive-control state plus durable attempt state. | **implemented** for account deletion recovery; **planned; blocked** elsewhere. |
| `AUTH-12` | **Update trust is transitive.** An update can activate only the signed, compatible closure understood by the installed updater; old/replayed/downgraded manifests and hostile archives fail closed. | Verify wrong channel, old sequence, revoked key, closure mismatch, traversal/reparse/hardlink archive, interrupted migration, and rollback. | **planned; blocked**. |

## Independent negative-oracle suite

Every effect class needs a side-effect oracle separate from the component under test. A failed assertion such as “no success toast” or “marker file absent” is not enough.

| Effect class | Positive control | Denied/adversarial attempt | Pass condition |
|---|---|---|---|
| Filesystem read/write/delete | Create a fixture file/tree and record bytes, file IDs, link counts, ACLs, and an independent watcher result | Outside-root path, reparse/reparse ancestor, hardlink alias, path race, changed preimage, stale ticket | Allowed control changes only its granted identity; denied attempt leaves bytes, identity, and outside fixture unchanged. |
| Registry/account deletion | Fixture `accounts.json`, profile tree, canaries, and independent generation/identity snapshots | Replayed plan, active session, shared/default profile, registry race, quarantine substitution, cleanup substitution, crash at every durable transition | Only the intended account transaction reaches its stated terminal state; canaries and unrelated profile stay unchanged; ambiguous state is never success. **implemented** for baseline account deletion. |
| Process/shell/Python | Fixture child creates a process/file/registry/network signal and reports its own PID/exit | Denied command/cell; full-token escape; Job Object/self-test/transport failure | Positive control proves oracle visibility; denied run creates no process/effect and worker teardown is observed. |
| Network/connector | Local test server records connection, destination, request body/category, and secret canary | Unapproved host, redirect/DNS rebinding, cross-provider grant, telemetry-on worker in local-only mode | No connection or bytes leave to denied destination; allowed body matches category grant and provenance. |
| Browser | Local deterministic site records navigation/click/form/download; separate profile watcher records cookies/files | Prompt injection, redirect/popup/frame change, unapproved origin, download auto-open, takeover | Only approved origin/action occurs; target/state change invalidates grant; secret fields do not enter durable Studio activity. |
| Windows computer use | Signed fixture app exposes stable AUMID/identity and writes an independent action log | Same-title/wrong-signer app, minimized/closed/obscured target, UAC/secure desktop/higher-integrity target, takeover | Wrong target is denied; allowed action is visible in fixture log; takeover reaches a tested boundary or kills the Job Object. |
| Scheduler | Fixture occurrence writes one independent event keyed by schedule/revision/instant | Duplicate wake, DST fold/gap, restart after claim, stale leader epoch, missing approval | At most one dispatch; blocked occurrence ends `blocked-before-action`; approval starts a new correlated run and never replays the prior effect. |
| Artifacts/renderers | Benign fixture renders to a staged output with digest | Malformed/hostile archive, active content, macro/external relationship, decompression bomb, renderer crash/hang | Renderer is isolated and resource-bounded; no host/network/project effect; apply requires current base and approval. |
| Runtime/update | Known signed fixture closure and independent hash checker | Wrong channel, replay/downgrade, revoked key, closure mismatch, archive traversal/reparse/hardlink, crash during migration | Only exact closure activates; failed activation remains quarantined or enters recovery without overwriting newer data. |

## Evidence requirements

- Each oracle record uses the schema's stable effect/oracle/fixture IDs and records fixture revision, OS/build, runtime/worker closure, test ID, grant/policy/broker epochs, expected effect, observed effect, terminal state, and an independent environment-boundary oracle.
- Positive controls and denial cases run in separate fixtures or reset the fixture to a verified baseline; the system under test must not author the only oracle.
- A capability cannot move from `planned`/`blocked` to `implemented` because a UI test passed. The packaged Windows executable, exact runtime closure, and external driver must be used for release claims.
- Any skipped oracle is an explicit limitation and blocks the corresponding effect class. The account-deletion Rust tests do not satisfy shell/network/browser/computer/update or general project-write containment.

## References

- `docs/security/readiness-oracle-record.schema.json` defines the portable machine-readable record shape; it does not grant authority or claim cross-field equality that Draft 2020-12 cannot express.
- `docs/security/validate-readiness-oracle-records.py` is the authoritative record and fixture validator for schema plus semantic equality/independence checks.
- `docs/security/readiness-oracle-record.fixtures.json` contains one synthetic implemented/enforced positive fixture and fourteen mechanical negative fixtures, including the six epoch, observer, effect-identity, and case-insensitive-placeholder regressions.
- `PROTOCOL.md:188-207` for the blocked-tool event nuance.
- `app/src-tauri/src/accounts/delete.rs` and `app/src-tauri/tests/account_delete_transaction_windows.rs` for the implemented account-removal oracle family.
- Fresh baseline evidence: 50 frontend tests, reducer check, and 71 Rust tests passed; no broker/contained executor/negative-oracle suite is present in this branch.
