use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::accounts::delete::{path_snapshot_no_follow, FileIdentity};

const MAX_ARTIFACT_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIFF_ROWS: usize = 10_000;
const MAX_DIFF_LINE_CHARS: usize = 4_096;
const DIFF_CONTEXT_LINES: usize = 3;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRef {
    broker_id: String,
    root_session_id: String,
    artifact_id: String,
    revision: u64,
}

impl ArtifactRef {
    pub fn new(
        broker_id: impl Into<String>,
        root_session_id: impl Into<String>,
        artifact_id: impl Into<String>,
        revision: u64,
    ) -> Self {
        Self {
            broker_id: broker_id.into(),
            root_session_id: root_session_id.into(),
            artifact_id: artifact_id.into(),
            revision,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactOpenRequest {
    artifact_ref: ArtifactRef,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDiffRow {
    kind: &'static str,
    old_line: Option<u32>,
    new_line: Option<u32>,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDocument {
    label: String,
    #[serde(rename = "ref")]
    artifact_ref: ArtifactRef,
    identity: String,
    content: String,
    writable: bool,
    diff: Vec<StructuredDiffRow>,
    diff_truncated: bool,
}

impl ArtifactDocument {
    pub fn content(&self) -> &str {
        &self.content
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    pub fn artifact_ref(&self) -> &ArtifactRef {
        &self.artifact_ref
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactOpenResult {
    Opened { document: ArtifactDocument },
    Unsupported { reason: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactSaveRequest {
    #[serde(rename = "ref")]
    artifact_ref: ArtifactRef,
    expected_identity: String,
    expected_revision: u64,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactSaveCopyRequest {
    #[serde(rename = "ref")]
    artifact_ref: ArtifactRef,
    content: String,
}

impl ArtifactSaveRequest {
    pub fn new(
        artifact_ref: ArtifactRef,
        expected_identity: String,
        expected_revision: u64,
        content: String,
    ) -> Self {
        Self {
            artifact_ref,
            expected_identity,
            expected_revision,
            content,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactSaveResult {
    Saved { revision: u64, identity: String },
    Conflict { message: String },
    Unsupported { message: String },
    Error { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactSaveCopyResult {
    SavedCopy { label: String },
    Cancelled,
    Unsupported { message: String },
    Error { message: String },
}

#[derive(Clone, Debug)]
pub struct ArtifactAdmission {
    broker_id: String,
    root_session_id: String,
    artifact_id: String,
    root: PathBuf,
    path: PathBuf,
    writable: bool,
}

impl ArtifactAdmission {
    pub fn new(
        broker_id: impl Into<String>,
        root_session_id: impl Into<String>,
        artifact_id: impl Into<String>,
        root: impl Into<PathBuf>,
        path: impl Into<PathBuf>,
        writable: bool,
    ) -> Self {
        Self {
            broker_id: broker_id.into(),
            root_session_id: root_session_id.into(),
            artifact_id: artifact_id.into(),
            root: root.into(),
            path: path.into(),
            writable,
        }
    }
}

#[derive(Clone)]
struct Binding {
    root: PathBuf,
    path: PathBuf,
    writable: bool,
    revision: u64,
    stamp: FileIdentity,
    identity: String,
    baseline: String,
}

#[derive(Default)]
pub struct ArtifactAuthority {
    bindings: Mutex<HashMap<(String, String, String), Binding>>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn exact_file_identity(path: &Path) -> Result<FileIdentity, String> {
    let snapshot = path_snapshot_no_follow(path)
        .map_err(|_| "artifact file identity is unavailable".to_owned())?
        .ok_or_else(|| "artifact file identity is unavailable".to_owned())?;
    if snapshot.reparse_point || snapshot.directory || snapshot.hard_links != 1 {
        return Err("artifact requires one regular no-follow file identity".to_owned());
    }
    Ok(snapshot.identity)
}

fn read_text(root: &Path, path: &Path) -> Result<(String, String, FileIdentity), String> {
    let before = exact_file_identity(path)?;
    let bounded = crate::bounded_io::read_bounded_under(root, path, MAX_ARTIFACT_BYTES)?;
    let after = exact_file_identity(path)?;
    if before != after {
        return Err("artifact file identity changed while it was opened".to_owned());
    }
    if bounded.bytes.contains(&0) {
        return Err("binary artifacts are not editable".to_owned());
    }
    let identity = digest(&bounded.bytes);
    let content =
        String::from_utf8(bounded.bytes).map_err(|_| "artifact is not valid UTF-8".to_owned())?;
    Ok((content, identity, after))
}

fn diff_text(line: &str) -> String {
    let mut text: String = line.chars().take(MAX_DIFF_LINE_CHARS).collect();
    if line.chars().count() > MAX_DIFF_LINE_CHARS {
        text.push('…');
    }
    text
}

fn structured_diff(before: &str, after: &str) -> (Vec<StructuredDiffRow>, bool) {
    if before == after {
        return (Vec::new(), false);
    }
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let mut prefix = 0usize;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < old.len().saturating_sub(prefix)
        && suffix < new.len().saturating_sub(prefix)
        && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let old_change_end = old.len().saturating_sub(suffix);
    let new_change_end = new.len().saturating_sub(suffix);
    let context_start = prefix.saturating_sub(DIFF_CONTEXT_LINES);
    let suffix_count = suffix.min(DIFF_CONTEXT_LINES);
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut push = |row: StructuredDiffRow| {
        if rows.len() < MAX_DIFF_ROWS {
            rows.push(row);
        } else {
            truncated = true;
        }
    };
    for (index, line) in old.iter().enumerate().take(prefix).skip(context_start) {
        push(StructuredDiffRow {
            kind: "context",
            old_line: Some(index as u32 + 1),
            new_line: Some(index as u32 + 1),
            text: diff_text(line),
        });
    }
    for (index, line) in old.iter().enumerate().take(old_change_end).skip(prefix) {
        push(StructuredDiffRow {
            kind: "delete",
            old_line: Some(index as u32 + 1),
            new_line: None,
            text: diff_text(line),
        });
    }
    for (index, line) in new.iter().enumerate().take(new_change_end).skip(prefix) {
        push(StructuredDiffRow {
            kind: "add",
            old_line: None,
            new_line: Some(index as u32 + 1),
            text: diff_text(line),
        });
    }
    for offset in 0..suffix_count {
        let old_index = old_change_end + offset;
        let new_index = new_change_end + offset;
        push(StructuredDiffRow {
            kind: "context",
            old_line: Some(old_index as u32 + 1),
            new_line: Some(new_index as u32 + 1),
            text: diff_text(old[old_index]),
        });
    }
    (rows, truncated)
}

fn artifact_document(binding: &Binding, artifact_ref: &ArtifactRef, content: String, identity: String) -> ArtifactDocument {
    let (diff, diff_truncated) = structured_diff(&binding.baseline, &content);
    ArtifactDocument {
        label: binding
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Artifact")
            .to_owned(),
        artifact_ref: artifact_ref.clone(),
        identity,
        content,
        writable: binding.writable,
        diff,
        diff_truncated,
    }
}

impl ArtifactAuthority {
    pub fn admit_harness_artifact(
        &self,
        admission: ArtifactAdmission,
    ) -> Result<ArtifactRef, String> {
        if !valid_id(&admission.broker_id)
            || !valid_id(&admission.root_session_id)
            || !valid_id(&admission.artifact_id)
        {
            return Err("artifact admission identity is invalid".to_owned());
        }
        let root = admission
            .root
            .canonicalize()
            .map_err(|_| "artifact root is unavailable".to_owned())?;
        let path = admission
            .path
            .canonicalize()
            .map_err(|_| "artifact path is unavailable".to_owned())?;
        if !path.starts_with(&root) {
            return Err("artifact is outside its admitted root".to_owned());
        }
        let (baseline, identity, stamp) = read_text(&root, &path)?;
        let key = (
            admission.broker_id.clone(),
            admission.root_session_id.clone(),
            admission.artifact_id.clone(),
        );
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "artifact authority is unavailable".to_owned())?;
        if let Some(existing) = bindings.get(&key) {
            if existing.root != root
                || existing.path != path
                || existing.writable != admission.writable
            {
                return Err("artifact identity was reused for a different file".to_owned());
            }
            return Ok(ArtifactRef::new(
                admission.broker_id,
                admission.root_session_id,
                admission.artifact_id,
                existing.revision,
            ));
        }
        bindings.insert(
            key,
            Binding {
                root,
                path,
                writable: admission.writable,
                revision: 1,
                stamp,
                identity,
                baseline,
            },
        );
        Ok(ArtifactRef::new(
            admission.broker_id,
            admission.root_session_id,
            admission.artifact_id,
            1,
        ))
    }

    pub fn open(&self, artifact_ref: &ArtifactRef) -> ArtifactOpenResult {
        let key = (
            artifact_ref.broker_id.clone(),
            artifact_ref.root_session_id.clone(),
            artifact_ref.artifact_id.clone(),
        );
        let Ok(bindings) = self.bindings.lock() else {
            return ArtifactOpenResult::Unsupported {
                reason: "Artifact authority is unavailable.".to_owned(),
            };
        };
        let Some(binding) = bindings.get(&key) else {
            return ArtifactOpenResult::Unsupported {
                reason: "No identity-bound native or Harness artifact reference is available."
                    .to_owned(),
            };
        };
        if artifact_ref.revision != binding.revision {
            return ArtifactOpenResult::Unsupported {
                reason: "The artifact reference revision is stale.".to_owned(),
            };
        }
        let Ok((content, identity, stamp)) = read_text(&binding.root, &binding.path) else {
            return ArtifactOpenResult::Unsupported {
                reason: "The admitted artifact can no longer be opened safely.".to_owned(),
            };
        };
        if identity != binding.identity || stamp != binding.stamp {
            return ArtifactOpenResult::Unsupported {
                reason: "The admitted artifact identity changed.".to_owned(),
            };
        }
        ArtifactOpenResult::Opened { document: artifact_document(binding, artifact_ref, content, identity) }
    }

    pub fn reload(&self, artifact_ref: &ArtifactRef) -> ArtifactOpenResult {
        let key = (
            artifact_ref.broker_id.clone(),
            artifact_ref.root_session_id.clone(),
            artifact_ref.artifact_id.clone(),
        );
        let Ok(mut bindings) = self.bindings.lock() else {
            return ArtifactOpenResult::Unsupported { reason: "Artifact authority is unavailable.".to_owned() };
        };
        let Some(binding) = bindings.get_mut(&key) else {
            return ArtifactOpenResult::Unsupported { reason: "No identity-bound native or Harness artifact reference is available.".to_owned() };
        };
        if artifact_ref.revision != binding.revision {
            return ArtifactOpenResult::Unsupported { reason: "The artifact reference revision is stale.".to_owned() };
        }
        let Ok((content, identity, stamp)) = read_text(&binding.root, &binding.path) else {
            return ArtifactOpenResult::Unsupported { reason: "The admitted artifact can no longer be reloaded safely.".to_owned() };
        };
        if identity != binding.identity || stamp != binding.stamp {
            let Some(revision) = binding.revision.checked_add(1) else {
                return ArtifactOpenResult::Unsupported { reason: "Artifact revision overflowed.".to_owned() };
            };
            binding.revision = revision;
            binding.identity = identity.clone();
            binding.stamp = stamp;
        }
        let rebound = ArtifactRef::new(
            artifact_ref.broker_id.clone(),
            artifact_ref.root_session_id.clone(),
            artifact_ref.artifact_id.clone(),
            binding.revision,
        );
        ArtifactOpenResult::Opened { document: artifact_document(binding, &rebound, content, identity) }
    }

    pub fn suggested_copy_name(&self, artifact_ref: &ArtifactRef) -> Result<String, String> {
        let key = (
            artifact_ref.broker_id.clone(),
            artifact_ref.root_session_id.clone(),
            artifact_ref.artifact_id.clone(),
        );
        let bindings = self.bindings.lock().map_err(|_| "Artifact authority is unavailable.".to_owned())?;
        let binding = bindings.get(&key).ok_or_else(|| "No identity-bound artifact reference is available for saving a copy.".to_owned())?;
        if artifact_ref.revision != binding.revision {
            return Err("The artifact reference revision is stale.".to_owned());
        }
        let stem = binding.path.file_stem().and_then(|value| value.to_str()).unwrap_or("artifact");
        let extension = binding.path.extension().and_then(|value| value.to_str());
        Ok(match extension {
            Some(extension) => format!("{stem}.prime-copy.{extension}"),
            None => format!("{stem}.prime-copy"),
        })
    }

    pub fn save_copy_at(&self, artifact_ref: &ArtifactRef, content: &str, destination: &Path) -> ArtifactSaveCopyResult {
        if content.len() > MAX_ARTIFACT_BYTES || content.contains('\0') {
            return ArtifactSaveCopyResult::Error { message: "Artifact content exceeds the safe editable boundary.".to_owned() };
        }
        if self.suggested_copy_name(artifact_ref).is_err() {
            return ArtifactSaveCopyResult::Unsupported { message: "No identity-bound artifact reference is available for saving a copy.".to_owned() };
        }
        let Some(parent) = destination.parent() else {
            return ArtifactSaveCopyResult::Error { message: "The selected copy destination has no parent.".to_owned() };
        };
        let Ok(parent_metadata) = fs::symlink_metadata(parent) else {
            return ArtifactSaveCopyResult::Error { message: "The selected copy destination is unavailable.".to_owned() };
        };
        if !parent_metadata.is_dir() || crate::accounts::delete::is_reparse(&parent_metadata) {
            return ArtifactSaveCopyResult::Error { message: "The selected copy destination crosses a link or reparse boundary.".to_owned() };
        }
        if let Ok(metadata) = fs::symlink_metadata(destination) {
            if !metadata.is_file() || crate::accounts::delete::is_reparse(&metadata) {
                return ArtifactSaveCopyResult::Error { message: "The selected copy destination is not a regular file.".to_owned() };
            }
            if path_snapshot_no_follow(destination).ok().flatten().is_some_and(|snapshot| snapshot.hard_links != 1) {
                return ArtifactSaveCopyResult::Error { message: "The selected copy destination has a shared file identity.".to_owned() };
            }
        }
        if crate::accounts::atomic_replace(destination, content.as_bytes()).is_err() {
            return ArtifactSaveCopyResult::Error { message: "The artifact copy could not be saved atomically.".to_owned() };
        }
        ArtifactSaveCopyResult::SavedCopy {
            label: destination.file_name().and_then(|value| value.to_str()).unwrap_or("artifact copy").to_owned(),
        }
    }

    pub fn save(&self, request: ArtifactSaveRequest) -> ArtifactSaveResult {
        if request.content.len() > MAX_ARTIFACT_BYTES || request.content.contains('\0') {
            return ArtifactSaveResult::Error {
                message: "Artifact content exceeds the safe editable boundary.".to_owned(),
            };
        }
        let key = (
            request.artifact_ref.broker_id.clone(),
            request.artifact_ref.root_session_id.clone(),
            request.artifact_ref.artifact_id.clone(),
        );
        let Ok(mut bindings) = self.bindings.lock() else {
            return ArtifactSaveResult::Error {
                message: "Artifact authority is unavailable.".to_owned(),
            };
        };
        let Some(binding) = bindings.get_mut(&key) else {
            return ArtifactSaveResult::Unsupported {
                message: "No identity-bound artifact reference is available for saving.".to_owned(),
            };
        };
        if !binding.writable {
            return ArtifactSaveResult::Unsupported {
                message: "This artifact has no verified write authority.".to_owned(),
            };
        }
        if request.artifact_ref.revision != binding.revision
            || request.expected_revision != binding.revision
            || request.expected_identity != binding.identity
        {
            return ArtifactSaveResult::Conflict {
                message: "The artifact revision or identity changed. Reopen it before saving."
                    .to_owned(),
            };
        }
        let Ok((_, current_identity, current_stamp)) = read_text(&binding.root, &binding.path)
        else {
            return ArtifactSaveResult::Conflict {
                message: "The artifact can no longer be reopened safely.".to_owned(),
            };
        };
        if current_identity != binding.identity || current_stamp != binding.stamp {
            return ArtifactSaveResult::Conflict {
                message: "The file changed on disk. Reopen it before saving.".to_owned(),
            };
        }
        if crate::accounts::atomic_replace(&binding.path, request.content.as_bytes()).is_err() {
            return ArtifactSaveResult::Error {
                message: "The atomic artifact save failed.".to_owned(),
            };
        }
        let Ok((saved_content, identity, stamp)) = read_text(&binding.root, &binding.path) else {
            return ArtifactSaveResult::Error {
                message: "The saved artifact outcome is unknown.".to_owned(),
            };
        };
        if saved_content != request.content {
            return ArtifactSaveResult::Error {
                message: "The saved artifact outcome is unknown.".to_owned(),
            };
        }
        let Some(revision) = binding.revision.checked_add(1) else {
            return ArtifactSaveResult::Error {
                message: "Artifact revision overflowed.".to_owned(),
            };
        };
        binding.revision = revision;
        binding.identity = identity.clone();
        binding.stamp = stamp;
        ArtifactSaveResult::Saved { revision, identity }
    }
}

#[tauri::command]
pub(crate) fn editor_artifact_open(
    state: State<'_, crate::AppState>,
    request: ArtifactOpenRequest,
) -> ArtifactOpenResult {
    state.artifacts.open(&request.artifact_ref)
}

#[tauri::command]
pub(crate) fn editor_artifact_reload(
    state: State<'_, crate::AppState>,
    request: ArtifactOpenRequest,
) -> ArtifactOpenResult {
    state.artifacts.reload(&request.artifact_ref)
}

#[tauri::command]
pub(crate) fn editor_artifact_save(
    state: State<'_, crate::AppState>,
    request: ArtifactSaveRequest,
) -> ArtifactSaveResult {
    state.artifacts.save(request)
}

#[tauri::command]
pub(crate) async fn editor_artifact_save_copy(
    app: AppHandle,
    request: ArtifactSaveCopyRequest,
) -> Result<ArtifactSaveCopyResult, String> {
    let suggested = match app.state::<crate::AppState>().artifacts.suggested_copy_name(&request.artifact_ref) {
        Ok(value) => value,
        Err(message) => return Ok(ArtifactSaveCopyResult::Unsupported { message }),
    };
    if request.content.len() > MAX_ARTIFACT_BYTES || request.content.contains('\0') {
        return Ok(ArtifactSaveCopyResult::Error { message: "Artifact content exceeds the safe editable boundary.".to_owned() });
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog().file().set_file_name(suggested).save_file(move |path| {
        let _ = sender.send(path);
    });
    let Ok(selected) = receiver.recv() else {
        return Ok(ArtifactSaveCopyResult::Error { message: "The artifact copy dialog failed.".to_owned() });
    };
    let Some(destination) = selected.and_then(|path| path.into_path().ok()) else {
        return Ok(ArtifactSaveCopyResult::Cancelled);
    };
    Ok(app.state::<crate::AppState>().artifacts.save_copy_at(&request.artifact_ref, &request.content, &destination))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("prime-studio-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn admission_never_allows_a_candidate_outside_its_authoritative_root() {
        let root = temp_root("artifact-root");
        let outside = temp_root("artifact-outside").join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        let authority = ArtifactAuthority::default();
        let result = authority.admit_harness_artifact(ArtifactAdmission::new(
            "broker",
            "session",
            "candidate",
            &root,
            &outside,
            true,
        ));
        assert_eq!(result.unwrap_err(), "artifact is outside its admitted root");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn stale_disk_identity_cannot_be_opened_or_saved() {
        let root = temp_root("artifact-stale");
        let path = root.join("report.md");
        std::fs::write(&path, "one").unwrap();
        let authority = ArtifactAuthority::default();
        let artifact_ref = authority
            .admit_harness_artifact(ArtifactAdmission::new(
                "broker",
                "session",
                "candidate",
                &root,
                &path,
                true,
            ))
            .unwrap();
        let ArtifactOpenResult::Opened { document } = authority.open(&artifact_ref) else {
            panic!("expected admitted document")
        };
        std::fs::write(&path, "external change").unwrap();
        assert!(matches!(
            authority.open(&artifact_ref),
            ArtifactOpenResult::Unsupported { .. }
        ));
        assert!(matches!(
            authority.save(ArtifactSaveRequest::new(
                artifact_ref,
                document.identity().to_owned(),
                1,
                "two".to_owned()
            )),
            ArtifactSaveResult::Conflict { .. }
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
