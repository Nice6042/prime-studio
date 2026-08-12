use prime_studio_lib::harness::broker::{
    AttachRequest, BrokerState, HarnessBroker, ProjectionFreshness, RefreshSessionRequest,
    SessionCommandRequest, SessionOwnership, StudioOperationRequest,
};
use prime_studio_lib::harness::generated::{
    ChildAgentStatus, ChildAgentSummary, CurrentChatUsage, HarnessCursor, HarnessEvent,
    HarnessStudioAction, RootSessionSnapshot, RootSessionState, SessionCommandKind,
    StudioOperationStatus,
};
use prime_studio_lib::harness::recovery::{RecoveredSession, RecoveryRecord};
use prime_studio_lib::harness::sidecar::{HarnessError, SidecarSupervisor, VerifiedSidecarSpec};
use sha2::{Digest, Sha256};

fn ownership(session: &str, project: &str, chat: &str) -> (String, SessionOwnership) {
    (
        session.to_owned(),
        SessionOwnership {
            account_id: Some("account".to_owned()),
            project_id: project.to_owned(),
            chat_id: chat.to_owned(),
        },
    )
}

fn fake_sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-harness-sidecar"))
}

fn digest(path: &Path) -> String {
    format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap()))
}

fn sidecar(mode: &str) -> prime_studio_lib::harness::sidecar::SidecarHandle {
    let executable = fake_sidecar();
    let spec = VerifiedSidecarSpec::for_tests(
        executable.clone(),
        digest(&executable),
        vec![mode.to_owned()],
        Vec::new(),
    )
    .unwrap();
    SidecarSupervisor::start(spec).unwrap()
}

fn snapshot(
    session: &str,
    project: &str,
    chat: &str,
    generation: &str,
    sequence: u64,
) -> RootSessionSnapshot {
    RootSessionSnapshot {
        session_id: session.to_owned(),
        account_id: Some("account".to_owned()),
        project_id: project.to_owned(),
        chat_id: chat.to_owned(),
        cursor: HarnessCursor {
            runtime_generation: generation.to_owned(),
            sequence,
        },
        state: RootSessionState::Idle,
        parent_messages: Vec::new(),
        children: Vec::new(),
        queue: Vec::new(),
        tools: Vec::new(),
        resources: Vec::new(),
        usage: CurrentChatUsage {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 0,
            cost: None,
        },
    }
}

fn live_broker() -> HarnessBroker {
    let mut broker =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    broker.begin_snapshot(1).unwrap();
    let admitted = broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 1))
        .unwrap();
    broker.apply_snapshot(admitted).unwrap();
    broker.finish_snapshot().unwrap();
    broker
}

fn live_quarantine_broker() -> HarnessBroker {
    let mut broker = HarnessBroker::new(
        sidecar("broker-quarantine"),
        "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900".to_owned(),
        "prime-agent-daemon-v7-schema13-816309b1cd50".to_owned(),
        vec![
            ownership("root-a", "project-a", "chat-a"),
            ownership("root-b", "project-b", "chat-b"),
        ],
        None,
    )
    .unwrap();
    tauri::async_runtime::block_on(broker.bootstrap()).unwrap();
    broker
}

#[test]
fn refresh_generation_change_rebootstraps_and_retires_the_old_generation() {
    let mut broker = HarnessBroker::new(
        sidecar("broker-generation-transition"),
        "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900".to_owned(),
        "prime-agent-daemon-v7-schema13-816309b1cd50".to_owned(),
        vec![ownership("root", "project", "chat")],
        None,
    )
    .unwrap();
    let initial = tauri::async_runtime::block_on(broker.bootstrap()).unwrap();
    let prior = initial.sessions[0].cursor.clone();
    assert_eq!(prior.runtime_generation, "generation");

    let refreshed = tauri::async_runtime::block_on(broker.refresh_session(RefreshSessionRequest {
        session_id: "root".to_owned(),
        known_cursor: prior.clone(),
    }))
    .unwrap();
    assert_eq!(refreshed.cursor.runtime_generation, "generation-b");
    assert_eq!(refreshed.cursor.sequence, 1);
    assert_eq!(broker.state(), BrokerState::Live);

    let replay = broker.admit_event(HarnessEvent::SessionState {
        session_id: "root".to_owned(),
        cursor: HarnessCursor {
            runtime_generation: prior.runtime_generation,
            sequence: prior.sequence + 1,
        },
        state: RootSessionState::Idle,
    });
    assert!(matches!(replay, Err(HarnessError::ChronologyViolation)));
}

