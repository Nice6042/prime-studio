#![cfg(feature = "test-support-bin")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use prime_studio_lib::harness::broker::{
    AttachRequest, BrokerState, HarnessBroker, InspectorRequest, RefreshSessionRequest,
    SessionCommandRequest, SessionOwnership, StudioOperationRequest,
};
use prime_studio_lib::harness::generated::{
    ChildAgentStatus, CommandOutcome, HarnessCursor, HarnessStudioAction, RootSessionState,
    SessionCommandKind, StudioOperationStatus,
};
use prime_studio_lib::harness::sidecar::{SidecarSupervisor, VerifiedSidecarSpec};
use sha2::{Digest, Sha256};

const RUNTIME_DIGEST: &str =
    "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900";
const PROFILE: &str = "prime-agent-daemon-v7-schema13-816309b1cd50";

fn digest(path: &Path) -> String {
    format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap()))
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn ensure_compiled_sidecar(app: &Path) {
    let entry = app.join("harness-sidecar/dist/src/index.js");
    if entry.is_file() {
        return;
    }
    #[cfg(windows)]
    let npm = "npm.cmd";
    #[cfg(not(windows))]
    let npm = "npm";
    let status = Command::new(npm)
        .args(["run", "build:harness-sidecar"])
        .current_dir(app)
        .status()
        .expect("npm must be available for the sidecar integration test");
    assert!(status.success(), "sidecar compilation must succeed");
}

fn node_executable() -> PathBuf {
    if let Some(configured) = std::env::var_os("PRIME_STUDIO_TEST_NODE") {
        return PathBuf::from(configured);
    }
    #[cfg(windows)]
    {
        let output = Command::new("where.exe")
            .arg("node.exe")
            .output()
            .expect("node lookup must run");
        assert!(output.status.success(), "node must be installed");
        let first = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim()
            .to_owned();
        PathBuf::from(first)
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("sh")
            .args(["-c", "command -v node"])
            .output()
            .expect("node lookup must run");
        assert!(output.status.success(), "node must be installed");
        PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
    }
}

#[test]
fn tauri_broker_bootstraps_through_the_real_sidecar_against_a_fake_daemon() {
    let app = app_root();
    ensure_compiled_sidecar(&app);
    let entry = app.join("harness-sidecar/dist/src/index.js");
    let scenario = app.join("harness-sidecar/test/fixtures/fake-daemon/scenario-manifest.json");
    let resources = [
        "compatibility.js",
        "fakeDaemonScenario.js",
        "framing.js",
        "index.js",
        "redaction.js",
        "runtimeDiscovery.js",
        "runtimeClosure.js",
        "reviewedPrimeAdapter.js",
        "primeDaemonBridge.js",
        "studioHarnessOperations.js",
        "profiles/daemon-v7-schema13.js",
        "vendor/package.json",
        "vendor/prime-daemon-adapter-v0.7.1.mjs",
    ]
    .into_iter()
    .map(|relative| app.join("harness-sidecar/dist/src").join(relative))
    .chain(std::iter::once(scenario.clone()))
    .map(|path| {
        let hash = digest(&path);
        (path, hash)
    })
    .collect();
    let node = node_executable();
    let spec = VerifiedSidecarSpec::for_tests(
        node.clone(),
        digest(&node),
        vec![
            entry.display().to_string(),
            "--fixture-scenario".to_owned(),
            scenario.display().to_string(),
        ],
        resources,
    )
    .unwrap();
    let sidecar = SidecarSupervisor::start(spec).unwrap();
    let mut broker = HarnessBroker::new(
        sidecar,
        RUNTIME_DIGEST.to_owned(),
        PROFILE.to_owned(),
        vec![(
            "session-e2e".to_owned(),
            SessionOwnership {
                account_id: Some("account-e2e".to_owned()),
                project_id: "project:personal".to_owned(),
                chat_id: "chat-e2e".to_owned(),
            },
        )],
        None,
    )
    .unwrap();

    let projection = tauri::async_runtime::block_on(broker.bootstrap()).unwrap();
    assert_eq!(broker.state(), BrokerState::Live);
    assert_eq!(projection.sessions.len(), 1);
    let session = &projection.sessions[0];
    assert_eq!(session.session_id, "session-e2e");
    assert_eq!(session.state, RootSessionState::Working);
    assert_eq!(session.parent_messages.len(), 2);
    assert_eq!(session.children.len(), 2);
    assert_eq!(session.children[0].status, ChildAgentStatus::Running);
    assert_eq!(session.queue.len(), 1);
    assert_eq!(session.tools.len(), 1);
    assert_eq!(session.resources.len(), 1);
    assert_eq!(session.usage.total_tokens, 2_400);
    let attached = tauri::async_runtime::block_on(broker.attach(AttachRequest {
        session_id: "session-e2e".to_owned(),
    }))
    .unwrap();
    assert_eq!(attached.cursor.sequence, 8);
    let submitted = tauri::async_runtime::block_on(broker.submit(SessionCommandRequest {
        session_id: "session-e2e".to_owned(),
        command_id: "command-rust-1".to_owned(),
        expected_cursor: HarnessCursor {
            runtime_generation: "fake-generation-1".to_owned(),
            sequence: 8,
        },
        kind: SessionCommandKind::Prompt,
        text: "Verify the Rust broker".to_owned(),
    }))
    .unwrap();
    assert_eq!(submitted.outcome, CommandOutcome::Accepted);
    assert_eq!(submitted.session.cursor.sequence, 9);
    assert_eq!(submitted.session.parent_messages.len(), 4);
    let live_refreshed =
        tauri::async_runtime::block_on(broker.refresh_session(RefreshSessionRequest {
            session_id: "session-e2e".to_owned(),
            known_cursor: submitted.session.cursor.clone(),
        }))
        .expect("the real Rust broker must continue polling from the direct-command cursor");
    assert_eq!(live_refreshed.cursor.sequence, 10);
    let inspector = tauri::async_runtime::block_on(broker.inspector(InspectorRequest {
        session_id: "session-e2e".to_owned(),
    }))
    .unwrap();
    let inspector: serde_json::Value = serde_json::from_str(&inspector).unwrap();
    assert_eq!(inspector["context"]["usedTokens"], 2_418);
    let refreshed =
        tauri::async_runtime::block_on(broker.execute_operation(StudioOperationRequest {
            session_id: "session-e2e".to_owned(),
            operation_id: "operation-rust-1".to_owned(),
            action: HarnessStudioAction::UsageCurrentRefresh,
            payload_json: r#"{"sessionId":"session-e2e"}"#.to_owned(),
            expected_cursor: None,
            idempotency_key: None,
        }))
        .unwrap();
    assert_eq!(refreshed.status, StudioOperationStatus::Updated);
    assert_eq!(refreshed.session.unwrap().cursor.sequence, 11);
    assert_eq!(broker.recovery_record(1).unwrap().sessions.len(), 1);
    broker.close();
}
