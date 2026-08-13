use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use unicode_general_category::{get_general_category, GeneralCategory};

use crate::project_catalog::ProjectCatalog;

const CHAT_DISPLAY_FILE_NAME: &str = "chat-display-v1.json";
const CHAT_DISPLAY_LOCK_NAME: &str = ".chat-display-v1.lock";
const MAX_RECORDS: usize = 4_096;
const MAX_CONTENT_BYTES: usize = 128 * 1024;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
pub const MAX_CHAT_DISPLAY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatDisplayErrorCode {
    InvalidInput,
    RecoveryRequired,
    RevisionConflict,
    UnknownChat,
    PersistenceOutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatDisplayError {
    code: ChatDisplayErrorCode,
}

impl ChatDisplayError {
    pub fn code(self) -> &'static str {
        match self.code {
            ChatDisplayErrorCode::InvalidInput => "invalidInput",
            ChatDisplayErrorCode::RecoveryRequired => "recoveryRequired",
            ChatDisplayErrorCode::RevisionConflict => "revisionConflict",
            ChatDisplayErrorCode::UnknownChat => "unknownChat",
            ChatDisplayErrorCode::PersistenceOutcomeUnknown => "persistenceOutcomeUnknown",
        }
    }

    fn invalid_input() -> Self {
        Self {
            code: ChatDisplayErrorCode::InvalidInput,
        }
    }
    fn recovery_required() -> Self {
        Self {
            code: ChatDisplayErrorCode::RecoveryRequired,
        }
    }
    fn revision_conflict() -> Self {
        Self {
            code: ChatDisplayErrorCode::RevisionConflict,
        }
    }
    fn unknown_chat() -> Self {
        Self {
            code: ChatDisplayErrorCode::UnknownChat,
        }
    }
    fn persistence_outcome_unknown() -> Self {
        Self {
            code: ChatDisplayErrorCode::PersistenceOutcomeUnknown,
        }
    }
}

