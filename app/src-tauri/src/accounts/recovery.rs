//! Durable transaction records for account-profile quarantine and recovery.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::delete::{
    build_cleanup_manifest, delete_tree_no_follow, derive_deletion_target, first_reparse_component,
    is_reparse, path_snapshot_no_follow, read_registry_handle_bounded, registry_generation,
    valid_account_id, validate_cleanup_manifest, CleanupManifestEntry, DeletionError,
    DeletionErrorCode, FileIdentity, PathSnapshot,
};
use super::{
    atomic_replace, durable_remove_dir, durable_remove_file, durable_remove_file_if_identity,
    durable_rename, read_account_registry_bounded, sync_parent, AccountRegistry,
    AccountRegistryReadError, MAX_PROVIDER_PRODUCT_ACCOUNTS,
};

pub(crate) const JOURNAL_VERSION: u32 = 1;
pub(crate) const MAX_TRANSACTION_JOURNAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSACTION_JOURNAL_ENTRIES: usize = MAX_PROVIDER_PRODUCT_ACCOUNTS;
const MAX_TRANSACTION_JOURNAL_AGGREGATE_BYTES: usize = MAX_TRANSACTION_JOURNAL_BYTES;
const TRANSACTION_PREFIX: &str = ".accounts.transaction.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransactionPhase {
    JournalPrepared,
    ProposalIdentityRecorded,
    ProposedRegistryFlushed,
    ProfileQuarantined,
    RegistryReplaced,
    Committed,
    CleanupInProgress,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionJournal {
    pub version: u32,
    pub transaction_id: String,
    pub account_id: String,
    pub original_registry_generation: String,
    pub proposed_registry_generation: String,
    #[serde(default)]
    pub proposal_identity: Option<FileIdentity>,
    pub source_identity: Option<FileIdentity>,
    pub source_present: bool,
    #[serde(default)]
    pub cleanup_manifest: Option<Vec<CleanupManifestEntry>>,
    #[serde(default)]
    pub cleanup_progress: u64,
    pub phase: TransactionPhase,
}

#[derive(Clone, Debug)]
pub(crate) struct TransactionPaths {
    pub trash: PathBuf,
    pub journals: PathBuf,
    pub journal: PathBuf,
    pub proposed_registry: PathBuf,
    pub quarantine: PathBuf,
}

#[derive(Debug)]
pub(crate) struct OpenProposedRegistry {
    file: fs::File,
    identity: FileIdentity,
}

#[derive(Debug)]
pub(crate) struct SealedProposedRegistry {
    file: fs::File,
    identity: FileIdentity,
}

#[derive(Debug)]
pub(crate) struct ProposalInstallError {
    pub(crate) error: std::io::Error,
    pub(crate) namespace_replaced: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecoverySummary {
    pub restored: u64,
    pub finalized: u64,
    pub pending: u64,
}

impl TransactionPaths {
    pub fn new(profiles: &Path, transaction_id: &str) -> Self {
        let trash = profiles.join(".trash");
        let journals = trash.join(".transactions");
        Self {
            journal: journals.join(format!("{transaction_id}.json")),
            proposed_registry: profiles
                .join(format!("{TRANSACTION_PREFIX}{transaction_id}.proposed")),
            quarantine: trash.join(transaction_id),
            trash,
            journals,
        }
    }
}

pub(crate) fn ensure_layout(paths: &TransactionPaths) -> std::io::Result<()> {
    ensure_regular_directory(&paths.trash)?;
    ensure_regular_directory(&paths.journals)?;
    Ok(())
}

pub(crate) fn create_journal(
    paths: &TransactionPaths,
    journal: &TransactionJournal,
) -> std::io::Result<()> {
    let bytes = serialize_journal(journal)?;
    write_new_synced(&paths.journal, &bytes)
}

pub(crate) fn update_journal(
    paths: &TransactionPaths,
    journal: &TransactionJournal,
) -> std::io::Result<()> {
    let bytes = serialize_journal(journal)?;
    atomic_replace(&paths.journal, &bytes)
}

pub(crate) fn create_proposed_registry(
    paths: &TransactionPaths,
) -> std::io::Result<OpenProposedRegistry> {
    let file = open_new_proposed_registry(&paths.proposed_registry)?;
    let snapshot = file_snapshot(&file)?;
    if snapshot.reparse_point || snapshot.directory || snapshot.hard_links != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "created proposal is not a safe single-link regular file",
        ));
    }
    Ok(OpenProposedRegistry {
        file,
        identity: snapshot.identity,
    })
}

