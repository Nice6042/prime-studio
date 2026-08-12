use serde::{Deserialize, Serialize};
use tauri::State;

use crate::harness::broker::{
    AttachRequest, InspectorRequest, RefreshSessionRequest, SessionCommandRequest,
    StudioOperationRequest,
};
use crate::harness::generated::{
    CommandOutcome, HarnessCursor, HarnessStudioAction, SessionCommandKind, StudioOperationStatus,
};
use crate::harness::projections::{BootProjection, RootSessionProjection};

#[tauri::command]
pub(crate) fn harness_bootstrap(state: State<'_, crate::AppState>) -> BootProjection {
    state.harness.bootstrap_projection()
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
pub(crate) struct HarnessInspectorInput {
    session_id: String,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessSessionCommandOutput {
    command_id: String,
    outcome: CommandOutcome,
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
        tauri::async_runtime::block_on(broker.inspector(InspectorRequest {
            session_id: request.session_id,
        }))
        .map_err(|error| format!("Harness inspector failed: {}", error.code()))
    })
    .await
    .map_err(|_| "Harness inspector task failed".to_owned())?
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
