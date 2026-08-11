use tauri::State;

use crate::harness::projections::{BootProjection, RootSessionProjection};

#[tauri::command]
pub(crate) fn harness_bootstrap(state: State<'_, crate::AppState>) -> BootProjection {
    state.harness.bootstrap_projection()
}

#[tauri::command]
pub(crate) fn harness_projection(state: State<'_, crate::AppState>) -> Vec<RootSessionProjection> {
    state.harness.session_projections()
}
