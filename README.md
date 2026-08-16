# Prime Studio

Prime Studio is a Windows-first Tauri and React desktop workspace for a separately installed
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) runtime.

> [!IMPORTANT]
> This repository is a development snapshot, not a supported product or release candidate.
> The source contains a reviewed exact-profile production activation path, but this repository
> does not yet contain independent disposable-Windows evidence from a real provider-backed
> account. Do not use it with important accounts, workspaces, or data.

## Status

Prime Studio has one product entry: a responsive three-pane workspace with projects on the
left, the parent conversation and composer in the center, and the Harness inspector on the
right. The inspector owns child-agent transcripts, queue, tools, activity, context sources,
and current-chat usage. Account-wide usage remains in Settings.

| Layer | Checked-in state | Evidence boundary |
|---|---|---|
| Product shell | Implemented and exercised by strict browser, accessibility, frontend, and Windows native gates | CI verifies deterministic fixtures and native test binaries, not a real provider account |
| Prime runtime bridge | Startup attempts activation for reviewed exact `prime-agent` 0.7.2/schema-16 and 0.7.1/schema-13 profiles | Full package, entrypoint, daemon, Node, sidecar, schema, and capability identity must match; other identities fail closed |
| Resident sessions | Typed create, attach, prompt, streaming, abort, reconnect, paging, child, usage, and artifact paths are present | A real installed runtime and provider-backed session still require host verification |
| Provider accounts | Credential-free account metadata, Prime CLI login handoff, auth health, local usage, and quota separation are available | The reviewed resident-create contract cannot select an account, provider, model, or thinking default for a new resident |
| Browser and computer use | Native readiness projection plus lease-scoped admission and evidence contracts are implemented | No production `VerifiedInteractionWorker` or effect-dispatch command is shipped, so browser and computer effects remain unavailable |
| Distribution | Installer policy, dependency review, notices, SBOM, and fail-closed publication checks are present | There are no official releases, signed binaries, release credentials, or independent release approval |

The runtime path is therefore neither a fake-only shell nor a generally supported live client.
A normal build attempts the exact reviewed activation path and reports the resulting runtime
truth. Successful CI is source evidence; it is not evidence that a particular machine,
subscription, account, daemon, browser, or foreground window has been safely exercised.

The detailed source-versus-host boundary for the implementation waves is recorded in
[docs/product/waves-0-6-completion.md](docs/product/waves-0-6-completion.md). Provider/session
limitations are recorded in
[docs/product/provider-session-capabilities.md](docs/product/provider-session-capabilities.md),
and the browser/computer-use boundary is recorded in
[docs/security/browser-computer-use-worker-contract.md](docs/security/browser-computer-use-worker-contract.md).

## Fail-closed boundaries

Prime Studio does not infer authority from an installed executable, a UI toggle, account
metadata, a capability label, or successful fixture tests. It requires exact native evidence.
The following remain unavailable unless their specific authority is present:

- unreviewed Prime versions, entrypoints, daemon schemas, Node binaries, or sidecar resources;
- selecting a provider account, model, or thinking default during resident creation;
- browser navigation, capture, download, or form interaction through a production worker;
- Windows click or typing effects through a production computer-use worker;
- signed release publication or automatic update installation.

Unavailable controls must stay disabled with a reason rather than silently falling back to an
unverified path.

## Repository map

| Path | Purpose |
|---|---|
| `app/src/app`, `entities`, `features`, `shared` | Product UI, normalized state, typed IPC client, and tests |
| `app/contracts/` | Versioned Studio Harness Protocol schema and generated bindings |
| `app/harness-sidecar/` | Studio-owned adapter, reviewed runtime profiles, and deterministic fake daemon |
| `app/src-tauri/src/` | Rust authority, activation, storage, account, artifact, browser, and computer-use boundaries |
| `app/e2e/` | Strict browser-shell behavior, accessibility, responsive, and projection tests |
| `docs/product/` | Product contracts, capability truth, and implementation ledgers |
| `docs/security/` | Threat models, authorization invariants, and high-impact worker contracts |
| `PROTOCOL.md` | Protocol, compatibility, and update-resilience policy |

See [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries and
[PRIVACY.md](PRIVACY.md) for local data handling.

## Development

Prerequisites:

- Windows 11 for the currently exercised native platform;
- Node.js 22.12 or later within the 22.x LTS line;
- Rust 1.97 and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

Install dependencies and exercise the mocked browser shell:

```powershell
cd app
npm ci
npm run install:browser-shell-chromium
npm run test:browser-shell:strict
```

This command builds and exercises the UI with injected synthetic IPC. It does not load the
Rust backend, credentials, a real Prime daemon, or an important workspace.

Do not run `npm run tauri dev` under your normal operating-system profile. Native startup may
inspect the `.prime` directory derived from `USERPROFILE` and application or WebView state
derived from `APPDATA` or `LOCALAPPDATA`. Use the disposable-environment recipe in
[TESTING.md](TESTING.md#native-development-window).

Run the core checks:

```powershell
cd app
npm test
npm run check
npm run build
npm run check:harness-contract
npm run check:harness-boundaries
cargo fmt --manifest-path .\src-tauri\Cargo.toml --all -- --check
cargo clippy --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin -- -D warnings
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

There are no official releases or signed binaries. A locally produced executable or installer
is an untrusted development artifact. Publication and binary release gates remain fail-closed;
see [docs/open-source-release-readiness.md](docs/open-source-release-readiness.md).

## License and provenance

The project license and package metadata use the non-personal collective label
`Prime Studio Contributors`; [AUTHORS](AUTHORS) explains that label without claiming a company
or transfer of ownership. Deterministic [third-party notices](THIRD_PARTY_NOTICES.md) and a
locked Windows dependency [SPDX SBOM](sbom/prime-studio-windows-x86_64.spdx.json) are checked
in and regenerated from lockfiles. These files do not declare a release: clean-room history,
source provenance, post-build bundle reconciliation, signing, and final publication approval
remain separate fail-closed gates.

prime-agent is a separate project and is not distributed by this repository.
