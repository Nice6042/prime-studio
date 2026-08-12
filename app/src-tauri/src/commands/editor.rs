use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::accounts::delete::{path_snapshot_no_follow, FileIdentity};

const MAX_ARTIFACT_BYTES: usize = 2 * 1024 * 1024;

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
        let (_, identity, stamp) = read_text(&root, &path)?;
        let key = (
            admission.broker_id.clone(),
            admission.root_session_id.clone(),
            admission.artifact_id.clone(),
        );
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "artifact authority is unavailable".to_owned())?;
        if bindings.contains_key(&key) {
            return Err("artifact identity is already admitted".to_owned());
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
        ArtifactOpenResult::Opened {
            document: ArtifactDocument {
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
                diff: Vec::new(),
            },
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
pub(crate) fn editor_artifact_save(
    state: State<'_, crate::AppState>,
    request: ArtifactSaveRequest,
) -> ArtifactSaveResult {
    state.artifacts.save(request)
}
