# Changelog

All notable source changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version labels do not by themselves mean
that a production-ready package was released.

## [Unreleased]

This is an admission-only development snapshot, not a working Prime Studio release. Production
starts with elevated effect classes unavailable, and Prime session process construction fails
closed before CLI discovery or spawn. Browser-shell results use mocked Tauri IPC and are
presentation evidence only.

### Added (source-level)

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
- Browser-shell tests inject a browser-only Tauri IPC fixture; they do not launch or package Tauri,
  execute the Rust backend, connect to Prime, or establish provider/workspace readiness.
- No current release candidate is declared. The source-only bootstrap is conditional and every
  binary distribution surface remains blocked by
  `docs/open-source-release-readiness.manifest.json`.

### Changed

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
