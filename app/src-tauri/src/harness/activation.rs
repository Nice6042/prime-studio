use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::broker::{HarnessBroker, SessionOwnership};
use super::generated::{reject_duplicate_json_keys, HarnessUnavailableReason};
use super::profiles::RUNTIME_PROFILES;
use super::sidecar::{SidecarSupervisor, VerifiedSidecarSpec};
use crate::project_catalog::{CatalogSnapshot, ProjectKind, ProjectRootKind};

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_RUNTIME_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESOURCE_FILES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivationError {
    NotInstalled,
    RuntimeIdentityMismatch,
    ResourceVerificationFailed,
    CatalogBindingInvalid,
    EnvironmentUnavailable,
    TransportUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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
    "sha256:58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f";
const PRODUCTION_RESOURCE_PINS: &[(&str, &str)] = &[
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

pub(crate) struct ProductionActivationInput {
    pub daemon_cli: PathBuf,
    pub node: PathBuf,
    pub resource_root: PathBuf,
    pub catalog: CatalogSnapshot,
    pub personal_workspace: PathBuf,
}

pub(crate) async fn activate_production(
    input: ProductionActivationInput,
) -> Result<HarnessBroker, ActivationError> {
    let runtime = verify_production_runtime(&input.daemon_cli)?;
    let node_digest = digest_file(&input.node, 128 * 1024 * 1024)
        .map_err(|_| ActivationError::EnvironmentUnavailable)?;
    if node_digest != PRODUCTION_NODE_DIGEST {
        return Err(ActivationError::EnvironmentUnavailable);
    }
    let pins = PRODUCTION_RESOURCE_PINS
        .iter()
        .map(|(relative, digest)| PinnedResource {
            relative: (*relative).to_owned(),
            digest: (*digest).to_owned(),
        })
        .collect::<Vec<_>>();
    let resources = verify_resource_root(&input.resource_root, &pins)?;
    let entry = input.resource_root.join("index.js");
    let spec = VerifiedSidecarSpec::verify(
        input.node,
        PRODUCTION_NODE_DIGEST.to_owned(),
        vec![
            entry.display().to_string(),
            "--runtime-root".to_owned(),
            child_process_path(&runtime.root),
        ],
        resources,
    )
    .map_err(|_| ActivationError::ResourceVerificationFailed)?;
    let sidecar =
        SidecarSupervisor::start(spec).map_err(|_| ActivationError::TransportUnavailable)?;
    let ownership =
        derive_catalog_ownership_for_runtime(&input.catalog, &input.personal_workspace)?;
    let mut broker = HarnessBroker::new(
        sidecar,
        runtime.package_digest,
        runtime.profile_id,
        ownership,
        None,
    )
    .map_err(|_| ActivationError::CatalogBindingInvalid)?;
    broker
        .bootstrap_owned()
        .await
        .map_err(|_| ActivationError::TransportUnavailable)?;
    Ok(broker)
}

impl ActivationError {
    pub const fn unavailable_reason(self) -> HarnessUnavailableReason {
        match self {
            Self::NotInstalled => HarnessUnavailableReason::NotInstalled,
            Self::RuntimeIdentityMismatch => HarnessUnavailableReason::RuntimeIdentityMismatch,
            Self::ResourceVerificationFailed | Self::CatalogBindingInvalid => {
                HarnessUnavailableReason::SecurityVerificationFailed
            }
            Self::EnvironmentUnavailable | Self::TransportUnavailable => {
                HarnessUnavailableReason::TransportUnavailable
            }
        }
    }
}

pub fn derive_catalog_ownership(
    snapshot: &CatalogSnapshot,
) -> Result<Vec<(String, SessionOwnership)>, ActivationError> {
    derive_catalog_ownership_for_runtime(snapshot, Path::new(""))
}

fn derive_catalog_ownership_for_runtime(
    snapshot: &CatalogSnapshot,
    personal_workspace: &Path,
) -> Result<Vec<(String, SessionOwnership)>, ActivationError> {
    let mut ownership = BTreeMap::<String, SessionOwnership>::new();
    let mut daemon_chat_ids = BTreeSet::new();
    for project in snapshot
        .state
        .projects
        .iter()
        .filter(|project| !project.archived)
    {
        let bound_chats = project
            .chats
            .iter()
            .filter(|chat| !chat.archived && chat.binding.is_some())
            .collect::<Vec<_>>();
        if bound_chats.is_empty() {
            continue;
        }
        let root = match (
            project.kind,
            project.root.kind,
            project.root.path.as_deref(),
        ) {
            (ProjectKind::Folder, ProjectRootKind::Folder, Some(root)) => root.to_owned(),
            (ProjectKind::Personal, ProjectRootKind::StudioManagedEmpty, None)
                if personal_workspace.is_absolute() && personal_workspace.is_dir() =>
            {
                canonical_workspace_identity(personal_workspace)?
            }
            _ => return Err(ActivationError::CatalogBindingInvalid),
        };
        let daemon_project_id = stable_id("project", &root.to_lowercase());
        for chat in bound_chats {
            let binding = chat
                .binding
                .as_ref()
                .ok_or(ActivationError::CatalogBindingInvalid)?;
            let daemon_chat_id = binding
                .agent_id
                .as_deref()
                .filter(|value| valid_daemon_id(value))
                .ok_or(ActivationError::CatalogBindingInvalid)?;
            if !valid_daemon_id(&binding.session_id)
                || binding
                    .account_id
                    .as_deref()
                    .is_some_and(|value| !valid_daemon_id(value))
                || !daemon_chat_ids.insert(daemon_chat_id.to_owned())
                || ownership
                    .insert(
                        binding.session_id.clone(),
                        SessionOwnership {
                            account_id: binding.account_id.clone(),
                            project_id: daemon_project_id.clone(),
                            chat_id: daemon_chat_id.to_owned(),
                        },
                    )
                    .is_some()
            {
                return Err(ActivationError::CatalogBindingInvalid);
            }
        }
    }
    Ok(ownership.into_iter().collect())
}

fn stable_id(prefix: &str, value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    format!("{prefix}-{}", &digest[..24])
}

pub(crate) fn canonical_workspace_identity(path: &Path) -> Result<String, ActivationError> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| ActivationError::CatalogBindingInvalid)?;
        if metadata.file_type().is_symlink() || workspace_metadata_is_reparse(&metadata) {
            return Err(ActivationError::CatalogBindingInvalid);
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ActivationError::CatalogBindingInvalid)?;
    if !canonical.is_absolute() || !canonical.is_dir() {
        return Err(ActivationError::CatalogBindingInvalid);
    }
    Ok(child_process_path(&canonical))
}