fn unknown_operation(session_id: &str, operation_id: &str) -> StudioOperationRequest {
    StudioOperationRequest {
        session_id: session_id.to_owned(),
        operation_id: operation_id.to_owned(),
        action: HarnessStudioAction::HarnessSessionPrompt,
        payload_json: format!(r#"{{"sessionId":"{session_id}","text":"uncertain"}}"#),
        expected_cursor: Some(HarnessCursor {
            runtime_generation: "generation".to_owned(),
            sequence: 1,
        }),
        idempotency_key: Some(format!("key-{operation_id}")),
    }
}

#[test]
fn unknown_outcome_quarantine_is_session_scoped_and_gates_both_mutation_apis() {
    let mut broker = live_quarantine_broker();
    let unknown = tauri::async_runtime::block_on(
        broker.execute_operation(unknown_operation("root-a", "unknown-a")),
    )
    .unwrap();
    assert_eq!(unknown.status, StudioOperationStatus::UnknownOutcome);
    assert_eq!(
        broker.project("root-a").unwrap().freshness,
        ProjectionFreshness::UnknownOutcome
    );
    assert_eq!(
        broker.project("root-b").unwrap().freshness,
        ProjectionFreshness::Live
    );

    let legacy = tauri::async_runtime::block_on(broker.submit(SessionCommandRequest {
        session_id: "root-a".to_owned(),
        command_id: "legacy-after-unknown".to_owned(),
        expected_cursor: HarnessCursor {
            runtime_generation: "generation".to_owned(),
            sequence: 1,
        },
        kind: SessionCommandKind::Prompt,
        text: "must remain quarantined".to_owned(),
    }));
    assert!(matches!(legacy, Err(HarnessError::OwnershipViolation)));

    let repeated = tauri::async_runtime::block_on(
        broker.execute_operation(unknown_operation("root-a", "unknown-a-second")),
    );
    assert!(matches!(repeated, Err(HarnessError::OwnershipViolation)));

    let other = tauri::async_runtime::block_on(broker.execute_operation(StudioOperationRequest {
        session_id: "root-b".to_owned(),
        operation_id: "safe-b".to_owned(),
        action: HarnessStudioAction::UsageCurrentRefresh,
        payload_json: r#"{"sessionId":"root-b"}"#.to_owned(),
        expected_cursor: Some(HarnessCursor {
            runtime_generation: "generation".to_owned(),
            sequence: 1,
        }),
        idempotency_key: None,
    }))
    .unwrap();
    assert_eq!(other.status, StudioOperationStatus::Updated);
    assert_eq!(other.session.unwrap().cursor.sequence, 2);
}

#[test]
fn refresh_never_reconciles_unknown_outcomes_and_attach_clears_only_its_session() {
    let mut broker = live_quarantine_broker();
    for (session, operation) in [("root-a", "unknown-a"), ("root-b", "unknown-b")] {
        let result = tauri::async_runtime::block_on(
            broker.execute_operation(unknown_operation(session, operation)),
        )
        .unwrap();
        assert_eq!(result.status, StudioOperationStatus::UnknownOutcome);
    }

    let refreshed = tauri::async_runtime::block_on(broker.refresh_session(RefreshSessionRequest {
        session_id: "root-a".to_owned(),
        known_cursor: HarnessCursor {
            runtime_generation: "generation".to_owned(),
            sequence: 1,
        },
    }))
    .unwrap();
    assert_eq!(refreshed.cursor.sequence, 2);
    assert_eq!(refreshed.freshness, ProjectionFreshness::UnknownOutcome);
    assert_eq!(
        broker.project("root-b").unwrap().freshness,
        ProjectionFreshness::UnknownOutcome
    );

    let attached = tauri::async_runtime::block_on(broker.attach(AttachRequest {
        session_id: "root-a".to_owned(),
    }))
    .unwrap();
    assert_eq!(attached.cursor.sequence, 3);
    assert_eq!(attached.freshness, ProjectionFreshness::Live);
    assert_eq!(
        broker.project("root-b").unwrap().freshness,
        ProjectionFreshness::UnknownOutcome
    );

    let mut replay = unknown_operation("root-a", "unknown-a");
    replay.expected_cursor = Some(HarnessCursor {
        runtime_generation: "generation".to_owned(),
        sequence: 3,
    });
    let replay = tauri::async_runtime::block_on(broker.execute_operation(replay)).unwrap();
    assert_eq!(replay.status, StudioOperationStatus::UnknownOutcome);
    assert_eq!(
        replay.reason.as_deref(),
        Some("operation remains tombstoned")
    );
    assert_eq!(broker.project("root-a").unwrap().cursor.sequence, 3);
}

#[test]
fn reconnect_snapshot_batch_does_not_reconcile_an_unknown_mutation() {
    let mut broker = live_broker();
    broker
        .mark_unknown_outcome("root", "unknown-operation", Some("unknown-key"))
        .unwrap();
    broker.begin_reconnect().unwrap();
    broker.begin_snapshot(1).unwrap();
    let replacement = broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-b", 1))
        .unwrap();
    broker.apply_snapshot(replacement).unwrap();
    broker.finish_snapshot().unwrap();
    assert_eq!(
        broker.project("root").unwrap().freshness,
        ProjectionFreshness::UnknownOutcome
    );
}

#[test]
fn no_event_or_projection_is_visible_before_a_complete_snapshot() {
    let mut broker =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    let event = HarnessEvent::SessionState {
        session_id: "root".to_owned(),
        cursor: HarnessCursor {
            runtime_generation: "generation-a".to_owned(),
            sequence: 2,
        },
        state: RootSessionState::Working,
    };
    assert!(broker.admit_event(event).is_err());
    broker.begin_snapshot(2).unwrap();
    let admitted = broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 1))
        .unwrap();
    broker.apply_snapshot(admitted).unwrap();
    assert!(broker.project("root").is_none());
    assert!(broker.finish_snapshot().is_err());
    assert_eq!(broker.state(), BrokerState::Failed);
    assert!(broker.project("root").is_none());
}

