# Prime Studio

Prime Studio is a Windows-first Tauri and React development snapshot exploring a
desktop interface for a separately installed
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) runtime.

> [!IMPORTANT]
> This repository is not a working Prime desktop client, a supported product, or a
> release candidate. Do not use it with production accounts or important data.

## Status

The production backend starts with every elevated effect class unavailable. The
checked-in authority gate rejects Prime process execution, live RPC, authentication,
external navigation, workspace reads, browser execution, and computer use unless a
future trusted verifier explicitly enables them. The current process verifier also
stops before constructing or spawning a Prime process.

Consequently, the application cannot currently:

- start or attach to a real Prime session;
- send a live prompt or stream a live response;
- authenticate a provider or switch a live model;
- read live provider usage or workspace artifacts; or
- perform browser or computer-use actions.

The source tree does include presentation components, strict protocol models,
account-registry code, process-isolation primitives, recovery logic, and test
harnesses. Tests and browser fixtures demonstrate those isolated boundaries; they do
not activate production capabilities.

## Repository map

| Path | Purpose |
|---|---|
| `app/src/` | React UI, state, domain contracts, and frontend tests |
| `app/src-tauri/src/` | Rust backend, authority gate, local storage, and native tests |
| `app/e2e/` | Mocked browser-shell tests; no native or provider integration |
| `docs/security/` | Detailed threat models and security invariants |
| `PROTOCOL.md` | Protocol research and contracts, not proof of live connectivity |

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
