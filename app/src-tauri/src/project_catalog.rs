use std::collections::HashSet;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::accounts::sync_parent;

const SCHEMA_VERSION: u8 = 2;
const PERSONAL_PROJECT_ID: &str = "project:personal";
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTAINER_NODES: usize = 10_000;
const MAX_SNAPSHOT_DEPTH: usize = 64;
const MAX_OWN_KEY_WORK: usize = 100_000;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const CATALOG_FILE_NAME: &str = "projects-v2.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CatalogErrorCode {
    InvalidCommand,
    RecoveryRequired,
    RevisionConflict,
    RevisionOverflow,
    StateLimitExceeded,
    PersistenceOutcomeUnknown,
    WriteFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogError {
    code: CatalogErrorCode,
}

impl CatalogError {
    pub fn code(&self) -> &'static str {
        match self.code {
            CatalogErrorCode::InvalidCommand => "invalidCommand",
            CatalogErrorCode::RecoveryRequired => "recoveryRequired",
            CatalogErrorCode::RevisionConflict => "revisionConflict",
            CatalogErrorCode::RevisionOverflow => "revisionOverflow",
            CatalogErrorCode::StateLimitExceeded => "stateLimitExceeded",
            CatalogErrorCode::PersistenceOutcomeUnknown => "persistenceOutcomeUnknown",
            CatalogErrorCode::WriteFailed => "writeFailed",
        }
    }

    fn invalid_command() -> Self {
        Self {
            code: CatalogErrorCode::InvalidCommand,
        }
    }

    fn recovery_required() -> Self {
        Self {
            code: CatalogErrorCode::RecoveryRequired,
        }
    }

    fn revision_conflict() -> Self {
        Self {
            code: CatalogErrorCode::RevisionConflict,
        }
    }

    fn revision_overflow() -> Self {
        Self {
            code: CatalogErrorCode::RevisionOverflow,
        }
    }

    fn state_limit_exceeded() -> Self {
        Self {
            code: CatalogErrorCode::StateLimitExceeded,
        }
    }

    fn persistence_outcome_unknown() -> Self {
        Self {
            code: CatalogErrorCode::PersistenceOutcomeUnknown,
        }
    }

    fn write_failed() -> Self {
        Self {
            code: CatalogErrorCode::WriteFailed,
        }
    }
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for CatalogError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSnapshot {
    pub revision: u64,
    pub state: ProjectChatState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectChatState {
    pub schema_version: u8,
    pub selected_project_id: String,
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKind {
    Personal,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectRootKind {
    StudioManagedEmpty,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRoot {
    pub kind: ProjectRootKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub kind: ProjectKind,
    pub name: String,
    pub root: ProjectRoot,
    pub pinned: bool,
    pub archived: bool,
    pub selected_chat_id: Option<String>,
    pub chats: Vec<ProjectChat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectChat {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub pinned: bool,
    pub archived: bool,
    pub binding: Option<PrimeChatBinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrimeChatBindingKind {
    PrimeSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrimeChatBinding {
    pub kind: PrimeChatBindingKind,
    pub account_id: Option<String>,
    pub session_id: String,
    /// Non-authoritative relative basename metadata. This value is never resolved as a path.
    pub session_file: String,
    pub agent_id: Option<String>,
}

#[derive(Default)]
enum RequiredField<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

struct RequiredFieldVisitor<T>(std::marker::PhantomData<T>);

impl<'de, T> serde::de::Visitor<'de> for RequiredFieldVisitor<T>
where
    T: Deserialize<'de>,
{
    type Value = RequiredField<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("null or a directly decoded field value")
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(RequiredField::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(RequiredField::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        T::deserialize(deserializer).map(RequiredField::Value)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectRootWire {
    kind: ProjectRootKind,
    #[serde(default)]
    path: RequiredField<String>,
}

impl<'de, T> Deserialize<'de> for RequiredField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_option(RequiredFieldVisitor(std::marker::PhantomData))
    }
}

impl<'de> Deserialize<'de> for ProjectRoot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ProjectRootWire::deserialize(deserializer)?;
        Ok(match (wire.kind, wire.path) {
            (ProjectRootKind::StudioManagedEmpty, RequiredField::Missing) => Self {
                kind: ProjectRootKind::StudioManagedEmpty,
                path: None,
            },
            (ProjectRootKind::Folder, RequiredField::Value(path)) => Self {
                kind: ProjectRootKind::Folder,
                path: Some(path),
            },
            (ProjectRootKind::StudioManagedEmpty, _) => {
                return Err(serde::de::Error::custom(
                    "studio-managed-empty root cannot contain path",
                ));
            }
            (ProjectRootKind::Folder, _) => {
                return Err(serde::de::Error::custom("folder root requires string path"));
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectWire {
    id: String,
    kind: ProjectKind,
    name: String,
    root: ProjectRoot,
    pinned: bool,
    archived: bool,
    #[serde(default)]
    selected_chat_id: RequiredField<String>,
    chats: Vec<ProjectChat>,
}

impl<'de> Deserialize<'de> for Project {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ProjectWire::deserialize(deserializer)?;
        Ok(Self {
            id: wire.id,
            kind: wire.kind,
            name: wire.name,
            root: wire.root,
            pinned: wire.pinned,
            archived: wire.archived,
            selected_chat_id: required_nullable::<D::Error, _>(
                wire.selected_chat_id,
                "selectedChatId",
            )?,
            chats: wire.chats,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectChatWire {
    id: String,
    project_id: String,
    title: String,
    pinned: bool,
    archived: bool,
    #[serde(default)]
    binding: RequiredField<PrimeChatBinding>,
}

impl<'de> Deserialize<'de> for ProjectChat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ProjectChatWire::deserialize(deserializer)?;
        Ok(Self {
            id: wire.id,
            project_id: wire.project_id,
            title: wire.title,
            pinned: wire.pinned,
            archived: wire.archived,
            binding: required_nullable::<D::Error, _>(wire.binding, "binding")?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrimeChatBindingWire {
    kind: PrimeChatBindingKind,
    #[serde(default)]
    account_id: RequiredField<String>,
    session_id: String,
    session_file: String,
    #[serde(default)]
    agent_id: RequiredField<String>,
}

impl<'de> Deserialize<'de> for PrimeChatBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = PrimeChatBindingWire::deserialize(deserializer)?;
        Ok(Self {
            kind: wire.kind,
            account_id: required_nullable::<D::Error, _>(wire.account_id, "accountId")?,
            session_id: wire.session_id,
            session_file: wire.session_file,
            agent_id: required_nullable::<D::Error, _>(wire.agent_id, "agentId")?,
        })
    }
}

fn required_nullable<E, T>(value: RequiredField<T>, field: &'static str) -> Result<Option<T>, E>
where
    E: serde::de::Error,
{
    match value {
        RequiredField::Missing => Err(E::missing_field(field)),
        RequiredField::Null => Ok(None),
        RequiredField::Value(value) => Ok(Some(value)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProjectChatCommand {
    #[serde(rename = "project.create")]
    ProjectCreate(ProjectCreateCommand),
    #[serde(rename = "chat.create")]
    ChatCreate(ChatCreateCommand),
    #[serde(rename = "chat.bind-prime-session")]
    BindPrimeSession(BindPrimeSessionCommand),
    #[serde(rename = "project.rename")]
    ProjectRename(ProjectRenameCommand),
    #[serde(rename = "project.archive")]
    ProjectArchive(ProjectIdCommand),
    #[serde(rename = "project.restore")]
    ProjectRestore(ProjectIdCommand),
    #[serde(rename = "project.set-pinned")]
    SetProjectPinned(SetProjectPinnedCommand),
    #[serde(rename = "chat.rename")]
    ChatRename(ChatRenameCommand),
    #[serde(rename = "chat.archive")]
    ChatArchive(ChatIdCommand),
    #[serde(rename = "chat.restore")]
    ChatRestore(ChatIdCommand),
    #[serde(rename = "chat.set-pinned")]
    SetChatPinned(SetChatPinnedCommand),
    #[serde(rename = "chat.duplicate")]
    DuplicateChat(DuplicateChatCommand),
    #[serde(rename = "chat.move")]
    MoveChat(MoveChatCommand),
    #[serde(rename = "chat.delete")]
    DeleteChat(ChatIdCommand),
    #[serde(rename = "selection.select-project")]
    SelectProject(SelectProjectCommand),
    #[serde(rename = "selection.select-chat")]
    SelectChat(ChatIdCommand),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreateCommand {
    pub project_id: String,
    pub name: String,
    pub folder_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRenameCommand {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectIdCommand {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProjectPinnedCommand {
    pub project_id: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatCreateCommand {
    pub project_id: String,
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindPrimeSessionCommand {
    pub project_id: String,
    pub chat_id: String,
    pub binding: PrimeChatBinding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRenameCommand {
    pub project_id: String,
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatIdCommand {
    pub project_id: String,
    pub chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetChatPinnedCommand {
    pub project_id: String,
    pub chat_id: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicateChatCommand {
    pub project_id: String,
    pub chat_id: String,
    pub new_chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveChatCommand {
    pub project_id: String,
    pub chat_id: String,
    pub target_project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectProjectCommand {
    pub project_id: String,
}

fn exact_catalog_root(destination: &Path) -> std::io::Result<&Path> {
    if destination.file_name() != Some(std::ffi::OsStr::new(CATALOG_FILE_NAME)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog must be the exact service-owned file name",
        ));
    }
    let root = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog must be a direct child of its service-owned root",
        )
    })?;
    if !root.is_absolute()
        || root.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog root must be an absolute normalized path",
        ));
    }
    Ok(root)
}

#[cfg(windows)]
struct CatalogDirectoryGuard {
    path: PathBuf,
    canonical: PathBuf,
    file: File,
}

#[cfg(windows)]
struct CatalogNamespace {
    root: PathBuf,
    guards: Vec<CatalogDirectoryGuard>,
}

#[cfg(windows)]
impl CatalogNamespace {
    fn confine(destination: &Path) -> std::io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        let requested_root = exact_catalog_root(destination)?;
        let mut ancestors = requested_root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut guards = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let before = fs::symlink_metadata(&path)?;
            if !before.is_dir() || windows_attributes_are_reparse(before.file_attributes()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root has a reparse ancestor",
                ));
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            let opened = file.metadata()?;
            if !opened.is_dir() || windows_attributes_are_reparse(opened.file_attributes()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root handle is a reparse point",
                ));
            }
            guards.push(CatalogDirectoryGuard {
                canonical: fs::canonicalize(&path)?,
                path,
                file,
            });
        }
        let root = fs::canonicalize(requested_root)?;
        let namespace = Self { root, guards };
        namespace.revalidate()?;
        namespace.revalidate_catalog_leaf()?;
        Ok(namespace)
    }

    fn catalog_path(&self) -> PathBuf {
        self.root.join(CATALOG_FILE_NAME)
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::windows::fs::MetadataExt;

        for guard in &self.guards {
            let path = fs::symlink_metadata(&guard.path)?;
            let opened = guard.file.metadata()?;
            if !path.is_dir()
                || !opened.is_dir()
                || windows_attributes_are_reparse(path.file_attributes())
                || windows_attributes_are_reparse(opened.file_attributes())
                || fs::canonicalize(&guard.path)? != guard.canonical
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root namespace changed",
                ));
            }
        }
        Ok(())
    }

    fn revalidate_catalog_leaf(&self) -> std::io::Result<()> {
        self.revalidate()?;
        reject_catalog_leaf_reparse(&self.catalog_path())
    }
}

#[cfg(unix)]
struct CatalogDirectoryGuard {
    path: PathBuf,
    file: File,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
struct CatalogNamespace {
    root: PathBuf,
    guards: Vec<CatalogDirectoryGuard>,
}

#[cfg(unix)]
impl CatalogNamespace {
    fn confine(destination: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let requested_root = exact_catalog_root(destination)?;
        let mut ancestors = requested_root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut guards = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let before = fs::symlink_metadata(&path)?;
            if before.file_type().is_symlink() || !before.is_dir() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root has a symlink ancestor",
                ));
            }
            let file = File::open(&path)?;
            let opened = file.metadata()?;
            let after = fs::symlink_metadata(&path)?;
            if !opened.is_dir()
                || after.file_type().is_symlink()
                || before.dev() != opened.dev()
                || before.ino() != opened.ino()
                || after.dev() != opened.dev()
                || after.ino() != opened.ino()
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root identity changed while opening",
                ));
            }
            guards.push(CatalogDirectoryGuard {
                path,
                device: opened.dev(),
                inode: opened.ino(),
                file,
            });
        }
        let root = fs::canonicalize(requested_root)?;
        let namespace = Self { root, guards };
        namespace.revalidate()?;
        namespace.revalidate_catalog_leaf()?;
        Ok(namespace)
    }

    fn catalog_path(&self) -> PathBuf {
        self.root.join(CATALOG_FILE_NAME)
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;

        for guard in &self.guards {
            let path = fs::symlink_metadata(&guard.path)?;
            let opened = guard.file.metadata()?;
            if path.file_type().is_symlink()
                || !path.is_dir()
                || path.dev() != guard.device
                || path.ino() != guard.inode
                || opened.dev() != guard.device
                || opened.ino() != guard.inode
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog root namespace changed",
                ));
            }
        }
        Ok(())
    }

    fn revalidate_catalog_leaf(&self) -> std::io::Result<()> {
        self.revalidate()?;
        reject_catalog_leaf_reparse(&self.catalog_path())
    }
}

#[cfg(not(any(windows, unix)))]
struct CatalogNamespace;

#[cfg(not(any(windows, unix)))]
impl CatalogNamespace {
    fn confine(_destination: &Path) -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "catalog namespace confinement is unavailable",
        ))
    }

    fn catalog_path(&self) -> PathBuf {
        PathBuf::new()
    }

    fn revalidate(&self) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "catalog namespace confinement is unavailable",
        ))
    }

    fn revalidate_catalog_leaf(&self) -> std::io::Result<()> {
        self.revalidate()
    }
}

