//! Native ownership boundary for Windows computer-use admission.
//!
//! Milestone 1 deliberately stops before worker launch or effect dispatch. The
//! renderer can read the projection registered in `lib.rs`, but there is no IPC
//! command that accepts authority, changes readiness, or performs an effect.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const COMPUTER_USE_POLICY_VERSION: u8 = 3;
pub const MAX_AUTHORITY_IDENTIFIER_BYTES: usize = 256;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) const AUTHORITY_STRING_FIELDS: [&str; 8] = [
    "accountId",
    "projectId",
    "chatId",
    "sessionId",
    "principalId",
    "policyId",
    "brokerId",
    "workerId",
];

pub(crate) const AUTHORITY_EPOCH_FIELDS: [&str; 9] = [
    "accountEpoch",
    "projectEpoch",
    "chatEpoch",
    "sessionEpoch",
    "principalEpoch",
    "policyEpoch",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityBindingParts {
    pub(crate) account_id: String,
    pub(crate) project_id: String,
    pub(crate) chat_id: String,
    pub(crate) session_id: String,
    pub(crate) principal_id: String,
    pub(crate) policy_id: String,
    pub(crate) broker_id: String,
    pub(crate) worker_id: String,
    pub(crate) account_epoch: u64,
    pub(crate) project_epoch: u64,
    pub(crate) chat_epoch: u64,
    pub(crate) session_epoch: u64,
    pub(crate) principal_epoch: u64,
    pub(crate) policy_epoch: u64,
    pub(crate) broker_epoch: u64,
    pub(crate) worker_epoch: u64,
    pub(crate) readiness_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityBinding {
    account_id: String,
    project_id: String,
    chat_id: String,
    session_id: String,
    principal_id: String,
    policy_id: String,
    broker_id: String,
    worker_id: String,
    account_epoch: u64,
    project_epoch: u64,
    chat_epoch: u64,
    session_epoch: u64,
    principal_epoch: u64,
    policy_epoch: u64,
    broker_epoch: u64,
    worker_epoch: u64,
    readiness_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AuthorityBindingError {
    InvalidIdentifier(&'static str),
    InvalidEpoch(&'static str),
}

impl fmt::Display for AuthorityBindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier(field) => {
                write!(formatter, "computer-use authority has an invalid {field}")
            }
            Self::InvalidEpoch(field) => {
                write!(formatter, "computer-use authority has an invalid {field}")
            }
        }
    }
}

impl std::error::Error for AuthorityBindingError {}

impl TryFrom<AuthorityBindingParts> for AuthorityBinding {
    type Error = AuthorityBindingError;

    fn try_from(parts: AuthorityBindingParts) -> Result<Self, Self::Error> {
        for (field, value) in [
            ("accountId", parts.account_id.as_str()),
            ("projectId", parts.project_id.as_str()),
            ("chatId", parts.chat_id.as_str()),
            ("sessionId", parts.session_id.as_str()),
            ("principalId", parts.principal_id.as_str()),
            ("policyId", parts.policy_id.as_str()),
            ("brokerId", parts.broker_id.as_str()),
            ("workerId", parts.worker_id.as_str()),
        ] {
            if value.is_empty() || value.len() > MAX_AUTHORITY_IDENTIFIER_BYTES {
                return Err(AuthorityBindingError::InvalidIdentifier(field));
            }
        }
        for (field, value) in [
            ("accountEpoch", parts.account_epoch),
            ("projectEpoch", parts.project_epoch),
            ("chatEpoch", parts.chat_epoch),
            ("sessionEpoch", parts.session_epoch),
            ("principalEpoch", parts.principal_epoch),
            ("policyEpoch", parts.policy_epoch),
            ("brokerEpoch", parts.broker_epoch),
            ("workerEpoch", parts.worker_epoch),
            ("readinessEpoch", parts.readiness_epoch),
        ] {
            if value == 0 || value > MAX_SAFE_INTEGER {
                return Err(AuthorityBindingError::InvalidEpoch(field));
            }
        }
        Ok(Self {
            account_id: parts.account_id,
            project_id: parts.project_id,
            chat_id: parts.chat_id,
            session_id: parts.session_id,
            principal_id: parts.principal_id,
            policy_id: parts.policy_id,
            broker_id: parts.broker_id,
            worker_id: parts.worker_id,
            account_epoch: parts.account_epoch,
            project_epoch: parts.project_epoch,
            chat_epoch: parts.chat_epoch,
            session_epoch: parts.session_epoch,
            principal_epoch: parts.principal_epoch,
            policy_epoch: parts.policy_epoch,
            broker_epoch: parts.broker_epoch,
            worker_epoch: parts.worker_epoch,
            readiness_epoch: parts.readiness_epoch,
        })
    }
}

impl AuthorityBinding {
    /// Match the approved TypeScript contract's sorted-key stable JSON digest.
    pub fn digest(&self) -> String {
        let value = serde_json::to_value(self).expect("authority binding is serializable");
        let object = value
            .as_object()
            .expect("authority binding serializes as an object");
        let sorted: BTreeMap<&str, &Value> = AUTHORITY_STRING_FIELDS
            .into_iter()
            .chain(AUTHORITY_EPOCH_FIELDS)
            .map(|key| {
                (
                    key,
                    object
                        .get(key)
                        .expect("authority serialization matches the pinned inventory"),
                )
            })
            .collect();
        assert_eq!(
            object.len(),
            sorted.len(),
            "authority serialization contains an unpinned field"
        );
        let encoded = serde_json::to_string(&sorted).expect("authority binding JSON is finite");
        let digest = Sha256::digest(encoded.as_bytes());
        format!("sha256:{digest:x}")
    }
}

/// Opaque result of a future trusted native verifier. The binding and token
/// constructor are unavailable to renderer IPC and external Rust callers.
/// Until that verifier exists, production can construct only an unavailable
/// broker.
pub(crate) struct VerifiedComputerUseAuthority {
    binding: AuthorityBinding,
}

impl VerifiedComputerUseAuthority {
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self {
            binding: AuthorityBinding::try_from(test_authority_parts())
                .expect("test authority is valid"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseReadinessStatus {
    Unavailable,
    AdmissionOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnavailableControl {
    Worker,
    EffectDispatch,
}

impl Serialize for UnavailableControl {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str("unavailable")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseReadinessProjection {
    pub effect_class: &'static str,
    pub status: ComputerUseReadinessStatus,
    pub policy_version: u8,
    pub authority_bound: bool,
    pub broker_instance_id: Option<String>,
    pub authority_digest: Option<String>,
    pub worker_status: UnavailableControl,
    pub effect_dispatch: UnavailableControl,
    pub can_dispatch: bool,
}

#[derive(Debug)]
enum BrokerAdmission {
    Unavailable,
    AdmissionOnly {
        authority: Box<AuthorityBinding>,
        broker_instance_id: String,
    },
}

#[derive(Debug)]
pub struct ComputerUseBroker {
    admission: BrokerAdmission,
}

impl ComputerUseBroker {
    pub const fn phase_zero() -> Self {
        Self {
            admission: BrokerAdmission::Unavailable,
        }
    }

    /// Native-only promotion seam. No Tauri command calls this function in
    /// milestone 1, and it still creates no worker or effect-dispatch ability.
    pub(crate) fn admit_verified_authority(authority: VerifiedComputerUseAuthority) -> Self {
        Self {
            admission: BrokerAdmission::AdmissionOnly {
                authority: Box::new(authority.binding),
                broker_instance_id: Uuid::new_v4().to_string(),
            },
        }
    }

    pub fn readiness(&self) -> ComputerUseReadinessProjection {
        let (status, authority_bound, broker_instance_id, authority_digest) = match &self.admission
        {
            BrokerAdmission::Unavailable => {
                (ComputerUseReadinessStatus::Unavailable, false, None, None)
            }
            BrokerAdmission::AdmissionOnly {
                authority,
                broker_instance_id,
            } => (
                ComputerUseReadinessStatus::AdmissionOnly,
                true,
                Some(broker_instance_id.clone()),
                Some(authority.digest()),
            ),
        };
        ComputerUseReadinessProjection {
            effect_class: "windows_computer_use",
            status,
            policy_version: COMPUTER_USE_POLICY_VERSION,
            authority_bound,
            broker_instance_id,
            authority_digest,
            worker_status: UnavailableControl::Worker,
            effect_dispatch: UnavailableControl::EffectDispatch,
            can_dispatch: false,
        }
    }
}

impl Default for ComputerUseBroker {
    fn default() -> Self {
        Self::phase_zero()
    }
}

#[cfg(test)]
fn test_authority_parts() -> AuthorityBindingParts {
    AuthorityBindingParts {
        account_id: "account-1".into(),
        project_id: "project-2".into(),
        chat_id: "chat-3".into(),
        session_id: "session-4".into(),
        principal_id: "principal-5".into(),
        policy_id: "policy-6".into(),
        broker_id: "broker-7".into(),
        worker_id: "worker-8".into(),
        account_epoch: 1,
        project_epoch: 2,
        chat_epoch: 3,
        session_epoch: 4,
        principal_epoch: 5,
        policy_epoch: 6,
        broker_epoch: 7,
        worker_epoch: 8,
        readiness_epoch: 9,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority_parts() -> AuthorityBindingParts {
        test_authority_parts()
    }

    #[test]
    fn authority_inventory_matches_the_approved_typescript_contract_exactly() {
        assert_eq!(
            AUTHORITY_STRING_FIELDS,
            [
                "accountId",
                "projectId",
                "chatId",
                "sessionId",
                "principalId",
                "policyId",
                "brokerId",
                "workerId",
            ]
        );
        assert_eq!(
            AUTHORITY_EPOCH_FIELDS,
            [
                "accountEpoch",
                "projectEpoch",
                "chatEpoch",
                "sessionEpoch",
                "principalEpoch",
                "policyEpoch",
                "brokerEpoch",
                "workerEpoch",
                "readinessEpoch",
            ]
        );
    }

    #[test]
    fn native_admission_binds_the_exact_contract_digest_without_enabling_dispatch() {
        let authority = AuthorityBinding::try_from(authority_parts()).expect("valid authority");
        assert_eq!(
            authority.digest(),
            "sha256:9ec2757b0239b03e824b911c3ae172547d95f1fb2290e62bd54820cca26d329a"
        );

        let readiness =
            ComputerUseBroker::admit_verified_authority(VerifiedComputerUseAuthority::for_test())
                .readiness();
        assert_eq!(readiness.status, ComputerUseReadinessStatus::AdmissionOnly);
        assert!(readiness.authority_bound);
        assert!(readiness.broker_instance_id.is_some());
        assert_eq!(
            readiness.authority_digest.as_deref(),
            Some("sha256:9ec2757b0239b03e824b911c3ae172547d95f1fb2290e62bd54820cca26d329a")
        );
        assert!(!readiness.can_dispatch);
    }

    #[test]
    fn authority_rejects_empty_or_oversized_ids_and_non_typescript_epochs() {
        let mut empty = authority_parts();
        empty.account_id.clear();
        assert_eq!(
            AuthorityBinding::try_from(empty),
            Err(AuthorityBindingError::InvalidIdentifier("accountId"))
        );

        let mut oversized = authority_parts();
        oversized.worker_id = "x".repeat(MAX_AUTHORITY_IDENTIFIER_BYTES + 1);
        assert_eq!(
            AuthorityBinding::try_from(oversized),
            Err(AuthorityBindingError::InvalidIdentifier("workerId"))
        );

        let mut zero = authority_parts();
        zero.policy_epoch = 0;
        assert_eq!(
            AuthorityBinding::try_from(zero),
            Err(AuthorityBindingError::InvalidEpoch("policyEpoch"))
        );

        let mut unsafe_integer = authority_parts();
        unsafe_integer.readiness_epoch = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            AuthorityBinding::try_from(unsafe_integer),
            Err(AuthorityBindingError::InvalidEpoch("readinessEpoch"))
        );
    }
}
