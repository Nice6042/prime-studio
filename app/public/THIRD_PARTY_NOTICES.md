# Third-party notices

This file is generated from the committed npm and Cargo lockfiles. It records the
declared-license inventory for 113 npm production packages, 244 Rust
packages in the locked x86_64-pc-windows-msvc non-development closure, one reviewed build-data
input, and the retained application scaffold. `licenseConcluded` remains `NOASSERTION`
in the companion SPDX document: a package declaration is evidence, not a legal
conclusion or an invented ownership claim.

The source archive links below are immutable by version and lockfile checksum. A binary
release must still reconcile these records to the unpacked installer and carry forward
the exact copyright and license notices from those archives. This source-tree inventory
does not authorize a release when provenance, signing, or candidate-output gates remain
open.

## Reproduction

```text
cargo fetch --manifest-path app/src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
node scripts/generate-third-party-artifacts.mjs --check
node scripts/generate-third-party-artifacts.mjs --write
```

- npm lock SHA-256: `8fc203ab9ab479b3f389e1f828a7c45d92068c2d98365ec0e27913e220019ebe`
- Cargo lock SHA-256: `57797241b9e3c4cc01f47f2fcb23c87e54e8ac13d7e59ec2b40932ee9ba56f6d`
- Cargo target: `x86_64-pc-windows-msvc`
- Cargo scope: normal and build dependencies reachable from the workspace package;
  development dependencies are excluded.
- npm scope: records marked as production by package-lock v3; development dependencies
  are excluded except for the separately classified caniuse-lite build-data record.

## Retained create-tauri-app scaffold