impl OpenProposedRegistry {
    pub(crate) fn identity(&self) -> &FileIdentity {
        &self.identity
    }

    pub(crate) fn persist(self, paths: &TransactionPaths, bytes: &[u8]) -> std::io::Result<Self> {
        clear_proposed_registry_delete_on_close(&self.file)?;
        let mut file = reopen_proposed_registry_for_durable_write(&self.file)?;
        let reopened = file_snapshot(&file)?;
        if reopened.identity != self.identity
            || reopened.reparse_point
            || reopened.directory
            || reopened.hard_links != 1
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proposal identity changed before its durable write",
            ));
        }
        drop(self.file);
        file.write_all(bytes)?;
        file.sync_all()?;
        let snapshot = file_snapshot(&file)?;
        if snapshot.identity != self.identity
            || snapshot.reparse_point
            || snapshot.directory
            || snapshot.hard_links != 1
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proposal identity changed during its durable write",
            ));
        }
        sync_parent(paths.proposed_registry.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "proposed registry has no parent directory",
            )
        })?)?;
        Ok(Self {
            file,
            identity: self.identity,
        })
    }

    pub(crate) fn seal(self) -> std::io::Result<SealedProposedRegistry> {
        seal_proposed_registry(self)
    }
}

impl SealedProposedRegistry {
    pub(crate) fn identity(&self) -> &FileIdentity {
        &self.identity
    }

    pub(crate) fn read_exact_bytes(&mut self) -> std::io::Result<Vec<u8>> {
        let metadata_len = self.file.metadata()?.len();
        read_registry_handle_bounded(&mut self.file, metadata_len)
    }

    pub(crate) fn install(
        self,
        destination: &Path,
        parent: &Path,
    ) -> Result<FileIdentity, ProposalInstallError> {
        install_sealed_proposed_registry(self, destination, parent)
    }
}

pub(crate) fn remove_transaction_files(
    paths: &TransactionPaths,
    journal: &TransactionJournal,
) -> std::io::Result<()> {
    remove_transaction_files_observed(paths, journal, || Ok(()))
}

pub(crate) fn remove_transaction_files_observed<F>(
    paths: &TransactionPaths,
    journal: &TransactionJournal,
    mut after_journal_delete: F,
) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    // On Windows the allocation handle stays delete-on-close until its identity is journaled.
    // Therefore an occupant found after restart in JournalPrepared is not transaction-owned and
    // must be left. Other targets retain their existing fail-closed cleanup behavior.
    if !cfg!(windows) || journal.phase != TransactionPhase::JournalPrepared {
        remove_owned_proposal_if_present(
            &paths.proposed_registry,
            journal.proposal_identity.as_ref(),
        )?;
    }
    if remove_file_if_present(&paths.journal)? {
        after_journal_delete()?;
    }
    sync_parent(&paths.journals)?;
    remove_directory_if_empty(&paths.journals)?;
    remove_directory_if_empty(&paths.trash)?;
    Ok(())
}

