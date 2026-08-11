use prime_studio_lib::authority::{
    authorize_tauri_command, AuthorityError, AuthorityGate, EffectClass, SecurityReadiness,
    TauriCommand,
};
use prime_studio_lib::harness::compatibility::{decide_compatibility, CompatibilityStatus};
use prime_studio_lib::harness::generated::{
    HarnessCapability, HarnessCompatibility, HarnessUnavailableReason, RuntimeIdentity,
};

fn known_runtime() -> RuntimeIdentity {
    RuntimeIdentity {
        package_name: "prime-agent".to_owned(),
        package_version: "0.7.1".to_owned(),
        package_digest: "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900"
            .to_owned(),
        entrypoint_digest:
            "sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b".to_owned(),
        protocol_name: "prime-agent.daemon".to_owned(),
        protocol_version: 7,
        schema_revision: 13,
        schema_id: "protocol-7-schema-13-816309b1cd50".to_owned(),
        capabilities: vec![
            HarnessCapability::AttachSnapshot,
            HarnessCapability::EventSequence,
            HarnessCapability::ResidentSessions,
            HarnessCapability::SessionInputAdmission,
            HarnessCapability::ModelCatalog,
            HarnessCapability::ExtensionUi,
            HarnessCapability::ChunkedSnapshot,
            HarnessCapability::PromptAdmissionCancellation,
            HarnessCapability::QueueManagement,
            HarnessCapability::ResourceSnapshot,
            HarnessCapability::DeleteChild,
            HarnessCapability::HeartbeatCatalog,
            HarnessCapability::HeartbeatManagement,
            HarnessCapability::SideQuestionTranscript,
            HarnessCapability::TransientBash,
        ],
    }
}

#[test]
fn exact_complete_runtime_is_ready() {
    assert_eq!(
        decide_compatibility(&known_runtime()).status(),
        CompatibilityStatus::Ready
    );
}

#[test]
fn optional_capability_loss_is_degraded() {
    let mut runtime = known_runtime();
    runtime
        .capabilities
        .retain(|capability| *capability != HarnessCapability::ExtensionUi);
    assert_eq!(
        decide_compatibility(&runtime).status(),
        CompatibilityStatus::Degraded
    );
}

#[test]
fn mandatory_capability_loss_is_read_only() {
    let mut runtime = known_runtime();
    runtime
        .capabilities
        .retain(|capability| *capability != HarnessCapability::EventSequence);
    assert!(matches!(
        decide_compatibility(&runtime),
        HarnessCompatibility::ReadOnly {
            reason: HarnessUnavailableReason::MissingMandatoryCapability,
            ..
        }
    ));
}

#[test]
fn unknown_schema_or_identity_is_unavailable() {
    let mut schema = known_runtime();
    schema.schema_revision = 14;
    assert_eq!(
        decide_compatibility(&schema).status(),
        CompatibilityStatus::Unavailable
    );

    let mut digest = known_runtime();
    digest.entrypoint_digest = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        decide_compatibility(&digest).status(),
        CompatibilityStatus::Unavailable
    );

    let mut version = known_runtime();
    version.package_version = "0.7.2".to_owned();
    assert_eq!(
        decide_compatibility(&version).status(),
        CompatibilityStatus::Unavailable
    );
}

#[test]
fn ready_compatibility_cannot_mint_process_authority() {
    assert!(matches!(
        decide_compatibility(&known_runtime()),
        HarnessCompatibility::Ready { .. }
    ));
    assert_eq!(
        authorize_tauri_command(&AuthorityGate::phase_zero(), TauriCommand::StartSession),
        Err(AuthorityError::ReadinessNotEnforced {
            effect: EffectClass::PrimeSessionProcess,
            readiness: SecurityReadiness::Unavailable,
        })
    );
}
