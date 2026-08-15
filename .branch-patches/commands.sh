#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path

path = Path("app/src-tauri/src/harness/activation.rs")
text = path.read_text(encoding="utf-8")

def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)

replace_once(
r'''use super::broker::{HarnessBroker, SessionOwnership};
use super::generated::{reject_duplicate_json_keys, HarnessUnavailableReason};
use super::sidecar::{SidecarSupervisor, VerifiedSidecarSpec};
use crate::project_catalog::{CatalogSnapshot, ProjectKind, ProjectRootKind};
''',
r'''use super::broker::{HarnessBroker, SessionOwnership};
use super::generated::{reject_duplicate_json_keys, HarnessUnavailableReason};
use super::profiles::RUNTIME_PROFILES;
use super::sidecar::{SidecarSupervisor, VerifiedSidecarSpec};
use crate::project_catalog::{CatalogSnapshot, ProjectKind, ProjectRootKind};
''',
    "profile registry import",
)

replace_once(
r'''#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRuntime {
    pub root: PathBuf,
    pub package_digest: String,
}

struct RuntimeProfile<'a> {
    package_version: &'a str,
    package_digest: &'a str,
    entrypoint_digest: &'a str,
    daemon_entrypoint_digest: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PinnedResource {
    relative: String,
    digest: String,
}

const PRODUCTION_RUNTIME: RuntimeProfile<'static> = RuntimeProfile {
    package_version: "0.7.1",
    package_digest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
    entrypoint_digest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
    daemon_entrypoint_digest:
        "sha256:16e2324a4e3aa13305c437168d44d7395bab317e292218a52d1c61a7ebdf0993",
};
const PRODUCTION_PROFILE: &str = "prime-agent-daemon-v7-schema13-816309b1cd50";
const PRODUCTION_NODE_DIGEST: &str =
''',
r'''#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRuntime {
    pub root: PathBuf,
    pub package_digest: String,
    pub profile_id: String,
}

struct RuntimeProfile<'a> {
    id: &'a str,
    package_version: &'a str,
    package_digest: &'a str,
    entrypoint_digest: &'a str,
    daemon_entrypoint_digest: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PinnedResource {
    relative: String,
    digest: String,
}

const PRODUCTION_NODE_DIGEST: &str =
''',
    "verified runtime profile binding",
)

replace_once(
r'''const PRODUCTION_RESOURCE_PINS: &[(&str, &str)] = &[
    (
        "compatibility.js",
        "sha256:2f85a4a0afa430ecea3f22d1279a5d791d6140c65d909d57f4b1d58fc8058a76",
    ),
    (
        "fakeDaemonScenario.js",
        "sha256:42d88148f86b7c07b4b1313172094a4a69275960812e1f61a3cfb24b1f92d84f",
    ),
    (
        "framing.js",
        "sha256:a5733a71be3bc78bbfabf55e6bcab9d3c2ff9c00656c5501589f3e0bed430579",
    ),
    (
        "index.js",
        "sha256:cff5a9055d0c7bb51c055c419fd4cc4033e6cd7f23b73fd2373614fe1db1250a",
    ),
    (
        "primeDaemonBridge.js",
        "sha256:6564df54a66e3e8d2953099ba7a91ae6541b234ef1753aa673bcfbc83b824cc1",
    ),
    (
        "redaction.js",
        "sha256:b4af7febdc35de53bcc82f54343315cc7e9fe1f10a2a6e48eddbf850c7713f56",
    ),
    (
        "reviewedPrimeAdapter.js",
        "sha256:3375301cb3d9da7d8e2d7568482cc9029f2d9e04e33df9ba9ffd4ce507c6728c",
    ),
    (
        "runtimeClosure.js",
        "sha256:7db96e1f9a8d38dad9e4bfc063951ce4dc2a4e4688fbe335ba92e9bb9e8f7502",
    ),
    (
        "runtimeDiscovery.js",
        "sha256:6e8297558f802a9f128ca89fef697a1324da208680c5577d3acb8512b6b9ca66",
    ),
    (
        "studioHarnessOperations.js",
        "sha256:c985b592ab583a0283c9d68e6ecccbdd3761096615b14a2a586a30dda19dd470",
    ),
    (
        "profiles/daemon-v7-schema13.js",
        "sha256:2c31e2bf1dc75008cbc31c8858f898fc845aa7890129fcb4e9c4a3f39b89be68",
    ),
    (
        "vendor/package.json",
        "sha256:bdb2183f33a3e93479c191a9b74b0c57c8e7f0e8801126ab348bd07f99f73903",
    ),
    (
        "vendor/prime-daemon-adapter-v0.7.1.mjs",
        "sha256:8097d080916562ffb8c1c80e2cc4a0640418fa5ec8e09456077d3cffb9c785e3",
    ),
    (
        "vendor/prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt",
        "sha256:499f8862091b39e455a54363b0323c1a9c3774f7c292d8bf6dcc7ed4e9871a17",
    ),
];
''',
r'''const PRODUCTION_RESOURCE_PINS: &[(&str, &str)] = &[
    (
        "compatibility.js",
        "sha256:df29f5619188429e5536cac846683ab39ed708957c9679f065f8a5ed2b8bc84d",
    ),
    (
        "fakeDaemonScenario.js",
        "sha256:42d88148f86b7c07b4b1313172094a4a69275960812e1f61a3cfb24b1f92d84f",
    ),
    (
        "framing.js",
        "sha256:a5733a71be3bc78bbfabf55e6bcab9d3c2ff9c00656c5501589f3e0bed430579",
    ),
    (
        "index.js",
        "sha256:cff5a9055d0c7bb51c055c419fd4cc4033e6cd7f23b73fd2373614fe1db1250a",
    ),
    (
        "primeDaemonBridge.js",
        "sha256:4a2b8630c4fda34bc6e587916441eaceb2ba155bb0a83044b68414252e5fd349",
    ),
    (
        "profiles/daemon-v7-schema13.js",
        "sha256:83d4acc591afd699861898d4906366a8cefc71b6559afc42cfd8d3e7bd14c93b",
    ),
    (
        "profiles/daemon-v7-schema16.js",
        "sha256:66b25f448e292b9fb54ae622be259fde92f9530d77a0a088c789ebd78996473f",
    ),
    (
        "profiles/index.js",
        "sha256:c26563d3f3a864c3127e02c421fd22c08c67532c565ed5f21fa399c702c79f83",
    ),
    (
        "redaction.js",
        "sha256:b4af7febdc35de53bcc82f54343315cc7e9fe1f10a2a6e48eddbf850c7713f56",
    ),
    (
        "reviewedPrimeAdapter.js",
        "sha256:99b34fed059d0e8f916f962551aea249455e2dbed3711ff9c890b2d5aaf6eb3b",
    ),
    (
        "runtimeClosure.js",
        "sha256:7db96e1f9a8d38dad9e4bfc063951ce4dc2a4e4688fbe335ba92e9bb9e8f7502",
    ),
    (
        "runtimeDiscovery.js",
        "sha256:abbcfc116f6107e3cbc84b4a9e442e4b7a5a3bc8b2cd6c101a97b15ad30841b2",
    ),
    (
        "studioHarnessOperations.js",
        "sha256:c985b592ab583a0283c9d68e6ecccbdd3761096615b14a2a586a30dda19dd470",
    ),
    (
        "vendor/package.json",
        "sha256:bdb2183f33a3e93479c191a9b74b0c57c8e7f0e8801126ab348bd07f99f73903",
    ),
    (
        "vendor/prime-daemon-adapter-v0.7.1.mjs",
        "sha256:8097d080916562ffb8c1c80e2cc4a0640418fa5ec8e09456077d3cffb9c785e3",
    ),
    (
        "vendor/prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt",
        "sha256:499f8862091b39e455a54363b0323c1a9c3774f7c292d8bf6dcc7ed4e9871a17",
    ),
    (
        "vendor/v0.7.2/package.json",
        "sha256:36deafec913bac913f09b6747126c93c0f1a05e0cd95312ca9e14b10859059fb",
    ),
    (
        "vendor/v0.7.2/prime-daemon-adapter.mjs",
        "sha256:d2b986eb7aeba9dedb1d86d0f4a0b76399d59bbcadfae836360245dd5340c721",
    ),
    (
        "vendor/v0.7.2/prime-daemon-adapter.mjs.LEGAL.txt",
        "sha256:23af88f5a44096d5e0d3f70e4e919d01a3fc60e80eecdecb2c0795160a5d516d",
    ),
];
''',
    "sidecar resource closure",
)

