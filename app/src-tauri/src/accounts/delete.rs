//! Safe account-removal planning and validation.

use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::recovery::{
    create_journal, create_proposed_registry, ensure_layout, file_snapshot, recover_locked,
    remove_transaction_files, remove_transaction_files_observed, update_journal, RecoverySummary,
    SealedProposedRegistry, TransactionJournal, TransactionPaths, TransactionPhase,
    JOURNAL_VERSION,
};
use super::{
    durable_remove_cleanup_entry, durable_rename, read_account_registry_bounded, Account,
    AccountRegistry, AccountRegistryReadError, MAX_ACCOUNT_REGISTRY_BYTES,
};

pub const MAX_ESTIMATE_ITEMS: u64 = 10_000;
pub const MAX_ESTIMATE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_PLAN_TOMBSTONES: usize = 1_024;
pub(crate) const MAX_CLEANUP_MANIFEST_ENTRIES: usize = 100_000;
pub(crate) const MAX_CLEANUP_PATH_COMPONENTS: usize = 256;
pub(crate) const MAX_CLEANUP_COMPONENT_UTF16_UNITS: usize = 255;
pub(crate) const MAX_CLEANUP_MANIFEST_UTF16_UNITS: usize = 16_777_216;
pub(crate) const MAX_CLEANUP_FILE_ALIASES: u32 = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub volume: u64,
    pub file: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathSnapshot {
    pub(crate) identity: FileIdentity,
    pub(crate) reparse_point: bool,
    pub(crate) directory: bool,
    pub(crate) hard_links: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupManifestEntry {
    pub(crate) relative_path: Vec<Vec<u16>>,
    pub(crate) snapshot: PathSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalEstimate {
    pub items: u64,
    pub bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalChecks {
    pub active_session: bool,
    pub shared_profile: bool,
    pub default_or_migrated: bool,
    pub stored_path_matches: bool,
    pub direct_child: bool,
    pub reparse_point: bool,
    pub data_deletion_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalBlocker {
    ActiveSession,
    SharedProfile,
    DefaultOrMigrated,
    StoredPathMismatch,
    UnsafeTarget,
    ReparsePoint,
    UnsupportedPlatform,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreparedCommitStrategy {
    WindowsTransaction,
    PortableEntryOnly,
    UnsupportedProfileData,
}

fn prepared_commit_strategy(is_windows: bool, delete_data: bool) -> PreparedCommitStrategy {
    if is_windows {
        PreparedCommitStrategy::WindowsTransaction
    } else if delete_data {
        PreparedCommitStrategy::UnsupportedProfileData
    } else {
        PreparedCommitStrategy::PortableEntryOnly
    }
}

fn current_platform_commit_strategy(delete_data: bool) -> PreparedCommitStrategy {
    prepared_commit_strategy(cfg!(windows), delete_data)
}

fn platform_removal_blocker(strategy: PreparedCommitStrategy) -> Option<RemovalBlocker> {
    (strategy == PreparedCommitStrategy::UnsupportedProfileData)
        .then_some(RemovalBlocker::UnsupportedPlatform)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPlan {
    pub plan_id: String,
    pub account_label: String,
    pub target_path: String,
    pub delete_data: bool,
    pub expires_at_ms: u64,
    pub registry_generation: String,
    pub target_identity: Option<FileIdentity>,
    pub estimate: RemovalEstimate,
    pub checks: RemovalChecks,
    pub blockers: Vec<RemovalBlocker>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeletionErrorCode {
    AccountNotFound,
    InvalidAccountId,
    PlanNotFound,
    PlanExpired,
    PlanReplayed,
    PlanBlocked,
    PlanRequired,
    RegistryChanged,
    TargetChanged,
    LabelMismatch,
    QuarantineConflict,
    RecoveryRequired,
    OutcomeUnknown,
    CleanupPending,
    RegistryInvalid,
    UnsafeTarget,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionError {
    pub code: DeletionErrorCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionFaultPoint {
    AfterJournalPrepared,
    AfterProposalAllocatedBeforeOwnershipJournal,
    AfterDurableProposalCreated,
    AfterProposedRegistryFlushed,
    AfterDurableQuarantineRename,
    AfterQuarantineRenamed,
    AfterDurableRestoreRename,
    BeforeRegistryReplace,
    AfterFinalProposalValidated,
    AfterRegistryReplaced,
    AfterCommittedJournalFlushed,
    BeforeCleanupEntry,
    BeforeCleanupIdentityGroupValidation,
    AfterDurableCleanupEntry,
    AfterCleanupEntry,
    AfterCleanupComplete,
    AfterDurableJournalDelete,
}

#[derive(Clone, Debug)]
pub struct TransactionObservation {
    pub transaction_id: String,
    pub source: PathBuf,
    pub quarantine: PathBuf,
    pub journal: PathBuf,
    pub proposed_registry: PathBuf,
    pub cleanup_entry: Option<PathBuf>,
    pub cleanup_path_opens: u64,
}

impl std::fmt::Display for DeletionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DeletionError {}

pub struct AccountDeletion {
    registry: Arc<AccountRegistry>,
    plan_ttl_ms: u64,
    plans: Mutex<PlanStore>,
}

#[derive(Default)]
struct PlanStore {
    pending: HashMap<String, StoredPlan>,
    claimed: VecDeque<String>,
}

struct StoredPlan {
    public: RemovalPlan,
    account_id: String,
    target: PathBuf,
    registry_identity: FileIdentity,
}

impl AccountDeletion {
    pub fn with_ttl(registry: Arc<AccountRegistry>, plan_ttl_ms: u64) -> Self {
        Self {
            registry,
            plan_ttl_ms,
            plans: Mutex::new(PlanStore::default()),
        }
    }

    pub fn prepare_remove_account_at(
        &self,
        id: &str,
        delete_data: bool,
        active_account_ids: &HashSet<String>,
        now_ms: u64,
    ) -> Result<RemovalPlan, DeletionError> {
        let target = derive_deletion_target(self.registry.profiles_dir(), id)?;
        let _guard = self.registry.lock().map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "account registry is unavailable".to_owned(),
        })?;
        let registry_path = self.registry.registry_path();
        let registry_before = validated_regular_file_snapshot(
            &registry_path,
            DeletionErrorCode::UnsafeTarget,
            "account registry is not a safe regular file",
        )?;
        let (registry_bytes, accounts) = read_strict_account_registry(&registry_path)?;
        let registry_after = validated_regular_file_snapshot(
            &registry_path,
            DeletionErrorCode::TargetChanged,
            "account registry changed while it was read",
        )?;
        if registry_before.identity != registry_after.identity {
            return Err(deletion_error(
                DeletionErrorCode::TargetChanged,
                "account registry changed while it was read",
            ));
        }
        let account = accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| DeletionError {
                code: DeletionErrorCode::AccountNotFound,
                message: "account was not found".to_owned(),
            })?;
        let stored_path_matches = matches!(
            profile_reference_match(
                self.registry.profiles_dir(),
                Path::new(&account.agent_dir),
                &target,
            ),
            ProfileReferenceMatch::Equivalent
        );
        let direct_child = target.parent() == Some(self.registry.profiles_dir());
        let active_session = active_account_ids.contains(id);
        let default_or_migrated = id.starts_with("default-")
            || paths_equal_lexically(
                Path::new(&account.agent_dir),
                self.registry.default_agent_dir(),
            );
        let shared_profile = accounts.iter().any(|other| {
            other.id != account.id
                && !matches!(
                    profile_reference_match(
                        self.registry.profiles_dir(),
                        Path::new(&other.agent_dir),
                        &target,
                    ),
                    ProfileReferenceMatch::Distinct
                )
        });
        let reparse_boundary = first_reparse_component(&target)?;
        let (estimate, reparse_point, target_identity) = if let Some(boundary) = reparse_boundary {
            let items = u64::from(boundary == target);
            (
                RemovalEstimate {
                    items,
                    bytes: 0,
                    truncated: false,
                },
                true,
                None,
            )
        } else {
            let (estimate, subtree_reparse) = bounded_estimate(&target)?;
            let snapshot = path_snapshot_no_follow(&target).map_err(|_| DeletionError {
                code: DeletionErrorCode::Io,
                message: "profile identity could not be inspected".to_owned(),
            })?;
            let leaf_reparse = snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.reparse_point);
            let target_identity = snapshot
                .filter(|snapshot| !snapshot.reparse_point)
                .map(|snapshot| snapshot.identity);
            (estimate, subtree_reparse || leaf_reparse, target_identity)
        };
        let mut blockers = Vec::new();
        if !stored_path_matches {
            blockers.push(RemovalBlocker::StoredPathMismatch);
        }
        if default_or_migrated {
            blockers.push(RemovalBlocker::DefaultOrMigrated);
        }
        if shared_profile {
            blockers.push(RemovalBlocker::SharedProfile);
        }
        if active_session {
            blockers.push(RemovalBlocker::ActiveSession);
        }
        if reparse_point {
            blockers.push(RemovalBlocker::ReparsePoint);
        }
        if let Some(blocker) =
            platform_removal_blocker(current_platform_commit_strategy(delete_data))
        {
            blockers.push(blocker);
        }
        let data_deletion_allowed = blockers.is_empty();
        let registry_generation = format!("{:x}", Sha256::digest(&registry_bytes));
        let plan = RemovalPlan {
            plan_id: Uuid::new_v4().simple().to_string(),
            account_label: account.label.clone(),
            target_path: target.to_string_lossy().into_owned(),
            delete_data,
            expires_at_ms: now_ms.saturating_add(self.plan_ttl_ms),
            registry_generation,
            target_identity,
            estimate,
            checks: RemovalChecks {
                active_session,
                shared_profile,
                default_or_migrated,
                stored_path_matches,
                direct_child,
                reparse_point,
                data_deletion_allowed,
            },
            blockers,
        };
        self.plans
            .lock()
            .map_err(|_| DeletionError {
                code: DeletionErrorCode::Io,
                message: "deletion plan store is unavailable".to_owned(),
            })?
            .pending
            .insert(
                plan.plan_id.clone(),
                StoredPlan {
                    public: plan.clone(),
                    account_id: account.id.clone(),
                    target,
                    registry_identity: registry_after.identity,
                },
            );
        Ok(plan)
    }

    pub fn claim_plan_at(&self, plan_id: &str, now_ms: u64) -> Result<RemovalPlan, DeletionError> {
        let _registry_guard = self.registry.lock().map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "account registry is unavailable".to_owned(),
        })?;
        let registry = read_strict_account_registry(&self.registry.registry_path());
        let mut plans = self.plans.lock().map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "deletion plan store is unavailable".to_owned(),
        })?;
        if plans.claimed.iter().any(|claimed| claimed == plan_id) {
            return Err(DeletionError {
                code: DeletionErrorCode::PlanReplayed,
                message: "deletion plan has already been claimed".to_owned(),
            });
        }
        let stored = plans.pending.remove(plan_id).ok_or_else(|| DeletionError {
            code: DeletionErrorCode::PlanNotFound,
            message: "deletion plan was not found".to_owned(),
        })?;
        remember_claimed(&mut plans, plan_id);
        let plan = stored.public;
        let (registry_bytes, _) = registry?;
        let registry_generation = format!("{:x}", Sha256::digest(&registry_bytes));
        if registry_generation != plan.registry_generation {
            return Err(DeletionError {
                code: DeletionErrorCode::RegistryChanged,
                message: "account registry changed after this plan was prepared".to_owned(),
            });
        }
        if now_ms >= plan.expires_at_ms {
            return Err(DeletionError {
                code: DeletionErrorCode::PlanExpired,
                message: "deletion plan has expired".to_owned(),
            });
        }
        if plan.delete_data && !plan.checks.data_deletion_allowed {
            return Err(DeletionError {
                code: DeletionErrorCode::PlanBlocked,
                message: "deletion plan is blocked by current account safety checks".to_owned(),
            });
        }
        if plan.delete_data {
            match first_reparse_component(&stored.target) {
                Ok(Some(_)) => {
                    return Err(DeletionError {
                        code: DeletionErrorCode::UnsafeTarget,
                        message: "deletion target crossed a reparse boundary".to_owned(),
                    });
                }
                Ok(None) => {}
                Err(error) => return Err(error),
            }
            let fresh_snapshot = match path_snapshot_no_follow(&stored.target) {
                Ok(snapshot) => snapshot,
                Err(_) => {
                    return Err(DeletionError {
                        code: DeletionErrorCode::Io,
                        message: "deletion target identity could not be inspected".to_owned(),
                    });
                }
            };
            if fresh_snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.reparse_point)
            {
                return Err(DeletionError {
                    code: DeletionErrorCode::UnsafeTarget,
                    message: "deletion target became a reparse point".to_owned(),
                });
            }
            let fresh_identity = fresh_snapshot.map(|snapshot| snapshot.identity);
            if fresh_identity != plan.target_identity {
                return Err(DeletionError {
                    code: DeletionErrorCode::TargetChanged,
                    message: "deletion target changed after this plan was prepared".to_owned(),
                });
            }
        }
        Ok(plan)
    }

    pub fn commit_remove_account_at(
        &self,
        plan_id: &str,
        typed_label: &str,
        active_account_ids: &HashSet<String>,
        now_ms: u64,
    ) -> Result<(), DeletionError> {
        self.commit_remove_account_at_with_observer(
            plan_id,
            typed_label,
            active_account_ids,
            now_ms,
            |_point, _observation| Ok(()),
        )
    }

    pub fn recover_pending_transactions(&self) -> Result<RecoverySummary, DeletionError> {
        let _registry_guard = self.registry.lock().map_err(|_| {
            deletion_error(
                DeletionErrorCode::Io,
                "account registry is unavailable for recovery",
            )
        })?;
        recover_locked(&self.registry)
    }

    #[doc(hidden)]
    pub fn commit_remove_account_at_with_observer<F>(
        &self,
        plan_id: &str,
        typed_label: &str,
        active_account_ids: &HashSet<String>,
        now_ms: u64,
        observer: F,
    ) -> Result<(), DeletionError>
    where
        F: FnMut(TransactionFaultPoint, &TransactionObservation) -> Result<(), ()>,
    {
        self.commit_remove_account_at_with_observer_for_platform(
            plan_id,
            typed_label,
            active_account_ids,
            now_ms,
            cfg!(windows),
            observer,
        )
    }

    fn commit_remove_account_at_with_observer_for_platform<F>(
        &self,
        plan_id: &str,
        typed_label: &str,
        active_account_ids: &HashSet<String>,
        now_ms: u64,
        is_windows: bool,
        mut observer: F,
    ) -> Result<(), DeletionError>
    where
        F: FnMut(TransactionFaultPoint, &TransactionObservation) -> Result<(), ()>,
    {
        let _registry_guard = self.registry.lock().map_err(|_| {
            deletion_error(DeletionErrorCode::Io, "account registry is unavailable")
        })?;
        {
            let plans = self.plans.lock().map_err(|_| {
                deletion_error(DeletionErrorCode::Io, "deletion plan store is unavailable")
            })?;
            if plans.claimed.iter().any(|claimed| claimed == plan_id) {
                return Err(deletion_error(
                    DeletionErrorCode::PlanReplayed,
                    "deletion plan has already been claimed",
                ));
            }
        }
        recover_locked(&self.registry)?;
        let stored = {
            let mut plans = self.plans.lock().map_err(|_| {
                deletion_error(DeletionErrorCode::Io, "deletion plan store is unavailable")
            })?;
            if plans.claimed.iter().any(|claimed| claimed == plan_id) {
                return Err(deletion_error(
                    DeletionErrorCode::PlanReplayed,
                    "deletion plan has already been claimed",
                ));
            }
            let stored = plans.pending.remove(plan_id).ok_or_else(|| {
                deletion_error(
                    DeletionErrorCode::PlanNotFound,
                    "deletion plan was not found",
                )
            })?;
            remember_claimed(&mut plans, plan_id);
            stored
        };
        let plan = &stored.public;
        if now_ms >= plan.expires_at_ms {
            return Err(deletion_error(
                DeletionErrorCode::PlanExpired,
                "deletion plan has expired",
            ));
        }
        let registry_path = self.registry.registry_path();
        let registry_before = validated_regular_file_snapshot(
            &registry_path,
            DeletionErrorCode::TargetChanged,
            "account registry changed after this plan was prepared",
        )?;
        if registry_before.identity != stored.registry_identity {
            return Err(deletion_error(
                DeletionErrorCode::TargetChanged,
                "account registry changed after this plan was prepared",
            ));
        }
        let (registry_bytes, accounts) = read_strict_account_registry(&registry_path)?;
        let registry_after = validated_regular_file_snapshot(
            &registry_path,
            DeletionErrorCode::TargetChanged,
            "account registry changed while it was read",
        )?;
        if registry_before.identity != registry_after.identity {
            return Err(deletion_error(
                DeletionErrorCode::TargetChanged,
                "account registry changed while it was read",
            ));
        }
        let current_generation = registry_generation(&registry_bytes);
        if current_generation != plan.registry_generation {
            return Err(deletion_error(
                DeletionErrorCode::RegistryChanged,
                "account registry changed after this plan was prepared",
            ));
        }
        if plan.delete_data && typed_label != plan.account_label {
            return Err(deletion_error(
                DeletionErrorCode::LabelMismatch,
                "typed account label did not match the prepared plan",
            ));
        }
        let account = accounts
            .iter()
            .find(|account| account.id == stored.account_id)
            .ok_or_else(|| {
                deletion_error(DeletionErrorCode::AccountNotFound, "account was not found")
            })?;
        if account.label != plan.account_label {
            return Err(deletion_error(
                DeletionErrorCode::RegistryChanged,
                "account changed after this plan was prepared",
            ));
        }
        let target = derive_deletion_target(self.registry.profiles_dir(), &stored.account_id)?;
        if target != stored.target || target.parent() != Some(self.registry.profiles_dir()) {
            return Err(deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "derived profile is not the prepared direct-child target",
            ));
        }

        let source_snapshot = if plan.delete_data {
            self.revalidate_data_removal(account, &accounts, &target, plan, active_account_ids)?
        } else {
            None
        };
        let source_present = source_snapshot.is_some();
        let mut retained_accounts = accounts;
        let position = retained_accounts
            .iter()
            .position(|account| account.id == stored.account_id)
            .ok_or_else(|| {
                deletion_error(DeletionErrorCode::AccountNotFound, "account was not found")
            })?;
        retained_accounts.remove(position);
        match prepared_commit_strategy(is_windows, plan.delete_data) {
            PreparedCommitStrategy::PortableEntryOnly => {
                return self.registry.write_locked(&retained_accounts).map_err(|_| {
                    deletion_error(DeletionErrorCode::Io, "account registry replacement failed")
                });
            }
            PreparedCommitStrategy::UnsupportedProfileData => {
                return Err(deletion_error(
                    DeletionErrorCode::PlanBlocked,
                    "profile-data removal is available only on Windows",
                ));
            }
            PreparedCommitStrategy::WindowsTransaction => {}
        }
        let proposed_registry = serde_json::to_vec_pretty(&retained_accounts).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RegistryInvalid,
                "replacement account registry could not be serialized",
            )
        })?;
        let proposed_generation = registry_generation(&proposed_registry);
        let transaction_id = Uuid::new_v4().simple().to_string();
        let paths = TransactionPaths::new(self.registry.profiles_dir(), &transaction_id);
        ensure_layout(&paths).map_err(|_| {
            deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "Studio quarantine could not be created safely",
            )
        })?;
        validate_quarantine_destination(&paths, source_snapshot.as_ref())?;
        let mut observation = TransactionObservation {
            transaction_id: transaction_id.clone(),
            source: target.clone(),
            quarantine: paths.quarantine.clone(),
            journal: paths.journal.clone(),
            proposed_registry: paths.proposed_registry.clone(),
            cleanup_entry: None,
            cleanup_path_opens: 0,
        };

        let mut journal = TransactionJournal {
            version: JOURNAL_VERSION,
            transaction_id,
            account_id: stored.account_id,
            original_registry_generation: current_generation,
            proposed_registry_generation: proposed_generation,
            proposal_identity: None,
            source_identity: source_snapshot
                .as_ref()
                .map(|snapshot| snapshot.identity.clone()),
            source_present,
            cleanup_manifest: None,
            cleanup_progress: 0,
            phase: TransactionPhase::JournalPrepared,
        };
        create_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "account-removal journal could not be persisted",
            )
        })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterJournalPrepared,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        let open_proposal = create_proposed_registry(&paths).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "proposed account registry could not be allocated",
            )
        })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterProposalAllocatedBeforeOwnershipJournal,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        journal.proposal_identity = Some(open_proposal.identity().clone());
        journal.phase = TransactionPhase::ProposalIdentityRecorded;
        if update_journal(&paths, &journal).is_err() {
            drop(open_proposal);
            let _ = remove_transaction_files(&paths, &journal);
            return Err(deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "proposed account registry ownership could not be persisted",
            ));
        }
        let open_proposal = open_proposal
            .persist(&paths, &proposed_registry)
            .map_err(|_| {
                deletion_error(
                    DeletionErrorCode::RecoveryRequired,
                    "proposed account registry could not be persisted",
                )
            })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterDurableProposalCreated,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        journal.phase = TransactionPhase::ProposedRegistryFlushed;
        update_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "account-removal journal could not be advanced",
            )
        })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterProposedRegistryFlushed,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        validate_proposed_registry(
            &paths.proposed_registry,
            &proposed_registry,
            &journal.proposed_registry_generation,
            open_proposal.identity(),
        )?;

        if let Some(snapshot) = source_snapshot.as_ref() {
            if let Err(error) =
                validate_source_before_quarantine(&target, &paths.quarantine, snapshot)
            {
                let _ = remove_transaction_files(&paths, &journal);
                return Err(error);
            }
            durable_rename(&target, &paths.quarantine).map_err(|_| {
                deletion_error(
                    DeletionErrorCode::RecoveryRequired,
                    "profile could not be moved into Studio quarantine",
                )
            })?;
            let quarantined = path_snapshot_no_follow(&paths.quarantine)
                .map_err(|_| {
                    deletion_error(
                        DeletionErrorCode::OutcomeUnknown,
                        "quarantined profile identity could not be inspected",
                    )
                })?
                .ok_or_else(|| {
                    deletion_error(
                        DeletionErrorCode::OutcomeUnknown,
                        "quarantined profile was not found after movement",
                    )
                })?;
            if quarantined.reparse_point || quarantined.identity != snapshot.identity {
                return Err(deletion_error(
                    DeletionErrorCode::OutcomeUnknown,
                    "quarantined profile identity changed during movement",
                ));
            }
            observe_transition(
                &mut observer,
                TransactionFaultPoint::AfterDurableQuarantineRename,
                &observation,
                DeletionErrorCode::RecoveryRequired,
            )?;
        }
        journal.phase = TransactionPhase::ProfileQuarantined;
        update_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "account-removal journal could not record quarantine",
            )
        })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterQuarantineRenamed,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        let precommit_validation = validate_proposed_registry(
            &paths.proposed_registry,
            &proposed_registry,
            &journal.proposed_registry_generation,
            open_proposal.identity(),
        )
        .and_then(|()| {
            validate_quarantine_before_registry(
                &target,
                &paths.quarantine,
                source_snapshot.as_ref(),
                plan.delete_data,
            )
        });
        if let Err(error) = precommit_validation {
            return match restore_quarantine(
                &target,
                &paths,
                source_snapshot.as_ref(),
                &mut observer,
                &observation,
            ) {
                Ok(()) => {
                    let _ = remove_transaction_files(&paths, &journal);
                    Err(error)
                }
                Err(()) => Err(deletion_error(
                    DeletionErrorCode::OutcomeUnknown,
                    "pre-commit validation failed and profile restoration is uncertain",
                )),
            };
        }
        observe_transition(
            &mut observer,
            TransactionFaultPoint::BeforeRegistryReplace,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        let registry_still_bound = validated_regular_file_snapshot(
            &registry_path,
            DeletionErrorCode::TargetChanged,
            "account registry changed before durable replacement",
        )
        .and_then(|snapshot| {
            if snapshot.identity == stored.registry_identity {
                Ok(())
            } else {
                Err(deletion_error(
                    DeletionErrorCode::TargetChanged,
                    "account registry changed before durable replacement",
                ))
            }
        });
        if let Err(error) = registry_still_bound {
            return match restore_quarantine(
                &target,
                &paths,
                source_snapshot.as_ref(),
                &mut observer,
                &observation,
            ) {
                Ok(()) => {
                    let _ = remove_transaction_files(&paths, &journal);
                    Err(error)
                }
                Err(()) => Err(deletion_error(
                    DeletionErrorCode::OutcomeUnknown,
                    "registry identity changed and profile restoration is uncertain",
                )),
            };
        }
        let mut sealed_proposal = match open_proposal.seal() {
            Ok(proposal) => proposal,
            Err(_) => {
                let error = deletion_error(
                    DeletionErrorCode::TargetChanged,
                    "proposed account registry could not be sealed for commit",
                );
                return match restore_quarantine(
                    &target,
                    &paths,
                    source_snapshot.as_ref(),
                    &mut observer,
                    &observation,
                ) {
                    Ok(()) => {
                        let _ = remove_transaction_files(&paths, &journal);
                        Err(error)
                    }
                    Err(()) => Err(deletion_error(
                        DeletionErrorCode::OutcomeUnknown,
                        "proposal sealing failed and profile restoration is uncertain",
                    )),
                };
            }
        };
        if let Err(error) = validate_sealed_proposed_registry(
            &mut sealed_proposal,
            &paths.proposed_registry,
            &proposed_registry,
            &journal.proposed_registry_generation,
            journal
                .proposal_identity
                .as_ref()
                .expect("a sealed proposal always has a journal identity"),
        ) {
            drop(sealed_proposal);
            return match restore_quarantine(
                &target,
                &paths,
                source_snapshot.as_ref(),
                &mut observer,
                &observation,
            ) {
                Ok(()) => {
                    let _ = remove_transaction_files(&paths, &journal);
                    Err(error)
                }
                Err(()) => Err(deletion_error(
                    DeletionErrorCode::OutcomeUnknown,
                    "final proposal validation failed and profile restoration is uncertain",
                )),
            };
        }
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterFinalProposalValidated,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        let installed_identity = match self
            .registry
            .replace_with_proposed_locked(&paths.proposed_registry, sealed_proposal)
        {
            Ok(identity) => identity,
            Err(error) if error.namespace_replaced => {
                let _durability_error_kind = error.error.kind();
                return Err(deletion_error(
                    DeletionErrorCode::RecoveryRequired,
                    "registry namespace changed but durability could not be confirmed",
                ));
            }
            Err(error) => {
                let _replacement_error_kind = error.error.kind();
                return match restore_quarantine(
                    &target,
                    &paths,
                    source_snapshot.as_ref(),
                    &mut observer,
                    &observation,
                ) {
                    Ok(()) => {
                        let _ = remove_transaction_files(&paths, &journal);
                        Err(deletion_error(
                            DeletionErrorCode::Io,
                            "account registry replacement failed; profile was restored",
                        ))
                    }
                    Err(()) => Err(deletion_error(
                        DeletionErrorCode::OutcomeUnknown,
                        "account registry replacement failed and profile restoration is uncertain",
                    )),
                };
            }
        };
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterRegistryReplaced,
            &observation,
            DeletionErrorCode::RecoveryRequired,
        )?;
        let mut committed_registry =
            CommittedRegistryGuard::bind(&registry_path, &proposed_registry, &installed_identity)?;
        journal.phase = TransactionPhase::RegistryReplaced;
        update_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "registry committed but the recovery journal could not be advanced",
            )
        })?;
        journal.phase = TransactionPhase::Committed;
        update_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::RecoveryRequired,
                "registry committed but commit state could not be flushed",
            )
        })?;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterCommittedJournalFlushed,
            &observation,
            DeletionErrorCode::CleanupPending,
        )?;
        let cleanup_manifest = if let Some(snapshot) = source_snapshot.as_ref() {
            build_cleanup_manifest(&paths.quarantine, &snapshot.identity).map_err(|_| {
                deletion_error(
                    DeletionErrorCode::CleanupPending,
                    "registry committed but cleanup inventory could not be prepared",
                )
            })?
        } else {
            Vec::new()
        };
        journal.cleanup_manifest = Some(cleanup_manifest);
        journal.cleanup_progress = 0;
        journal.phase = TransactionPhase::CleanupInProgress;
        update_journal(&paths, &journal).map_err(|_| {
            deletion_error(
                DeletionErrorCode::CleanupPending,
                "registry committed but cleanup state could not be persisted",
            )
        })?;
        if let Some(snapshot) = source_snapshot.as_ref() {
            let cleanup_manifest = journal.cleanup_manifest.clone().ok_or_else(|| {
                deletion_error(
                    DeletionErrorCode::CleanupPending,
                    "registry committed but cleanup inventory is unavailable",
                )
            })?;
            let cleanup_progress = journal.cleanup_progress;
            observation.cleanup_path_opens = delete_tree_no_follow_observed(
                &paths.quarantine,
                &snapshot.identity,
                &cleanup_manifest,
                cleanup_progress,
                |next_progress| {
                    journal.cleanup_progress = next_progress;
                    update_journal(&paths, &journal)
                },
                |point, entry, cleanup_path_opens| {
                    observation.cleanup_entry = Some(entry.to_path_buf());
                    observation.cleanup_path_opens = cleanup_path_opens;
                    observe_transition(
                        &mut observer,
                        point,
                        &observation,
                        DeletionErrorCode::CleanupPending,
                    )
                    .map_err(|_| std::io::Error::other("injected cleanup interruption"))
                },
            )
            .map_err(|_| {
                deletion_error(
                    DeletionErrorCode::CleanupPending,
                    "registry committed but quarantined data cleanup is pending",
                )
            })?;
        }
        observation.cleanup_entry = None;
        observe_transition(
            &mut observer,
            TransactionFaultPoint::AfterCleanupComplete,
            &observation,
            DeletionErrorCode::CleanupPending,
        )?;
        committed_registry.verify_exact(&proposed_registry)?;
        remove_transaction_files_observed(&paths, &journal, || {
            observe_transition(
                &mut observer,
                TransactionFaultPoint::AfterDurableJournalDelete,
                &observation,
                DeletionErrorCode::CleanupPending,
            )
            .map_err(|_| std::io::Error::other("injected journal-deletion interruption"))
        })
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::CleanupPending,
                "registry committed but transaction-record cleanup is pending",
            )
        })?;
        Ok(())
    }

    fn revalidate_data_removal(
        &self,
        account: &Account,
        accounts: &[Account],
        target: &Path,
        plan: &RemovalPlan,
        active_account_ids: &HashSet<String>,
    ) -> Result<Option<PathSnapshot>, DeletionError> {
        if !plan.checks.data_deletion_allowed
            || active_account_ids.contains(&account.id)
            || account.id.starts_with("default-")
            || paths_equal_lexically(
                Path::new(&account.agent_dir),
                self.registry.default_agent_dir(),
            )
            || !matches!(
                profile_reference_match(
                    self.registry.profiles_dir(),
                    Path::new(&account.agent_dir),
                    target,
                ),
                ProfileReferenceMatch::Equivalent
            )
            || accounts.iter().any(|other| {
                other.id != account.id
                    && !matches!(
                        profile_reference_match(
                            self.registry.profiles_dir(),
                            Path::new(&other.agent_dir),
                            target,
                        ),
                        ProfileReferenceMatch::Distinct
                    )
            })
        {
            return Err(deletion_error(
                DeletionErrorCode::PlanBlocked,
                "deletion plan is blocked by current account safety checks",
            ));
        }
        if first_reparse_component(target)?.is_some() {
            return Err(deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "deletion target crossed a reparse boundary",
            ));
        }
        let snapshot = path_snapshot_no_follow(target).map_err(|_| {
            deletion_error(
                DeletionErrorCode::Io,
                "deletion target identity could not be inspected",
            )
        })?;
        if snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.reparse_point || !snapshot.directory || unsafe_hard_link_count(snapshot)
        }) {
            return Err(deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "deletion target is not a safe profile directory",
            ));
        }
        if snapshot.as_ref().map(|snapshot| &snapshot.identity) != plan.target_identity.as_ref() {
            return Err(deletion_error(
                DeletionErrorCode::TargetChanged,
                "deletion target changed after this plan was prepared",
            ));
        }
        if snapshot.is_some() {
            verify_tree_no_reparse(target)?;
            let after_scan = path_snapshot_no_follow(target).map_err(|_| {
                deletion_error(
                    DeletionErrorCode::Io,
                    "deletion target identity could not be rechecked",
                )
            })?;
            if after_scan.as_ref().map(|snapshot| &snapshot.identity)
                != snapshot.as_ref().map(|snapshot| &snapshot.identity)
            {
                return Err(deletion_error(
                    DeletionErrorCode::TargetChanged,
                    "deletion target changed while it was inspected",
                ));
            }
        }
        Ok(snapshot)
    }
}

