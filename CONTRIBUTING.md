# Contributing to Prime Studio

Prime Studio is an unsupported development snapshot. Contributions may be reviewed
only after the public repository has assigned maintainers and enabled the controls in
[GOVERNANCE.md](GOVERNANCE.md). Until then, a submitted change may remain unanswered.

## Issues and contributions are closed during bootstrap

Issues, Discussions, and contribution intake remain disabled until maintainers are
appointed and the repository has a tested conduct route. Do not put credentials,
private paths, account data, session content, personal data, or unannounced security
findings in any public channel. Follow [SECURITY.md](SECURITY.md) for security-sensitive
reports.

## Development setup

Requirements:

- Windows 11 for native development and verification;
- Node.js 22.12 or later within the 22.x LTS line;
- Rust stable and the Tauri v2 build prerequisites;
- Git with line-ending behavior understood for the files being changed.

Clone only from the canonical repository page hosting this file; mirrors and forks are
not authoritative. From the checkout:

```powershell
cd app
npm ci
npm run install:browser-shell-chromium
npm run test:browser-shell:strict
```

This source snapshot intentionally does not hard-code a personal owner or account
identifier. The mocked browser shell is the default UI-development boundary. It does
not load the native backend or real user data. Native launch is permitted only with
the explicit disposable environment in [TESTING.md](TESTING.md#native-development-window).

## Make a focused change

1. Start from the current default branch.
2. Keep each change limited to one reviewable purpose.
3. Add or update tests for behavior changes.
4. Use synthetic fixtures. Never capture a real account, credential, session, local
   path, provider response, or usage record.
5. Update documentation when a public interface, trust boundary, test command, or
   limitation changes.
6. Run the checks in [TESTING.md](TESTING.md).
7. Complete the pull-request checklist.

Protocol fields and event ordering must be verified against an authorized,
disposable probe and documented in `PROTOCOL.md`; do not guess them. Probe evidence
must be reduced to deterministic synthetic fixtures before it enters Git.

## Security and filesystem rules

- Elevated effects remain unavailable unless a trusted verifier supplies explicit
  enforced readiness. Do not add a UI or test-only bypass.
- Never read, log, echo, serialize, or include credential values in errors. Tests may
  use clearly synthetic, non-usable values.
- Destructive tests must use a newly created disposable root whose resolved path is
  checked before use. Never aim them at an existing Prime profile.
- Keep Windows-only behavior behind the appropriate target configuration.
- Fail closed on malformed, oversized, ambiguous, or partially trusted input.
- Do not weaken bounds, identity checks, path-containment checks, process-environment
  allowlists, or pre-dispatch authorization without a focused security review.

## Provenance rules

All submitted bytes need a known origin and redistribution basis.

- Do not copy code, text, icons, fonts, screenshots, fixtures, generated bundles, or
  branding from another project without an exact-path provenance review.
- Identify generated files and include their source chain.
- State whether a change is original, adapted, or copied in the pull request.
- Preserve required license and notice text in the same change.
- Do not use private repository history as the source of a public patch.

Changes to packages, lockfiles, build downloads, or workflow actions must follow
[DEPENDENCIES.md](DEPENDENCIES.md). A pull request must identify user impact and
whether dependencies are added, removed, or changed.

## Public-history sign-off

The mandatory sign-off policy begins only after the repository is opened for public
contributions. Do not add invented sign-offs, rewrite identities, or infer permission
to publish an identity.

After public contribution intake is explicitly activated, every new contribution
commit must include a Developer Certificate of Origin sign-off. Create it with
`git commit -s`, then verify that the generated identity is one you are authorized to
publish. By signing off, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Use an
identity and address you are authorized to publish in Git history. The project does
not currently claim that public contribution intake or automated DCO enforcement is
active. Once activated, missing sign-offs are a review blocker for new public
contributions.

For a new public contribution after intake is activated, unless stated otherwise for
a reviewed imported path, you agree that the contribution may be distributed under
the repository's MIT license terms. This is not a representation that every
pre-existing path has completed provenance review.

## Pull requests

A pull request is not mergeable until:

- required checks pass on the exact revision;
- at least one independent authorized maintainer approves it;
- security-sensitive changes receive security review;
- imported or generated content receives provenance review;
- all review discussions are resolved; and
- the branch is current under the repository's configured merge policy.

For a public contribution after cutover, the sign-off policy above is an additional
merge condition. It does not apply retroactively to the current private history.

No maintainer or CODEOWNER is currently assigned in this snapshot, so these
conditions cannot yet be satisfied. See [MAINTAINERS.md](MAINTAINERS.md).

## What not to include

Do not submit secrets, personal data, private identifiers, local absolute paths,
private issue or task identifiers, unredacted crash dumps, production logs, real
account aliases, signed artifacts, signing material, or third-party content without
reviewed provenance.
