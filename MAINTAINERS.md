# Maintainers

No public maintainer identity is assigned in this snapshot. The hosting account's
repository administrator may perform the one-time source-only bootstrap described in
[GOVERNANCE.md](GOVERNANCE.md), without being named in source or receiving release authority.

| Role | Assignment | Required before |
|---|---|---|
| Repository administrator | Hosting account owner, not named in source | One-time public-source bootstrap and repository controls |
| Maintainer | Vacant | Accepting or merging contributions |
| Security maintainer | Vacant | Triaging, disclosing, or releasing a confidential security report |
| License maintainer | Vacant | Approving source, asset, dependency, license, provenance, and notices |
| Build maintainer | Vacant | Approving build and signing automation |
| Governance maintainer | Vacant | Approving governance and repository-control changes |
| Release manager | Vacant | Freezing or publishing a candidate |
| Independent reviewer | Vacant | Approving evidence produced by another role |
| Conduct moderator | Vacant | Opening community participation |

Because these roles are vacant:

- no person is authorized by this file to merge contributions, publish binaries, sign,
  or speak for the project;
- no response time is promised;
- no CODEOWNERS rule can truthfully name an owner; and
- [AUTHORS](AUTHORS) uses a non-personal collective label and does not assign a
  maintainer or legal entity.

During the one-time source-only bootstrap, the repository administrator may enable
and test GitHub Private Vulnerability Reporting and hold any received report without
promising a response. The administrator must not triage, disclose, close, or release a
report until a security maintainer is appointed.

The comment-only `.github/CODEOWNERS` file intentionally creates no ownership rule.
When maintainers are appointed under [GOVERNANCE.md](GOVERNANCE.md), update both files
in the same reviewed change using public GitHub handles or teams whose owners have
agreed to publication.