#[cfg(windows)]
fn workspace_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn workspace_metadata_is_reparse(_: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn child_process_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        value.into_owned()
    }
}

#[cfg(not(windows))]
fn child_process_path(path: &Path) -> String {
    path.display().to_string()
}

fn valid_daemon_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn verify_production_runtime(daemon_cli: &Path) -> Result<VerifiedRuntime, ActivationError> {
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
    let daemon_cli = canonical_regular_file(daemon_cli, MAX_RUNTIME_FILE_BYTES)
        .map_err(|_| ActivationError::RuntimeIdentityMismatch)?;
    let bundle = daemon_cli
        .parent()
        .filter(|path| path.file_name().and_then(|value| value.to_str()) == Some("bundle"))
        .ok_or(ActivationError::RuntimeIdentityMismatch)?;
    let dist = bundle
        .parent()
        .filter(|path| path.file_name().and_then(|value| value.to_str()) == Some("dist"))
        .ok_or(ActivationError::RuntimeIdentityMismatch)?;
    let root = dist
        .parent()
        .ok_or(ActivationError::RuntimeIdentityMismatch)?
        .to_path_buf();
    let package_path = root.join("package.json");
    let package_bytes = read_regular_bounded(&package_path, MAX_MANIFEST_BYTES)
        .map_err(|_| ActivationError::RuntimeIdentityMismatch)?;
    if digest_bytes(&package_bytes) != profile.package_digest
        || digest_file(&daemon_cli, MAX_RUNTIME_FILE_BYTES)? != profile.daemon_entrypoint_digest
    {
        return Err(ActivationError::RuntimeIdentityMismatch);
    }
    reject_duplicate_json_keys(&package_bytes)
        .map_err(|_| ActivationError::RuntimeIdentityMismatch)?;
    let manifest: Value = serde_json::from_slice(&package_bytes)
        .map_err(|_| ActivationError::RuntimeIdentityMismatch)?;
    if manifest.get("name").and_then(Value::as_str) != Some("prime-agent")
        || manifest.get("version").and_then(Value::as_str) != Some(profile.package_version)
    {
        return Err(ActivationError::RuntimeIdentityMismatch);
    }
    let relative_entrypoint = manifest
        .pointer("/exports/./import")
        .and_then(Value::as_str)
        .ok_or(ActivationError::RuntimeIdentityMismatch)?;
    let relative_path = Path::new(relative_entrypoint);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(ActivationError::RuntimeIdentityMismatch);
    }
    let entrypoint = canonical_regular_file(&root.join(relative_path), MAX_RUNTIME_FILE_BYTES)
        .map_err(|_| ActivationError::RuntimeIdentityMismatch)?;
    if !entrypoint.starts_with(&root)
        || digest_file(&entrypoint, MAX_RUNTIME_FILE_BYTES)? != profile.entrypoint_digest
    {
        return Err(ActivationError::RuntimeIdentityMismatch);
    }
    Ok(VerifiedRuntime {
        root,
        package_digest: profile.package_digest.to_owned(),
        profile_id: profile.id.to_owned(),
    })
}