impl fmt::Display for ChatDisplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ChatDisplayError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatDisplayRecord {
    pub chat_id: String,
    pub message_id: String,
    pub revision: u64,
    pub source_content: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatDisplaySnapshot {
    pub schema_version: u8,
    pub records: Vec<ChatDisplayRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatDisplayApplyRequest {
    pub chat_id: String,
    pub message_id: String,
    pub expected_revision: u64,
    pub source_content: String,
    pub content: String,
}

pub struct ChatDisplayAuthority {
    path: PathBuf,
    catalog: Arc<ProjectCatalog>,
    mutation: Mutex<()>,
    lock_provisioned: bool,
    namespace: Option<DisplayNamespace>,
}

impl ChatDisplayAuthority {
    pub fn new(path: PathBuf, catalog: Arc<ProjectCatalog>) -> Self {
        let namespace = DisplayNamespace::confine(&path).ok();
        let confined_path = namespace
            .as_ref()
            .map(DisplayNamespace::display_path)
            .unwrap_or(path);
        let lock_provisioned = namespace.as_ref().is_some_and(|namespace| {
            namespace.revalidate_display_leaf().is_ok()
                && DisplayFileLock::provision(&confined_path).is_ok()
                && namespace.revalidate_display_leaf().is_ok()
        });
        Self {
            path: confined_path,
            catalog,
            mutation: Mutex::new(()),
            lock_provisioned,
            namespace,
        }
    }

    pub fn load(&self) -> Result<ChatDisplaySnapshot, ChatDisplayError> {
        self.with_locked_snapshot(Ok)
    }

    pub fn apply(
        &self,
        expected_revision: u64,
        chat_id: &str,
        message_id: &str,
        source_content: &str,
        content: &str,
    ) -> Result<ChatDisplayRecord, ChatDisplayError> {
        if !(1..MAX_SAFE_REVISION).contains(&expected_revision)
            || !valid_id(chat_id)
            || !valid_id(message_id)
            || !valid_content(source_content)
            || !valid_content(content)
        {
            return Err(ChatDisplayError::invalid_input());
        }

        self.with_locked_snapshot(|mut snapshot| {
            let matches = self
                .catalog
                .load()
                .map_err(|_| ChatDisplayError::recovery_required())?
                .state
                .projects
                .into_iter()
                .flat_map(|project| project.chats)
                .filter(|chat| chat.id == chat_id)
                .count();
            if matches != 1 {
                return Err(ChatDisplayError::unknown_chat());
            }

            let index = snapshot
                .records
                .iter()
                .position(|record| record.chat_id == chat_id && record.message_id == message_id);
            let current_revision = index
                .map(|index| snapshot.records[index].revision)
                .unwrap_or(1);
            if current_revision != expected_revision {
                return Err(ChatDisplayError::revision_conflict());
            }
            if index.is_some_and(|index| snapshot.records[index].source_content != source_content) {
                return Err(ChatDisplayError::revision_conflict());
            }
            let source_content = index
                .map(|index| snapshot.records[index].source_content.clone())
                .unwrap_or_else(|| source_content.to_owned());
            let record = ChatDisplayRecord {
                chat_id: chat_id.to_owned(),
                message_id: message_id.to_owned(),
                revision: expected_revision + 1,
                source_content,
                content: content.to_owned(),
            };
            if let Some(index) = index {
                snapshot.records[index] = record.clone();
            } else {
                if snapshot.records.len() >= MAX_RECORDS {
                    return Err(ChatDisplayError::invalid_input());
                }
                snapshot.records.push(record.clone());
            }
            snapshot.records.sort_by(|left, right| {
                (&left.chat_id, &left.message_id).cmp(&(&right.chat_id, &right.message_id))
            });
            validate_snapshot(&snapshot)?;
            let bytes =
                serde_json::to_vec(&snapshot).map_err(|_| ChatDisplayError::invalid_input())?;
            if bytes.len() > MAX_CHAT_DISPLAY_BYTES {
                return Err(ChatDisplayError::invalid_input());
            }
            self.revalidate_namespace()
                .map_err(|_| ChatDisplayError::recovery_required())?;
            self.persist_bytes(&bytes)?;
            self.revalidate_namespace()
                .map_err(|_| ChatDisplayError::persistence_outcome_unknown())?;
            let committed = self
                .read_snapshot()
                .map_err(|_| ChatDisplayError::persistence_outcome_unknown())?;
            if committed != snapshot {
                return Err(ChatDisplayError::persistence_outcome_unknown());
            }
            Ok(record)
        })
    }

    fn with_locked_snapshot<T>(
        &self,
        operation: impl FnOnce(ChatDisplaySnapshot) -> Result<T, ChatDisplayError>,
    ) -> Result<T, ChatDisplayError> {
        if !self.lock_provisioned {
            return Err(ChatDisplayError::recovery_required());
        }
        self.revalidate_namespace()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        let _local = self
            .mutation
            .lock()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        let file_lock = DisplayFileLock::acquire(&self.path)
            .map_err(|_| ChatDisplayError::recovery_required())?;
        file_lock
            .revalidate()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        self.revalidate_namespace()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        let snapshot = self.read_snapshot()?;
        validate_catalog_records(&self.catalog, &snapshot)?;
        let result = operation(snapshot);
        file_lock
            .revalidate()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        self.revalidate_namespace()
            .map_err(|_| ChatDisplayError::recovery_required())?;
        result
    }

    fn revalidate_namespace(&self) -> std::io::Result<()> {
        self.namespace
            .as_ref()
            .filter(|_| self.lock_provisioned)
            .ok_or_else(|| std::io::Error::other("chat-display namespace unavailable"))?
            .revalidate_display_leaf()
    }

    fn read_snapshot(&self) -> Result<ChatDisplaySnapshot, ChatDisplayError> {
        #[cfg(unix)]
        {
            return read_snapshot_from_directory(
                self.namespace
                    .as_ref()
                    .ok_or_else(ChatDisplayError::recovery_required)?,
            );
        }
        #[cfg(not(unix))]
        {
            read_snapshot(&self.path)
        }
    }

    fn persist_bytes(&self, bytes: &[u8]) -> Result<(), ChatDisplayError> {
        #[cfg(unix)]
        {
            return persist_bytes_in_directory(
                self.namespace
                    .as_ref()
                    .ok_or_else(ChatDisplayError::recovery_required)?,
                bytes,
            )
            .map_err(|_| ChatDisplayError::persistence_outcome_unknown());
        }
        #[cfg(not(unix))]
        {
            classify_persistence_result(crate::accounts::atomic_replace(&self.path, bytes))
        }
    }
}

fn empty_snapshot() -> ChatDisplaySnapshot {
    ChatDisplaySnapshot {
        schema_version: 1,
        records: Vec::new(),
    }
}

fn read_snapshot(path: &Path) -> Result<ChatDisplaySnapshot, ChatDisplayError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty_snapshot()),
        Err(_) => return Err(ChatDisplayError::recovery_required()),
    };
    if !metadata.is_file()
        || is_reparse(&metadata)
        || metadata.len() > MAX_CHAT_DISPLAY_BYTES as u64
    {
        return Err(ChatDisplayError::recovery_required());
    }
    let bytes = crate::bounded_io::read_bounded(path, MAX_CHAT_DISPLAY_BYTES)
        .map_err(|_| ChatDisplayError::recovery_required())?
        .bytes;
    let snapshot: ChatDisplaySnapshot =
        serde_json::from_slice(&bytes).map_err(|_| ChatDisplayError::recovery_required())?;
    validate_snapshot(&snapshot).map_err(|_| ChatDisplayError::recovery_required())?;
    Ok(snapshot)
}