#[test]
fn ownership_and_broker_specific_admission_are_enforced() {
    let mut first =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    let mut second =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    first.begin_snapshot(1).unwrap();
    second.begin_snapshot(1).unwrap();
    for hostile in [
        snapshot("other", "project", "chat", "generation-a", 1),
        snapshot("root", "other-project", "chat", "generation-a", 1),
        snapshot("root", "project", "other-chat", "generation-a", 1),
        {
            let mut value = snapshot("root", "project", "chat", "generation-a", 1);
            value.account_id = Some("other-account".to_owned());
            value
        },
    ] {
        assert!(first.admit_snapshot(hostile).is_err());
    }
    let evidence = first
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 1))
        .unwrap();
    assert!(second.apply_snapshot(evidence).is_err());
}

#[test]
fn studio_catalog_bindings_cannot_forge_daemon_session_project_chat_or_account_identity() {
    let mut broker =
        HarnessBroker::for_tests(vec![ownership("daemon-session", "project-from-cwd", "daemon-chat")], None)
            .unwrap();
    broker.begin_snapshot(1).unwrap();

    let mut forged_catalog_chat = snapshot(
        "daemon-session",
        "project-from-cwd",
        "catalog-chat",
        "generation-a",
        1,
    );
    forged_catalog_chat.account_id = Some("account".to_owned());
    assert!(matches!(
        broker.admit_snapshot(forged_catalog_chat),
        Err(HarnessError::OwnershipViolation)
    ));

    let mut forged_catalog_project = snapshot(
        "daemon-session",
        "catalog-project",
        "daemon-chat",
        "generation-a",
        1,
    );
    forged_catalog_project.account_id = Some("account".to_owned());
    assert!(matches!(
        broker.admit_snapshot(forged_catalog_project),
        Err(HarnessError::OwnershipViolation)
    ));

    let mut unproven_account = snapshot(
        "daemon-session",
        "project-from-cwd",
        "daemon-chat",
        "generation-a",
        1,
    );
    unproven_account.account_id = None;
    assert!(matches!(
        broker.admit_snapshot(unproven_account),
        Err(HarnessError::OwnershipViolation)
    ));
}

