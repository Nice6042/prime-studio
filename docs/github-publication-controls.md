# GitHub source-publication controls

Status: **source-only bootstrap**. It applies only to the explicitly authorized initial
public source snapshot. Releases, packages, Pages, workflow artifacts, installers,
executables, signing, and update payloads remain out of scope.

## Stop before publication

Do not publish the current staging history. Export the approved tracked tree into a
new standalone repository with one root commit and no shared objects, alternates,
private refs, reflogs, tags, remotes, hooks, or copied `.git` state. The bytes pushed
to GitHub must come only from that final clean-room repository. Do not clone, mirror,
fork, bundle, graft, or push from the private repository.

The exact clean-room root must pass the existing privacy, package-identity, notice,
SBOM, and release-readiness tests plus the validator below. A pinned secret scanner
must separately scan the full clean-room object store and checked-out tree. Any
private-history remediation evidence stays outside public Git and cannot authorize a
binary release.

```powershell
cargo fetch --manifest-path .\app\src-tauri\Cargo.toml --locked --target x86_64-pc-windows-msvc
node --test tests/open-source-release-readiness.check.mjs `
  tests/public-fixtures-privacy.check.mjs `
  tests/public-package-identity.check.mjs `
  tests/third-party-artifacts.test.mjs `
  tests/github-publication-controls.test.mjs
node scripts/validate-github-publication-controls.mjs --root . --json
```

The fetch step populates the exact locked Windows graph before the notice/SBOM test
switches Cargo to offline mode. It changes no lockfile and is required in a fresh
checkout or empty Cargo cache.

The validator must report zero findings only inside the standalone one-commit
clean-room repository. A private staging checkout is expected to fail the history-shape
checks and must never be used as a push source.

## Account checks that must be done in the UI

Do not infer two-factor authentication from repository API access or token scopes, and
do not broaden a token merely to automate this check.

1. In GitHub **Settings > Password and authentication**, visibly confirm that 2FA is
   enabled, complete a fresh 2FA challenge, retain recovery methods privately, and
   record only a redacted pass/fail attestation. GitHub recommends TOTP or security
   keys and multiple recovery methods in its
   [2FA configuration guide](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication).
2. In **Settings > Notifications**, enable web and email delivery for security alerts.
   On the repository, choose **Watch > Custom > Security alerts**. GitHub documents
   the required subscriptions in
   [Managing security notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-security-notifications).

Neither check is complete from a CLI response alone.

## Truthful bootstrap boundary

Do not invent a maintainer, owner, company, author, security contact, or signing
identity. The initial publication may identify an authorized
`repository-administrator` operational role without presenting that administrator as
a project maintainer or copyright claimant. Before the one root is exposed, require:

- one independent technical review of the exact path-and-SHA-256 tree manifest; and
- one independent provenance/license/notice review of that same manifest.

Record non-personal actor identifiers and decisions in controlled evidence. This is a
narrow bootstrap exception for source hosting, not an appointment to a vacant role and
not a binary-release approval. Keep contribution intake, merges other than necessary
repository-control corrections, and every binary release blocked until the
corresponding roles in `MAINTAINERS.md` are staffed. Before private vulnerability
reporting is enabled, the repository administrator must test receipt and notifications
and accept interim custody of reports without promising a response window; appoint a
security maintainer before any report is triaged, disclosed, or released.

The governance documents permit only this narrow administrator bootstrap while all
maintainer roles remain vacant. They do not authorize contribution intake or releases.

## Repository settings

Create an empty repository without a README, license, `.gitignore`, starter commit,
template, import, mirror, or fork relationship. Where the account plan permits private
staging with the same controls, configure and validate the empty/private repository,
push the single reviewed root, allow CI to establish its check names, activate the
final ruleset, validate again, and only then make it public. Otherwise, the initial
single-root push uses the already authorized source-only bootstrap and must be followed
immediately by control validation. Make no second source push until every control below
validates.

