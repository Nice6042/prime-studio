use super::generated::{
    HarnessCapability, HarnessCompatibility, HarnessUnavailableReason, RuntimeIdentity,
    UnavailableFeature,
};

const PROFILE_ID: &str = "prime-agent-daemon-v7-schema13-816309b1cd50";
const PACKAGE_VERSION: &str = "0.7.1";
const PACKAGE_DIGEST: &str =
    "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900";
const ENTRYPOINT_DIGEST: &str =
    "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b";
const PROTOCOL_NAME: &str = "prime-agent.daemon";
const PROTOCOL_VERSION: u16 = 7;
const SCHEMA_REVISION: u16 = 13;
const SCHEMA_ID: &str = "protocol-7-schema-13-816309b1cd50";

const MANDATORY: &[HarnessCapability] = &[
    HarnessCapability::AttachSnapshot,
    HarnessCapability::EventSequence,
    HarnessCapability::ResidentSessions,
    HarnessCapability::SessionInputAdmission,
    HarnessCapability::ModelCatalog,
];

const SUPPORTED: &[HarnessCapability] = &[
    HarnessCapability::AttachSnapshot,
    HarnessCapability::ChunkedSnapshot,
    HarnessCapability::DeleteChild,
    HarnessCapability::EventSequence,
    HarnessCapability::ExtensionUi,
    HarnessCapability::HeartbeatCatalog,
    HarnessCapability::HeartbeatManagement,
    HarnessCapability::ModelCatalog,
    HarnessCapability::PromptAdmissionCancellation,
    HarnessCapability::QueueManagement,
    HarnessCapability::ResidentSessions,
    HarnessCapability::ResourceSnapshot,
    HarnessCapability::SessionInputAdmission,
    HarnessCapability::SideQuestionTranscript,
    HarnessCapability::TransientBash,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompatibilityStatus {
    Ready,
    Degraded,
    ReadOnly,
    Unavailable,
}

impl HarnessCompatibility {
    pub const fn status(&self) -> CompatibilityStatus {
        match self {
            Self::Ready { .. } => CompatibilityStatus::Ready,
            Self::Degraded { .. } => CompatibilityStatus::Degraded,
            Self::ReadOnly { .. } => CompatibilityStatus::ReadOnly,
            Self::Unavailable { .. } => CompatibilityStatus::Unavailable,
        }
    }
}

fn unavailable(reason: HarnessUnavailableReason) -> HarnessCompatibility {
    HarnessCompatibility::Unavailable { reason }
}

pub fn decide_compatibility(runtime: &RuntimeIdentity) -> HarnessCompatibility {
    if runtime.package_name != "prime-agent"
        || runtime.package_version != PACKAGE_VERSION
        || runtime.package_digest != PACKAGE_DIGEST
        || runtime.entrypoint_digest != ENTRYPOINT_DIGEST
    {
        return unavailable(HarnessUnavailableReason::RuntimeIdentityMismatch);
    }
    if runtime.protocol_name != PROTOCOL_NAME || runtime.protocol_version != PROTOCOL_VERSION {
        return unavailable(HarnessUnavailableReason::UnsupportedProtocol);
    }
    if runtime.schema_revision != SCHEMA_REVISION || runtime.schema_id != SCHEMA_ID {
        return unavailable(HarnessUnavailableReason::UnsupportedSchema);
    }
    if MANDATORY
        .iter()
        .any(|capability| !runtime.capabilities.contains(capability))
    {
        return HarnessCompatibility::ReadOnly {
            reason: HarnessUnavailableReason::MissingMandatoryCapability,
            runtime: Some(runtime.clone()),
        };
    }

    let capabilities: Vec<HarnessCapability> = SUPPORTED
        .iter()
        .filter(|capability| runtime.capabilities.contains(capability))
        .cloned()
        .collect();
    let unavailable: Vec<UnavailableFeature> = SUPPORTED
        .iter()
        .filter(|capability| !runtime.capabilities.contains(capability))
        .cloned()
        .map(|capability| UnavailableFeature {
            capability,
            reason: HarnessUnavailableReason::MissingMandatoryCapability,
        })
        .collect();
    if unavailable.is_empty() {
        HarnessCompatibility::Ready {
            profile: PROFILE_ID.to_owned(),
            capabilities,
        }
    } else {
        HarnessCompatibility::Degraded {
            profile: PROFILE_ID.to_owned(),
            capabilities,
            unavailable,
        }
    }
}
