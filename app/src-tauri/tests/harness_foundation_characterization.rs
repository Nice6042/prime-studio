use prime_studio_lib::authority::{
    authorize_tauri_command, authorize_tauri_invoke, AuthorityError, AuthorityGate,
    EffectClass, SecurityReadiness, TauriCommand,
};
use serde_json::json;

#[test]
fn phase_zero_rejects_every_existing_harness_execution_entry() {
    let gate = AuthorityGate::phase_zero();

    for command in [
        TauriCommand::StartSession,
        TauriCommand::AttachSession,
        TauriCommand::FleetList,
    ] {
        assert!(matches!(
            authorize_tauri_command(&gate, command),
            Err(AuthorityError::ReadinessNotEnforced {
                readiness: SecurityReadiness::Unavailable,
                ..
            })
        ));
    }

    assert!(matches!(
        authorize_tauri_invoke(
            &gate,
            TauriCommand::SendRpc.name(),
            &json!({ "command": { "type": "get_state" } }),
        ),
        Err(AuthorityError::ReadinessNotEnforced {
            readiness: SecurityReadiness::Unavailable,
            ..
        })
    ));
}

#[test]
fn renderer_payload_cannot_supply_runtime_readiness() {
    let gate = AuthorityGate::phase_zero();
    let hostile_payload = json!({
        "compatibility": { "status": "ready" },
        "readiness": "enforced",
        "authority": { "primeSessionProcess": true },
    });

    assert!(matches!(
        authorize_tauri_invoke(&gate, "start_session", &hostile_payload),
        Err(AuthorityError::ReadinessNotEnforced {
            effect: EffectClass::PrimeSessionProcess,
            readiness: SecurityReadiness::Unavailable,
        })
    ));

    assert!(matches!(
        authorize_tauri_invoke(&gate, "harness_bootstrap", &hostile_payload),
        Err(AuthorityError::UnknownTauriCommand { .. })
    ));
}

#[test]
fn compatibility_evidence_is_not_an_execution_authority() {
    let gate = AuthorityGate::phase_zero();

    for effect in [
        EffectClass::PrimeCliProcess,
        EffectClass::PrimeSessionProcess,
        EffectClass::PrimeRpcTurn,
    ] {
        assert_eq!(gate.readiness(effect), SecurityReadiness::Unavailable);
        assert_eq!(
            gate.require(effect),
            Err(AuthorityError::ReadinessNotEnforced {
                effect,
                readiness: SecurityReadiness::Unavailable,
            })
        );
    }
}