#[test]
fn sequence_must_be_exactly_next_and_old_generations_stay_retired() {
    let mut broker = live_broker();
    for sequence in [1, 3, 0] {
        let event = HarnessEvent::SessionState {
            session_id: "root".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation-a".to_owned(),
                sequence,
            },
            state: RootSessionState::Working,
        };
        assert!(broker.admit_event(event).is_err());
    }
    let next = broker
        .admit_event(HarnessEvent::SessionState {
            session_id: "root".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation-a".to_owned(),
                sequence: 2,
            },
            state: RootSessionState::Working,
        })
        .unwrap();
    broker.apply_event(next).unwrap();
    assert_eq!(
        broker.project("root").unwrap().state,
        RootSessionState::Working
    );

    broker.begin_reconnect().unwrap();
    broker.begin_snapshot(1).unwrap();
    let replacement = broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-b", 1))
        .unwrap();
    broker.apply_snapshot(replacement).unwrap();
    broker.finish_snapshot().unwrap();
    let old = broker.admit_event(HarnessEvent::SessionState {
        session_id: "root".to_owned(),
        cursor: HarnessCursor {
            runtime_generation: "generation-a".to_owned(),
            sequence: 3,
        },
        state: RootSessionState::Failed,
    });
    assert!(old.is_err());
}

#[test]
fn recovery_cursor_replay_is_rejected_after_restart() {
    let recovery = RecoveryRecord {
        schema_version: 1,
        projection_schema_version: 1,
        revision: 4,
        runtime_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_owned(),
        profile: "daemon-v7-schema13".to_owned(),
        sessions: vec![RecoveredSession {
            session_id: "root".to_owned(),
            account_id: Some("account".to_owned()),
            project_id: "project".to_owned(),
            chat_id: "chat".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation-a".to_owned(),
                sequence: 9,
            },
        }],
    };
    let mut broker =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], Some(recovery))
            .unwrap();
    broker.begin_snapshot(1).unwrap();
    assert!(broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 9))
        .is_err());
    assert!(broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 8))
        .is_err());
    let next = broker
        .admit_snapshot(snapshot("root", "project", "chat", "generation-a", 10))
        .unwrap();
    broker.apply_snapshot(next).unwrap();
    broker.finish_snapshot().unwrap();
}

#[test]
fn child_ownership_and_snapshot_bounds_are_checked_before_commit() {
    let mut broker = HarnessBroker::for_tests(
        vec![
            ownership("root-a", "project-a", "chat-a"),
            ownership("root-b", "project-b", "chat-b"),
        ],
        None,
    )
    .unwrap();
    broker.begin_snapshot(2).unwrap();
    let child = ChildAgentSummary {
        id: "child".to_owned(),
        status: ChildAgentStatus::Running,
        task: "task".to_owned(),
        provider: None,
        model: None,
        progress: None,
    };
    let mut first = snapshot("root-a", "project-a", "chat-a", "generation", 1);
    first.children.push(child.clone());
    let mut second = snapshot("root-b", "project-b", "chat-b", "generation", 1);
    second.children.push(child);
    let admitted = broker.admit_snapshot(first).unwrap();
    broker.apply_snapshot(admitted).unwrap();
    let admitted = broker.admit_snapshot(second).unwrap();
    broker.apply_snapshot(admitted).unwrap();
    assert!(broker.finish_snapshot().is_err());
    assert!(broker.project("root-a").is_none());

    let mut bounded =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    bounded.begin_snapshot(1).unwrap();
    let mut hostile = snapshot("root", "project", "chat", "generation", 1);
    hostile.children = (0..257)
        .map(|index| ChildAgentSummary {
            id: format!("child-{index}"),
            status: ChildAgentStatus::Queued,
            task: "task".to_owned(),
            provider: None,
            model: None,
            progress: None,
        })
        .collect();
    assert!(bounded.admit_snapshot(hostile).is_err());
}

#[test]
fn recovery_is_bound_to_the_expected_runtime_profile() {
    let mut recovery = RecoveryRecord {
        schema_version: 1,
        projection_schema_version: 1,
        revision: 1,
        runtime_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .to_owned(),
        profile: "other-profile".to_owned(),
        sessions: Vec::new(),
    };
    assert!(HarnessBroker::for_tests(Vec::new(), Some(recovery.clone())).is_err());
    recovery.runtime_digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert!(HarnessBroker::for_tests(Vec::new(), Some(recovery)).is_err());
}

#[test]
fn projections_distinguish_live_reconnecting_unknown_and_closed() {
    let mut broker = live_broker();
    assert_eq!(
        broker.project("root").unwrap().freshness,
        ProjectionFreshness::Live
    );
    broker.begin_reconnect().unwrap();
    assert_eq!(
        broker.project("root").unwrap().freshness,
        ProjectionFreshness::Stale
    );
    broker
        .mark_unknown_outcome("root", "operation", Some("idempotency-key"))
        .unwrap();
    assert_eq!(
        broker.project("root").unwrap().freshness,
        ProjectionFreshness::UnknownOutcome
    );
    broker.close();
    assert_eq!(
        broker.project("root").unwrap().freshness,
        ProjectionFreshness::Disconnected
    );
}

