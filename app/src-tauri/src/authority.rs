//! Phase 0 security authority.
//!
//! The backend starts with every effect class unavailable. A caller may admit a
//! class only by supplying an explicit `Enforced` readiness value from a future
//! trusted attestation path; no Tauri command can change readiness. Offline
//! journal reads, account-registry administration, local configuration reads,
//! and safety-reducing operations do not expand execution authority.

use std::collections::HashMap;
use std::fmt;

use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SecurityReadiness {
    #[default]
    Unavailable,
    AdmissionOnly,
    Enforced,
}

impl SecurityReadiness {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::AdmissionOnly => "admission_only",
            Self::Enforced => "enforced",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(usize)]
pub enum EffectClass {
    PrimeSessionProcess,
    PrimeCliProcess,
    LocalGitProcess,
    LocalConfigurationWrite,
    WorkspaceFilesystemRead,
    OpaqueInterpreter,
    AccountAuthentication,
    ExternalNavigation,
    PrimeRpcLiveRead,
    PrimeRpcExport,
    PrimeRpcTurn,
    PrimeRpcSessionMutation,
    PrimeRpcMessaging,
    PrimeRpcBackground,
    PrimeRpcObservation,
    WindowsComputerUse,
    BrowserExecution,
}

pub const ALL_EFFECT_CLASSES: [EffectClass; 17] = [
    EffectClass::PrimeSessionProcess,
    EffectClass::PrimeCliProcess,
    EffectClass::LocalGitProcess,
    EffectClass::LocalConfigurationWrite,
    EffectClass::WorkspaceFilesystemRead,
    EffectClass::OpaqueInterpreter,
    EffectClass::AccountAuthentication,
    EffectClass::ExternalNavigation,
    EffectClass::PrimeRpcLiveRead,
    EffectClass::PrimeRpcExport,
    EffectClass::PrimeRpcTurn,
    EffectClass::PrimeRpcSessionMutation,
    EffectClass::PrimeRpcMessaging,
    EffectClass::PrimeRpcBackground,
    EffectClass::PrimeRpcObservation,
    EffectClass::WindowsComputerUse,
    EffectClass::BrowserExecution,
];

impl EffectClass {
    const fn index(self) -> usize {
        self as usize
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PrimeSessionProcess => "prime_session_process",
            Self::PrimeCliProcess => "prime_cli_process",
            Self::LocalGitProcess => "local_git_process",
            Self::LocalConfigurationWrite => "local_configuration_write",
            Self::WorkspaceFilesystemRead => "workspace_filesystem_read",
            Self::OpaqueInterpreter => "opaque_interpreter",
            Self::AccountAuthentication => "account_authentication",
            Self::ExternalNavigation => "external_navigation",
            Self::PrimeRpcLiveRead => "prime_rpc_live_read",
            Self::PrimeRpcExport => "prime_rpc_export",
            Self::PrimeRpcTurn => "prime_rpc_turn",
            Self::PrimeRpcSessionMutation => "prime_rpc_session_mutation",
            Self::PrimeRpcMessaging => "prime_rpc_messaging",
            Self::PrimeRpcBackground => "prime_rpc_background",
            Self::PrimeRpcObservation => "prime_rpc_observation",
            Self::WindowsComputerUse => "windows_computer_use",
            Self::BrowserExecution => "browser_execution",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum AuthorityError {
    ReadinessNotEnforced {
        effect: EffectClass,
        readiness: SecurityReadiness,
    },
    RawRpcPayloadRequired,
    MalformedTauriPayload,
    UnknownTauriCommand {
        command: String,
    },
    MalformedRawRpcCommand,
    UnknownRawRpcCommand,
    UnknownStudioSession {
        session_key: String,
    },
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReadinessNotEnforced { effect, readiness } => write!(
                formatter,
                "security gate denied {}: readiness {} is not enforced",
                effect.as_str(),
                readiness.as_str()
            ),
            Self::RawRpcPayloadRequired => {
                formatter.write_str("security gate requires raw RPC payload classification")
            }
            Self::MalformedTauriPayload => {
                formatter.write_str("security gate denied malformed Tauri command payload")
            }
            Self::UnknownTauriCommand { command } => {
                write!(
                    formatter,
                    "security gate denied unknown Tauri command: {command}"
                )
            }
            Self::MalformedRawRpcCommand => {
                formatter.write_str("security gate denied malformed raw RPC command")
            }
            Self::UnknownRawRpcCommand => {
                formatter.write_str("security gate denied unknown raw RPC command")
            }
            Self::UnknownStudioSession { session_key } => {
                write!(formatter, "no such Studio-owned session: {session_key}")
            }
        }
    }
}

