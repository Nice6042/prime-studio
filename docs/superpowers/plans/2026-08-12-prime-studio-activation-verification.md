# Prime Studio Activation and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete app against a fake daemon, activate one verified Prime Harness profile, migrate/remove stale integration paths, and close security, performance, documentation, and release gates.

**Architecture:** Activation is a trusted native state transition from a verified runtime manifest and compatibility profile to an authority receipt. All runtime commands pass through the broker/sidecar. The fake-daemon E2E is mandatory before any real profile activation.

**Tech Stack:** Rust/Tauri, Node sidecar, fake daemon fixtures, React/Playwright, Cargo/CI/repository policy.

## Global Constraints

- Never test activation against the user's normal OS profile, credentials, sessions, or workspace.
- A compatibility result is not authority; only a verified activation receipt can promote exact effect classes.
- Do not restore legacy raw RPC on failure. Degrade the adapter profile instead.
- No public release/signing/update claim is created by source completion.
- Every real-runtime probe is credential-free and ignored by default unless explicitly authorized.

---

### Task ACT-01: Build deterministic fake daemon and full-stack Tauri E2E

**Files:**
- Create: `app/harness-sidecar/test/fixtures/fake-daemon/scenario-manifest.json`
- Create: `app/harness-sidecar/test/fixtures/fake-daemon/daemon-v7-schema13.jsonl`
- Create: `app/src-tauri/tests/support/fake_harness_daemon.rs`
- Create: `app/src-tauri/tests/harness_end_to_end.rs`
- Create: `app/e2e/fixtures/harness-scenarios.ts`
- Modify: `app/e2e/support/browser-shell.ts`
- Modify: `app/src-tauri/Cargo.toml`

**Interfaces:**
- Fake daemon implements hello, model catalog, create resident, attach snapshot/replay, prompt stream, steer/follow-up/abort, compact, fork, child lifecycle, queue, tools, resources, usage, activity, extension UI, disconnect, generation restart, and shutdown.

```ts
export interface FakeDaemonScenario {
  name: string;
  initial: RootSessionSnapshot;
  onCommand(command: DaemonCommand): readonly DaemonOutbound[];
}
```

- [ ] **Step 1: Write protocol scenario assertions first**

Create deterministic scripts for happy parent turn, concurrent child, child failure/retry, overload, compaction, extension prompt, reconnect complete/partial/unavailable, stale generation, malformed/oversized frames, and unknown capability.

- [ ] **Step 2: Run RED**

Expected: fake daemon/E2E missing.

- [ ] **Step 3: Implement fake daemon**

Use a synthetic temp root, fixed clocks/IDs, no network, no provider package, and no real workspace. Assert every received command's identity, expected cursor, and capability.

- [ ] **Step 4: Implement full Rust integration**

Launch Rust broker + real sidecar + fake daemon. Validate discovery, compatibility, snapshot/event projections, command responses, restart/recovery, and shutdown.

- [ ] **Step 5: Add renderer fixture parity**

The browser fixture reuses the same serialized SHP scenario corpus so unit/browser/native expectations cannot drift.

- [ ] **Step 6: Run gate and commit**

```powershell
cd app
npx tsc -p harness-sidecar/tsconfig.json
node --test harness-sidecar/dist/test/*.test.js
cargo test --manifest-path src-tauri/Cargo.toml --locked --test harness_end_to_end --features test-support-bin
npm run test:browser-shell:strict
git diff --check
git add harness-sidecar/test src-tauri/tests e2e src-tauri/Cargo.toml
git commit -m "test: exercise studio through fake harness daemon"
```

### Task ACT-02: Implement verified activation for one runtime profile

**Files:**
- Create: `app/src-tauri/src/harness/activation.rs`
- Create: `app/src-tauri/tests/harness_activation.rs`
- Modify: `app/src-tauri/src/runtime_manifest.rs`
- Modify: `app/src-tauri/src/authority.rs`
- Modify: `app/src-tauri/src/harness/compatibility.rs`
- Modify: `app/src-tauri/src/harness/broker.rs`
- Modify: `app/src-tauri/src/commands/harness.rs`
- Modify: `app/harness-sidecar/src/profiles/daemon-v7-schema13.ts`
- Modify: `docs/runtime-compatibility-manifest.md`
- Modify: `app/src/providerProduct.ts` or compatibility UI projection

**Interfaces:**
- `verify_harness_activation(runtime, profile, now) -> VerifiedHarnessActivation` is private/native.
- Receipt binds runtime file identities/hashes, Node identity, protocol/schema/capabilities, sidecar hash, account/project scope policy, and expiry/epoch.
- `AuthorityGate::from_verified_activation(receipt)` promotes only exact required effect classes.