fn reject_catalog_leaf_reparse(path: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if windows_attributes_are_reparse(metadata.file_attributes()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog leaf is a reparse point",
            ));
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "catalog leaf is a symbolic link",
        ));
    }
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "catalog leaf is not a regular file",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_attributes_are_reparse(attributes: u32) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub struct ProjectCatalog {
    path: PathBuf,
    mutation: Mutex<()>,
    lock_provisioned: bool,
    namespace: Option<CatalogNamespace>,
}

impl ProjectCatalog {
    /// Service-startup constructor. It confines the exact catalog child and
    /// provisions the service-owned lock before any command can run; `load`
    /// subsequently opens that lock without creating filesystem state.
    pub fn new(path: PathBuf) -> Self {
        let namespace = CatalogNamespace::confine(&path).ok();
        let confined_path = namespace
            .as_ref()
            .map(CatalogNamespace::catalog_path)
            .unwrap_or(path);
        let lock_provisioned = namespace.as_ref().is_some_and(|namespace| {
            namespace.revalidate().is_ok()
                && CatalogFileLock::provision(&confined_path).is_ok()
                && namespace.revalidate().is_ok()
        });
        Self {
            path: confined_path,
            mutation: Mutex::new(()),
            lock_provisioned,
            namespace,
        }
    }

    pub fn load(&self) -> Result<CatalogSnapshot, CatalogError> {
        let namespace = self
            .namespace
            .as_ref()
            .filter(|_| self.lock_provisioned)
            .ok_or_else(CatalogError::recovery_required)?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;
        let _local = self
            .mutation
            .lock()
            .map_err(|_| CatalogError::recovery_required())?;
        let _file_lock =
            CatalogFileLock::acquire(&self.path).map_err(|_| CatalogError::write_failed())?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;
        let snapshot = load_snapshot(&self.path)?;
        _file_lock
            .revalidate()
            .map_err(|_| CatalogError::recovery_required())?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;
        Ok(snapshot)
    }

    pub fn apply(
        &self,
        expected_revision: u64,
        command: ProjectChatCommand,
    ) -> Result<CatalogSnapshot, CatalogError> {
        let namespace = self
            .namespace
            .as_ref()
            .filter(|_| self.lock_provisioned)
            .ok_or_else(CatalogError::recovery_required)?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;
        let _local = self
            .mutation
            .lock()
            .map_err(|_| CatalogError::recovery_required())?;
        let _file_lock =
            CatalogFileLock::acquire(&self.path).map_err(|_| CatalogError::write_failed())?;
        _file_lock
            .revalidate()
            .map_err(|_| CatalogError::recovery_required())?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;

        let (current, previous_bytes) = load_snapshot_with_bytes(&self.path)?;
        _file_lock
            .revalidate()
            .map_err(|_| CatalogError::recovery_required())?;
        namespace
            .revalidate_catalog_leaf()
            .map_err(|_| CatalogError::recovery_required())?;
        if current.revision != expected_revision {
            return Err(CatalogError::revision_conflict());
        }

        let mut state = current.state.clone();
        let changed = apply_command(&mut state, command)?;
        if !changed {
            _file_lock
                .revalidate()
                .map_err(|_| CatalogError::recovery_required())?;
            namespace
                .revalidate_catalog_leaf()
                .map_err(|_| CatalogError::recovery_required())?;
            return Ok(current);
        }

        validate_state(&state).map_err(|_| CatalogError::recovery_required())?;
        let folder_roots =
            FolderRootGuards::acquire(&state).map_err(|_| CatalogError::recovery_required())?;
        let revision = current
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_REVISION)
            .ok_or_else(CatalogError::revision_overflow)?;
        let next = CatalogSnapshot { revision, state };
        let bytes = serde_json::to_vec(&next).map_err(|_| CatalogError::state_limit_exceeded())?;
        if bytes.len() > MAX_CATALOG_BYTES {
            return Err(CatalogError::state_limit_exceeded());
        }
        let value =
            serde_json::to_value(&next).map_err(|_| CatalogError::state_limit_exceeded())?;
        validate_catalog_value_bounds(&value).map_err(|_| CatalogError::state_limit_exceeded())?;
        folder_roots
            .revalidate()
            .map_err(|_| CatalogError::recovery_required())?;
        let outcome = persist_catalog_with_sync_and_guard(
            &self.path,
            previous_bytes.as_deref(),
            &bytes,
            || {
                _file_lock.revalidate()?;
                namespace.revalidate_catalog_leaf()?;
                folder_roots.revalidate()
            },
            sync_parent,
        );
        let reconciled = reconcile_persistence_with_sync(
            &self.path,
            previous_bytes.as_deref(),
            &bytes,
            outcome,
            sync_parent,
        );
        let guards_valid = _file_lock.revalidate().is_ok()
            && namespace.revalidate_catalog_leaf().is_ok()
            && folder_roots.revalidate().is_ok();
        finalize_persistence(outcome, reconciled, guards_valid)?;
        Ok(next)
    }
}