impl std::error::Error for AuthorityError {}

#[derive(Debug)]
pub struct AuthorityGate {
    readiness: [SecurityReadiness; ALL_EFFECT_CLASSES.len()],
}

/// Readiness can enter a gate only after a trusted verifier has produced this
/// private value. Phase 0 has no verifier for elevated effects, so production
/// construction can produce only the all-unavailable attestation.
struct VerifiedAttestation {
    readiness: [SecurityReadiness; ALL_EFFECT_CLASSES.len()],
}

impl VerifiedAttestation {
    const fn phase_zero() -> Self {
        Self {
            readiness: [SecurityReadiness::Unavailable; ALL_EFFECT_CLASSES.len()],
        }
    }

    #[cfg(test)]
    fn for_test(entries: &[(EffectClass, SecurityReadiness)]) -> Self {
        let mut attestation = Self::phase_zero();
        for &(effect, readiness) in entries {
            attestation.readiness[effect.index()] = readiness;
        }
        attestation
    }
}

impl AuthorityGate {
    pub const fn phase_zero() -> Self {
        Self::from_verified_attestation(VerifiedAttestation::phase_zero())
    }

    const fn from_verified_attestation(attestation: VerifiedAttestation) -> Self {
        Self {
            readiness: attestation.readiness,
        }
    }

    #[cfg(test)]
    fn from_test_attestation(entries: &[(EffectClass, SecurityReadiness)]) -> Self {
        Self::from_verified_attestation(VerifiedAttestation::for_test(entries))
    }

    #[cfg(test)]
    pub(crate) fn from_test_readiness(entries: &[(EffectClass, SecurityReadiness)]) -> Self {
        Self::from_test_attestation(entries)
    }

    pub const fn readiness(&self, effect: EffectClass) -> SecurityReadiness {
        self.readiness[effect.index()]
    }

    pub fn require(&self, effect: EffectClass) -> Result<(), AuthorityError> {
        let readiness = self.readiness(effect);
        if readiness == SecurityReadiness::Enforced {
            Ok(())
        } else {
            Err(AuthorityError::ReadinessNotEnforced { effect, readiness })
        }
    }
}

