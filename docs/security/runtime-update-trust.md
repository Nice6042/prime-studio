# Prime Studio runtime and update trust

**Scope:** current public source tree; no historical commit identity grants authority
**Trust decision:** a version string or installer checksum is not sufficient; execution requires one authenticated, compatible artifact closure.

Status vocabulary: `implemented` is direct current-tree evidence; `planned` is documented but not present or proven; `blocked` cannot be activated until the trust-chain evidence passes.

## Current runtime evidence

| Item | Observed/required state | Status |
|---|---|---|
| Studio source | The clean public root identifies the source tree; no historical private commit is release evidence. | **implemented** as source identity only. |
| Prime package label | Installed audit runtime reported `prime-agent 0.7.1`; the same label was observed with source changes not shipped in the inspected package. | **implemented** as an observation only; trust closure **planned; blocked**. |
| Protocol profile | `PROTOCOL.md` records legacy RPC/event shapes and known daemon/attach limits; a complete runtime-validated profile and capability manifest is still required. | **planned; blocked**. |
| Prime ownership | Current app launches/uses a separately installed Prime CLI/profile and shows the CLI path in settings. | **planned; blocked** for managed-vs-external ownership. |
| Security extension/broker/executors | No pinned security extension, final host gate, Windows broker, or contained worker is present in this baseline. | **planned; blocked**. |
| Update mechanism | `app/src-tauri/tauri.conf.json` defines bundling but no authenticated update trust chain. | **planned; blocked**. |
| Release evidence | No signed `release-evidence.json` tied to exact tested bytes is present in `docs/security` or the baseline. | **planned; blocked**. |

## Compatibility closure

The managed execution closure must be a named, hashed set containing at least:

- Studio executable, frontend assets, and native Tauri workers;
- the exact Prime build/source fingerprint and provider/auth mode;
- the selected protocol/schema profile and validators;
- the pinned first-party security extension;
- broker and executor binaries plus their security/broker epochs;
- browser/Chromium component and browser protocol profile when enabled;
- database schema/migration range and the supported data image;
- dependency/license/SBOM/provenance records.

The closure is not equivalent to a marketing version, package label, single executable checksum, or the presence of a Prime binary on `PATH`. A profile whose required capability, validator, epoch, or artifact is not understood by the installed updater is incompatible and remains read/export-only.

## Runtime admission

Before a Prime process or managed worker starts, Studio must:

1. Resolve the intended managed artifact closure, not an arbitrary executable/path supplied by a model, project, or extension.
2. Verify the signed manifest, artifact hashes, schema range, protocol profile, security extension, broker/executor epochs, and provider-auth mode.
3. Launch only from immutable content-addressed or otherwise identity-locked paths.
4. Verify the runtime self-test, secure transport, final host gate, containment attestation, and telemetry-off state where local-only mode requires it.
5. Record the closure identity in the AgentRun/release evidence before dispatch.

An external Prime installation may be supported as an explicitly labeled read/export profile. It must never be silently updated, mixed with managed components, or used to satisfy a managed compatibility claim.

## Update trust chain

The approved update design requires two roles:

- an offline threshold trust root for product/channel and key-rotation policy;
- a separately delegated online targets/rollback role for individual releases.

Every manifest includes:

`product identity` + `channel` + monotonic `sequence` + issue/expiry times + minimum compatible version + key ID + authorized key-rotation record + artifact closure + protocol/schema/security/broker/browser epochs + migration range.

Activation must reject:

- invalid signature, wrong product/channel, expired/future-invalid manifest, or unknown key rotation;
- replayed/frozen/downgraded sequence or a revoked old key;
- artifact hash/closure mismatch, unsupported validator/profile, active managed runs, or insufficient data migration support;
- hostile archives (traversal, reparse/symlink/hardlink, decompression bomb, redirect/size violation);
- external Prime/runtime mixing or a worker launched before pre-spawn verification.

Rollback to an older closure requires a fresh, higher-sequence rollback manifest signed by the currently trusted rollback role and naming a compatible data image. Replaying an old lower-sequence manifest is forbidden. The anti-rollback floor lives outside ordinary database backups.

## Activation state machine

```text
download → verify envelope/closure → quarantine exact bytes
        → pre-migration backup/fence → test exact hashes
        → acquire exclusive runtime lock
        → approve/promote → spawn only after re-verification
```

Failure before the upgraded version accepts writes may restore the previous closure and pre-migration data atomically. After upgraded writes, older data must never overwrite newer user data; recovery is forward repair, read/export, or a verified lossless delta migration. Activation must cover active, resident, detached, and scheduled workers, and refuse to start while the lock cannot be obtained.

## Status matrix

| Trust claim | Required evidence | Current status |
|---|---|---|
| “This is the supported Prime build” | Signed/fingerprinted runtime + complete protocol/capability manifest | **planned; blocked**. `0.7.1` label alone is insufficient. |
| “This worker is the approved security extension/broker/executor” | Closure hash, signer/role, epoch handshake, self-test, pre-spawn verification | **planned; blocked**. |
| “This update is authentic and current” | Canonical signed envelope, sequence/channel/expiry/key-rotation verification | **planned; blocked**. |
| “This rollback preserves user data” | Compatible data image, migration/recovery test after interrupted activation | **planned; blocked**. |
| “This release was tested” | Signed release evidence tied to source/dirty states/toolchain/OS/WebView/test IDs/artifact hashes | **planned; blocked**. |

Until these gates exist, the runtime/update surface must be labeled unsupported or read/export-only. A successful local build is build evidence, not update/authenticity evidence. The local traceability record is not a signed release attestation.

## References

- `PROTOCOL.md:1-37,176-207` for observed Prime version/daemon limitations and extension behavior.
- `app/src-tauri/tauri.conf.json` for the current bundle configuration and absence of an updater trust definition.
- Fresh baseline build evidence: Vite build passed and the initial JS chunk was observed at 632.37 kB (195.51 kB gzip). This is a build measurement only; no checked-in budget approval or signed release-evidence record exists, so it is not a normative budget or signature claim.