fn initial_snapshot() -> CatalogSnapshot {
    CatalogSnapshot {
        revision: 0,
        state: ProjectChatState {
            schema_version: SCHEMA_VERSION,
            selected_project_id: PERSONAL_PROJECT_ID.to_owned(),
            projects: vec![Project {
                id: PERSONAL_PROJECT_ID.to_owned(),
                kind: ProjectKind::Personal,
                name: "Personal".to_owned(),
                root: ProjectRoot {
                    kind: ProjectRootKind::StudioManagedEmpty,
                    path: None,
                },
                pinned: false,
                archived: false,
                selected_chat_id: None,
                chats: Vec::new(),
            }],
        },
    }
}

fn load_snapshot(path: &Path) -> Result<CatalogSnapshot, CatalogError> {
    load_snapshot_with_bytes(path).map(|(snapshot, _)| snapshot)
}

fn load_snapshot_with_bytes(
    path: &Path,
) -> Result<(CatalogSnapshot, Option<Vec<u8>>), CatalogError> {
    let Some(bytes) = read_catalog_bytes(path).map_err(|_| CatalogError::recovery_required())?
    else {
        return Ok((initial_snapshot(), None));
    };
    let snapshot = decode_snapshot(&bytes)?;
    Ok((snapshot, Some(bytes)))
}

fn read_catalog_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    for evidence in [catalog_recovery_path(path)?, catalog_backup_path(path)?] {
        match fs::symlink_metadata(&evidence) {
            Ok(_) => {
                reject_catalog_leaf_reparse(&evidence)?;
                return Err(std::io::Error::other(
                    "catalog has pending replacement recovery evidence",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    read_catalog_candidate_bytes(path)
}

fn read_catalog_candidate_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let bounded = crate::bounded_io::read_bounded(path, MAX_CATALOG_BYTES)
        .map_err(|_| std::io::Error::other("catalog bounded read failed"))?;
    Ok(Some(bounded.bytes))
}

fn decode_snapshot(bytes: &[u8]) -> Result<CatalogSnapshot, CatalogError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| CatalogError::recovery_required())?;
    validate_catalog_value_bounds(&value).map_err(|_| CatalogError::recovery_required())?;
    let snapshot: CatalogSnapshot =
        serde_json::from_slice(bytes).map_err(|_| CatalogError::recovery_required())?;
    if snapshot.revision > MAX_SAFE_REVISION {
        return Err(CatalogError::recovery_required());
    }
    validate_state(&snapshot.state).map_err(|_| CatalogError::recovery_required())?;
    Ok(snapshot)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersistenceOutcome {
    Committed,
    NotCommitted,
    OutcomeUnknown,
    NamespaceNotCommitted,
    NamespaceOutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconciledPersistence {
    Committed,
    NotCommitted,
    OutcomeUnknown,
}

#[cfg(test)]
fn persist_catalog_with_sync<F>(destination: &Path, bytes: &[u8], sync: F) -> PersistenceOutcome
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let previous = read_catalog_candidate_bytes(destination).ok().flatten();
    persist_catalog_with_sync_and_guard(destination, previous.as_deref(), bytes, || Ok(()), sync)
}

fn persist_catalog_with_sync_and_guard<F, G>(
    destination: &Path,
    previous: Option<&[u8]>,
    bytes: &[u8],
    guard: G,
    sync: F,
) -> PersistenceOutcome
where
    F: FnMut(&Path) -> std::io::Result<()>,
    G: FnMut() -> std::io::Result<()>,
{
    persist_catalog_transaction_with(
        destination,
        previous,
        bytes,
        guard,
        sync,
        replace_catalog_file,
    )
}

fn persist_catalog_transaction_with<F, G, R>(
    destination: &Path,
    previous: Option<&[u8]>,
    bytes: &[u8],
    mut guard: G,
    mut sync: F,
    replace: R,
) -> PersistenceOutcome
where
    F: FnMut(&Path) -> std::io::Result<()>,
    G: FnMut() -> std::io::Result<()>,
    R: FnOnce(&Path, &Path, &Path) -> std::io::Result<()>,
{
    let Some(parent) = destination.parent() else {
        return PersistenceOutcome::NotCommitted;
    };
    let temporary = match catalog_temporary_path(destination) {
        Ok(path) => path,
        Err(_) => return PersistenceOutcome::NotCommitted,
    };
    let backup = match catalog_backup_path(destination) {
        Ok(path) => path,
        Err(_) => return PersistenceOutcome::NotCommitted,
    };
    let recovery = match catalog_recovery_path(destination) {
        Ok(path) => path,
        Err(_) => return PersistenceOutcome::NotCommitted,
    };
    if candidate_exists(&backup).unwrap_or(true) || candidate_exists(&recovery).unwrap_or(true) {
        return PersistenceOutcome::OutcomeUnknown;
    }

    if write_new_durable_file(&temporary, bytes).is_err() {
        let _ = fs::remove_file(&temporary);
        return PersistenceOutcome::NotCommitted;
    }
    let journal = match replacement_journal_bytes(&temporary, &backup, previous, bytes) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = remove_known_candidate(&temporary, Some(bytes));
            return PersistenceOutcome::NotCommitted;
        }
    };
    if write_new_durable_file(&recovery, &journal).is_err() || sync(parent).is_err() {
        return if cleanup_replacement_candidates(
            &temporary, &backup, &recovery, previous, bytes, &journal, parent, &mut sync,
        )
        .is_ok()
        {
            PersistenceOutcome::NotCommitted
        } else {
            PersistenceOutcome::OutcomeUnknown
        };
    }

    if guard().is_err() {
        return if cleanup_replacement_candidates(
            &temporary, &backup, &recovery, previous, bytes, &journal, parent, &mut sync,
        )
        .is_ok()
        {
            PersistenceOutcome::NamespaceNotCommitted
        } else {
            PersistenceOutcome::NamespaceOutcomeUnknown
        };
    }
    if replace(&temporary, destination, &backup).is_err() {
        return reconcile_replace_candidates(
            destination,
            &temporary,
            &backup,
            &recovery,
            previous,
            bytes,
            &journal,
            &mut guard,
            &mut sync,
        );
    }
    if guard().is_err() {
        return PersistenceOutcome::NamespaceOutcomeUnknown;
    }
    if sync(parent).is_err() {
        return reconcile_replace_candidates(
            destination,
            &temporary,
            &backup,
            &recovery,
            previous,
            bytes,
            &journal,
            &mut guard,
            &mut sync,
        );
    }
    if guard().is_err() {
        return PersistenceOutcome::NamespaceOutcomeUnknown;
    }
    if cleanup_replacement_candidates(
        &temporary, &backup, &recovery, previous, bytes, &journal, parent, &mut sync,
    )
    .is_err()
    {
        return PersistenceOutcome::OutcomeUnknown;
    }
    if guard().is_err() {
        PersistenceOutcome::NamespaceOutcomeUnknown
    } else {
        PersistenceOutcome::Committed
    }
}

