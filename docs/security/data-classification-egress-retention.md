# Prime Studio data classification, egress, and retention

**Scope:** current public source tree; no historical commit identity grants authority
**Default:** local-first, least-egress, explicit destination/account/category consent
**Important:** the current tree has account/profile plumbing and usage readers, not a complete application database, egress broker, retention scheduler, or lossless export pipeline.

Status vocabulary: `implemented` is directly evidenced in the current tree; `planned` is documented but not present or proven; `blocked` must remain unavailable until its storage/egress/retention evidence passes.

## Classification

Classification is applied before persistence, indexing, export, or external transmission. A scanner is defense in depth, not proof that content is safe; scanner failure blocks automatic indexing or memory persistence and records the scanner version/limitation.

| Class | Examples | Default handling | External egress | Retention/export |
|---|---|---|---|---|
| `C0 — public` | Public documentation, source already marked public, user-selected public artifact | May be indexed locally and included in a user-selected export | Only to the named provider/connector/destination approved for the operation | Ordinary local retention; exportable with provenance. |
| `C1 — operational metadata` | Account ID/label/provider, model ID, health state, timestamps, non-secret paths, usage facts | Store only fields needed for the feature; do not infer secrets from absence/presence metadata | May accompany a request only when required by the named destination and grant | Normalized fields may be exported; raw diagnostics remain separate and bounded. |
| `C2 — project/user content` | Source text, prompts, chat messages, tool results, attachments, diffs, generated artifacts | Local by default; respect Git ignore plus Studio exclusions; eligible reads are exact-path/range/digest recorded | Never implied by selecting a folder. A provider/account, attachment category, tool-result category, and destination must be approved before first egress | User-controlled local retention; source/provenance closure is required for lossless backup/export. |
| `C3 — sensitive/secret-bearing` | OAuth tokens, refresh tokens, passwords, API keys, cookies, OTPs, payment values, clipboard secrets, recognized credential files | Never intentionally stored in Studio DB, memory, logs, diagnostics, IPC, default export, or automatic memory; provider-owned auth remains in Prime profile storage | Never intentionally sent as context; secret handles may be used by a typed broker without exposing values | Deletion claims exclude provider-side, external, backup, synchronized, Windows journal, and forensic remnants. |
| `C4 — security/provenance` | Raw Prime journal bytes, immutable blobs, broker tickets/epochs, approval evidence, crash/recovery records, release evidence | Separate from normalized user data; integrity/length/schema/reachability checked; sensitive fields redacted where possible | No inference/analytics egress by default; named security/release destination only | Retention-limited, versioned policy required; excluded from default exports unless needed for a user-requested lossless provenance export. |
| `C5 — ephemeral browser/desktop state` | Browser cache/cookies/page state/downloads, screenshots before redaction, UIA/clipboard buffers, worker staging | Keep inside isolated worker/profile/staging roots; do not treat as trusted instructions; capture may be disabled for sensitive origins | Only the selected, redacted, category-approved result may leave the worker | Ephemeral cleanup is required but cannot claim that all browser disk remnants are erased; screenshots/actions are redacted before durable Studio storage. |

## Egress policy

Every egress record must bind:

`principal` (provider account or connector account) + `destination` (provider/host/origin) + `purpose` + `data categories` + `grant ID/generation` + `source records/ranges` + `timestamp`.

| Egress path | Default | Additional rule | Current status |
|---|---|---|---|
| Studio-owned DB/index/cache → local disk | Allowed only within Studio-owned paths and policy scope | Transactional writes; user can inspect/export/delete; protected roots are excluded | **planned; blocked**; no application DB/index exists in baseline. |
| Project read → Claude account | Not implied by project access | First egress requires account + exact outbound categories + destination/purpose approval | **planned; blocked**; current account/session plumbing is not an egress broker. |
| Project read → ChatGPT/Codex account | Not implied by project access | Separate account principal and independent consent; provider switch re-evaluates before first egress | **planned; blocked**. |
| Automatic cross-provider delegation | Denied unless already approved | Lead/child graph cannot broaden data categories; otherwise run ends blocked before action | **planned; blocked**. |
| Tool result/attachment → provider | Denied by default for each category | Tool-result and attachment categories require explicit approval even if prompt text was approved | **planned; blocked**. |
| Typed remote connector/API | Denied until typed binding exists | Bind account, operation, destination, data categories, and secret-handle use; direct connectors are preferred over screen automation | **planned; blocked**. |
| Built-in browser → external web origin | Brokered and origin-scoped | Canonical scheme/host/port; recheck redirects, frames, popups, DNS/rebinding, target replacement | **planned; blocked**; browser worker absent. |
| Existing Chrome → web origin | Denied until explicit connection/domain grant | Existing Chrome is a separate trust boundary; visible control and takeover are mandatory | **planned; blocked**; bridge absent. |
| Search/analytics/crash telemetry | Off by default | Separate opt-in from inference consent; list destination/fields; local-only refuses unverifiable resident worker telemetry-off state | **planned; blocked**; no attested telemetry policy. |
| Current `export_html` transcript export | Explicit user action | Presentational HTML transcript only; exclude auth and do not describe it as a lossless backup or source-closure export | **implemented** as a prototype path; privacy/release guarantees remain **planned; blocked**. |
| Future lossless backup/source-closure export | Explicit user action | Exclude auth; include complete reachable Prime source closure; verify manifest/semantic round trip | **planned; blocked**; no DB/source-closure pipeline. |
| Future synchronization/cloud execution | Not implemented | Must be a new, separately reviewed egress class; it cannot be silently enabled by local features | **planned; blocked** by scope. |

