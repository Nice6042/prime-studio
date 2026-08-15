use super::generated::{HarnessCapability, RuntimeIdentity};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeProfile {
    pub id: &'static str,
    pub package_version: &'static str,
    pub package_digest: &'static str,
    pub entrypoint_digest: &'static str,
    pub daemon_entrypoint_digest: &'static str,
    pub protocol_name: &'static str,
    pub protocol_version: u16,
    pub schema_revision: u16,
    pub schema_id: &'static str,
    pub mandatory_capabilities: &'static [HarnessCapability],
    pub supported_capabilities: &'static [HarnessCapability],
}

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

pub static DAEMON_V7_SCHEMA16: RuntimeProfile = RuntimeProfile {
    id: "prime-agent-daemon-v7-schema16-1bcb9e7f1a49",
    package_version: "0.7.2",
    package_digest: "sha256:0b45bc86527fcdb73dae76d319f6f50f6d40827a63614303664a57e8fe41c8cf",
    entrypoint_digest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
    daemon_entrypoint_digest: "sha256:a6144570af2554b537530372cb3080b4f7713875e8d9d4677e453bb1040f1ec5",
    protocol_name: "prime-agent.daemon",
    protocol_version: 7,
    schema_revision: 16,
    schema_id: "protocol-7-schema-16-1bcb9e7f1a49",
    mandatory_capabilities: MANDATORY,
    supported_capabilities: SUPPORTED,
};

pub static DAEMON_V7_SCHEMA13: RuntimeProfile = RuntimeProfile {
    id: "prime-agent-daemon-v7-schema13-816309b1cd50",
    package_version: "0.7.1",
    package_digest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
    entrypoint_digest: "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
    daemon_entrypoint_digest: "sha256:16e2324a4e3aa13305c437168d44d7395bab317e292218a52d1c61a7ebdf0993",
    protocol_name: "prime-agent.daemon",
    protocol_version: 7,
    schema_revision: 13,
    schema_id: "protocol-7-schema-13-816309b1cd50",
    mandatory_capabilities: MANDATORY,
    supported_capabilities: SUPPORTED,
};

pub static RUNTIME_PROFILES: [&RuntimeProfile; 2] = [&DAEMON_V7_SCHEMA16, &DAEMON_V7_SCHEMA13];

pub fn profile_for_package_identity(
    package_version: &str,
    package_digest: &str,
    entrypoint_digest: &str,
) -> Option<&'static RuntimeProfile> {
    RUNTIME_PROFILES.iter().copied().find(|profile| {
        package_version == profile.package_version
            && package_digest == profile.package_digest
            && entrypoint_digest == profile.entrypoint_digest
    })
}

pub fn profile_for_runtime_identity(runtime: &RuntimeIdentity) -> Option<&'static RuntimeProfile> {
    let profile = profile_for_package_identity(
        &runtime.package_version,
        &runtime.package_digest,
        &runtime.entrypoint_digest,
    )?;
    (runtime.package_name == "prime-agent"
        && runtime.protocol_name == profile.protocol_name
        && runtime.protocol_version == profile.protocol_version
        && runtime.schema_revision == profile.schema_revision
        && runtime.schema_id == profile.schema_id)
        .then_some(profile)
}

pub fn profile_for_id(id: &str) -> Option<&'static RuntimeProfile> {
    RUNTIME_PROFILES
        .iter()
        .copied()
        .find(|profile| profile.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn reviewed_profiles_are_exact_unique_and_newest_first() {
        assert_eq!(
            RUNTIME_PROFILES
                .iter()
                .map(|profile| profile.package_version)
                .collect::<Vec<_>>(),
            vec!["0.7.2", "0.7.1"]
        );
        assert_ne!(RUNTIME_PROFILES[0].id, RUNTIME_PROFILES[1].id);
        assert_ne!(
            RUNTIME_PROFILES[0].package_digest,
            RUNTIME_PROFILES[1].package_digest
        );
    }

    #[test]
    fn full_identity_selects_only_the_matching_profile() {
        let schema16 = runtime(&DAEMON_V7_SCHEMA16);
        assert_eq!(
            profile_for_runtime_identity(&schema16).map(|profile| profile.id),
            Some(DAEMON_V7_SCHEMA16.id)
        );
        assert!(profile_for_runtime_identity(&RuntimeIdentity {
            schema_revision: DAEMON_V7_SCHEMA13.schema_revision,
            schema_id: DAEMON_V7_SCHEMA13.schema_id.to_owned(),
            ..schema16
        })
        .is_none());
    }

    #[test]
    fn profile_ids_round_trip() {
        for profile in RUNTIME_PROFILES {
            assert_eq!(profile_for_id(profile.id), Some(profile));
        }
    }
}
