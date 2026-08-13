# CV-14 Parent History Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load bounded older pages for the active root conversation from a verified, opaque, snapshot-bound Harness cursor without allowing child data, stale pages, or invented retention facts into the main chat.

**Architecture:** Add a dedicated `page_parent_history` Studio Harness request/response rather than reusing the generic operation result, because the page payload and its exact snapshot identity must survive every decoder. The sidecar owns opaque cursor records and admits paging only from an atomic root snapshot with bounded source proof; Rust rechecks ownership and committed generation/sequence; the renderer decoder and store reject late/cross-chat pages before the parent-only UI prepends them.

**Tech Stack:** Node 22.12, TypeScript, Rust/Tauri 2, React 19, Vitest, Node test, Cargo test, Playwright.

## Global Constraints

- Base is exactly `16ea9432600a8755dbfdb9605901cef205b6218a` in `D:\PrimeStudio\worktrees\cv14-history-paging`.
- Parent/root messages only; child transcript rows never enter the main conversation.
- Cursor binds exact session, runtime generation, Studio snapshot sequence, and source window.
- Reject malformed, unknown, stale, and cross-session cursors fail closed.
- Page rows and encoded bytes are bounded; exact total and omission counts describe only the proven snapshot.
- When the installed Harness cannot prove a bounded atomic history source, render explicit unavailability.
- Do not edit `app/src/contracts/packageAcceptance.ts`.

---

### Task 1: Closed protocol page contract

**Files:**
- Modify: `app/contracts/harness-v1.schema.json`
- Modify: `app/scripts/generate-harness-contract.mjs`
- Test: `app/scripts/generate-harness-contract.test.mjs`

**Interfaces:**
- Produces: `ParentHistoryPage`, `StudioRequest::PageParentHistory` serialized as `conversation_history_page`, and `StudioResponse::ParentHistoryPageResult` serialized as `conversation_history_page_result` in generated TypeScript/Rust.

- [ ] Write schema-generation tests requiring a closed request `{type, sessionId, expectedCursor, before}` and page `{sessionId, snapshotCursor, messages, totalMessages, omittedBefore, omittedAfter, olderCursor, truncatedByBytes}`.
- [ ] Run the contract test and confirm RED because those generated variants do not exist.
- [ ] Add the closed schema definitions and generator output, with message arrays capped at 300 and opaque cursors using the bounded `Id` grammar.
- [ ] Generate the TypeScript/Rust sources and run contract check GREEN.

### Task 2: Sidecar paging authority

**Files:**
- Modify: `app/harness-sidecar/src/primeDaemonBridge.ts`
- Modify: `app/harness-sidecar/src/fakeDaemonScenario.ts`
- Modify: `app/harness-sidecar/src/index.ts`
- Test: `app/harness-sidecar/test/primeDaemonBridge.test.ts`
- Test: `app/harness-sidecar/test/fakeDaemon.test.ts`

**Interfaces:**
- Consumes: generated `ParentHistoryPage` request/response.
- Produces: `PrimeDaemonBridge.parentHistoryPage(sessionId, expectedCursor, before)` and deterministic fake-daemon behavior.

- [ ] Add RED tests for a newest page with exact totals/omissions, an older page, row/byte truncation, and exclusion of a `channel:"child"` row.
- [ ] Add RED tests for malformed/unknown, stale generation/sequence, and cross-session opaque cursors plus no atomic `source.messages` proof.
- [ ] Implement an in-memory opaque cursor registry containing session ID, runtime generation, Studio sequence, total/source digest, and `beforeExclusive` window index.
- [ ] Build pages backwards with a 100-row and 1 MiB content budget; require at most 4,096 source rows and 8 MiB of canonical source proof; return `history_unavailable` otherwise.
- [ ] Recheck the mutation barrier and source digest before every page; emit specific fail-closed errors and run sidecar tests GREEN.

### Task 3: Rust broker and Tauri command

