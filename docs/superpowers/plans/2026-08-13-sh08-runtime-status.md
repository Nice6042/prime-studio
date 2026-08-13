# SH-08 runtime status implementation plan

**Goal:** Compose every verified runtime status authority into the package's fixed 24px bottom bar
without duplicate polling, stale identity, or fabricated fallback values.

## Task 1: Define the closed status projection

**Files:**
- Modify `app/src/features/harness/adapter.ts`
- Modify `app/src/features/harness/HarnessInspector.tsx`
- Modify `app/src/features/harness/HarnessInspector.test.tsx`

1. Write RED tests for exact session/cursor projection, overload admission, stale completion, and
   unavailable load outcomes.
2. Run the focused inspector tests and record RED.
3. Add the immutable runtime-status projection and emit it only from the existing guarded load.
4. Run focused tests GREEN.

## Task 2: Bind and render all status evidence

**Files:**
- Modify `app/src/app/StudioApp.tsx`
- Modify `app/src/features/shell/RuntimeStatusBar.tsx`
- Modify `app/src/features/shell/RuntimeStatusBar.test.tsx`
- Modify `app/src/features/shell/shell.css`

1. Write RED tests for exact composer cursor binding, runtime/connection, context use/limit,
   CV-04 values, overload, hostile/stale input, and unavailable semantics.
2. Run focused tests and record RED.
3. Bind composer responses to exact session/generation/sequence and compose status evidence.
4. Implement the 24px wide/compact presentation without timers.
5. Run focused tests GREEN.

## Task 3: Prove responsive accessibility and finish

**Files:**
- Modify `app/e2e/acceptance-matrix.spec.ts`
- Modify `app/e2e/narrow.spec.ts`
- Create `D:\PrimeStudio\evidence\sh08-runtime-status-report.md`

1. Add RED browser geometry, focus, accessible-name, overload, and axe assertions.
2. Make responsive CSS GREEN at 640x400 and 320x200@2x.
3. Request independent P0-P2 review and fix findings through RED-GREEN tests.
4. Run the Impeccable detector exactly once after review fixes.
5. Run focused tests, strict browser, production build, and diff checks.
6. Write the report, commit, and verify a clean worktree without acceptance edits or push.
