# Prime Studio

Prime Studio is a Windows-first Tauri and React desktop workspace for a separately installed
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) runtime.

> [!IMPORTANT]
> This repository is a development snapshot, not a supported product or release
> candidate. The product shell and typed fake-Harness integration work, but production
> runtime activation remains unavailable. Do not use it with production accounts or
> important data.

It is not a working Prime desktop client against a real provider until that activation
boundary is implemented and independently verified.

## Status

The app now has one product entry: a responsive three-pane workspace with projects on
the left, the clean parent conversation and composer in the center, and the Harness
inspector on the right. The inspector owns child-agent transcripts, queue, tools,
activity, context sources, and current-chat usage. Account-wide usage remains in
Settings. Browser and native development tests exercise the same typed projections.

The native path includes a closed Studio Harness Protocol, Rust broker, verified
sidecar launch boundary, cursor-bound session commands, and a deterministic fake
daemon. An explicit debug-only profile exercises the real
Tauri -> Rust -> sidecar -> fake-daemon path without credentials or a real workspace.

Production still starts with every elevated effect class unavailable. The checked-in
authority gate rejects live Prime execution, authentication, external navigation,
workspace effects, browser execution, and computer use unless a trusted native
verifier enables the exact capability. The production activation receipt for a real
Prime Harness profile is deliberately not shipped yet.

Consequently, a normal production build cannot currently:

- start or attach to a real Prime session;
- send a live prompt or stream a live response;
- authenticate a provider or switch a live model;
- read live provider usage or workspace artifacts; or
- perform browser or computer-use actions.

The deterministic fake profile can attach its synthetic root session, admit typed
prompt/steer/follow-up/abort commands, return parent replies, update current-chat
usage, and project child-agent detail only into the right inspector. This is
integration evidence, not production capability evidence.

## Repository map

| Path | Purpose |
|---|---|
| `app/src/app`, `entities`, `features`, `shared` | Product UI, state, strict IPC client, and tests |
| `app/harness-contract/` | Versioned SHP schema and generated Rust/TypeScript contracts |
| `app/harness-sidecar/` | Studio-owned adapter process and deterministic fake daemon |
| `app/src-tauri/src/` | Rust backend, authority gate, local storage, and native tests |
| `app/e2e/` | Browser-shell behavior, accessibility, responsive, and projection tests |
| `docs/security/` | Detailed threat models and security invariants |
| `PROTOCOL.md` | SHP boundary, compatibility policy, and update-resilience contract |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime boundaries and
[PRIVACY.md](PRIVACY.md) for local data handling.

## Development

Prerequisites:

- Windows 11 for the currently exercised native platform;
- Node.js 22.12 or later within the 22.x LTS line;
- Rust stable and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

Install dependencies and use the mocked browser shell as the default UI-development
boundary:

```powershell
cd app
npm ci
npm run install:browser-shell-chromium
npm run test:browser-shell:strict
```

This command builds and exercises the UI with injected synthetic IPC. It does not load
the Rust backend, Prime profiles, credentials, or a real workspace.

Do not run `npm run tauri dev` under your normal operating-system profile. Native
startup may run account-recovery logic against the `.prime` directory derived from
`USERPROFILE` and may read or write application or webview state derived from
`APPDATA` or `LOCALAPPDATA`. The explicit disposable-environment recipe is in
[TESTING.md](TESTING.md#native-development-window).

Run the core checks:

```powershell
cd app
npm test
npm run check
npm run build
npm run check:harness-contract
npm run check:harness-boundaries
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
```

The complete local gate, browser-shell boundary, and optional native probes are in
[TESTING.md](TESTING.md).

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Privacy](PRIVACY.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Governance](GOVERNANCE.md)
- [Maintainers](MAINTAINERS.md)
- [Dependency Policy](DEPENDENCIES.md)
- [Releasing](RELEASING.md)

There are no official releases or signed binaries. A locally produced executable or
installer is an untrusted development artifact. Publication and binary release gates
remain fail-closed; see
[docs/open-source-release-readiness.md](docs/open-source-release-readiness.md).

## License and provenance

The project license and package metadata use the non-personal collective label
`Prime Studio Contributors`; [AUTHORS](AUTHORS) explains that label without claiming a
company or transfer of ownership. Deterministic [third-party notices](THIRD_PARTY_NOTICES.md)
and a locked Windows dependency [SPDX SBOM](sbom/prime-studio-windows-x86_64.spdx.json)
are checked in and regenerated from the lockfiles. These files do not declare a release:
clean-room history, source provenance, post-build bundle reconciliation, signing, and
final publication approval remain separate fail-closed gates.

prime-agent is a separate project and is not distributed by this repository.