impl Default for AuthorityGate {
    fn default() -> Self {
        Self::phase_zero()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandAuthority {
    OfflineRead,
    AccountManagement,
    LocalBookkeeping,
    SafetyControl,
    VerifiedBroker,
    DynamicRawRpc,
    Effects(&'static [EffectClass]),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TauriCommand {
    StartSession,
    AttachSession,
    DetachSession,
    StopSession,
    NoteAgent,
    FleetList,
    StopAgent,
    RenameAgent,
    SendRpc,
    ListSessions,
    GetStderr,
    BrowserSecurityStatus,
    BrowserCheckIntentAdmission,
    ListDiskSessions,
    ReadDiskSession,
    ReadChildSession,
    ListModels,
    GetProviderProductSnapshot,
    ListAccounts,
    AddAccount,
    PrepareRemoveAccount,
    CommitRemoveAccount,
    RenameAccount,
    AccountStatuses,
    BeginAccountLogin,
    AccountUsage,
    AccountUsageSeries,
    CodexSubscriptionUsage,
    ResolvePrimeCli,
    SetPrimeCli,
    CheckPrimeCli,
    GetAppSettings,
    ProjectCatalogLoad,
    ProjectCatalogApply,
    AttentionLoad,
    AttentionMarkSeen,
    SchedulerProjection,
    HarnessBootstrap,
    HarnessProjection,
    HarnessAttachSession,
    HarnessSessionCommand,
    HarnessInspector,
    HarnessArtifactOpen,
    HarnessRefreshSession,
    HarnessStudioOperation,
    HarnessCreateResidentChat,
    GetLayoutPreferences,
    SetLayoutPreferences,
    SetAppSetting,
    ExportAccountUsageCsv,
    EditorArtifactOpen,
    EditorArtifactSave,
    KernelStatus,
    FilesTouched,
    PickDirectory,
    ReadWorkspaceFile,
    ListWorkspaceFiles,
    OpenExternal,
    ComputerUseReadiness,
}

pub const ALL_TAURI_COMMANDS: [TauriCommand; 59] = [
    TauriCommand::StartSession,
    TauriCommand::AttachSession,
    TauriCommand::DetachSession,
    TauriCommand::StopSession,
    TauriCommand::NoteAgent,
    TauriCommand::FleetList,
    TauriCommand::StopAgent,
    TauriCommand::RenameAgent,
    TauriCommand::SendRpc,
    TauriCommand::ListSessions,
    TauriCommand::GetStderr,
    TauriCommand::BrowserSecurityStatus,
    TauriCommand::BrowserCheckIntentAdmission,
    TauriCommand::ListDiskSessions,
    TauriCommand::ReadDiskSession,
    TauriCommand::ReadChildSession,
    TauriCommand::ListModels,
    TauriCommand::GetProviderProductSnapshot,
    TauriCommand::ListAccounts,
    TauriCommand::AddAccount,
    TauriCommand::PrepareRemoveAccount,
    TauriCommand::CommitRemoveAccount,
    TauriCommand::RenameAccount,
    TauriCommand::AccountStatuses,
    TauriCommand::BeginAccountLogin,
    TauriCommand::AccountUsage,
    TauriCommand::AccountUsageSeries,
    TauriCommand::CodexSubscriptionUsage,
    TauriCommand::ResolvePrimeCli,
    TauriCommand::SetPrimeCli,
    TauriCommand::CheckPrimeCli,
    TauriCommand::GetAppSettings,
    TauriCommand::ProjectCatalogLoad,
    TauriCommand::ProjectCatalogApply,
    TauriCommand::AttentionLoad,
    TauriCommand::AttentionMarkSeen,
    TauriCommand::SchedulerProjection,
    TauriCommand::HarnessBootstrap,
    TauriCommand::HarnessProjection,
    TauriCommand::HarnessAttachSession,
    TauriCommand::HarnessSessionCommand,
    TauriCommand::HarnessInspector,
    TauriCommand::HarnessArtifactOpen,
    TauriCommand::HarnessRefreshSession,
    TauriCommand::HarnessStudioOperation,
    TauriCommand::HarnessCreateResidentChat,
    TauriCommand::GetLayoutPreferences,
    TauriCommand::SetLayoutPreferences,
    TauriCommand::SetAppSetting,
    TauriCommand::ExportAccountUsageCsv,
    TauriCommand::EditorArtifactOpen,
    TauriCommand::EditorArtifactSave,
    TauriCommand::KernelStatus,
    TauriCommand::FilesTouched,
    TauriCommand::PickDirectory,
    TauriCommand::ReadWorkspaceFile,
    TauriCommand::ListWorkspaceFiles,
    TauriCommand::OpenExternal,
    TauriCommand::ComputerUseReadiness,
];

impl TauriCommand {
    pub fn from_name(name: &str) -> Option<Self> {
        ALL_TAURI_COMMANDS
            .iter()
            .copied()
            .find(|command| command.name() == name)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::StartSession => "start_session",
            Self::AttachSession => "attach_session",
            Self::DetachSession => "detach_session",
            Self::StopSession => "stop_session",
            Self::NoteAgent => "note_agent",
            Self::FleetList => "fleet_list",
            Self::StopAgent => "stop_agent",
            Self::RenameAgent => "rename_agent",
            Self::SendRpc => "send_rpc",
            Self::ListSessions => "list_sessions",
            Self::GetStderr => "get_stderr",
            Self::BrowserSecurityStatus => "browser_security_status",
            Self::BrowserCheckIntentAdmission => "browser_check_intent_admission",
            Self::ListDiskSessions => "list_disk_sessions",
            Self::ReadDiskSession => "read_disk_session",
            Self::ReadChildSession => "read_child_session",
            Self::ListModels => "list_models",
            Self::GetProviderProductSnapshot => "get_provider_product_snapshot",
            Self::ListAccounts => "list_accounts",
            Self::AddAccount => "add_account",
            Self::PrepareRemoveAccount => "prepare_remove_account",
            Self::CommitRemoveAccount => "commit_remove_account",
            Self::RenameAccount => "rename_account",
            Self::AccountStatuses => "account_statuses",
            Self::BeginAccountLogin => "begin_account_login",
            Self::AccountUsage => "account_usage",
            Self::AccountUsageSeries => "account_usage_series",
            Self::CodexSubscriptionUsage => "codex_subscription_usage",
            Self::ResolvePrimeCli => "resolve_prime_cli",
            Self::SetPrimeCli => "set_prime_cli",
            Self::CheckPrimeCli => "check_prime_cli",
            Self::GetAppSettings => "get_app_settings",
            Self::ProjectCatalogLoad => "project_catalog_load",
            Self::ProjectCatalogApply => "project_catalog_apply",
            Self::AttentionLoad => "attention_load",
            Self::AttentionMarkSeen => "attention_mark_seen",
            Self::SchedulerProjection => "scheduler_projection",
            Self::HarnessBootstrap => "harness_bootstrap",
            Self::HarnessProjection => "harness_projection",
            Self::HarnessAttachSession => "harness_attach_session",
            Self::HarnessSessionCommand => "harness_session_command",
            Self::HarnessInspector => "harness_inspector",
            Self::HarnessArtifactOpen => "harness_artifact_open",
            Self::HarnessRefreshSession => "harness_refresh_session",
            Self::HarnessStudioOperation => "harness_studio_operation",
            Self::HarnessCreateResidentChat => "harness_create_resident_chat",
            Self::GetLayoutPreferences => "get_layout_preferences",
            Self::SetLayoutPreferences => "set_layout_preferences",
            Self::SetAppSetting => "set_app_setting",
            Self::ExportAccountUsageCsv => "export_account_usage_csv",
            Self::EditorArtifactOpen => "editor_artifact_open",
            Self::EditorArtifactSave => "editor_artifact_save",
            Self::KernelStatus => "kernel_status",
            Self::FilesTouched => "files_touched",
            Self::PickDirectory => "pick_directory",
            Self::ReadWorkspaceFile => "read_workspace_file",
            Self::ListWorkspaceFiles => "list_workspace_files",
            Self::OpenExternal => "open_external",
            Self::ComputerUseReadiness => "computer_use_readiness",
        }
    }

    pub const fn authority(self) -> CommandAuthority {
        use EffectClass::{
            AccountAuthentication, ExternalNavigation, LocalConfigurationWrite, LocalGitProcess,
            OpaqueInterpreter, PrimeCliProcess, PrimeSessionProcess, WorkspaceFilesystemRead,
        };
        match self {
            Self::StartSession | Self::AttachSession => {
                CommandAuthority::Effects(&[PrimeSessionProcess])
            }
            Self::FleetList
            | Self::StopAgent
            | Self::RenameAgent
            | Self::ListModels
            | Self::ResolvePrimeCli
            | Self::CheckPrimeCli => CommandAuthority::Effects(&[PrimeCliProcess]),
            Self::SetPrimeCli => {
                CommandAuthority::Effects(&[LocalConfigurationWrite, PrimeCliProcess])
            }
            Self::KernelStatus => CommandAuthority::Effects(&[OpaqueInterpreter]),
            Self::FilesTouched => CommandAuthority::Effects(&[LocalGitProcess]),
            Self::SetAppSetting | Self::SetLayoutPreferences => {
                CommandAuthority::Effects(&[LocalConfigurationWrite])
            }
            Self::PickDirectory
            | Self::ReadWorkspaceFile
            | Self::ListWorkspaceFiles
            | Self::ListDiskSessions
            | Self::ReadDiskSession
            | Self::ReadChildSession
            | Self::AccountUsage
            | Self::AccountUsageSeries
            | Self::CodexSubscriptionUsage => CommandAuthority::Effects(&[WorkspaceFilesystemRead]),
            Self::BeginAccountLogin => CommandAuthority::Effects(&[AccountAuthentication]),
            Self::OpenExternal => CommandAuthority::Effects(&[ExternalNavigation]),
            Self::DetachSession | Self::StopSession => CommandAuthority::SafetyControl,
            Self::HarnessAttachSession
            | Self::HarnessSessionCommand
            | Self::HarnessInspector
            | Self::HarnessArtifactOpen
            | Self::HarnessRefreshSession
            | Self::HarnessStudioOperation
            | Self::HarnessCreateResidentChat => CommandAuthority::VerifiedBroker,
            Self::ExportAccountUsageCsv => CommandAuthority::SafetyControl,
            Self::EditorArtifactOpen | Self::EditorArtifactSave => CommandAuthority::VerifiedBroker,
            Self::NoteAgent | Self::ProjectCatalogApply | Self::AttentionMarkSeen => {
                CommandAuthority::LocalBookkeeping
            }
            Self::SendRpc => CommandAuthority::DynamicRawRpc,
            Self::GetProviderProductSnapshot
            | Self::ListAccounts
            | Self::AddAccount
            | Self::PrepareRemoveAccount
            | Self::CommitRemoveAccount
            | Self::RenameAccount
            | Self::AccountStatuses => CommandAuthority::AccountManagement,
            Self::ListSessions
            | Self::GetStderr
            | Self::BrowserSecurityStatus
            | Self::BrowserCheckIntentAdmission
            | Self::GetAppSettings
            | Self::ProjectCatalogLoad
            | Self::AttentionLoad
            | Self::SchedulerProjection
            | Self::HarnessBootstrap
            | Self::HarnessProjection
            | Self::GetLayoutPreferences
            | Self::ComputerUseReadiness => CommandAuthority::OfflineRead,
        }
    }
}

/// Classify the actual command name and payload received at Tauri's dispatcher.
/// `send_rpc` is dynamic, so its nested Prime command must be admitted here too.
pub fn authorize_tauri_invoke(
    gate: &AuthorityGate,
    command_name: &str,
    payload: &Value,
) -> Result<(), AuthorityError> {
    let command = TauriCommand::from_name(command_name).ok_or_else(|| {
        AuthorityError::UnknownTauriCommand {
            command: command_name.to_owned(),
        }
    })?;
    match command {
        TauriCommand::SendRpc => {
            let raw_command = payload
                .as_object()
                .and_then(|object| object.get("command"))
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            authorize_raw_rpc(gate, raw_command)
        }
        TauriCommand::BrowserSecurityStatus
        | TauriCommand::HarnessBootstrap
        | TauriCommand::HarnessProjection => {
            let object = payload
                .as_object()
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            if !object.is_empty() {
                return Err(AuthorityError::MalformedTauriPayload);
            }
            authorize_tauri_command(gate, command)
        }
        TauriCommand::BrowserCheckIntentAdmission => {
            let object = payload
                .as_object()
                .filter(|object| object.len() == 1)
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            let request = object
                .get("request")
                .and_then(Value::as_object)
                .filter(|request| request.len() == 1)
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            let action_type = request
                .get("actionType")
                .and_then(Value::as_str)
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            if action_type != "inspect" && action_type != "screenshot" {
                return Err(AuthorityError::MalformedTauriPayload);
            }
            authorize_tauri_command(gate, command)
        }
        TauriCommand::ComputerUseReadiness => {
            let object = payload
                .as_object()
                .ok_or(AuthorityError::MalformedTauriPayload)?;
            if !object.is_empty() {
                return Err(AuthorityError::MalformedTauriPayload);
            }
            authorize_tauri_command(gate, command)
        }
        _ => authorize_tauri_command(gate, command),
    }
}

pub fn authorize_tauri_command(
    gate: &AuthorityGate,
    command: TauriCommand,
) -> Result<(), AuthorityError> {
    match command.authority() {
        CommandAuthority::Effects(effects) => {
            for &effect in effects {
                gate.require(effect)?;
            }
            Ok(())
        }
        CommandAuthority::DynamicRawRpc => Err(AuthorityError::RawRpcPayloadRequired),
        CommandAuthority::OfflineRead
        | CommandAuthority::AccountManagement
        | CommandAuthority::LocalBookkeeping
        | CommandAuthority::SafetyControl
        | CommandAuthority::VerifiedBroker => Ok(()),
    }
}

/// Run a Tauri operation only after its static command policy admits it. Keeping
/// the operation inside the closure makes fail-before-effect ordering explicit
/// and directly testable.
pub fn run_guarded_tauri_command<T>(
    gate: &AuthorityGate,
    command: TauriCommand,
    operation: impl FnOnce() -> T,
) -> Result<T, AuthorityError> {
    authorize_tauri_command(gate, command)?;
    Ok(operation())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RawRpcClass {
    SafetyControl,
    LiveRead,
    Export,
    TurnExecution,
    SessionMutation,
    AgentMessaging,
    BackgroundAutomation,
    Observation,
}

impl RawRpcClass {
    pub const fn effect(self) -> Option<EffectClass> {
        match self {
            Self::SafetyControl => None,
            Self::LiveRead => Some(EffectClass::PrimeRpcLiveRead),
            Self::Export => Some(EffectClass::PrimeRpcExport),
            Self::TurnExecution => Some(EffectClass::PrimeRpcTurn),
            Self::SessionMutation => Some(EffectClass::PrimeRpcSessionMutation),
            Self::AgentMessaging => Some(EffectClass::PrimeRpcMessaging),
            Self::BackgroundAutomation => Some(EffectClass::PrimeRpcBackground),
            Self::Observation => Some(EffectClass::PrimeRpcObservation),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RawRpcCommandPolicy {
    pub command: &'static str,
    pub class: RawRpcClass,
}

use RawRpcClass::{
    AgentMessaging, BackgroundAutomation, Export, LiveRead, Observation, SafetyControl,
    SessionMutation, TurnExecution,
};

pub const LEGACY_RAW_RPC_COMMANDS: [RawRpcCommandPolicy; 45] = [
    RawRpcCommandPolicy {
        command: "prompt",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "steer",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "follow_up",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "abort",
        class: SafetyControl,
    },
    RawRpcCommandPolicy {
        command: "new_session",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "get_state",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "set_model",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "cycle_model",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "get_available_models",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "set_thinking_level",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "cycle_thinking_level",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "set_steering_mode",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "set_follow_up_mode",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "compact",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "refine",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "set_auto_compaction",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "set_auto_retry",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "abort_retry",
        class: SafetyControl,
    },
    RawRpcCommandPolicy {
        command: "bash",
        class: TurnExecution,
    },
    RawRpcCommandPolicy {
        command: "abort_bash",
        class: SafetyControl,
    },
    RawRpcCommandPolicy {
        command: "get_session_stats",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "export_html",
        class: Export,
    },
    RawRpcCommandPolicy {
        command: "switch_session",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "fork",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "clone",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "get_fork_messages",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "get_last_assistant_text",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "set_session_name",
        class: SessionMutation,
    },
    RawRpcCommandPolicy {
        command: "get_messages",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "send_message",
        class: AgentMessaging,
    },
    RawRpcCommandPolicy {
        command: "agent_messages_status",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "agent_messages_pause",
        class: AgentMessaging,
    },
    RawRpcCommandPolicy {
        command: "agent_messages_resume",
        class: AgentMessaging,
    },
    RawRpcCommandPolicy {
        command: "agent_messages_clear",
        class: AgentMessaging,
    },
    RawRpcCommandPolicy {
        command: "list_schedules",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "add_schedule",
        class: BackgroundAutomation,
    },
    RawRpcCommandPolicy {
        command: "cancel_schedule",
        class: BackgroundAutomation,
    },
    RawRpcCommandPolicy {
        command: "list_heartbeats",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "get_heartbeat",
        class: LiveRead,
    },
    RawRpcCommandPolicy {
        command: "set_heartbeat",
        class: BackgroundAutomation,
    },
    RawRpcCommandPolicy {
        command: "update_heartbeat",
        class: BackgroundAutomation,
    },
    RawRpcCommandPolicy {
        command: "manage_heartbeat",
        class: BackgroundAutomation,
    },
    RawRpcCommandPolicy {
        command: "observe",
        class: Observation,
    },
    RawRpcCommandPolicy {
        command: "unobserve",
        class: Observation,
    },
    RawRpcCommandPolicy {
        command: "get_commands",
        class: LiveRead,
    },
];

pub fn authorize_raw_rpc(gate: &AuthorityGate, command: &Value) -> Result<(), AuthorityError> {
    let command_name = command
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
        .ok_or(AuthorityError::MalformedRawRpcCommand)?;
    let policy = LEGACY_RAW_RPC_COMMANDS
        .iter()
        .find(|policy| policy.command == command_name)
        .ok_or(AuthorityError::UnknownRawRpcCommand)?;
    match policy.class.effect() {
        Some(effect) => gate.require(effect),
        None => Ok(()),
    }
}

/// Authorize a raw command and bind it to a client process already owned by
/// this backend. This is what makes the Phase 0 cancellation exception
/// safety-reducing: an arbitrary daemon/session identifier cannot become a new
/// attach or control path.
pub fn authorize_known_session_rpc<'a, T>(
    gate: &AuthorityGate,
    sessions: &'a mut HashMap<String, T>,
    session_key: &str,
    command: &Value,
) -> Result<&'a mut T, AuthorityError> {
    authorize_raw_rpc(gate, command)?;
    sessions
        .get_mut(session_key)
        .ok_or_else(|| AuthorityError::UnknownStudioSession {
            session_key: session_key.to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_gate(entries: &[(EffectClass, SecurityReadiness)]) -> AuthorityGate {
        AuthorityGate::from_test_attestation(entries)
    }

    #[test]
    fn conjunctive_requirements_deny_until_every_effect_is_enforced() {
        use EffectClass::{LocalConfigurationWrite, PrimeCliProcess};

        let command = TauriCommand::SetPrimeCli;
        assert_eq!(
            command.authority(),
            CommandAuthority::Effects(&[LocalConfigurationWrite, PrimeCliProcess])
        );
        for gate in [
            test_gate(&[(LocalConfigurationWrite, SecurityReadiness::Enforced)]),
            test_gate(&[(PrimeCliProcess, SecurityReadiness::Enforced)]),
            test_gate(&[
                (LocalConfigurationWrite, SecurityReadiness::AdmissionOnly),
                (PrimeCliProcess, SecurityReadiness::Enforced),
            ]),
            test_gate(&[
                (LocalConfigurationWrite, SecurityReadiness::Enforced),
                (PrimeCliProcess, SecurityReadiness::AdmissionOnly),
            ]),
        ] {
            assert!(authorize_tauri_command(&gate, command).is_err());
        }

        let gate = test_gate(&[
            (LocalConfigurationWrite, SecurityReadiness::Enforced),
            (PrimeCliProcess, SecurityReadiness::Enforced),
        ]);
        assert_eq!(authorize_tauri_command(&gate, command), Ok(()));
    }

    #[test]
    fn every_static_effect_requires_each_exact_test_attestation() {
        for command in ALL_TAURI_COMMANDS {
            let CommandAuthority::Effects(effects) = command.authority() else {
                continue;
            };
            let enforced_entries: Vec<_> = effects
                .iter()
                .copied()
                .map(|effect| (effect, SecurityReadiness::Enforced))
                .collect();
            assert!(authorize_tauri_command(&test_gate(&enforced_entries), command).is_ok());

            for &withheld in effects {
                let entries: Vec<_> = effects
                    .iter()
                    .copied()
                    .filter(|effect| *effect != withheld)
                    .map(|effect| (effect, SecurityReadiness::Enforced))
                    .collect();
                assert_eq!(
                    authorize_tauri_command(&test_gate(&entries), command),
                    Err(AuthorityError::ReadinessNotEnforced {
                        effect: withheld,
                        readiness: SecurityReadiness::Unavailable,
                    }),
                    "{} borrowed authority without {}",
                    command.name(),
                    withheld.as_str()
                );
            }
        }
    }

    #[test]
    fn each_raw_effect_accepts_only_its_exact_test_attestation() {
        for policy in LEGACY_RAW_RPC_COMMANDS {
            let Some(effect) = policy.class.effect() else {
                continue;
            };
            let exact = test_gate(&[(effect, SecurityReadiness::Enforced)]);
            assert!(
                authorize_raw_rpc(&exact, &serde_json::json!({ "type": policy.command })).is_ok()
            );
        }
    }
}