fn read_strict_account_registry(path: &Path) -> Result<(Vec<u8>, Vec<Account>), DeletionError> {
    read_account_registry_bounded(path).map_err(|error| match error {
        AccountRegistryReadError::Invalid => deletion_error(
            DeletionErrorCode::RegistryInvalid,
            "account registry is invalid",
        ),
        AccountRegistryReadError::Io => {
            deletion_error(DeletionErrorCode::Io, "account registry could not be read")
        }
    })
}

fn deletion_error(code: DeletionErrorCode, message: &str) -> DeletionError {
    DeletionError {
        code,
        message: message.to_owned(),
    }
}

fn observe_transition<F>(
    observer: &mut F,
    point: TransactionFaultPoint,
    observation: &TransactionObservation,
    code: DeletionErrorCode,
) -> Result<(), DeletionError>
where
    F: FnMut(TransactionFaultPoint, &TransactionObservation) -> Result<(), ()>,
{
    observer(point, observation).map_err(|()| {
        deletion_error(
            code,
            "account-removal transaction was interrupted at a durable boundary",
        )
    })
}

pub(crate) fn registry_generation(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_quarantine_destination(
    paths: &TransactionPaths,
    source: Option<&PathSnapshot>,
) -> Result<(), DeletionError> {
    if fs::symlink_metadata(&paths.quarantine).is_ok()
        || fs::symlink_metadata(&paths.journal).is_ok()
        || fs::symlink_metadata(&paths.proposed_registry).is_ok()
    {
        return Err(deletion_error(
            DeletionErrorCode::QuarantineConflict,
            "account-removal transaction destination already exists",
        ));
    }
    let trash = path_snapshot_no_follow(&paths.trash)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "Studio quarantine identity could not be inspected",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "Studio quarantine was not found after creation",
            )
        })?;
    if trash.reparse_point || !trash.directory || unsafe_hard_link_count(&trash) {
        return Err(deletion_error(
            DeletionErrorCode::UnsafeTarget,
            "Studio quarantine is not a safe directory",
        ));
    }
    if source.is_some_and(|source| source.identity.volume != trash.identity.volume) {
        return Err(deletion_error(
            DeletionErrorCode::UnsafeTarget,
            "Studio quarantine is not on the profile volume",
        ));
    }
    Ok(())
}

