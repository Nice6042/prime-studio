use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const STORE_FILE_NAME: &str = "editor-drafts-v1.json";
const STORE_SCHEMA_VERSION: u8 = 1;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_EDITOR_DRAFT_RECORDS: usize = 64;
pub(crate) const MAX_EDITOR_DRAFT_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_EDITOR_DRAFT_TOTAL_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STORE_BYTES: usize = 10 * 1024 * 1024;
const MAX_SCOPE_ID_BYTES: usize = 512;
const MAX_DOCUMENT_ID_BYTES: usize = 2_048;
const MAX_OPERATION_ID_BYTES: usize = 160;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EditorDraftErrorCode {
    InvalidInput,
    RevisionConflict,
    CapacityExceeded,
    RecoveryRequired,
    PersistenceOutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EditorDraftError {
    code: EditorDraftErrorCode,
}

impl EditorDraftError {
    const fn invalid_input() -> Self {
        Self {
            code: EditorDraftErrorCode::InvalidInput,
        }
    }

    const fn revision_conflict() -> Self {
        Self {
            code: EditorDraftErrorCode::RevisionConflict,
        }
    }

    const fn capacity_exceeded() -> Self {
        Self {
            code: EditorDraftErrorCode::CapacityExceeded,
        }
    }

    const fn recovery_required() -> Self {
        Self {
            code: EditorDraftErrorCode::RecoveryRequired,
        }
    }

    const fn persistence_outcome_unknown() -> Self {
        Self {
            code: EditorDraftErrorCode::PersistenceOutcomeUnknown,
        }
    }

    const fn code(self) -> &'static str {
        match self.code {
            EditorDraftErrorCode::InvalidInput => "invalidInput",
            EditorDraftErrorCode::RevisionConflict => "revisionConflict",
            EditorDraftErrorCode::CapacityExceeded => "capacityExceeded",
            EditorDraftErrorCode::RecoveryRequired => "recoveryRequired",
            EditorDraftErrorCode::PersistenceOutcomeUnknown => "persistenceOutcomeUnknown",
        }
    }
}

impl fmt::Display for EditorDraftError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for EditorDraftError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorDraftRecord {
    pub scope_id: String,
    pub document_id: String,
    pub baseline_digest: String,
    pub content: String,
    pub revision: u64,
    pub last_operation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorDraftSnapshot {
    pub schema_version: u8,
    pub store_revision: u64,
    pub records: Vec<EditorDraftRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorDraftPutRequest {
    pub scope_id: String,
    pub document_id: String,
    pub baseline_digest: String,
    pub expected_revision: Option<u64>,
    pub operation_id: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorDraftDeleteRequest {
    pub scope_id: String,
    pub document_id: String,
    pub baseline_digest: String,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorDraftMutationResult {
    pub store_revision: u64,
    pub record_revision: Option<u64>,
    pub status: EditorDraftMutationStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EditorDraftMutationStatus {
    Stored,
    Deleted,
    Absent,
    Replayed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredEnvelope {
    schema_version: u8,
    store_revision: u64,
    records: Vec<EditorDraftRecord>,
    checksum: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksumPayload<'a> {
    schema_version: u8,
    store_revision: u64,
    records: &'a [EditorDraftRecord],
}

#[derive(Clone, Copy)]
struct StoreLimits {
    records: usize,
    content_bytes: usize,
    total_content_bytes: usize,
    store_bytes: usize,
}

impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            records: MAX_EDITOR_DRAFT_RECORDS,
            content_bytes: MAX_EDITOR_DRAFT_CONTENT_BYTES,
            total_content_bytes: MAX_EDITOR_DRAFT_TOTAL_CONTENT_BYTES,
            store_bytes: MAX_STORE_BYTES,
        }
    }
}

struct EditorDraftStore {
    path: PathBuf,
    mutation: Mutex<()>,
    limits: StoreLimits,
}

impl EditorDraftStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            mutation: Mutex::new(()),
            limits: StoreLimits::default(),
        }
    }

    #[cfg(test)]
    fn with_limits(path: PathBuf, limits: StoreLimits) -> Self {
        Self {
            path,
            mutation: Mutex::new(()),
            limits,
        }
    }

