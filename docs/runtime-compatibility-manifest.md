# Runtime compatibility manifest foundation

Prime Studio does not treat a package version, CLI loader hash, source checkout, or runtime self-report as execution authority. The version 1 manifest binds the exact files and protocol evidence that were inspected. The Rust verifier remains deliberately non-activating: every verified result is read/export-only, and `executionAllowed: true` is rejected.

The machine-readable contract is [`app/src-tauri/schemas/runtime-compatibility-manifest.schema.json`](../app/src-tauri/schemas/runtime-compatibility-manifest.schema.json). The implementation is `app/src-tauri/src/runtime_manifest.rs`. Wire objects deserialize into private temporary types first; only `parse_manifest` can construct the public validated domain object. Nullable evidence keys remain required on the wire, so `null` and an omitted observation are not interchangeable.

## Ownership states

| State | Meaning | Version 1 result |
| --- | --- | --- |
| `managed` | Studio owns the clean, identified runtime distribution and its complete closure. | Exact closure can be verified; execution remains false. |
| `external` | The user or another installer owns a clean, explicitly selected runtime. Studio never updates or combines it silently. | Exact closure can be verified; execution remains false. |
| `unidentified` | Provenance, closure, schema, or capabilities are incomplete or inconsistent. | Rejected before filesystem access. |

`packageVersion` is descriptive metadata only. `sourceRevision`, `buildRevision`, `sourceAttested`, and `dirty` preserve provenance observations, but the verifier's byte authority is the complete artifact closure. Managed and external manifests must be clean, name package/source/build metadata, attest the source revision, and include complete artifact, protocol, and capability bindings.

## Bound records

Every artifact record binds:

- canonical bundle-relative `path`;
- one fixed `role`;
- exact byte `size`;
- lowercase SHA-256 of the opened file handle.

The complete closure rejects files that are present on disk but absent from the manifest. Its allowed directory topology is derived from the parents of those artifact paths, so unlisted empty directories also fail closed. This prevents a manifest for a loader and Node executable from silently blessing unmeasured JavaScript bundles, dependencies, validators, native workers, or extensions.

A managed or external Prime closure requires exactly one `prime-cli-entry`, exactly one `node-runtime`, at least one `protocol-schema`, and at least one `protocol-validator`. Additional dependencies, assets, workers, schemas, and validators remain individually listed and hashed; a role requirement never substitutes for complete enumeration.

`protocol.schemaArtifact` must exactly equal one closure path, including case, whose role is `protocol-schema`; `protocol.schemaSha256` must equal that entry's digest. Capabilities are sorted records with a canonical identifier, `present` or `absent` state, and an optional bounded ASCII string value. The value key may be omitted but can never be `null`; an absent capability cannot carry it at all. Absence is recorded explicitly when it is an audited compatibility fact.

## Canonical paths and filesystem checks

Manifest paths use printable ASCII and `/` separators. They are relative to the runtime root selected by the caller. Rust rejects:

- absolute, drive-qualified, UNC, device, and alternate-data-stream paths;
- `.` or `..`, empty segments, backslashes, and reserved Windows characters;
- Windows device names such as `CON`, `NUL`, `COM1`, and `LPT1`, including names with extensions;
- trailing dots/spaces, oversized components, case-insensitive duplicate paths, and unsorted path records.

The stored path spelling must also match the directory entry's exact case. A differently cased Windows alias may resolve to the same bytes, but it is not a second canonical manifest spelling.

Verification requires an absolute runtime root. It inspects every existing path component without following the leaf, rejects reparse points, enumerates the complete tree without traversal, and opens each expected regular file. On Windows it records the 64-bit volume serial, 128-bit file identifier, reparse state, directory state, and link count. It rejects multiply linked files and repeated file identities, compares the final opened-handle path to the selected root plus manifest path, and rejects every named NTFS alternate data stream on the root, each nested directory, and each artifact.

Windows verification holds no-follow root, directory, and artifact handles while it acquires the view. Artifact handles deny write/delete sharing; identities, sizes, last-write times, and filesystem change times from enumeration must match the locked handles; tree enumeration and alternate-stream enumeration are repeated after hashing and followed by final handle/path snapshots. Root and nested-directory streams are checked both when their handles are acquired and during final validation. Synthetic synchronization hooks test root replacement, directory-component replacement, late extra files, same-file writes, and late alternate streams, including mutations injected after the final tree enumeration. A successful `VerifiedManifest` retains the handles as a private verification lease, but exposes neither handles nor a launch path. The complete-closure claim is the exact view linearized by those checks; it is not continuing authority over a mutable source directory.