fn candidate_exists(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            reject_catalog_leaf_reparse(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn write_new_durable_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_WRITE_THROUGH;

        options.custom_flags(FILE_FLAG_WRITE_THROUGH);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn replacement_journal_bytes(
    temporary: &Path,
    backup: &Path,
    previous: Option<&[u8]>,
    intended: &[u8],
) -> std::io::Result<Vec<u8>> {
    let temporary = temporary
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other("replacement temp name is not Unicode"))?;
    let backup = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other("replacement backup name is not Unicode"))?;
    serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "temporary": temporary,
        "backup": backup,
        "previousSha256": previous.map(sha256_hex),
        "intendedSha256": sha256_hex(intended),
    }))
    .map_err(std::io::Error::other)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn remove_known_candidate(path: &Path, expected: Option<&[u8]>) -> std::io::Result<()> {
    match read_catalog_candidate_bytes(path)? {
        None => Ok(()),
        Some(observed) if expected.is_some_and(|expected| observed == expected) => {
            reject_catalog_leaf_reparse(path)?;
            fs::remove_file(path)
        }
        Some(_) => Err(std::io::Error::other(
            "replacement candidate identity is not recognized",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn cleanup_replacement_candidates<F>(
    temporary: &Path,
    backup: &Path,
    recovery: &Path,
    previous: Option<&[u8]>,
    intended: &[u8],
    journal: &[u8],
    parent: &Path,
    sync: &mut F,
) -> std::io::Result<()>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    remove_known_candidate(temporary, Some(intended))?;
    remove_known_candidate(backup, previous)?;
    remove_known_candidate(recovery, Some(journal))?;
    sync(parent)
}

#[allow(clippy::too_many_arguments)]
fn reconcile_replace_candidates<F, G>(
    destination: &Path,
    temporary: &Path,
    backup: &Path,
    recovery: &Path,
    previous: Option<&[u8]>,
    intended: &[u8],
    journal: &[u8],
    guard: &mut G,
    sync: &mut F,
) -> PersistenceOutcome
where
    F: FnMut(&Path) -> std::io::Result<()>,
    G: FnMut() -> std::io::Result<()>,
{
    let Some(parent) = destination.parent() else {
        return PersistenceOutcome::OutcomeUnknown;
    };
    if guard().is_err() {
        return PersistenceOutcome::NamespaceOutcomeUnknown;
    }
    let observed = match read_catalog_candidate_bytes(destination) {
        Ok(bytes) => bytes,
        Err(_) => return PersistenceOutcome::OutcomeUnknown,
    };
    let replacement = match read_catalog_candidate_bytes(temporary) {
        Ok(bytes) => bytes,
        Err(_) => return PersistenceOutcome::OutcomeUnknown,
    };
    let old_backup = match read_catalog_candidate_bytes(backup) {
        Ok(bytes) => bytes,
        Err(_) => return PersistenceOutcome::OutcomeUnknown,
    };
    let marker = match read_catalog_candidate_bytes(recovery) {
        Ok(bytes) => bytes,
        Err(_) => return PersistenceOutcome::OutcomeUnknown,
    };
    if marker.as_deref() != Some(journal)
        || replacement
            .as_deref()
            .is_some_and(|candidate| candidate != intended)
        || old_backup
            .as_deref()
            .is_some_and(|candidate| previous != Some(candidate))
    {
        return PersistenceOutcome::OutcomeUnknown;
    }

    if observed.as_deref() == Some(intended) {
        if sync(parent).is_err()
            || guard().is_err()
            || cleanup_replacement_candidates(
                temporary, backup, recovery, previous, intended, journal, parent, sync,
            )
            .is_err()
        {
            return PersistenceOutcome::OutcomeUnknown;
        }
        return if guard().is_ok() {
            PersistenceOutcome::Committed
        } else {
            PersistenceOutcome::NamespaceOutcomeUnknown
        };
    }

    if observed.is_none() {
        if replacement.as_deref() == Some(intended) {
            if move_known_candidate_to_missing(temporary, destination, intended).is_err()
                || sync(parent).is_err()
                || read_catalog_candidate_bytes(destination)
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(intended)
                || guard().is_err()
                || cleanup_replacement_candidates(
                    temporary, backup, recovery, previous, intended, journal, parent, sync,
                )
                .is_err()
            {
                return PersistenceOutcome::OutcomeUnknown;
            }
            return PersistenceOutcome::Committed;
        }
        if let Some(previous) = previous {
            if old_backup.as_deref() == Some(previous) {
                if move_known_candidate_to_missing(backup, destination, previous).is_err()
                    || sync(parent).is_err()
                    || read_catalog_candidate_bytes(destination)
                        .ok()
                        .flatten()
                        .as_deref()
                        != Some(previous)
                    || guard().is_err()
                    || cleanup_replacement_candidates(
                        temporary,
                        backup,
                        recovery,
                        Some(previous),
                        intended,
                        journal,
                        parent,
                        sync,
                    )
                    .is_err()
                {
                    return PersistenceOutcome::OutcomeUnknown;
                }
                return PersistenceOutcome::NotCommitted;
            }
        }
        return PersistenceOutcome::OutcomeUnknown;
    }

    if previous.is_some() && observed.as_deref() == previous {
        if guard().is_err()
            || cleanup_replacement_candidates(
                temporary, backup, recovery, previous, intended, journal, parent, sync,
            )
            .is_err()
        {
            PersistenceOutcome::OutcomeUnknown
        } else {
            PersistenceOutcome::NotCommitted
        }
    } else {
        PersistenceOutcome::OutcomeUnknown
    }
}

fn move_known_candidate_to_missing(
    source: &Path,
    destination: &Path,
    expected: &[u8],
) -> std::io::Result<()> {
    if read_catalog_candidate_bytes(source)?.as_deref() != Some(expected) {
        return Err(std::io::Error::other(
            "replacement move source identity changed",
        ));
    }
    if candidate_exists(destination)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "replacement destination unexpectedly exists",
        ));
    }
    move_catalog_candidate(source, destination)
}

fn reconcile_persistence_with_sync<F>(
    destination: &Path,
    previous: Option<&[u8]>,
    intended: &[u8],
    outcome: PersistenceOutcome,
    sync: F,
) -> ReconciledPersistence
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    match outcome {
        PersistenceOutcome::Committed => ReconciledPersistence::Committed,
        PersistenceOutcome::NotCommitted => ReconciledPersistence::NotCommitted,
        PersistenceOutcome::NamespaceNotCommitted => ReconciledPersistence::NotCommitted,
        PersistenceOutcome::NamespaceOutcomeUnknown => ReconciledPersistence::OutcomeUnknown,
        PersistenceOutcome::OutcomeUnknown => {
            let observed = match read_catalog_bytes(destination) {
                Ok(observed) => observed,
                Err(_) => return ReconciledPersistence::OutcomeUnknown,
            };
            if observed.as_deref() == Some(intended) {
                let Some(parent) = destination.parent() else {
                    return ReconciledPersistence::OutcomeUnknown;
                };
                return if sync(parent).is_ok() {
                    ReconciledPersistence::Committed
                } else {
                    ReconciledPersistence::OutcomeUnknown
                };
            }
            if observed.as_deref() == previous {
                ReconciledPersistence::NotCommitted
            } else {
                ReconciledPersistence::OutcomeUnknown
            }
        }
    }
}

fn finalize_persistence(
    outcome: PersistenceOutcome,
    reconciled: ReconciledPersistence,
    guards_valid: bool,
) -> Result<(), CatalogError> {
    if outcome == PersistenceOutcome::NamespaceNotCommitted {
        return Err(CatalogError::recovery_required());
    }
    let replace_was_attempted = matches!(
        outcome,
        PersistenceOutcome::Committed
            | PersistenceOutcome::OutcomeUnknown
            | PersistenceOutcome::NamespaceOutcomeUnknown
    );
    if replace_was_attempted && !guards_valid {
        return Err(CatalogError::persistence_outcome_unknown());
    }
    match reconciled {
        ReconciledPersistence::Committed => Ok(()),
        ReconciledPersistence::NotCommitted => Err(CatalogError::write_failed()),
        ReconciledPersistence::OutcomeUnknown => Err(CatalogError::persistence_outcome_unknown()),
    }
}

fn catalog_temporary_path(destination: &Path) -> std::io::Result<PathBuf> {
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog has no parent directory",
        )
    })?;
    let file_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "catalog has no file name")
    })?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    Ok(parent.join(temporary_name))
}

fn catalog_recovery_path(destination: &Path) -> std::io::Result<PathBuf> {
    catalog_fixed_sidecar_path(destination, ".replace-pending")
}

fn catalog_backup_path(destination: &Path) -> std::io::Result<PathBuf> {
    catalog_fixed_sidecar_path(destination, ".replace-backup")
}

fn catalog_fixed_sidecar_path(destination: &Path, suffix: &str) -> std::io::Result<PathBuf> {
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog has no parent directory",
        )
    })?;
    let file_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "catalog has no file name")
    })?;
    let mut sidecar = OsString::from(".");
    sidecar.push(file_name);
    sidecar.push(suffix);
    Ok(parent.join(sidecar))
}

fn catalog_lock_path(destination: &Path) -> std::io::Result<PathBuf> {
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "catalog has no parent directory",
        )
    })?;
    let file_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "catalog has no file name")
    })?;
    let mut lock_name = OsString::from(".");
    lock_name.push(file_name);
    lock_name.push(".lock");
    Ok(parent.join(lock_name))
}