fn verify_resource_root(
    root: &Path,
    pins: &[PinnedResource],
) -> Result<Vec<(PathBuf, String)>, ActivationError> {
    if pins.len() > MAX_RESOURCE_FILES {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    let root = root
        .canonicalize()
        .map_err(|_| ActivationError::ResourceVerificationFailed)?;
    let root_metadata =
        fs::symlink_metadata(&root).map_err(|_| ActivationError::ResourceVerificationFailed)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    let mut observed = BTreeMap::<String, PathBuf>::new();
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|_| ActivationError::ResourceVerificationFailed)?
        {
            let entry = entry.map_err(|_| ActivationError::ResourceVerificationFailed)?;
            let metadata = entry
                .metadata()
                .map_err(|_| ActivationError::ResourceVerificationFailed)?;
            let file_type = entry
                .file_type()
                .map_err(|_| ActivationError::ResourceVerificationFailed)?;
            if file_type.is_symlink() {
                return Err(ActivationError::ResourceVerificationFailed);
            }
            let path = entry.path();
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(&root)
                    .map_err(|_| ActivationError::ResourceVerificationFailed)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if observed.insert(relative, path).is_some() || observed.len() > MAX_RESOURCE_FILES
                {
                    return Err(ActivationError::ResourceVerificationFailed);
                }
            } else {
                return Err(ActivationError::ResourceVerificationFailed);
            }
        }
    }
    let expected = pins
        .iter()
        .map(|pin| (pin.relative.clone(), pin))
        .collect::<BTreeMap<_, _>>();
    if expected.len() != pins.len()
        || observed.keys().ne(expected.keys())
        || expected.keys().any(|relative| {
            Path::new(relative).is_absolute()
                || relative.contains('\\')
                || Path::new(relative)
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
        })
    {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    observed
        .into_iter()
        .map(|(relative, path)| {
            let pin = expected
                .get(&relative)
                .ok_or(ActivationError::ResourceVerificationFailed)?;
            let actual = digest_file(&path, MAX_RUNTIME_FILE_BYTES)?;
            if actual != pin.digest {
                return Err(ActivationError::ResourceVerificationFailed);
            }
            Ok((path, pin.digest.clone()))
        })
        .collect()
}

fn canonical_regular_file(path: &Path, maximum: u64) -> Result<PathBuf, ActivationError> {
    if !path.is_absolute() {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| ActivationError::ResourceVerificationFailed)?;
        if metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
            return Err(ActivationError::ResourceVerificationFailed);
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ActivationError::ResourceVerificationFailed)?;
    read_regular_bounded(&canonical, maximum)?;
    Ok(canonical)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn read_regular_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, ActivationError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ActivationError::ResourceVerificationFailed)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    let bytes = fs::read(path).map_err(|_| ActivationError::ResourceVerificationFailed)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(ActivationError::ResourceVerificationFailed);
    }
    Ok(bytes)
}

