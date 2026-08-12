use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

use crate::commands::editor::{ArtifactAdmission, ArtifactOpenResult};
use crate::harness::activation::canonical_workspace_identity;
use crate::harness::broker::{
    AttachRequest, InspectorRequest, RefreshSessionRequest, ResidentBranchRequest,
    ResidentCreateRequest, SessionCommandRequest, StudioOperationRequest, WorkerRetryRequest,
};
use crate::harness::generated::{
    CommandOutcome, HarnessCursor, HarnessStudioAction, ParentMessage, SessionCommandKind,
    StudioOperationStatus, WorkerRetryOutcome,
};
use crate::harness::projections::{BootProjection, RootSessionProjection};
use crate::project_catalog::{
    BindPrimeSessionCommand, CatalogSnapshot, ChatCreateCommand, PrimeChatBinding,
    PrimeChatBindingKind, ProjectChatCommand, ProjectKind, ProjectRootKind,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) fn harness_bootstrap(state: State<'_, crate::AppState>) -> BootProjection {
    state
        .harness
        .wait_bootstrap_projection(Duration::from_secs(6))
}

#[tauri::command]
pub(crate) fn harness_projection(state: State<'_, crate::AppState>) -> Vec<RootSessionProjection> {
    state.harness.session_projections()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessAttachInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessSessionCommandInput {
    session_id: String,
    command_id: String,
    expected_cursor: HarnessCursor,
    kind: SessionCommandKind,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessWorkerRetryInput {
    session_id: String,
    observation_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessInspectorInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessArtifactOpenInput {
    session_id: String,
    candidate_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessRefreshSessionInput {
    session_id: String,
    known_cursor: HarnessCursor,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessStudioOperationInput {
    session_id: String,
    operation_id: String,
    action: HarnessStudioAction,
    payload_json: String,
    expected_cursor: Option<HarnessCursor>,
    idempotency_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessStudioOperationOutput {
    operation_id: String,
    status: StudioOperationStatus,
    command_id: Option<String>,
    position: Option<u64>,
    revision: Option<String>,
    reason: Option<String>,
    retryable: Option<bool>,
    session: Option<RootSessionProjection>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessCreateResidentChatInput {
    expected_revision: u64,
    project_id: String,
    chat_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessCreateResidentChatOutput {
    catalog: CatalogSnapshot,
    session: RootSessionProjection,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HarnessBranchResidentChatInput {
    expected_revision: u64,
    project_id: String,
    source_chat_id: String,
    source_session_id: String,
    message_id: String,
    expected_cursor: HarnessCursor,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessBranchResidentChatOutput {
    branch_chat_id: String,
    catalog: CatalogSnapshot,
    session: RootSessionProjection,
}

fn daemon_project_id(cwd: &str) -> String {
    let lowered = cwd.to_lowercase();
    let digest = format!("{:x}", Sha256::digest(lowered.as_bytes()));
    format!("project-{}", &digest[..24])
}

fn session_file_metadata(daemon_chat_id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(daemon_chat_id.as_bytes()));
    format!("{}.jsonl", &digest[..24])
}

fn branch_chat_id(project_id: &str, source_chat_id: &str, message_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(project_id.as_bytes());
    digest.update([0]);
    digest.update(source_chat_id.as_bytes());
    digest.update([0]);
    digest.update(message_id.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    format!("chat-branch-{}", &digest[..24])
}

fn branch_title(source: &str) -> String {
    format!("Branch of {source}").chars().take(200).collect()
}

fn canonical_workspace(path: &Path) -> Result<String, String> {
    canonical_workspace_identity(path).map_err(|_| "Harness workspace is unavailable".to_owned())
}

fn project_workspace(project: &crate::project_catalog::Project) -> Result<String, String> {
    match (
        project.kind,
        project.root.kind,
        project.root.path.as_deref(),
    ) {
        (ProjectKind::Folder, ProjectRootKind::Folder, Some(path)) => {
            let canonical = canonical_workspace(Path::new(path))?;
            if Path::new(&canonical) != Path::new(path) {
                return Err("Harness workspace identity changed".to_owned());
            }
            Ok(canonical)
        }
        (ProjectKind::Personal, ProjectRootKind::StudioManagedEmpty, None) => {
            let workspace: PathBuf = crate::config_dir().join("personal-workspace");
            std::fs::create_dir_all(&workspace)
                .map_err(|_| "Personal Harness workspace is unavailable".to_owned())?;
            canonical_workspace(&workspace)
        }
        _ => Err("Catalog project workspace is invalid".to_owned()),
    }
}

#[tauri::command]
pub(crate) async fn harness_create_resident_chat(
    state: State<'_, crate::AppState>,
    request: HarnessCreateResidentChatInput,
) -> Result<HarnessCreateResidentChatOutput, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    let catalog = state.project_catalog.clone();
    let transaction = state.harness.resident_transaction();
    tauri::async_runtime::spawn_blocking(move || {
        let _transaction = transaction
            .lock()
            .map_err(|_| "Harness resident transaction is unavailable".to_owned())?;
        let current = catalog.load().map_err(|error| error.to_string())?;
        let project = current
            .state
            .projects
            .iter()
            .find(|project| project.id == request.project_id && !project.archived)
            .ok_or_else(|| "Catalog project is unavailable".to_owned())?;
        let chat = project
            .chats
            .iter()
            .find(|chat| chat.id == request.chat_id && !chat.archived)
            .ok_or_else(|| "Catalog chat is unavailable".to_owned())?;
        if chat.project_id != project.id {
            return Err("Catalog chat ownership is invalid".to_owned());
        }
        if chat.binding.is_none() && current.revision != request.expected_revision {
            return Err("revisionConflict".to_owned());
        }
        let cwd = project_workspace(project)?;
        let expected_project_id = daemon_project_id(&cwd);
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let created = tauri::async_runtime::block_on(
            broker.create_resident(ResidentCreateRequest {
                creation_id: chat.id.clone(),
                name: format!("Prime Studio chat {}", chat.id),
                cwd,
                expected_account_id: chat
                    .binding
                    .as_ref()
                    .and_then(|binding| binding.account_id.clone()),
                expected_project_id,
            }),
        )
        .map_err(|error| format!("Harness resident creation failed: {}", error.code()))?;
        let binding = PrimeChatBinding {
            kind: PrimeChatBindingKind::PrimeSession,
            account_id: created.session.account_id.clone(),
            session_id: created.session.session_id.clone(),
            session_file: session_file_metadata(&created.session.chat_id),
            agent_id: Some(created.session.chat_id.clone()),
        };
        if let Some(existing) = &chat.binding {
            if existing != &binding {
                return Err("Catalog chat is bound to a different Harness session".to_owned());
            }
            return Ok(HarnessCreateResidentChatOutput {
                catalog: current,
                session: created.session,
            });
        }
        let catalog = catalog
            .apply(
                current.revision,
                ProjectChatCommand::BindPrimeSession(BindPrimeSessionCommand {
                    project_id: project.id.clone(),
                    chat_id: chat.id.clone(),
                    binding,
                }),
            )
            .map_err(|error| error.to_string())?;
        Ok(HarnessCreateResidentChatOutput {
            catalog,
            session: created.session,
        })
    })
    .await
    .map_err(|_| "Harness resident transaction task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn harness_branch_resident_chat(
    state: State<'_, crate::AppState>,
    request: HarnessBranchResidentChatInput,
) -> Result<HarnessBranchResidentChatOutput, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    let catalog = state.project_catalog.clone();
    let transaction = state.harness.resident_transaction();
    tauri::async_runtime::spawn_blocking(move || {
        let _transaction = transaction
            .lock()
            .map_err(|_| "Harness resident transaction is unavailable".to_owned())?;
        let current = catalog.load().map_err(|error| error.to_string())?;
        let project = current
            .state
            .projects
            .iter()
            .find(|project| project.id == request.project_id && !project.archived)
            .ok_or_else(|| "Catalog project is unavailable".to_owned())?;
        let source = project
            .chats
            .iter()
            .find(|chat| chat.id == request.source_chat_id && !chat.archived)
            .ok_or_else(|| "Source catalog chat is unavailable".to_owned())?;
        let source_binding = source
            .binding
            .as_ref()
            .filter(|binding| binding.session_id == request.source_session_id)
            .ok_or_else(|| "Source Harness binding changed".to_owned())?;
        let branch_chat_id = branch_chat_id(&project.id, &source.id, &request.message_id);
        if let Some(existing) = project.chats.iter().find(|chat| chat.id == branch_chat_id) {
            if existing.archived {
                return Err("Catalog branch chat is archived".to_owned());
            }
            if let Some(binding) = &existing.binding {
                let broker = broker
                    .lock()
                    .map_err(|_| "Harness broker is unavailable".to_owned())?;
                let session = broker
                    .project(&binding.session_id)
                    .ok_or_else(|| "Catalog branch Harness session is unavailable".to_owned())?;
                if binding.account_id != session.account_id
                    || binding.agent_id.as_deref() != Some(session.chat_id.as_str())
                    || binding.session_id == source_binding.session_id
                    || session.account_id != source_binding.account_id
                    || session.project_id != daemon_project_id(&project_workspace(project)?)
                    || !session.parent_messages.iter().any(|message| match message {
                        ParentMessage::User { id, .. }
                        | ParentMessage::Assistant { id, .. }
                        | ParentMessage::Notice { id, .. } => id == &request.message_id,
                    })
                    || branch_chat_id == session.session_id
                    || branch_chat_id == session.chat_id
                {
                    return Err("Catalog branch binding identity is invalid".to_owned());
                }
                return Ok(HarnessBranchResidentChatOutput {
                    branch_chat_id,
                    catalog: current,
                    session,
                });
            }
        } else if current.revision != request.expected_revision {
            return Err("revisionConflict".to_owned());
        }
        let source_title = source.title.clone();
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let branched =
            tauri::async_runtime::block_on(broker.branch_resident(ResidentBranchRequest {
                creation_id: branch_chat_id.clone(),
                source_session_id: request.source_session_id,
                entry_id: request.message_id,
                name: branch_title(&source_title),
                expected_cursor: request.expected_cursor,
            }))
            .map_err(|error| format!("Harness resident branch failed: {}", error.code()))?;
        if branched.session.account_id != source_binding.account_id
            || branched.session.project_id != daemon_project_id(&project_workspace(project)?)
            || branch_chat_id == branched.session.session_id
            || branch_chat_id == branched.session.chat_id
        {
            return Err("Harness resident branch identity is invalid".to_owned());
        }
        drop(broker);

        let latest = catalog.load().map_err(|error| error.to_string())?;
        let latest_project = latest
            .state
            .projects
            .iter()
            .find(|candidate| candidate.id == project.id && !candidate.archived)
            .ok_or_else(|| "Catalog project changed during branch".to_owned())?;
        let latest_source = latest_project
            .chats
            .iter()
            .find(|chat| chat.id == source.id && !chat.archived)
            .ok_or_else(|| "Source catalog chat changed during branch".to_owned())?;
        if latest_source.binding.as_ref() != Some(source_binding) {
            return Err("Source Harness binding changed during branch".to_owned());
        }
        let latest_project_id = latest_project.id.clone();
        let branch_exists = latest_project
            .chats
            .iter()
            .any(|chat| chat.id == branch_chat_id);
        let mut persisted = latest;
        if !branch_exists {
            persisted = catalog
                .apply(
                    persisted.revision,
                    ProjectChatCommand::ChatCreate(ChatCreateCommand {
                        project_id: latest_project_id.clone(),
                        chat_id: branch_chat_id.clone(),
                        title: branch_title(&source_title),
                    }),
                )
                .map_err(|error| error.to_string())?;
        }
        let binding = PrimeChatBinding {
            kind: PrimeChatBindingKind::PrimeSession,
            account_id: branched.session.account_id.clone(),
            session_id: branched.session.session_id.clone(),
            session_file: session_file_metadata(&branched.session.chat_id),
            agent_id: Some(branched.session.chat_id.clone()),
        };
        let branch = persisted
            .state
            .projects
            .iter()
            .find(|candidate| candidate.id == latest_project_id)
            .and_then(|candidate| {
                candidate
                    .chats
                    .iter()
                    .find(|chat| chat.id == branch_chat_id)
            })
            .ok_or_else(|| "Catalog branch chat was not created".to_owned())?;
        if let Some(existing) = &branch.binding {
            if existing != &binding {
                return Err(
                    "Catalog branch chat is bound to a different Harness session".to_owned(),
                );
            }
        } else {
            persisted = catalog
                .apply(
                    persisted.revision,
                    ProjectChatCommand::BindPrimeSession(BindPrimeSessionCommand {
                        project_id: latest_project_id,
                        chat_id: branch_chat_id.clone(),
                        binding,
                    }),
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(HarnessBranchResidentChatOutput {
            branch_chat_id,
            catalog: persisted,
            session: branched.session,
        })
    })
    .await
    .map_err(|_| "Harness resident branch transaction task failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessSessionCommandOutput {
    command_id: String,
    outcome: CommandOutcome,
    session: RootSessionProjection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessWorkerRetryOutput {
    observation_id: String,
    outcome: WorkerRetryOutcome,
    session: RootSessionProjection,
}

#[tauri::command]
pub(crate) async fn harness_attach_session(
    state: State<'_, crate::AppState>,
    request: HarnessAttachInput,
) -> Result<RootSessionProjection, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        tauri::async_runtime::block_on(broker.attach(AttachRequest {
            session_id: request.session_id,
        }))
        .map_err(|error| format!("Harness attach failed: {}", error.code()))
    })
    .await
    .map_err(|_| "Harness attach task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn harness_retry_worker(
    state: State<'_, crate::AppState>,
    request: HarnessWorkerRetryInput,
) -> Result<HarnessWorkerRetryOutput, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let result = tauri::async_runtime::block_on(broker.retry_worker(WorkerRetryRequest {
            session_id: request.session_id,
            observation_id: request.observation_id,
        }))
        .map_err(|error| format!("Harness worker retry failed: {}", error.code()))?;
        Ok(HarnessWorkerRetryOutput {
            observation_id: result.observation_id,
            outcome: result.outcome,
            session: result.session,
        })
    })
    .await
    .map_err(|_| "Harness worker retry task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn harness_session_command(
    state: State<'_, crate::AppState>,
    request: HarnessSessionCommandInput,
) -> Result<HarnessSessionCommandOutput, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let command_id = request.command_id.clone();
        let result = tauri::async_runtime::block_on(broker.submit(SessionCommandRequest {
            session_id: request.session_id,
            command_id: request.command_id,
            expected_cursor: request.expected_cursor,
            kind: request.kind,
            text: request.text,
        }))
        .map_err(|error| format!("Harness command failed: {}", error.code()))?;
        Ok(HarnessSessionCommandOutput {
            command_id,
            outcome: result.outcome,
            session: result.session,
        })
    })
    .await
    .map_err(|_| "Harness command task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn harness_inspector(
    state: State<'_, crate::AppState>,
    request: HarnessInspectorInput,
) -> Result<String, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let raw = tauri::async_runtime::block_on(broker.inspector(InspectorRequest {
            session_id: request.session_id,
        }))
        .map_err(|error| format!("Harness inspector failed: {}", error.code()))?;
        inspector_projection(raw, false)
    })
    .await
    .map_err(|_| "Harness inspector task failed".to_owned())?
}

fn inspector_projection(raw: String, composer_only: bool) -> Result<String, String> {
    let mut projection: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "Harness inspector returned an invalid projection".to_owned())?;
    let object = projection
        .as_object_mut()
        .ok_or_else(|| "Harness inspector returned an invalid projection".to_owned())?;
    let composer = object.remove("composer");
    let selected = if composer_only {
        composer.ok_or_else(|| "Harness composer projection is unavailable".to_owned())?
    } else {
        projection
    };
    serde_json::to_string(&selected)
        .map_err(|_| "Harness inspector projection could not be serialized".to_owned())
}

#[cfg(test)]
mod inspector_projection_tests {
    use super::inspector_projection;

    #[test]
    fn separates_composer_from_legacy_inspector_projection() {
        let raw = r#"{"observedAtMs":1,"composer":{"models":[]}}"#.to_owned();
        assert_eq!(
            inspector_projection(raw.clone(), false).unwrap(),
            r#"{"observedAtMs":1}"#
        );
        assert_eq!(inspector_projection(raw, true).unwrap(), r#"{"models":[]}"#);
    }

    #[test]
    fn composer_projection_is_explicitly_unavailable_when_not_reported() {
        let error = inspector_projection(r#"{"observedAtMs":1}"#.to_owned(), true).unwrap_err();
        assert_eq!(error, "Harness composer projection is unavailable");
    }
}

#[tauri::command]
pub(crate) async fn harness_composer_projection(
    state: State<'_, crate::AppState>,
    request: HarnessInspectorInput,
) -> Result<String, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let raw = tauri::async_runtime::block_on(broker.inspector(InspectorRequest {
            session_id: request.session_id,
        }))
        .map_err(|error| format!("Harness inspector failed: {}", error.code()))?;
        inspector_projection(raw, true)
    })
    .await
    .map_err(|_| "Harness composer projection task failed".to_owned())?
}

fn artifact_unavailable(reason: impl Into<String>) -> ArtifactOpenResult {
    ArtifactOpenResult::Unsupported {
        reason: reason.into(),
    }
}

#[tauri::command]
pub(crate) fn harness_artifact_open(
    state: State<'_, crate::AppState>,
    request: HarnessArtifactOpenInput,
) -> ArtifactOpenResult {
    let Some(broker) = state.harness.broker() else {
        return artifact_unavailable("The verified Harness broker is unavailable.");
    };
    let coordinator = state.harness.resident_transaction();
    let Ok(_catalog_transaction) = coordinator.lock() else {
        return artifact_unavailable(
            "The authoritative project catalog transaction is unavailable.",
        );
    };
    let Ok(catalog) = state.project_catalog.load() else {
        return artifact_unavailable("The authoritative project catalog is unavailable.");
    };
    let matches = catalog
        .state
        .projects
        .iter()
        .filter(|project| {
            !project.archived
                && project
                    .chats
                    .iter()
                    .filter(|chat| {
                        !chat.archived
                            && chat
                                .binding
                                .as_ref()
                                .is_some_and(|binding| binding.session_id == request.session_id)
                    })
                    .count()
                    == 1
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return artifact_unavailable(
            "The Harness session is not uniquely bound to an active catalog project.",
        );
    }
    let project = matches[0];
    let Ok(workspace) = project_workspace(project) else {
        return artifact_unavailable("The authoritative project workspace is unavailable.");
    };
    // Keep the broker chronology lock through admission. Otherwise a Harness event could advance
    // the session after candidate resolution but before the file becomes an ArtifactAuthority
    // binding, turning a stale renderer gesture into a newly admitted artifact.
    let Ok(broker) = broker.lock() else {
        return artifact_unavailable("The verified Harness broker is unavailable.");
    };
    let resolution =
        match broker.resolve_artifact_candidate(&request.session_id, &request.candidate_id) {
            Ok(candidate) => candidate,
            Err(_) => return artifact_unavailable(
                "The artifact candidate is forged, stale, or belongs to another Harness session.",
            ),
        };
    if daemon_project_id(&workspace) != resolution.project_id {
        return artifact_unavailable(
            "The Harness candidate does not belong to the catalog project workspace.",
        );
    }
    let root = PathBuf::from(workspace);
    let candidate_path = if resolution.path.is_absolute() {
        resolution.path.clone()
    } else {
        root.join(&resolution.path)
    };
    let artifact_ref =
        match state
            .artifacts
            .admit_harness_artifact(ArtifactAdmission::new(
                resolution.broker_id,
                resolution.root_session_id,
                resolution.artifact_id,
                root,
                candidate_path,
                resolution.writable,
            )) {
            Ok(artifact_ref) => artifact_ref,
            Err(_) => return artifact_unavailable(
                "The Harness artifact could not be admitted inside its authoritative project root.",
            ),
        };
    drop(broker);
    state.artifacts.open(&artifact_ref)
}

#[tauri::command]
pub(crate) async fn harness_refresh_session(
    state: State<'_, crate::AppState>,
    request: HarnessRefreshSessionInput,
) -> Result<RootSessionProjection, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        tauri::async_runtime::block_on(broker.refresh_session(RefreshSessionRequest {
            session_id: request.session_id,
            known_cursor: request.known_cursor,
        }))
        .map_err(|error| format!("Harness refresh failed: {}", error.code()))
    })
    .await
    .map_err(|_| "Harness refresh task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn harness_studio_operation(
    state: State<'_, crate::AppState>,
    request: HarnessStudioOperationInput,
) -> Result<HarnessStudioOperationOutput, String> {
    let broker = state
        .harness
        .broker()
        .ok_or_else(|| "Harness activation is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut broker = broker
            .lock()
            .map_err(|_| "Harness broker is unavailable".to_owned())?;
        let result =
            tauri::async_runtime::block_on(broker.execute_operation(StudioOperationRequest {
                session_id: request.session_id,
                operation_id: request.operation_id,
                action: request.action,
                payload_json: request.payload_json,
                expected_cursor: request.expected_cursor,
                idempotency_key: request.idempotency_key,
            }))
            .map_err(|error| format!("Harness operation failed: {}", error.code()))?;
        Ok(HarnessStudioOperationOutput {
            operation_id: result.operation_id,
            status: result.status,
            command_id: result.command_id,
            position: result.position,
            revision: result.revision,
            reason: result.reason,
            retryable: result.retryable,
            session: result.session,
        })
    })
    .await
    .map_err(|_| "Harness operation task failed".to_owned())?
}

#[cfg(test)]
mod resident_composition_tests {
    use super::*;

    #[test]
    fn daemon_project_identity_matches_the_javascript_contract_for_ascii_windows_paths() {
        assert_eq!(
            daemon_project_id(r"C:\Work"),
            "project-194c27bb658adbc8e822c4e3"
        );
        assert_eq!(daemon_project_id(r"C:\Work"), daemon_project_id(r"c:\work"));
    }

    #[test]
    fn daemon_chat_identity_is_metadata_only_and_never_a_path() {
        let metadata = session_file_metadata("daemon-chat-1");
        assert!(metadata.ends_with(".jsonl"));
        assert!(!metadata.contains(['/', '\\', ':']));
        assert_ne!(metadata, "daemon-chat-1.jsonl");
    }

    #[test]
    fn studio_branch_identity_is_deterministic_and_never_reuses_daemon_or_source_ids() {
        let id = branch_chat_id("project:personal", "studio-source", "message-1");
        assert_eq!(
            id,
            branch_chat_id("project:personal", "studio-source", "message-1")
        );
        assert!(id.starts_with("chat-branch-"));
        assert_ne!(id, "studio-source");
        assert_ne!(id, "daemon-active-branch");
    }
}