pub(crate) fn recover_locked(registry: &AccountRegistry) -> Result<RecoverySummary, DeletionError> {
    let trash = registry.profiles_dir().join(".trash");
    if first_reparse_component(&trash)?.is_some() {
        return Err(recovery_error(
            "Studio quarantine crosses a reparse boundary",
        ));
    }
    let trash_metadata = match fs::symlink_metadata(&trash) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoverySummary::default())
        }
        Err(_) => return Err(recovery_error("Studio quarantine could not be inspected")),
    };
    if !trash_metadata.is_dir() || is_reparse(&trash_metadata) {
        return Err(recovery_error("Studio quarantine is not a safe directory"));
    }
    let journals = trash.join(".transactions");
    let journal_metadata = match fs::symlink_metadata(&journals) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoverySummary::default())
        }
        Err(_) => {
            return Err(recovery_error(
                "transaction journals could not be inspected",
            ))
        }
    };
    if !journal_metadata.is_dir() || is_reparse(&journal_metadata) {
        return Err(recovery_error("transaction journal directory is unsafe"));
    }
    let mut journal_entries = Vec::new();
    for entry in fs::read_dir(&journals)
        .map_err(|_| recovery_error("transaction journals could not be enumerated"))?
    {
        if journal_entries.len() >= MAX_TRANSACTION_JOURNAL_ENTRIES {
            return Err(recovery_error(
                "transaction journal directory exceeds its entry resource bound",
            ));
        }
        journal_entries.push(
            entry.map_err(|_| recovery_error("transaction journal entry could not be read"))?,
        );
    }
    journal_entries.sort_by_key(|entry| entry.file_name());

    let mut stale_temporary_paths = Vec::new();
    let mut journal_paths = Vec::new();
    let mut declared_aggregate_journal_bytes = 0_u64;
    for entry in journal_entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| recovery_error("transaction journal metadata could not be read"))?;
        if !metadata.is_file() || is_reparse(&metadata) {
            return Err(recovery_error("transaction journal entry is unsafe"));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| recovery_error("transaction journal name is invalid"))?;
        if name.starts_with(".accounts.json.") && name.ends_with(".tmp") {
            stale_temporary_paths.push(path);
            continue;
        }
        if !name.ends_with(".json") {
            return Err(recovery_error("transaction journal name is invalid"));
        }
        if metadata.len() > MAX_TRANSACTION_JOURNAL_BYTES as u64 {
            return Err(outcome_unknown(
                "transaction journal exceeds its encoded byte resource bound; record was retained",
            ));
        }
        declared_aggregate_journal_bytes = declared_aggregate_journal_bytes
            .checked_add(metadata.len())
            .filter(|total| *total <= MAX_TRANSACTION_JOURNAL_AGGREGATE_BYTES as u64)
            .ok_or_else(aggregate_journal_bound_error)?;
        journal_paths.push(path);
    }

    let mut admitted_journals = Vec::with_capacity(journal_paths.len());
    let mut aggregate_journal_bytes = 0_usize;
    for journal_path in journal_paths {
        let remaining = MAX_TRANSACTION_JOURNAL_AGGREGATE_BYTES
            .checked_sub(aggregate_journal_bytes)
            .ok_or_else(aggregate_journal_bound_error)?;
        let journal_bytes = read_transaction_journal_bounded(&journal_path, remaining)?;
        aggregate_journal_bytes = aggregate_journal_bytes
            .checked_add(journal_bytes.len())
            .filter(|total| *total <= MAX_TRANSACTION_JOURNAL_AGGREGATE_BYTES)
            .ok_or_else(aggregate_journal_bound_error)?;
        admitted_journals.push((journal_path, journal_bytes));
    }

    for path in stale_temporary_paths {
        durable_remove_file(&path)
            .map_err(|_| recovery_error("stale journal temporary could not be removed"))?;
    }

    let mut summary = RecoverySummary::default();
    for (journal_path, journal_bytes) in admitted_journals {
        let mut journal: TransactionJournal = serde_json::from_slice(&journal_bytes)
            .map_err(|_| recovery_error("transaction journal is invalid"))?;
        validate_journal(&journal_path, &journal)?;
        let paths = TransactionPaths::new(registry.profiles_dir(), &journal.transaction_id);
        if paths.journal != journal_path {
            return Err(recovery_error("transaction journal path is inconsistent"));
        }
        let source = derive_deletion_target(registry.profiles_dir(), &journal.account_id)?;
        if first_reparse_component(&source)?.is_some() {
            return Err(recovery_error(
                "source profile crosses a reparse boundary during recovery",
            ));
        }
        let registry_path = registry.registry_path();
        let registry_before = path_snapshot_no_follow(&registry_path)
            .map_err(|_| recovery_error("account registry could not be inspected during recovery"))?
            .ok_or_else(|| recovery_error("account registry is missing during recovery"))?;
        if registry_before.reparse_point || registry_before.directory {
            return Err(recovery_error("account registry is unsafe during recovery"));
        }
        let (registry_bytes, _) =
            read_account_registry_bounded(&registry_path).map_err(|error| match error {
                AccountRegistryReadError::Invalid => {
                    recovery_error("account registry is invalid during recovery")
                }
                AccountRegistryReadError::Io => {
                    recovery_error("account registry could not be read during recovery")
                }
            })?;
        let registry_after = path_snapshot_no_follow(&registry_path)
            .map_err(|_| recovery_error("account registry could not be rechecked during recovery"))?
            .ok_or_else(|| recovery_error("account registry disappeared during recovery"))?;
        if registry_before.identity != registry_after.identity
            || registry_after.reparse_point
            || registry_after.directory
        {
            return Err(outcome_unknown(
                "account registry identity changed during recovery; record was retained",
            ));
        }
        let generation = registry_generation(&registry_bytes);
        let committed = if generation == journal.proposed_registry_generation {
            true
        } else if generation == journal.original_registry_generation {
            false
        } else {
            return Err(outcome_unknown(
                "account registry generation is ambiguous; recovery record was retained",
            ));
        };

        if committed
            && journal
                .proposal_identity
                .as_ref()
                .is_none_or(|expected| registry_after.identity != *expected)
        {
            return Err(outcome_unknown(
                "committed registry is not the recorded proposal object; recovery record was retained",
            ));
        }

        if committed {
            finalize_committed(&source, &paths, &mut journal)?;
            summary.finalized += 1;
        } else {
            restore_precommit(&source, &paths, &journal)?;
            summary.restored += 1;
        }
    }
    Ok(summary)
}

