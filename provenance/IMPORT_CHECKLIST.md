# OSS import checklist for Prime Studio

This is a planning gate for future provenance work. It does not approve an import and
contains no imported external code or assets.

## Required record for every proposed import

- [ ] Assign one stable import ID and describe the user-facing purpose.
- [ ] Record the source project, canonical URL, exact audited commit SHA, audit date, and the
      clean-clone evidence used to verify the SHA.
- [ ] Record the exact source path(s), whether each path is code, documentation, generated output,
      font, image, icon, or other asset, and a content hash for each imported file.
- [ ] Read the path-level `LICENSE`, `COPYING`, `NOTICE`, `THIRD_PARTY_NOTICES`, package metadata,
      and adjacent headers. Do not infer a file’s license from a repository root alone.
- [ ] Record the SPDX license expression, copyright holders, required notices, modification
      marking, source-offer or corresponding-source terms, patent terms, and trademark limits.
- [ ] Classify the item as exactly one of `reusable`, `adapt`, or `learn-only`, and record why the
      classification fits the proposed use.
- [ ] Record whether the implementation is verbatim, modified, translated, generated from, or
      independently reimplemented. Treat a generated or translated derivative as an import for
      review purposes.
- [ ] Identify nested repositories, vendored dependencies, generated files, model outputs, and
      assets used by the selected path. Each must have its own source and license record.
- [ ] Write the final attribution text and identify where it will ship: distributed NOTICE,
      about screen, source header, documentation, or another legally appropriate location.
- [ ] Obtain the required legal/product approval before staging any external bytes.

## AGPL-3.0 gate

- [ ] If the source is Cherry Studio or Opcode, stop: this register classifies it as `learn-only`.
- [ ] Do not import AGPL code, snippets, copied wording, generated derivatives, icons, screenshots,
      logos, CSS, fonts, or other assets under this plan.
- [ ] Do not assume an API, IPC, plugin, subprocess, or separate package boundary removes AGPL
      obligations.
- [ ] Re-open the decision only with written legal review, an explicit license/commercial-license
      basis, a source-availability plan, and an updated provenance record.

## Apache-2.0 gate

- [ ] Include the Apache-2.0 license in the distributed notice set.
- [ ] Preserve copyright, patent, attribution, trademark, and warranty notices.
- [ ] Mark every modified source file with a prominent modification notice where required.
- [ ] Include applicable repository NOTICE text. For Codex, preserve the OpenAI and Ratatui
      attributions and the Ratatui MIT notice when the imported path is affected.
- [ ] Confirm that product names, logos, and marks are not presented as endorsement.

## MIT gate

- [ ] Preserve each relevant copyright and permission notice and the warranty disclaimer.
- [ ] Check package-level and vendored licenses before treating a path as MIT-cleared.
- [ ] Check assets separately; a project’s MIT source license does not automatically license its
      logos, screenshots, fonts, model outputs, or third-party content.
- [ ] Preserve Prime Agent’s Mario Zechner/Prime Intellect notices and T3 Code’s T3 Tools Inc.
      notice when an approved path is ever copied.

## Independent-adaptation gate

- [ ] For an `adapt` item, write a short independent design note before implementation, naming the
      behavior being reproduced without copying source structure, identifiers, comments, or
      distinctive text.
- [ ] Keep the audited clone outside the Prime Studio repository; use it as read-only research.
- [ ] Review the diff for copied code, copied assets, generated derivatives, or copied wording
      before commit.
- [ ] Add the approved source row and attribution before the product change that consumes it.

## Release and repository gate

- [ ] Update the final distributed third-party notice only after an import is actually approved;
      this planning file is not the final notice.
- [ ] Re-run the source/license audit at the pinned SHA before release if the import was made later
      than the recorded audit.
- [ ] Confirm the change does not modify package manifests, lockfiles, product/account behavior,
      or unrelated files.
- [ ] Verify `git diff --check`, the relevant tests/build, and the exact staged file list.
- [ ] Commit the provenance record with the imported change so the source, SHA, license, and
      attribution stay reviewable together.

## Public-source declaration

- [x] This checklist contains planning prose only and imports no external source or assets.
- [x] The source register uses canonical upstream URLs and exact upstream revisions.
- [ ] No future import is approved by this checklist alone; complete the record and gates above
      for each separate change.
