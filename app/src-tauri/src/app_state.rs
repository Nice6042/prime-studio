use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::harness::broker::HarnessBroker;
use crate::harness::generated::{HarnessCompatibility, HarnessUnavailableReason};
use crate::harness::projections::BootProjection;

enum ActivationSlot {
    Pending,
    Ready(Arc<Mutex<HarnessBroker>>),
    Unavailable(HarnessUnavailableReason),
}

struct HarnessStateInner {
    slot: Mutex<ActivationSlot>,
    changed: Condvar,
    resident_transaction: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub struct HarnessState {
    inner: Arc<HarnessStateInner>,
}

impl Default for HarnessState {
    fn default() -> Self {
        Self {
            inner: Arc::new(HarnessStateInner {
                slot: Mutex::new(ActivationSlot::Pending),
                changed: Condvar::new(),
                resident_transaction: Arc::new(Mutex::new(())),
            }),
        }
    }
}

impl HarnessState {
    pub fn bootstrap_projection(&self) -> BootProjection {
        self.projection_from_current_slot()
    }

    pub fn wait_bootstrap_projection(&self, timeout: Duration) -> BootProjection {
        let Ok(slot) = self.inner.slot.lock() else {
            return unavailable_projection(HarnessUnavailableReason::SecurityVerificationFailed);
        };
        let Ok((mut slot, wait)) = self
            .inner
            .changed
            .wait_timeout_while(slot, timeout, |slot| {
                matches!(slot, ActivationSlot::Pending)
            })
        else {
            return unavailable_projection(HarnessUnavailableReason::SecurityVerificationFailed);
        };
        if wait.timed_out() && matches!(*slot, ActivationSlot::Pending) {
            *slot = ActivationSlot::Unavailable(HarnessUnavailableReason::TransportUnavailable);
            self.inner.changed.notify_all();
        }
        projection_from_slot(&slot)
    }

    pub fn session_projections(&self) -> Vec<crate::harness::projections::RootSessionProjection> {
        self.broker()
            .and_then(|broker| broker.lock().ok().map(|broker| broker.projects()))
            .unwrap_or_default()
    }

    pub(crate) fn broker(&self) -> Option<Arc<Mutex<HarnessBroker>>> {
        let slot = self.inner.slot.lock().ok()?;
        match &*slot {
            ActivationSlot::Ready(broker) => Some(broker.clone()),
            ActivationSlot::Pending | ActivationSlot::Unavailable(_) => None,
        }
    }

    pub(crate) fn resident_transaction(&self) -> Arc<Mutex<()>> {
        self.inner.resident_transaction.clone()
    }

    pub(crate) fn install(&self, broker: HarnessBroker) -> Result<(), &'static str> {
        let mut slot = self
            .inner
            .slot
            .lock()
            .map_err(|_| "Harness state is unavailable")?;
        if !matches!(*slot, ActivationSlot::Pending) {
            return Err("Harness activation already reached a terminal state");
        }
        *slot = ActivationSlot::Ready(Arc::new(Mutex::new(broker)));
        self.inner.changed.notify_all();
        Ok(())
    }

    pub(crate) fn mark_unavailable(
        &self,
        reason: HarnessUnavailableReason,
    ) -> Result<(), &'static str> {
        let mut slot = self
            .inner
            .slot
            .lock()
            .map_err(|_| "Harness state is unavailable")?;
        if !matches!(*slot, ActivationSlot::Pending) {
            return Err("Harness activation already reached a terminal state");
        }
        *slot = ActivationSlot::Unavailable(reason);
        self.inner.changed.notify_all();
        Ok(())
    }

    fn projection_from_current_slot(&self) -> BootProjection {
        self.inner
            .slot
            .lock()
            .map(|slot| projection_from_slot(&slot))
            .unwrap_or_else(|_| {
                unavailable_projection(HarnessUnavailableReason::SecurityVerificationFailed)
            })
    }
}

fn projection_from_slot(slot: &ActivationSlot) -> BootProjection {
    match slot {
        ActivationSlot::Ready(broker) => broker
            .lock()
            .ok()
            .and_then(|broker| broker.boot_projection())
            .unwrap_or_else(|| {
                unavailable_projection(HarnessUnavailableReason::TransportUnavailable)
            }),
        ActivationSlot::Unavailable(reason) => unavailable_projection(reason.clone()),
        ActivationSlot::Pending => {
            unavailable_projection(HarnessUnavailableReason::TransportUnavailable)
        }
    }
}

fn unavailable_projection(reason: HarnessUnavailableReason) -> BootProjection {
    BootProjection {
        compatibility: HarnessCompatibility::Unavailable { reason },
        runtime: None,
        sessions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn failed_activation_is_visible_with_its_exact_reason() {
        let state = HarnessState::default();
        state
            .mark_unavailable(HarnessUnavailableReason::NotInstalled)
            .unwrap();

        assert!(matches!(
            state
                .wait_bootstrap_projection(Duration::from_millis(1))
                .compatibility,
            HarnessCompatibility::Unavailable {
                reason: HarnessUnavailableReason::NotInstalled
            }
        ));
    }

    #[test]
    fn pending_activation_waits_for_a_terminal_result() {
        let state = HarnessState::default();
        let worker = state.clone();
        std::thread::spawn(move || {
            worker
                .mark_unavailable(HarnessUnavailableReason::TransportUnavailable)
                .unwrap();
        });

        assert!(matches!(
            state
                .wait_bootstrap_projection(Duration::from_secs(1))
                .compatibility,
            HarnessCompatibility::Unavailable {
                reason: HarnessUnavailableReason::TransportUnavailable
            }
        ));
    }

    #[test]
    fn activation_timeout_becomes_a_terminal_visible_failure() {
        let state = HarnessState::default();

        assert!(matches!(
            state
                .wait_bootstrap_projection(Duration::from_millis(1))
                .compatibility,
            HarnessCompatibility::Unavailable {
                reason: HarnessUnavailableReason::TransportUnavailable
            }
        ));
        assert_eq!(
            state.mark_unavailable(HarnessUnavailableReason::NotInstalled),
            Err("Harness activation already reached a terminal state")
        );
    }

    #[test]
    fn every_catalog_mutation_shares_the_resident_transaction_coordinator() {
        let state = HarnessState::default();
        let first = state.resident_transaction();
        let second = state.resident_transaction();
        let held = first.lock().unwrap();
        assert!(second.try_lock().is_err());
        drop(held);
        assert!(second.try_lock().is_ok());
    }
}
