use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::generated::{reject_duplicate_json_keys, HarnessCursor};
use super::sidecar::HarnessError;

const RECOVERY_SCHEMA_VERSION: u8 = 1;
const MAX_SESSIONS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RecoveredSession {
    pub session_id: String,
    pub account_id: Option<String>,
    pub project_id: String,
    pub chat_id: String,
    pub cursor: HarnessCursor,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub schema_version: u8,
    pub projection_schema_version: u16,
    pub revision: u64,
    pub runtime_digest: String,
    pub profile: String,
    pub sessions: Vec<RecoveredSession>,
}

impl RecoveryRecord {
    pub fn validate(&self) -> Result<(), HarnessError> {
        if self.schema_version != RECOVERY_SCHEMA_VERSION
            || self.projection_schema_version != 1
            || self.revision > MAX_SAFE_INTEGER
            || !valid_digest(&self.runtime_digest)
            || !valid_id(&self.profile)
            || self.sessions.len() > MAX_SESSIONS
        {
            return Err(HarnessError::RecoveryFailed);
        }
        for (index, session) in self.sessions.iter().enumerate() {
            if !valid_id(&session.session_id)
                || session.account_id.as_ref().is_some_and(|id| !valid_id(id))
                || !valid_id(&session.project_id)
                || !valid_id(&session.chat_id)
                || !valid_id(&session.cursor.runtime_generation)
                || session.cursor.sequence > MAX_SAFE_INTEGER
                || self.sessions[..index]
                    .iter()
                    .any(|seen| seen.session_id == session.session_id)
            {
                return Err(HarnessError::RecoveryFailed);
            }
        }
        Ok(())
    }
}

pub struct RecoveryStore {
    path: PathBuf,
    next: PathBuf,
    backup: PathBuf,
}

impl RecoveryStore {
    pub const MAX_BYTES: usize = 1024 * 1024;

    pub fn new(path: PathBuf) -> Result<Self, HarnessError> {
        if !path.is_absolute() || path.file_name().is_none() || path.parent().is_none() {
            return Err(HarnessError::RecoveryFailed);
        }
        let parent = path
            .parent()
            .ok_or(HarnessError::RecoveryFailed)?
            .to_path_buf();
        validate_store_path(&path)?;
        Ok(Self {
            path,
            next: parent.join(".harness-recovery.next"),
            backup: parent.join(".harness-recovery.backup"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<RecoveryRecord>, HarnessError> {
        if entry_exists(&self.next)? || entry_exists(&self.backup)? {
            return Err(HarnessError::RecoveryFailed);
        }
        let Some(bytes) = read_bounded(&self.path)? else {
            return Ok(None);
        };
        reject_duplicate_json_keys(&bytes).map_err(|_| HarnessError::RecoveryFailed)?;
        let record: RecoveryRecord =
            serde_json::from_slice(&bytes).map_err(|_| HarnessError::RecoveryFailed)?;
        record.validate()?;
        Ok(Some(record))
    }

    pub fn save(
        &self,
        expected_revision: u64,
        record: &RecoveryRecord,
    ) -> Result<(), HarnessError> {
        record.validate()?;
        if record.revision != expected_revision.saturating_add(1)
            || entry_exists(&self.next)?
            || entry_exists(&self.backup)?
        {
            return Err(HarnessError::RecoveryFailed);
        }
        let observed = self.load()?.map_or(0, |current| current.revision);
        if observed != expected_revision {
            return Err(HarnessError::RecoveryFailed);
        }
        let bytes = serde_json::to_vec(record).map_err(|_| HarnessError::RecoveryFailed)?;
        if bytes.len() > Self::MAX_BYTES {
            return Err(HarnessError::RecoveryFailed);
        }
        let result = (|| {
            let mut next = open_new_recovery_file(&self.next)?;
            next.write_all(&bytes)?;
            next.sync_all()?;
            drop(next);
            replace_file(&self.next, &self.path, &self.backup)?;
            sync_parent(&self.path)?;
            if self.backup.exists() {
                fs::remove_file(&self.backup)?;
                sync_parent(&self.path)?;
            }
            Ok::<(), std::io::Error>(())
        })();
        result.map_err(|_| HarnessError::RecoveryFailed)
    }
}

fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>, HarnessError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(HarnessError::RecoveryFailed),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse(&metadata)
        || metadata.len() > RecoveryStore::MAX_BYTES as u64
    {
        return Err(HarnessError::RecoveryFailed);
    }
    let file = match open_recovery_read(path) {
        Ok(file) => file,
        Err(_) => return Err(HarnessError::RecoveryFailed),
    };
    let opened = file.metadata().map_err(|_| HarnessError::RecoveryFailed)?;
    if !opened.is_file()
        || metadata_is_reparse(&opened)
        || opened.len() != metadata.len()
        || opened.len() > RecoveryStore::MAX_BYTES as u64
    {
        return Err(HarnessError::RecoveryFailed);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take((RecoveryStore::MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| HarnessError::RecoveryFailed)?;
    if bytes.len() > RecoveryStore::MAX_BYTES {
        return Err(HarnessError::RecoveryFailed);
    }
    Ok(Some(bytes))
}

fn entry_exists(path: &Path) -> Result<bool, HarnessError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(HarnessError::RecoveryFailed),
    }
}

fn validate_store_path(path: &Path) -> Result<(), HarnessError> {
    let parent = path.parent().ok_or(HarnessError::RecoveryFailed)?;
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| HarnessError::RecoveryFailed)?;
        if metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
            return Err(HarnessError::RecoveryFailed);
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse(&metadata)
        {
            return Err(HarnessError::RecoveryFailed);
        }
    }
    Ok(())
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

#[cfg(windows)]
fn open_recovery_read(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_recovery_read(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

#[cfg(windows)]
fn open_new_recovery_file(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_new_recovery_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_digest(value: &str) -> bool {
    matches!(value.strip_prefix("sha256:"), Some(digest) if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn sync_parent(path: &Path) -> std::io::Result<()> {
    crate::accounts::sync_parent(
        path.parent()
            .ok_or_else(|| std::io::Error::other("missing parent"))?,
    )
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path, backup: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let backup: Vec<u16> = backup.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                source.as_ptr(),
                backup.as_ptr(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                source.as_ptr(),
                destination_wide.as_ptr(),
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
fn replace_file(source: &Path, destination: &Path, _backup: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}
