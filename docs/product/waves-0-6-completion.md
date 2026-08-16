# Waves 0–6 implementation and evidence ledger

This ledger separates checked-in implementation from evidence that can only be produced on a
specific Windows host, against a specific installed Prime closure, provider account, foreground
window, signing identity, or release authority. A green fixture or fake-daemon test must never be
promoted into evidence for one of those external identities.

## State vocabulary

| State | Meaning |
|---|---|
| `SOURCE_COMPLETE` | The reviewed source path and its fail-closed behavior are checked in |
| `CI_VERIFIED` | Required repository workflows exercise the checked-in path successfully |
| `HOST_VERIFICATION_REQUIRED` | A disposable Windows run against the exact installed identity is still required |
| `UPSTREAM_UNAVAILABLE` | The reviewed Prime contract cannot express the requested authority |
| `WORKER_UNAVAILABLE` | Admission and safety contracts exist, but no production effect worker is bound |
| `INDEPENDENT_APPROVAL_REQUIRED` | A person or credential outside the source change must approve the action |

## Summary

| Wave | Repository state | External boundary |
|---|---|---|
| 0. Restore a trustworthy baseline | `SOURCE_COMPLETE`, `CI_VERIFIED` | None for source merge |
| 1. Exact Prime runtime vertical slice | `SOURCE_COMPLETE`, `CI_VERIFIED`, `HOST_VERIFICATION_REQUIRED` | Real installed runtime and provider-backed session |
| 2. Provider/account/model/usage truth | `SOURCE_COMPLETE`, `CI_VERIFIED`, `UPSTREAM_UNAVAILABLE`, `HOST_VERIFICATION_REQUIRED` | Resident-create identity selection is not exposed by the reviewed daemon contract |
| 3. Browser and computer-use authority | `SOURCE_COMPLETE`, `CI_VERIFIED`, `WORKER_UNAVAILABLE` | A separately reviewed production worker and host evidence are required before effects |
| 4. Independent product gaps | `SOURCE_COMPLETE` for the rows promoted by this branch; catalog remains fail-closed | Bridge- and worker-dependent rows remain partial or unavailable |
| 5. Architecture and quality gates | `SOURCE_COMPLETE`, `CI_VERIFIED` for the changed boundaries | Further decomposition is maintenance work, not release evidence |
| 6. Distribution and release controls | `SOURCE_COMPLETE`, `CI_VERIFIED`, `INDEPENDENT_APPROVAL_REQUIRED` | Signing, credentials, release roles, clean build evidence, and publication approval |

## Wave 0 — baseline repair

Delivered:

- deterministic focus restoration after a selected child disappears;
- strict browser/accessibility coverage with zero retry masking;
- Rust 1.97 formatting and Clippy conformance;
- green frontend, source-policy, Windows Rust, browser, dependency, and security workflows.

A regression is not closed merely because a retry passes. The required browser job remains a
zero-retry gate.

## Wave 1 — exact runtime activation

Delivered:

- startup activation through the native authority boundary;
- reviewed exact profiles for `prime-agent` 0.7.2/schema 16 and 0.7.1/schema 13;
- package, CLI, entrypoint, daemon, Node, schema, capability, sidecar, and adapter closure checks;
- newest-first profile selection without a permissive fallback;
- resident create, attach, project, prompt, streaming, abort, reconnect, paging, branch, child,
  usage, queue, tool, context, and artifact contracts behind the verified broker;
- fail-closed rejection of an unsupported or changed identity.

Evidence still required on a disposable Windows profile:

1. discover one exact reviewed installation;
2. complete activation without a profile or digest mismatch;
3. create or attach a resident session;
4. send, stream, abort, reconnect, and stop;
5. preserve the resulting redacted logs and runtime identity evidence.

The repository must not manufacture this evidence from the fake daemon.

## Wave 2 — providers, accounts, models, and usage

Delivered:

- credential-free account registry and auth-health projection;
- explicit Prime CLI login handoff rather than credential capture in Studio;
- hardened add, remove, sign-out, refresh, local ledger, and quota/cost separation paths;
- model and thinking controls that activate only when the admitted current session reports the
  relevant catalog and command authority;
- account-wide usage isolated from current-chat usage;
- truthful disabled reasons when a provider or quota authority is absent.

Upstream contract boundary:

- the reviewed resident-create request cannot select an account, provider, model, or thinking
  default for a new resident session;
- Studio therefore does not pretend that an account-row selection owns resident creation;
- adding that behavior requires a reviewed Prime contract/profile update, not a renderer-only
  workaround.

## Wave 3 — browser and computer use

Delivered:

- a native readiness projection with explicit unavailable and verified states;
- bounded capabilities for browser inspection, screenshots, computer observation, clicking, and
  text entry;
- identity-bound operation, session, chat, target, worker, issue time, and expiry fields;
- explicit grants for mutating effects;
- replay, lease expiry, worker mismatch, capacity, malformed request, and oversized evidence
  rejection;
- bounded evidence digests and operation retirement;
- a frontend projection that cannot convert a security contract into dispatch authority.

Not shipped:

- a production `VerifiedInteractionWorker`;
- browser navigation, capture, download, or form-effect dispatch;
- foreground-window computer observation, click, or typing dispatch.

Those effects remain unavailable until a worker implementation, worker identity closure,
cancellation/takeover behavior, host tests, and independent security review are present.

## Wave 4 — product acceptance closure

The machine-derived package catalog at this branch contains:

- **72 complete** rows;
- **41 partial** rows;
- **0 placeholder** rows;
- **0 missing** rows;
- **2 explicitly unavailable** rows.

This branch newly closes, with direct implementation and tests:

- `CP-06`: slash autocomplete filtering, active choice, keyboard movement, and execution;
- `ST-12`: shortcut settings generated from the same command registry that executes commands;
- `CV-15`: archived transcripts remain read-only and can create a distinct verified resident
  branch without restoring or mutating the source chat.

Bridge-dependent rows remain in `PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS` and cannot be promoted
from component, fixture, or fake-daemon evidence. Attachment admission remains partial because
metadata chips are not native file authority and the reviewed prompt contract does not admit
attachments. Browser/computer controls remain unavailable because no production effect worker is
bound.

## Wave 5 — architecture and quality

Delivered for the changed paths:

- typed renderer, durable, native, and Harness dispatch boundaries;
- fail-closed transport decoders and immutable projections;
- deterministic frontend tests and strict browser/accessibility checks;
- Rust format, Clippy, tests, locked builds, and Windows installer policy;
- dependency review, npm audit, locked dependency policy, notices, SBOM, source provenance, and
  bundle budgets;
- an identity-bound interaction broker separated from renderer dispatch;
- exact runtime profiles separated from activation and broker execution.

`StudioApp` and the native root module still contain broad orchestration responsibilities.
Further decomposition must be incremental and behavior-preserving; it is not a reason to weaken
current authority checks or delay a source-only merge whose required gates are green.

## Wave 6 — distribution and release

Delivered:

- fail-closed release-readiness policy;
- Windows installer content policy;
- deterministic third-party notices and locked SPDX SBOM;
- source publication controls and personal/captured-fixture residue checks;
- explicit separation between a local development artifact and an official release.

Still independently gated:

- clean-room build provenance and post-build bundle reconciliation;
- code-signing identity and protected credentials;
- update-feed signing and rollback policy;
- staffed build, security, release, and independent review roles;
- final binary review and publication approval.

No source commit may mark those gates complete on behalf of the missing people, machines, or
credentials.

## Merge criterion

The source branch may merge when all required CI and Security workflows are green and the PR diff
contains no temporary patch machinery. Merge does **not** create a release, attest a real provider
session, or authorize browser/computer effects. Those claims require their own evidence and
approval records.
