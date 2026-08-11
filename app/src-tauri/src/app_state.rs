use std::sync::Mutex;

use crate::harness::broker::HarnessBroker;

#[derive(Default)]
pub struct AppState {
    pub harness: Mutex<Option<HarnessBroker>>,
}
