use prime_studio_lib::authority::SecurityReadiness;
use prime_studio_lib::browser::{
    BrowserBroker, BrowserIntentAdmissionRequest, BrowserReadOnlyIntentKind,
};
use serde_json::{json, to_value};

#[test]
fn native_broker_never_projects_effect_dispatch_from_authority_readiness_alone() {
    let broker = BrowserBroker::admission_only();

    for authority_readiness in [
        SecurityReadiness::Unavailable,
        SecurityReadiness::AdmissionOnly,
        SecurityReadiness::Enforced,
    ] {
        assert_eq!(
            to_value(broker.security_status(authority_readiness)).unwrap(),
            json!({
                "contractVersion": 1,
                "authority": "native",
                "admissionReadiness": "admission_only",
                "executorReadiness": "unavailable",
                "authorityGateReadiness": authority_readiness.as_str(),
                "dispatchAvailable": false,
                "reason": "native_browser_executor_unavailable"
            })
        );
    }
}

#[test]
fn read_only_intent_admission_returns_no_lease_or_effect_authority() {
    let broker = BrowserBroker::admission_only();

    for action_type in [
        BrowserReadOnlyIntentKind::Inspect,
        BrowserReadOnlyIntentKind::Screenshot,
    ] {
        let projection = to_value(broker.check_intent_admission(
            SecurityReadiness::Enforced,
            BrowserIntentAdmissionRequest { action_type },
        ))
        .unwrap();
        assert_eq!(
            projection,
            json!({
                "contractVersion": 1,
                "authority": "native",
                "actionType": match action_type {
                    BrowserReadOnlyIntentKind::Inspect => "inspect",
                    BrowserReadOnlyIntentKind::Screenshot => "screenshot",
                },
                "admissionReadiness": "admission_only",
                "executorReadiness": "unavailable",
                "authorityGateReadiness": "enforced",
                "dispatchAvailable": false,
                "reason": "native_browser_executor_unavailable"
            })
        );
        let object = projection.as_object().unwrap();
        for forbidden in [
            "allowed",
            "decisionId",
            "evidence",
            "lease",
            "leaseId",
            "startToken",
        ] {
            assert!(
                !object.contains_key(forbidden),
                "forbidden authority field {forbidden}"
            );
        }
    }
}

#[test]
fn read_only_intent_request_is_closed_to_unknown_actions_and_fields() {
    for rejected in [
        json!({ "actionType": "click" }),
        json!({ "actionType": "inspect", "principalId": "renderer-minted" }),
        json!({ "actionType": "screenshot", "workerEpoch": 7 }),
        json!({}),
    ] {
        assert!(
            serde_json::from_value::<BrowserIntentAdmissionRequest>(rejected).is_err(),
            "renderer input must not expand the closed read-only request"
        );
    }
}