#[cfg(windows)]
fn replace_catalog_file(source: &Path, destination: &Path, backup: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let destination_exists = destination.exists();
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let backup: Vec<u16> = backup.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        if destination_exists {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                backup.as_ptr(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_catalog_file(source: &Path, destination: &Path, _backup: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn move_catalog_candidate(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_catalog_candidate(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
struct CatalogFileLock {
    file: File,
}

#[cfg(windows)]
impl CatalogFileLock {
    fn open(destination: &Path, create: bool) -> std::io::Result<File> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(create)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(catalog_lock_path(destination)?)?;
        if windows_attributes_are_reparse(file.metadata()?.file_attributes()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock is a reparse point",
            ));
        }
        Ok(file)
    }

    fn provision(destination: &Path) -> std::io::Result<()> {
        drop(Self::open(destination, true)?);
        Ok(())
    }

    fn acquire(destination: &Path) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::LockFile;

        let file = Self::open(destination, false)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let locked = unsafe { LockFile(file.as_raw_handle() as _, 0, 0, 1, 0) };
            if locked != 0 {
                return Ok(Self { file });
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(33) || std::time::Instant::now() >= deadline {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::windows::fs::MetadataExt;

        if windows_attributes_are_reparse(self.file.metadata()?.file_attributes()) {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock is a reparse point",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for CatalogFileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFile;

        unsafe {
            UnlockFile(self.file.as_raw_handle() as _, 0, 0, 1, 0);
        }
    }
}

#[cfg(all(
    unix,
    any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    )
))]
struct CatalogFileLock {
    path: PathBuf,
    file: File,
    device: u64,
    inode: u64,
}

#[cfg(all(
    unix,
    any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    )
))]
impl CatalogFileLock {
    fn open(destination: &Path, create: bool) -> std::io::Result<(PathBuf, File, u64, u64)> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        #[cfg(any(target_os = "android", target_os = "linux"))]
        const O_NOFOLLOW: std::ffi::c_int = 0x0002_0000;
        #[cfg(any(target_os = "ios", target_os = "macos"))]
        const O_NOFOLLOW: std::ffi::c_int = 0x0000_0100;

        let path = catalog_lock_path(destination)?;
        let before = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1
                {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "catalog lock is not a direct single-link file",
                    ));
                }
                Some((metadata.dev(), metadata.ino()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(create)
            .custom_flags(O_NOFOLLOW);
        let file = options.open(&path)?;
        let opened = file.metadata()?;
        if !opened.is_file()
            || opened.nlink() != 1
            || before.is_some_and(|identity| identity != (opened.dev(), opened.ino()))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock identity changed while opening",
            ));
        }
        let opened_path = fs::symlink_metadata(&path)?;
        if opened_path.file_type().is_symlink()
            || !opened_path.is_file()
            || opened_path.nlink() != 1
            || opened_path.dev() != opened.dev()
            || opened_path.ino() != opened.ino()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock namespace changed while opening",
            ));
        }
        Ok((path, file, opened.dev(), opened.ino()))
    }

    fn provision(destination: &Path) -> std::io::Result<()> {
        drop(Self::open(destination, true)?);
        Ok(())
    }

    fn acquire(destination: &Path) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;

        unsafe extern "C" {
            fn flock(
                file_descriptor: std::ffi::c_int,
                operation: std::ffi::c_int,
            ) -> std::ffi::c_int;
        }
        const LOCK_EXCLUSIVE: std::ffi::c_int = 2;

        let (path, file, device, inode) = Self::open(destination, false)?;
        if unsafe { flock(file.as_raw_fd(), LOCK_EXCLUSIVE) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let locked_path = fs::symlink_metadata(&path)?;
        if locked_path.file_type().is_symlink()
            || !locked_path.is_file()
            || locked_path.nlink() != 1
            || locked_path.dev() != device
            || locked_path.ino() != inode
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock namespace changed while locking",
            ));
        }
        Ok(Self {
            path,
            device,
            inode,
            file,
        })
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;

        let path = fs::symlink_metadata(&self.path)?;
        let file = self.file.metadata()?;
        if path.file_type().is_symlink()
            || !path.is_file()
            || path.nlink() != 1
            || path.dev() != self.device
            || path.ino() != self.inode
            || file.dev() != self.device
            || file.ino() != self.inode
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog lock namespace changed while held",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(all(
    unix,
    any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    )
))]
impl Drop for CatalogFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        unsafe extern "C" {
            fn flock(
                file_descriptor: std::ffi::c_int,
                operation: std::ffi::c_int,
            ) -> std::ffi::c_int;
        }
        const LOCK_UNLOCK: std::ffi::c_int = 8;
        unsafe {
            flock(self.file.as_raw_fd(), LOCK_UNLOCK);
        }
    }
}

#[cfg(not(any(
    windows,
    all(
        unix,
        any(
            target_os = "android",
            target_os = "ios",
            target_os = "linux",
            target_os = "macos"
        )
    )
)))]
struct CatalogFileLock;

#[cfg(not(any(
    windows,
    all(
        unix,
        any(
            target_os = "android",
            target_os = "ios",
            target_os = "linux",
            target_os = "macos"
        )
    )
)))]
impl CatalogFileLock {
    fn provision(_destination: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "cross-process catalog locking is unavailable",
        ))
    }

    fn acquire(_destination: &Path) -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "cross-process catalog locking is unavailable",
        ))
    }

    fn revalidate(&self) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "cross-process catalog locking is unavailable",
        ))
    }
}

#[cfg(windows)]
struct FolderRootGuard {
    path: PathBuf,
    file: File,
}

#[cfg(windows)]
struct FolderRootGuards {
    guards: Vec<FolderRootGuard>,
}

#[cfg(windows)]
impl FolderRootGuards {
    fn acquire(state: &ProjectChatState) -> std::io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        let mut guards = Vec::new();
        for project in &state.projects {
            if project.kind != ProjectKind::Folder {
                continue;
            }
            let path = PathBuf::from(project.root.path.as_deref().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "folder root has no path")
            })?);
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            let metadata = file.metadata()?;
            if !metadata.is_dir()
                || windows_attributes_are_reparse(metadata.file_attributes())
                || Path::new(
                    &canonical_folder(path.to_str().ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "folder root is not Unicode",
                        )
                    })?)
                    .map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "folder root is invalid",
                        )
                    })?,
                ) != path
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root identity changed",
                ));
            }
            guards.push(FolderRootGuard { path, file });
        }
        Ok(Self { guards })
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::windows::fs::MetadataExt;

        for guard in &self.guards {
            let metadata = guard.file.metadata()?;
            let canonical = canonical_folder(guard.path.to_str().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root is not Unicode",
                )
            })?)
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "folder root is invalid")
            })?;
            if !metadata.is_dir()
                || windows_attributes_are_reparse(metadata.file_attributes())
                || Path::new(&canonical) != guard.path
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root identity changed",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
struct FolderRootGuard {
    path: PathBuf,
    file: File,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
struct FolderRootGuards {
    guards: Vec<FolderRootGuard>,
}

#[cfg(unix)]
impl FolderRootGuards {
    fn acquire(state: &ProjectChatState) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let mut guards = Vec::new();
        for project in &state.projects {
            if project.kind != ProjectKind::Folder {
                continue;
            }
            let path = PathBuf::from(project.root.path.as_deref().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "folder root has no path")
            })?);
            let before = fs::symlink_metadata(&path)?;
            if before.file_type().is_symlink() || !before.is_dir() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root is not a direct directory",
                ));
            }
            let file = File::open(&path)?;
            let metadata = file.metadata()?;
            let canonical = canonical_folder(path.to_str().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root is not Unicode",
                )
            })?)
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "folder root is invalid")
            })?;
            if !metadata.is_dir()
                || before.dev() != metadata.dev()
                || before.ino() != metadata.ino()
                || Path::new(&canonical) != path
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root identity changed",
                ));
            }
            guards.push(FolderRootGuard {
                path,
                device: metadata.dev(),
                inode: metadata.ino(),
                file,
            });
        }
        Ok(Self { guards })
    }

    fn revalidate(&self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;

        for guard in &self.guards {
            let path_metadata = fs::symlink_metadata(&guard.path)?;
            let file_metadata = guard.file.metadata()?;
            let canonical = canonical_folder(guard.path.to_str().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root is not Unicode",
                )
            })?)
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "folder root is invalid")
            })?;
            if path_metadata.file_type().is_symlink()
                || !path_metadata.is_dir()
                || path_metadata.dev() != guard.device
                || path_metadata.ino() != guard.inode
                || file_metadata.dev() != guard.device
                || file_metadata.ino() != guard.inode
                || Path::new(&canonical) != guard.path
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "folder root identity changed",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(not(any(windows, unix)))]
struct FolderRootGuards;

#[cfg(not(any(windows, unix)))]
impl FolderRootGuards {
    fn acquire(state: &ProjectChatState) -> std::io::Result<Self> {
        if state
            .projects
            .iter()
            .any(|project| project.kind == ProjectKind::Folder)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "folder root identity guards are unavailable",
            ));
        }
        Ok(Self)
    }

    fn revalidate(&self) -> std::io::Result<()> {
        Ok(())
    }
}

