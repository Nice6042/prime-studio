# Provider and session capability truth

This matrix separates account-registry capabilities from verified resident-session capabilities.
A visible account or successful OAuth login is not evidence that the current daemon can select
that account for a new resident session.

| Capability | Authority | Current result |
|---|---|---|
| Add, rename, remove, and list account profiles | Native account registry | Available through bounded credential-free metadata |
| Interactive Claude or ChatGPT/Codex login | Prime CLI in a visible terminal | Available; credential values never enter renderer projections |
| Account auth health | Native bounded auth metadata read | Available or explicitly unavailable/stale |
| Local account usage and API-equivalent cost | Native bounded session ledger | Available when the ledger validates; invalid or oversized rows fail closed |
| Subscription quota | Provider-specific observed evidence | Available only when reported; otherwise explicit unavailable |
| Select account/provider for resident creation | Prime daemon resident-create contract | Upstream unavailable: the reviewed contract accepts workspace and title only |
| Select model and thinking for the current admitted session | Verified daemon model catalog and session operations | Available when the attached session reports the option and returns an authoritative snapshot |
| Persist model/thinking/account defaults for future residents | Prime daemon resident-create contract | Upstream unavailable until creation accepts and proves these identities |

Shared account directories are read once. Provider-separated rows can be attributed by provider;
multiple account rows for the same provider and directory remain explicitly unattributed rather
than repeating one ledger total under each account.