    fn load_scope(&self, scope_id: &str) -> Result<EditorDraftSnapshot, EditorDraftError> {
        validate_scope_id(scope_id)?;
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| EditorDraftError::recovery_required())?;
        let envelope = self.read_envelope()?;
        let records = envelope
            .records
            .into_iter()
            .filter(|record| record.scope_id == scope_id)
            .collect();
        Ok(EditorDraftSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            store_revision: envelope.store_revision,
            records,
        })
    }

    fn put(
        &self,
        request: EditorDraftPutRequest,
    ) -> Result<EditorDraftMutationResult, EditorDraftError> {
        validate_put_request(&request, self.limits)?;
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| EditorDraftError::recovery_required())?;
        let mut envelope = self.read_envelope()?;
        let index = record_index(&envelope.records, &request.scope_id, &request.document_id);

        if let Some(index) = index {
            let current = &envelope.records[index];
            if current.last_operation_id == request.operation_id {
                if current.baseline_digest == request.baseline_digest
                    && current.content == request.content
                {
                    return Ok(EditorDraftMutationResult {
                        store_revision: envelope.store_revision,
                        record_revision: Some(current.revision),
                        status: EditorDraftMutationStatus::Replayed,
                    });
                }
                return Err(EditorDraftError::revision_conflict());
            }
            if request.expected_revision != Some(current.revision)
                || request.baseline_digest != current.baseline_digest
            {
                return Err(EditorDraftError::revision_conflict());
            }
        } else if request.expected_revision.is_some() {
            return Err(EditorDraftError::revision_conflict());
        }

        let next_revision = next_revision(envelope.store_revision)?;
        let record = EditorDraftRecord {
            scope_id: request.scope_id,
            document_id: request.document_id,
            baseline_digest: request.baseline_digest,
            content: request.content,
            revision: next_revision,
            last_operation_id: request.operation_id,
        };
        if let Some(index) = index {
            envelope.records[index] = record.clone();
        } else {
            envelope.records.push(record.clone());
        }
        envelope.store_revision = next_revision;
        self.evict_to_limits(&mut envelope, (&record.scope_id, &record.document_id))?;
        canonicalize(&mut envelope.records);
        envelope.checksum = checksum_for(
            envelope.schema_version,
            envelope.store_revision,
            &envelope.records,
        )?;
        self.persist_and_verify(&envelope)?;
        Ok(EditorDraftMutationResult {
            store_revision: envelope.store_revision,
            record_revision: Some(record.revision),
            status: EditorDraftMutationStatus::Stored,
        })
    }

    fn delete(
        &self,
        request: EditorDraftDeleteRequest,
    ) -> Result<EditorDraftMutationResult, EditorDraftError> {
        validate_delete_request(&request)?;
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| EditorDraftError::recovery_required())?;
        let mut envelope = self.read_envelope()?;
        let Some(index) = record_index(&envelope.records, &request.scope_id, &request.document_id)
        else {
            return Ok(EditorDraftMutationResult {
                store_revision: envelope.store_revision,
                record_revision: None,
                status: EditorDraftMutationStatus::Absent,
            });
        };
        let current = &envelope.records[index];
        if current.revision != request.expected_revision
            || current.baseline_digest != request.baseline_digest
        {
            return Err(EditorDraftError::revision_conflict());
        }

        envelope.records.remove(index);
        envelope.store_revision = next_revision(envelope.store_revision)?;
        canonicalize(&mut envelope.records);
        envelope.checksum = checksum_for(
            envelope.schema_version,
            envelope.store_revision,
            &envelope.records,
        )?;
        self.persist_and_verify(&envelope)?;
        Ok(EditorDraftMutationResult {
            store_revision: envelope.store_revision,
            record_revision: None,
            status: EditorDraftMutationStatus::Deleted,
        })
    }

    fn evict_to_limits(
        &self,
        envelope: &mut StoredEnvelope,
        protected: (&str, &str),
    ) -> Result<(), EditorDraftError> {
        loop {
            let total = total_content_bytes(&envelope.records)?;
            if envelope.records.len() <= self.limits.records
                && total <= self.limits.total_content_bytes
            {
                break;
            }
            let candidate = envelope
                .records
                .iter()
                .enumerate()
                .filter(|(_, record)| {
                    record.scope_id != protected.0 || record.document_id != protected.1
                })
                .min_by(|(_, left), (_, right)| {
                    (left.revision, &left.scope_id, &left.document_id).cmp(&(
                        right.revision,
                        &right.scope_id,
                        &right.document_id,
                    ))
                })
                .map(|(index, _)| index)
                .ok_or_else(EditorDraftError::capacity_exceeded)?;
            envelope.records.remove(candidate);
        }
        if envelope.records.len() > self.limits.records
            || total_content_bytes(&envelope.records)? > self.limits.total_content_bytes
        {
            return Err(EditorDraftError::capacity_exceeded());
        }
        Ok(())
    }

    fn read_envelope(&self) -> Result<StoredEnvelope, EditorDraftError> {
        self.ensure_trusted_parent()?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return empty_envelope()
            }
            Err(_) => return Err(EditorDraftError::recovery_required()),
        };
        if !metadata.is_file()
            || metadata_is_reparse(&metadata)
            || metadata.len() > self.limits.store_bytes as u64
        {
            return self.quarantine_and_fail();
        }
        let bytes = crate::bounded_io::read_bounded(&self.path, self.limits.store_bytes)
            .map_err(|_| EditorDraftError::recovery_required())?
            .bytes;
        let envelope = serde_json::from_slice::<StoredEnvelope>(&bytes)
            .map_err(|_| EditorDraftError::recovery_required());
        let envelope = match envelope {
            Ok(envelope) => envelope,
            Err(_) => return self.quarantine_and_fail(),
        };
        if validate_envelope(&envelope, self.limits).is_err() {
            return self.quarantine_and_fail();
        }
        Ok(envelope)
    }

    fn persist_and_verify(&self, envelope: &StoredEnvelope) -> Result<(), EditorDraftError> {
        validate_envelope(envelope, self.limits)?;
        self.ensure_trusted_parent()?;
        if self.path.exists() && path_is_reparse(&self.path) {
            return Err(EditorDraftError::recovery_required());
        }
        let bytes = serde_json::to_vec(envelope).map_err(|_| EditorDraftError::invalid_input())?;
        if bytes.len() > self.limits.store_bytes {
            return Err(EditorDraftError::capacity_exceeded());
        }
        crate::accounts::atomic_replace(&self.path, &bytes)
            .map_err(|_| EditorDraftError::persistence_outcome_unknown())?;
        restrict_permissions(&self.path)
            .map_err(|_| EditorDraftError::persistence_outcome_unknown())?;
        let committed = self.read_envelope()?;
        if &committed != envelope {
            return Err(EditorDraftError::persistence_outcome_unknown());
        }
        Ok(())
    }

    fn ensure_trusted_parent(&self) -> Result<(), EditorDraftError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(EditorDraftError::recovery_required)?;
        fs::create_dir_all(parent).map_err(|_| EditorDraftError::recovery_required())?;
        if path_is_reparse(parent)
            || !fs::metadata(parent).is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(EditorDraftError::recovery_required());
        }
        restrict_directory_permissions(parent).map_err(|_| EditorDraftError::recovery_required())
    }

    fn quarantine_and_fail<T>(&self) -> Result<T, EditorDraftError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(EditorDraftError::recovery_required)?;
        if !self.path.exists() || path_is_reparse(&self.path) || path_is_reparse(parent) {
            return Err(EditorDraftError::recovery_required());
        }
        let quarantine = parent.join(format!(
            ".editor-drafts-v1.corrupt-{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        crate::accounts::durable_rename(&self.path, &quarantine)
            .map_err(|_| EditorDraftError::recovery_required())?;
        Err(EditorDraftError::recovery_required())
    }
}