fn validate_catalog_records(
    catalog: &ProjectCatalog,
    snapshot: &ChatDisplaySnapshot,
) -> Result<(), ChatDisplayError> {
    let durable = catalog
        .load()
        .map_err(|_| ChatDisplayError::recovery_required())?;
    let chat_ids: HashSet<String> = durable
        .state
        .projects
        .into_iter()
        .flat_map(|project| project.chats.into_iter().map(|chat| chat.id))
        .collect();
    if snapshot
        .records
        .iter()
        .any(|record| !chat_ids.contains(&record.chat_id))
    {
        return Err(ChatDisplayError::recovery_required());
    }
    Ok(())
}

fn classify_persistence_result(result: std::io::Result<()>) -> Result<(), ChatDisplayError> {
    result.map_err(|_| ChatDisplayError::persistence_outcome_unknown())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && value.trim() == value
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn valid_content(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CONTENT_BYTES
        && value.chars().all(|character| {
            matches!(character, '\n' | '\r' | '\t')
                || !matches!(
                    get_general_category(character),
                    GeneralCategory::Control
                        | GeneralCategory::Format
                        | GeneralCategory::LineSeparator
                        | GeneralCategory::ParagraphSeparator
                        | GeneralCategory::Surrogate
                )
        })
}

fn validate_snapshot(snapshot: &ChatDisplaySnapshot) -> Result<(), ChatDisplayError> {
    if snapshot.schema_version != 1 || snapshot.records.len() > MAX_RECORDS {
        return Err(ChatDisplayError::invalid_input());
    }
    let mut keys = HashSet::with_capacity(snapshot.records.len());
    for record in &snapshot.records {
        if !valid_id(&record.chat_id)
            || !valid_id(&record.message_id)
            || record.revision < 2
            || record.revision > MAX_SAFE_REVISION
            || !valid_content(&record.source_content)
            || !valid_content(&record.content)
            || !keys.insert((record.chat_id.as_str(), record.message_id.as_str()))
        {
            return Err(ChatDisplayError::invalid_input());
        }
    }
    Ok(())
}

fn exact_display_root(path: &Path) -> std::io::Result<&Path> {
    if path.file_name() != Some(std::ffi::OsStr::new(CHAT_DISPLAY_FILE_NAME))
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid chat-display path",
        ));
    }
    path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "missing chat-display root",
        )
    })
}