fn validate_journal(path: &Path, journal: &TransactionJournal) -> Result<(), DeletionError> {
    let expected_name = format!("{}.json", journal.transaction_id);
    let proposal_identity_valid = match journal.phase {
        TransactionPhase::JournalPrepared => journal.proposal_identity.is_none(),
        _ => journal.proposal_identity.is_some(),
    };
    let cleanup_manifest_valid = match journal.cleanup_manifest.as_ref() {
        Some(manifest) => {
            journal.phase == TransactionPhase::CleanupInProgress
                && journal.cleanup_progress <= manifest.len() as u64
        }
        None => journal.cleanup_progress == 0,
    };
    if journal.version != JOURNAL_VERSION
        || !valid_transaction_id(&journal.transaction_id)
        || !valid_account_id(&journal.account_id)
        || path
            .file_name()
            .is_none_or(|name| name != expected_name.as_str())
        || journal.original_registry_generation.len() != 64
        || journal.proposed_registry_generation.len() != 64
        || !proposal_identity_valid
        || !cleanup_manifest_valid
    {
        return Err(recovery_error("transaction journal failed validation"));
    }
    Ok(())
}

fn restore_precommit(
    source: &Path,
    paths: &TransactionPaths,
    journal: &TransactionJournal,
) -> Result<(), DeletionError> {
    let source_snapshot = path_snapshot_no_follow(source)
        .map_err(|_| recovery_error("source profile could not be inspected during recovery"))?;
    let quarantine_snapshot = path_snapshot_no_follow(&paths.quarantine)
        .map_err(|_| recovery_error("quarantine could not be inspected during recovery"))?;
    if journal.source_present {
        let expected = journal.source_identity.as_ref().ok_or_else(|| {
            recovery_error("transaction journal omitted the source profile identity")
        })?;
        match (source_snapshot, quarantine_snapshot) {
            (Some(source), None)
                if !source.reparse_point && source.directory && source.identity == *expected => {}
            (None, Some(quarantine))
                if !quarantine.reparse_point
                    && quarantine.directory
                    && quarantine.identity == *expected =>
            {
                durable_rename(&paths.quarantine, source)
                    .map_err(|_| recovery_error("quarantined profile could not be restored"))?;
                let restored = path_snapshot_no_follow(source)
                    .map_err(|_| recovery_error("restored profile could not be inspected"))?
                    .ok_or_else(|| recovery_error("restored profile is missing"))?;
                if restored.reparse_point || restored.identity != *expected {
                    return Err(outcome_unknown(
                        "restored profile identity is uncertain; recovery record was retained",
                    ));
                }
            }
            _ => {
                return Err(outcome_unknown(
                    "pre-commit profile state is ambiguous; recovery record was retained",
                ))
            }
        }
    } else if quarantine_snapshot.is_some() {
        return Err(outcome_unknown(
            "unexpected quarantine exists for an absent prepared profile",
        ));
    }
    remove_transaction_files(paths, journal).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidData {
            outcome_unknown("proposal identity is uncertain; restored recovery record was retained")
        } else {
            recovery_error("restored transaction record cleanup is pending")
        }
    })
}

