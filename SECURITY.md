# Security Policy

## Supported versions

Prime Studio has no supported release, security-support window, or official binary.

| Version | Supported |
|---|---|
| Development source snapshot | No |
| Locally built artifacts | No |
| Official releases | None exist |

Security fixes may be developed on the default branch, but that does not create a
support commitment.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, exploit, credential, private path,
account record, session transcript, or personal data in a public issue or discussion.

Use GitHub Private Vulnerability Reporting only when the canonical repository's
**Security** page visibly offers **Report a vulnerability**. That route must be enabled
and tested as part of the source-only bootstrap. Until it is visible, retain the report
privately and do not send sensitive details to the project. Public Issues and
Discussions remain disabled during bootstrap.

The project does not currently offer a bug bounty, response-time guarantee, embargo
agreement, or CVE-assignment service.

## Report contents

After a confidential route exists, a useful report should contain:

- the affected commit or artifact hash;
- the impacted trust boundary;
- minimal reproduction steps using synthetic data;
- expected and observed behavior;
- impact and preconditions;
- whether the issue is already public; and
- a safe way to coordinate follow-up through the private report.

Do not include working credentials, real account data, unnecessary personal data, or
private repository history. Replace sensitive values with stable, non-reversible
labels.

## Security model

The current production backend is intentionally fail-closed. It begins with all
elevated effect classes unavailable, and no frontend command can promote readiness.
This is a safety boundary, not proof that the application is production-ready.

Important review surfaces include:

- Tauri IPC command classification and pre-dispatch authorization;
- process executable, argument, environment, and lifetime control;
- account-registry and profile deletion transactions;
- local path containment, link/reparse-point handling, and bounded reads;
- provider and RPC input validation;
- browser intent authorization and evidence binding;
- dependency, build, installer, signing, and update provenance; and
- publication-history and fixture sanitization.

Detailed engineering documents are under `docs/security/`. Their presence does not
replace an independent audit or release approval.

## Disclosure and release

A fix must not be described as released until it is present in a published,
authenticated artifact. There are currently no such artifacts. Security advisories,
release tags, signed installers, and public disclosure require authorized maintainers
and the gates in [RELEASING.md](RELEASING.md).
