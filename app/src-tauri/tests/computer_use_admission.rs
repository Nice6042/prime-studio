use prime_studio_lib::computer_use::{
    ComputerUseBroker, ComputerUseReadinessStatus, COMPUTER_USE_POLICY_VERSION,
};
use serde_json::json;

#[test]
fn phase_zero_broker_projects_only_honest_unavailability() {
    let broker = ComputerUseBroker::phase_zero();
    let projection = serde_json::to_value(broker.readiness()).expect("projection serializes");

    assert_eq!(
        projection,
        json!({
            "effectClass": "windows_computer_use",
            "status": "unavailable",
            "policyVersion": 3,
            "authorityBound": false,
            "brokerInstanceId": null,
            "authorityDigest": null,
            "workerStatus": "unavailable",
            "effectDispatch": "unavailable",
            "canDispatch": false,
        })
    );
    assert_eq!(
        broker.readiness().status,
        ComputerUseReadinessStatus::Unavailable
    );
    assert_eq!(COMPUTER_USE_POLICY_VERSION, 3);
    assert!(!broker.readiness().can_dispatch);
}
