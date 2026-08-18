# Prime Studio Windows host evidence review

This record reviews evidence collected on one Windows host. It is not a source-code review, an
automatic acceptance promotion, or a release authorization.

## Evidence intake

| Field | Value |
|---|---|
| Repository commit | `<40-character commit>` |
| Branch or detached state | `<value>` |
| Preflight SHA-256 | `<64-character digest>` |
| Bundle manifest SHA-256 | `<64-character digest>` |
| Host evidence classification | `HOST_COLLECTED_UNREVIEWED` |
| Collector version | `1` |
| Reviewer | `<independent reviewer>` |
| Review time, UTC | `<timestamp>` |
| Review disposition | `REJECTED`, `PARTIAL`, or `HOST_REVIEWED_NOT_RELEASED` |

Reject the intake if the commit or hashes do not match, the manifest contains an absolute path, an
included file is missing or has a different hash, a secret is visible, or excluded binary evidence
was silently substituted for reviewed text evidence.

## 1. Source build

**Decision:** `NOT_REVIEWED`, `ACCEPTED`, or `REJECTED`

Record:

- repository clean-state and changed-entry count;
- hashes of the six required package, Cargo, Tauri, and toolchain identity files;
- each requested frontend and Rust command, result, duration, and log hash;
- any failed, unavailable, or timed-out command without reinterpretation.

A passing source build does not prove an installed Prime closure or provider-backed session.

## 2. Exact Prime closure

**Decision:** `NOT_REVIEWED`, `ACCEPTED`, or `REJECTED`

Independent evidence must identify the exact:

- Prime package and package version;
- CLI executable or command shim and SHA-256;
- entrypoint and daemon identity;
- Node executable and SHA-256;
- protocol schema and capability set;
- reviewed sidecar and adapter profile;
- profile-selection result with no permissive fallback.

A successful `--version` probe alone is insufficient.

## 3. Activation and resident session

**Decision:** `NOT_REVIEWED`, `ACCEPTED`, or `REJECTED`

Record the activation result and prove that a resident session was created or attached through the
verified broker. Preserve redacted evidence for send, stream, abort, reconnect, and stop. Record
profile mismatch, digest mismatch, failed commands, and unknown outcomes as failures or unknowns;
do not retry them into a different historical result.

## 4. Provider and account session

**Decision:** `NOT_REVIEWED`, `ACCEPTED`, or `REJECTED`

Record only credential-free account identity and auth-health evidence. Confirm that no provider
secret, browser cookie, credential-store export, or environment dump entered the review bundle.
Do not claim that resident creation selected an account, provider, model, or thinking default unless
the exact reviewed Prime contract exposes and proves that authority.

## 5. Browser, computer-use, and interaction worker

**Decision:** `UNAVAILABLE`, `NOT_REVIEWED`, `ACCEPTED`, or `REJECTED`

Acceptance requires a separately reviewed production worker, exact worker identity, bounded lease,
explicit grant for mutating effects, replay prevention, cancellation and takeover behavior, target
binding, and independent host evidence. Admission-only source contracts or deterministic fixtures
cannot satisfy this section.

List each observed effect separately: navigation, capture, download, observation, click, and text
entry. Unknown or missing effects remain unavailable.

## 6. Installer and signing

**Decision:** `NOT_REVIEWED`, `UNSIGNED_DEVELOPMENT_CANDIDATE`, `ACCEPTED`, or `REJECTED`

Record MSI and NSIS hashes, installer scope, downgrade behavior, WebView2 policy, payload inventory,
uninstall retention checks, Authenticode state, signer identity, and clean-VM results. Unsigned
candidate evidence must remain explicitly non-publishable. Source policy cannot approve a signing
identity or protected credential.

## 7. Release authority

**Decision:** `NOT_AUTHORIZED` or `AUTHORIZED_BY_NAMED_RELEASE_ROLE`

Release authorization requires the repository's independent build, security, release, and review
roles; clean-build provenance; final binary reconciliation; signing; update-feed policy; and an
explicit publication decision. No collector, CI run, host operator, or source pull request may fill
this section on behalf of the missing authority.

## Findings and unresolved boundaries

Record every mismatch, exclusion, unknown outcome, unsupported upstream capability, unavailable
worker, missing signer, or missing reviewer. A `PARTIAL` disposition must enumerate exactly which
sections were accepted and which remain unreviewed or rejected.

## Final statement

The reviewer confirms that accepted sections are supported by the cited independent evidence and
that no unreviewed section was promoted by inference. `HOST_REVIEWED_NOT_RELEASED` means only that
the named host evidence was reviewed; it does not authorize publication.