fn validated_regular_file_snapshot(
    path: &Path,
    code: DeletionErrorCode,
    message: &str,
) -> Result<PathSnapshot, DeletionError> {
    let snapshot = path_snapshot_no_follow(path)
        .map_err(|_| deletion_error(code.clone(), message))?
        .ok_or_else(|| deletion_error(code.clone(), message))?;
    if snapshot.reparse_point || snapshot.directory || unsafe_hard_link_count(&snapshot) {
        return Err(deletion_error(code, message));
    }
    Ok(snapshot)
}

struct CommittedRegistryGuard {
    file: fs::File,
}

pub(crate) fn read_registry_handle_bounded<R: Read + Seek>(
    reader: &mut R,
    metadata_len: u64,
) -> std::io::Result<Vec<u8>> {
    if metadata_len > MAX_ACCOUNT_REGISTRY_BYTES as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "account registry exceeds the byte limit",
        ));
    }
    reader.seek(SeekFrom::Start(0))?;
    let initial_capacity = usize::try_from(metadata_len)
        .unwrap_or(MAX_ACCOUNT_REGISTRY_BYTES)
        .min(64 * 1024);
    let mut bytes = Vec::with_capacity(initial_capacity);
    reader
        .take(MAX_ACCOUNT_REGISTRY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_ACCOUNT_REGISTRY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "account registry grew beyond the byte limit",
        ));
    }
    Ok(bytes)
}

