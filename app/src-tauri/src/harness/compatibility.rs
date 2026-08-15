use super::generated::{
    HarnessCapability, HarnessCompatibility, HarnessUnavailableReason, RuntimeIdentity,
    UnavailableFeature,
};
use super::profiles::{profile_for_package_identity, RuntimeProfile};

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

fn compatibility_for_profile(
    runtime: &RuntimeIdentity,
    profile: &RuntimeProfile,
) -> HarnessCompatibility {
    if profile
        .mandatory_capabilities
        .iter()
        .any(|capability| !runtime.capabilities.contains(capability))
    {
        return HarnessCompatibility::ReadOnly {
            reason: HarnessUnavailableReason::MissingMandatoryCapability,
            runtime: Some(runtime.clone()),
        };
    }

    let capabilities: Vec<HarnessCapability> = profile
        .supported_capabilities
        .iter()
        .filter(|capability| runtime.capabilities.contains(capability))
        .cloned()
        .collect();
    let unavailable: Vec<UnavailableFeature> = profile
        .supported_capabilities
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
            profile: profile.id.to_owned(),
            capabilities,
        }
    } else {
        HarnessCompatibility::Degraded {
            profile: profile.id.to_owned(),
            capabilities,
            unavailable,
        }
    }
}

pub fn decide_compatibility(runtime: &RuntimeIdentity) -> HarnessCompatibility {
    if runtime.package_name != "prime-agent" {
        return unavailable(HarnessUnavailableReason::RuntimeIdentityMismatch);
    }
    let Some(profile) = profile_for_package_identity(
        &runtime.package_version,
        &runtime.package_digest,
        &runtime.entrypoint_digest,
    ) else {
        return unavailable(HarnessUnavailableReason::RuntimeIdentityMismatch);
    };
    if runtime.protocol_name != profile.protocol_name
        || runtime.protocol_version != profile.protocol_version
    {
        return unavailable(HarnessUnavailableReason::UnsupportedProtocol);
    }
    if runtime.schema_revision != profile.schema_revision || runtime.schema_id != profile.schema_id {
        return unavailable(HarnessUnavailableReason::UnsupportedSchema);
    }
    compatibility_for_profile(runtime, profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::profiles::{DAEMON_V7_SCHEMA13, DAEMON_V7_SCHEMA16};

    fn runtime(profile: &RuntimeProfile) -> RuntimeIdentity {
        RuntimeIdentity {
            package_name: "prime-agent".to_owned(),
            package_version: profile.package_version.to_owned(),
            package_digest: profile.package_digest.to_owned(),
            entrypoint_digest: profile.entrypoint_digest.to_owned(),
            protocol_name: profile.protocol_name.to_owned(),
            protocol_version: profile.protocol_version,
            schema_revision: profile.schema_revision,
            schema_id: profile.schema_id.to_owned(),
            capabilities: profile.supported_capabilities.to_vec(),
        }
    }

    #[test]
    fn both_reviewed_profiles_are_ready_only_for_their_exact_identity() {
        for profile in [&DAEMON_V7_SCHEMA16, &DAEMON_V7_SCHEMA13] {
            assert_eq!(
                decide_compatibility(&runtime(profile)),
                HarnessCompatibility::Ready {
                    profile: profile.id.to_owned(),
                    capabilities: profile.supported_capabilities.to_vec(),
                }
            );
        }
    }

    #[test]
    fn package_protocol_and_schema_mismatches_have_distinct_reasons() {
        let exact = runtime(&DAEMON_V7_SCHEMA16);
        assert_eq!(
            decide_compatibility(&RuntimeIdentity {
                package_digest: DAEMON_V7_SCHEMA13.package_digest.to_owned(),
                ..exact.clone()
            }),
            unavailable(HarnessUnavailableReason::RuntimeIdentityMismatch)
        );
        assert_eq!(
            decide_compatibility(&RuntimeIdentity {
                protocol_version: 8,
                ..exact.clone()
            }),
            unavailable(HarnessUnavailableReason::UnsupportedProtocol)
        );
        assert_eq!(
            decide_compatibility(&RuntimeIdentity {
                schema_revision: DAEMON_V7_SCHEMA13.schema_revision,
                schema_id: DAEMON_V7_SCHEMA13.schema_id.to_owned(),
                ..exact
            }),
            unavailable(HarnessUnavailableReason::UnsupportedSchema)
        );
    }

    #[test]
    fn missing_mandatory_capability_is_read_only() {
        let mut observed = runtime(&DAEMON_V7_SCHEMA16);
        observed
            .capabilities
            .retain(|capability| capability != &HarnessCapability::ModelCatalog);
        assert_eq!(
            decide_compatibility(&observed),
            HarnessCompatibility::ReadOnly {
                reason: HarnessUnavailableReason::MissingMandatoryCapability,
                runtime: Some(observed),
            }
        );
    }

    #[test]
    fn missing_optional_capability_degrades_only_that_surface() {
        let mut observed = runtime(&DAEMON_V7_SCHEMA16);
        observed
            .capabilities
            .retain(|capability| capability != &HarnessCapability::ExtensionUi);
        assert_eq!(
            decide_compatibility(&observed),
            HarnessCompatibility::Degraded {
                profile: DAEMON_V7_SCHEMA16.id.to_owned(),
                capabilities: observed.capabilities.clone(),
                unavailable: vec![UnavailableFeature {
                    capability: HarnessCapability::ExtensionUi,
                    reason: HarnessUnavailableReason::MissingMandatoryCapability,
                }],
            }
        );
    }
}
