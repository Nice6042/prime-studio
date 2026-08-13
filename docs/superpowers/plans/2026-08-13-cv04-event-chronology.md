# CV-04 Event Chronology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project first-output latency and parent-turn output throughput only when the reviewed daemon's admitted event chronology proves both measurements.

**Architecture:** A bounded sidecar recorder consumes the reviewed adapter's already ordered and stale-filtered root session events using an injected monotonic clock. It publishes either exact completed-turn measurements or an explicit unavailable reason inside the next atomic root snapshot, whose session and cursor bind the evidence end to end through generated IPC, Rust validation, the renderer store, and the status bar.

**Tech Stack:** TypeScript, Node 22, JSON Schema plus deterministic generators, Rust/Tauri, React/Vitest.

## Global Constraints

- Do not use wall-clock time or message timestamps to calculate performance.
- Never admit child-session events, incomplete turns, unknown event shapes, duplicate message usage, reconnect-spanning chronology, or generation-spanning chronology.
- Bound state to one active turn and at most 256 distinct assistant message identities.
- Preserve package acceptance truth unchanged.

---

### Task 1: Closed performance projection

**Files:**
- Modify: `app/contracts/harness-v1.schema.json`
- Modify: `app/scripts/generate-harness-contract.mjs`
- Modify: `app/scripts/generate-harness-contract.node.mjs`
- Generated: `app/src/shared/ipc/harness.generated.ts`
- Generated: `app/src-tauri/src/harness/generated.rs`

**Interfaces:**
- Produces: `TurnPerformanceProjection`, a required `performance` member of every `RootSessionSnapshot`.

- [ ] Write RED generator assertions for the closed available/unavailable union and required root field.
- [ ] Run the generator tests and confirm the missing projection failure.
- [ ] Add the schema and templates, regenerate both bindings, and rerun generator/contract checks GREEN.

### Task 2: Monotonic root-event recorder

**Files:**
- Modify: `app/harness-sidecar/src/primeDaemonBridge.ts`
- Modify: `app/harness-sidecar/src/fakeDaemonScenario.ts`
- Modify: `app/harness-sidecar/test/primeDaemonBridge.test.ts`
- Modify: bounded scenario fixtures containing root snapshots.

**Interfaces:**
- Consumes: reviewed-adapter `subscribe(listener)` events and an injected `monotonicNow(): number` port.
- Produces: snapshot `performance` bound to the snapshot's session and exact generation/sequence.

- [ ] Write RED tests for exact parent chronology, incomplete/unknown/duplicate/clock-regressing events, generation replacement, and child isolation.
- [ ] Run focused sidecar tests and confirm failures are caused by the absent recorder.
- [ ] Implement the bounded recorder and explicit reasons, then update fake scenarios to explicit unavailable.
- [ ] Run focused and complete sidecar suites GREEN.

### Task 3: Native and renderer admission

**Files:**
- Modify: `app/src-tauri/src/harness/sidecar.rs`
- Modify: native tests beside validation.
- Modify: `app/src/shared/ipc/client.ts`
- Modify: `app/src/shared/ipc/client.test.ts`
- Modify: `app/src/features/shell/RuntimeStatusBar.tsx`
- Modify: `app/src/features/shell/RuntimeStatusBar.test.tsx`
- Modify: `app/src/app/StudioApp.tsx`
- Modify: `app/src/app/StudioApp.test.tsx`

**Interfaces:**
- Consumes: exact root snapshot performance projection.
- Produces: session-scoped status text; available values only for an exact cursor, otherwise a focusable explicit-unavailable explanation.

- [ ] Write RED hostile decoder/native validation tests and production-mount UI tests.
- [ ] Run each focused test and confirm the intended failure.
- [ ] Add strict admission and status-bar wiring without local timers.
- [ ] Run focused frontend/native tests GREEN.

### Task 4: Verification and review

- [ ] Regenerate the contract and rebuild the sidecar deterministically.
- [ ] Recompute every changed production sidecar resource pin and prove the activation pin test.
- [ ] Run combined focused tests, full serial frontend tests, complete sidecar tests, serial Rust harness tests, production build, contract/boundary checks, and `git diff --check`.
- [ ] Run the Impeccable detector exactly once over changed UI files and address material findings without rerunning it.
- [ ] Request an independent P0-P2 review against this plan and CV-04; fix findings with RED→GREEN tests.
- [ ] Write `D:\PrimeStudio\evidence\cv04-event-chronology-report.md`, commit all changes, and verify a clean worktree.