impl CommittedRegistryGuard {
    fn bind(
        path: &Path,
        expected: &[u8],
        expected_identity: &FileIdentity,
    ) -> Result<Self, DeletionError> {
        let file = open_committed_registry(path).map_err(|_| {
            deletion_error(
                DeletionErrorCode::OutcomeUnknown,
                "committed account registry could not be bound exclusively",
            )
        })?;
        let snapshot = file_snapshot(&file).map_err(|_| {
            deletion_error(
                DeletionErrorCode::OutcomeUnknown,
                "committed account registry could not be inspected",
            )
        })?;
        if snapshot.reparse_point
            || snapshot.directory
            || unsafe_hard_link_count(&snapshot)
            || snapshot.identity != *expected_identity
        {
            return Err(deletion_error(
                DeletionErrorCode::OutcomeUnknown,
                "committed account registry is not the installed proposal object",
            ));
        }
        let mut guard = Self { file };
        guard.verify_exact(expected)?;
        Ok(guard)
    }

    fn verify_exact(&mut self, expected: &[u8]) -> Result<(), DeletionError> {
        let metadata_len = self.file.metadata().map_err(|_| {
            deletion_error(
                DeletionErrorCode::OutcomeUnknown,
                "committed account registry could not be verified",
            )
        })?;
        let bytes =
            read_registry_handle_bounded(&mut self.file, metadata_len.len()).map_err(|_| {
                deletion_error(
                    DeletionErrorCode::OutcomeUnknown,
                    "committed account registry could not be verified",
                )
            })?;
        if bytes != expected {
            return Err(deletion_error(
                DeletionErrorCode::OutcomeUnknown,
                "committed account registry bytes are uncertain; recovery record was retained",
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn open_committed_registry(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;

    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};

    fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_committed_registry(path: &Path) -> std::io::Result<fs::File> {
    fs::File::open(path)
}

fn validate_proposed_registry(
    path: &Path,
    expected_bytes: &[u8],
    expected_generation: &str,
    expected_identity: &FileIdentity,
) -> Result<(), DeletionError> {
    let before = path_snapshot_no_follow(path)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry could not be inspected",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry disappeared before commit",
            )
        })?;
    if before.reparse_point
        || before.directory
        || unsafe_hard_link_count(&before)
        || before.identity != *expected_identity
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry became unsafe before commit",
        ));
    }
    let mut file = fs::File::open(path).map_err(|_| {
        deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry could not be reread before commit",
        )
    })?;
    let opened = file_snapshot(&file).map_err(|_| {
        deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry could not be inspected after opening",
        )
    })?;
    if opened.reparse_point
        || opened.directory
        || unsafe_hard_link_count(&opened)
        || opened.identity != *expected_identity
        || opened.identity != before.identity
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry became unsafe while it was opened",
        ));
    }
    let metadata_len = file.metadata().map_err(|_| {
        deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry could not be inspected before reading",
        )
    })?;
    let actual = read_registry_handle_bounded(&mut file, metadata_len.len()).map_err(|_| {
        deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry could not be reread before commit",
        )
    })?;
    let after = path_snapshot_no_follow(path)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry could not be rechecked",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry disappeared before commit",
            )
        })?;
    if before.identity != after.identity
        || after.identity != *expected_identity
        || before.reparse_point != after.reparse_point
        || actual != expected_bytes
        || registry_generation(&actual) != expected_generation
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry changed before commit",
        ));
    }
    Ok(())
}

fn validate_sealed_proposed_registry(
    proposed: &mut SealedProposedRegistry,
    path: &Path,
    expected_bytes: &[u8],
    expected_generation: &str,
    expected_identity: &FileIdentity,
) -> Result<(), DeletionError> {
    if proposed.identity() != expected_identity {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "sealed proposal identity does not match the recovery journal",
        ));
    }
    let before = path_snapshot_no_follow(path)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry could not be inspected after sealing",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry disappeared after sealing",
            )
        })?;
    if before.reparse_point
        || before.directory
        || unsafe_hard_link_count(&before)
        || before.identity != *expected_identity
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "proposed account registry object changed before commit",
        ));
    }
    let actual = proposed.read_exact_bytes().map_err(|_| {
        deletion_error(
            DeletionErrorCode::TargetChanged,
            "sealed proposed account registry could not be reread",
        )
    })?;
    let after = path_snapshot_no_follow(path)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry could not be rechecked after sealing",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "proposed account registry disappeared after sealing",
            )
        })?;
    if after.identity != *expected_identity
        || after.reparse_point
        || after.directory
        || unsafe_hard_link_count(&after)
        || actual != expected_bytes
        || registry_generation(&actual) != expected_generation
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "sealed proposed account registry changed before commit",
        ));
    }
    Ok(())
}

fn validate_source_before_quarantine(
    source: &Path,
    quarantine: &Path,
    expected: &PathSnapshot,
) -> Result<(), DeletionError> {
    if fs::symlink_metadata(quarantine).is_ok() {
        return Err(deletion_error(
            DeletionErrorCode::QuarantineConflict,
            "quarantine destination appeared before profile movement",
        ));
    }
    if first_reparse_component(source)?.is_some() {
        return Err(deletion_error(
            DeletionErrorCode::UnsafeTarget,
            "deletion target crossed a reparse boundary before movement",
        ));
    }
    let before = path_snapshot_no_follow(source)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "deletion target could not be inspected before movement",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "deletion target disappeared before movement",
            )
        })?;
    if before.reparse_point
        || !before.directory
        || unsafe_hard_link_count(&before)
        || before.identity != expected.identity
    {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "deletion target changed before movement",
        ));
    }
    verify_tree_no_reparse(source)?;
    let after = path_snapshot_no_follow(source)
        .map_err(|_| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "deletion target could not be rechecked before movement",
            )
        })?
        .ok_or_else(|| {
            deletion_error(
                DeletionErrorCode::TargetChanged,
                "deletion target disappeared before movement",
            )
        })?;
    if after.reparse_point || after.identity != expected.identity {
        return Err(deletion_error(
            DeletionErrorCode::TargetChanged,
            "deletion target changed while movement was authorized",
        ));
    }
    Ok(())
}

fn validate_quarantine_before_registry(
    source: &Path,
    quarantine: &Path,
    expected: Option<&PathSnapshot>,
    delete_data: bool,
) -> Result<(), DeletionError> {
    let source_now = path_snapshot_no_follow(source).map_err(|_| {
        deletion_error(
            DeletionErrorCode::OutcomeUnknown,
            "source profile state could not be inspected before registry commit",
        )
    })?;
    let quarantine_now = path_snapshot_no_follow(quarantine).map_err(|_| {
        deletion_error(
            DeletionErrorCode::OutcomeUnknown,
            "quarantine state could not be inspected before registry commit",
        )
    })?;
    match expected {
        Some(expected)
            if source_now.is_none()
                && quarantine_now.as_ref().is_some_and(|snapshot| {
                    !snapshot.reparse_point
                        && snapshot.directory
                        && !unsafe_hard_link_count(snapshot)
                        && snapshot.identity == expected.identity
                }) =>
        {
            Ok(())
        }
        None if !delete_data && quarantine_now.is_none() => Ok(()),
        None if delete_data && source_now.is_none() && quarantine_now.is_none() => Ok(()),
        _ => Err(deletion_error(
            DeletionErrorCode::OutcomeUnknown,
            "profile or quarantine identity changed before registry commit",
        )),
    }
}

