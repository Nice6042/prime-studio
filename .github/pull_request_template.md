## Summary

<!-- Describe one focused change and why it is needed. -->

## Verification

<!-- List exact commands and results. Do not paste sensitive logs. -->

- [ ] Relevant frontend tests pass.
- [ ] Relevant Rust tests pass.
- [ ] `git diff --check` passes.
- [ ] Browser-shell or native checks are included when the changed boundary requires them.

## User impact

<!-- Describe user-visible behavior, compatibility, migration, data, security, privacy, performance, and accessibility impact. Write "None" only with a brief reason. -->

- [ ] Activated and unavailable capabilities remain described truthfully.
- [ ] Any data migration, deletion, upgrade, rollback, or recovery behavior is documented.

## Trust and data boundaries

- [ ] I did not add credentials, personal data, account data, private identifiers, or local absolute paths.
- [ ] Destructive tests use only a verified disposable root with synthetic data.
- [ ] The change does not weaken authorization, bounds, path containment, process policy, or fail-closed behavior without explicit security review.
- [ ] User-facing capability and privacy claims match reachable production behavior.

## Provenance

- [ ] All submitted content is original, or exact-path provenance and required license/notice material are included.
- [ ] Generated files include their reviewed source chain.
- [ ] No private Git history or unreviewed binary artifact is included.

## Dependencies and supply chain

<!-- State "No dependency changes", or list every package, action, lockfile, build download, generated asset, or separately installed runtime change required by DEPENDENCIES.md. -->

- [ ] No dependency or supply-chain input changed; or the exact source, resolved version/commit, license, provenance, advisories, lifecycle behavior, shipped form, and user/build impact are documented.
- [ ] Declaration and lockfile changes are paired and were generated with the documented package-manager command.
- [ ] Required notice, SBOM, and independent-review updates are included or explicitly remain release-blocking.

## Contribution identity

Select the one applicable state:

- [ ] Curated public contribution intake is active, and every new contribution commit contains a Developer Certificate of Origin `Signed-off-by` line for an identity I am authorized to publish.
- [ ] This is pre-cutover private development; mandatory DCO sign-off is not active, and this change makes no public contributor-identity claim.
