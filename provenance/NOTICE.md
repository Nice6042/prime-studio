# Prime Studio OSS provenance and NOTICE plan

Status: planning artifact only. This file records provenance and release gates; it is not an
import of source code or assets, and it is not a substitute for a final distributed third-party
notice.

Each external row below is pinned to a canonical URL and exact upstream revision. A moving branch
or tag is not an acceptable substitute. Local clone names and private audit identifiers are not
provenance evidence and are intentionally omitted.

## Classification key

- `reusable` — the root license permits source reuse after the import checklist, path-level audit,
  and notice work are complete. The originating provenance change copied no source or assets.
- `adapt` — use the behavior, protocol, or design as research and implement it independently;
  literal source reuse is not planned.
- `learn-only` — research and paraphrased notes only. No source code, snippets, generated
  derivatives, documentation text, branding, or other assets may enter Prime Studio.

Classifications are project-planning decisions, not legal opinions. A root license never clears
licenses attached to a nested package, vendored repository, generated file, or asset.

## Audited source register

| Source project | Exact audited SHA | URL | Audited license evidence | Classification | Planned handling | Attribution obligations |
|---|---|---|---|---|---|---|
| Cherry Studio | `e08335cc32bf6f9ab8805fe1c10c0000a083503f` | https://github.com/CherryHQ/cherry-studio | `LICENSE`; README identifies the Community Edition as AGPL-3.0 | `learn-only` | Study interaction ideas only. Do not import code, snippets, copied wording, or assets. | AGPL-3.0 obligations would require intact notices, license delivery, corresponding source, and network-use compliance for a covered derivative. This register forbids importing one; see the hard stop below. |
| Cline | `d011d049a13a04a58fb04d72666c35da6b4f1853` | https://github.com/cline/cline | `LICENSE`; Apache-2.0 appendix names Copyright 2026 Cline Bot Inc. | `reusable` | Future code reuse is permitted only after a path-level audit and an import record. This register does not approve any Cline bytes for import. | Retain the Apache-2.0 license, copyright/attribution/patent/trademark notices, and any applicable NOTICE text; mark modified files. Apache-2.0 grants no trademark rights. |
| OpenAI Codex CLI | `936f5eb3ee223ab34dcb221fa7c5f9943c8092bd` | https://github.com/openai/codex | `LICENSE`; `docs/license.md`; root `NOTICE` | `reusable` | Reuse only a specifically audited path. Treat the repository NOTICE and third-party subtree notices as part of the import boundary. | Retain Apache-2.0 notices and the root NOTICE attribution for OpenAI and Ratatui when affected. Ratatui-derived code is separately MIT-licensed and must keep its listed copyright notices. Do not imply OpenAI/Codex trademark endorsement. |
| Opcode | `70c16d8a4910db48cd9684aeacdd431caefd7d71` | https://github.com/winfunc/opcode | `LICENSE`; `package.json` declares AGPL-3.0 | `learn-only` | Learn from behavior and architecture only. No code, snippets, generated derivatives, UI assets, or branding may enter Prime Studio. | AGPL-3.0 obligations would include modification notices, license delivery, source availability, and applicable network-use terms. This register forbids importing a covered work; legal review is required before any exception. |
| OpenCode | `fe82a1b6ca4f535beb973b0867017e3f639f85ed` | https://github.com/anomalyco/opencode | `LICENSE`; `package.json` declares MIT | `adapt` | Independently implement useful interaction and runtime patterns. Audit a specific subtree before considering literal reuse. | Preserve the MIT copyright, permission notice, and disclaimer. The clone also has licenses under `packages/docs`, `packages/http-recorder`, and `packages/ui`; those paths need their own records. |
| OpenHands | `4470813ce58f5ac384e3d367d34518e10106526b` | https://github.com/OpenHands/OpenHands | `LICENSE`; root `package.json` declares MIT | `adapt` | Use architecture or workflow ideas as independent design input. This register does not approve any OpenHands code or assets for import. | Preserve the MIT copyright, permission notice, and disclaimer for any approved path. Audit package-level and asset-level notices before reuse. |
| Prime Agent | `a18809e00ea30638584d87b3afea7285a9d7296c` | https://github.com/PrimeIntellect-ai/prime-agent | `LICENSE`; README identifies the project as MIT | `adapt` | Prime Studio remains a client of a separately installed runtime. Use the verified RPC contract and behavior as an interface boundary; do not vendor Prime Agent source here. | Preserve Copyright 2025 Mario Zechner and Copyright 2026 Prime Intellect for any approved copied path. The repository describes pi-mono heritage and retains third-party package identifiers, so a subtree import needs a separate upstream-notice audit. |
| T3 Code | `a20923ce463335e89e92f5983d98a180536e8e7d` | https://github.com/pingdotgg/t3code | `LICENSE` declares MIT; copyright is T3 Tools Inc. | `adapt` | Use the existing research record and independently recreate selected UX or architecture ideas. This register does not approve any T3 Code source or assets for import. | Preserve Copyright 2026 T3 Tools Inc. for any approved root-owned path. The clone contains vendored `.repos/effect-smol` and `native/libghostty-vt` boundaries with their own licenses; audit the exact path before reuse. |

## AGPL-3.0 hard stop

Cherry Studio and Opcode are learn-only sources for Prime Studio. Do not copy, paste, vendor,
translate, port, mechanically transform, or generate a substantially derived implementation from
their source code. Do not copy their icons, screenshots, logos, CSS, other binary assets, or
distinctive documentation wording. Do not assume that placing copied code behind an API, IPC
boundary, or separate process avoids license obligations. A future request to import anything from
either project must stop here until legal review, a source-path decision, and an explicit
AGPL-3.0/commercial-license distribution plan are recorded.

## License-family obligations for a future approved import

### Apache-2.0 sources

For Cline or Codex code that passes the checklist, ship a readable copy of Apache-2.0, retain
copyright, patent, trademark, attribution, and warranty notices, mark modified files, and carry
forward any applicable NOTICE text. For Codex, the root NOTICE names OpenAI and Ratatui; preserve
the Ratatui MIT attribution whenever the imported path is derived from it. This plan grants no
right to use project names or marks as endorsement.

### MIT sources

For OpenCode, OpenHands, Prime Agent, or T3 Code code that passes the checklist, retain the
copyright and permission notice and the warranty disclaimer in the distributed notice set. Check
the exact file and its nested dependencies first; the root MIT file does not automatically clear
vendored repositories, generated files, package-specific licenses, or assets.

### AGPL-3.0 sources

No AGPL source is approved for import by this plan. If that decision is ever revisited, the review
must address the full AGPL-3.0 terms, including source availability for covered derivatives and
the corresponding-source requirement for network interaction, as well as the project’s product
license and distribution model. Do not resolve this by copying a license file after code has been
imported.

## Public clean-room boundary

The public repository intentionally excludes private development history. These
provenance files are policy and metadata only; they do not authorize copying external
code, patches, snippets, generated source, license text, screenshots, icons, logos,
fonts, or other assets. Verify the complete public tree with the checked-in provenance,
privacy, notice, and clean-room object-store gates. Private commit identifiers are not
publication evidence and must not be required to audit the public snapshot.
