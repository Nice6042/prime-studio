# Releasing

Prime Studio has no release candidate, official release, supported installer,
signing identity, or update channel. This document separates the authorized
source-only bootstrap from a future binary release; it does not authorize binaries.

The normative gate definitions are in
[`docs/open-source-release-readiness.md`](docs/open-source-release-readiness.md) and
its machine-readable companion. If this summary conflicts with that runbook, the
stricter requirement applies.

## Release classes

| Class | Contents | Current status |
|---|---|---|
| Public source | Sanitized source in a new public Git object store | Conditional bootstrap |
| Windows binary | Executable, installer, or update payload | Blocked |

Building successfully does not change either status.

## Public-source candidate

The initial repository administrator must:

1. freeze one exact reviewed source tree;
2. resolve source ownership, contributor attribution, asset provenance, licenses, and
   distributed notices;
3. remove personal data, account data, credentials, private paths, raw captures,
   private identifiers, and unapproved generated artifacts;
4. export tracked content without `.git` into a quarantine directory;
5. initialize a brand-new standalone Git object store with neutral, reviewed public
   metadata and only the intended root commit and branch;
6. scan the tree, reachable history, refs, reflogs, loose objects, packs, and binary
   metadata with pinned tools;
7. verify no alternates, shallow state, partial-clone state, promisor objects,
   unapproved refs, missing objects, or unreachable objects exist;
8. repeat closure and secret scans in a fresh non-local clone;
9. bind a sorted path-and-SHA-256 manifest and all approvals to the exact candidate;
10. obtain independent technical and provenance reviews of the exact clean tree; and
11. create and push the one-root source repository under the authorized bootstrap.

Use the fail-closed local exporter and verification procedure in
[`docs/public-release/clean-room-export.md`](docs/public-release/clean-room-export.md)
for steps 4 through 7. Export success is evidence for review, not publication
authorization.

Do not mirror, fork, bundle, graft, or reuse the private repository's object store.
Deleting visible branches is not a clean-history cutover.

## Windows binary candidate

In addition to every public-source gate, a binary candidate requires:

- corrected and reviewed package and Windows identity metadata;
- a pinned toolchain and locked dependency graph reviewed under
  [DEPENDENCIES.md](DEPENDENCIES.md);
- clean builds on independent controlled builders;
- explanation or elimination of every unsigned-build difference;
- review of installer scope, downgrade behavior, WebView2 policy, uninstall behavior,
  and local-data retention;
- complete SBOMs and distributed third-party notices reconciled to unpacked output;
- an approved Authenticode identity, protected short-lived signing authorization, and
  a trusted timestamp;
- SHA-256 manifests and signed provenance bound to the final artifacts; and
- an explicit decision to keep updates disabled or to use an independently verified,
  rollback-aware signed update channel.

The current fail-closed installer configuration, scope matrix, WebView2 behavior,
uninstall retention rules, and local unsigned-candidate inventory procedure are in
[`docs/windows-installer-policy.md`](docs/windows-installer-policy.md).

Unsigned local MSI, NSIS, executable, or updater output must never be described as an
official release.

The source license, contributor label, and package-manifest identity are normalized for
public-source review. They do not supply a repository owner, maintainer, signing
principal, or release authorization. The checked-in dependency SBOM and notices must be
regenerated after every lockfile or feature change and reconciled with any future built
artifact before that artifact can be released.

## Repository controls

Before contribution intake or any binary release, administrators must assign the roles
in [MAINTAINERS.md](MAINTAINERS.md) and satisfy [GOVERNANCE.md](GOVERNANCE.md). The
source-only bootstrap still requires tested private vulnerability reporting, pinned
read-only automation, and verified branch protection.

Pull-request workflows must not receive release secrets. Publishing and signing must
use a protected environment and the least privilege needed for that specific action.

## Release notes

Release notes must state:

- the exact tag, commit, and artifact SHA-256 values;
- supported operating systems and upgrade paths;
- activated and unavailable capabilities;
- known security and privacy limitations;
- installer and uninstall data behavior;
- SBOM, notice, signature, and provenance locations; and
- whether automatic updates are enabled.

Do not promise compatibility, support, or functionality that was not verified on the
exact signed candidate.

## Stop conditions

Stop immediately on any unresolved secret, provenance gap, personal-data finding,
unknown license, unsigned artifact, unexpected signer, non-reproducible difference,
missing evidence, stale approval, or candidate-tree change. Correct the issue, freeze
a new candidate, and rerun every affected gate.