```rust
fn verify_harness_activation(
    runtime: VerifiedRuntimeClosure,
    profile: &'static CompatibilityProfile,
    clock: &dyn TrustedClock,
) -> Result<VerifiedHarnessActivation, ActivationError>;
```

- [ ] **Step 1: Write activation RED matrix**

Reject missing/changed/hash-swapped file, wrong Node, protocol/schema/capability mismatch, stale receipt, clock rollback, runtime replacement after verification, sidecar mismatch, different account/project, daemon generation mismatch, forged renderer readiness, and unsupported profile.

- [ ] **Step 2: Run RED**

Expected: activation verifier absent.

- [ ] **Step 3: Extend runtime manifest**

Verify the realistic required artifact closure in indexed O(n), bounded bytes/time/handles, no reparses/links, and exact root identity before and after hashing. Do not retain 16,384 handles or use quadratic lookup.

- [ ] **Step 4: Mint private activation receipt**

The receipt type cannot deserialize from Tauri input and has no public constructor. Bind security epoch and compatibility profile. Revalidate at every broker start and on runtime identity change.

- [ ] **Step 5: Register live commands**

Add typed `harness_create_session`, `harness_attach_session`, `harness_detach_session`, `harness_stop_session`, `harness_send_command`, `harness_page`, and extension UI response. Classify each exact effect; safety stop/detach remains available for owned known sessions.

- [ ] **Step 6: Create resident session semantics**

Use `lifecycle: "resident"`; bind account agentDir canonically; map project/chat/session/generation; use command envelopes and idempotency IDs; reconcile uncertain create/send outcomes before allowing retry.

- [ ] **Step 7: Add credential-free installed-runtime ignored test**

Discover hello/capabilities and compare recorded identities only. It must not create a session, read AuthStorage values, list personal sessions, or contact a provider.

- [ ] **Step 8: Run fake and activation suites; request independent security review**

Do not proceed while any P0/P1/P2 activation finding remains.

- [ ] **Step 9: Commit**

```powershell
git add app/src-tauri/src/harness app/src-tauri/src/runtime_manifest.rs app/src-tauri/src/authority.rs app/src-tauri/tests/harness_activation.rs app/harness-sidecar/src/profiles docs/runtime-compatibility-manifest.md app/src
git commit -m "security: activate verified prime harness profile"
```

### Task ACT-03: Migrate live UI commands and remove stale raw RPC architecture

