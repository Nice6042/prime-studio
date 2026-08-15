# Governance

Prime Studio is currently developed through an owner-directed public-source phase. The repository
owner is assigned as the development maintainer in [MAINTAINERS.md](MAINTAINERS.md), so routine
source work may proceed through protected branches and required checks. External contribution
intake, community participation, production-security approval, signing, and releases remain closed
until the additional roles below are staffed.

## Roles

- **Contributor:** proposes issues, documentation, code, tests, or reviews under
  [CONTRIBUTING.md](CONTRIBUTING.md) once contribution intake is opened.
- **Development maintainer:** reviews and merges ordinary reversible source changes and keeps
  project documentation accurate.
- **Security maintainer:** handles confidential vulnerability reports and reviews changes to trust
  boundaries.
- **License maintainer:** reviews source, asset, dependency, license, provenance, and notice
  obligations.
- **Build maintainer:** owns reproducible builds, protected automation, signing, and artifact
  attestations.
- **Governance maintainer:** maintains public decision rules, repository controls, role assignments,
  and conflicts records.
- **Release manager:** freezes a candidate, verifies independent approvals, and authorizes a release
  under [RELEASING.md](RELEASING.md).
- **Independent reviewer:** reviews evidence they did not produce and records an approve or reject
  decision for the exact candidate.
- **Conduct moderator:** handles community-conduct reports independently and confidentially.

A person may hold multiple roles for routine work, but no one may independently approve evidence
they alone produced for a security, provenance, signing, or release gate.

## Development phase

The current development maintainer may:

- prepare and merge owner-directed, reversible source changes after the required checks pass;
- maintain compatibility profiles, tests, documentation, and development-only verification tools;
- prepare security-, installer-, updater-, signing-, and release-related implementations while
  keeping their production/distribution authority disabled; and
- administer repository settings within the checked-in source-publication policy.

This phase does **not** authorize:

- general external contribution intake or a public support promise;
- confidential vulnerability triage or disclosure;
- independent approval of a trust-boundary change prepared by the same person;
- a production-capability, installer, updater, signing, or release claim; or
- publication of binaries, packages, workflow artifacts, or update payloads.

The development and release state must therefore remain separately reported. Passing tests may
prove a source implementation or a development fixture without promoting it to independently
approved production or release authority.

## Decisions

Ordinary reversible, owner-directed source changes require all protected checks to pass. While only
one development maintainer is assigned, the branch rules may require zero approving reviews so the
repository is not self-locked; this is not an independent-review claim.

The following require at least one qualified reviewer who did not prepare the evidence, plus the
relevant staffed role before their capability can be described as production-ready or released:

- changes to an authorization, credential, deletion, sandbox, process, browser, computer-use,
  signing, update, or release boundary;
- new third-party or generated content intended for distribution;
- governance or code-of-conduct enforcement changes;
- default-branch protection changes; and
- any binary release or supported source release.

A source implementation may be developed before those approvals exist, provided it remains
fail-closed and is documented as unapproved. Security fixes may be prepared privately only by an
authorized security maintainer. Their eventual public change still requires a non-sensitive audit
trail and independent review.

When maintainers disagree, they should record the technical options, risks, and reversibility in
the pull request. A gated decision proceeds only when its required approvals are present; otherwise
the previous production/release state remains in force.

## Maintainer appointment and removal

The repository owner may nominate an initial development maintainer through an owner-authorized
public change. That appointment opens owner-directed source development only; it cannot authorize a
release, security disclosure, signing key, or general contribution intake by itself.

Before external contribution intake opens, appoint at least one additional qualified maintainer and
a conduct moderator, update [MAINTAINERS.md](MAINTAINERS.md) and CODEOWNERS, require at least one
approval on protected pull requests, enable stale-approval dismissal and last-push approval, and
exercise the conduct and security-report routes.

After at least two maintainers are assigned, later appointments require approval by two existing
maintainers and the governance maintainer. Candidates must demonstrate sustained, safe
contributions and agree to the project's security, privacy, provenance, conduct, and sign-off
policies.

A maintainer may step down at any time. Two uninvolved maintainers may suspend access for
compromised credentials, inactivity that leaves a critical role uncovered, or a documented policy
violation. Conduct allegations must follow the code-of-conduct process and conflicts must be
disclosed.

## Repository controls

During owner-directed development, administrators must preserve:

- a protected default branch with no force-push or deletion;
- required, named checks on the exact merge revision;
- restricted workflow and environment permissions;
- full-SHA-pinned third-party actions;
- private vulnerability reporting; and
- blocked binary distribution surfaces.

Before accepting external contributions, additionally require at least one independent review and
code-owner review where applicable, dismissal of stale approvals, approval of the most recent
reviewable push, and a tested private conduct route. Configuration in the hosting service is
evidence that must be reviewed separately; documentation alone does not enable these controls.

## Project assets and funds

No project entity, treasury, donation program, sponsorship program, trademark owner, or commercial
steward is declared. A future change must identify and review any such arrangement rather than
implying one.