fn digest_file(path: &Path, maximum: u64) -> Result<String, ActivationError> {
    Ok(digest_bytes(&read_regular_bounded(path, maximum)?))
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use sha2::{Digest, Sha256};
    use uuid::Uuid;

    use super::*;
    use crate::project_catalog::{
        CatalogSnapshot, PrimeChatBinding, PrimeChatBindingKind, Project, ProjectChat,
        ProjectChatState, ProjectKind, ProjectRoot, ProjectRootKind,
    };

    fn folder_catalog(path: &Path, bindings: Vec<PrimeChatBinding>) -> CatalogSnapshot {
        CatalogSnapshot {
            revision: 7,
            state: ProjectChatState {
                schema_version: 1,
                selected_project_id: "studio-project".to_owned(),
                projects: vec![
                    Project {
                        id: "project:personal".to_owned(),
                        kind: ProjectKind::Personal,
                        name: "Personal".to_owned(),
                        root: ProjectRoot {
                            kind: ProjectRootKind::StudioManagedEmpty,
                            path: None,
                        },
                        pinned: true,
                        archived: false,
                        selected_chat_id: None,
                        chats: Vec::new(),
                    },
                    Project {
                        id: "studio-project".to_owned(),
                        kind: ProjectKind::Folder,
                        name: "Workspace".to_owned(),
                        root: ProjectRoot {
                            kind: ProjectRootKind::Folder,
                            path: Some(path.display().to_string()),
                        },
                        pinned: false,
                        archived: false,
                        selected_chat_id: Some("studio-chat-0".to_owned()),
                        chats: bindings
                            .into_iter()
                            .enumerate()
                            .map(|(index, binding)| ProjectChat {
                                id: format!("studio-chat-{index}"),
                                project_id: "studio-project".to_owned(),
                                title: format!("Chat {index}"),
                                pinned: false,
                                archived: false,
                                binding: Some(binding),
                            })
                            .collect(),
                    },
                ],
            },
        }
    }

    fn binding(session_id: &str, daemon_chat_id: Option<&str>) -> PrimeChatBinding {
        PrimeChatBinding {
            kind: PrimeChatBindingKind::PrimeSession,
            account_id: None,
            session_id: session_id.to_owned(),
            session_file: format!("{session_id}.jsonl"),
            agent_id: daemon_chat_id.map(str::to_owned),
        }
    }

    #[test]
    fn catalog_ownership_uses_only_daemon_binding_ids() {
        let root = Path::new("C:\\Work\\Prime Studio");
        let catalog = folder_catalog(root, vec![binding("daemon-active", Some("daemon-chat"))]);

        let ownership = derive_catalog_ownership(&catalog).expect("binding is authoritative");

        let expected_project = format!(
            "project-{}",
            hex_digest(root.display().to_string().to_lowercase().as_bytes())[..24].to_owned()
        );
        assert_eq!(ownership.len(), 1);
        assert_eq!(ownership[0].0, "daemon-active");
        assert_eq!(ownership[0].1.project_id, expected_project);
        assert_eq!(ownership[0].1.chat_id, "daemon-chat");
        assert_ne!(ownership[0].0, "studio-chat-0");
        assert_ne!(ownership[0].1.project_id, "studio-project");
    }

    #[test]
    fn catalog_ownership_maps_bound_personal_chats_to_the_owned_personal_workspace() {
        let workspace =
            std::env::temp_dir().join(format!("prime-studio-personal-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&workspace).unwrap();
        let mut catalog = folder_catalog(Path::new(r"C:\Work\Prime Studio"), Vec::new());
        catalog.state.projects[0].chats.push(ProjectChat {
            id: "studio-personal-chat".to_owned(),
            project_id: "project:personal".to_owned(),
            title: "Personal chat".to_owned(),
            pinned: false,
            archived: false,
            binding: Some(binding(
                "daemon-personal-active",
                Some("daemon-personal-chat"),
            )),
        });
        let ownership = derive_catalog_ownership_for_runtime(&catalog, &workspace).unwrap();
        let personal = ownership
            .iter()
            .find(|(session, _)| session == "daemon-personal-active")
            .unwrap();
        assert_eq!(
            personal.1.project_id,
            stable_id(
                "project",
                &canonical_workspace_identity(&workspace)
                    .unwrap()
                    .to_lowercase()
            )
        );
        fs::remove_dir(workspace).unwrap();
    }

    #[test]
    fn catalog_ownership_rejects_incomplete_or_duplicate_bindings() {
        let root = Path::new("C:\\Work\\Prime Studio");
        let incomplete = folder_catalog(root, vec![binding("daemon-active", None)]);
        assert_eq!(
            derive_catalog_ownership(&incomplete),
            Err(ActivationError::CatalogBindingInvalid)
        );

        let duplicate = folder_catalog(
            root,
            vec![
                binding("daemon-active", Some("daemon-chat-a")),
                binding("daemon-active", Some("daemon-chat-b")),
            ],
        );
        assert_eq!(
            derive_catalog_ownership(&duplicate),
            Err(ActivationError::CatalogBindingInvalid)
        );
    }

    #[test]
    fn runtime_verification_reads_pinned_bytes_without_executing_javascript() {
        let root = unique_temp("runtime");
        let cli = root.join("dist/bundle/cli.js");
        let entry = root.join("dist/index.js");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(
            root.join("package.json"),
            br#"{"name":"prime-agent","version":"0.7.1","exports":{".":{"import":"./dist/index.js"}}}"#,
        )
        .unwrap();
        fs::write(&entry, b"throw new Error('must not execute');\n").unwrap();
        fs::write(&cli, b"throw new Error('must not execute');\n").unwrap();
        let package_digest = digest_file(&root.join("package.json"));
        let entrypoint_digest = digest_file(&entry);
        let daemon_entrypoint_digest = digest_file(&cli);
        let profile = RuntimeProfile {
            id: "synthetic-test-profile",
            package_version: "0.7.1",
            package_digest: &package_digest,
            entrypoint_digest: &entrypoint_digest,
            daemon_entrypoint_digest: &daemon_entrypoint_digest,
        };

        let verified = verify_runtime(&cli, &profile).expect("exact bytes are accepted");

        assert_eq!(verified.root, root.canonicalize().unwrap());
        fs::write(&entry, b"changed\n").unwrap();
        assert_eq!(
            verify_runtime(&cli, &profile),
            Err(ActivationError::RuntimeIdentityMismatch)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resource_verification_requires_the_exact_closed_inventory() {
        let root = unique_temp("resources");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("index.js"), b"index\n").unwrap();
        fs::write(root.join("nested/adapter.mjs"), b"adapter\n").unwrap();
        let pins = [
            PinnedResource {
                relative: "index.js".to_owned(),
                digest: digest_file(&root.join("index.js")),
            },
            PinnedResource {
                relative: "nested/adapter.mjs".to_owned(),
                digest: digest_file(&root.join("nested/adapter.mjs")),
            },
        ];

        let verified = verify_resource_root(&root, &pins).expect("closed inventory is accepted");
        assert_eq!(verified.len(), 2);

        fs::write(root.join("unreviewed.js"), b"unreviewed\n").unwrap();
        assert_eq!(
            verify_resource_root(&root, &pins),
            Err(ActivationError::ResourceVerificationFailed)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn production_resource_pins_match_the_built_reviewed_sidecar() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("harness-sidecar/dist/src");
        let pins = PRODUCTION_RESOURCE_PINS
            .iter()
            .map(|(relative, digest)| PinnedResource {
                relative: (*relative).to_owned(),
                digest: (*digest).to_owned(),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            verify_resource_root(&root, &pins).unwrap().len(),
            pins.len()
        );
    }

    #[test]
    #[ignore = "requires the exact reviewed local prime-agent and Node installations"]
    fn production_activation_discovers_locally_without_a_daemon_or_provider_call() {
        let resource_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("harness-sidecar/dist/src");
        let catalog = CatalogSnapshot {
            revision: 0,
            state: ProjectChatState {
                schema_version: 1,
                selected_project_id: "project:personal".to_owned(),
                projects: vec![Project {
                    id: "project:personal".to_owned(),
                    kind: ProjectKind::Personal,
                    name: "Personal".to_owned(),
                    root: ProjectRoot {
                        kind: ProjectRootKind::StudioManagedEmpty,
                        path: None,
                    },
                    pinned: true,
                    archived: false,
                    selected_chat_id: None,
                    chats: Vec::new(),
                }],
            },
        };
        let broker =
            tauri::async_runtime::block_on(activate_production(ProductionActivationInput {
                daemon_cli: crate::prime_cli().unwrap().cli,
                node: crate::production_node().unwrap(),
                resource_root,
                catalog,
                personal_workspace: crate::config_dir().join("personal-workspace"),
            }))
            .unwrap();

        assert_eq!(broker.state(), super::super::broker::BrokerState::Live);
        assert!(broker.projects().is_empty());
    }

    fn unique_temp(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("prime-studio-{label}-{}", Uuid::new_v4()))
    }

    fn hex_digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn digest_file(path: &Path) -> String {
        format!("sha256:{}", hex_digest(&fs::read(path).unwrap()))
    }
}