This verifier's security boundary is Windows. Unix builds retain a diagnostic implementation for tests and fail closed if `/proc/self/fd` handle resolution is unavailable; they are not an execution-verification boundary. Any later executor must use an immutable managed installation or materialize from the verified handles, revalidate immediately before spawn, and never treat the original mutable path as continuing authority. These checks are a compatibility foundation, not a substitute for the later signed updater, immutable installation ACLs, runtime lock, and pre-spawn gate.

## Canonical set digests

All integers use unsigned big-endian encoding. A string frame is `u32 byte_length || UTF-8 bytes`. Records must already be sorted by canonical path or capability identifier.

Artifact closure digest input:

```text
"prime-studio.artifact-closure/v1\0"
|| u32 artifact_count
|| for each artifact:
     frame(path)
     || frame(role)
     || u64(size)
     || frame(lowercase_sha256)
```

Capability set digest input:

```text
"prime-studio.capability-set/v1\0"
|| u32 capability_count
|| for each capability:
     frame(id)
     || frame(state)
     || u8(value_present)
     || if present: frame(value)
```

The manifest stores each resulting lowercase SHA-256. These deterministic digests detect reordered, omitted, duplicated, or altered bindings. They provide integrity comparison only; without a separately authenticated trust policy they are not authenticity evidence.

## Synthetic rejected-runtime fixture

`unidentified-observed-rejected.json` is an intentionally synthetic record. Its zero/standard
hash vectors, synthetic version, and incomplete closure exercise default denial without
publishing an installed runtime fingerprint or local source revision.

| Observation | Value |
| --- | --- |
| Synthetic CLI row size / SHA-256 | `0` / SHA-256 of the empty byte string |
| Synthetic runtime row size / SHA-256 | `3` / SHA-256 of `abc` |
| Legacy raw RPC commands | `0` |
| Top-level outbound variants | `0` |
| Extension UI methods | `0` |
| Headless daemon attach / `rate_limits` | absent |

The two illustrative artifact rows do not close over a runnable Prime bundle, dependencies,
protocol schema/validator, security extension, or native helpers. The record is therefore
`unidentified`, `complete: false`, `protocol: null`, and `executionAllowed: false`. It is not
a supported Prime compatibility set.

## Fixtures and activation boundary

`tests/fixtures/runtime-manifest/runtime` contains inert text bytes with executable-looking filenames solely to exercise path, size, role, hash, and schema binding. `.gitattributes` disables line-ending conversion for those files so a clean checkout retains the exact tested bytes. No fixture contains provider credentials, personal paths, captured chats, or runnable Prime code.

The contract test compiles the checked-in schema as Draft 2020-12, validates every fixture, and runs a shared valid/invalid mutation corpus through both the JSON Schema validator and the Rust parser. Rust also applies semantic constraints that JSON Schema cannot conveniently express, including sorted records, aggregate byte limits, case-insensitive Windows aliases, reserved path segments, deterministic set digests, and filesystem identity checks.

A later schema must add the approved signed compatibility-set envelope, trust-root/key policy, Studio closure, security/broker epochs, provider-auth mode, migration range, immutable managed path, anti-rollback state, and pre-spawn revalidation. That work must use a new explicit activation API. Changing this version's boolean or returning a verified structure must never start Prime by itself.

## Prime Harness daemon profile

The Studio Harness adapter adds a separate, non-activating compatibility decision. It binds the
installed `prime-agent` package version 0.7.1, manifest and public-entrypoint SHA-256 digests,
`prime-agent.daemon` protocol 7, schema revision 13, schema ID
`protocol-7-schema-13-816309b1cd50`, and an explicit capability inventory.

Attach snapshots, monotonic event sequences, resident sessions, session-input admission, and model
catalog discovery are mandatory. Losing one makes the runtime read-only. Missing optional
capabilities degrade only their corresponding interface. An unknown identity, protocol, or schema
remains unavailable until a fixture-backed profile and security review are merged.

A compatible result is evidence, not execution authority. Production process readiness remains
unavailable until the activation plan verifies and installs a private native activation receipt.