fn apply_command(
    state: &mut ProjectChatState,
    command: ProjectChatCommand,
) -> Result<bool, CatalogError> {
    match command {
        ProjectChatCommand::ProjectCreate(command) => {
            if !valid_id(&command.project_id)
                || !valid_label(&command.name)
                || state
                    .projects
                    .iter()
                    .any(|project| project.id == command.project_id)
            {
                return Err(CatalogError::invalid_command());
            }
            let canonical = canonical_folder(&command.folder_path)
                .map_err(|_| CatalogError::invalid_command())?;
            let project_id = command.project_id;
            state.selected_project_id.clone_from(&project_id);
            state.projects.push(Project {
                id: project_id,
                kind: ProjectKind::Folder,
                name: command.name,
                root: ProjectRoot {
                    kind: ProjectRootKind::Folder,
                    path: Some(canonical),
                },
                pinned: false,
                archived: false,
                selected_chat_id: None,
                chats: Vec::new(),
            });
            Ok(true)
        }
        ProjectChatCommand::ProjectRename(command) => {
            if !valid_label(&command.name) {
                return Err(CatalogError::invalid_command());
            }
            let project = state
                .projects
                .iter_mut()
                .find(|project| project.id == command.project_id)
                .ok_or_else(CatalogError::invalid_command)?;
            if project.kind == ProjectKind::Personal {
                return Err(CatalogError::invalid_command());
            }
            if project.name == command.name {
                return Ok(false);
            }
            project.name = command.name;
            Ok(true)
        }
        ProjectChatCommand::ProjectArchive(command) => {
            let project = state
                .projects
                .iter_mut()
                .find(|project| project.id == command.project_id)
                .ok_or_else(CatalogError::invalid_command)?;
            if project.kind == ProjectKind::Personal {
                return Err(CatalogError::invalid_command());
            }
            if project.archived {
                return Ok(false);
            }
            project.archived = true;
            if state.selected_project_id == project.id {
                state.selected_project_id = PERSONAL_PROJECT_ID.to_owned();
            }
            Ok(true)
        }
        ProjectChatCommand::ProjectRestore(command) => {
            let project = state
                .projects
                .iter_mut()
                .find(|project| project.id == command.project_id)
                .ok_or_else(CatalogError::invalid_command)?;
            if project.kind == ProjectKind::Personal || !project.archived {
                return Ok(false);
            }
            project.archived = false;
            Ok(true)
        }
        ProjectChatCommand::SetProjectPinned(command) => {
            let project = state
                .projects
                .iter_mut()
                .find(|project| project.id == command.project_id)
                .ok_or_else(CatalogError::invalid_command)?;
            if project.pinned == command.pinned {
                return Ok(false);
            }
            project.pinned = command.pinned;
            Ok(true)
        }
        ProjectChatCommand::ChatCreate(command) => {
            if !valid_id(&command.chat_id)
                || !valid_label(&command.title)
                || state
                    .projects
                    .iter()
                    .flat_map(|project| &project.chats)
                    .any(|chat| chat.id == command.chat_id)
            {
                return Err(CatalogError::invalid_command());
            }
            let project = state
                .projects
                .iter_mut()
                .find(|project| project.id == command.project_id)
                .filter(|project| !project.archived)
                .ok_or_else(CatalogError::invalid_command)?;
            let chat_id = command.chat_id;
            project.selected_chat_id.clone_from(&Some(chat_id.clone()));
            project.chats.push(ProjectChat {
                id: chat_id,
                project_id: project.id.clone(),
                title: command.title,
                pinned: false,
                archived: false,
                binding: None,
            });
            state.selected_project_id.clone_from(&project.id);
            Ok(true)
        }
        ProjectChatCommand::BindPrimeSession(command) => {
            validate_binding(&command.binding).map_err(|_| CatalogError::invalid_command())?;
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let chat = &mut state.projects[project_index].chats[chat_index];
            match &chat.binding {
                Some(binding) if binding == &command.binding => Ok(false),
                Some(_) => Err(CatalogError::invalid_command()),
                None => {
                    chat.binding = Some(command.binding);
                    Ok(true)
                }
            }
        }
        ProjectChatCommand::ChatRename(command) => {
            if !valid_label(&command.title) {
                return Err(CatalogError::invalid_command());
            }
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let chat = &mut state.projects[project_index].chats[chat_index];
            if chat.title == command.title {
                return Ok(false);
            }
            chat.title = command.title;
            Ok(true)
        }
        ProjectChatCommand::ChatArchive(command) => {
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let project = &mut state.projects[project_index];
            if project.chats[chat_index].archived {
                return Ok(false);
            }
            if project.selected_chat_id.as_deref() == Some(command.chat_id.as_str()) {
                project.selected_chat_id = project
                    .chats
                    .iter()
                    .skip(chat_index + 1)
                    .find(|chat| !chat.archived)
                    .or_else(|| {
                        project.chats[..chat_index]
                            .iter()
                            .rev()
                            .find(|chat| !chat.archived)
                    })
                    .map(|chat| chat.id.clone());
            }
            project.chats[chat_index].archived = true;
            Ok(true)
        }
        ProjectChatCommand::ChatRestore(command) => {
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let project = &mut state.projects[project_index];
            if !project.chats[chat_index].archived {
                return Ok(false);
            }
            let has_active_remembered =
                project.selected_chat_id.as_deref().is_some_and(|selected| {
                    project
                        .chats
                        .iter()
                        .any(|chat| chat.id == selected && !chat.archived)
                });
            if !has_active_remembered {
                project.selected_chat_id = Some(command.chat_id);
            }
            project.chats[chat_index].archived = false;
            Ok(true)
        }
        ProjectChatCommand::SetChatPinned(command) => {
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let chat = &mut state.projects[project_index].chats[chat_index];
            if chat.pinned == command.pinned {
                return Ok(false);
            }
            chat.pinned = command.pinned;
            Ok(true)
        }
        ProjectChatCommand::DuplicateChat(command) => {
            if !valid_id(&command.new_chat_id)
                || !valid_label(&command.title)
                || state
                    .projects
                    .iter()
                    .flat_map(|project| &project.chats)
                    .any(|chat| chat.id == command.new_chat_id)
            {
                return Err(CatalogError::invalid_command());
            }
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            if state.projects[project_index].archived
                || state.projects[project_index].chats[chat_index].archived
            {
                return Err(CatalogError::invalid_command());
            }
            let project = &mut state.projects[project_index];
            project.selected_chat_id = Some(command.new_chat_id.clone());
            project.chats.push(ProjectChat {
                id: command.new_chat_id,
                project_id: project.id.clone(),
                title: command.title,
                pinned: false,
                archived: false,
                binding: None,
            });
            state.selected_project_id.clone_from(&project.id);
            Ok(true)
        }
        ProjectChatCommand::MoveChat(command) => {
            let (source_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let target_index = state
                .projects
                .iter()
                .position(|project| project.id == command.target_project_id)
                .filter(|index| !state.projects[*index].archived)
                .ok_or_else(CatalogError::invalid_command)?;
            if source_index == target_index {
                return Ok(false);
            }
            if state.projects[source_index].archived
                || state.projects[source_index].chats[chat_index].archived
            {
                return Err(CatalogError::invalid_command());
            }
            if state.projects[source_index].selected_chat_id.as_deref()
                == Some(command.chat_id.as_str())
            {
                state.projects[source_index].selected_chat_id = state.projects[source_index]
                    .chats
                    .iter()
                    .skip(chat_index + 1)
                    .find(|chat| !chat.archived)
                    .or_else(|| {
                        state.projects[source_index].chats[..chat_index]
                            .iter()
                            .rev()
                            .find(|chat| !chat.archived)
                    })
                    .map(|chat| chat.id.clone());
            }
            let mut moved = state.projects[source_index].chats.remove(chat_index);
            moved.project_id.clone_from(&command.target_project_id);
            state.projects[target_index].selected_chat_id = Some(moved.id.clone());
            state.projects[target_index].chats.push(moved);
            state.selected_project_id = command.target_project_id;
            Ok(true)
        }
        ProjectChatCommand::DeleteChat(command) => {
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let project = &mut state.projects[project_index];
            if project.selected_chat_id.as_deref() == Some(command.chat_id.as_str()) {
                project.selected_chat_id = project
                    .chats
                    .iter()
                    .skip(chat_index + 1)
                    .find(|chat| !chat.archived)
                    .or_else(|| {
                        project.chats[..chat_index]
                            .iter()
                            .rev()
                            .find(|chat| !chat.archived)
                    })
                    .map(|chat| chat.id.clone());
            }
            project.chats.remove(chat_index);
            Ok(true)
        }
        ProjectChatCommand::SelectProject(command) => {
            let project = state
                .projects
                .iter()
                .find(|project| project.id == command.project_id)
                .filter(|project| !project.archived)
                .ok_or_else(CatalogError::invalid_command)?;
            if state.selected_project_id == project.id {
                return Ok(false);
            }
            state.selected_project_id.clone_from(&project.id);
            Ok(true)
        }
        ProjectChatCommand::SelectChat(command) => {
            let (project_index, chat_index) =
                find_chat(state, &command.project_id, &command.chat_id)?;
            let project = &mut state.projects[project_index];
            if project.archived || project.chats[chat_index].archived {
                return Err(CatalogError::invalid_command());
            }
            if state.selected_project_id == project.id
                && project.selected_chat_id.as_deref() == Some(command.chat_id.as_str())
            {
                return Ok(false);
            }
            project.selected_chat_id = Some(command.chat_id);
            state.selected_project_id.clone_from(&project.id);
            Ok(true)
        }
    }
}

fn find_chat(
    state: &ProjectChatState,
    project_id: &str,
    chat_id: &str,
) -> Result<(usize, usize), CatalogError> {
    let project_index = state
        .projects
        .iter()
        .position(|project| project.id == project_id)
        .ok_or_else(CatalogError::invalid_command)?;
    let chat_index = state.projects[project_index]
        .chats
        .iter()
        .position(|chat| chat.id == chat_id)
        .ok_or_else(CatalogError::invalid_command)?;
    Ok((project_index, chat_index))
}

fn validate_state(state: &ProjectChatState) -> Result<(), ()> {
    if state.schema_version != SCHEMA_VERSION || !valid_id(&state.selected_project_id) {
        return Err(());
    }
    let mut project_ids = HashSet::new();
    let mut chat_ids = HashSet::new();
    let mut personal_count = 0;
    for project in &state.projects {
        if !valid_id(&project.id)
            || !valid_label(&project.name)
            || !project_ids.insert(project.id.as_str())
        {
            return Err(());
        }
        match project.kind {
            ProjectKind::Personal => {
                if project.id != PERSONAL_PROJECT_ID
                    || project.name != "Personal"
                    || project.archived
                    || project.root.kind != ProjectRootKind::StudioManagedEmpty
                    || project.root.path.is_some()
                {
                    return Err(());
                }
                personal_count += 1;
            }
            ProjectKind::Folder => {
                if project.id == PERSONAL_PROJECT_ID || project.root.kind != ProjectRootKind::Folder
                {
                    return Err(());
                }
                let path = project.root.path.as_deref().ok_or(())?;
                let canonical = canonical_folder(path).map_err(|_| ())?;
                if Path::new(path) != Path::new(&canonical) {
                    return Err(());
                }
            }
        }
        for chat in &project.chats {
            if !valid_id(&chat.id)
                || chat.project_id != project.id
                || !valid_label(&chat.title)
                || !chat_ids.insert(chat.id.as_str())
            {
                return Err(());
            }
            if let Some(binding) = &chat.binding {
                validate_binding(binding)?;
            }
        }
        if let Some(selected_chat_id) = &project.selected_chat_id {
            if !valid_id(selected_chat_id)
                || !project
                    .chats
                    .iter()
                    .any(|chat| chat.id == *selected_chat_id && !chat.archived)
            {
                return Err(());
            }
        }
    }
    if personal_count != 1
        || !state
            .projects
            .iter()
            .any(|project| project.id == state.selected_project_id && !project.archived)
    {
        return Err(());
    }
    Ok(())
}

fn validate_binding(binding: &PrimeChatBinding) -> Result<(), ()> {
    if binding.kind != PrimeChatBindingKind::PrimeSession
        || binding
            .account_id
            .as_deref()
            .is_some_and(|value| !valid_id(value))
        || !valid_id(&binding.session_id)
        || !valid_session_file_metadata(&binding.session_file)
        || binding
            .agent_id
            .as_deref()
            .is_some_and(|value| !valid_id(value))
    {
        return Err(());
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes.first() != Some(&b' ')
        && bytes.last() != Some(&b' ')
        && bytes.iter().all(|byte| (0x20..=0x7e).contains(byte))
}

fn valid_label(value: &str) -> bool {
    value.trim() == value
        && (1..=200).contains(&value.chars().count())
        && !value.chars().any(forbidden_label_character)
}

fn forbidden_label_character(character: char) -> bool {
    character.is_control()
        || matches!(character, '\u{2028}' | '\u{2029}')
        || matches!(
            character as u32,
            0x00ad
                | 0x061c
                | 0x06dd
                | 0x070f
                | 0x08e2
                | 0x180e
                | 0xfeff
                | 0x110bd
                | 0x110cd
                | 0xe0001
                | 0x0600..=0x0605
                | 0x0890..=0x0891
                | 0x200b..=0x200f
                | 0x202a..=0x202e
                | 0x2060..=0x2064
                | 0x2066..=0x206f
                | 0xfff9..=0xfffb
                | 0x13430..=0x1343f
                | 0x1bca0..=0x1bca3
                | 0x1d173..=0x1d17a
                | 0xe0020..=0xe007f
        )
}

fn valid_nonempty_path_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0')
}

fn valid_session_file_metadata(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=255).contains(&bytes.len())
        && value != "."
        && value != ".."
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-'))
}

