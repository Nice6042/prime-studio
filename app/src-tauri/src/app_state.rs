use std::sync::Mutex;

use crate::harness::broker::HarnessBroker;
use crate::harness::generated::{HarnessCompatibility, HarnessUnavailableReason};
use crate::harness::projections::BootProjection;

#[derive(Default)]
pub struct HarnessState {
    broker: Mutex<Option<HarnessBroker>>,
}

impl HarnessState {
    pub fn bootstrap_projection(&self) -> BootProjection {
        self.broker
            .lock()
            .ok()
            .and_then(|broker| broker.as_ref().and_then(HarnessBroker::boot_projection))
            .unwrap_or_else(unavailable_projection)
    }

    pub fn session_projections(&self) -> Vec<crate::harness::projections::RootSessionProjection> {
        self.broker
            .lock()
            .ok()
            .and_then(|broker| broker.as_ref().map(HarnessBroker::projects))
            .unwrap_or_default()
    }
}

fn unavailable_projection() -> BootProjection {
    BootProjection {
        compatibility: HarnessCompatibility::Unavailable {
            reason: HarnessUnavailableReason::SecurityVerificationFailed,
        },
        sessions: Vec::new(),
    }
}