Configure one active branch ruleset targeting `~DEFAULT_BRANCH` (`main`), with no
bypass actors:

- restrict deletions;
- block force pushes (`non_fast_forward`);
- require linear history;
- require a pull request before merging;
- require all review conversations to be resolved;
- require branches to be up to date before merging; and
- require exactly these seven status checks:

  1. `Source policy and acceptance`
  2. `Frontend checks`
  3. `Strict browser shell`
  4. `Rust checks (Windows)`
  5. `npm audit`
  6. `Locked dependency policy`
  7. `Dependency review`

Set required approving reviews to **0 while exactly one maintainer exists** so the
repository is not self-locked. Immediately after a second maintainer is appointed,
raise it to **1**, enable dismissal of stale approvals, and require approval of the
most recent reviewable push. GitHub describes deletion/force-push protection, linear
history, pull requests, conversation resolution, and status checks in
[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

Allow squash merging only. Disable merge commits and rebase merging so the permitted
merge path is unambiguous and linear.

Keep Issues and Discussions disabled until project maintainers are appointed and a
tested moderation/conduct route exists. Security reports use private vulnerability
reporting, never a public issue.

## Actions and fork controls

In **Settings > Actions > General**:

- enable Actions only for the checked-in workflows;
- set workflow permissions to **Read repository contents**;
- disable **Allow GitHub Actions to create and approve pull requests**;
- require actions to be pinned to a full-length commit SHA; and
- under fork pull-request workflow approvals, choose **Require approval for all
  external contributors**.

Every workflow must retain top-level `permissions: contents: read`, every `uses:` value
must use a 40-hex commit SHA, and `pull_request_target` must remain absent. GitHub states
that a full commit SHA is the only immutable action reference in its
[secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use),
and warns that first-time-contributor-only approval can be bypassed after an innocuous
merge in its
[repository Actions settings guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

## Security features

In **Settings > Advanced Security**:

- enable secret scanning and push protection, then require zero open secret-scanning
  findings or bypasses;
- enable the dependency graph, Dependabot alerts, and Dependabot security updates;
- retain `.github/dependabot.yml` for npm, Cargo, and GitHub Actions version updates;
- enable private vulnerability reporting and verify that **Security > Advisories**
  displays **Report a vulnerability**; and
- complete the account/repository security-notification checks above.

GitHub documents these controls in
[Enabling secret scanning](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning),
[Enabling push protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection),
[Configuring Dependabot alerts](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts),
[Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates), and
[Private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## No distribution surfaces

Before and after publication, verify all of the following:

- **Releases** is empty and no tags or release assets exist;
- **Packages** is empty for this repository;
- **Settings > Pages** has no source and the repository reports Pages disabled;
- workflows contain no publish, deploy, release, signing, attestation, package-upload,
  Pages, or artifact-upload job; and
- no executable, installer, archive, update payload, or other built artifact has been
  attached to GitHub. Locally built CI output is ephemeral and must not be uploaded.

The checked-in SPDX file and third-party notices are source review evidence, not a
GitHub package, release asset, or binary SBOM claim.

## Read-only post-configuration validation

After a repository exists, run the following from the final clean-room root. The
validator issues only GitHub REST `GET` requests; it does not create, update, delete,
push, publish, approve, or upload anything.

```powershell
node scripts/validate-github-publication-controls.mjs `
  --root . `
  --repo OWNER/REPOSITORY `
  --maintainers 1 `
  --json
```

Use `--maintainers 2` immediately after the second maintainer is appointed. The API
checks follow GitHub's official
[rulesets REST API](https://docs.github.com/en/rest/repos/rules),
[Actions-permissions REST API](https://docs.github.com/en/rest/actions/permissions),
and [repository REST API](https://docs.github.com/en/rest/repos/repos). A zero finding
count is necessary but not sufficient: attach the manual 2FA, security-notification,
package-absence, clean-room secret-scan, and independent-review evidence to the exact
root SHA before authorization.
