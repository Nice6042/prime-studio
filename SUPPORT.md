# Support

Prime Studio has no supported release, service-level commitment, paid support,
official installer, or guaranteed maintainer response. The repository is suitable for
source review and development experimentation only.

## Appropriate public requests

After a public issue tracker exists, use it for:

- reproducible source-build failures on the documented Windows toolchain;
- deterministic test failures;
- documentation corrections; and
- feature proposals that clearly acknowledge the current fail-closed boundary.

Use the provided issue templates and synthetic data. Include the commit identifier,
Windows version, Node.js version, Rust toolchain output, exact command, and a minimal
non-sensitive error excerpt.

## Requests the project cannot handle publicly

Do not use public issues for:

- vulnerabilities or privacy incidents;
- credentials, account records, provider responses, or session content;
- private repository history, private task identifiers, or local absolute paths;
- recovery of important data;
- help with a third-party service account or billing issue; or
- claims about an unofficial binary from another distributor.

Follow [SECURITY.md](SECURITY.md) for sensitive reports. Contact the relevant provider
or runtime project for its own service, account, or billing support.

## Troubleshooting checklist

Before filing a non-sensitive issue:

1. Confirm that the problem concerns a checked-in development boundary rather than a
   capability listed as unavailable in [README.md](README.md). Live Prime and provider
   capabilities are currently unavailable by design.
2. Reproduce from a clean checkout after running `cd app` and `npm ci`.
3. Run the smallest relevant check from [TESTING.md](TESTING.md).
4. Remove real data and replace it with a synthetic reproducer.
5. Search existing issues for the exact error.

An unanswered request is not an indication that a feature or workaround is safe.
