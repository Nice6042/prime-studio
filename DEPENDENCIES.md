# Dependency Policy

Prime Studio treats packages, build tools, workflow actions, downloaded binaries,
generated assets, and separately installed runtimes as supply-chain inputs. The
presence of a dependency in a lockfile is not release approval.

## Default decision

Prefer the standard library and existing reviewed dependencies. Add a dependency only
when the pull request identifies a concrete requirement that cannot be met safely and
maintainably with the current graph. Convenience alone is insufficient for a new
runtime dependency.

No contributor may claim that a package, license, artifact, or version is approved
unless the exact candidate has completed the reviews below.

## Required pull-request evidence

A dependency change must disclose:

- the package or action name, exact resolved version or commit, source registry or
  canonical repository, and files that declare or lock it;
- whether it is a production, development, build-only, test-only, optional, platform-
  specific, workflow, or separately installed dependency;
- the user-visible need and the smaller alternatives considered;
- the SPDX license expression, copyright and notice obligations, and whether any
  source, data, font, icon, binary, or generated output is distributed;
- advisory and maintenance status from pinned review tools;
- install or build lifecycle scripts, network downloads, native code, subprocesses,
  environment access, filesystem access, and credential exposure;
- expected bundle, startup, memory, and build-time impact; and
- removal, upgrade, rollback, and lockfile behavior.

The pull request must update the declaration and its lockfile together. Generated
lockfile changes must be attributable to the documented package-manager command; do
not hand-edit resolved versions or integrity values.

## Source and version rules

- Use the repository's existing package managers and committed lockfiles.
- Do not add an unpinned Git branch, moving tag, floating archive URL, or mutable
  download location.
- Workflow actions require an immutable full commit SHA and a nearby human-readable
  version comment.
- Direct binary downloads require a canonical HTTPS source, immutable version, and
  verified digest. A versioned filename without a digest is not immutable evidence.
- New registries, mirrors, package-manager configuration, or dependency overrides
  require explicit supply-chain review.
- Do not enable a broader default feature set when a smaller reviewed feature set is
  sufficient.

Version ranges in manifests describe resolver policy; the committed lockfiles define
the exact development graph. Release evidence must be regenerated from the frozen
lockfiles in a clean environment with network behavior recorded.

## Review gates

At minimum, dependency changes require:

1. locked installation or resolution from a clean environment;
2. ecosystem tests, compilation, linting, and the affected packaged boundary;
3. vulnerability and license scans using pinned tool and advisory-database versions;
4. review of source provenance, nested notices, generated inputs, and shipped output;
5. reconciliation with distributed notices and SBOMs; and
6. independent approval from the roles required by [GOVERNANCE.md](GOVERNANCE.md).

Unknown, unlicensed, deny-listed, vulnerable without an accepted disposition, or
unreviewed generated content remains blocked. A clean vulnerability scan does not
replace license, provenance, maintenance, or behavior review.

## Current snapshot boundary

Current npm and Cargo manifests and lockfiles are development inputs. Their package
identity fields, authorship fields, license metadata, dependency notices, and shipped
closure are not declared release-ready. A separate authorized metadata and provenance
pass must correct them without inventing a legal claimant, maintainer, repository
owner, or signing identity.

The separately installed prime-agent runtime is not distributed by this repository.
Any future activation still requires a pinned compatibility decision and runtime
provenance; installation on a developer machine is not approval to bundle it.

See [RELEASING.md](RELEASING.md) for candidate-wide SBOM, reproducibility, signing,
and notice requirements.

## Reproducible local dependency gate

The supported dependency graph is the 64-bit Windows MSVC target only. The repository
pins Rust 1.97.0 in `rust-toolchain.toml`; the Node application declares
`>=22.12.0 <23`. Other Node major releases and non-Windows Cargo graphs are not release
evidence.

Install the review tools at their exact recorded versions. Do not use an unversioned
install or update command:

```text
cargo install --locked cargo-deny --version 0.20.2
cargo install --locked cargo-audit --version 0.22.2
```

Clone `https://github.com/RustSec/advisory-db` outside the repository, check out commit
`565436d86a136c840d01ad4a7851fc7391295404`, and set `RUSTSEC_ADVISORY_DB` to that
checkout. If the variable is unset, the check uses Cargo's standard
`advisory-db` directory. The checkout must remain at that exact clean revision; the
`db.lock` file created by `cargo-audit` is the only permitted untracked file.

From `app/`, run:

```text
npm ci
npm run test:dependency-policy
npm run check:dependencies
```

`check:dependencies` rejects an unsupported Node release, changed lock resolution,
npm vulnerabilities of any severity, an unexpected Cargo source or license, listed
banned crates, unexpected RustSec findings, changed tool versions, a changed advisory
database revision, expired dispositions, and stale dispositions. It runs both
`cargo-deny` and `cargo-audit` without fetching or updating the advisory database.

### Time-bounded informational dispositions

The supported Windows graph currently reaches five unmaintained `unic-*` crates
through `tauri-utils -> urlpattern -> unic-ucd-ident`. The exact machine-readable
records are in `dependency-policy.json`; all expire after 2026-09-10 and are owned by
the release-manager role. That role is currently vacant, so these records make the
development check explicit and fail closed on drift, but do not authorize a public
release. A release manager must remove, renew, or reject them by the review date.

The Linux-only GTK3/glib closure is absent from the supported Windows Cargo graph. Its
unsoundness and maintenance advisories are therefore neither ignored nor accepted by
this policy; any future Linux support requires a separate graph, dispositions, tests,
and release decision.