#[test]
fn randomized_monotonic_sequences_never_accept_a_gap_or_replay() {
    for seed in 0_u64..64 {
        let broker = live_broker();
        let candidate = 1 + ((seed.wrapping_mul(1_103_515_245).wrapping_add(12_345)) % 8);
        let admitted = broker.admit_event(HarnessEvent::SessionState {
            session_id: "root".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation-a".to_owned(),
                sequence: candidate,
            },
            state: RootSessionState::Working,
        });
        assert_eq!(admitted.is_ok(), candidate == 2, "candidate={candidate}");
    }
}

#[test]
fn live_snapshot_events_cannot_steal_children_or_exceed_safe_chronology() {
    let mut broker = HarnessBroker::for_tests(
        vec![
            ownership("root-a", "project-a", "chat-a"),
            ownership("root-b", "project-b", "chat-b"),
        ],
        None,
    )
    .unwrap();
    broker.begin_snapshot(2).unwrap();
    let mut first = snapshot("root-a", "project-a", "chat-a", "generation", 1);
    first.children.push(ChildAgentSummary {
        id: "child".to_owned(),
        status: ChildAgentStatus::Running,
        task: "task".to_owned(),
        provider: None,
        model: None,
        progress: None,
    });
    for item in [
        first,
        snapshot("root-b", "project-b", "chat-b", "generation", 1),
    ] {
        let admitted = broker.admit_snapshot(item).unwrap();
        broker.apply_snapshot(admitted).unwrap();
    }
    broker.finish_snapshot().unwrap();
    let mut stolen = snapshot("root-b", "project-b", "chat-b", "generation", 2);
    stolen.children.push(ChildAgentSummary {
        id: "child".to_owned(),
        status: ChildAgentStatus::Done,
        task: "stolen".to_owned(),
        provider: None,
        model: None,
        progress: Some(1.0),
    });
    assert!(broker
        .admit_event(HarnessEvent::Snapshot {
            snapshot: Box::new(stolen),
        })
        .is_err());

    let mut bounded =
        HarnessBroker::for_tests(vec![ownership("root", "project", "chat")], None).unwrap();
    bounded.begin_snapshot(1).unwrap();
    let admitted = bounded
        .admit_snapshot(snapshot(
            "root",
            "project",
            "chat",
            "generation",
            9_007_199_254_740_991,
        ))
        .unwrap();
    bounded.apply_snapshot(admitted).unwrap();
    bounded.finish_snapshot().unwrap();
    assert!(bounded
        .admit_event(HarnessEvent::SessionState {
            session_id: "root".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation".to_owned(),
                sequence: 9_007_199_254_740_992,
            },
            state: RootSessionState::Working,
        })
        .is_err());
}

#[test]
fn contained_bootstrap_commits_atomically_and_profile_failure_is_terminal() {
    let mut broker = HarnessBroker::new(
        sidecar("broker-bootstrap"),
        "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900".to_owned(),
        "prime-agent-daemon-v7-schema13-816309b1cd50".to_owned(),
        vec![ownership("root", "project", "chat")],
        None,
    )
    .unwrap();
    let projection = tauri::async_runtime::block_on(broker.bootstrap()).unwrap();
    assert_eq!(broker.state(), BrokerState::Live);
    assert_eq!(projection.sessions.len(), 1);
    let recovery = broker.recovery_record(1).unwrap();
    assert_eq!(recovery.sessions.len(), 1);
    assert_eq!(recovery.projection_schema_version, 1);

    let mut wrong = HarnessBroker::new(
        sidecar("broker-wrong-profile"),
        "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900".to_owned(),
        "prime-agent-daemon-v7-schema13-816309b1cd50".to_owned(),
        vec![ownership("root", "project", "chat")],
        None,
    )
    .unwrap();
    assert!(tauri::async_runtime::block_on(wrong.bootstrap()).is_err());
    assert_eq!(wrong.state(), BrokerState::Failed);
    assert!(wrong.project("root").is_none());
}
use std::fs;
use std::path::{Path, PathBuf};
