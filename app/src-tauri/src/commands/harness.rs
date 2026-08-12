use serde::{Deserialize, Serialize};
use tauri::State;

use crate::harness::broker::{AttachRequest, SessionCommandRequest};
use crate::harness::generated::{CommandOutcome, HarnessCursor, SessionCommandKind};
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