#[cfg(windows)]
fn unsafe_hard_link_count(snapshot: &PathSnapshot) -> bool {
    snapshot.hard_links != 1
}

#[cfg(not(windows))]
fn unsafe_hard_link_count(_snapshot: &PathSnapshot) -> bool {
    false
}

fn verify_tree_no_reparse(root: &Path) -> Result<(), DeletionError> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            deletion_error(
                DeletionErrorCode::Io,
                "profile tree could not be inspected safely",
            )
        })?;
        if is_reparse(&metadata) {
            return Err(deletion_error(
                DeletionErrorCode::UnsafeTarget,
                "profile tree contains a reparse point",
            ));
        }
        if metadata.is_dir() {
            let entries = fs::read_dir(&path).map_err(|_| {
                deletion_error(
                    DeletionErrorCode::Io,
                    "profile tree could not be inspected safely",
                )
            })?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|_| {
                            deletion_error(
                                DeletionErrorCode::Io,
                                "profile tree could not be inspected safely",
                            )
                        })?
                        .path(),
                );
            }
        }
    }
    Ok(())
}

fn restore_quarantine<F>(
    source: &Path,
    paths: &TransactionPaths,
    expected: Option<&PathSnapshot>,
    observer: &mut F,
    observation: &TransactionObservation,
) -> Result<(), ()>
where
    F: FnMut(TransactionFaultPoint, &TransactionObservation) -> Result<(), ()>,
{
    let Some(expected) = expected else {
        return Ok(());
    };
    if fs::symlink_metadata(source).is_ok() {
        return Err(());
    }
    let quarantined = path_snapshot_no_follow(&paths.quarantine)
        .map_err(|_| ())?
        .ok_or(())?;
    if quarantined.reparse_point || quarantined.identity != expected.identity {
        return Err(());
    }
    durable_rename(&paths.quarantine, source).map_err(|_| ())?;
    let restored = path_snapshot_no_follow(source).map_err(|_| ())?.ok_or(())?;
    if restored.reparse_point || restored.identity != expected.identity {
        return Err(());
    }
    observe_transition(
        observer,
        TransactionFaultPoint::AfterDurableRestoreRename,
        observation,
        DeletionErrorCode::RecoveryRequired,
    )
    .map_err(|_| ())
}

pub(crate) fn build_cleanup_manifest(
    root: &Path,
    expected: &FileIdentity,
) -> std::io::Result<Vec<CleanupManifestEntry>> {
    let root_snapshot = path_snapshot_no_follow(root)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "quarantined profile was not found",
        )
    })?;
    if root_snapshot.reparse_point
        || !root_snapshot.directory
        || &root_snapshot.identity != expected
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "quarantined profile identity is unsafe",
        ));
    }

    let mut manifest = Vec::new();
    let mut enumerated_entries = 1_usize;
    let mut total_utf16_units = 0_usize;
    let mut pending = vec![(root.to_path_buf(), root_snapshot, false)];
    while let Some((path, enumerated, visited)) = pending.pop() {
        validate_cleanup_entry_identity(&path, &enumerated)?;
        if !enumerated.reparse_point && enumerated.directory {
            if visited {
                push_cleanup_manifest_entry(
                    &mut manifest,
                    &mut total_utf16_units,
                    CleanupManifestEntry {
                        relative_path: cleanup_relative_path(root, &path)?,
                        snapshot: enumerated,
                    },
                )?;
            } else {
                pending.push((path.clone(), enumerated.clone(), true));
                for entry in fs::read_dir(&path)? {
                    if enumerated_entries >= MAX_CLEANUP_MANIFEST_ENTRIES {
                        return Err(invalid_cleanup_data(
                            "cleanup inventory exceeds its entry resource bound",
                        ));
                    }
                    let child = entry?.path();
                    let child_snapshot = path_snapshot_no_follow(&child)?.ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "cleanup entry changed while it was enumerated",
                        )
                    })?;
                    pending.push((child, child_snapshot, false));
                    enumerated_entries += 1;
                }
                validate_cleanup_entry_identity(&path, &enumerated)?;
            }
        } else {
            push_cleanup_manifest_entry(
                &mut manifest,
                &mut total_utf16_units,
                CleanupManifestEntry {
                    relative_path: cleanup_relative_path(root, &path)?,
                    snapshot: enumerated,
                },
            )?;
        }
    }

    validate_cleanup_manifest(root, expected, &manifest)?;
    Ok(manifest)
}

fn push_cleanup_manifest_entry(
    manifest: &mut Vec<CleanupManifestEntry>,
    total_utf16_units: &mut usize,
    entry: CleanupManifestEntry,
) -> std::io::Result<()> {
    if manifest.len() >= MAX_CLEANUP_MANIFEST_ENTRIES
        || entry.relative_path.len() > MAX_CLEANUP_PATH_COMPONENTS
        || entry
            .relative_path
            .iter()
            .any(|component| component.len() > MAX_CLEANUP_COMPONENT_UTF16_UNITS)
    {
        return Err(invalid_cleanup_data(
            "cleanup inventory entry exceeds its resource bound",
        ));
    }
    for component in &entry.relative_path {
        *total_utf16_units = checked_cleanup_utf16_total(*total_utf16_units, component.len())?;
    }
    manifest.push(entry);
    Ok(())
}

pub(crate) fn delete_tree_no_follow(
    root: &Path,
    expected: &FileIdentity,
    manifest: &[CleanupManifestEntry],
    cleanup_progress: u64,
    persist_progress: impl FnMut(u64) -> std::io::Result<()>,
) -> std::io::Result<()> {
    delete_tree_no_follow_observed(
        root,
        expected,
        manifest,
        cleanup_progress,
        persist_progress,
        |_point, _entry, _cleanup_path_opens| Ok(()),
    )
    .map(|_| ())
}

fn delete_tree_no_follow_observed<P, F>(
    root: &Path,
    expected: &FileIdentity,
    manifest: &[CleanupManifestEntry],
    cleanup_progress: u64,
    mut persist_progress: P,
    mut observer: F,
) -> std::io::Result<u64>
where
    P: FnMut(u64) -> std::io::Result<()>,
    F: FnMut(TransactionFaultPoint, &Path, u64) -> std::io::Result<()>,
{
    let mut durable_progress = usize::try_from(cleanup_progress).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup progress exceeds the supported entry count",
        )
    })?;
    if durable_progress > manifest.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup progress exceeds its inventory",
        ));
    }
    let mut ownership = CleanupOwnershipIndex::new(root, expected, manifest, durable_progress)?;
    let path_open_budget = CleanupPathOpenBudget::new(manifest, durable_progress, &ownership)?;

    // Fault injection and any test-controlled namespace mutation happen before
    // the one whole-manifest ownership preflight. No deletion can precede a
    // mismatch introduced at any BeforeCleanupEntry boundary.
    for entry in manifest.iter().skip(durable_progress) {
        let path = cleanup_manifest_path(root, &entry.relative_path)?;
        observer(
            TransactionFaultPoint::BeforeCleanupEntry,
            &path,
            path_open_budget.opened(),
        )?;
    }
    validate_cleanup_ownership_closure(
        root,
        manifest,
        durable_progress,
        &ownership,
        &path_open_budget,
    )?;

    for (index, entry) in manifest.iter().enumerate().skip(durable_progress) {
        let path = cleanup_manifest_path(root, &entry.relative_path)?;
        let file_identity = cleanup_file_identity(entry);
        let mut expected_snapshot = entry.snapshot.clone();
        if let Some(identity) = file_identity {
            expected_snapshot.hard_links = ownership.remaining_links(identity)?;
        }
        durable_remove_cleanup_entry(
            root,
            expected,
            &path,
            &expected_snapshot,
            || path_open_budget.record(),
            || {
                if let Some(identity) = file_identity {
                    observer(
                        TransactionFaultPoint::BeforeCleanupIdentityGroupValidation,
                        &path,
                        path_open_budget.opened(),
                    )?;
                    validate_cleanup_file_identity_group(
                        root,
                        manifest,
                        index,
                        identity,
                        &ownership,
                        &path_open_budget,
                    )?;
                }
                Ok(())
            },
            || {
                if index != durable_progress {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "cleanup progress is not a contiguous inventory prefix",
                    ));
                }
                let next_progress = u64::try_from(index + 1).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "cleanup progress exceeds the supported entry count",
                    )
                })?;
                persist_progress(next_progress)?;
                durable_progress = index + 1;
                Ok(())
            },
        )?;
        if let Some(identity) = file_identity {
            ownership.record_removed_link(identity)?;
        }
        observer(
            TransactionFaultPoint::AfterDurableCleanupEntry,
            &path,
            path_open_budget.opened(),
        )?;
        observer(
            TransactionFaultPoint::AfterCleanupEntry,
            &path,
            path_open_budget.opened(),
        )?;
    }
    validate_cleanup_ownership_closure(
        root,
        manifest,
        durable_progress,
        &ownership,
        &path_open_budget,
    )?;
    Ok(path_open_budget.opened())
}

type CleanupFileIdentity = (u64, u64);

struct CleanupOwnershipIndex {
    remaining_file_links: HashMap<CleanupFileIdentity, u32>,
    file_alias_positions: HashMap<CleanupFileIdentity, Vec<usize>>,
}

impl CleanupOwnershipIndex {
    fn new(
        root: &Path,
        expected: &FileIdentity,
        manifest: &[CleanupManifestEntry],
        durable_progress: usize,
    ) -> std::io::Result<Self> {
        let mut remaining_file_links = validate_cleanup_manifest(root, expected, manifest)?;
        let mut file_alias_positions = HashMap::<CleanupFileIdentity, Vec<usize>>::new();
        for (index, entry) in manifest.iter().enumerate() {
            if let Some(identity) = cleanup_file_identity(entry) {
                file_alias_positions
                    .entry(identity)
                    .or_default()
                    .push(index);
                if index < durable_progress {
                    let remaining = remaining_file_links.get_mut(&identity).ok_or_else(|| {
                        invalid_cleanup_data("cleanup inventory file identity is inconsistent")
                    })?;
                    *remaining = remaining.checked_sub(1).ok_or_else(|| {
                        invalid_cleanup_data(
                            "cleanup inventory exhausted a file identity too early",
                        )
                    })?;
                }
            }
        }
        Ok(Self {
            remaining_file_links,
            file_alias_positions,
        })
    }