replace_once(
r'''    let runtime = verify_runtime(&input.daemon_cli, &PRODUCTION_RUNTIME)?;
''',
r'''    let runtime = verify_production_runtime(&input.daemon_cli)?;
''',
    "production runtime selection",
)

replace_once(
r'''        PRODUCTION_PROFILE.to_owned(),
''',
r'''        runtime.profile_id,
''',
    "broker profile binding",
)

replace_once(
r'''fn verify_runtime(
    daemon_cli: &Path,
    profile: &RuntimeProfile<'_>,
) -> Result<VerifiedRuntime, ActivationError> {
''',
r'''fn verify_production_runtime(daemon_cli: &Path) -> Result<VerifiedRuntime, ActivationError> {
    for profile in RUNTIME_PROFILES {
        let expected = RuntimeProfile {
            id: profile.id,
            package_version: profile.package_version,
            package_digest: profile.package_digest,
            entrypoint_digest: profile.entrypoint_digest,
            daemon_entrypoint_digest: profile.daemon_entrypoint_digest,
        };
        match verify_runtime(daemon_cli, &expected) {
            Ok(runtime) => return Ok(runtime),
            Err(ActivationError::RuntimeIdentityMismatch) => {}
            Err(error) => return Err(error),
        }
    }
    Err(ActivationError::RuntimeIdentityMismatch)
}

fn verify_runtime(
    daemon_cli: &Path,
    profile: &RuntimeProfile<'_>,
) -> Result<VerifiedRuntime, ActivationError> {
''',
    "production profile verifier",
)

replace_once(
r'''    Ok(VerifiedRuntime {
        root,
        package_digest: profile.package_digest.to_owned(),
    })
''',
r'''    Ok(VerifiedRuntime {
        root,
        package_digest: profile.package_digest.to_owned(),
        profile_id: profile.id.to_owned(),
    })
''',
    "verified runtime result",
)

replace_once(
r'''        let profile = RuntimeProfile {
            package_version: "0.7.1",
''',
r'''        let profile = RuntimeProfile {
            id: "synthetic-test-profile",
            package_version: "0.7.1",
''',
    "synthetic runtime profile",
)

path.write_text(text, encoding="utf-8")
PY

rm -f .branch-patches/activation-marker
cargo fmt --manifest-path app/src-tauri/Cargo.toml --all
cargo fmt --manifest-path app/src-tauri/Cargo.toml --all -- --check
(
  cd app
  npm ci
  npm run build
)