fn store() -> &'static EditorDraftStore {
    static STORE: OnceLock<EditorDraftStore> = OnceLock::new();
    STORE.get_or_init(|| EditorDraftStore::new(crate::config_dir().join(STORE_FILE_NAME)))
}

#[tauri::command]
pub(crate) fn editor_drafts_load(scope_id: String) -> Result<EditorDraftSnapshot, String> {
    store()
        .load_scope(&scope_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn editor_draft_put(
    request: EditorDraftPutRequest,
) -> Result<EditorDraftMutationResult, String> {
    store().put(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn editor_draft_delete(
    request: EditorDraftDeleteRequest,
) -> Result<EditorDraftMutationResult, String> {
    store().delete(request).map_err(|error| error.to_string())
}

fn empty_envelope() -> Result<StoredEnvelope, EditorDraftError> {
    let records = Vec::new();
    Ok(StoredEnvelope {
        schema_version: STORE_SCHEMA_VERSION,
        store_revision: 0,
        checksum: checksum_for(STORE_SCHEMA_VERSION, 0, &records)?,
        records,
    })
}

fn checksum_for(
    schema_version: u8,
    store_revision: u64,
    records: &[EditorDraftRecord],
) -> Result<String, EditorDraftError> {
    let bytes = serde_json::to_vec(&ChecksumPayload {
        schema_version,
        store_revision,
        records,
    })
    .map_err(|_| EditorDraftError::invalid_input())?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn validate_envelope(
    envelope: &StoredEnvelope,
    limits: StoreLimits,
) -> Result<(), EditorDraftError> {
    if envelope.schema_version != STORE_SCHEMA_VERSION
        || envelope.store_revision > MAX_SAFE_REVISION
        || envelope.records.len() > limits.records
    {
        return Err(EditorDraftError::recovery_required());
    }
    let mut identities = HashSet::new();
    let mut previous: Option<(&str, &str)> = None;
    for record in &envelope.records {
        validate_record(record, limits)?;
        if record.revision > envelope.store_revision {
            return Err(EditorDraftError::recovery_required());
        }
        let identity = (record.scope_id.as_str(), record.document_id.as_str());
        if !identities.insert((record.scope_id.clone(), record.document_id.clone()))
            || previous.is_some_and(|prior| prior >= identity)
        {
            return Err(EditorDraftError::recovery_required());
        }
        previous = Some(identity);
    }
    if total_content_bytes(&envelope.records)? > limits.total_content_bytes
        || checksum_for(
            envelope.schema_version,
            envelope.store_revision,
            &envelope.records,
        )? != envelope.checksum
    {
        return Err(EditorDraftError::recovery_required());
    }
    Ok(())
}

fn validate_record(record: &EditorDraftRecord, limits: StoreLimits) -> Result<(), EditorDraftError> {
    validate_scope_id(&record.scope_id)?;
    validate_document_id(&record.document_id)?;
    validate_digest(&record.baseline_digest)?;
    validate_operation_id(&record.last_operation_id)?;
    if record.revision == 0
        || record.revision > MAX_SAFE_REVISION
        || record.content.len() > limits.content_bytes
    {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn validate_put_request(
    request: &EditorDraftPutRequest,
    limits: StoreLimits,
) -> Result<(), EditorDraftError> {
    validate_scope_id(&request.scope_id)?;
    validate_document_id(&request.document_id)?;
    validate_digest(&request.baseline_digest)?;
    validate_operation_id(&request.operation_id)?;
    if request.content.len() > limits.content_bytes
        || request
            .expected_revision
            .is_some_and(|revision| revision == 0 || revision > MAX_SAFE_REVISION)
    {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn validate_delete_request(request: &EditorDraftDeleteRequest) -> Result<(), EditorDraftError> {
    validate_scope_id(&request.scope_id)?;
    validate_document_id(&request.document_id)?;
    validate_digest(&request.baseline_digest)?;
    validate_operation_id(&request.operation_id)?;
    if request.expected_revision == 0 || request.expected_revision > MAX_SAFE_REVISION {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn validate_scope_id(value: &str) -> Result<(), EditorDraftError> {
    validate_bounded_identity(value, MAX_SCOPE_ID_BYTES)
}

fn validate_document_id(value: &str) -> Result<(), EditorDraftError> {
    validate_bounded_identity(value, MAX_DOCUMENT_ID_BYTES)
}

fn validate_bounded_identity(value: &str, max_bytes: usize) -> Result<(), EditorDraftError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(|character| character.is_control())
    {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), EditorDraftError> {
    if value.is_empty()
        || value.len() > MAX_OPERATION_ID_BYTES
        || !value.is_ascii()
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), EditorDraftError> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err(EditorDraftError::invalid_input());
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(EditorDraftError::invalid_input());
    }
    Ok(())
}

fn next_revision(current: u64) -> Result<u64, EditorDraftError> {
    if current >= MAX_SAFE_REVISION {
        return Err(EditorDraftError::capacity_exceeded());
    }
    Ok(current + 1)
}

fn record_index(
    records: &[EditorDraftRecord],
    scope_id: &str,
    document_id: &str,
) -> Option<usize> {
    records
        .iter()
        .position(|record| record.scope_id == scope_id && record.document_id == document_id)
}

fn canonicalize(records: &mut [EditorDraftRecord]) {
    records.sort_by(|left, right| {
        (&left.scope_id, &left.document_id).cmp(&(&right.scope_id, &right.document_id))
    });
}

fn total_content_bytes(records: &[EditorDraftRecord]) -> Result<usize, EditorDraftError> {
    records.iter().try_fold(0usize, |total, record| {
        total
            .checked_add(record.content.len())
            .ok_or_else(EditorDraftError::capacity_exceeded)
    })
}

fn path_is_reparse(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata_is_reparse(&metadata))
}

fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> (PathBuf, EditorDraftStore) {
        let directory = std::env::temp_dir().join(format!(
            "prime-studio-editor-drafts-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(STORE_FILE_NAME);
        (directory, EditorDraftStore::new(path))
    }

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn put_request(
        scope_id: &str,
        document_id: &str,
        expected_revision: Option<u64>,
        operation_id: &str,
        content: &str,
    ) -> EditorDraftPutRequest {
        EditorDraftPutRequest {
            scope_id: scope_id.to_owned(),
            document_id: document_id.to_owned(),
            baseline_digest: digest('a'),
            expected_revision,
            operation_id: operation_id.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn round_trip_survives_an_independent_store_instance() {
        let (directory, store) = temp_store("round-trip");
        let stored = store
            .put(put_request(
                "scope-a",
                "document-a",
                None,
                "put-1",
                "private draft",
            ))
            .unwrap();
        assert_eq!(stored.record_revision, Some(1));

        let restarted = EditorDraftStore::new(directory.join(STORE_FILE_NAME));
        let snapshot = restarted.load_scope("scope-a").unwrap();
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.records[0].content, "private draft");
        assert_eq!(snapshot.records[0].revision, 1);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn scope_and_document_identities_never_cross() {
        let (directory, store) = temp_store("identity");
        store
            .put(put_request("scope-a", "document-a", None, "put-a", "a"))
            .unwrap();
        store
            .put(put_request("scope-a", "document-b", None, "put-b", "b"))
            .unwrap();
        store
            .put(put_request("scope-b", "document-a", None, "put-c", "c"))
            .unwrap();
        let a = store.load_scope("scope-a").unwrap();
        assert_eq!(a.records.len(), 2);
        assert!(a
            .records
            .iter()
            .all(|record| record.scope_id == "scope-a"));
        let b = store.load_scope("scope-b").unwrap();
        assert_eq!(b.records.len(), 1);
        assert_eq!(b.records[0].content, "c");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn stale_writes_and_deletes_cannot_erase_a_successor() {
        let (directory, store) = temp_store("cas");
        let first = store
            .put(put_request("scope", "document", None, "put-1", "one"))
            .unwrap();
        let second = store
            .put(put_request(
                "scope",
                "document",
                first.record_revision,
                "put-2",
                "two",
            ))
            .unwrap();
        assert_eq!(
            store.put(put_request(
                "scope",
                "document",
                first.record_revision,
                "stale-put",
                "stale",
            )),
            Err(EditorDraftError::revision_conflict())
        );
        assert_eq!(
            store.delete(EditorDraftDeleteRequest {
                scope_id: "scope".to_owned(),
                document_id: "document".to_owned(),
                baseline_digest: digest('a'),
                expected_revision: first.record_revision.unwrap(),
                operation_id: "stale-delete".to_owned(),
            }),
            Err(EditorDraftError::revision_conflict())
        );
        assert_eq!(
            store.load_scope("scope").unwrap().records[0].content,
            "two"
        );
        assert_eq!(second.record_revision, Some(2));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn put_and_delete_replays_are_idempotent() {
        let (directory, store) = temp_store("replay");
        let request = put_request("scope", "document", None, "put-1", "one");
        let first = store.put(request).unwrap();
        let replay = store
            .put(put_request(
                "scope",
                "document",
                first.record_revision,
                "put-1",
                "one",
            ))
            .unwrap();
        assert_eq!(replay.status, EditorDraftMutationStatus::Replayed);
        assert_eq!(replay.store_revision, first.store_revision);
        let deletion = EditorDraftDeleteRequest {
            scope_id: "scope".to_owned(),
            document_id: "document".to_owned(),
            baseline_digest: digest('a'),
            expected_revision: first.record_revision.unwrap(),
            operation_id: "delete-1".to_owned(),
        };
        assert_eq!(
            store.delete(deletion.clone()).unwrap().status,
            EditorDraftMutationStatus::Deleted
        );
        assert_eq!(
            store.delete(deletion).unwrap().status,
            EditorDraftMutationStatus::Absent
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn eviction_is_deterministic_by_revision_then_identity() {
        let directory = std::env::temp_dir().join(format!(
            "prime-studio-editor-drafts-eviction-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        let store = EditorDraftStore::with_limits(
            directory.join(STORE_FILE_NAME),
            StoreLimits {
                records: 2,
                content_bytes: 32,
                total_content_bytes: 32,
                store_bytes: 4 * 1024,
            },
        );
        store
            .put(put_request("scope", "a", None, "put-a", "a"))
            .unwrap();
        store
            .put(put_request("scope", "b", None, "put-b", "b"))
            .unwrap();
        store
            .put(put_request("scope", "c", None, "put-c", "c"))
            .unwrap();
        let snapshot = store.load_scope("scope").unwrap();
        assert_eq!(
            snapshot
                .records
                .iter()
                .map(|record| record.document_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn oversize_rejection_preserves_the_previous_record() {
        let directory = std::env::temp_dir().join(format!(
            "prime-studio-editor-drafts-oversize-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        let store = EditorDraftStore::with_limits(
            directory.join(STORE_FILE_NAME),
            StoreLimits {
                records: 4,
                content_bytes: 4,
                total_content_bytes: 8,
                store_bytes: 4 * 1024,
            },
        );
        let first = store
            .put(put_request("scope", "document", None, "put-1", "safe"))
            .unwrap();
        assert_eq!(
            store.put(put_request(
                "scope",
                "document",
                first.record_revision,
                "put-2",
                "too large",
            )),
            Err(EditorDraftError::invalid_input())
        );
        assert_eq!(
            store.load_scope("scope").unwrap().records[0].content,
            "safe"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn corrupt_or_unsupported_store_is_quarantined_and_reported() {
        let (directory, store) = temp_store("corrupt");
        fs::write(directory.join(STORE_FILE_NAME), b"not-json").unwrap();
        assert_eq!(
            store.load_scope("scope"),
            Err(EditorDraftError::recovery_required())
        );
        assert!(!directory.join(STORE_FILE_NAME).exists());
        assert!(fs::read_dir(&directory).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".editor-drafts-v1.corrupt-")
        }));
        assert!(store.load_scope("scope").unwrap().records.is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn reparse_parent_is_rejected_without_following_it() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "prime-studio-editor-drafts-link-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let target = root.join("target");
        let link = root.join("link");
        fs::create_dir_all(&target).unwrap();
        symlink(&target, &link).unwrap();
        let store = EditorDraftStore::new(link.join(STORE_FILE_NAME));
        assert_eq!(
            store.load_scope("scope"),
            Err(EditorDraftError::recovery_required())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_errors_are_bounded_codes_without_content_or_paths() {
        let error = EditorDraftError::revision_conflict().to_string();
        assert_eq!(error, "revisionConflict");
        assert!(error.len() < 64);
        assert!(!error.contains('/') && !error.contains('\\'));
    }
}
