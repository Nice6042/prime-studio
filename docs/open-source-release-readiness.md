# Open-source source-publication policy

This policy separates a public **source snapshot** from a software release. The source-only
bootstrap is authorized only after every condition in
[`open-source-release-readiness.manifest.json`](open-source-release-readiness.manifest.json)
passes. Executables, installers, updater payloads, workflow artifacts, packages, Pages, signing,
and GitHub Releases remain blocked.

## Clean public history

The public repository must be created from the reviewed tracked tree in a new standalone Git
object store. It must contain one parentless commit on `main`, no tags, no pre-push remotes, no
alternates or shared objects, no reflogs or private refs, and no copied private Git metadata.
Private development commits, authors, timestamps, branches, worktrees, task records, and incident
evidence are not public-source inputs.

The clean-room tree and its complete object store must pass:

```powershell
cargo fetch --manifest-path .\app\src-tauri\Cargo.toml --locked --target x86_64-pc-windows-msvc
node --test tests/*.mjs
cd app
npm test -- --maxWorkers=1 --no-file-parallelism
npm run check
npm run build
npm run test:browser-shell:strict
cargo fmt --manifest-path .\src-tauri\Cargo.toml --all -- --check
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
cargo clippy --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin -- -D warnings
```

A pinned secret scanner must report zero findings for both the checked-out tree and every object
in the clean repository. The privacy test must reject personal names, account identifiers,
credentials, private filesystem paths, internal branch/worktree/agent labels, and private-history
commit or tree identifiers.

## GitHub controls

Before the repository is made public:

- visibly verify account two-factor authentication;
- enable secret scanning, push protection, the dependency graph, Dependabot alerts and security
  updates, and private vulnerability reporting;
- configure the protected `main` ruleset and exact required checks in
  [`github-publication-controls.md`](github-publication-controls.md);
- keep Issues and Discussions disabled until maintainers and a tested conduct route exist;
- keep Pages, Releases, Packages, and artifact-upload workflows absent; and
- allow squash merging only, with force pushes and branch deletion blocked.

The initial repository administrator performs this source-hosting bootstrap only. That role does
not become a project maintainer, security maintainer, release manager, or copyright owner.
Contribution intake remains closed until [`MAINTAINERS.md`](../MAINTAINERS.md) and
[`GOVERNANCE.md`](../GOVERNANCE.md) are satisfied.

## No binary release

The checked-in UI and native code are an unsupported development snapshot. Production authority
for live Prime execution remains unavailable. Local builds are untrusted development artifacts
and must not be uploaded, attached, signed, or described as releases. A future binary release
requires a separately reviewed policy, authenticated artifact closure, reproducible build
evidence, signing authority, update security, current SBOM/notices, and staffed release/security
roles.
