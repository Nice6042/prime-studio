use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use prime_studio_lib::authority::{
    authorize_known_session_rpc, authorize_raw_rpc, authorize_tauri_command,
    authorize_tauri_invoke, run_guarded_tauri_command, AuthorityError, AuthorityGate,
    CommandAuthority, RawRpcClass, SecurityReadiness, TauriCommand, ALL_EFFECT_CLASSES,
    ALL_TAURI_COMMANDS, LEGACY_RAW_RPC_COMMANDS,
};
use serde_json::{json, Value};

const EXPECTED_TAURI_COMMANDS: [&str; 45] = [
    "start_session",
    "attach_session",
    "detach_session",
    "stop_session",
    "note_agent",
    "fleet_list",
    "stop_agent",
    "rename_agent",
    "send_rpc",
    "list_sessions",
    "get_stderr",
    "browser_security_status",
    "browser_check_intent_admission",
    "list_disk_sessions",
    "read_disk_session",
    "read_child_session",
    "list_models",
    "get_provider_product_snapshot",
    "list_accounts",
    "add_account",
    "prepare_remove_account",
    "commit_remove_account",
    "rename_account",
    "account_statuses",
    "begin_account_login",
    "account_usage",
    "account_usage_series",
    "codex_subscription_usage",
    "resolve_prime_cli",
    "set_prime_cli",
    "check_prime_cli",
    "get_app_settings",
    "scheduler_projection",
    "harness_bootstrap",
    "harness_projection",
    "get_layout_preferences",
    "set_layout_preferences",
    "set_app_setting",
    "kernel_status",
    "files_touched",
    "pick_directory",
    "read_workspace_file",
    "list_workspace_files",
    "open_external",
    "computer_use_readiness",
];

const EXPECTED_RAW_RPC_COMMANDS: [&str; 45] = [
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "new_session",
    "get_state",
    "set_model",
    "cycle_model",
    "get_available_models",
    "set_thinking_level",
    "cycle_thinking_level",
    "set_steering_mode",
    "set_follow_up_mode",
    "compact",
    "refine",
    "set_auto_compaction",
    "set_auto_retry",
    "abort_retry",
    "bash",
    "abort_bash",
    "get_session_stats",
    "export_html",
    "switch_session",
    "fork",
    "clone",
    "get_fork_messages",
    "get_last_assistant_text",
    "set_session_name",
    "get_messages",
    "send_message",
    "agent_messages_status",
    "agent_messages_pause",
    "agent_messages_resume",
    "agent_messages_clear",
    "list_schedules",
    "add_schedule",
    "cancel_schedule",
    "list_heartbeats",
    "get_heartbeat",
    "set_heartbeat",
    "update_heartbeat",
    "manage_heartbeat",
    "observe",
    "unobserve",
    "get_commands",
];

fn command(name: &str) -> Value {
    json!({ "id": "adversarial-test", "type": name })
}