The retained source scaffold is from [create-tauri-app 4.6.2](https://github.com/tauri-apps/create-tauri-app/tree/d959db0f057aa4c1b9cc4ad7f030cffedf3e48a6)
(commit `d959db0f057aa4c1b9cc4ad7f030cffedf3e48a6`), declared `MIT OR Apache-2.0`. The initial direct
React/TypeScript/Tauri manifest matches that tagged template. Stock Vite and Tauri
branding is not part of this notice set because it has been replaced by locally generated
original code-native branding recorded in `assets/branding/README.md`. This attribution covers the retained scaffold structure only and
does not claim that create-tauri-app owns later Prime Studio source.

## Mozilla Public License 2.0 source availability

The following unmodified Rust crates are in the locked Windows production/build graph.
Rows marked `windows-runtime` are present in executable form; build-input rows are used
only to create it. Their exact Source Code Form is available from the versioned archives
below under MPL-2.0. Prime Studio does not apply additional restrictions to those sources.
Each archive contains the applicable
license and package notices. The MPL-2.0 text is available from [Mozilla](https://www.mozilla.org/MPL/2.0/).

| Component | Version | Purpose | Exact source | Upstream repository |
|---|---:|---|---|---|
| `cssparser` | `0.36.0` | windows-runtime | [crates.io archive](https://crates.io/api/v1/crates/cssparser/0.36.0/download) | [repository](https://github.com/servo/rust-cssparser) |
| `cssparser-macros` | `0.6.1` | windows-build-input | [crates.io archive](https://crates.io/api/v1/crates/cssparser-macros/0.6.1/download) | [repository](https://github.com/servo/rust-cssparser) |
| `dtoa-short` | `0.3.5` | windows-runtime | [crates.io archive](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) | [repository](https://github.com/upsuper/dtoa-short) |
| `option-ext` | `0.2.0` | windows-runtime | [crates.io archive](https://crates.io/api/v1/crates/option-ext/0.2.0/download) | [repository](https://github.com/soc/option-ext.git) |
| `selectors` | `0.36.1` | windows-runtime | [crates.io archive](https://crates.io/api/v1/crates/selectors/0.36.1/download) | [repository](https://github.com/servo/stylo) |

## Unicode License v3

The 19 components below declare `Unicode-3.0` as all or part of their
license expression: 18 declare it alone and `unicode-ident` declares it together with
permissive alternatives. Their versioned archives contain the package-specific Unicode
copyright and permission notice, including the applicable year range; those notices must
be retained in associated documentation for a binary distribution.

| Component | Version | Purpose | Declared license | Exact source |
|---|---:|---|---|---|
| `icu_collections` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_collections/2.2.0/download) |
| `icu_locale_core` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_locale_core/2.2.0/download) |
| `icu_normalizer` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_normalizer/2.2.0/download) |
| `icu_normalizer_data` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_normalizer_data/2.2.0/download) |
| `icu_properties` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_properties/2.2.0/download) |
| `icu_properties_data` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_properties_data/2.2.0/download) |
| `icu_provider` | `2.2.0` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/icu_provider/2.2.0/download) |
| `litemap` | `0.8.2` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/litemap/0.8.2/download) |
| `potential_utf` | `0.1.5` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/potential_utf/0.1.5/download) |
| `tinystr` | `0.8.3` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/tinystr/0.8.3/download) |
| `unicode-ident` | `1.0.24` | windows-runtime | `(MIT OR Apache-2.0) AND Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/unicode-ident/1.0.24/download) |
| `writeable` | `0.6.3` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/writeable/0.6.3/download) |
| `yoke` | `0.8.3` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/yoke/0.8.3/download) |
| `yoke-derive` | `0.8.2` | windows-build-input | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/yoke-derive/0.8.2/download) |
| `zerofrom` | `0.1.8` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/zerofrom/0.1.8/download) |
| `zerofrom-derive` | `0.1.7` | windows-build-input | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/zerofrom-derive/0.1.7/download) |
| `zerotrie` | `0.2.4` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/zerotrie/0.2.4/download) |
| `zerovec` | `0.11.6` | windows-runtime | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/zerovec/0.11.6/download) |
| `zerovec-derive` | `0.11.3` | windows-build-input | `Unicode-3.0` | [source archive](https://crates.io/api/v1/crates/zerovec-derive/0.11.3/download) |

## caniuse-lite CC-BY-4.0 build-data decision

`caniuse-lite@1.0.30001809` is locked as development-only browser compatibility
data from [its exact npm archive](https://registry.npmjs.org/caniuse-lite/-/caniuse-lite-1.0.30001809.tgz) and declares `CC-BY-4.0`. It is
reachable through the build toolchain, is absent from the npm production closure, and is
not imported by application runtime source. It is therefore recorded in the SPDX 2.3 file
as `OTHER`, explicitly annotated as build-only, with `BUILD_DEPENDENCY_OF`; it is not a
shipped runtime dependency. Final candidate
output scanning must reopen this decision if any caniuse dataset or recognizable extract
appears in the installer. Upstream package attribution: Ben Briggs (package author); source at
[browserslist/caniuse-lite](https://github.com/browserslist/caniuse-lite); license at
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

## Permissive license families

Every component and exact declared expression appears in the complete inventory below.
The family counts make the MIT, Apache-2.0, BSD-3-Clause, ISC, and Zlib obligations
visible even when a component offers alternative terms. Use the exact source archive for
the copyright notice and license text that belongs to that component.

| License family | Components whose expression includes it |
|---|---:|
| `MIT` | 328 |
| `Apache-2.0` | 170 |
| `BSD-3-Clause` | 5 |
| `ISC` | 1 |
| `Zlib` | 3 |

## Prime Agent is not distributed

Prime Agent is a separately installed runtime and is intentionally absent from this shipped
dependency SBOM. The audited interoperability reference is commit `a18809e00ea30638584d87b3afea7285a9d7296c`
at [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/a18809e00ea30638584d87b3afea7285a9d7296c), declared `MIT`. No Prime Agent source or
binary is vendored by this repository. If that boundary changes, regenerate the SBOM and
perform a path-level pi-mono and nested-notice audit first. The audited upstream notices are:

- Copyright (c) 2025 Mario Zechner
- Copyright (c) 2026 Prime Intellect

## Declared-license summary

| SPDX expression | Component count |
|---|---:|
| `(MIT OR Apache-2.0) AND Unicode-3.0` | 1 |
| `0BSD OR MIT OR Apache-2.0` | 1 |
| `Apache-2.0` | 2 |
| `Apache-2.0 AND MIT` | 1 |
| `Apache-2.0 OR MIT` | 31 |
| `BSD-3-Clause` | 3 |
| `BSD-3-Clause AND MIT` | 1 |
| `BSD-3-Clause OR MIT` | 1 |
| `CC-BY-4.0` | 1 |
| `CC0-1.0 OR MIT-0 OR Apache-2.0` | 1 |
| `ISC` | 1 |
| `MIT` | 152 |
| `MIT OR Apache-2.0` | 131 |
| `MIT OR Apache-2.0 OR Zlib` | 1 |
| `MIT OR Zlib OR Apache-2.0` | 1 |
| `MPL-2.0` | 5 |
| `Unicode-3.0` | 18 |
| `Unlicense OR MIT` | 6 |
| `Zlib` | 1 |

## Complete locked inventory

| Ecosystem/scope | Component | Version | Purpose | Declared license | Exact source |
|---|---|---:|---|---|---|
| cargo | `adler2` | `2.0.1` | windows-build-input | `0BSD OR MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/adler2/2.0.1/download) |
| cargo | `aho-corasick` | `1.1.5` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/aho-corasick/1.1.5/download) |
| cargo | `alloc-no-stdlib` | `2.0.4` | windows-runtime | `BSD-3-Clause` | [archive](https://crates.io/api/v1/crates/alloc-no-stdlib/2.0.4/download) |
| cargo | `alloc-stdlib` | `0.2.4` | windows-runtime | `BSD-3-Clause` | [archive](https://crates.io/api/v1/crates/alloc-stdlib/0.2.4/download) |
| cargo | `anyhow` | `1.0.104` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/anyhow/1.0.104/download) |
| cargo | `autocfg` | `1.5.1` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/autocfg/1.5.1/download) |
| cargo | `base64` | `0.22.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/base64/0.22.1/download) |
| cargo | `bit-set` | `0.8.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/bit-set/0.8.0/download) |
| cargo | `bit-vec` | `0.8.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/bit-vec/0.8.0/download) |
| cargo | `bitflags` | `1.3.2` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/bitflags/1.3.2/download) |
| cargo | `bitflags` | `2.13.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/bitflags/2.13.1/download) |
| cargo | `block-buffer` | `0.10.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/block-buffer/0.10.4/download) |
| cargo | `brotli` | `8.0.4` | windows-runtime | `BSD-3-Clause AND MIT` | [archive](https://crates.io/api/v1/crates/brotli/8.0.4/download) |
| cargo | `brotli-decompressor` | `5.0.3` | windows-runtime | `BSD-3-Clause OR MIT` | [archive](https://crates.io/api/v1/crates/brotli-decompressor/5.0.3/download) |
| cargo | `byteorder` | `1.5.0` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/byteorder/1.5.0/download) |
| cargo | `bytes` | `1.12.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/bytes/1.12.1/download) |
| cargo | `camino` | `1.2.5` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/camino/1.2.5/download) |
| cargo | `cargo-platform` | `0.1.9` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/cargo-platform/0.1.9/download) |
| cargo | `cargo_metadata` | `0.19.2` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/cargo_metadata/0.19.2/download) |
| cargo | `cargo_toml` | `0.22.3` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/cargo_toml/0.22.3/download) |
| cargo | `cc` | `1.4.2` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/cc/1.4.2/download) |
| cargo | `cfb` | `0.7.3` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/cfb/0.7.3/download) |
| cargo | `cfg-if` | `1.0.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/cfg-if/1.0.4/download) |
| cargo | `cookie` | `0.18.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/cookie/0.18.1/download) |
| cargo | `cpufeatures` | `0.2.17` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/cpufeatures/0.2.17/download) |
| cargo | `crc32fast` | `1.5.0` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/crc32fast/1.5.0/download) |
| cargo | `crossbeam-channel` | `0.5.16` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/crossbeam-channel/0.5.16/download) |
| cargo | `crossbeam-utils` | `0.8.22` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/crossbeam-utils/0.8.22/download) |
| cargo | `crypto-common` | `0.1.7` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/crypto-common/0.1.7/download) |
| cargo | `cssparser` | `0.36.0` | windows-runtime | `MPL-2.0` | [archive](https://crates.io/api/v1/crates/cssparser/0.36.0/download) |
| cargo | `cssparser-macros` | `0.6.1` | windows-build-input | `MPL-2.0` | [archive](https://crates.io/api/v1/crates/cssparser-macros/0.6.1/download) |
| cargo | `ctor` | `0.8.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/ctor/0.8.0/download) |
| cargo | `ctor-proc-macro` | `0.0.7` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/ctor-proc-macro/0.0.7/download) |
| cargo | `darling` | `0.23.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/darling/0.23.0/download) |
| cargo | `darling_core` | `0.23.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/darling_core/0.23.0/download) |
| cargo | `darling_macro` | `0.23.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/darling_macro/0.23.0/download) |
| cargo | `deranged` | `0.5.8` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/deranged/0.5.8/download) |
| cargo | `derive_more` | `2.1.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/derive_more/2.1.1/download) |
| cargo | `derive_more-impl` | `2.1.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/derive_more-impl/2.1.1/download) |
| cargo | `digest` | `0.10.7` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/digest/0.10.7/download) |
| cargo | `dirs` | `6.0.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/dirs/6.0.0/download) |
| cargo | `dirs-sys` | `0.5.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/dirs-sys/0.5.0/download) |
| cargo | `displaydoc` | `0.2.7` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/displaydoc/0.2.7/download) |
| cargo | `dom_query` | `0.27.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/dom_query/0.27.0/download) |
| cargo | `dpi` | `0.1.2` | windows-runtime | `Apache-2.0 AND MIT` | [archive](https://crates.io/api/v1/crates/dpi/0.1.2/download) |
| cargo | `dtoa` | `1.0.11` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/dtoa/1.0.11/download) |
| cargo | `dtoa-short` | `0.3.5` | windows-runtime | `MPL-2.0` | [archive](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) |
| cargo | `dunce` | `1.0.5` | windows-runtime | `CC0-1.0 OR MIT-0 OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/dunce/1.0.5/download) |
| cargo | `dyn-clone` | `1.0.20` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/dyn-clone/1.0.20/download) |
| cargo | `embed-resource` | `3.0.11` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/embed-resource/3.0.11/download) |
| cargo | `equivalent` | `1.0.2` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/equivalent/1.0.2/download) |
| cargo | `erased-serde` | `0.4.10` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/erased-serde/0.4.10/download) |
| cargo | `fastrand` | `2.5.0` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/fastrand/2.5.0/download) |
| cargo | `fdeflate` | `0.3.7` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/fdeflate/0.3.7/download) |
| cargo | `find-msvc-tools` | `0.1.10` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/find-msvc-tools/0.1.10/download) |
| cargo | `flate2` | `1.1.9` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/flate2/1.1.9/download) |
| cargo | `fnv` | `1.0.7` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/fnv/1.0.7/download) |
| cargo | `foldhash` | `0.2.0` | windows-runtime | `Zlib` | [archive](https://crates.io/api/v1/crates/foldhash/0.2.0/download) |
| cargo | `form_urlencoded` | `1.2.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/form_urlencoded/1.2.2/download) |
| cargo | `generic-array` | `0.14.7` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/generic-array/0.14.7/download) |
| cargo | `getrandom` | `0.3.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/getrandom/0.3.4/download) |
| cargo | `getrandom` | `0.4.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/getrandom/0.4.3/download) |
| cargo | `glob` | `0.3.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/glob/0.3.4/download) |
| cargo | `hashbrown` | `0.12.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/hashbrown/0.12.3/download) |
| cargo | `hashbrown` | `0.17.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/hashbrown/0.17.1/download) |
| cargo | `heck` | `0.5.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/heck/0.5.0/download) |
| cargo | `html5ever` | `0.38.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/html5ever/0.38.0/download) |
| cargo | `http` | `1.5.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/http/1.5.0/download) |
| cargo | `ico` | `0.5.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/ico/0.5.0/download) |
| cargo | `icu_collections` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_collections/2.2.0/download) |
| cargo | `icu_locale_core` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_locale_core/2.2.0/download) |
| cargo | `icu_normalizer` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_normalizer/2.2.0/download) |
| cargo | `icu_normalizer_data` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_normalizer_data/2.2.0/download) |
| cargo | `icu_properties` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_properties/2.2.0/download) |
| cargo | `icu_properties_data` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_properties_data/2.2.0/download) |
| cargo | `icu_provider` | `2.2.0` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/icu_provider/2.2.0/download) |
| cargo | `ident_case` | `1.0.1` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/ident_case/1.0.1/download) |
| cargo | `idna` | `1.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/idna/1.1.0/download) |
| cargo | `idna_adapter` | `1.2.2` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/idna_adapter/1.2.2/download) |
| cargo | `indexmap` | `1.9.3` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/indexmap/1.9.3/download) |
| cargo | `indexmap` | `2.14.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/indexmap/2.14.0/download) |
| cargo | `infer` | `0.19.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/infer/0.19.0/download) |
| cargo | `itoa` | `1.0.18` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/itoa/1.0.18/download) |
| cargo | `json-patch` | `3.0.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/json-patch/3.0.1/download) |
| cargo | `jsonptr` | `0.6.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/jsonptr/0.6.3/download) |
| cargo | `keyboard-types` | `0.7.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/keyboard-types/0.7.0/download) |
| cargo | `libc` | `0.2.189` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/libc/0.2.189/download) |
| cargo | `litemap` | `0.8.2` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/litemap/0.8.2/download) |
| cargo | `lock_api` | `0.4.14` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/lock_api/0.4.14/download) |
| cargo | `log` | `0.4.33` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/log/0.4.33/download) |
| cargo | `markup5ever` | `0.38.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/markup5ever/0.38.0/download) |
| cargo | `memchr` | `2.8.3` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/memchr/2.8.3/download) |
| cargo | `mime` | `0.3.17` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/mime/0.3.17/download) |
| cargo | `miniz_oxide` | `0.8.9` | windows-build-input | `MIT OR Zlib OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/miniz_oxide/0.8.9/download) |
| cargo | `muda` | `0.19.3` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/muda/0.19.3/download) |
| cargo | `new_debug_unreachable` | `1.0.6` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/new_debug_unreachable/1.0.6/download) |
| cargo | `num-conv` | `0.2.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/num-conv/0.2.2/download) |
| cargo | `once_cell` | `1.21.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/once_cell/1.21.4/download) |
| cargo | `open` | `5.4.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/open/5.4.1/download) |
| cargo | `option-ext` | `0.2.0` | windows-runtime | `MPL-2.0` | [archive](https://crates.io/api/v1/crates/option-ext/0.2.0/download) |
| cargo | `parking_lot` | `0.12.5` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/parking_lot/0.12.5/download) |
| cargo | `parking_lot_core` | `0.9.12` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/parking_lot_core/0.9.12/download) |
| cargo | `percent-encoding` | `2.3.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/percent-encoding/2.3.2/download) |
| cargo | `phf` | `0.13.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/phf/0.13.1/download) |
| cargo | `phf_codegen` | `0.13.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/phf_codegen/0.13.1/download) |
| cargo | `phf_generator` | `0.13.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/phf_generator/0.13.1/download) |
| cargo | `phf_macros` | `0.13.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/phf_macros/0.13.1/download) |
| cargo | `phf_shared` | `0.13.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/phf_shared/0.13.1/download) |
| cargo | `pin-project-lite` | `0.2.17` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/pin-project-lite/0.2.17/download) |
| cargo | `plist` | `1.10.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/plist/1.10.0/download) |
| cargo | `png` | `0.17.16` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/png/0.17.16/download) |
| cargo | `potential_utf` | `0.1.5` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/potential_utf/0.1.5/download) |
| cargo | `powerfmt` | `0.2.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/powerfmt/0.2.0/download) |
| cargo | `precomputed-hash` | `0.1.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/precomputed-hash/0.1.1/download) |
| cargo | `proc-macro2` | `1.0.107` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/proc-macro2/1.0.107/download) |
| cargo | `quick-xml` | `0.41.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/quick-xml/0.41.0/download) |
| cargo | `quote` | `1.0.47` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/quote/1.0.47/download) |
| cargo | `raw-window-handle` | `0.6.2` | windows-runtime | `MIT OR Apache-2.0 OR Zlib` | [archive](https://crates.io/api/v1/crates/raw-window-handle/0.6.2/download) |
| cargo | `regex` | `1.13.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/regex/1.13.1/download) |
| cargo | `regex-automata` | `0.4.18` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/regex-automata/0.4.18/download) |
| cargo | `regex-syntax` | `0.8.11` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/regex-syntax/0.8.11/download) |
| cargo | `rfd` | `0.16.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/rfd/0.16.0/download) |
| cargo | `rustc-hash` | `2.1.3` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/rustc-hash/2.1.3/download) |
| cargo | `rustc_version` | `0.4.1` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/rustc_version/0.4.1/download) |
| cargo | `same-file` | `1.0.6` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/same-file/1.0.6/download) |
| cargo | `schemars` | `0.8.22` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/schemars/0.8.22/download) |
| cargo | `schemars_derive` | `0.8.22` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/schemars_derive/0.8.22/download) |
| cargo | `scopeguard` | `1.2.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/scopeguard/1.2.0/download) |
| cargo | `selectors` | `0.36.1` | windows-runtime | `MPL-2.0` | [archive](https://crates.io/api/v1/crates/selectors/0.36.1/download) |
| cargo | `semver` | `1.0.28` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/semver/1.0.28/download) |
| cargo | `serde` | `1.0.229` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde/1.0.229/download) |
| cargo | `serde-untagged` | `0.1.9` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde-untagged/0.1.9/download) |
| cargo | `serde_core` | `1.0.229` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_core/1.0.229/download) |
| cargo | `serde_derive` | `1.0.229` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_derive/1.0.229/download) |
| cargo | `serde_derive_internals` | `0.29.1` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_derive_internals/0.29.1/download) |
| cargo | `serde_json` | `1.0.151` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_json/1.0.151/download) |
| cargo | `serde_repr` | `0.1.21` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_repr/0.1.21/download) |
| cargo | `serde_spanned` | `1.1.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_spanned/1.1.1/download) |
| cargo | `serde_with` | `3.21.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_with/3.21.0/download) |
| cargo | `serde_with_macros` | `3.21.0` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serde_with_macros/3.21.0/download) |
| cargo | `serialize-to-javascript` | `0.1.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serialize-to-javascript/0.1.2/download) |
| cargo | `serialize-to-javascript-impl` | `0.1.2` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/serialize-to-javascript-impl/0.1.2/download) |
| cargo | `servo_arc` | `0.4.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/servo_arc/0.4.3/download) |
| cargo | `sha2` | `0.10.9` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/sha2/0.10.9/download) |
| cargo | `shlex` | `2.0.1` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/shlex/2.0.1/download) |
| cargo | `simd-adler32` | `0.3.10` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/simd-adler32/0.3.10/download) |
| cargo | `siphasher` | `1.0.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/siphasher/1.0.3/download) |
| cargo | `smallvec` | `1.15.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/smallvec/1.15.2/download) |
| cargo | `softbuffer` | `0.4.8` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/softbuffer/0.4.8/download) |
| cargo | `stable_deref_trait` | `1.2.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/stable_deref_trait/1.2.1/download) |
| cargo | `string_cache` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/string_cache/0.9.0/download) |
| cargo | `string_cache_codegen` | `0.6.1` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/string_cache_codegen/0.6.1/download) |
| cargo | `strsim` | `0.11.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/strsim/0.11.1/download) |
| cargo | `syn` | `2.0.119` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/syn/2.0.119/download) |
| cargo | `syn` | `3.0.3` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/syn/3.0.3/download) |
| cargo | `synstructure` | `0.13.2` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/synstructure/0.13.2/download) |
| cargo | `tao` | `0.35.3` | windows-runtime | `Apache-2.0` | [archive](https://crates.io/api/v1/crates/tao/0.35.3/download) |
| cargo | `tauri` | `2.11.5` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri/2.11.5/download) |
| cargo | `tauri-build` | `2.6.3` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-build/2.6.3/download) |
| cargo | `tauri-codegen` | `2.6.3` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-codegen/2.6.3/download) |
| cargo | `tauri-macros` | `2.6.3` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-macros/2.6.3/download) |
| cargo | `tauri-plugin` | `2.6.3` | windows-build-input | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-plugin/2.6.3/download) |
| cargo | `tauri-plugin-dialog` | `2.7.2` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-plugin-dialog/2.7.2/download) |
| cargo | `tauri-plugin-fs` | `2.5.1` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-plugin-fs/2.5.1/download) |
| cargo | `tauri-plugin-opener` | `2.5.4` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-plugin-opener/2.5.4/download) |
| cargo | `tauri-runtime` | `2.11.3` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-runtime/2.11.3/download) |
| cargo | `tauri-runtime-wry` | `2.11.4` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-runtime-wry/2.11.4/download) |
| cargo | `tauri-utils` | `2.9.3` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/tauri-utils/2.9.3/download) |
| cargo | `tauri-winres` | `0.3.6` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/tauri-winres/0.3.6/download) |
| cargo | `tendril` | `0.5.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/tendril/0.5.1/download) |
| cargo | `thiserror` | `1.0.69` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/thiserror/1.0.69/download) |
| cargo | `thiserror` | `2.0.20` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/thiserror/2.0.20/download) |
| cargo | `thiserror-impl` | `1.0.69` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/thiserror-impl/1.0.69/download) |
| cargo | `thiserror-impl` | `2.0.20` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/thiserror-impl/2.0.20/download) |
| cargo | `time` | `0.3.55` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/time/0.3.55/download) |
| cargo | `time-core` | `0.1.9` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/time-core/0.1.9/download) |
| cargo | `time-macros` | `0.2.32` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/time-macros/0.2.32/download) |
| cargo | `tinystr` | `0.8.3` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/tinystr/0.8.3/download) |
| cargo | `tokio` | `1.53.1` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/tokio/1.53.1/download) |
| cargo | `toml` | `0.9.12+spec-1.1.0` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml/0.9.12%2Bspec-1.1.0/download) |
| cargo | `toml` | `1.1.4+spec-1.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml/1.1.4%2Bspec-1.1.0/download) |
| cargo | `toml_datetime` | `0.7.5+spec-1.1.0` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml_datetime/0.7.5%2Bspec-1.1.0/download) |
| cargo | `toml_datetime` | `1.1.1+spec-1.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml_datetime/1.1.1%2Bspec-1.1.0/download) |
| cargo | `toml_parser` | `1.1.3+spec-1.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml_parser/1.1.3%2Bspec-1.1.0/download) |
| cargo | `toml_writer` | `1.1.2+spec-1.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/toml_writer/1.1.2%2Bspec-1.1.0/download) |
| cargo | `tracing` | `0.1.44` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/tracing/0.1.44/download) |
| cargo | `tracing-core` | `0.1.36` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/tracing-core/0.1.36/download) |
| cargo | `typeid` | `1.0.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/typeid/1.0.3/download) |
| cargo | `typenum` | `1.20.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/typenum/1.20.1/download) |
| cargo | `unic-char-property` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unic-char-property/0.9.0/download) |
| cargo | `unic-char-range` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unic-char-range/0.9.0/download) |
| cargo | `unic-common` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unic-common/0.9.0/download) |
| cargo | `unic-ucd-ident` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unic-ucd-ident/0.9.0/download) |
| cargo | `unic-ucd-version` | `0.9.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unic-ucd-version/0.9.0/download) |
| cargo | `unicode-general-category` | `1.1.0` | windows-runtime | `Apache-2.0` | [archive](https://crates.io/api/v1/crates/unicode-general-category/1.1.0/download) |
| cargo | `unicode-ident` | `1.0.24` | windows-runtime | `(MIT OR Apache-2.0) AND Unicode-3.0` | [archive](https://crates.io/api/v1/crates/unicode-ident/1.0.24/download) |
| cargo | `unicode-segmentation` | `1.13.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/unicode-segmentation/1.13.3/download) |
| cargo | `url` | `2.5.8` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/url/2.5.8/download) |
| cargo | `urlpattern` | `0.3.0` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/urlpattern/0.3.0/download) |
| cargo | `utf8_iter` | `1.0.4` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/utf8_iter/1.0.4/download) |
| cargo | `uuid` | `1.24.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/uuid/1.24.0/download) |
| cargo | `version_check` | `0.9.5` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/version_check/0.9.5/download) |
| cargo | `vswhom` | `0.1.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/vswhom/0.1.0/download) |
| cargo | `vswhom-sys` | `0.1.3` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/vswhom-sys/0.1.3/download) |
| cargo | `walkdir` | `2.5.0` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/walkdir/2.5.0/download) |
| cargo | `web_atoms` | `0.2.5` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/web_atoms/0.2.5/download) |
| cargo | `webview2-com` | `0.38.2` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/webview2-com/0.38.2/download) |
| cargo | `webview2-com-macros` | `0.8.1` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/webview2-com-macros/0.8.1/download) |
| cargo | `webview2-com-sys` | `0.38.2` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/webview2-com-sys/0.38.2/download) |
| cargo | `winapi-util` | `0.1.11` | windows-runtime | `Unlicense OR MIT` | [archive](https://crates.io/api/v1/crates/winapi-util/0.1.11/download) |
| cargo | `window-vibrancy` | `0.6.0` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/window-vibrancy/0.6.0/download) |
| cargo | `windows` | `0.61.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows/0.61.3/download) |
| cargo | `windows-collections` | `0.2.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-collections/0.2.0/download) |
| cargo | `windows-core` | `0.61.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-core/0.61.2/download) |
| cargo | `windows-future` | `0.2.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-future/0.2.1/download) |
| cargo | `windows-implement` | `0.60.2` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-implement/0.60.2/download) |
| cargo | `windows-interface` | `0.59.3` | windows-build-input | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-interface/0.59.3/download) |
| cargo | `windows-link` | `0.1.3` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-link/0.1.3/download) |
| cargo | `windows-link` | `0.2.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-link/0.2.1/download) |
| cargo | `windows-numerics` | `0.2.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-numerics/0.2.0/download) |
| cargo | `windows-result` | `0.3.4` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-result/0.3.4/download) |
| cargo | `windows-strings` | `0.4.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-strings/0.4.2/download) |
| cargo | `windows-sys` | `0.59.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-sys/0.59.0/download) |
| cargo | `windows-sys` | `0.60.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-sys/0.60.2/download) |
| cargo | `windows-sys` | `0.61.2` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-sys/0.61.2/download) |
| cargo | `windows-targets` | `0.52.6` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-targets/0.52.6/download) |
| cargo | `windows-targets` | `0.53.5` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-targets/0.53.5/download) |
| cargo | `windows-threading` | `0.1.0` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-threading/0.1.0/download) |
| cargo | `windows-version` | `0.1.7` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows-version/0.1.7/download) |
| cargo | `windows_x86_64_msvc` | `0.52.6` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.52.6/download) |
| cargo | `windows_x86_64_msvc` | `0.53.1` | windows-runtime | `MIT OR Apache-2.0` | [archive](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.53.1/download) |
| cargo | `winnow` | `0.7.15` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/winnow/0.7.15/download) |
| cargo | `winnow` | `1.0.4` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/winnow/1.0.4/download) |
| cargo | `winreg` | `0.55.0` | windows-build-input | `MIT` | [archive](https://crates.io/api/v1/crates/winreg/0.55.0/download) |
| cargo | `writeable` | `0.6.3` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/writeable/0.6.3/download) |
| cargo | `wry` | `0.55.1` | windows-runtime | `Apache-2.0 OR MIT` | [archive](https://crates.io/api/v1/crates/wry/0.55.1/download) |
| cargo | `yoke` | `0.8.3` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/yoke/0.8.3/download) |
| cargo | `yoke-derive` | `0.8.2` | windows-build-input | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/yoke-derive/0.8.2/download) |
| cargo | `zerofrom` | `0.1.8` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/zerofrom/0.1.8/download) |
| cargo | `zerofrom-derive` | `0.1.7` | windows-build-input | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/zerofrom-derive/0.1.7/download) |
| cargo | `zerotrie` | `0.2.4` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/zerotrie/0.2.4/download) |
| cargo | `zerovec` | `0.11.6` | windows-runtime | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/zerovec/0.11.6/download) |
| cargo | `zerovec-derive` | `0.11.3` | windows-build-input | `Unicode-3.0` | [archive](https://crates.io/api/v1/crates/zerovec-derive/0.11.3/download) |
| cargo | `zmij` | `1.0.23` | windows-runtime | `MIT` | [archive](https://crates.io/api/v1/crates/zmij/1.0.23/download) |
| npm | `@tauri-apps/api` | `2.11.1` | npm-production-closure | `Apache-2.0 OR MIT` | [archive](https://registry.npmjs.org/@tauri-apps/api/-/api-2.11.1.tgz) |
| npm | `@tauri-apps/plugin-opener` | `2.5.4` | npm-production-closure | `MIT OR Apache-2.0` | [archive](https://registry.npmjs.org/@tauri-apps/plugin-opener/-/plugin-opener-2.5.4.tgz) |
| npm | `@types/debug` | `4.1.13` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/debug/-/debug-4.1.13.tgz) |
| npm | `@types/estree` | `1.0.9` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/estree/-/estree-1.0.9.tgz) |
| npm | `@types/estree-jsx` | `1.0.5` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/estree-jsx/-/estree-jsx-1.0.5.tgz) |
| npm | `@types/hast` | `3.0.5` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/hast/-/hast-3.0.5.tgz) |
| npm | `@types/mdast` | `4.0.4` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/mdast/-/mdast-4.0.4.tgz) |
| npm | `@types/ms` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/ms/-/ms-2.1.0.tgz) |
| npm | `@types/react` | `19.2.18` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/react/-/react-19.2.18.tgz) |
| npm | `@types/unist` | `2.0.11` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/unist/-/unist-2.0.11.tgz) |
| npm | `@types/unist` | `3.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/@types/unist/-/unist-3.0.3.tgz) |
| npm | `@ungap/structured-clone` | `1.3.3` | npm-production-closure | `ISC` | [archive](https://registry.npmjs.org/@ungap/structured-clone/-/structured-clone-1.3.3.tgz) |
| npm | `bail` | `2.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/bail/-/bail-2.0.2.tgz) |
| npm | `ccount` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/ccount/-/ccount-2.0.1.tgz) |
| npm | `character-entities` | `2.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/character-entities/-/character-entities-2.0.2.tgz) |
| npm | `character-entities-html4` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/character-entities-html4/-/character-entities-html4-2.1.0.tgz) |
| npm | `character-entities-legacy` | `3.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/character-entities-legacy/-/character-entities-legacy-3.0.0.tgz) |
| npm | `character-reference-invalid` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/character-reference-invalid/-/character-reference-invalid-2.0.1.tgz) |
| npm | `comma-separated-tokens` | `2.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/comma-separated-tokens/-/comma-separated-tokens-2.0.3.tgz) |
| npm | `csstype` | `3.2.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz) |
| npm | `debug` | `4.4.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/debug/-/debug-4.4.3.tgz) |
| npm | `decode-named-character-reference` | `1.3.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/decode-named-character-reference/-/decode-named-character-reference-1.3.0.tgz) |
| npm | `dequal` | `2.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/dequal/-/dequal-2.0.3.tgz) |
| npm | `devlop` | `1.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/devlop/-/devlop-1.1.0.tgz) |
| npm | `escape-string-regexp` | `5.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-5.0.0.tgz) |
| npm | `estree-util-is-identifier-name` | `3.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/estree-util-is-identifier-name/-/estree-util-is-identifier-name-3.0.0.tgz) |
| npm | `extend` | `3.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/extend/-/extend-3.0.2.tgz) |
| npm | `hast-util-is-element` | `3.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/hast-util-is-element/-/hast-util-is-element-3.0.0.tgz) |
| npm | `hast-util-to-jsx-runtime` | `2.3.6` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/hast-util-to-jsx-runtime/-/hast-util-to-jsx-runtime-2.3.6.tgz) |
| npm | `hast-util-to-text` | `4.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/hast-util-to-text/-/hast-util-to-text-4.0.2.tgz) |
| npm | `hast-util-whitespace` | `3.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/hast-util-whitespace/-/hast-util-whitespace-3.0.0.tgz) |
| npm | `highlight.js` | `11.11.1` | npm-production-closure | `BSD-3-Clause` | [archive](https://registry.npmjs.org/highlight.js/-/highlight.js-11.11.1.tgz) |
| npm | `html-url-attributes` | `3.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/html-url-attributes/-/html-url-attributes-3.0.1.tgz) |
| npm | `inline-style-parser` | `0.2.7` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/inline-style-parser/-/inline-style-parser-0.2.7.tgz) |
| npm | `is-alphabetical` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/is-alphabetical/-/is-alphabetical-2.0.1.tgz) |
| npm | `is-alphanumerical` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/is-alphanumerical/-/is-alphanumerical-2.0.1.tgz) |
| npm | `is-decimal` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/is-decimal/-/is-decimal-2.0.1.tgz) |
| npm | `is-hexadecimal` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/is-hexadecimal/-/is-hexadecimal-2.0.1.tgz) |
| npm | `is-plain-obj` | `4.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/is-plain-obj/-/is-plain-obj-4.1.0.tgz) |
| npm | `longest-streak` | `3.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/longest-streak/-/longest-streak-3.1.0.tgz) |
| npm | `lowlight` | `3.3.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/lowlight/-/lowlight-3.3.0.tgz) |
| npm | `markdown-table` | `3.0.4` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/markdown-table/-/markdown-table-3.0.4.tgz) |
| npm | `mdast-util-find-and-replace` | `3.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-find-and-replace/-/mdast-util-find-and-replace-3.0.2.tgz) |
| npm | `mdast-util-from-markdown` | `2.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-from-markdown/-/mdast-util-from-markdown-2.0.3.tgz) |
| npm | `mdast-util-gfm` | `3.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm/-/mdast-util-gfm-3.1.0.tgz) |
| npm | `mdast-util-gfm-autolink-literal` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm-autolink-literal/-/mdast-util-gfm-autolink-literal-2.0.1.tgz) |
| npm | `mdast-util-gfm-footnote` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm-footnote/-/mdast-util-gfm-footnote-2.1.0.tgz) |
| npm | `mdast-util-gfm-strikethrough` | `2.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm-strikethrough/-/mdast-util-gfm-strikethrough-2.0.0.tgz) |
| npm | `mdast-util-gfm-table` | `2.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm-table/-/mdast-util-gfm-table-2.0.0.tgz) |
| npm | `mdast-util-gfm-task-list-item` | `2.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-gfm-task-list-item/-/mdast-util-gfm-task-list-item-2.0.0.tgz) |
| npm | `mdast-util-mdx-expression` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-mdx-expression/-/mdast-util-mdx-expression-2.0.1.tgz) |
| npm | `mdast-util-mdx-jsx` | `3.2.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-mdx-jsx/-/mdast-util-mdx-jsx-3.2.0.tgz) |
| npm | `mdast-util-mdxjs-esm` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-mdxjs-esm/-/mdast-util-mdxjs-esm-2.0.1.tgz) |
| npm | `mdast-util-phrasing` | `4.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-phrasing/-/mdast-util-phrasing-4.1.0.tgz) |
| npm | `mdast-util-to-hast` | `13.2.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-to-hast/-/mdast-util-to-hast-13.2.1.tgz) |
| npm | `mdast-util-to-markdown` | `2.1.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-to-markdown/-/mdast-util-to-markdown-2.1.2.tgz) |
| npm | `mdast-util-to-string` | `4.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/mdast-util-to-string/-/mdast-util-to-string-4.0.0.tgz) |
| npm | `micromark` | `4.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark/-/micromark-4.0.2.tgz) |
| npm | `micromark-core-commonmark` | `2.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-core-commonmark/-/micromark-core-commonmark-2.0.3.tgz) |
| npm | `micromark-extension-gfm` | `3.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm/-/micromark-extension-gfm-3.0.0.tgz) |
| npm | `micromark-extension-gfm-autolink-literal` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-autolink-literal/-/micromark-extension-gfm-autolink-literal-2.1.0.tgz) |
| npm | `micromark-extension-gfm-footnote` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-footnote/-/micromark-extension-gfm-footnote-2.1.0.tgz) |
| npm | `micromark-extension-gfm-strikethrough` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-strikethrough/-/micromark-extension-gfm-strikethrough-2.1.0.tgz) |
| npm | `micromark-extension-gfm-table` | `2.1.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-table/-/micromark-extension-gfm-table-2.1.1.tgz) |
| npm | `micromark-extension-gfm-tagfilter` | `2.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-tagfilter/-/micromark-extension-gfm-tagfilter-2.0.0.tgz) |
| npm | `micromark-extension-gfm-task-list-item` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-extension-gfm-task-list-item/-/micromark-extension-gfm-task-list-item-2.1.0.tgz) |
| npm | `micromark-factory-destination` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-factory-destination/-/micromark-factory-destination-2.0.1.tgz) |
| npm | `micromark-factory-label` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-factory-label/-/micromark-factory-label-2.0.1.tgz) |
| npm | `micromark-factory-space` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-factory-space/-/micromark-factory-space-2.0.1.tgz) |
| npm | `micromark-factory-title` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-factory-title/-/micromark-factory-title-2.0.1.tgz) |
| npm | `micromark-factory-whitespace` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-factory-whitespace/-/micromark-factory-whitespace-2.0.1.tgz) |
| npm | `micromark-util-character` | `2.1.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-character/-/micromark-util-character-2.1.1.tgz) |
| npm | `micromark-util-chunked` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-chunked/-/micromark-util-chunked-2.0.1.tgz) |
| npm | `micromark-util-classify-character` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-classify-character/-/micromark-util-classify-character-2.0.1.tgz) |
| npm | `micromark-util-combine-extensions` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-combine-extensions/-/micromark-util-combine-extensions-2.0.1.tgz) |
| npm | `micromark-util-decode-numeric-character-reference` | `2.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-decode-numeric-character-reference/-/micromark-util-decode-numeric-character-reference-2.0.2.tgz) |
| npm | `micromark-util-decode-string` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-decode-string/-/micromark-util-decode-string-2.0.1.tgz) |
| npm | `micromark-util-encode` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-encode/-/micromark-util-encode-2.0.1.tgz) |
| npm | `micromark-util-html-tag-name` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-html-tag-name/-/micromark-util-html-tag-name-2.0.1.tgz) |
| npm | `micromark-util-normalize-identifier` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-normalize-identifier/-/micromark-util-normalize-identifier-2.0.1.tgz) |
| npm | `micromark-util-resolve-all` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-resolve-all/-/micromark-util-resolve-all-2.0.1.tgz) |
| npm | `micromark-util-sanitize-uri` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-sanitize-uri/-/micromark-util-sanitize-uri-2.0.1.tgz) |
| npm | `micromark-util-subtokenize` | `2.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-subtokenize/-/micromark-util-subtokenize-2.1.0.tgz) |
| npm | `micromark-util-symbol` | `2.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-symbol/-/micromark-util-symbol-2.0.1.tgz) |
| npm | `micromark-util-types` | `2.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/micromark-util-types/-/micromark-util-types-2.0.2.tgz) |
| npm | `ms` | `2.1.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/ms/-/ms-2.1.3.tgz) |
| npm | `parse-entities` | `4.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/parse-entities/-/parse-entities-4.0.2.tgz) |
| npm | `property-information` | `7.2.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/property-information/-/property-information-7.2.0.tgz) |
| npm | `react` | `19.2.8` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/react/-/react-19.2.8.tgz) |
| npm | `react-dom` | `19.2.8` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/react-dom/-/react-dom-19.2.8.tgz) |
| npm | `react-markdown` | `10.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/react-markdown/-/react-markdown-10.1.0.tgz) |
| npm | `rehype-highlight` | `7.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/rehype-highlight/-/rehype-highlight-7.0.2.tgz) |
| npm | `remark-gfm` | `4.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/remark-gfm/-/remark-gfm-4.0.1.tgz) |
| npm | `remark-parse` | `11.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/remark-parse/-/remark-parse-11.0.0.tgz) |
| npm | `remark-rehype` | `11.1.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/remark-rehype/-/remark-rehype-11.1.2.tgz) |
| npm | `remark-stringify` | `11.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/remark-stringify/-/remark-stringify-11.0.0.tgz) |
| npm | `scheduler` | `0.27.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/scheduler/-/scheduler-0.27.0.tgz) |
| npm | `space-separated-tokens` | `2.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/space-separated-tokens/-/space-separated-tokens-2.0.2.tgz) |
| npm | `stringify-entities` | `4.0.4` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/stringify-entities/-/stringify-entities-4.0.4.tgz) |
| npm | `style-to-js` | `1.1.21` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/style-to-js/-/style-to-js-1.1.21.tgz) |
| npm | `style-to-object` | `1.0.14` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/style-to-object/-/style-to-object-1.0.14.tgz) |
| npm | `trim-lines` | `3.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/trim-lines/-/trim-lines-3.0.1.tgz) |
| npm | `trough` | `2.2.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/trough/-/trough-2.2.0.tgz) |
| npm | `unified` | `11.0.5` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unified/-/unified-11.0.5.tgz) |
| npm | `unist-util-find-after` | `5.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-find-after/-/unist-util-find-after-5.0.0.tgz) |
| npm | `unist-util-is` | `6.0.1` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-is/-/unist-util-is-6.0.1.tgz) |
| npm | `unist-util-position` | `5.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-position/-/unist-util-position-5.0.0.tgz) |
| npm | `unist-util-stringify-position` | `4.0.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-stringify-position/-/unist-util-stringify-position-4.0.0.tgz) |
| npm | `unist-util-visit` | `5.1.0` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-visit/-/unist-util-visit-5.1.0.tgz) |
| npm | `unist-util-visit-parents` | `6.0.2` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/unist-util-visit-parents/-/unist-util-visit-parents-6.0.2.tgz) |
| npm | `vfile` | `6.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/vfile/-/vfile-6.0.3.tgz) |
| npm | `vfile-message` | `4.0.3` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/vfile-message/-/vfile-message-4.0.3.tgz) |
| npm | `zwitch` | `2.0.4` | npm-production-closure | `MIT` | [archive](https://registry.npmjs.org/zwitch/-/zwitch-2.0.4.tgz) |
| npm-build-input | `caniuse-lite` | `1.0.30001809` | build-data-not-shipped | `CC-BY-4.0` | [archive](https://registry.npmjs.org/caniuse-lite/-/caniuse-lite-1.0.30001809.tgz) |
| scaffold | `create-tauri-app` | `4.6.2` | source-scaffold | `MIT OR Apache-2.0` | [archive](https://github.com/tauri-apps/create-tauri-app/archive/d959db0f057aa4c1b9cc4ad7f030cffedf3e48a6.tar.gz) |