    fn remaining_links(&self, identity: CleanupFileIdentity) -> std::io::Result<u32> {
        self.remaining_file_links
            .get(&identity)
            .copied()
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| invalid_cleanup_data("cleanup inventory file identity is inconsistent"))
    }

    fn record_removed_link(&mut self, identity: CleanupFileIdentity) -> std::io::Result<()> {
        let remaining = self
            .remaining_file_links
            .get_mut(&identity)
            .ok_or_else(|| {
                invalid_cleanup_data("cleanup inventory file identity is inconsistent")
            })?;
        *remaining = remaining.checked_sub(1).ok_or_else(|| {
            invalid_cleanup_data("cleanup inventory exhausted a file identity too early")
        })?;
        Ok(())
    }
}

struct CleanupPathOpenBudget {
    opened: Cell<u64>,
    limit: u64,
}

impl CleanupPathOpenBudget {
    fn new(
        manifest: &[CleanupManifestEntry],
        durable_progress: usize,
        ownership: &CleanupOwnershipIndex,
    ) -> std::io::Result<Self> {
        let manifest_count = u64::try_from(manifest.len()).map_err(|_| {
            invalid_cleanup_data("cleanup inventory exceeds the supported entry count")
        })?;
        let remaining_count = u64::try_from(manifest.len() - durable_progress).map_err(|_| {
            invalid_cleanup_data("cleanup inventory exceeds the supported entry count")
        })?;
        let durable_opens = if remaining_count == 0 {
            0
        } else {
            remaining_count
                .checked_mul(2)
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| invalid_cleanup_data("cleanup path-open budget overflowed"))?
        };
        let mut group_peer_opens = 0_u64;
        for positions in ownership.file_alias_positions.values() {
            let remaining = u64::try_from(
                positions
                    .iter()
                    .filter(|position| **position >= durable_progress)
                    .count(),
            )
            .map_err(|_| invalid_cleanup_data("cleanup alias count overflowed"))?;
            group_peer_opens = group_peer_opens
                .checked_add(remaining.saturating_mul(remaining.saturating_add(1)) / 2)
                .ok_or_else(|| invalid_cleanup_data("cleanup path-open budget overflowed"))?;
        }
        let limit = manifest_count
            .checked_mul(2)
            .and_then(|value| value.checked_add(durable_opens))
            .and_then(|value| value.checked_add(group_peer_opens))
            .ok_or_else(|| invalid_cleanup_data("cleanup path-open budget overflowed"))?;
        Ok(Self {
            opened: Cell::new(0),
            limit,
        })
    }

    fn record(&self) -> std::io::Result<()> {
        let opened = self
            .opened
            .get()
            .checked_add(1)
            .ok_or_else(|| invalid_cleanup_data("cleanup path-open count overflowed"))?;
        if opened > self.limit {
            return Err(invalid_cleanup_data(
                "cleanup exceeded its bounded path-open budget",
            ));
        }
        self.opened.set(opened);
        Ok(())
    }

    fn opened(&self) -> u64 {
        self.opened.get()
    }

    #[cfg(test)]
    fn limit(&self) -> u64 {
        self.limit
    }
}

fn validate_cleanup_ownership_closure(
    root: &Path,
    manifest: &[CleanupManifestEntry],
    durable_progress: usize,
    ownership: &CleanupOwnershipIndex,
    path_open_budget: &CleanupPathOpenBudget,
) -> std::io::Result<()> {
    for entry in manifest.iter().take(durable_progress) {
        let path = cleanup_manifest_path(root, &entry.relative_path)?;
        path_open_budget.record()?;
        if path_snapshot_no_follow(&path)?.is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "a completed cleanup pathname was reoccupied",
            ));
        }
    }

    for entry in manifest.iter().skip(durable_progress) {
        let path = cleanup_manifest_path(root, &entry.relative_path)?;
        let mut expected_snapshot = entry.snapshot.clone();
        if let Some(identity) = cleanup_file_identity(entry) {
            expected_snapshot.hard_links = ownership.remaining_links(identity)?;
        }
        path_open_budget.record()?;
        let current = path_snapshot_no_follow(&path)?.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup entry disappeared without durable per-entry progress",
            )
        })?;
        if current != expected_snapshot {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup entry identity changed after its inventory was persisted",
            ));
        }
    }
    Ok(())
}

fn validate_cleanup_file_identity_group(
    root: &Path,
    manifest: &[CleanupManifestEntry],
    current_index: usize,
    identity: CleanupFileIdentity,
    ownership: &CleanupOwnershipIndex,
    path_open_budget: &CleanupPathOpenBudget,
) -> std::io::Result<()> {
    let expected_links = ownership.remaining_links(identity)?;
    let positions = ownership
        .file_alias_positions
        .get(&identity)
        .ok_or_else(|| invalid_cleanup_data("cleanup inventory file identity is inconsistent"))?;
    for position in positions
        .iter()
        .copied()
        .filter(|position| *position >= current_index)
    {
        let entry = &manifest[position];
        let path = cleanup_manifest_path(root, &entry.relative_path)?;
        path_open_budget.record()?;
        let mut expected_snapshot = entry.snapshot.clone();
        expected_snapshot.hard_links = expected_links;
        if path_snapshot_no_follow(&path)?.as_ref() != Some(&expected_snapshot) {
            return Err(invalid_cleanup_data(
                "cleanup hardlink ownership group changed before deletion",
            ));
        }
    }
    Ok(())
}

fn cleanup_file_identity(entry: &CleanupManifestEntry) -> Option<CleanupFileIdentity> {
    (!entry.snapshot.reparse_point && !entry.snapshot.directory)
        .then_some((entry.snapshot.identity.volume, entry.snapshot.identity.file))
}

fn invalid_cleanup_data(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

pub(crate) fn validate_cleanup_manifest(
    root: &Path,
    expected: &FileIdentity,
    manifest: &[CleanupManifestEntry],
) -> std::io::Result<HashMap<(u64, u64), u32>> {
    validate_cleanup_manifest_resources(manifest)?;
    let root_entry = manifest.last().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup inventory omitted its root",
        )
    })?;
    if !root_entry.relative_path.is_empty()
        || root_entry.snapshot.identity != *expected
        || root_entry.snapshot.reparse_point
        || !root_entry.snapshot.directory
        || root_entry.snapshot.hard_links == 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup inventory root is invalid",
        ));
    }

    let mut positions = HashMap::with_capacity(manifest.len());
    for (index, entry) in manifest.iter().enumerate() {
        cleanup_manifest_path(root, &entry.relative_path)?;
        if entry.snapshot.hard_links == 0
            || positions
                .insert(entry.relative_path.clone(), index)
                .is_some()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory contains an invalid or duplicate entry",
            ));
        }
    }

    for (index, entry) in manifest.iter().enumerate().take(manifest.len() - 1) {
        if entry.relative_path.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory contains multiple roots",
            ));
        }
        let mut parent = entry.relative_path.clone();
        parent.pop();
        let parent_index = positions.get(&parent).copied().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory omitted an entry parent",
            )
        })?;
        let parent_entry = &manifest[parent_index];
        if parent_index <= index
            || parent_entry.snapshot.reparse_point
            || !parent_entry.snapshot.directory
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory is not ordered children before directories",
            ));
        }
    }
    let mut file_links = HashMap::<(u64, u64), u32>::new();
    for entry in manifest {
        if !entry.snapshot.reparse_point && !entry.snapshot.directory {
            let identity = (entry.snapshot.identity.volume, entry.snapshot.identity.file);
            let count = file_links.entry(identity).or_default();
            *count = count.checked_add(1).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "cleanup inventory has too many file aliases",
                )
            })?;
            if *count > MAX_CLEANUP_FILE_ALIASES {
                return Err(invalid_cleanup_data(
                    "cleanup inventory file alias group exceeds its resource bound",
                ));
            }
        }
    }
    for entry in manifest {
        if !entry.snapshot.reparse_point && !entry.snapshot.directory {
            let identity = (entry.snapshot.identity.volume, entry.snapshot.identity.file);
            if file_links.get(&identity).copied() != Some(entry.snapshot.hard_links) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "cleanup inventory does not own every hardlink name for a file",
                ));
            }
        }
    }
    Ok(file_links)
}

fn validate_cleanup_manifest_resources(manifest: &[CleanupManifestEntry]) -> std::io::Result<()> {
    if manifest.len() > MAX_CLEANUP_MANIFEST_ENTRIES {
        return Err(invalid_cleanup_data(
            "cleanup inventory exceeds its entry resource bound",
        ));
    }
    let mut total_utf16_units = 0_usize;
    for entry in manifest {
        if entry.relative_path.len() > MAX_CLEANUP_PATH_COMPONENTS {
            return Err(invalid_cleanup_data(
                "cleanup inventory path exceeds its component resource bound",
            ));
        }
        for component in &entry.relative_path {
            if component.len() > MAX_CLEANUP_COMPONENT_UTF16_UNITS {
                return Err(invalid_cleanup_data(
                    "cleanup inventory path component exceeds its resource bound",
                ));
            }
            total_utf16_units = checked_cleanup_utf16_total(total_utf16_units, component.len())?;
        }
    }
    Ok(())
}

fn checked_cleanup_utf16_total(current: usize, added: usize) -> std::io::Result<usize> {
    let total = current
        .checked_add(added)
        .ok_or_else(|| invalid_cleanup_data("cleanup inventory path resource count overflowed"))?;
    if total > MAX_CLEANUP_MANIFEST_UTF16_UNITS {
        return Err(invalid_cleanup_data(
            "cleanup inventory paths exceed their resource bound",
        ));
    }
    Ok(total)
}

#[cfg(windows)]
fn cleanup_relative_path(root: &Path, path: &Path) -> std::io::Result<Vec<Vec<u16>>> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Component;

    path.strip_prefix(root)
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup entry escaped its quarantine root",
            )
        })?
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.encode_wide().collect()),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup entry has an unsafe relative path",
            )),
        })
        .collect()
}

#[cfg(not(windows))]
fn cleanup_relative_path(_root: &Path, _path: &Path) -> std::io::Result<Vec<Vec<u16>>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "cleanup inventory is available only on Windows",
    ))
}

#[cfg(windows)]
fn cleanup_manifest_path(root: &Path, relative: &[Vec<u16>]) -> std::io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Component;

    let mut path = root.to_path_buf();
    for encoded in relative {
        if encoded.is_empty()
            || encoded
                .iter()
                .any(|unit| [0, u16::from(b':'), u16::from(b'/'), u16::from(b'\\')].contains(unit))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory path component is unsafe",
            ));
        }
        let name = OsString::from_wide(encoded);
        let mut components = Path::new(&name).components();
        if !matches!(components.next(), Some(Component::Normal(value)) if value == name.as_os_str())
            || components.next().is_some()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup inventory path component is unsafe",
            ));
        }
        path.push(name);
    }
    Ok(path)
}

#[cfg(not(windows))]
fn cleanup_manifest_path(_root: &Path, _relative: &[Vec<u16>]) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "cleanup inventory is available only on Windows",
    ))
}

