# Maintainers

Prime Studio is in an owner-directed development phase. The public repository owner,
[`@Nice6042`](https://github.com/Nice6042), is the development maintainer for routine source work,
repository administration, and protected-branch maintenance. This assignment does not grant
security-disclosure, licensing, signing, independent-review, or release authority.

| Role | Assignment | Authority |
|---|---|---|
| Repository administrator | `@Nice6042` | Repository settings, protected branches, and owner-directed source administration |
| Development maintainer | `@Nice6042` | Review and merge routine reversible source changes after required checks pass |
| Security maintainer | Vacant | Required before confidential vulnerability triage, disclosure, or security-release approval |
| License maintainer | Vacant | Required before approving new source/asset provenance, dependency licensing, and release notices |
| Build maintainer | Vacant | Required before approving reproducible-build, signing, or protected release automation |
| Governance maintainer | Vacant | Required before opening general contribution intake or changing long-term governance controls |
| Release manager | Vacant | Required before freezing or publishing any supported candidate |
| Independent reviewer | Vacant | Required for evidence that must be reviewed by someone other than its producer |
| Conduct moderator | Vacant | Required before opening public community participation |

## Current operating boundary

- Owner-directed source development and pull requests may proceed under the required CI and branch
  rules.
- External contribution intake, Issues, and Discussions remain closed until a second qualified
  maintainer and a tested conduct route are appointed.
- The development maintainer may prepare security-, installer-, updater-, and release-related code,
  but cannot independently approve those capabilities for distribution or production use.
- No person is authorized by this file to publish binaries, sign artifacts, promise support, or
  speak for a legal entity or commercial steward.
- `Prime Studio Contributors` remains a non-personal collective source label; it is not a company,
  copyright transfer, or maintainer identity.

The comment-only `.github/CODEOWNERS` file intentionally remains non-authoritative while there is
only one development maintainer. Requiring that same account to approve its own most recent push
would create a false independence claim. Appointing a second maintainer must update this file,
[GOVERNANCE.md](GOVERNANCE.md), CODEOWNERS, and the protected-branch review requirements in one
reviewed change.

During this phase, the repository administrator may enable and test GitHub Private Vulnerability
Reporting and hold an incoming report without promising a response window. The administrator must
not represent the report as triaged, disclose it, close it as resolved, or authorize a release until
a security maintainer and independent reviewer are appointed.
