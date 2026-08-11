# Prime Studio Planning Self-Review

**Reviewed artifacts:** PRODUCT.md, the 2026-08-12 Harness workspace design specification, the implementation program, and five subsystem plans.

**Baseline:** public `main` at `2540d1d8c5c58b5d9d29d0a6ccc63d826ec24d50`.

## Verdict

**PASS — ready for implementation planning handoff.** No production implementation or runtime activation is included.

## Coverage

- 115 unique prototype feature IDs are recorded in the design specification.
- Every feature prefix/range is mapped to one or more of 32 executable tasks or to an explicit, reasoned exclusion.
- The prototype's shell, navigation, parent conversation, composer, Harness overview, child detail, current-chat usage, activity, editor, Canvas, settings, account usage, command palette, responsive behavior, accessibility, state, failures, and visual tokens are covered.
- Voice input, unsafe edit undo, unavailable kernel variables, unsupported provider quota, direct browser/computer dispatch, and a generic approvals dashboard are explicitly excluded rather than silently omitted.
- Current-chat and account-wide usage have different types, routes, selectors, and regression tests.
- Parent and child channels have different stores, DTOs, routes, and hostile isolation tests.

## Architecture review

- Tauri/React is retained; the plan refactors boundaries instead of introducing an unnecessary framework rewrite.
- Existing native security domains remain named dependencies and are not replaced by renderer logic.
- A Rust-owned broker and contained Studio Node sidecar isolate the Prime Harness SDK and daemon.
- Compatibility uses exact runtime identity, protocol/schema identity, and capabilities; semver cannot activate execution.
- Unsupported future Harness versions start in degraded, read-only, or unavailable mode and cannot crash or silently activate the app.
- Compatibility evidence and execution authority remain separate until the activation task mints a private verified receipt.
- Snapshot/replay chronology, generation, session/account/project ownership, bounded payloads, recovery, idempotency, and uncertain outcomes all have planned tests.
- Legacy raw RPC removal happens only after fake-daemon parity and verified activation.

## Plan quality review

- The program is split into five dependency-ordered subsystem plans.
- Every task names exact files, interfaces, a RED command/expected failure, implementation behavior, GREEN commands, and a commit boundary.
- Shared type names were checked and normalized: `HarnessCompatibility`, `HarnessUnavailableReason`, `HarnessCapability`, `HarnessCursor`, `RootSessionSnapshot`, `RootSessionProjection`, and `InspectorRoute`.
- Ambiguous “or current module” and “delete after parity” file instructions were replaced with exact files/functions.
- Placeholder-pattern scan returned zero findings.
- Migration, rollback, accessibility, performance, privacy, provenance, dependency/SBOM, native fake-daemon, and release gates are included.

## Repository verification

- `git diff --check`: pass.
- Local Markdown link scan over PRODUCT.md and `docs/superpowers/`: pass, zero broken local targets.
- Feature inventory script: 115 unique feature IDs.
- Task inventory script: 32 unique task IDs.
- Personal/local-data scan over new files: zero matches for reviewed names, email/account identifiers, local user paths, worktree routes, or agent routes.
- Focused repository policy suite: 24/24 pass:
  - design provenance;
  - GitHub publication controls;
  - open-source release readiness;
  - public fixture privacy;
  - public package identity.
- The aggregate `node --test tests/*.mjs` command exceeded the 120-second command ceiling while running the unrelated clean-room exporter tests and emitted no failure. Relevant planning/privacy/provenance tests were then run explicitly and passed.

## Residual implementation risks

These are not planning gaps; they are mandatory review points in the plans:

1. exact installed Harness artifacts can change without a semver change;
2. the Windows daemon pipe is a same-user shared boundary;
3. extension/IPython tools are not an OS sandbox;
4. runtime activation must not weaken existing phase-zero authority;
5. a future Harness adapter profile requires a new fixture and security review;
6. binary distribution remains separately gated by signing, update, reproducibility, and release policy.

## Final handoff condition

Implementation must start with the runtime foundation plan and may not skip directly to UI activation. Each milestone must end green, independently reviewed, and revertible before its dependent plan begins.
