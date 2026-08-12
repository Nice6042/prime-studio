# Prime Studio Implementation Self-Review

**Review scope:** implementation from the public baseline through the integrated fake-Harness milestone (M5).

**Verdict:** approved as a development integration milestone. It is not approved for production Harness activation or release.

## What was reviewed

- the generated, closed Studio Harness Protocol shared by TypeScript and Rust;
- the Studio-owned sidecar, deterministic fake daemon, and Rust broker;
- ownership, cursor chronology, command admission, bounded transport, and fail-closed behavior;
- the React product entry, three-pane workspace, project/chat navigation, parent-only conversation, composer, Harness inspector, current-chat usage, Settings account usage, editor/canvas, command palette, themes, persistence, resizing, and compact sheets;
- browser-shell, native debug, accessibility, forced-colors, reduced-motion, bundle, dependency, privacy, and public-policy gates; and
- documentation and release truthfulness.

## Findings closed during review

1. No-argument native commands could accept hostile extra payload keys. The Tauri entry points now reject malformed payloads before dispatch, with focused native regressions.
2. The title bar used text glyphs for several controls. Those controls now use project-authored SVG icons with accessible names, and a regression prevents the glyphs from returning.
3. The native product profile used the wrong project-catalog filename. It now opens the confined `projects-v2.json` catalog used by the hardened catalog boundary.
4. The legacy application entry remained reachable through the top-level React switch. `App.tsx` now mounts the new Studio product entry only, and the production bundle boundary rejects legacy renderer integration.
5. A clean-room exporter race test matched an obsolete rejection phrase. The test now accepts only the current precise late-reference rejection.

## Confirmed invariants

- Parent chat renders parent-channel messages only. Child transcript, activity, and files remain confined to the selected child route in the right inspector.
- Right-panel usage is scoped to the current chat. Account-wide usage is available only from Settings.
- Renderer code cannot import Prime runtime packages, open daemon sockets, call raw `send_rpc`, or receive credentials, executable paths, or unrestricted filesystem/process handles.
- Harness commands bind project, chat, root session, generation, sequence, and command identity. Stale, replayed, mismatched, unknown, oversized, or impossible data fails closed.
- Debug fake-Harness activation requires explicit absolute resource paths and native verification. A normal production build does not silently fall back to fake or live execution.
- Pane resizing is bounded and keyboard operable; compact layouts use focus-managed modal sheets; serious and critical axe findings are zero in the exercised browser scenarios.
- UI controls do not claim capabilities that are unavailable. Disabled actions provide a reason instead of simulating success.

## Remaining activation-gated work

The following work is deliberately not represented as complete:

- minting a production activation receipt for a reviewed exact Prime Harness profile;
- creating or reattaching resident live sessions, including durable new-chat creation;
- live model/thinking changes, attachment admission, child paging/control, and provider/account usage;
- removing the remaining hardened legacy native domains after verified parity; and
- release/signing approval after M6 and M7 complete.

These are explicit M6/M7 gates. The M5 fake-daemon path is integration evidence, not proof that a real provider or user workspace is safe to use.

## Verification evidence

- Frontend: full serialized Vitest, TypeScript/reducer check, production build, bundle tests, generated contract check, renderer boundary check, sidecar suite, and strict Playwright/axe suite.
- Native: Rust formatting, all-target check, Clippy with warnings denied, and all-target tests with the test-support feature.
- Policy: root Node policy suite, dependency policy under the pinned Node 22.12 runtime, exact Cargo advisory tools/database, notices/SBOM reproduction, and clean diff/status checks.
- Native smoke: a disposable-profile Tauri window attached to the verified fake daemon, admitted a typed prompt, rendered the parent response, advanced current-chat usage, and kept child detail in the right inspector.

No real provider credentials, production account, or real user workspace were used by the activation tests.
