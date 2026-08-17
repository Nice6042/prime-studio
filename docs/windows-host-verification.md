# Windows host verification and evidence handling

Prime Studio has source and CI coverage for several Windows-first boundaries, but a repository
workflow cannot attest an installed Prime closure, a provider-backed resident session, foreground
interaction effects, code signing, or release approval. This kit collects a credential-free
preflight and produces a bounded redacted evidence bundle for later independent review.

Every generated record and bundle is classified:

```text
HOST_COLLECTED_UNREVIEWED
```

That classification is intentional. Collection is not review, a passing source build is not
activation evidence, and a reviewed host run is not a release authorization.

## Included tooling

- `app/scripts/windows-host-verification/Collect-WindowsHostPreflight.ps1`
  records the Windows, PowerShell, WebView2, Node, npm, Rust, Cargo, Git, Prime-command, repository,
  and optional source-check evidence described by the checked-in schema.
- `app/scripts/windows-host-verification/New-WindowsHostEvidenceBundle.ps1`
  redacts and bundles bounded text evidence while excluding binary evidence for separate review.
- `docs/windows-host-preflight.schema.json`
  is a Draft 2020-12 schema whose non-source claims are fixed to `NOT_ATTESTED`.
- `docs/windows-host-review-template.md`
  separates source build, exact Prime closure, activation, provider session, interaction worker,
  installer signing, and release authority decisions.

The scripts do not read browser profiles, provider credential stores, environment-variable dumps,
cookies, account secrets, or private keys.

## 1. Prepare a disposable Windows profile

Use a clean Windows user profile or disposable virtual machine. Check out the exact commit under
review and do not add evidence inside the repository. The preflight records only a clean-state flag
and changed-entry count; it never records the changed filenames.

From the repository root, collect the lightweight preflight:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File app/scripts/windows-host-verification/Collect-WindowsHostPreflight.ps1 `
  -OutputRoot <OUTSIDE_REPOSITORY>\prime-studio-host-evidence\raw
```

To execute the locked frontend and Rust source checks as part of the same collection, add
`-RunSourceChecks`:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File app/scripts/windows-host-verification/Collect-WindowsHostPreflight.ps1 `
  -OutputRoot <OUTSIDE_REPOSITORY>\prime-studio-host-evidence\raw `
  -RunSourceChecks
```

The requested checks are run independently and their redacted logs are preserved. If any check
fails or times out, the script writes the failed evidence and exits non-zero. It never edits a
failure into a pass.

The preflight binds the evidence to:

- the exact Git commit and branch;
- repository clean-state and changed-entry count;
- SHA-256 and size for `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`,
  `tauri.conf.json`, and `rust-toolchain.toml`;
- Windows build, architecture, PowerShell, and WebView2 observations;
- executable path after path redaction and SHA-256 when a concrete executable is available;
- version-command status for Node, npm, Rust, Cargo, Git, and the first available reviewed Prime
  command candidate.

A discovered Prime command is only an observation. The preflight does not prove that its package,
entrypoint, daemon, schema, adapter, or capability closure matches a reviewed profile.

## 2. Exercise the real host boundaries separately

After preflight, a supervised host run may collect additional text logs for independent review.
The minimum Wave 1 sequence is:

1. discover one exact reviewed Prime installation;
2. verify package, CLI entrypoint, daemon, Node, schema, capability, sidecar, and adapter identity;
3. complete Prime Studio activation without a profile or digest mismatch;
4. create or attach a provider-backed resident session;
5. send, stream, abort, reconnect, and stop;
6. preserve the resulting credential-free logs and exact runtime identity evidence.

Browser navigation, download, capture, clicking, or typing must remain classified unavailable
unless a separately reviewed production interaction worker, worker identity closure, grant,
cancellation behavior, and host evidence are present. A source-level admission contract is not an
effect worker.

Do not place any of the following in the evidence input directory:

- provider credentials, cookies, browser profile exports, private keys, signing material, or
  authorization headers that are still needed;
- complete environment-variable dumps;
- personal files unrelated to the verification;
- release binaries intended for publication.

The bundler performs defensive redaction, but it is not permission to collect unnecessary secrets.

## 3. Produce the redacted bundle

Run the bundler against the raw evidence directory and write to a new, absent output directory:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File app/scripts/windows-host-verification/New-WindowsHostEvidenceBundle.ps1 `
  -InputRoot <OUTSIDE_REPOSITORY>\prime-studio-host-evidence\raw `
  -OutputRoot <OUTSIDE_REPOSITORY>\prime-studio-host-evidence\redacted
```

The bundler:

- includes only `.txt`, `.json`, `.xml`, `.csv`, `.md`, and `.log` files;
- caps each file at 2 MiB and the included bundle at 32 MiB;
- rejects reparse-point paths, binary content, screenshots, archives, executables, installers,
  traces, databases, and other non-allowlisted evidence;
- redacts repository, user-profile, and temporary paths;
- redacts authorization and cookie headers, secret-named JSON properties, common provider and
  collaboration token shapes, JWTs, and email addresses;
- writes UTF-8 without a byte-order mark and normalizes line endings;
- writes a deterministic `bundle-manifest.json` sorted by relative path, with source and bundled
  SHA-256 hashes plus explicit exclusion reasons;
- scans included output again and fails closed if a high-risk pattern remains.

Excluded screenshots or binary artifacts may be reviewed separately only after a person checks
them for secrets, personal data, and unrelated window content. They must never be silently added to
the text bundle.

## 4. Review independently

Copy `docs/windows-host-review-template.md` into the review record and bind it to:

- the exact repository commit;
- the SHA-256 of `windows-host-preflight.json`;
- the SHA-256 of `bundle-manifest.json`;
- the reviewer identity and review time;
- the independent evidence used for each promoted boundary.

The collector cannot promote its own `HOST_COLLECTED_UNREVIEWED` classification. A reviewer may
accept source-build evidence while rejecting or leaving unreviewed the Prime closure, activation,
provider, interaction, signing, or release sections.

## CI boundary

Repository CI parses the PowerShell source, exercises redaction, JSON secret handling, deterministic
manifests, binary and oversize exclusion, hashing, and a credential-free preflight on a GitHub-hosted
Windows runner. That proves the checked-in collection kit behaves as designed on the runner. It does
not attest the user's machine, installed Prime runtime, provider account, interaction worker,
installer, signing identity, or release decision.