fn validate_display_leaves(root: &Path) -> std::io::Result<()> {
    for leaf in [
        root.join(CHAT_DISPLAY_FILE_NAME),
        root.join(CHAT_DISPLAY_LOCK_NAME),
    ] {
        match fs::symlink_metadata(&leaf) {
            Ok(metadata) if !metadata.is_file() || is_reparse(&metadata) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display leaf is not a direct regular file",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(windows)]
struct DisplayDirectoryGuard {
    path: PathBuf,
    canonical: PathBuf,
    file: File,
}

#[cfg(windows)]
struct DisplayNamespace {
    root: PathBuf,
    guards: Vec<DisplayDirectoryGuard>,
}

#[cfg(windows)]
impl DisplayNamespace {
    fn confine(destination: &Path) -> std::io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        let requested_root = exact_display_root(destination)?;
        let mut ancestors = requested_root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut guards = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let before = fs::symlink_metadata(&path)?;
            if !before.is_dir() || is_reparse(&before) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display root has a reparse ancestor",
                ));
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            let opened = file.metadata()?;
            if !opened.is_dir() || is_reparse(&opened) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display root handle is a reparse point",
                ));
            }
            guards.push(DisplayDirectoryGuard {
                canonical: fs::canonicalize(&path)?,
                path,
                file,
            });
        }
        let root = fs::canonicalize(requested_root)?;
        let namespace = Self { root, guards };
        namespace.revalidate_display_leaf()?;
        Ok(namespace)
    }

    fn display_path(&self) -> PathBuf {
        self.root.join(CHAT_DISPLAY_FILE_NAME)
    }

    fn revalidate(&self) -> std::io::Result<()> {
        for guard in &self.guards {
            let path = fs::symlink_metadata(&guard.path)?;
            let opened = guard.file.metadata()?;
            if !path.is_dir()
                || !opened.is_dir()
                || is_reparse(&path)
                || is_reparse(&opened)
                || fs::canonicalize(&guard.path)? != guard.canonical
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display root namespace changed",
                ));
            }
        }
        Ok(())
    }

    fn revalidate_display_leaf(&self) -> std::io::Result<()> {
        self.revalidate()?;
        validate_display_leaves(&self.root)
    }
}

#[cfg(not(windows))]
struct DisplayNamespace {
    root: PathBuf,
    file: File,
    device: u64,
    inode: u64,
}

#[cfg(not(windows))]
impl DisplayNamespace {
    fn confine(destination: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let requested_root = exact_display_root(destination)?;
        for ancestor in requested_root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
        {
            let metadata = fs::symlink_metadata(ancestor)?;
            if !metadata.is_dir() || is_reparse(&metadata) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display root has a symlink ancestor",
                ));
            }
        }
        let canonical = fs::canonicalize(requested_root)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&canonical)?;
        let opened = file.metadata()?;
        let namespace = Self {
            root: canonical,
            device: opened.dev(),
            inode: opened.ino(),
            file,
        };
        namespace.revalidate_display_leaf()?;
        Ok(namespace)
    }

    fn display_path(&self) -> PathBuf {
        self.root.join(CHAT_DISPLAY_FILE_NAME)
    }

    fn revalidate_display_leaf(&self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let path = fs::symlink_metadata(&self.root)?;
        let opened = self.file.metadata()?;
        if path.file_type().is_symlink()
            || !path.is_dir()
            || path.dev() != self.device
            || path.ino() != self.inode
            || !opened.is_dir()
            || opened.dev() != self.device
            || opened.ino() != self.inode
            || fs::canonicalize(&self.root)? != self.root
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chat-display root namespace changed",
            ));
        }
        for ancestor in self
            .root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
        {
            let metadata = fs::symlink_metadata(ancestor)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "chat-display ancestor changed",
                ));
            }
        }
        validate_display_leaves(&self.root)
    }
}