fn finalize_committed(
    source: &Path,
    paths: &TransactionPaths,
    journal: &mut TransactionJournal,
) -> Result<(), DeletionError> {
    let source_snapshot = path_snapshot_no_follow(source)
        .map_err(|_| recovery_error("source profile could not be inspected during recovery"))?;
    let quarantine_snapshot = path_snapshot_no_follow(&paths.quarantine)
        .map_err(|_| recovery_error("quarantine could not be inspected during recovery"))?;
    if journal.source_present {
        if source_snapshot.is_some() {
            return Err(outcome_unknown(
                "committed transaction has an unexpected source profile",
            ));
        }
        let expected = journal.source_identity.clone().ok_or_else(|| {
            recovery_error("transaction journal omitted the source profile identity")
        })?;
        if let Some(quarantine) = quarantine_snapshot {
            if quarantine.reparse_point || !quarantine.directory || quarantine.identity != expected
            {
                return Err(outcome_unknown(
                    "committed quarantine identity is uncertain; recovery record was retained",
                ));
            }
            if journal.cleanup_manifest.is_none() {
                if journal.phase == TransactionPhase::CleanupInProgress {
                    return Err(outcome_unknown(
                        "committed cleanup ownership is uncertain; recovery record was retained",
                    ));
                }
                let manifest = build_cleanup_manifest(&paths.quarantine, &expected)
                    .map_err(committed_cleanup_error)?;
                journal.cleanup_manifest = Some(manifest);
                journal.cleanup_progress = 0;
                journal.phase = TransactionPhase::CleanupInProgress;
                update_journal(paths, journal).map_err(committed_cleanup_persist_error)?;
            }
            let manifest = journal.cleanup_manifest.clone().ok_or_else(|| {
                outcome_unknown(
                    "committed cleanup ownership is uncertain; recovery record was retained",
                )
            })?;
            let cleanup_progress = journal.cleanup_progress;
            delete_tree_no_follow(
                &paths.quarantine,
                &expected,
                &manifest,
                cleanup_progress,
                |next_progress| {
                    journal.cleanup_progress = next_progress;
                    update_journal(paths, journal)
                },
            )
            .map_err(committed_cleanup_error)?;
        } else {
            let manifest = journal.cleanup_manifest.as_deref().ok_or_else(|| {
                outcome_unknown(
                    "committed quarantine disappeared without cleanup progress; recovery record was retained",
                )
            })?;
            validate_cleanup_manifest(&paths.quarantine, &expected, manifest)
                .map_err(committed_cleanup_error)?;
            if journal.cleanup_progress != manifest.len() as u64 {
                return Err(outcome_unknown(
                    "committed quarantine disappeared without cleanup progress; recovery record was retained",
                ));
            }
        }
    } else if quarantine_snapshot.is_some() {
        return Err(outcome_unknown(
            "unexpected quarantine exists for a committed absent profile",
        ));
    }
    remove_transaction_files(paths, journal).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidData {
            outcome_unknown(
                "proposal identity is uncertain; committed recovery record was retained",
            )
        } else {
            DeletionError {
                code: DeletionErrorCode::CleanupPending,
                message: "committed transaction record cleanup remains pending".to_owned(),
            }
        }
    })
}

