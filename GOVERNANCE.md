# Governance

Prime Studio currently has no assigned public maintainers. This document defines the
roles and decision rules required before the repository can accept contributions or
publish releases; it does not claim those roles are staffed.

## Roles

- **Contributor:** proposes issues, documentation, code, tests, or reviews under
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainer:** reviews and merges ordinary changes and keeps project documentation
  accurate.
- **Security maintainer:** handles confidential vulnerability reports and reviews
  changes to trust boundaries.
- **License maintainer:** reviews source, asset, dependency, license, provenance, and
  notice obligations.
- **Build maintainer:** owns reproducible builds, protected automation, signing, and
  artifact attestations.
- **Governance maintainer:** maintains public decision rules, repository controls,
  role assignments, and conflicts records.
- **Release manager:** freezes a candidate, verifies independent approvals, and
  authorizes a release under [RELEASING.md](RELEASING.md).
- **Independent reviewer:** reviews evidence they did not produce and records an
  approve or reject decision for the exact candidate.
- **Conduct moderator:** handles community-conduct reports independently and
  confidentially.

A person may hold multiple roles for routine work, but no one may independently
approve evidence they alone produced for a security, provenance, or release gate.

### Initial public-source bootstrap

Before a maintainer roster exists, the hosting account's repository administrator may
perform one one-time publication of an honestly labeled development source snapshot.
That bootstrap requires a new one-root clean-room history, passing privacy, provenance,
license, dependency, security, and CI gates, plus independent technical and provenance
reviews of the exact tree. The reviewers need not be project maintainers and gain no
ongoing authority. This exception does not open contribution intake, enable a binary
release, create a support promise, or authorize signing.

## Decisions

Ordinary reversible changes require passing checks and approval from one uninvolved
maintainer. The following require at least two approvals, including the relevant role:

- changes to an authorization, credential, deletion, sandbox, process, browser,
  signing, update, or release boundary;
- new third-party or generated content;
- governance or code-of-conduct enforcement changes;
- default-branch protection changes; and
- any binary release or later supported source release.

Security fixes may be prepared privately by authorized security maintainers. Their
eventual public change still requires a non-sensitive audit trail and independent
review.

When maintainers disagree, they should record the technical options, risks, and
reversibility in the pull request. A decision proceeds only when its required
approvals are present; otherwise the status quo remains. There is no casting-vote
owner in this snapshot.

## Maintainer appointment and removal

The first roster is a one-time bootstrap action. After a canonical public repository
exists, its lawfully authorized administrators may nominate the initial maintainers
in a pull request. That change requires review by at least one qualified person who
did not prepare it, must record the administrator authority and selection rationale
without private data, and must update [MAINTAINERS.md](MAINTAINERS.md) and CODEOWNERS
together. It cannot authorize a release by itself.

After at least two maintainers are assigned, later appointments require approval by
two existing maintainers and the governance maintainer. Candidates must demonstrate
sustained, safe contributions and agree to the project's security, privacy,
provenance, conduct, and sign-off policies.

A maintainer may step down at any time. Two uninvolved maintainers may suspend access
for compromised credentials, inactivity that leaves a critical role uncovered, or a
documented policy violation. Conduct allegations must follow the code-of-conduct
process and conflicts must be disclosed.

## Repository controls

Before accepting contributions, administrators must configure:

- a protected default branch with no force-push or deletion;
- required, named checks on the exact merge revision;
- at least one independent review and code-owner review where applicable;
- dismissal of stale approvals after relevant changes;
- restricted workflow and environment permissions;
- private vulnerability reporting and a tested private conduct route; and
- short-lived, least-privilege release credentials.

Configuration in the hosting service is evidence that must be reviewed separately;
documentation alone does not enable these controls.

## Project assets and funds

No project entity, treasury, donation program, sponsorship program, trademark owner,
or commercial steward is declared. A future change must identify and review any such
arrangement rather than implying one.