**Files:**
- Modify: `app/src/shared/ipc/client.ts`
- Modify: `app/src/entities/sessions/sessionStore.ts`
- Modify: `app/src/entities/messages/parentTranscriptReducer.ts`
- Modify: `app/src/useSession.ts`
- Modify: `app/src/rpc.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/src/types.ts`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/authority.rs`
- Modify: `app/src-tauri/src/session_process.rs` (retain bounded process primitives; remove legacy ownership API after broker parity)
- Test: `app/src/app/liveMigration.test.tsx`
- Test: `app/src-tauri/tests/harness_migration.rs`

**Interfaces:**
- All session actions use typed Harness client methods.
- Legacy disk/account/provider APIs remain only where their hardened native domain still owns the truth.
- `send_rpc` and renderer-extensible `RpcCommand { type: string }` are removed from production.

```ts
export interface HarnessSessionClient {
  create(request: CreateRootSessionRequest): Promise<RootSessionProjection>;
  attach(request: AttachRootSessionRequest): Promise<RootSessionProjection>;
  send(request: RootSessionCommand): Promise<CommandAdmission>;
  page(request: SessionPageRequest): Promise<SessionPage>;
  detach(request: OwnedSessionRequest): Promise<void>;
  stop(request: OwnedSessionRequest): Promise<void>;
}
```

- [ ] **Step 1: Write parity and forbidden-path tests**

For create, attach, detach, stop, prompt, steer, follow-up, abort, model, thinking, compact, fork, history paging, stats, child, and extension response, prove new path behavior. Assert no production import/call of legacy `sendRpc`, no open command union, and no direct process spawn.

- [ ] **Step 2: Run RED**

Expected: current code still uses raw RPC/session process.

- [ ] **Step 3: Migrate `useSession` consumers to stores/services**

Remove one-hook-one-process ownership. Chat tabs bind to broker root-session IDs; closing detaches presentation while explicit Stop ends the resident agent.

- [ ] **Step 4: Remove stale daemon detection**

Delete `--background`/legacy `-d` assumptions and update CLI status to compatibility projection. Do not keep a fallback that reintroduces unverified execution.

- [ ] **Step 5: Remove open RPC unions and handlers**

Replace `{ type: string; [k:string]: unknown }` with generated command unions. Remove the
legacy `start_session`, `attach_session`, `send_rpc`, process-listener, and renderer session-key
handlers from `lib.rs`; retain reusable bounded child-process primitives in
`session_process.rs`. Retain safety controls through typed broker-owned known-session commands.

- [ ] **Step 6: Run full parity and forbidden marker scans**

```powershell
rg -n "send_rpc|--background|\[-d\]|type: string; \[k: string\]" app/src app/src-tauri/src
```

Expected: only historical migration docs/tests explicitly allowing the terms; no production path.

- [ ] **Step 7: Commit**

```powershell
git add -A app/src app/src-tauri/src app/src-tauri/tests
git commit -m "refactor: route sessions through verified harness broker"
```

### Task ACT-04: Migrate durable state and prove rollback/recovery

**Files:**
- Create: `app/src-tauri/src/storage/migrations.rs`
- Create: `app/src-tauri/tests/studio_state_migration.rs`
- Modify: `app/src-tauri/src/project_catalog.rs`
- Modify: `app/src-tauri/src/harness/recovery.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/app/StudioApp.tsx`

**Interfaces:**
- Migrates current settings/project-chat/session bindings to versioned Studio schema.
- Leaves Prime-owned session files untouched.
- Creates pre-migration backup and atomic post-migration state with recovery marker.

```rust
pub fn migrate_studio_state(
    source: PersistedStudioState,
    target_version: u32,
) -> Result<MigrationOutput, MigrationError>;
```

- [ ] **Step 1: Write migration fixtures**

Current valid state, empty state, maximum bounded state, duplicate/unknown keys, corrupt/truncated files, interrupted pre/post replace, downgrade attempt, missing session, account removed, and old localStorage layout import.

- [ ] **Step 2: Run RED**

Expected: migration module absent.

- [ ] **Step 3: Implement ordered idempotent migrations**

Each step accepts one source version and emits one target. Duplicate fields are rejected. Backups are bounded and named by schema transition, not user data. A failed migration keeps old state and starts in read-only recovery.

- [ ] **Step 4: Implement reconciliation**

Reconcile catalog session bindings against broker/discovered sessions without deleting unknown Prime files. Missing live session becomes archived/disconnected truth.

- [ ] **Step 5: Prove rollback**

A binary built for the prior Studio schema can ignore or restore from the retained backup according to documented policy; no new runtime authority persists in renderer storage.

- [ ] **Step 6: Run tests and commit**

```powershell
git add app/src-tauri/src/storage app/src-tauri/tests/studio_state_migration.rs app/src-tauri/src/project_catalog.rs app/src-tauri/src/harness/recovery.rs app/src-tauri/src/lib.rs app/src/app/StudioApp.tsx
git commit -m "feat: migrate durable studio workspace state"
```

### Task ACT-05: Complete accessibility, performance, security, and native verification

**Files:**
- Create: `app/e2e/prime-studio-complete.spec.ts`
- Create: `app/src-tauri/tests/harness_resource_bounds.rs`
- Create: `app/scripts/check-harness-boundaries.mjs`
- Modify: `app/e2e/support/browser-shell.ts`
- Modify: `app/e2e/axe-baseline.json`
- Modify: `app/scripts/measure-bundle.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/security.yml`

**Interfaces:**
- Final fixture story crosses every feature without real credentials.
- CI runs contract, sidecar, frontend, browser, Rust, dependency, privacy, and provenance gates.

```js
const forbiddenProductionPatterns = [
  { pattern: /invoke\(["']send_rpc/, scope: "app/src" },
  { pattern: /from ["']prime-agent["']/, scope: "app/src", allow: ["app/harness-sidecar/src"] },
  { pattern: /type:\s*string;\s*\[k:\s*string\]/, scope: "app/src" },
];
```

- [ ] **Step 1: Add the complete browser story**

Create project/chat, stream parent, queue/steer, open child tabs, current-chat usage, activity/file/editor, Canvas, palette, settings/account usage, theme, resize, narrow sheets, reconnect/degraded, and contextual extension prompt.

- [ ] **Step 2: Add resource stress tests**

Maximum chats/children/activity/tool rows; 50k/32 MiB archive paging; 4 MiB frames; snapshot chunk boundaries; event flood; sidecar crash loop; 100 sessions thread/handle count; startup/recovery deadlines; overlapping refresh prevention.

- [ ] **Step 3: Add security boundary checker**

Reject raw invoke outside generated client, direct Harness import outside sidecar, broad process APIs, unsafe open command unions, credential-shaped DTO keys, unbounded JSON/file reads, and unpinned action refs.

- [ ] **Step 4: Run actual bundle/startup capture**

Ensure editor/Markdown/settings/account charts remain lazy and startup asset closure is within documented budget. Fail on unknown/missing/redirected assets and secret-bearing URLs.

- [ ] **Step 5: Run native disposable-profile smoke**

Create a fresh synthetic profile and workspace, point to fake daemon/profile, launch Tauri, exercise one complete session, capture native screenshots, stop exact PIDs, compare filesystem before/after, and preserve evidence outside the source tree.

- [ ] **Step 6: Perform final Impeccable and independent reviews**

One batched desktop/narrow screenshot round, one fix batch, one confirmation, detector once, finish review/verdict, React best-practices review, security review, and compatibility review.

- [ ] **Step 7: Commit**

```powershell
git add app/e2e app/src-tauri/tests/harness_resource_bounds.rs app/scripts .github
git commit -m "test: close prime studio product verification"
```

### Task ACT-06: Update public documentation, privacy, SBOM, and release truth

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Replace stale runtime content: `PROTOCOL.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `TESTING.md`
- Modify: `ACCOUNTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/runtime-compatibility-manifest.md`
- Modify: `docs/open-source-release-readiness.md`
- Modify: `docs/open-source-release-readiness.manifest.json`
- Regenerate: `THIRD_PARTY_NOTICES.md`
- Regenerate: `app/public/THIRD_PARTY_NOTICES.md`
- Regenerate: `sbom/prime-studio-windows-x86_64.spdx.json`
- Test: root policy/privacy/provenance suites

**Interfaces:**
- Documentation distinguishes source completeness, verified local activation, and release eligibility.
- Protocol document describes SHP and supported Harness profile, not obsolete `-d/--background` assumptions.

- [ ] **Step 1: Write documentation assertions**

Add tests requiring exact current protocol/profile identifiers, separately installed Harness statement, current-chat/account-wide scope distinction, no generic approvals claim, no raw RPC instructions, and no release claim.

- [ ] **Step 2: Run RED**

Expected: stale docs fail.

- [ ] **Step 3: Rewrite docs from verified code**

Document boot/compatibility, authority, sidecar, state locations, credential handling, supported/unsupported features, migration/recovery, test boundaries, and how to add a profile.

- [ ] **Step 4: Regenerate notices/SBOM**

Run the locked generator after all package/Cargo changes; verify root/public copies and official SPDX schema.

- [ ] **Step 5: Run complete final gate**

```powershell
node --test tests/*.mjs
cd app
npm ci
npm test -- --maxWorkers=1 --no-file-parallelism
npm run check
npm run build
npm run test:bundle
npm run test:browser-shell:strict
npm run check:dependencies
cargo fmt --manifest-path .\src-tauri\Cargo.toml --all -- --check
cargo check --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
cargo clippy --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin -- -D warnings
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
cd ..
node scripts/generate-third-party-artifacts.mjs --check
git diff --check
git status --short
```

Expected: all pass; release policy may still truthfully block signed binary distribution.

- [ ] **Step 6: Commit**

```powershell
git add README.md ARCHITECTURE.md PROTOCOL.md PRIVACY.md SECURITY.md TESTING.md ACCOUNTS.md CHANGELOG.md docs THIRD_PARTY_NOTICES.md app/public/THIRD_PARTY_NOTICES.md sbom
git commit -m "docs: document verified prime studio architecture"
```

### Task ACT-07: Final program self-review and handoff

**Files:**
- Modify only files required by concrete review findings.
- Create: `docs/superpowers/reviews/2026-08-12-prime-studio-final-review.md`

**Interfaces:**
- Produces an evidence-bound verdict for exact final commit.

- [ ] **Step 1: Review spec traceability**

Check every feature ID in the design specification against a shipped component, contract, unavailable state, and test. Record exact file/test anchors.

- [ ] **Step 2: Review architecture invariants**

Confirm no renderer credentials/runtime imports, no raw RPC, exact compatibility profiles, sidecar containment, chronology, parent/child isolation, accounting scope, migration, and rollback.

- [ ] **Step 3: Review product behavior**

Run the full fixture story and native fake-daemon story side by side at supported viewports; compare all reference areas without copying proprietary assets.

- [ ] **Step 4: Review evidence**

Re-run only fresh exact-commit gates; do not reuse earlier milestone evidence. Ensure clean status and no generated untracked outputs.

- [ ] **Step 5: Write final verdict**

The review file states exact commit/tree, commands/results, feature coverage, known unsupported capabilities, and `PASS` only if no P0/P1/P2 remains. Otherwise state `CHANGES_REQUIRED` and keep activation/release blocked.

- [ ] **Step 6: Commit review**

```powershell
git add docs/superpowers/reviews/2026-08-12-prime-studio-final-review.md
git commit -m "docs: record prime studio final verification"
```
