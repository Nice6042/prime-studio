# Clean-room public-history export

This procedure creates a local review candidate. It does not create a hosting
repository, configure a remote, push, publish, tag, release, or authorize any of
those actions. Run it only after every source, privacy, provenance, license,
security, documentation, and CI gate has passed for one frozen commit.

## Preconditions

- Record the full object ID of the exact approved commit. Branch names, tags,
  abbreviations, and a moving `HEAD` are refused.
- The approved commit may have an empty tree. Any tracked entry it does contain must
  be a regular file; symlinks, submodules, and non-file modes are refused.
- Run on Windows. The final no-replace move uses the Windows directory-move
  primitive; the exporter fails closed on other operating systems.
- Use a complete standalone source repository. Shallow, partial/promisor, and
  alternate-backed source repositories are refused so export cannot fetch missing
  objects or depend on another object database.
- Put the quarantine and destination outside the source worktree, absolute Git
  directory, and common Git directory. Each final path must not exist, its immediate
  parent must exist, and the paths must not overlap. Pre-created empty directories
  are deliberately refused so the exporter can acquire each work area exclusively.
- Create a local JSON file outside the source tree containing every review-specific
  personal value that must be absent. Use literal values, not regular expressions:

  ```json
  [
    "review-specific personal name",
    "review-specific account address",
    "review-specific private path fragment"
  ]
  ```

  Keep this file and all scan evidence outside public Git. The report records only a
  positional private-rule ID and finding count; it never records literal values or
  affected paths.
- Create a separate review-only file containing exactly 32 cryptographically random
  bytes. Keep it outside public Git with the literals file. The report records an
  HMAC-SHA-256 binding to the exact denylist bytes, never the key or literal values.
- Choose reviewed collective commit metadata. The tool requires an email under the
  reserved `.invalid` domain so a real account address cannot enter the root commit.
- Use trusted local Git, Node.js, Windows PowerShell, and .NET. Archive inspection is
  bounded and in-process; environment-controlled external tar extraction is not used.

## Run

From the frozen private checkout, substitute absolute paths and the exact commit:

```powershell
node tools/clean-room-export.mjs `
  --source D:\review\prime-studio-candidate `
  --candidate 0123456789abcdef0123456789abcdef01234567 `
  --quarantine D:\review\prime-studio-quarantine `
  --destination D:\review\prime-studio-public `
  --private-literals-file D:\review-private\prime-studio-private-literals.json `
  --private-literals-hmac-key-file D:\review-private\prime-studio-private-literals.hmac-key `
  --author-name "Prime Studio Contributors" `
  --author-email "contributors@prime-studio.invalid"
```

The placeholder object ID is deliberately not usable for a real release. Supply the
full ID recorded by the release gate. The exporter will not delete or overwrite a
failed work area; use another path that does not exist after investigating failure.

## What the exporter proves

The tool archives the exact commit into an exclusively created quarantine and parses
the bounded ustar/PAX stream without extracting it, rejects
unsupported entry modes and high-risk paths, compares archive-member and file
closure, enforces file and aggregate size bounds, and scans both Git-archive
representations and canonical blob bytes with built-in secret/home-path rules and
the private literal list. It reconstructs the exact tree in an unpredictable,
same-parent bare-repository staging directory, revalidates Git/object directory
identities and reparse state, and atomically places the verified directory at the
still-nonexistent destination. No pathname-based worktree is materialized; raw bytes
are compared directly between source and destination blob objects without filters.
Mixed-case and uppercase `GIT_*` variables are removed from every Git child
environment on Windows before the exporter supplies its fixed internal values.

It then verifies:

- the destination tree ID equals the source candidate tree ID;
- exactly one parentless commit is reachable;
- `refs/heads/main` is the only ref;
- author and committer use the requested neutral identity;
- both commit timestamps are fixed at `2000-01-01T00:00:00Z`;
- no remotes, reflogs, alternates, shallow state, grafts, missing objects, dangling
  objects, or unreachable objects are present; and
- the complete object inventory equals the reachable graph and contains exactly one
  commit object, no tag objects, and only the required tree and blob objects; and
- the bare destination tree has the same tracked-file closure and raw blob bytes as
  the candidate, without creating checked-out filesystem paths.

The redacted evidence file is
`<quarantine>/public-export-audit.json`. Keep the tar, report, private-literals file,
HMAC key, reviewer records, and subsequent scanner outputs in the controlled release
evidence location. Do not copy them into the public candidate.

## Independent gates after export

Export success is necessary but insufficient. A different reviewer must bind their
decision to the report's candidate, source tree, destination tree, destination
commit, archive SHA-256, and file-manifest SHA-256 values. Then:

1. run the pinned secret, personal-data, license, provenance, dependency, and binary
   metadata scanners over the quarantine archive and every destination object;
2. make a fresh non-local clone with hardlinks disabled and repeat ref, reflog,
   alternate, promisor/partial-clone, unreachable-object, secret, and closure scans;
3. confirm the fresh clone's root commit and tree match the report;
4. complete the evidence ledger and independent security/release approvals; and
5. perform public repository creation and the first push only as a separate,
   explicitly authorized action.

Stop on any mismatch, scan finding, unexpected object, unreviewed file, stale
approval, or candidate change. Freeze a new commit and rerun every affected gate.
