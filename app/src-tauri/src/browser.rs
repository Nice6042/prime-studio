//! Native browser admission foundation.
//!
//! Milestone 1 deliberately has no worker, lease, completion evidence,
//! capture/redaction, ledger, persistence, or dispatch API. The broker can
//! describe and validate its closed read-only admission contract, while every
//! executable browser capability stays unavailable even if another authority
//! class is attested in the future.

use serde::{Deserialize, Serialize};

use crate::authority::SecurityReadiness;

pub const BROWSER_ADMISSION_CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserReadOnlyIntentKind {
    Inspect,
    Screenshot,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserIntentAdmissionRequest {
    pub action_type: BrowserReadOnlyIntentKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSecurityStatus {
    contract_version: u32,
    authority: &'static str,
    admission_readiness: &'static str,
    executor_readiness: &'static str,
    authority_gate_readiness: &'static str,
    dispatch_available: bool,
    reason: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIntentAdmission {
    contract_version: u32,
    authority: &'static str,
    action_type: BrowserReadOnlyIntentKind,
    admission_readiness: &'static str,
    executor_readiness: &'static str,
    authority_gate_readiness: &'static str,
    dispatch_available: bool,
    reason: &'static str,
}

#[derive(Debug, Default)]
pub struct BrowserBroker;

impl BrowserBroker {
    pub const fn admission_only() -> Self {
        Self
    }

    pub const fn security_status(
        &self,
        authority_gate_readiness: SecurityReadiness,
    ) -> BrowserSecurityStatus {
        BrowserSecurityStatus {
            contract_version: BROWSER_ADMISSION_CONTRACT_VERSION,
            authority: "native",
            admission_readiness: SecurityReadiness::AdmissionOnly.as_str(),
            executor_readiness: SecurityReadiness::Unavailable.as_str(),
            authority_gate_readiness: authority_gate_readiness.as_str(),
            dispatch_available: false,
            reason: "native_browser_executor_unavailable",
        }
    }

    pub const fn check_intent_admission(
        &self,
        authority_gate_readiness: SecurityReadiness,
        request: BrowserIntentAdmissionRequest,
    ) -> BrowserIntentAdmission {
        BrowserIntentAdmission {
            contract_version: BROWSER_ADMISSION_CONTRACT_VERSION,
            authority: "native",
            action_type: request.action_type,
            admission_readiness: SecurityReadiness::AdmissionOnly.as_str(),
            executor_readiness: SecurityReadiness::Unavailable.as_str(),
            authority_gate_readiness: authority_gate_readiness.as_str(),
            dispatch_available: false,
            reason: "native_browser_executor_unavailable",
        }
    }
}
