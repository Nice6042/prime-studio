# Production Harness Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the real Harness inspector adapter and create recoverable resident Prime sessions whose daemon identities are admitted natively and bound to distinct Studio catalog identities.

**Architecture:** The renderer adapter resolves operations only through authoritative session projections and immutable catalog bindings. A single native command owns resident creation, fresh attach, snapshot validation, dynamic broker admission, and catalog CAS binding; the renderer never manufactures daemon IDs. Existing sidecar chronology, compatibility, and fail-closed outcomes remain authoritative.

**Tech Stack:** React 19, TypeScript, Tauri 2, Rust, Studio Harness Protocol v1, Prime daemon protocol v7/schema 13.

## Global Constraints

- Base exact integration commit `fdd90002f7edd14ec0ce2b3a4629292dec4a6214`.
- Studio project/chat IDs and Prime active/session IDs remain separate identities.
- No credential values, mutable installed runtime imports, raw renderer filesystem authority, or provider calls in tests.
- Runtime mutations require authoritative generation/cursor and explicit accepted/queued/updated/cancelled/unavailable/rejected/unknown-outcome results.
- Unsupported upstream behavior never simulates success.

---

### Task 1: Production inspector adapter

**Files:**
- Create: `app/src/features/harness/productionAdapter.ts`
- Create: `app/src/features/harness/productionAdapter.test.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/src/App.test.tsx`

**Interfaces:**
- Consumes: `StudioStore`, `loadHarnessInspector(sessionId)`, `executeHarnessStudioOperation(request)`.
- Produces: `createProductionHarnessInspectorAdapter(store): HarnessInspectorAdapter`.

- [ ] Write failing tests proving load uses the root daemon session ID, chat payloads resolve only through immutable catalog bindings, ambiguous/mismatched identities reject, and a successful operation publishes its returned session projection.
- [ ] Run `npx vitest run src/features/harness/productionAdapter.test.ts src/App.test.tsx` and confirm failure because the factory/mount does not exist.
- [ ] Implement the adapter and mount one stable instance from `App.tsx`.
- [ ] Run the focused tests and production TypeScript build.
- [ ] Commit the adapter slice.

### Task 2: Resident create protocol and authoritative broker admission

**Files:**
- Modify: `app/scripts/generate-harness-contract.mjs`
- Modify: generated SHP TypeScript/Rust files
- Modify: `app/harness-sidecar/src/fakeDaemonScenario.ts`
- Modify: `app/harness-sidecar/src/index.ts`
- Modify: `app/harness-sidecar/src/primeDaemonBridge.ts`
- Modify: `app/src-tauri/src/harness/broker.rs`
- Modify: sidecar and broker tests

**Interfaces:**
- Consumes: closed request `{type:"create_resident", creationId, name, cwd}`.
- Produces: `{type:"resident_created", creationId, snapshot}` and `HarnessBroker::create_resident` which admits ownership only after validating a fresh authoritative snapshot.

- [ ] Write failing sidecar and broker tests for exact request closure, idempotent creation ID replay, cwd-derived daemon project identity, account `null`, and rejection of substituted snapshots.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the minimal closed protocol, sidecar recovery lookup/create/attach, and dynamic broker ownership admission.
- [ ] Run contract generation checks, sidecar tests, and broker tests.
- [ ] Commit the protocol/admission slice.

### Task 3: Native create-to-catalog binding transaction

**Files:**
- Create: `app/src-tauri/src/harness/composition.rs`
- Modify: `app/src-tauri/src/commands/harness.rs`
- Modify: `app/src-tauri/src/app_state.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/project_catalog.rs`
- Create/modify: native composition and catalog tests
- Modify: `app/src/shared/ipc/client.ts` and tests

**Interfaces:**
- Consumes: `{creationId, expectedCatalogRevision, studioProjectId, studioChatId, name}`.
- Produces: `{catalog, session}` where catalog binding contains daemon active/session identities and session is the admitted projection.

- [ ] Write failing native tests for create→attach→bind, revision conflicts, retry of the same creation ID, persistence-unknown reconciliation, duplicate daemon binding rejection, and catalog-ID substitution.
- [ ] Run focused tests and confirm failures.
- [ ] Implement one native transaction coordinator with a bounded creation ledger/tombstones and catalog reload reconciliation.
- [ ] Add the strict renderer client and route new-chat through it; on failure leave the chat unbound and visibly unavailable.
- [ ] Run native and renderer focused tests.
- [ ] Commit the transaction slice.

### Task 4: Verification and security review

**Files:**
- Modify only defects found by verification/review.

- [ ] Run sidecar, Harness Rust, catalog Rust, adapter/IPC/UI tests, TypeScript build, contract/boundary checks, `cargo fmt --check`, and `git diff --check`.
- [ ] Request independent review for identity separation, unknown-outcome recovery, replay, chronology, and renderer authority.
- [ ] Fix every Critical/Important finding with a failing regression test first.
- [ ] Rerun the full focused gate and record clean SHA order.