fn registered_tauri_commands() -> Vec<&'static str> {
    const MARKER: &str = ".invoke_handler(authority_invoke_handler(tauri::generate_handler![";
    let source = include_str!("../src/lib.rs");
    let (_, after_marker) = source
        .split_once(MARKER)
        .expect("lib.rs registers one explicit Tauri handler list");
    let (handler_list, _) = after_marker
        .split_once("])")
        .expect("the Tauri handler list has a closing delimiter");
    handler_list
        .split([',', '\r', '\n'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect()
}

#[test]
fn tauri_command_inventory_is_complete_unique_and_stable() {
    let source = include_str!("../src/lib.rs");
    let registered = registered_tauri_commands();
    let actual: Vec<&str> = ALL_TAURI_COMMANDS
        .iter()
        .copied()
        .map(TauriCommand::name)
        .collect();
    assert_eq!(registered, EXPECTED_TAURI_COMMANDS);
    assert_eq!(actual, EXPECTED_TAURI_COMMANDS);
    assert_eq!(actual, registered);
    assert_eq!(
        actual.iter().copied().collect::<HashSet<_>>().len(),
        EXPECTED_TAURI_COMMANDS.len()
    );
    assert_eq!(
        source.matches(".invoke_handler(").count(),
        1,
        "every registered command must share the sole invoke wrapper"
    );
    assert_eq!(
        source
            .matches(".invoke_handler(authority_invoke_handler(")
            .count(),
        1,
        "the sole invoke handler must be the authority wrapper"
    );
}

#[test]
fn legacy_unprepared_account_removal_is_not_registered_or_authorized() {
    assert!(!registered_tauri_commands().contains(&"remove_account"));
    assert_eq!(TauriCommand::from_name("remove_account"), None);
    assert!(matches!(
        authorize_tauri_invoke(
            &AuthorityGate::phase_zero(),
            "remove_account",
            &json!({ "id": "claude-work", "deleteData": false }),
        ),
        Err(AuthorityError::UnknownTauriCommand { .. })
    ));
}

#[test]
fn native_scheduler_surface_registers_projection_only() {
    let scheduler_commands: Vec<&str> = ALL_TAURI_COMMANDS
        .iter()
        .copied()
        .map(TauriCommand::name)
        .filter(|name| name.contains("schedule"))
        .collect();

    assert_eq!(scheduler_commands, ["scheduler_projection"]);
    assert_eq!(
        TauriCommand::SchedulerProjection.authority(),
        CommandAuthority::OfflineRead
    );
}

#[test]
fn tauri_policy_keeps_only_offline_account_configuration_reads_and_owned_stop_paths_open() {
    use CommandAuthority::{
        AccountManagement, DynamicRawRpc, LocalBookkeeping, OfflineRead, SafetyControl,
    };

    let cases = [
        (TauriCommand::DetachSession, SafetyControl),
        (TauriCommand::StopSession, SafetyControl),
        (TauriCommand::NoteAgent, LocalBookkeeping),
        (TauriCommand::SendRpc, DynamicRawRpc),
        (TauriCommand::ListSessions, OfflineRead),
        (TauriCommand::GetStderr, OfflineRead),
        (TauriCommand::BrowserSecurityStatus, OfflineRead),
        (TauriCommand::BrowserCheckIntentAdmission, OfflineRead),
        (TauriCommand::GetProviderProductSnapshot, AccountManagement),
        (TauriCommand::ListAccounts, AccountManagement),
        (TauriCommand::AddAccount, AccountManagement),
        (TauriCommand::PrepareRemoveAccount, AccountManagement),
        (TauriCommand::CommitRemoveAccount, AccountManagement),
        (TauriCommand::RenameAccount, AccountManagement),
        (TauriCommand::AccountStatuses, AccountManagement),
        (TauriCommand::GetAppSettings, OfflineRead),
        (TauriCommand::SchedulerProjection, OfflineRead),
        (TauriCommand::HarnessBootstrap, OfflineRead),
        (TauriCommand::HarnessProjection, OfflineRead),
        (TauriCommand::GetLayoutPreferences, OfflineRead),
        (TauriCommand::ComputerUseReadiness, OfflineRead),
    ];

    let actual_non_effect: Vec<(TauriCommand, CommandAuthority)> = ALL_TAURI_COMMANDS
        .iter()
        .copied()
        .filter_map(|tauri_command| {
            let authority = tauri_command.authority();
            (!matches!(authority, CommandAuthority::Effects(_)))
                .then_some((tauri_command, authority))
        })
        .collect();
    assert_eq!(actual_non_effect, cases);

    for (tauri_command, expected) in cases {
        assert_eq!(
            tauri_command.authority(),
            expected,
            "{}",
            tauri_command.name()
        );
        if expected == DynamicRawRpc {
            assert_eq!(
                authorize_tauri_command(&AuthorityGate::phase_zero(), tauri_command),
                Err(AuthorityError::RawRpcPayloadRequired)
            );
        } else {
            assert!(
                authorize_tauri_command(&AuthorityGate::phase_zero(), tauri_command).is_ok(),
                "{} must remain available in Phase 0",
                tauri_command.name()
            );
        }
    }
}

#[test]
fn persisted_local_configuration_waits_for_write_enforcement() {
    use prime_studio_lib::authority::EffectClass::LocalConfigurationWrite;

    assert_eq!(
        TauriCommand::SetAppSetting.authority(),
        CommandAuthority::Effects(&[LocalConfigurationWrite])
    );
    assert_eq!(
        TauriCommand::SetLayoutPreferences.authority(),
        CommandAuthority::Effects(&[LocalConfigurationWrite])
    );
    for command in [
        TauriCommand::SetAppSetting,
        TauriCommand::SetLayoutPreferences,
    ] {
        assert_eq!(
            authorize_tauri_command(&AuthorityGate::phase_zero(), command),
            Err(AuthorityError::ReadinessNotEnforced {
                effect: LocalConfigurationWrite,
                readiness: SecurityReadiness::Unavailable,
            })
        );
    }
}

#[test]
fn user_selected_workspace_browsing_waits_for_filesystem_read_enforcement() {
    use prime_studio_lib::authority::EffectClass::WorkspaceFilesystemRead;

    for tauri_command in [
        TauriCommand::PickDirectory,
        TauriCommand::ReadWorkspaceFile,
        TauriCommand::ListWorkspaceFiles,
        TauriCommand::ListDiskSessions,
        TauriCommand::ReadDiskSession,
        TauriCommand::ReadChildSession,
        TauriCommand::AccountUsage,
        TauriCommand::AccountUsageSeries,
        TauriCommand::CodexSubscriptionUsage,
    ] {
        assert_eq!(
            tauri_command.authority(),
            CommandAuthority::Effects(&[WorkspaceFilesystemRead]),
            "{} is not a Studio-owned offline journal read",
            tauri_command.name()
        );
        assert_eq!(
            authorize_tauri_command(&AuthorityGate::phase_zero(), tauri_command),
            Err(AuthorityError::ReadinessNotEnforced {
                effect: WorkspaceFilesystemRead,
                readiness: SecurityReadiness::Unavailable,
            })
        );
    }
}

#[test]
fn browser_projection_is_a_closed_offline_read_while_execution_stays_unavailable() {
    use prime_studio_lib::authority::EffectClass::BrowserExecution;

    let gate = AuthorityGate::phase_zero();
    for command in [
        TauriCommand::BrowserSecurityStatus,
        TauriCommand::BrowserCheckIntentAdmission,
    ] {
        assert_eq!(command.authority(), CommandAuthority::OfflineRead);
        assert!(authorize_tauri_command(&gate, command).is_ok());
    }
    assert_eq!(
        gate.readiness(BrowserExecution),
        SecurityReadiness::Unavailable
    );

    assert!(prime_studio_lib::authority::authorize_tauri_invoke(
        &gate,
        "browser_security_status",
        &json!({}),
    )
    .is_ok());
    assert_eq!(
        prime_studio_lib::authority::authorize_tauri_invoke(
            &gate,
            "browser_security_status",
            &json!({ "unexpected": true }),
        ),
        Err(AuthorityError::MalformedTauriPayload)
    );

    assert!(prime_studio_lib::authority::authorize_tauri_invoke(
        &gate,
        "browser_check_intent_admission",
        &json!({ "request": { "actionType": "inspect" } }),
    )
    .is_ok());
    for malformed in [
        json!({}),
        json!({ "request": { "actionType": "click" } }),
        json!({ "request": { "actionType": "inspect", "principalId": "renderer" } }),
        json!({ "request": { "actionType": "screenshot" }, "workerEpoch": 7 }),
    ] {
        assert_eq!(
            prime_studio_lib::authority::authorize_tauri_invoke(
                &gate,
                "browser_check_intent_admission",
                &malformed,
            ),
            Err(AuthorityError::MalformedTauriPayload)
        );
    }
}

#[test]
fn every_effectful_tauri_command_requires_its_exact_enforced_readiness() {
    for tauri_command in ALL_TAURI_COMMANDS {
        let CommandAuthority::Effects(effects) = tauri_command.authority() else {
            continue;
        };
        assert!(!effects.is_empty(), "effect sets cannot be empty");
        assert!(
            matches!(
                authorize_tauri_command(&AuthorityGate::phase_zero(), tauri_command),
                Err(AuthorityError::ReadinessNotEnforced {
                    readiness: SecurityReadiness::Unavailable,
                    ..
                })
            ),
            "{} must fail closed by default",
            tauri_command.name()
        );
    }
}

#[test]
fn set_prime_cli_requires_configuration_write_and_process_authority() {
    use prime_studio_lib::authority::EffectClass::{LocalConfigurationWrite, PrimeCliProcess};

    assert_eq!(
        TauriCommand::SetPrimeCli.authority(),
        CommandAuthority::Effects(&[LocalConfigurationWrite, PrimeCliProcess])
    );
}

#[test]
fn dynamic_raw_rpc_never_bypasses_payload_classification() {
    let gate = AuthorityGate::phase_zero();
    assert_eq!(
        authorize_tauri_command(&gate, TauriCommand::SendRpc),
        Err(AuthorityError::RawRpcPayloadRequired)
    );
}

#[test]
fn legacy_raw_rpc_inventory_is_complete_unique_and_stable() {
    let actual: Vec<&str> = LEGACY_RAW_RPC_COMMANDS
        .iter()
        .map(|policy| policy.command)
        .collect();
    assert_eq!(actual, EXPECTED_RAW_RPC_COMMANDS);
    assert_eq!(actual.iter().copied().collect::<HashSet<_>>().len(), 45);
}

#[test]
fn phase_zero_raw_rpc_allows_only_safety_reducing_commands() {
    let gate = AuthorityGate::phase_zero();
    let mut allowed = Vec::new();

    for policy in LEGACY_RAW_RPC_COMMANDS {
        let result = authorize_raw_rpc(&gate, &command(policy.command));
        if result.is_ok() {
            allowed.push(policy.command);
        } else {
            assert_ne!(
                policy.class,
                RawRpcClass::SafetyControl,
                "safety-reducing {} must reach the known-session check",
                policy.command
            );
        }
    }

    assert_eq!(allowed, ["abort", "abort_retry", "abort_bash"]);
    assert!(
        authorize_raw_rpc(&gate, &command("export_html")).is_err(),
        "Prime export is not a Studio-owned bounded offline export"
    );
}

#[test]
fn each_effectful_raw_rpc_class_denies_by_default() {
    for policy in LEGACY_RAW_RPC_COMMANDS {
        let Some(effect) = policy.class.effect() else {
            assert_eq!(policy.class, RawRpcClass::SafetyControl);
            continue;
        };

        assert_eq!(
            authorize_raw_rpc(&AuthorityGate::phase_zero(), &command(policy.command)),
            Err(AuthorityError::ReadinessNotEnforced {
                effect,
                readiness: SecurityReadiness::Unavailable,
            })
        );
    }
}

#[test]
fn malformed_and_unknown_raw_rpc_denies_even_when_all_known_classes_are_enforced() {
    let gate = AuthorityGate::phase_zero();
    let malformed = [
        Value::Null,
        json!([]),
        json!({}),
        json!({ "type": null }),
        json!({ "type": 7 }),
    ];
    for value in malformed {
        assert_eq!(
            authorize_raw_rpc(&gate, &value),
            Err(AuthorityError::MalformedRawRpcCommand)
        );
    }

    for name in [
        "unknown",
        " get_state",
        "get_state ",
        "GET_STATE",
        "get-state",
        "get_state\0prompt",
    ] {
        assert_eq!(
            authorize_raw_rpc(&gate, &command(name)),
            Err(AuthorityError::UnknownRawRpcCommand),
            "raw command spelling must match the pinned inventory exactly"
        );
    }
}

#[test]
fn every_effect_class_is_unavailable_in_the_phase_zero_gate() {
    let gate = AuthorityGate::phase_zero();
    assert_eq!(ALL_EFFECT_CLASSES.len(), 17);
    assert_eq!(
        ALL_EFFECT_CLASSES
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len(),
        17,
        "the effect inventory must be unique"
    );
    for effect in ALL_EFFECT_CLASSES {
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

#[test]
fn computer_use_readiness_ipc_is_read_only_strict_and_cannot_mint_authority() {
    let gate = AuthorityGate::phase_zero();
    assert_eq!(
        TauriCommand::ComputerUseReadiness.authority(),
        CommandAuthority::OfflineRead
    );
    assert!(authorize_tauri_invoke(&gate, "computer_use_readiness", &json!({})).is_ok());

    for hostile in [
        Value::Null,
        json!([]),
        json!({ "status": "enforced" }),
        json!({ "readiness": "enforced" }),
        json!({ "authority": {} }),
        json!({ "authorityDigest": format!("sha256:{}", "0".repeat(64)) }),
    ] {
        assert_eq!(
            authorize_tauri_invoke(&gate, "computer_use_readiness", &hostile),
            Err(AuthorityError::MalformedTauriPayload),
            "renderer payload must never influence native readiness"
        );
    }

    for forbidden in [
        "computer_use_execute",
        "computer_use_input",
        "computer_use_screenshot",
        "computer_use_clipboard",
        "computer_use_set_readiness",
    ] {
        assert_eq!(TauriCommand::from_name(forbidden), None);
        assert!(matches!(
            authorize_tauri_invoke(&gate, forbidden, &json!({})),
            Err(AuthorityError::UnknownTauriCommand { .. })
        ));
    }
}

#[test]
fn computer_use_admission_capability_is_not_a_public_rust_api() {
    let source = include_str!("../src/computer_use.rs");

    for forbidden in [
        "pub struct AuthorityBindingParts",
        "pub struct AuthorityBinding",
        "pub fn admit_native_authority",
    ] {
        assert!(
            !source.contains(forbidden),
            "raw authority construction leaked through {forbidden}"
        );
    }
    assert!(
        source.contains("pub(crate) struct VerifiedComputerUseAuthority"),
        "AppState must accept only an opaque crate-owned verification result"
    );
}

#[test]
fn windows_computer_use_is_an_exact_unavailable_effect_inventory_member() {
    use prime_studio_lib::authority::EffectClass::WindowsComputerUse;

    assert_eq!(WindowsComputerUse.as_str(), "windows_computer_use");
    assert_eq!(
        AuthorityGate::phase_zero().readiness(WindowsComputerUse),
        SecurityReadiness::Unavailable
    );
    assert_eq!(
        AuthorityGate::phase_zero().require(WindowsComputerUse),
        Err(AuthorityError::ReadinessNotEnforced {
            effect: WindowsComputerUse,
            readiness: SecurityReadiness::Unavailable,
        })
    );
}

#[test]
fn a_denied_tauri_effect_never_enters_its_operation_body() {
    for tauri_command in ALL_TAURI_COMMANDS {
        let CommandAuthority::Effects(effects) = tauri_command.authority() else {
            continue;
        };
        let calls = Cell::new(0);
        let denied = run_guarded_tauri_command(&AuthorityGate::phase_zero(), tauri_command, || {
            calls.set(calls.get() + 1)
        });
        assert_eq!(
            denied,
            Err(AuthorityError::ReadinessNotEnforced {
                effect: effects[0],
                readiness: SecurityReadiness::Unavailable
            })
        );
        assert_eq!(
            calls.get(),
            0,
            "{} reached its effect body",
            tauri_command.name()
        );
    }
}

#[test]
fn raw_rpc_cancellation_reaches_only_an_existing_studio_owned_session() {
    let gate = AuthorityGate::phase_zero();
    let mut sessions = HashMap::from([("owned-session".to_string(), 0_u8)]);

    let owned =
        authorize_known_session_rpc(&gate, &mut sessions, "owned-session", &command("abort"))
            .expect("cancellation may reach a known Studio-owned process");
    *owned += 1;
    assert_eq!(sessions["owned-session"], 1);

    let missing = authorize_known_session_rpc(
        &gate,
        &mut sessions,
        "attacker-selected-daemon-agent",
        &command("abort"),
    );
    assert_eq!(
        missing,
        Err(AuthorityError::UnknownStudioSession {
            session_key: "attacker-selected-daemon-agent".to_string(),
        })
    );
    assert_eq!(sessions["owned-session"], 1);

    let prompt =
        authorize_known_session_rpc(&gate, &mut sessions, "owned-session", &command("prompt"));
    assert!(matches!(
        prompt,
        Err(AuthorityError::ReadinessNotEnforced {
            effect: prime_studio_lib::authority::EffectClass::PrimeRpcTurn,
            readiness: SecurityReadiness::Unavailable,
        })
    ));
    assert_eq!(sessions["owned-session"], 1);
}

#[test]
fn webview_capabilities_cannot_bypass_rust_for_filesystem_or_external_opening() {
    let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
        .expect("the checked-in Tauri capability is valid JSON");
    let permissions = capability["permissions"]
        .as_array()
        .expect("the main-window capability has an explicit permission list");
    let permissions: Vec<&str> = permissions
        .iter()
        .map(|permission| permission.as_str().expect("permission names are strings"))
        .collect();

    assert_eq!(
        permissions,
        ["core:app:allow-version", "core:event:allow-listen"],
        "new webview permissions require an explicit Phase 0 authority review"
    );

    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("the checked-in Tauri config is valid JSON");
    assert_eq!(
        config["app"]["windows"][0]["create"],
        Value::Bool(false),
        "the main WebView must be manually built with the navigation policy"
    );
    assert!(
        include_str!("../Cargo.toml").contains("tauri = { version = \"=2.11.5\""),
        "navigation callback ordering is audited against and pinned to Tauri 2.11.5"
    );
    let manifest = include_str!("../Cargo.toml");
    assert!(
        manifest.contains("[features]\ndefault = [\"custom-protocol\"]\ncustom-protocol = [\"tauri/custom-protocol\"]"),
        "release builds must enable Tauri's custom protocol so is_dev() cannot admit the dev origin"
    );
}