fn committed_cleanup_error(error: std::io::Error) -> DeletionError {
    if error.kind() == std::io::ErrorKind::InvalidData {
        outcome_unknown("committed cleanup identity is uncertain; recovery record was retained")
    } else {
        DeletionError {
            code: DeletionErrorCode::CleanupPending,
            message: "committed quarantine cleanup remains pending".to_owned(),
        }
    }
}

fn committed_cleanup_persist_error(error: std::io::Error) -> DeletionError {
    if error.kind() == std::io::ErrorKind::InvalidData {
        outcome_unknown(
            "committed cleanup inventory exceeds its durable resource bounds; record was retained",
        )
    } else {
        DeletionError {
            code: DeletionErrorCode::CleanupPending,
            message: "committed cleanup inventory could not be persisted".to_owned(),
        }
    }
}

fn valid_transaction_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn recovery_error(message: &str) -> DeletionError {
    DeletionError {
        code: DeletionErrorCode::RecoveryRequired,
        message: message.to_owned(),
    }
}

fn outcome_unknown(message: &str) -> DeletionError {
    DeletionError {
        code: DeletionErrorCode::OutcomeUnknown,
        message: message.to_owned(),
    }
}

fn aggregate_journal_bound_error() -> DeletionError {
    recovery_error(
        "transaction journals exceed their aggregate encoded byte resource bound; records were retained",
    )
}

fn serialize_journal(journal: &TransactionJournal) -> std::io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    validate_transaction_journal_encoded_len(bytes.len())?;
    Ok(bytes)
}

fn validate_transaction_journal_encoded_len(encoded_len: usize) -> std::io::Result<()> {
    if encoded_len > MAX_TRANSACTION_JOURNAL_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "transaction journal exceeds its encoded byte resource bound",
        ));
    }
    Ok(())
}

fn read_transaction_journal_bounded(
    path: &Path,
    aggregate_remaining: usize,
) -> Result<Vec<u8>, DeletionError> {
    let file = fs::File::open(path)
        .map_err(|_| recovery_error("transaction journal could not be read"))?;
    let encoded_len = file
        .metadata()
        .map_err(|_| recovery_error("transaction journal metadata could not be read"))?
        .len();
    if encoded_len > MAX_TRANSACTION_JOURNAL_BYTES as u64 {
        return Err(outcome_unknown(
            "transaction journal exceeds its encoded byte resource bound; record was retained",
        ));
    }
    if encoded_len > aggregate_remaining as u64 {
        return Err(aggregate_journal_bound_error());
    }
    let initial_capacity = usize::try_from(encoded_len)
        .map_err(|_| outcome_unknown("transaction journal size is unsupported"))?;
    let mut bytes = Vec::with_capacity(initial_capacity);
    let read_ceiling = MAX_TRANSACTION_JOURNAL_BYTES.min(aggregate_remaining);
    file.take(read_ceiling.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| recovery_error("transaction journal could not be read"))?;
    if bytes.len() > MAX_TRANSACTION_JOURNAL_BYTES {
        return Err(outcome_unknown(
            "transaction journal grew beyond its encoded byte resource bound; record was retained",
        ));
    }
    if bytes.len() > aggregate_remaining {
        return Err(aggregate_journal_bound_error());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn open_new_proposed_registry(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;

    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

#[cfg(not(windows))]
fn open_new_proposed_registry(path: &Path) -> std::io::Result<fs::File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(windows)]
fn clear_proposed_registry_delete_on_close(file: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfoEx, SetFileInformationByHandle, FILE_DISPOSITION_FLAG_ON_CLOSE,
        FILE_DISPOSITION_INFO_EX,
    };

    // ON_CLOSE without DELETE clears the create-time delete-on-close state on this exact handle.
    // The legacy FileDispositionInfo class cannot clear FILE_FLAG_DELETE_ON_CLOSE.
    let mut disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_ON_CLOSE,
    };
    let succeeded = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileDispositionInfoEx,
            (&mut disposition as *mut FILE_DISPOSITION_INFO_EX).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO_EX>()
                .try_into()
                .unwrap_or(u32::MAX),
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn clear_proposed_registry_delete_on_close(_file: &fs::File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn reopen_proposed_registry_for_durable_write(file: &fs::File) -> std::io::Result<fs::File> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        ReOpenFile, DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let handle = unsafe {
        ReOpenFile(
            file.as_raw_handle() as _,
            GENERIC_READ | GENERIC_WRITE | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }
}

#[cfg(not(windows))]
fn reopen_proposed_registry_for_durable_write(file: &fs::File) -> std::io::Result<fs::File> {
    file.try_clone()
}

#[cfg(windows)]
pub(crate) fn file_snapshot(file: &fs::File) -> std::io::Result<PathSnapshot> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let inspected =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if inspected == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PathSnapshot {
        identity: FileIdentity {
            volume: u64::from(information.dwVolumeSerialNumber),
            file: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        },
        reparse_point: information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        directory: information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        hard_links: information.nNumberOfLinks,
    })
}

