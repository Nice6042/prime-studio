use std::sync::{Arc, Mutex};

use crate::harness::broker::HarnessBroker;
use crate::harness::generated::{HarnessCompatibility, HarnessUnavailableReason};
use crate::harness::projections::BootProjection;

#[derive(Default)]
pub struct HarnessState {
    broker: Mutex<Option<Arc<Mutex<HarnessBroker>>>>,
}

impl HarnessState {
    pub fn bootstrap_projection(&self) -> BootProjection {
        self.broker
            .lock()
            .ok()
            .and_then(|broker| broker.as_ref().cloned())
            .and_then(|broker| {
                broker
                    .lock()
                    .ok()
                    .and_then(|broker| broker.boot_projection())
            })
            .unwrap_or_else(unavailable_projection)
    }

    pub fn session_projections(&self) -> Vec<crate::harness::projections::RootSessionProjection> {
        self.broker
            .lock()
            .ok()
            .and_then(|broker| broker.as_ref().cloned())
            .and_then(|broker| broker.lock().ok().map(|broker| broker.projects()))
            .unwrap_or_default()
    }

    pub(crate) fn broker(&self) -> Option<Arc<Mutex<HarnessBroker>>> {
        self.broker.lock().ok()?.as_ref().cloned()
    }

    #[cfg(any(test, debug_assertions))]
    pub(crate) fn install(&self, broker: HarnessBroker) -> Result<(), &'static str> {
        let mut slot = self
            .broker
            .lock()
            .map_err(|_| "Harness state is unavailable")?;
        if slot.is_some() {
            return Err("Harness broker is already installed");
        }
        *slot = Some(Arc::new(Mutex::new(broker)));
        Ok(())
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