fn validate_cleanup_entry_identity(path: &Path, expected: &PathSnapshot) -> std::io::Result<()> {
    let current = path_snapshot_no_follow(path)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup entry disappeared after it was enumerated",
        )
    })?;
    if current.identity != expected.identity
        || current.reparse_point != expected.reparse_point
        || current.directory != expected.directory
        || current.hard_links != expected.hard_links
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup entry identity changed after it was enumerated",
        ));
    }
    Ok(())
}

pub fn derive_deletion_target(
    profiles_dir: &Path,
    account_id: &str,
) -> Result<std::path::PathBuf, DeletionError> {
    if !valid_account_id(account_id) {
        return Err(DeletionError {
            code: DeletionErrorCode::InvalidAccountId,
            message: "account ID is not a safe profile path component".to_owned(),
        });
    }
    if !safe_profiles_root(profiles_dir) {
        return Err(DeletionError {
            code: DeletionErrorCode::UnsafeTarget,
            message: "profiles directory is not a safe local path".to_owned(),
        });
    }
    let target = profiles_dir.join(account_id);
    if target.parent() != Some(profiles_dir) {
        return Err(DeletionError {
            code: DeletionErrorCode::UnsafeTarget,
            message: "derived profile is not a direct child of the profiles directory".to_owned(),
        });
    }
    Ok(target)
}

#[cfg(windows)]
fn safe_profiles_root(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        || !matches!(components.next(), Some(Component::RootDir))
    {
        return false;
    }
    let mut saw_normal = false;
    for component in components {
        match component {
            Component::Normal(value) => {
                if value.to_string_lossy().contains(':') {
                    return false;
                }
                saw_normal = true;
            }
            _ => return false,
        }
    }
    saw_normal
}

#[cfg(not(windows))]
fn safe_profiles_root(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
}

pub(crate) fn valid_account_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let bytes = id.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        return false;
    }
    !matches!(
        id,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

#[cfg(windows)]
fn paths_equal_lexically(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn paths_equal_lexically(left: &Path, right: &Path) -> bool {
    left == right
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileReferenceMatch {
    Equivalent,
    Distinct,
    Untrusted,
}

#[cfg(windows)]
fn profile_reference_match(
    profiles_dir: &Path,
    candidate: &Path,
    target: &Path,
) -> ProfileReferenceMatch {
    let Some(profiles_dir) = normalize_local_windows_path(profiles_dir) else {
        return ProfileReferenceMatch::Untrusted;
    };
    let Some(candidate) = normalize_local_windows_path(candidate) else {
        return ProfileReferenceMatch::Untrusted;
    };
    let Some(target) = normalize_local_windows_path(target) else {
        return ProfileReferenceMatch::Untrusted;
    };

    if windows_paths_equal(&candidate, &target) {
        return ProfileReferenceMatch::Equivalent;
    }
    let Some(candidate_parent) = candidate.parent() else {
        return ProfileReferenceMatch::Distinct;
    };
    if !windows_paths_equal(candidate_parent, &profiles_dir) {
        match (
            safe_existing_identity(candidate_parent),
            safe_existing_identity(&profiles_dir),
        ) {
            (Ok(Some(candidate_parent)), Ok(Some(profiles_dir)))
                if candidate_parent == profiles_dir => {}
            (Ok(Some(_)), Ok(Some(_))) | (Ok(None), _) | (_, Ok(None)) => {
                return ProfileReferenceMatch::Distinct;
            }
            _ => return ProfileReferenceMatch::Untrusted,
        }
    }

    match (
        safe_existing_identity(&candidate),
        safe_existing_identity(&target),
    ) {
        (Ok(Some(candidate)), Ok(Some(target))) if candidate == target => {
            ProfileReferenceMatch::Equivalent
        }
        (Ok(Some(_)), Ok(Some(_))) | (Ok(None), _) | (_, Ok(None)) => {
            ProfileReferenceMatch::Distinct
        }
        _ => ProfileReferenceMatch::Untrusted,
    }
}

#[cfg(windows)]
fn normalize_local_windows_path(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let drive = match components.next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) => drive,
            _ => return None,
        },
        _ => return None,
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return None;
    }
    let mut normal = Vec::new();
    for component in components {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop()?;
            }
            Component::Normal(value) if safe_windows_path_component(value) => {
                normal.push(value.to_os_string());
            }
            _ => return None,
        }
    }
    let mut normalized = PathBuf::from(format!("{}:\\", char::from(drive).to_ascii_uppercase()));
    normalized.extend(normal);
    Some(normalized)
}

#[cfg(windows)]
fn safe_windows_path_component(component: &std::ffi::OsStr) -> bool {
    let value = component.to_string_lossy();
    !value.is_empty()
        && !value.ends_with([' ', '.'])
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

#[cfg(windows)]
fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(windows)]
fn safe_existing_identity(path: &Path) -> Result<Option<FileIdentity>, ()> {
    match path_snapshot_no_follow(path).map_err(|_| ())? {
        Some(snapshot) if snapshot.reparse_point => Err(()),
        Some(snapshot) => Ok(Some(snapshot.identity)),
        None => Ok(None),
    }
}

#[cfg(not(windows))]
fn profile_reference_match(
    _profiles_dir: &Path,
    candidate: &Path,
    target: &Path,
) -> ProfileReferenceMatch {
    if candidate == target {
        ProfileReferenceMatch::Equivalent
    } else {
        ProfileReferenceMatch::Distinct
    }
}

fn remember_claimed(plans: &mut PlanStore, plan_id: &str) {
    if plans.claimed.len() == MAX_PLAN_TOMBSTONES {
        plans.claimed.pop_front();
    }
    plans.claimed.push_back(plan_id.to_owned());
}

fn bounded_estimate(target: &Path) -> Result<(RemovalEstimate, bool), DeletionError> {
    if !target.exists() {
        return Ok((
            RemovalEstimate {
                items: 0,
                bytes: 0,
                truncated: false,
            },
            false,
        ));
    }

    let mut estimate = RemovalEstimate {
        items: 0,
        bytes: 0,
        truncated: false,
    };
    let mut reparse_point = false;
    let mut pending = vec![target.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "profile estimate could not be completed".to_owned(),
        })?;
        estimate.items = estimate.items.saturating_add(1);
        if is_reparse(&metadata) {
            reparse_point = true;
            continue;
        }
        if metadata.is_dir() {
            let entries = fs::read_dir(&path).map_err(|_| DeletionError {
                code: DeletionErrorCode::Io,
                message: "profile estimate could not be completed".to_owned(),
            })?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|_| DeletionError {
                            code: DeletionErrorCode::Io,
                            message: "profile estimate could not be completed".to_owned(),
                        })?
                        .path(),
                );
            }
        } else {
            estimate.bytes = estimate.bytes.saturating_add(metadata.len());
        }
        if estimate.items >= MAX_ESTIMATE_ITEMS || estimate.bytes >= MAX_ESTIMATE_BYTES {
            estimate.items = estimate.items.min(MAX_ESTIMATE_ITEMS);
            estimate.bytes = estimate.bytes.min(MAX_ESTIMATE_BYTES);
            estimate.truncated = true;
            break;
        }
    }
    Ok((estimate, reparse_point))
}

pub(crate) fn first_reparse_component(
    target: &Path,
) -> Result<Option<std::path::PathBuf>, DeletionError> {
    let mut components = target.ancestors().collect::<Vec<_>>();
    components.reverse();
    for path in components {
        if path.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if is_reparse(&metadata) => return Ok(Some(path.to_path_buf())),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(DeletionError {
                    code: DeletionErrorCode::Io,
                    message: "profile path metadata could not be inspected".to_owned(),
                });
            }
        }
    }
    Ok(None)
}

#[cfg(windows)]
pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(unix)]
pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
pub(crate) fn path_snapshot_no_follow(path: &Path) -> std::io::Result<Option<PathSnapshot>> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(handle, &mut information) };
    let information_error = (succeeded == 0).then(std::io::Error::last_os_error);
    unsafe {
        CloseHandle(handle);
    }
    if let Some(error) = information_error {
        Err(error)
    } else {
        Ok(Some(PathSnapshot {
            identity: FileIdentity {
                volume: u64::from(information.dwVolumeSerialNumber),
                file: (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            },
            reparse_point: information.dwFileAttributes
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0,
            directory: information.dwFileAttributes
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY
                != 0,
            hard_links: information.nNumberOfLinks,
        }))
    }
}