#[cfg(unix)]
pub(crate) fn file_snapshot(file: &fs::File) -> std::io::Result<PathSnapshot> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(PathSnapshot {
        identity: FileIdentity {
            volume: metadata.dev(),
            file: metadata.ino(),
        },
        reparse_point: false,
        directory: metadata.is_dir(),
        hard_links: metadata.nlink().try_into().unwrap_or(u32::MAX),
    })
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn file_snapshot(_file: &fs::File) -> std::io::Result<PathSnapshot> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "proposal file identity is unavailable on this platform",
    ))
}

#[cfg(windows)]
fn seal_proposed_registry(
    proposed: OpenProposedRegistry,
) -> std::io::Result<SealedProposedRegistry> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        ReOpenFile, DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    fn reopen(file: &fs::File, access: u32, share: u32) -> std::io::Result<fs::File> {
        let handle = unsafe {
            ReOpenFile(
                file.as_raw_handle() as _,
                access,
                share,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { fs::File::from_raw_handle(handle) })
        }
    }

    let OpenProposedRegistry { file, identity } = proposed;
    let transition = reopen(
        &file,
        GENERIC_READ | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )?;
    drop(file);
    let sealed = reopen(
        &transition,
        GENERIC_READ | GENERIC_WRITE | DELETE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    )?;
    drop(transition);
    let snapshot = file_snapshot(&sealed)?;
    if snapshot.reparse_point
        || snapshot.directory
        || snapshot.hard_links != 1
        || snapshot.identity != identity
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "proposal identity changed while sealing its handle",
        ));
    }
    Ok(SealedProposedRegistry {
        file: sealed,
        identity,
    })
}

#[cfg(not(windows))]
fn seal_proposed_registry(
    proposed: OpenProposedRegistry,
) -> std::io::Result<SealedProposedRegistry> {
    Ok(SealedProposedRegistry {
        file: proposed.file,
        identity: proposed.identity,
    })
}

