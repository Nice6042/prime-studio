# CP-01 bounded composer growth implementation plan

**Goal:** Make the parent composer grow naturally to the reviewed package's 140px bound and scroll
internally beyond it without changing draft, keyboard, or IME authority.

**Architecture:** Preserve the controlled `Composer` component and use native CSS intrinsic field
sizing. Bind the exact package limit through a component-owned CSS custom property; verify real
layout in Playwright rather than introducing renderer measurement state.

## Task 1: Lock the component contract

**Files:**
- Modify: `app/src/features/conversation/Composer.test.tsx`
- Modify: `app/src/features/conversation/Composer.tsx`

1. Add failing tests for the one-row input, exact 140px sizing token, multiline/IME callback
   behavior, and controlled A/B/A draft replacement.
2. Run the focused component test and confirm the missing sizing contract fails.
3. Add the minimal input class, exported bound, and custom property.
4. Run the focused component test green.

## Task 2: Implement and prove real responsive layout

**Files:**
- Modify: `app/src/features/conversation/conversation.css`
- Create: `app/e2e/composer-growth.spec.ts`
- Create: `app/e2e/composer-growth.narrow.spec.ts`

1. Add real-browser tests for wide/compact growth, cap, internal scroll, shrink-back, keyboard,
   IME, page overflow, and axe; add the 2x narrow-project equivalent.
2. Run the browser tests and confirm the textarea does not grow.
3. Add native intrinsic sizing and package-aligned typography/padding.
4. Run both browser projects green.

## Task 3: Review and finish

**Files:**
- Modify only files required by P0-P2 findings.
- Create: `D:\PrimeStudio\evidence\cp01-composer-growth-report.md`

1. Run focused unit/browser tests and request independent P0-P2 review.
2. Apply review fixes through RED-GREEN tests.
3. Run the Impeccable detector exactly once over changed UI targets and address actionable output.
4. Run the proportional frontend suite, production build, strict browser tests, and diff checks.
5. Write the evidence report, commit all changes, and verify the worktree is clean.