## Retention and deletion rules

The documented security requirements need retention limits, but do not authorize inventing a universal numeric duration. Before any production data store is enabled, each raw/normalized/ephemeral class must have a versioned retention policy with owner, deletion trigger, legal/operational exception, and verification evidence.

Required behavior:

- Normalized Studio entities use stable identifiers independent of display names or mutable filesystem paths and carry schema version/timestamps.
- Raw diagnostic records are sensitivity-tagged, stored separately, retention-limited, and excluded from default exports.
- The authoritative Prime execution source is a verified closure of journal bytes, transitively referenced immutable blobs, and a manifest. The projection never substitutes a normalized transcript for missing evidence.
- A backup takes one transactional fence over SQLite revision, stream identities/cursors, and reachable blobs. A failed consistent cut fails the backup; it must not combine independently timed copies.
- Restore verifies manifests, lengths, digests, schemas, reachability, and semantic round trip before activation and enters recovery on missing/corrupt objects.
- `Delete all Studio data` may claim deletion only for Studio-owned DB/indexes/caches, managed browser profiles, unreferenced artifacts, and Studio-owned Prime profiles. It must report but not claim deletion of provider-side data, external CLI/Prime profiles, user backups, synchronized copies, Windows journals, or forensic remnants.
- Provider credentials are excluded from Studio backups/exports and remain in Prime account-specific authentication storage.

The narrow, enforced account-removal transaction is an explicit account-management exception to the general read/export-only posture. It proves only its own account identity, journal/quarantine, and recovery boundary; it does not make `export_html`, future lossless export, project deletion, or provider-side deletion complete.

## Export boundary

The current `export_html` command renders a transcript for presentation. It does not close over the authoritative Prime journal, transitively referenced blobs, normalized Studio records, or source provenance required for a lossless backup. A future lossless source-closure export must use a transactional fence and the readiness/oracle record contract; until then it is `planned`/`blocked`.

## Current baseline evidence

| Evidence | What it proves | What it does not prove |
|---|---|---|
| `app/src/types.ts:187-269` | Account registry model and auth health cross the bridge without credential fields/values. | Complete egress consent or retention enforcement. |
| `ACCOUNTS.md:25-38,89-118` | Profile-scoped Prime home, credential-presence/expiry metadata, and per-account usage design. | Provider-side data deletion or a Studio-owned durable source closure. |
| `PROTOCOL.md:154-176` | Prime session paths/usage/event shape and known protocol limits. | Safe retention, redaction, or replay guarantees. |
| `app/src-tauri/src/accounts/delete.rs` and 71 Rust tests | Identity-bound account deletion/recovery path. | General filesystem, browser, connector, or executor containment. |
| `app/src/components/ChatPane.tsx:176-179` | Current `export_html` transcript command exists. | Lossless backup, source-closure completeness, or deletion of provider/external copies. |
| `docs/security/readiness-oracle-record.schema.json` | Defines the required effect/oracle/fixture, closure, epoch, terminal-state, and environment-boundary fields. | It does not itself authorize an effect. |

## Blocked claims

Until the broker, storage, and export tests exist, Prime Studio must not claim that it:

- knows or deletes every copy of a provider/user record;
- can safely index or transmit every file in a selected folder;
- can redact every secret from browser disk, screenshots, logs, or provider responses;
- can recover a complete conversation from a normalized transcript alone;
- has disabled analytics/telemetry for a resident worker unless that state is attested;
- treats a provider account switch as safe without a fresh data-category egress check;
- treats current `export_html` as a lossless source-closure backup;
- treats the implemented account-removal exception as proof of broad `Delete all Studio data` coverage.