**Files:**
- Modify: `app/src-tauri/src/harness/sidecar.rs`
- Modify: `app/src-tauri/src/harness/broker.rs`
- Modify: `app/src-tauri/src/commands/harness.rs`
- Modify: `app/src-tauri/src/authority.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/harness/broker.rs`
- Test: `app/src-tauri/tests/harness_integration.rs`

**Interfaces:**
- Produces: `HarnessBroker::page_parent_history` and Tauri command `harness_page_parent_history`.

- [ ] Add RED broker tests proving ownership, committed generation/sequence, returned page identity, and cross-session/stale rejection.
- [ ] Add RED native integration coverage for the exact sidecar envelope and returned bounded page.
- [ ] Implement the broker request/result and validate every message/count/cursor before returning it.
- [ ] Register and authorize the new Tauri command, then run focused Cargo tests GREEN.

### Task 4: Renderer decoder and bounded history store

**Files:**
- Modify: `app/src/shared/ipc/client.ts`
- Modify: `app/src/shared/ipc/client.test.ts`
- Create: `app/src/features/conversation/parentHistory.ts`
- Create: `app/src/features/conversation/parentHistory.test.ts`
- Modify: `app/src/shared/state/store.ts`
- Modify: `app/src/shared/state/store.test.ts`

**Interfaces:**
- Produces: `pageHarnessParentHistory`, `ParentHistoryState`, and reducer intents for load/start/success/unavailable.

- [ ] Add RED decoder tests for closed keys, bounded rows/bytes, parent channel, exact count arithmetic, and request identity.
- [ ] Add RED reducer tests for prepend/dedupe ordering, 600-row resident cap, late/stale/cross-chat responses, snapshot invalidation, and explicit unavailable state.
- [ ] Implement strict decoding and the bounded immutable history state; never mutate the authoritative live session projection.
- [ ] Run decoder/store tests GREEN.

### Task 5: Anchored parent-conversation UI

**Files:**
- Modify: `app/src/app/StudioApp.tsx`
- Modify: `app/src/features/conversation/ParentConversation.tsx`
- Modify: `app/src/features/conversation/ParentConversation.test.tsx`
- Modify: `app/src/features/conversation/conversation.css`
- Modify: `app/src/app/StudioApp.test.tsx`

**Interfaces:**
- Consumes: selected chat/session history state and `pageHarnessParentHistory`.
- Produces: a quiet load-older region with exact retained/total copy, loading/error/unavailable states, and focus/scroll anchoring.

- [ ] Add RED component tests for available/load/loading/error/unavailable/exhausted states and keyboard focus.
- [ ] Add RED production-mount tests proving the exact session cursor is sent, late results do not enter another chat, and child rows cannot render.
- [ ] Implement initial metadata discovery and older-page dispatch in `StudioApp`; pass combined parent-only rows and history presentation to `ParentConversation`.
- [ ] Capture the first visible message and scroll height before prepend; after commit restore the anchor and focus the first newly inserted message heading/turn.
- [ ] Add restrained incumbent CSS, forced-colors/reduced-motion-safe focus, and run focused tests GREEN.

### Task 6: Verification and handoff

**Files:**
- Modify if required: reviewed sidecar resource/pin files discovered by `build:reviewed-prime-adapter`
- Create outside Git: `D:\PrimeStudio\evidence\cv14-history-paging-report.md`

- [ ] Run Node 22 contract, sidecar, focused renderer, full serial renderer, Cargo, production build, strict browser, and `git diff --check` gates.
- [ ] Run the Impeccable detector exactly once over changed UI targets and address any findings in one bounded pass.
- [ ] Run Prime Agent independent review with a required report file; validate the report exists and retry once only on silent failure.
- [ ] Convert any actionable review finding into a RED test, implement GREEN, and rerun affected/full gates.
- [ ] Write the detailed evidence report, commit all tracked changes, verify `git status --porcelain` is empty, and do not push.
