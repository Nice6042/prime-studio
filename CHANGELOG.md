# Changelog

All notable source changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version labels do not by themselves mean
that a production-ready package was released.

## [Unreleased]

This is a development snapshot, not a supported Prime Studio release. The new product shell and
typed fake-Harness integration are working; production still starts with elevated effect classes
unavailable until a reviewed exact runtime profile can mint a scoped native activation receipt.

### Added (source-level)

- A single responsive three-pane product shell: projects and chats on the left, parent-only
  conversation and composer in the center, and a resizable Harness inspector on the right.
- Harness overview, selected-child transcript/activity/files, queue, tools, context sources,
  activity, and current-chat usage without leaking child content into the parent conversation.
- Editor/canvas, Settings (including separate account usage), command palette, themes, persisted
  bounded pane widths, keyboard navigation, compact focus-managed sheets, and accessible states.
- A generated Studio Harness Protocol contract, verified Node sidecar, Rust ownership/chronology
  broker, closed Tauri client, cursor-bound attach and session-command operations, and recovery
  records.
- A deterministic fake daemon shared by sidecar, Rust, browser, and native-development tests.
  The actual Tauri window can admit a synthetic prompt, render its response, update current-chat
  usage, and show child detail only in the inspector.
- A production bundle boundary check rejecting legacy entry selection, raw renderer RPC, direct
  runtime imports, open command unions, renderer Node primitives, and legacy Harness markers.

- Layered prime-agent CLI-resolution code: configured path -> `PRIME_STUDIO_CLI` /
  `PRIME_AGENT_CLI` -> `prime-agent` on PATH -> per-OS default install locations ->
  `npm root -g`.
- Settings presentation and backend command implementations for Prime CLI detection and
  configuration.
- Rust command implementations including `resolve_prime_cli`, `set_prime_cli`, and
  `check_prime_cli`.
- React presentation, domain contracts, security-admission models, runtime-manifest verification,
  and test harnesses for chat, accounts, models, usage, artifacts, orchestration, approvals,
  provider auth, computer use, and scheduling.
- `LICENSE`, `CONTRIBUTING.md`, this changelog, development diagnostics, a historical acceptance
  ledger, and a fail-closed open-source release policy.

These entries record code and test surfaces. They do not assert that the corresponding effect is
admitted or usable through the production application.

### Security boundary

- The production Tauri dispatcher starts from `AuthorityGate::phase_zero()` and rejects elevated
  effects before command dispatch.
- `start_session` and `attach_session` are unavailable because `PrimeSessionProcess` is not
  admitted.
- `verified_prime_process_spec` independently refuses to construct a production Prime process
  until verified-runtime and environment-policy results are integrated.
- Browser-shell tests inject a typed mutable Tauri projection fixture; native debug smoke runs the
  real Tauri/Rust/sidecar path against only the deterministic fake daemon. Neither establishes
  provider, real-runtime, credential, or workspace readiness.
- No current release candidate is declared. The source-only bootstrap is conditional and every
  binary distribution surface remains blocked by
  `docs/open-source-release-readiness.manifest.json`.

### Changed

- `App.tsx` now has one product entry and cannot select the former legacy shell by environment.
- Protocol documentation now describes the versioned SHP adapter boundary instead of the obsolete
  `--background`/`-d` discovery assumptions.
- The native catalog path now matches the hardened `projects-v2.json` catalog contract.

- The Windows `--require windowshide-shim.cjs` argument-building code is optional and includes the
  shim only when present; this code is not reachable through a verified production Prime launch.
- Account-login implementation is Windows-specific; production account-authentication admission
  remains unavailable.
- Diagnostic scripts live under `dev/` and avoid absolute machine paths.
- The bundle identifier is `dev.primestudio.app` rather than the earlier template identifier.
- Release-facing documentation now distinguishes source/test implementation, mocked presentation
  evidence, production admission, packaged readiness, and release approval.

## [0.1.0] - development snapshot

The earlier changelog described this as an “initial working build.” That was inaccurate. The
snapshot contains Tauri/React presentation and in-progress integration code for streaming chat,
tool cards, sessions, model selection, usage, artifacts, accounts, and related controls, but the
current production authority and process-spec boundaries do not permit a real Prime session.

No capability listed for this snapshot should be treated as packaged/backend readiness or release
approval. Remaining gates are recorded in `docs/open-source-release-readiness.*`.