#[cfg(unix)]
fn read_snapshot_from_directory(
    namespace: &DisplayNamespace,
) -> Result<ChatDisplaySnapshot, ChatDisplayError> {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(CHAT_DISPLAY_FILE_NAME).expect("static filename has no nul");
    let fd = unsafe {
        libc::openat(
            namespace.file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(empty_snapshot())
        } else {
            Err(ChatDisplayError::recovery_required())
        };
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| ChatDisplayError::recovery_required())?;
    if !metadata.is_file() || metadata.len() > MAX_CHAT_DISPLAY_BYTES as u64 {
        return Err(ChatDisplayError::recovery_required());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_CHAT_DISPLAY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ChatDisplayError::recovery_required())?;
    if bytes.len() > MAX_CHAT_DISPLAY_BYTES {
        return Err(ChatDisplayError::recovery_required());
    }
    let snapshot: ChatDisplaySnapshot =
        serde_json::from_slice(&bytes).map_err(|_| ChatDisplayError::recovery_required())?;
    validate_snapshot(&snapshot).map_err(|_| ChatDisplayError::recovery_required())?;
    Ok(snapshot)
}

#[cfg(unix)]
fn persist_bytes_in_directory(namespace: &DisplayNamespace, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    let temporary_name = format!(
        ".chat-display-v1.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let temporary = std::ffi::CString::new(temporary_name).expect("generated filename has no nul");
    let destination =
        std::ffi::CString::new(CHAT_DISPLAY_FILE_NAME).expect("static filename has no nul");
    let root_fd = namespace.file.as_raw_fd();
    let fd = unsafe {
        libc::openat(
            root_fd,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let result = (|| {
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if unsafe { libc::renameat(root_fd, temporary.as_ptr(), root_fd, destination.as_ptr()) }
            != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::fsync(root_fd) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(root_fd, temporary.as_ptr(), 0);
        }
    }
    result
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn lock_path(destination: &Path) -> std::io::Result<PathBuf> {
    Ok(destination
        .parent()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "missing chat-display root",
            )
        })?
        .join(CHAT_DISPLAY_LOCK_NAME))
}

#[cfg(windows)]
struct DisplayFileLock {
    file: File,
}

#[cfg(windows)]
impl DisplayFileLock {
    fn open(destination: &Path, create: bool) -> std::io::Result<File> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(lock_path(destination)?)?;
        if is_reparse(&file.metadata()?) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chat-display lock is a reparse point",
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
            if unsafe { LockFile(file.as_raw_handle() as _, 0, 0, 1, 0) } != 0 {
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
        if is_reparse(&self.file.metadata()?) {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chat-display lock changed",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for DisplayFileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFile;
        unsafe {
            UnlockFile(self.file.as_raw_handle() as _, 0, 0, 1, 0);
        }
    }
}

#[cfg(unix)]
struct DisplayFileLock {
    file: File,
}

#[cfg(unix)]
impl DisplayFileLock {
    fn open(destination: &Path, create: bool) -> std::io::Result<File> {
        use std::os::unix::fs::OpenOptionsExt;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .custom_flags(libc::O_NOFOLLOW)
            .open(lock_path(destination)?)?;
        if is_reparse(&file.metadata()?) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chat-display lock is a symlink",
            ));
        }
        Ok(file)
    }
    fn provision(destination: &Path) -> std::io::Result<()> {
        drop(Self::open(destination, true)?);
        Ok(())
    }
    fn acquire(destination: &Path) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        let file = Self::open(destination, false)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { file })
    }
    fn revalidate(&self) -> std::io::Result<()> {
        if self.file.metadata()?.is_file() {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chat-display lock changed",
            ))
        }
    }
}

#[cfg(unix)]
impl Drop for DisplayFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