#[cfg(unix)]
pub(crate) fn path_snapshot_no_follow(path: &Path) -> std::io::Result<Option<PathSnapshot>> {
    use std::os::unix::fs::MetadataExt;

    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(PathSnapshot {
            identity: FileIdentity {
                volume: metadata.dev(),
                file: metadata.ino(),
            },
            reparse_point: metadata.file_type().is_symlink(),
            directory: metadata.is_dir(),
            hard_links: metadata.nlink().try_into().unwrap_or(u32::MAX),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn path_snapshot_no_follow(path: &Path) -> std::io::Result<Option<PathSnapshot>> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod platform_strategy_tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        current_platform_commit_strategy, platform_removal_blocker, prepared_commit_strategy,
        Account, AccountDeletion, AccountRegistry, DeletionErrorCode, PreparedCommitStrategy,
        RemovalBlocker,
    };

    struct StrategyFixture {
        root: PathBuf,
        profiles: PathBuf,
        registry: Arc<AccountRegistry>,
        removed: Account,
        retained: Account,
        profile_canary: PathBuf,
    }

    impl StrategyFixture {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "prime-studio-platform-strategy-{name}-{}-{nonce}",
                std::process::id()
            ));
            let profiles = root.join(".prime").join("profiles");
            fs::create_dir_all(&profiles).expect("create profiles fixture");
            let registry = Arc::new(AccountRegistry::new(
                profiles.clone(),
                root.join(".prime").join("agent"),
            ));
            let removed = Account {
                id: "portable-entry".to_owned(),
                label: "Portable Entry".to_owned(),
                provider: "anthropic".to_owned(),
                agent_dir: profiles
                    .join("portable-entry")
                    .to_string_lossy()
                    .into_owned(),
                created_at: 1,
            };
            let retained = Account {
                id: "retained-entry".to_owned(),
                label: "Retained Entry".to_owned(),
                provider: "openai-codex".to_owned(),
                agent_dir: profiles
                    .join("retained-entry")
                    .to_string_lossy()
                    .into_owned(),
                created_at: 2,
            };
            let registry_bytes = serde_json::to_vec_pretty(&[removed.clone(), retained.clone()])
                .expect("serialize registry fixture");
            fs::write(registry.registry_path(), registry_bytes).expect("write registry fixture");
            let profile_canary = profiles.join(&removed.id).join("canary.bin");
            fs::create_dir_all(profile_canary.parent().expect("profile parent"))
                .expect("create owned profile");
            fs::write(&profile_canary, b"portable-profile-survives").expect("write profile canary");
            Self {
                root,
                profiles,
                registry,
                removed,
                retained,
                profile_canary,
            }
        }

        fn deletion(&self) -> AccountDeletion {
            AccountDeletion::with_ttl(self.registry.clone(), 60_000)
        }

        fn namespace(&self) -> Vec<String> {
            let mut names = fs::read_dir(&self.profiles)
                .expect("list profiles")
                .map(|entry| {
                    entry
                        .expect("read profiles entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<_>>();
            names.sort();
            names
        }
    }

    impl Drop for StrategyFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn strategy_matrix_preserves_windows_transactions_and_portable_entry_only_commits() {
        assert_eq!(
            prepared_commit_strategy(true, false),
            PreparedCommitStrategy::WindowsTransaction
        );
        assert_eq!(
            prepared_commit_strategy(true, true),
            PreparedCommitStrategy::WindowsTransaction
        );
        assert_eq!(
            prepared_commit_strategy(false, false),
            PreparedCommitStrategy::PortableEntryOnly
        );
        assert_eq!(
            prepared_commit_strategy(false, true),
            PreparedCommitStrategy::UnsupportedProfileData
        );
        assert_eq!(
            platform_removal_blocker(PreparedCommitStrategy::UnsupportedProfileData),
            Some(RemovalBlocker::UnsupportedPlatform)
        );
        assert_eq!(
            platform_removal_blocker(PreparedCommitStrategy::PortableEntryOnly),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn compiled_windows_strategy_keeps_both_modes_on_the_approved_transaction() {
        assert_eq!(
            current_platform_commit_strategy(false),
            PreparedCommitStrategy::WindowsTransaction
        );
        assert_eq!(
            current_platform_commit_strategy(true),
            PreparedCommitStrategy::WindowsTransaction
        );
    }

    #[test]
    fn simulated_non_windows_entry_only_commit_uses_atomic_registry_path_without_transaction() {
        let fixture = StrategyFixture::new("portable-entry");
        let deletion = fixture.deletion();
        let plan = deletion
            .prepare_remove_account_at(&fixture.removed.id, false, &HashSet::new(), 1_000)
            .expect("prepare entry-only plan");
        let mut observed = 0;

        deletion
            .commit_remove_account_at_with_observer_for_platform(
                &plan.plan_id,
                "",
                &HashSet::new(),
                2_000,
                false,
                |_point, _observation| {
                    observed += 1;
                    Err(())
                },
            )
            .expect("portable entry-only commit");

        assert_eq!(
            observed, 0,
            "portable path must not enter the Windows journal"
        );
        assert_eq!(
            fixture.registry.list().expect("read committed registry"),
            vec![fixture.retained.clone()]
        );
        assert_eq!(
            fs::read(&fixture.profile_canary).expect("read retained profile canary"),
            b"portable-profile-survives"
        );
        assert_eq!(
            fixture.namespace(),
            vec!["accounts.json".to_owned(), "portable-entry".to_owned()]
        );
    }

    #[test]
    fn simulated_non_windows_profile_data_commit_fails_before_any_transaction_or_mutation() {
        let fixture = StrategyFixture::new("unsupported-data");
        let deletion = fixture.deletion();
        let plan = deletion
            .prepare_remove_account_at(&fixture.removed.id, true, &HashSet::new(), 1_000)
            .expect("prepare profile-data plan on the Windows test host");
        let registry_before = fs::read(fixture.registry.registry_path()).expect("read registry");
        let mut observed = 0;

        let error = deletion
            .commit_remove_account_at_with_observer_for_platform(
                &plan.plan_id,
                &fixture.removed.label,
                &HashSet::new(),
                2_000,
                false,
                |_point, _observation| {
                    observed += 1;
                    Err(())
                },
            )
            .expect_err("non-Windows profile-data removal must fail closed");

        assert_eq!(error.code, DeletionErrorCode::PlanBlocked);
        assert_eq!(
            observed, 0,
            "unsupported data removal must not start a journal"
        );
        assert_eq!(
            fs::read(fixture.registry.registry_path()).expect("read unchanged registry"),
            registry_before
        );
        assert_eq!(
            fs::read(&fixture.profile_canary).expect("read unchanged profile canary"),
            b"portable-profile-survives"
        );
        assert_eq!(
            fixture.namespace(),
            vec!["accounts.json".to_owned(), "portable-entry".to_owned()]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn compiled_non_windows_strategy_is_portable_only_for_entry_removal() {
        assert_eq!(
            current_platform_commit_strategy(false),
            PreparedCommitStrategy::PortableEntryOnly
        );
        assert_eq!(
            current_platform_commit_strategy(true),
            PreparedCommitStrategy::UnsupportedProfileData
        );
    }
}

#[cfg(all(test, windows))]
mod cleanup_resource_tests {
    use std::path::Path;

    use super::{
        checked_cleanup_utf16_total, validate_cleanup_manifest_resources, CleanupManifestEntry,
        CleanupOwnershipIndex, CleanupPathOpenBudget, FileIdentity, PathSnapshot,
        MAX_CLEANUP_COMPONENT_UTF16_UNITS, MAX_CLEANUP_MANIFEST_ENTRIES,
        MAX_CLEANUP_MANIFEST_UTF16_UNITS, MAX_CLEANUP_PATH_COMPONENTS,
    };

    fn snapshot(file: u64, directory: bool) -> PathSnapshot {
        PathSnapshot {
            identity: FileIdentity { volume: 1, file },
            reparse_point: false,
            directory,
            hard_links: 1,
        }
    }

    #[test]
    fn ten_thousand_unique_entries_have_a_deterministic_linear_path_open_bound() {
        const FILE_COUNT: usize = 10_000;
        let expected_root = FileIdentity {
            volume: 1,
            file: u64::MAX,
        };
        let mut manifest = Vec::with_capacity(FILE_COUNT + 1);
        for index in 0..FILE_COUNT {
            manifest.push(CleanupManifestEntry {
                relative_path: vec![format!("entry-{index:05}").encode_utf16().collect()],
                snapshot: snapshot(index as u64 + 1, false),
            });
        }
        manifest.push(CleanupManifestEntry {
            relative_path: Vec::new(),
            snapshot: PathSnapshot {
                identity: expected_root.clone(),
                reparse_point: false,
                directory: true,
                hard_links: 1,
            },
        });

        let ownership = CleanupOwnershipIndex::new(
            Path::new(r"C:\synthetic-quarantine"),
            &expected_root,
            &manifest,
            0,
        )
        .expect("index a 10k synthetic cleanup manifest");
        let budget = CleanupPathOpenBudget::new(&manifest, 0, &ownership)
            .expect("derive runtime path-open budget");

        assert_eq!(budget.limit(), 50_003);
        assert!(budget.limit() <= 5 * manifest.len() as u64);
    }

    #[test]
    fn manifest_entry_and_path_resource_bounds_are_inclusive() {
        let empty_entry = CleanupManifestEntry {
            relative_path: Vec::new(),
            snapshot: snapshot(1, true),
        };
        assert!(validate_cleanup_manifest_resources(&vec![
            empty_entry.clone();
            MAX_CLEANUP_MANIFEST_ENTRIES
        ])
        .is_ok());
        assert!(validate_cleanup_manifest_resources(&vec![
            empty_entry;
            MAX_CLEANUP_MANIFEST_ENTRIES + 1
        ])
        .is_err());

        let at_component_count = CleanupManifestEntry {
            relative_path: vec![vec![u16::from(b'a')]; MAX_CLEANUP_PATH_COMPONENTS],
            snapshot: snapshot(2, false),
        };
        assert!(
            validate_cleanup_manifest_resources(std::slice::from_ref(&at_component_count)).is_ok()
        );
        let mut over_component_count = at_component_count;
        over_component_count
            .relative_path
            .push(vec![u16::from(b'b')]);
        assert!(
            validate_cleanup_manifest_resources(std::slice::from_ref(&over_component_count))
                .is_err()
        );

        let at_component_units = CleanupManifestEntry {
            relative_path: vec![vec![u16::from(b'a'); MAX_CLEANUP_COMPONENT_UTF16_UNITS]],
            snapshot: snapshot(3, false),
        };
        assert!(
            validate_cleanup_manifest_resources(std::slice::from_ref(&at_component_units)).is_ok()
        );
        let mut over_component_units = at_component_units;
        over_component_units.relative_path[0].push(u16::from(b'b'));
        assert!(
            validate_cleanup_manifest_resources(std::slice::from_ref(&over_component_units))
                .is_err()
        );

        assert_eq!(
            checked_cleanup_utf16_total(MAX_CLEANUP_MANIFEST_UTF16_UNITS, 0)
                .expect("the exact aggregate UTF-16 resource bound is accepted"),
            MAX_CLEANUP_MANIFEST_UTF16_UNITS
        );
        assert!(checked_cleanup_utf16_total(MAX_CLEANUP_MANIFEST_UTF16_UNITS, 1).is_err());
    }
}

#[cfg(test)]
mod registry_read_bound_tests {
    use std::cell::Cell;
    use std::io::{Cursor, Read, Seek, SeekFrom};

    use super::read_registry_handle_bounded;
    use crate::accounts::MAX_ACCOUNT_REGISTRY_BYTES;

    struct ObservedReader {
        bytes: Cursor<Vec<u8>>,
        bytes_read: Cell<usize>,
    }

    impl ObservedReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes: Cursor::new(bytes),
                bytes_read: Cell::new(0),
            }
        }
    }

    impl Read for ObservedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.bytes.read(buffer)?;
            self.bytes_read.set(self.bytes_read.get() + read);
            Ok(read)
        }
    }

    impl Seek for ObservedReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.bytes.seek(position)
        }
    }

    #[test]
    fn registry_handle_reader_accepts_the_exact_four_mib_boundary() {
        let mut reader = ObservedReader::new(vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES]);

        let actual = read_registry_handle_bounded(
            &mut reader,
            u64::try_from(MAX_ACCOUNT_REGISTRY_BYTES).expect("registry cap fits u64"),
        )
        .expect("the exact registry byte ceiling is valid");

        assert_eq!(actual.len(), MAX_ACCOUNT_REGISTRY_BYTES);
        assert_eq!(reader.bytes_read.get(), MAX_ACCOUNT_REGISTRY_BYTES);
    }

    #[test]
    fn registry_handle_reader_rejects_oversized_metadata_before_reading_or_allocating() {
        let mut reader = ObservedReader::new(vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES + 1]);

        let error = read_registry_handle_bounded(
            &mut reader,
            u64::try_from(MAX_ACCOUNT_REGISTRY_BYTES + 1).expect("registry cap + 1 fits u64"),
        )
        .expect_err("oversized metadata must fail before the handle is read");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(reader.bytes_read.get(), 0);
    }

    #[test]
    fn registry_handle_reader_stops_at_cap_plus_one_when_metadata_lies() {
        let mut reader = ObservedReader::new(vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES + 64]);

        let error = read_registry_handle_bounded(&mut reader, 0)
            .expect_err("growth beyond inspected metadata must fail at the streaming sentinel");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(reader.bytes_read.get(), MAX_ACCOUNT_REGISTRY_BYTES + 1);
    }
}