fn canonical_folder(value: &str) -> Result<String, ()> {
    if !valid_nonempty_path_text(value) {
        return Err(());
    }
    let canonical = fs::canonicalize(value).map_err(|_| ())?;
    if !canonical.is_absolute() || !canonical.is_dir() {
        return Err(());
    }
    canonical.into_os_string().into_string().map_err(|_| ())
}

fn validate_value_bounds(value: &Value) -> Result<(), ()> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize, work: &mut usize) -> Result<(), ()> {
        if depth > MAX_SNAPSHOT_DEPTH {
            return Err(());
        }
        match value {
            Value::Array(values) => {
                *nodes = nodes.checked_add(1).ok_or(())?;
                *work = work
                    .checked_add(values.len().checked_add(1).ok_or(())?)
                    .ok_or(())?;
                if *nodes > MAX_CONTAINER_NODES || *work > MAX_OWN_KEY_WORK {
                    return Err(());
                }
                for value in values {
                    visit(value, depth + 1, nodes, work)?;
                }
            }
            Value::Object(values) => {
                *nodes = nodes.checked_add(1).ok_or(())?;
                *work = work.checked_add(values.len()).ok_or(())?;
                if *nodes > MAX_CONTAINER_NODES || *work > MAX_OWN_KEY_WORK {
                    return Err(());
                }
                for value in values.values() {
                    visit(value, depth + 1, nodes, work)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    visit(value, 0, &mut 0, &mut 0)
}

fn validate_catalog_value_bounds(value: &Value) -> Result<(), ()> {
    let state = value
        .as_object()
        .and_then(|object| object.get("state"))
        .ok_or(())?;
    validate_value_bounds(state)
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn post_replace_sync_error_reconciles_from_observed_bytes() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-outcome-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create persistence test directory");
        let path = root.join("projects-v2.json");
        let old = b"old bytes";
        let intended = b"new bytes";
        fs::write(&path, old).expect("write old destination");

        let syncs = std::cell::Cell::new(0_u8);
        let outcome = persist_catalog_with_sync(&path, intended, |_| {
            let current = syncs.get();
            syncs.set(current + 1);
            if current == 1 {
                Err(std::io::Error::other("forced post-replace sync failure"))
            } else {
                Ok(())
            }
        });
        assert_eq!(outcome, PersistenceOutcome::Committed);
        assert_eq!(fs::read(&path).expect("read replaced bytes"), intended);
        assert_eq!(
            reconcile_persistence_with_sync(&path, Some(old), intended, outcome, |_| Ok(()),),
            ReconciledPersistence::Committed
        );

        fs::remove_dir_all(root).expect("remove persistence test directory");
    }

    #[test]
    fn namespace_loss_after_replace_never_reconciles_as_a_successful_commit() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-namespace-outcome-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create namespace outcome test directory");
        let path = root.join(CATALOG_FILE_NAME);
        let old = b"old bytes";
        let intended = b"new bytes";
        fs::write(&path, old).expect("write old namespace outcome destination");
        let validations = std::cell::Cell::new(0_u8);

        let outcome = persist_catalog_with_sync_and_guard(
            &path,
            Some(old),
            intended,
            || {
                let validation = validations.get();
                validations.set(validation + 1);
                if validation == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::other("forced namespace loss"))
                }
            },
            |_| Ok(()),
        );
        assert_eq!(outcome, PersistenceOutcome::NamespaceOutcomeUnknown);
        assert_eq!(fs::read(&path).expect("read replaced bytes"), intended);
        assert_eq!(
            reconcile_persistence_with_sync(&path, Some(old), intended, outcome, |_| Ok(())),
            ReconciledPersistence::OutcomeUnknown
        );

        fs::remove_dir_all(root).expect("remove namespace outcome test directory");
    }

    #[test]
    fn an_unknown_replace_cannot_be_finalized_from_an_untrusted_namespace_observation() {
        assert_eq!(
            finalize_persistence(
                PersistenceOutcome::OutcomeUnknown,
                ReconciledPersistence::NotCommitted,
                false,
            )
            .expect_err("namespace loss keeps replace outcome unknown")
            .code(),
            "persistenceOutcomeUnknown"
        );
        assert_eq!(
            finalize_persistence(
                PersistenceOutcome::NotCommitted,
                ReconciledPersistence::NotCommitted,
                true,
            )
            .expect_err("known pre-replace failure is a write failure")
            .code(),
            "writeFailed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_error_1176_reconciles_old_destination_before_candidate_cleanup() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-replace-1176-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create 1176 test directory");
        let destination = root.join(CATALOG_FILE_NAME);
        let old = b"old bytes";
        let intended = b"new bytes";
        fs::write(&destination, old).expect("write 1176 old destination");

        let resolved = persist_catalog_transaction_with(
            &destination,
            Some(old),
            intended,
            || Ok(()),
            |_| Ok(()),
            |temporary, destination, backup| {
                assert_eq!(fs::read(temporary).expect("read 1176 temp"), intended);
                assert_eq!(fs::read(destination).expect("read 1176 destination"), old);
                assert!(!backup.exists());
                Err(std::io::Error::from_raw_os_error(1176))
            },
        );

        assert_eq!(resolved, PersistenceOutcome::NotCommitted);
        assert_eq!(
            fs::read(&destination).expect("read retained old bytes"),
            old
        );
        assert!(!catalog_recovery_path(&destination).unwrap().exists());
        assert!(!catalog_backup_path(&destination).unwrap().exists());
        fs::remove_dir_all(root).expect("remove 1176 test directory");
    }

    #[cfg(windows)]
    #[test]
    fn windows_error_1177_recovers_from_temp_and_known_old_backup_without_last_copy_loss() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-replace-1177-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create 1177 test directory");
        let destination = root.join(CATALOG_FILE_NAME);
        let old = b"old bytes";
        let intended = b"new bytes";
        fs::write(&destination, old).expect("write 1177 old destination");

        let resolved = persist_catalog_transaction_with(
            &destination,
            Some(old),
            intended,
            || Ok(()),
            |_| Ok(()),
            |temporary, destination, backup| {
                fs::rename(destination, backup).expect("simulate old file moved to backup");
                assert_eq!(fs::read(temporary).expect("read 1177 temp"), intended);
                assert_eq!(fs::read(backup).expect("read 1177 old backup"), old);
                Err(std::io::Error::from_raw_os_error(1177))
            },
        );

        assert_eq!(resolved, PersistenceOutcome::Committed);
        assert_eq!(
            fs::read(&destination).expect("read recovered intended destination"),
            intended
        );
        assert!(!catalog_recovery_path(&destination).unwrap().exists());
        assert!(!catalog_backup_path(&destination).unwrap().exists());
        fs::remove_dir_all(root).expect("remove 1177 test directory");
    }

    #[test]
    fn pending_replace_evidence_prevents_a_missing_catalog_from_loading_as_fresh() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-pending-replace-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create pending replace test directory");
        let destination = root.join(CATALOG_FILE_NAME);
        let recovery = catalog_recovery_path(&destination).expect("recovery marker path");
        fs::write(&recovery, b"pending replacement").expect("write recovery marker");

        let error = ProjectCatalog::new(destination)
            .load()
            .expect_err("missing destination with replace evidence requires recovery");
        assert_eq!(error.code(), "recoveryRequired");

        fs::remove_file(recovery).expect("remove recovery marker");
        fs::remove_dir_all(root).expect("remove pending replace test directory");
    }

    #[test]
    fn state_depth_and_own_key_work_caps_are_inclusive() {
        let mut at_depth_cap = Value::Null;
        for _ in 0..MAX_SNAPSHOT_DEPTH {
            at_depth_cap = Value::Array(vec![at_depth_cap]);
        }
        assert_eq!(validate_value_bounds(&at_depth_cap), Ok(()));
        let over_depth_cap = Value::Array(vec![at_depth_cap]);
        assert_eq!(validate_value_bounds(&over_depth_cap), Err(()));

        let at_work_cap = Value::Array(vec![Value::Null; MAX_OWN_KEY_WORK - 1]);
        assert_eq!(validate_value_bounds(&at_work_cap), Ok(()));
        let over_work_cap = Value::Array(vec![Value::Null; MAX_OWN_KEY_WORK]);
        assert_eq!(validate_value_bounds(&over_work_cap), Err(()));
    }

    #[test]
    fn load_waits_for_the_catalog_process_lock_before_reading() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-load-lock-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create load lock test directory");
        let path = root.join("projects-v2.json");
        let catalog = ProjectCatalog::new(path.clone());
        let held_lock = CatalogFileLock::acquire(&path).expect("hold catalog process lock");
        let (sender, receiver) = std::sync::mpsc::channel();

        let worker = std::thread::spawn(move || {
            sender.send(catalog.load()).expect("send load result");
        });

        assert!(
            receiver
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "load must not read while another process owns the catalog transaction lock"
        );
        drop(held_lock);
        assert_eq!(
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("load completes after lock release")
                .expect("load succeeds after lock release"),
            initial_snapshot()
        );
        worker.join().expect("join load worker");
        fs::remove_dir_all(root).expect("remove load lock test directory");
    }

    #[test]
    fn offline_load_only_opens_the_lock_provisioned_during_service_startup() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-offline-load-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create offline load test directory");
        let path = root.join("projects-v2.json");
        let catalog = ProjectCatalog::new(path.clone());
        let lock = catalog_lock_path(&path).expect("catalog lock path");
        assert!(
            lock.is_file(),
            "service startup must provision its catalog lock before OfflineRead authority"
        );
        let before = fs::read_dir(&root)
            .expect("enumerate before offline load")
            .map(|entry| entry.expect("read entry before load").file_name())
            .collect::<Vec<_>>();

        assert_eq!(catalog.load().expect("offline load"), initial_snapshot());

        let after = fs::read_dir(&root)
            .expect("enumerate after offline load")
            .map(|entry| entry.expect("read entry after load").file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            after, before,
            "OfflineRead must not create filesystem state"
        );
        drop(catalog);
        fs::remove_dir_all(root).expect("remove offline load test directory");
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_oracle_rejects_the_attribute_independent_of_link_tag() {
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        assert!(windows_attributes_are_reparse(FILE_ATTRIBUTE_REPARSE_POINT));
        assert!(windows_attributes_are_reparse(
            FILE_ATTRIBUTE_REPARSE_POINT | 0x10
        ));
        assert!(!windows_attributes_are_reparse(0));
    }

    #[cfg(windows)]
    #[test]
    fn catalog_service_pins_its_root_namespace_until_shutdown() {
        let outer = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-root-pin-{}",
            uuid::Uuid::new_v4()
        ));
        let root = outer.join("owned");
        let moved = outer.join("moved");
        fs::create_dir_all(&root).expect("create pinned catalog root");

        let catalog = ProjectCatalog::new(root.join(CATALOG_FILE_NAME));
        assert!(
            fs::rename(&root, &moved).is_err(),
            "the service-owned root cannot be retargeted while the catalog is live"
        );
        drop(catalog);
        fs::rename(&root, &moved).expect("catalog shutdown releases the root namespace");
        fs::remove_dir_all(outer).expect("remove root pin test directory");
    }

    fn state_with_folder(path: &Path) -> ProjectChatState {
        let mut state = initial_snapshot().state;
        state.projects.push(Project {
            id: "p1".to_owned(),
            kind: ProjectKind::Folder,
            name: "Repo".to_owned(),
            root: ProjectRoot {
                kind: ProjectRootKind::Folder,
                path: Some(
                    fs::canonicalize(path)
                        .expect("canonical folder")
                        .into_os_string()
                        .into_string()
                        .expect("Unicode test path"),
                ),
            },
            pinned: false,
            archived: false,
            selected_chat_id: None,
            chats: Vec::new(),
        });
        state
    }

    #[cfg(windows)]
    #[test]
    fn folder_root_guard_pins_the_validated_windows_namespace_through_commit() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-folder-guard-{}",
            uuid::Uuid::new_v4()
        ));
        let folder = root.join("repo");
        fs::create_dir_all(&folder).expect("create guarded folder");
        let state = state_with_folder(&folder);

        let guards = FolderRootGuards::acquire(&state).expect("acquire folder root guards");
        assert!(
            fs::remove_dir(&folder).is_err(),
            "validated folder namespace cannot be replaced while commit is live"
        );
        guards.revalidate().expect("guard identity remains valid");
        drop(guards);
        fs::remove_dir(&folder).expect("guard release permits cleanup");
        fs::remove_dir(root).expect("remove guard test root");
    }

    #[cfg(unix)]
    #[test]
    fn folder_root_guard_detects_a_portable_namespace_substitution() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-folder-guard-{}",
            uuid::Uuid::new_v4()
        ));
        let folder = root.join("repo");
        let moved = root.join("moved");
        let outside = root.join("outside");
        fs::create_dir_all(&folder).expect("create guarded folder");
        fs::create_dir(&outside).expect("create outside folder");
        let state = state_with_folder(&folder);

        let guards = FolderRootGuards::acquire(&state).expect("acquire folder root guards");
        fs::rename(&folder, &moved).expect("move guarded namespace");
        std::os::unix::fs::symlink(&outside, &folder).expect("substitute folder symlink");
        assert!(guards.revalidate().is_err());

        fs::remove_file(folder).expect("remove substituted symlink");
        fs::remove_dir(moved).expect("remove moved folder");
        fs::remove_dir(outside).expect("remove outside folder");
        fs::remove_dir(root).expect("remove guard test root");
    }
}
