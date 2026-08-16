//! Closed, lease-scoped interaction worker contract.
//!
//! This module defines the native authority and chronology required before a
//! browser or desktop worker can perform effects. Production currently creates
//! only an unavailable broker; tests may install a synthetic verified worker to
//! exercise admission, lease expiry, replay rejection, and evidence binding.
//! No renderer-facing constructor or effect-dispatch command is provided here.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const INTERACTION_WORKER_CONTRACT_VERSION: u8 = 1;
pub const MAX_INTERACTION_ID_BYTES: usize = 160;
pub const MAX_TARGET_BYTES: usize = 2_048;
pub const MAX_LEASE_MS: u64 = 60_000;
pub const MAX_CAPTURE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_ACTIVE_LEASES: usize = 32;
pub const MAX_OPERATION_HISTORY: usize = 4_096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionCapability {
    BrowserInspect,
    BrowserScreenshot,
    ComputerObserve,
    ComputerClick,
    ComputerTypeText,
}

impl InteractionCapability {
    pub const fn is_mutating(self) -> bool {
        matches!(self, Self::ComputerClick | Self::ComputerTypeText)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionAdmissionRequest {
    pub operation_id: String,
    pub session_id: String,
    pub chat_id: String,
    pub capability: InteractionCapability,
    pub target: String,
    pub requested_at_ms: u64,
    pub lease_ms: u64,
    pub mutating_grant: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionWorkerReadiness {
    pub contract_version: u8,
    pub status: InteractionWorkerStatus,
    pub worker_bound: bool,
    pub worker_id: Option<String>,
    pub worker_digest: Option<String>,
    pub read_only_dispatch: bool,
    pub mutating_dispatch: bool,
    pub reason: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionWorkerStatus {
    Unavailable,
    Verified,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionLease {
    pub lease_id: String,
    pub operation_id: String,
    pub session_id: String,
    pub chat_id: String,
    pub capability: InteractionCapability,
    pub target_digest: String,
    pub worker_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionEvidence {
    pub lease_id: String,
    pub operation_id: String,
    pub worker_id: String,
    pub capability: InteractionCapability,
    pub target_digest: String,
    pub completed_at_ms: u64,
    pub payload_digest: String,
    pub payload_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InteractionAdmissionError {
    WorkerUnavailable,
    InvalidRequest,
    CapabilityUnavailable,
    ExplicitGrantRequired,
    LeaseCapacityExceeded,
    DuplicateOperation,
    OperationHistoryExhausted,
    LeaseNotFound,
    LeaseExpired,
    LeaseMismatch,
    EvidenceTooLarge,
}

#[derive(Clone, Debug)]
pub struct VerifiedInteractionWorker {
    worker_id: String,
    worker_digest: String,
    capabilities: BTreeSet<InteractionCapability>,
    mutating_enabled: bool,
}

impl VerifiedInteractionWorker {
    #[cfg(test)]
    fn new(
        worker_id: String,
        worker_digest: String,
        capabilities: BTreeSet<InteractionCapability>,
        mutating_enabled: bool,
    ) -> Result<Self, InteractionAdmissionError> {
        if !valid_identifier(&worker_id)
            || !valid_digest(&worker_digest)
            || capabilities.is_empty()
        {
            return Err(InteractionAdmissionError::InvalidRequest);
        }
        Ok(Self {
            worker_id,
            worker_digest,
            capabilities,
            mutating_enabled,
        })
    }

    #[cfg(test)]
    fn for_tests(capabilities: impl IntoIterator<Item = InteractionCapability>) -> Self {
        Self::new(
            "synthetic-worker-1".to_owned(),
            format!("sha256:{:x}", Sha256::digest(b"synthetic-worker-1")),
            capabilities.into_iter().collect(),
            true,
        )
        .expect("synthetic worker is valid")
    }
}

#[derive(Clone, Debug)]
struct ActiveLease {
    lease: InteractionLease,
}

#[derive(Debug)]
pub struct InteractionBroker {
    worker: Option<VerifiedInteractionWorker>,
    active: BTreeMap<String, ActiveLease>,
    operation_leases: BTreeMap<String, String>,
    retired_operations: BTreeSet<String>,
}

impl InteractionBroker {
    pub const fn unavailable() -> Self {
        Self {
            worker: None,
            active: BTreeMap::new(),
            operation_leases: BTreeMap::new(),
            retired_operations: BTreeSet::new(),
        }
    }

    #[cfg(test)]
    fn with_verified_worker(worker: VerifiedInteractionWorker) -> Self {
        Self {
            worker: Some(worker),
            active: BTreeMap::new(),
            operation_leases: BTreeMap::new(),
            retired_operations: BTreeSet::new(),
        }
    }

    pub fn readiness(&self) -> InteractionWorkerReadiness {
        match &self.worker {
            None => InteractionWorkerReadiness {
                contract_version: INTERACTION_WORKER_CONTRACT_VERSION,
                status: InteractionWorkerStatus::Unavailable,
                worker_bound: false,
                worker_id: None,
                worker_digest: None,
                read_only_dispatch: false,
                mutating_dispatch: false,
                reason: "verified_interaction_worker_unavailable",
            },
            Some(worker) => InteractionWorkerReadiness {
                contract_version: INTERACTION_WORKER_CONTRACT_VERSION,
                status: InteractionWorkerStatus::Verified,
                worker_bound: true,
                worker_id: Some(worker.worker_id.clone()),
                worker_digest: Some(worker.worker_digest.clone()),
                read_only_dispatch: worker.capabilities.iter().any(|capability| !capability.is_mutating()),
                mutating_dispatch: worker.mutating_enabled
                    && worker.capabilities.iter().any(|capability| capability.is_mutating()),
                reason: "verified_interaction_worker_ready",
            },
        }
    }

    pub fn admit(
        &mut self,
        request: InteractionAdmissionRequest,
        now_ms: u64,
    ) -> Result<InteractionLease, InteractionAdmissionError> {
        self.expire(now_ms);
        let worker = self
            .worker
            .as_ref()
            .ok_or(InteractionAdmissionError::WorkerUnavailable)?;
        validate_request(&request, now_ms)?;
        if !worker.capabilities.contains(&request.capability) {
            return Err(InteractionAdmissionError::CapabilityUnavailable);
        }
        if request.capability.is_mutating() && (!worker.mutating_enabled || !request.mutating_grant) {
            return Err(InteractionAdmissionError::ExplicitGrantRequired);
        }
        if self.active.len() >= MAX_ACTIVE_LEASES {
            return Err(InteractionAdmissionError::LeaseCapacityExceeded);
        }
        if self.operation_leases.contains_key(&request.operation_id)
            || self.retired_operations.contains(&request.operation_id)
        {
            return Err(InteractionAdmissionError::DuplicateOperation);
        }
        if self.operation_leases.len() + self.retired_operations.len()
            >= MAX_OPERATION_HISTORY
        {
            return Err(InteractionAdmissionError::OperationHistoryExhausted);
        }
        let lease_id = Uuid::new_v4().simple().to_string();
        let lease = InteractionLease {
            lease_id: lease_id.clone(),
            operation_id: request.operation_id.clone(),
            session_id: request.session_id,
            chat_id: request.chat_id,
            capability: request.capability,
            target_digest: digest_text(&request.target),
            worker_id: worker.worker_id.clone(),
            issued_at_ms: now_ms,
            expires_at_ms: now_ms + request.lease_ms,
        };
        self.operation_leases
            .insert(request.operation_id, lease_id.clone());
        self.active
            .insert(lease_id, ActiveLease { lease: lease.clone() });
        Ok(lease)
    }

    pub fn complete(
        &mut self,
        lease_id: &str,
        worker_id: &str,
        completed_at_ms: u64,
        payload: &[u8],
    ) -> Result<InteractionEvidence, InteractionAdmissionError> {
        let active = self
            .active
            .remove(lease_id)
            .ok_or(InteractionAdmissionError::LeaseNotFound)?;
        self.operation_leases.remove(&active.lease.operation_id);
        self.retired_operations
            .insert(active.lease.operation_id.clone());
        if payload.len() as u64 > MAX_CAPTURE_BYTES {
            return Err(InteractionAdmissionError::EvidenceTooLarge);
        }
        if completed_at_ms > active.lease.expires_at_ms {
            return Err(InteractionAdmissionError::LeaseExpired);
        }
        if worker_id != active.lease.worker_id {
            return Err(InteractionAdmissionError::LeaseMismatch);
        }
        Ok(InteractionEvidence {
            lease_id: active.lease.lease_id,
            operation_id: active.lease.operation_id,
            worker_id: active.lease.worker_id,
            capability: active.lease.capability,
            target_digest: active.lease.target_digest,
            completed_at_ms,
            payload_digest: format!("sha256:{:x}", Sha256::digest(payload)),
            payload_bytes: payload.len() as u64,
        })
    }

    pub fn cancel(&mut self, lease_id: &str) -> bool {
        let Some(active) = self.active.remove(lease_id) else {
            return false;
        };
        self.operation_leases.remove(&active.lease.operation_id);
        self.retired_operations.insert(active.lease.operation_id);
        true
    }

    pub fn expire(&mut self, now_ms: u64) {
        let expired = self
            .active
            .iter()
            .filter(|(_, active)| active.lease.expires_at_ms < now_ms)
            .map(|(lease_id, _)| lease_id.clone())
            .collect::<Vec<_>>();
        for lease_id in expired {
            let _ = self.cancel(&lease_id);
        }
    }
}

impl Default for InteractionBroker {
    fn default() -> Self {
        Self::unavailable()
    }
}

fn validate_request(
    request: &InteractionAdmissionRequest,
    now_ms: u64,
) -> Result<(), InteractionAdmissionError> {
    if !valid_identifier(&request.operation_id)
        || !valid_identifier(&request.session_id)
        || !valid_identifier(&request.chat_id)
        || request.target.is_empty()
        || request.target.len() > MAX_TARGET_BYTES
        || request.target.contains('\0')
        || request.requested_at_ms != now_ms
        || request.lease_ms == 0
        || request.lease_ms > MAX_LEASE_MS
        || now_ms.checked_add(request.lease_ms).is_none()
    {
        return Err(InteractionAdmissionError::InvalidRequest);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_INTERACTION_ID_BYTES
        && value
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'\\' && byte != b'"')
}

#[cfg(test)]
fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn digest_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(capability: InteractionCapability) -> InteractionAdmissionRequest {
        InteractionAdmissionRequest {
            operation_id: "operation-1".to_owned(),
            session_id: "session-1".to_owned(),
            chat_id: "chat-1".to_owned(),
            capability,
            target: "window:foreground".to_owned(),
            requested_at_ms: 100,
            lease_ms: 5_000,
            mutating_grant: false,
        }
    }

    #[test]
    fn production_broker_is_truthfully_unavailable() {
        let readiness = InteractionBroker::unavailable().readiness();
        assert_eq!(readiness.status, InteractionWorkerStatus::Unavailable);
        assert!(!readiness.worker_bound);
        assert!(!readiness.read_only_dispatch);
        assert!(!readiness.mutating_dispatch);
        assert_eq!(readiness.reason, "verified_interaction_worker_unavailable");
    }

    #[test]
    fn read_only_work_uses_a_bounded_identity_bound_lease() {
        let worker = VerifiedInteractionWorker::for_tests([
            InteractionCapability::BrowserInspect,
            InteractionCapability::BrowserScreenshot,
        ]);
        let mut broker = InteractionBroker::with_verified_worker(worker);
        let lease = broker
            .admit(request(InteractionCapability::BrowserInspect), 100)
            .expect("read-only work is admitted");
        assert_eq!(lease.session_id, "session-1");
        assert_eq!(lease.chat_id, "chat-1");
        assert_eq!(lease.expires_at_ms, 5_100);
        assert_eq!(lease.target_digest, digest_text("window:foreground"));

        let evidence = broker
            .complete(&lease.lease_id, "synthetic-worker-1", 120, b"bounded evidence")
            .expect("exact worker completes the lease");
        assert_eq!(evidence.operation_id, "operation-1");
        assert_eq!(evidence.payload_bytes, 16);
        assert_eq!(
            evidence.payload_digest,
            format!("sha256:{:x}", Sha256::digest(b"bounded evidence"))
        );
        let mut replay = request(InteractionCapability::BrowserInspect);
        replay.requested_at_ms = 121;
        assert_eq!(
            broker.admit(replay, 121),
            Err(InteractionAdmissionError::DuplicateOperation)
        );
    }

    #[test]
    fn mutating_work_requires_an_explicit_grant() {
        let worker = VerifiedInteractionWorker::for_tests([InteractionCapability::ComputerClick]);
        let mut broker = InteractionBroker::with_verified_worker(worker);
        assert_eq!(
            broker.admit(request(InteractionCapability::ComputerClick), 100),
            Err(InteractionAdmissionError::ExplicitGrantRequired)
        );
        let mut granted = request(InteractionCapability::ComputerClick);
        granted.mutating_grant = true;
        assert!(broker.admit(granted, 100).is_ok());
    }

    #[test]
    fn replay_expiry_and_worker_mismatch_fail_closed() {
        let worker = VerifiedInteractionWorker::for_tests([InteractionCapability::BrowserInspect]);
        let mut broker = InteractionBroker::with_verified_worker(worker);
        let lease = broker
            .admit(request(InteractionCapability::BrowserInspect), 100)
            .expect("first admission");
        assert_eq!(
            broker.admit(request(InteractionCapability::BrowserInspect), 100),
            Err(InteractionAdmissionError::DuplicateOperation)
        );
        assert_eq!(
            broker.complete(&lease.lease_id, "other-worker", 120, b"evidence"),
            Err(InteractionAdmissionError::LeaseMismatch)
        );
        assert_eq!(
            broker.admit(request(InteractionCapability::BrowserInspect), 121),
            Err(InteractionAdmissionError::InvalidRequest)
        );
        let mut replay = request(InteractionCapability::BrowserInspect);
        replay.requested_at_ms = 121;
        assert_eq!(
            broker.admit(replay, 121),
            Err(InteractionAdmissionError::DuplicateOperation)
        );

        let mut second = request(InteractionCapability::BrowserInspect);
        second.operation_id = "operation-2".to_owned();
        second.lease_ms = 10;
        let second = broker.admit(second, 100).expect("second admission");
        assert_eq!(
            broker.complete(&second.lease_id, "synthetic-worker-1", 111, b"evidence"),
            Err(InteractionAdmissionError::LeaseExpired)
        );
    }

    #[test]
    fn malformed_requests_and_oversized_evidence_are_rejected() {
        let worker = VerifiedInteractionWorker::for_tests([InteractionCapability::BrowserScreenshot]);
        let mut broker = InteractionBroker::with_verified_worker(worker);
        let mut malformed = request(InteractionCapability::BrowserScreenshot);
        malformed.target = "x".repeat(MAX_TARGET_BYTES + 1);
        assert_eq!(
            broker.admit(malformed, 100),
            Err(InteractionAdmissionError::InvalidRequest)
        );

        let lease = broker
            .admit(request(InteractionCapability::BrowserScreenshot), 100)
            .expect("valid admission");
        assert_eq!(
            broker.complete(
                &lease.lease_id,
                "synthetic-worker-1",
                120,
                &vec![0; MAX_CAPTURE_BYTES as usize + 1],
            ),
            Err(InteractionAdmissionError::EvidenceTooLarge)
        );
        let mut retry = request(InteractionCapability::BrowserScreenshot);
        retry.requested_at_ms = 121;
        assert_eq!(
            broker.admit(retry, 121),
            Err(InteractionAdmissionError::DuplicateOperation)
        );
    }
}