#[cfg(windows)]
fn install_sealed_proposed_registry(
    proposed: SealedProposedRegistry,
    destination: &Path,
    parent: &Path,
) -> Result<FileIdentity, ProposalInstallError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, FlushFileBuffers, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    let name_bytes = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| ProposalInstallError {
            error: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "registry destination path is too long",
            ),
            namespace_replaced: false,
        })?;
    let file_name_length = u32::try_from(name_bytes).map_err(|_| ProposalInstallError {
        error: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "registry destination path is too long",
        ),
        namespace_replaced: false,
    })?;
    let buffer_len = std::mem::size_of::<FILE_RENAME_INFO>()
        .checked_add(name_bytes.saturating_sub(std::mem::size_of::<u16>()))
        .ok_or_else(|| ProposalInstallError {
            error: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "registry destination path is too long",
            ),
            namespace_replaced: false,
        })?;
    let word = std::mem::size_of::<usize>();
    let mut buffer = vec![0usize; buffer_len.div_ceil(word)];
    let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        std::ptr::write(information, FILE_RENAME_INFO::default());
        (*information).Anonymous.ReplaceIfExists = true;
        (*information).RootDirectory = std::ptr::null_mut();
        (*information).FileNameLength = file_name_length;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            (information.cast::<u8>())
                .add(std::mem::offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>(),
            name.len(),
        );
    }

    let handle = proposed.file.as_raw_handle() as _;
    let replaced = unsafe {
        SetFileInformationByHandle(
            handle,
            FileRenameInfo,
            information.cast(),
            u32::try_from(buffer_len).unwrap_or(u32::MAX),
        )
    };
    if replaced == 0 {
        return Err(ProposalInstallError {
            error: std::io::Error::last_os_error(),
            namespace_replaced: false,
        });
    }
    let flushed = unsafe { FlushFileBuffers(handle) };
    if flushed == 0 {
        return Err(ProposalInstallError {
            error: std::io::Error::last_os_error(),
            namespace_replaced: true,
        });
    }
    let snapshot = file_snapshot(&proposed.file).map_err(|error| ProposalInstallError {
        error,
        namespace_replaced: true,
    })?;
    if snapshot.identity != proposed.identity || snapshot.reparse_point || snapshot.directory {
        return Err(ProposalInstallError {
            error: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "installed registry handle changed identity",
            ),
            namespace_replaced: true,
        });
    }
    sync_parent(parent).map_err(|error| ProposalInstallError {
        error,
        namespace_replaced: true,
    })?;
    Ok(proposed.identity)
}

#[cfg(not(windows))]
fn install_sealed_proposed_registry(
    _proposed: SealedProposedRegistry,
    _destination: &Path,
    _parent: &Path,
) -> Result<FileIdentity, ProposalInstallError> {
    Err(ProposalInstallError {
        error: std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "identity-bound proposal installation is unavailable on this platform",
        ),
        namespace_replaced: false,
    })
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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
    file.sync_all()?;
    drop(file);
    sync_parent(path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "transaction file has no parent directory",
        )
    })?)
}

fn ensure_regular_directory(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => Ok(()),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "transaction directory is not a regular directory",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            let metadata = fs::symlink_metadata(path)?;
            if metadata.is_dir() && !is_reparse(&metadata) {
                sync_parent(path.parent().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "transaction directory has no parent",
                    )
                })?)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "created transaction directory is unsafe",
                ))
            }
        }
        Err(error) => Err(error),
    }
}

fn remove_file_if_present(path: &Path) -> std::io::Result<bool> {
    match durable_remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_owned_proposal_if_present(
    path: &Path,
    expected_identity: Option<&FileIdentity>,
) -> std::io::Result<bool> {
    let Some(expected_identity) = expected_identity else {
        return match path_snapshot_no_follow(path)? {
            None => Ok(false),
            Some(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proposal exists without a recorded identity",
            )),
        };
    };
    match durable_remove_file_if_identity(path, expected_identity) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_directory_if_empty(path: &Path) -> std::io::Result<()> {
    match durable_remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod journal_resource_tests {
    use super::{validate_transaction_journal_encoded_len, MAX_TRANSACTION_JOURNAL_BYTES};

    #[test]
    fn encoded_journal_byte_bound_is_inclusive() {
        assert!(validate_transaction_journal_encoded_len(MAX_TRANSACTION_JOURNAL_BYTES).is_ok());
        assert!(
            validate_transaction_journal_encoded_len(MAX_TRANSACTION_JOURNAL_BYTES + 1).is_err()
        );
    }
}
