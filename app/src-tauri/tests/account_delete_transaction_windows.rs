#![cfg(windows)]

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use prime_studio_lib::accounts::delete::{
    AccountDeletion, DeletionErrorCode, FileIdentity, TransactionFaultPoint,
};
use prime_studio_lib::accounts::{Account, AccountRegistry};

const MAX_ACCOUNT_REGISTRY_BYTES: usize = 4 * 1024 * 1024;

struct Fixture {
    root: PathBuf,
    profiles: PathBuf,
    registry: Arc<AccountRegistry>,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "prime-studio-account-transaction-{name}-{}-{nonce}",
            std::process::id()
        ));
        let profiles = root.join(".prime").join("profiles");
        fs::create_dir_all(&profiles).expect("create disposable profiles fixture");
        let registry = Arc::new(AccountRegistry::new(
            profiles.clone(),
            root.join(".prime").join("agent"),
        ));
        Self {
            root,
            profiles,
            registry,
        }
    }

    fn account(&self, id: &str, label: &str) -> Account {
        Account {
            id: id.to_owned(),
            label: label.to_owned(),
            provider: "anthropic".to_owned(),
            agent_dir: self.profiles.join(id).to_string_lossy().into_owned(),
            created_at: 1,
        }
    }

    fn write_accounts(&self, accounts: &[Account]) {
        let bytes = serde_json::to_vec_pretty(accounts).expect("serialize fixture registry");
        fs::write(self.registry.registry_path(), bytes).expect("write fixture registry");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn bytes(path: &Path) -> Vec<u8> {
    fs::read(path).expect("read fixture bytes")
}

fn file_identity(path: &Path) -> FileIdentity {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_READ_ATTRIBUTES,
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
            0,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE, "open fixture identity handle");
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let inspected = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe {
        CloseHandle(handle);
    }
    assert_ne!(inspected, 0, "inspect fixture identity");
    FileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    }
}

fn journal_proposal_identity(path: &Path) -> FileIdentity {
    let journal: serde_json::Value =
        serde_json::from_slice(&bytes(path)).expect("parse fixture transaction journal");
    let identity = journal
        .get("proposalIdentity")
        .expect("journal records proposal identity");
    FileIdentity {
        volume: identity
            .get("volume")
            .and_then(serde_json::Value::as_u64)
            .expect("journal proposal volume"),
        file: identity
            .get("file")
            .and_then(serde_json::Value::as_u64)
            .expect("journal proposal file"),
    }
}

fn journal_cleanup_progress(path: &Path) -> u64 {
    let journal: serde_json::Value =
        serde_json::from_slice(&bytes(path)).expect("parse fixture transaction journal");
    journal
        .get("cleanupProgress")
        .and_then(serde_json::Value::as_u64)
        .expect("journal records monotonic cleanup progress")
}

fn read_journal(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&bytes(path)).expect("parse fixture transaction journal")
}

fn write_journal(path: &Path, journal: &serde_json::Value) {
    fs::write(
        path,
        serde_json::to_vec_pretty(journal).expect("serialize fixture transaction journal"),
    )
    .expect("write fixture transaction journal");
}

fn pad_journal_with_spaces(path: &Path, encoded_len: usize) {
    let current_len = fs::metadata(path).expect("inspect fixture journal").len() as usize;
    assert!(
        current_len <= encoded_len,
        "fixture journal exceeds target length"
    );
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open fixture journal for padding");
    let chunk = vec![b' '; 1024 * 1024];
    let mut remaining = encoded_len - current_len;
    while remaining > 0 {
        let count = remaining.min(chunk.len());
        file.write_all(&chunk[..count])
            .expect("pad fixture transaction journal");
        remaining -= count;
    }
    file.sync_all().expect("flush padded fixture journal");
    assert_eq!(
        fs::metadata(path).expect("reinspect fixture journal").len() as usize,
        encoded_len
    );
}

fn retain_committed_transaction(
    fixture: &Fixture,
    account_id: &str,
) -> (AccountDeletion, PathBuf, PathBuf) {
    let account = fixture.account(account_id, "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("profile-canary"), b"recovery-bound-canary")
        .expect("write recovery bound canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare bounded startup recovery");
    let mut quarantine = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::AfterCommittedJournalFlushed {
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                return Err(());
            }
            Ok(())
        },
    );
    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));

    (
        deletion,
        quarantine.expect("capture retained quarantine"),
        journal.expect("capture retained journal"),
    )
}

fn cleanup_manifest_entry_name(entry: &serde_json::Value) -> String {
    let component = entry
        .get("relativePath")
        .and_then(serde_json::Value::as_array)
        .and_then(|relative| relative.last())
        .and_then(serde_json::Value::as_array)
        .expect("manifest child has a final UTF-16 path component");
    let encoded = component
        .iter()
        .map(|unit| {
            unit.as_u64()
                .and_then(|unit| u16::try_from(unit).ok())
                .expect("manifest path component contains UTF-16 code units")
        })
        .collect::<Vec<_>>();
    String::from_utf16(&encoded).expect("manifest path component is valid UTF-16")
}

fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link).expect("create directory reparse fixture");
}

fn transaction_artifacts(profiles: &Path) -> Vec<PathBuf> {
    let mut artifacts = Vec::new();
    let Ok(entries) = fs::read_dir(profiles) else {
        return artifacts;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".accounts.transaction.") || name == ".trash" {
            artifacts.push(entry.path());
        }
    }
    artifacts
}

fn artifact_bytes(profiles: &Path) -> Vec<Vec<u8>> {
    let mut found = Vec::new();
    let mut pending = Vec::new();
    for artifact in transaction_artifacts(profiles) {
        if artifact.file_name().is_some_and(|name| name == ".trash") {
            let journals = artifact.join(".transactions");
            if journals.exists() {
                pending.push(journals);
            }
        } else {
            pending.push(artifact);
        }
    }
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).expect("inspect transaction artifact");
        if metadata.is_dir() {
            for entry in fs::read_dir(path).expect("read transaction artifact directory") {
                pending.push(entry.expect("read transaction artifact entry").path());
            }
        } else {
            found.push(bytes(&path));
        }
    }
    found
}

fn assert_recovery_rejects_invalid_registry(
    case: &str,
    invalid_registry: impl Fn(&Account, &Account) -> Vec<u8>,
) {
    let fixture = Fixture::new(case);
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained.clone()]);
    let source = fixture.profiles.join(&removed.id);
    fs::create_dir_all(&source).expect("create source profile");
    let canary = source.join("canary.txt");
    fs::write(&canary, b"profile-canary").expect("write profile canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare valid recovery plan");
    let mut journal_path = None;
    let interrupted = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterJournalPrepared {
                    journal_path = Some(observation.journal.clone());
                    Err(())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("fault injection must retain a recovery journal");
    assert_eq!(interrupted.code, DeletionErrorCode::RecoveryRequired);
    let journal_path = journal_path.expect("capture recovery journal path");

    let invalid_registry = invalid_registry(&removed, &retained);
    fs::write(fixture.registry.registry_path(), &invalid_registry).expect("write hostile registry");
    let journal_before = bytes(&journal_path);
    let canary_before = bytes(&canary);

    let recovery = deletion
        .recover_pending_transactions()
        .expect_err("recovery must reject a registry the normal parser rejects");

    assert_eq!(recovery.code, DeletionErrorCode::RecoveryRequired);
    assert_eq!(bytes(&fixture.registry.registry_path()), invalid_registry);
    assert_eq!(bytes(&journal_path), journal_before);
    assert_eq!(bytes(&canary), canary_before);
    assert!(source.is_dir());
}

#[test]
fn recovery_rejects_duplicate_account_ids_without_mutation() {
    assert_recovery_rejects_invalid_registry("recovery-duplicate-registry", |removed, retained| {
        serde_json::to_vec_pretty(&[removed, retained, removed])
            .expect("serialize duplicate registry")
    });
}

#[test]
fn recovery_rejects_malformed_registry_json_without_mutation() {
    assert_recovery_rejects_invalid_registry("recovery-malformed-registry", |_, _| b"{".to_vec());
}

#[test]
fn recovery_rejects_a_registry_over_the_byte_ceiling_without_mutation() {
    assert_recovery_rejects_invalid_registry("recovery-oversized-registry", |removed, retained| {
        let mut registry =
            serde_json::to_vec_pretty(&[removed, retained]).expect("serialize recovery registry");
        registry.resize(MAX_ACCOUNT_REGISTRY_BYTES + 1, b' ');
        registry
    });
}

#[test]
fn successful_commit_quarantines_profile_replaces_registry_and_cleans_journal() {
    let fixture = Fixture::new("commit-success");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained.clone()]);
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir_all(target.join("sessions")).expect("create disposable profile");
    fs::write(target.join("auth.json"), b"DISPOSABLE-CREDENTIAL-CANARY")
        .expect("write disposable credential canary");
    fs::write(target.join("sessions").join("one.jsonl"), b"session")
        .expect("write disposable session");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-byte-canary").expect("write outside canary");
    let mut permissions = fs::metadata(&outside)
        .expect("outside metadata")
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&outside, permissions).expect("set access-control marker");
    let outside_before = bytes(&outside);
    let outside_readonly_before = fs::metadata(&outside)
        .expect("outside metadata before")
        .permissions()
        .readonly();
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare owned profile deletion");

    deletion
        .commit_remove_account_at(&plan.plan_id, &removed.label, &HashSet::new(), 2_000)
        .expect("commit prepared deletion");

    assert_eq!(
        fixture.registry.list().expect("read committed registry"),
        vec![retained]
    );
    assert!(
        !target.exists(),
        "committed profile is no longer at its source"
    );
    assert_eq!(bytes(&outside), outside_before);
    assert_eq!(
        fs::metadata(&outside)
            .expect("outside metadata after")
            .permissions()
            .readonly(),
        outside_readonly_before,
        "outside access-control marker is unchanged"
    );
    let artifacts = transaction_artifacts(&fixture.profiles);
    assert!(
        artifacts.iter().all(|path| {
            path.file_name().is_some_and(|name| name == ".trash")
                && fs::read_dir(path)
                    .expect("inspect Studio trash")
                    .next()
                    .is_none()
        }),
        "a successful commit leaves no journal, proposal, or quarantine: {artifacts:?}"
    );
    let replay = deletion
        .commit_remove_account_at(&plan.plan_id, &removed.label, &HashSet::new(), 2_001)
        .expect_err("a committed plan is single-use");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn faults_at_every_durable_transition_recover_by_registry_truth_idempotently() {
    let cases = [
        (TransactionFaultPoint::AfterJournalPrepared, false),
        (
            TransactionFaultPoint::AfterProposalAllocatedBeforeOwnershipJournal,
            false,
        ),
        (TransactionFaultPoint::AfterDurableProposalCreated, false),
        (TransactionFaultPoint::AfterProposedRegistryFlushed, false),
        (TransactionFaultPoint::AfterQuarantineRenamed, false),
        (TransactionFaultPoint::AfterRegistryReplaced, true),
        (TransactionFaultPoint::AfterCommittedJournalFlushed, true),
        (TransactionFaultPoint::BeforeCleanupEntry, true),
        (TransactionFaultPoint::AfterCleanupEntry, true),
        (TransactionFaultPoint::AfterCleanupComplete, true),
    ];

    for (fault, registry_committed) in cases {
        let fixture = Fixture::new(&format!("fault-{fault:?}"));
        let removed = fixture.account("claude-work", "Claude Work");
        let retained = fixture.account("claude-home", "Claude Home");
        fixture.write_accounts(&[removed.clone(), retained.clone()]);
        let original_registry = bytes(&fixture.registry.registry_path());
        let proposed_registry =
            serde_json::to_vec_pretty(std::slice::from_ref(&retained)).expect("proposed bytes");
        let target = fixture.profiles.join(&removed.id);
        fs::create_dir_all(target.join("sessions").join("nested"))
            .expect("create disposable profile tree");
        let secret = b"DISPOSABLE-FAULT-CREDENTIAL-CANARY";
        fs::write(target.join("auth.json"), secret).expect("write credential canary");
        fs::write(
            target.join("sessions").join("nested").join("one.jsonl"),
            b"disposable-session",
        )
        .expect("write nested profile fixture");
        let outside = fixture.root.join("outside-canary.txt");
        fs::write(&outside, b"outside-fault-canary").expect("write outside canary");
        let outside_before = bytes(&outside);
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
            .expect("prepare faulted transaction");
        let mut injected = false;
        let mut allocation_prefix = None;
        let mut durable_proposal_prefix = None;

        let error = deletion
            .commit_remove_account_at_with_observer(
                &plan.plan_id,
                &removed.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if point == fault && !injected {
                        if fault
                            == TransactionFaultPoint::AfterProposalAllocatedBeforeOwnershipJournal
                        {
                            allocation_prefix = Some((
                                observation.proposed_registry.clone(),
                                observation.journal.clone(),
                            ));
                        } else if fault == TransactionFaultPoint::AfterDurableProposalCreated {
                            durable_proposal_prefix = Some((
                                observation.proposed_registry.clone(),
                                observation.journal.clone(),
                            ));
                        }
                        injected = true;
                        Err(())
                    } else {
                        Ok(())
                    }
                },
            )
            .expect_err("fault injection must interrupt the transaction");

        assert!(injected, "fault point {fault:?} was not observed");
        let unowned_proposal = allocation_prefix.map(|(proposal, journal)| {
            let journal_value: serde_json::Value =
                serde_json::from_slice(&bytes(&journal)).expect("parse allocation-prefix journal");
            assert_eq!(
                journal_value
                    .get("phase")
                    .and_then(serde_json::Value::as_str),
                Some("journal_prepared"),
                "the crash seam precedes the identity-bearing journal update"
            );
            assert!(
                journal_value
                    .get("proposalIdentity")
                    .is_some_and(serde_json::Value::is_null),
                "the crash seam leaves no durable proposal ownership"
            );

            let parked = fixture.profiles.join("adversary-parked-proposal-canary");
            if proposal.exists() {
                fs::rename(&proposal, &parked)
                    .expect("park a proposal that incorrectly survived handle close");
            }
            fs::hard_link(&outside, &proposal)
                .expect("install an unowned outside-canary proposal substitute");
            (proposal, parked, file_identity(&outside))
        });
        if let Some((proposal, journal)) = durable_proposal_prefix {
            assert_eq!(
                bytes(&proposal),
                proposed_registry,
                "the injected prefix retains the fully flushed proposal"
            );
            assert_eq!(
                file_identity(&proposal),
                journal_proposal_identity(&journal),
                "the pre-movement journal owns the exact durable proposal object"
            );
            let journal: serde_json::Value =
                serde_json::from_slice(&bytes(&journal)).expect("parse durable-prefix journal");
            assert_eq!(
                journal.get("phase").and_then(serde_json::Value::as_str),
                Some("proposal_identity_recorded"),
                "ownership is durable before proposal contents become durable"
            );
        }
        assert!(
            matches!(
                error.code,
                DeletionErrorCode::RecoveryRequired | DeletionErrorCode::CleanupPending
            ),
            "fault {fault:?} returned unexpected code {:?}",
            error.code
        );
        assert_eq!(bytes(&outside), outside_before, "fault {fault:?}");
        let diagnostics = format!("{error:?}");
        assert!(!diagnostics
            .as_bytes()
            .windows(secret.len())
            .any(|window| window == secret));
        for artifact in artifact_bytes(&fixture.profiles) {
            assert!(
                !artifact
                    .windows(secret.len())
                    .any(|window| window == secret),
                "journal/proposal leaked credential contents at {fault:?}"
            );
        }

        let recovered = deletion
            .recover_pending_transactions()
            .expect("startup recovery resolves a valid interrupted transaction");
        assert_eq!(recovered.pending, 0, "fault {fault:?}");
        assert_eq!(bytes(&outside), outside_before, "fault {fault:?}");
        if registry_committed {
            assert_eq!(
                bytes(&fixture.registry.registry_path()),
                proposed_registry,
                "fault {fault:?}"
            );
            assert!(!target.exists(), "fault {fault:?}");
            assert_eq!(recovered.finalized, 1, "fault {fault:?}");
        } else {
            assert_eq!(
                bytes(&fixture.registry.registry_path()),
                original_registry,
                "fault {fault:?}"
            );
            assert!(target.is_dir(), "fault {fault:?}");
            assert_eq!(bytes(&target.join("auth.json")), secret, "fault {fault:?}");
            assert_eq!(recovered.restored, 1, "fault {fault:?}");
        }
        if let Some((proposal, parked, outside_identity)) = unowned_proposal.as_ref() {
            assert!(
                !parked.exists(),
                "an automatically disposable pre-ownership proposal cannot survive termination"
            );
            assert_eq!(
                file_identity(proposal),
                *outside_identity,
                "recovery must not replace or unlink the unowned pathname substitute"
            );
            assert_eq!(bytes(proposal), outside_before);
            assert_eq!(bytes(&outside), outside_before);
            assert_eq!(
                transaction_artifacts(&fixture.profiles),
                vec![proposal.clone()],
                "only the unowned substitute remains after journal recovery"
            );
        } else {
            assert!(
                artifact_bytes(&fixture.profiles).is_empty(),
                "fault {fault:?}"
            );
        }

        let second = deletion
            .recover_pending_transactions()
            .expect("recovery is idempotent");
        assert_eq!(
            (second.restored, second.finalized, second.pending),
            (0, 0, 0)
        );
        if let Some((proposal, _, outside_identity)) = unowned_proposal {
            assert_eq!(file_identity(&proposal), outside_identity);
            assert_eq!(bytes(&proposal), outside_before);
            assert_eq!(bytes(&outside), outside_before);
        }
    }
}

#[test]
fn durable_namespace_crash_prefixes_restart_to_exact_state() {
    for case in ["quarantine-rename", "restore-rename", "journal-delete"] {
        let fixture = Fixture::new(&format!("durable-prefix-{case}"));
        let removed = fixture.account("claude-work", "Claude Work");
        let retained = fixture.account("claude-home", "Claude Home");
        fixture.write_accounts(&[removed.clone(), retained.clone()]);
        let original_registry = bytes(&fixture.registry.registry_path());
        let proposed_registry = serde_json::to_vec_pretty(std::slice::from_ref(&retained))
            .expect("serialize expected proposal");
        let target = fixture.profiles.join(&removed.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("profile-canary"), b"durable-prefix-profile")
            .expect("write profile canary");
        let outside = fixture.root.join("outside-canary");
        fs::write(&outside, b"outside-durable-prefix").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
            .expect("prepare durable-prefix transaction");
        let mut injected = false;

        let error = deletion
            .commit_remove_account_at_with_observer(
                &plan.plan_id,
                &removed.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if case == "restore-rename"
                        && point == TransactionFaultPoint::BeforeRegistryReplace
                    {
                        fs::write(&observation.proposed_registry, b"INVALID-RESTORE-TRIGGER")
                            .expect("invalidate proposal to trigger restoration");
                    }
                    let crash = match case {
                        "quarantine-rename" => {
                            point == TransactionFaultPoint::AfterDurableQuarantineRename
                        }
                        "restore-rename" => {
                            point == TransactionFaultPoint::AfterDurableRestoreRename
                        }
                        "journal-delete" => {
                            point == TransactionFaultPoint::AfterDurableJournalDelete
                        }
                        _ => unreachable!(),
                    };
                    if crash && !injected {
                        injected = true;
                        Err(())
                    } else {
                        Ok(())
                    }
                },
            )
            .expect_err("crash-prefix injection interrupts the transaction");

        assert!(injected, "durability point was not observed for {case}");
        assert!(
            matches!(
                error.code,
                DeletionErrorCode::RecoveryRequired
                    | DeletionErrorCode::OutcomeUnknown
                    | DeletionErrorCode::CleanupPending
            ),
            "unexpected error for {case}: {:?}",
            error.code
        );
        assert_eq!(bytes(&outside), b"outside-durable-prefix", "case {case}");

        let recovered = deletion
            .recover_pending_transactions()
            .expect("every documented durable prefix has deterministic recovery");
        if case == "journal-delete" {
            assert_eq!(
                bytes(&fixture.registry.registry_path()),
                proposed_registry,
                "case {case}"
            );
            assert!(!target.exists(), "case {case}");
            assert_eq!(
                (recovered.restored, recovered.finalized, recovered.pending),
                (0, 0, 0),
                "the removed journal means the committed transaction was already finalized"
            );
        } else {
            assert_eq!(
                bytes(&fixture.registry.registry_path()),
                original_registry,
                "case {case}"
            );
            assert_eq!(
                bytes(&target.join("profile-canary")),
                b"durable-prefix-profile",
                "case {case}"
            );
            assert_eq!(recovered.restored, 1, "case {case}");
        }
        assert!(artifact_bytes(&fixture.profiles).is_empty(), "case {case}");
        let second = deletion
            .recover_pending_transactions()
            .expect("durable-prefix recovery is idempotent");
        assert_eq!(
            (second.restored, second.finalized, second.pending),
            (0, 0, 0),
            "case {case}"
        );
    }
}

#[test]
fn every_durable_cleanup_deletion_prefix_restarts_to_committed_state() {
    const CLEANUP_ENTRIES: usize = 7;

    for crash_after in 0..CLEANUP_ENTRIES {
        let fixture = Fixture::new(&format!("durable-cleanup-prefix-{crash_after}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir_all(target.join("sessions").join("nested"))
            .expect("create disposable cleanup tree");
        fs::write(target.join("auth.json"), b"cleanup-auth").expect("write auth fixture");
        fs::write(target.join("sessions").join("one.jsonl"), b"one")
            .expect("write session fixture");
        fs::write(
            target.join("sessions").join("nested").join("two.jsonl"),
            b"two",
        )
        .expect("write nested session fixture");
        let outside = fixture.root.join("outside-reparse-target");
        fs::create_dir(&outside).expect("create outside directory");
        let outside_canary = outside.join("outside-canary");
        fs::write(&outside_canary, b"outside-cleanup-prefix").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare cleanup-prefix transaction");
        let mut late_reparse_created = false;
        let mut durable_deletions = 0usize;
        let mut injected = false;

        let error = deletion
            .commit_remove_account_at_with_observer(
                &plan.plan_id,
                &account.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if point == TransactionFaultPoint::AfterCommittedJournalFlushed
                        && !late_reparse_created
                    {
                        create_directory_symlink(
                            &outside,
                            &observation.quarantine.join("late-link"),
                        );
                        late_reparse_created = true;
                    }
                    if point == TransactionFaultPoint::AfterDurableCleanupEntry {
                        let current = durable_deletions;
                        durable_deletions += 1;
                        if current == crash_after {
                            injected = true;
                            return Err(());
                        }
                    }
                    Ok(())
                },
            )
            .expect_err("inject after one durable cleanup namespace deletion");

        assert!(late_reparse_created, "prefix {crash_after}");
        assert!(injected, "cleanup prefix {crash_after} was not observed");
        assert_eq!(error.code, DeletionErrorCode::CleanupPending);
        assert_eq!(bytes(&outside_canary), b"outside-cleanup-prefix");
        let recovered = deletion
            .recover_pending_transactions()
            .unwrap_or_else(|error| {
                panic!("restart finalizes durable cleanup prefix {crash_after}: {error:?}")
            });
        assert_eq!(
            (recovered.restored, recovered.finalized, recovered.pending),
            (0, 1, 0),
            "prefix {crash_after}"
        );
        assert!(!target.exists(), "prefix {crash_after}");
        assert_eq!(bytes(&outside_canary), b"outside-cleanup-prefix");
        assert!(artifact_bytes(&fixture.profiles).is_empty());
        let second = deletion
            .recover_pending_transactions()
            .expect("cleanup-prefix recovery is idempotent");
        assert_eq!(
            (second.restored, second.finalized, second.pending),
            (0, 0, 0),
            "prefix {crash_after}"
        );
    }
}

#[test]
fn proposed_registry_substitution_is_rejected_before_profile_movement() {
    let fixture = Fixture::new("proposed-registry-substitution");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir_all(&target).expect("create disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"DISPOSABLE-PROFILE-CANARY")
        .expect("write disposable profile canary");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-substitution-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare substitution test");
    let mut substituted = false;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterProposedRegistryFlushed && !substituted {
                    fs::write(
                        &observation.proposed_registry,
                        b"INVALID-SUBSTITUTED-REGISTRY",
                    )
                    .expect("substitute proposed registry bytes");
                    substituted = true;
                }
                Ok(())
            },
        )
        .expect_err("substituted proposed bytes must not be committed");

    assert!(substituted);
    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&profile_canary), b"DISPOSABLE-PROFILE-CANARY");
    assert_eq!(bytes(&outside), b"outside-substitution-canary");
    let recovered = deletion
        .recover_pending_transactions()
        .expect("pre-commit substitution journal can be rolled back");
    assert_eq!(
        (recovered.restored, recovered.finalized, recovered.pending),
        (1, 0, 0)
    );
}

#[test]
fn oversized_proposed_registry_is_rejected_without_mutation_or_secret_disclosure() {
    const HOSTILE_MARKER: &[u8] = b"OVERSIZED-PROPOSAL-SECRET-MUST-NOT-LEAK";

    let fixture = Fixture::new("oversized-proposed-registry");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir(&target).expect("create disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"PROPOSAL-BOUND-PROFILE-CANARY").expect("write profile canary");
    let outside = fixture.root.join("outside-proposal-bound-canary");
    fs::write(&outside, b"OUTSIDE-PROPOSAL-BOUND-CANARY").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare oversized proposal test");
    let mut injected = false;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterProposedRegistryFlushed && !injected {
                    let mut hostile = vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES + 1];
                    hostile[..HOSTILE_MARKER.len()].copy_from_slice(HOSTILE_MARKER);
                    fs::write(&observation.proposed_registry, hostile)
                        .expect("grow proposed registry to cap + 1");
                    injected = true;
                }
                Ok(())
            },
        )
        .expect_err("oversized proposed registry must fail before profile movement");

    assert!(injected);
    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert!(!error
        .message
        .contains(std::str::from_utf8(HOSTILE_MARKER).expect("hostile marker is UTF-8")));
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&profile_canary), b"PROPOSAL-BOUND-PROFILE-CANARY");
    assert_eq!(bytes(&outside), b"OUTSIDE-PROPOSAL-BOUND-CANARY");

    let recovered = deletion
        .recover_pending_transactions()
        .expect("oversized pre-movement proposal can be rolled back");
    assert_eq!(
        (recovered.restored, recovered.finalized, recovered.pending),
        (1, 0, 0)
    );
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn proposal_growth_after_path_validation_restores_profile_without_disclosure() {
    const HOSTILE_MARKER: &[u8] = b"SEALED-PROPOSAL-SECRET-MUST-NOT-LEAK";

    let fixture = Fixture::new("oversized-sealed-proposed-registry");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir(&target).expect("create disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"SEALED-BOUND-PROFILE-CANARY").expect("write profile canary");
    let outside = fixture.root.join("outside-sealed-bound-canary");
    fs::write(&outside, b"OUTSIDE-SEALED-BOUND-CANARY").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare sealed proposal growth test");
    let mut injected = false;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::BeforeRegistryReplace && !injected {
                    let mut hostile = vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES + 1];
                    hostile[..HOSTILE_MARKER.len()].copy_from_slice(HOSTILE_MARKER);
                    fs::write(&observation.proposed_registry, hostile)
                        .expect("grow proposal after path validation");
                    injected = true;
                }
                Ok(())
            },
        )
        .expect_err("oversized proposal must fail after its final handle is sealed");

    assert!(injected);
    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert!(!error
        .message
        .contains(std::str::from_utf8(HOSTILE_MARKER).expect("hostile marker is UTF-8")));
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&profile_canary), b"SEALED-BOUND-PROFILE-CANARY");
    assert_eq!(bytes(&outside), b"OUTSIDE-SEALED-BOUND-CANARY");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn target_substitution_after_journal_flush_is_rejected_before_quarantine_rename() {
    let fixture = Fixture::new("target-substitution-after-proposal");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create original disposable profile");
    fs::write(target.join("original-canary"), b"original-profile")
        .expect("write original profile canary");
    let parked = fixture.profiles.join("parked-original");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-target-swap-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare target substitution test");
    let mut substituted = false;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterProposedRegistryFlushed && !substituted {
                    fs::rename(&observation.source, &parked).expect("park original profile");
                    fs::create_dir(&observation.source).expect("create substituted profile");
                    fs::write(
                        observation.source.join("replacement-canary"),
                        b"replacement-profile",
                    )
                    .expect("write replacement profile canary");
                    substituted = true;
                }
                Ok(())
            },
        )
        .expect_err("substituted target must be rejected before movement");

    assert!(substituted);
    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&parked.join("original-canary")), b"original-profile");
    assert_eq!(
        bytes(&target.join("replacement-canary")),
        b"replacement-profile"
    );
    assert_eq!(bytes(&outside), b"outside-target-swap-canary");
    assert!(
        transaction_artifacts(&fixture.profiles).is_empty(),
        "a rejected pre-movement substitution needs no recovery transaction"
    );
}

#[test]
fn proposed_registry_substitution_after_quarantine_restores_the_exact_profile() {
    let fixture = Fixture::new("proposed-substitution-after-quarantine");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create original disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"DISPOSABLE-QUARANTINE-CANARY").expect("write profile canary");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-post-quarantine-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare post-quarantine substitution test");
    let mut substituted = false;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterQuarantineRenamed && !substituted {
                    fs::write(
                        &observation.proposed_registry,
                        b"INVALID-POST-QUARANTINE-REGISTRY",
                    )
                    .expect("substitute flushed proposed registry");
                    substituted = true;
                }
                Ok(())
            },
        )
        .expect_err("post-quarantine proposal substitution must fail closed");

    assert!(substituted);
    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&profile_canary), b"DISPOSABLE-QUARANTINE-CANARY");
    assert_eq!(bytes(&outside), b"outside-post-quarantine-canary");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn final_proposed_registry_substitution_rejects_valid_and_invalid_bytes() {
    for case in ["valid", "invalid", "identical-distinct"] {
        let fixture = Fixture::new(&format!("final-proposal-substitution-{case}"));
        let removed = fixture.account("claude-work", "Claude Work");
        let retained = fixture.account("claude-home", "Claude Home");
        fixture.write_accounts(&[removed.clone(), retained.clone()]);
        let expected_proposal =
            serde_json::to_vec_pretty(&[retained]).expect("serialize expected proposal");
        let registry_before = bytes(&fixture.registry.registry_path());
        let target = fixture.profiles.join(&removed.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("profile-canary"), b"exact-profile").expect("write profile canary");
        let outside = fixture.root.join("outside-canary");
        fs::write(&outside, b"outside-final-proposal").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
            .expect("prepare final proposal substitution");
        let mut substituted = false;
        let mut distinct_identities = None;
        let parked_original = fixture.profiles.join("parked-original-proposal");

        let error = deletion
            .commit_remove_account_at_with_observer(
                &plan.plan_id,
                &removed.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if point == TransactionFaultPoint::BeforeRegistryReplace && !substituted {
                        if case == "identical-distinct" {
                            let original_identity = file_identity(&observation.proposed_registry);
                            assert_eq!(
                                journal_proposal_identity(&observation.journal),
                                original_identity,
                                "journal identity is bound to the originally created proposal"
                            );
                            let substitute = fixture.profiles.join("distinct-exact-proposal");
                            fs::write(&substitute, &expected_proposal)
                                .expect("write exact-byte distinct proposal");
                            let substitute_identity = file_identity(&substitute);
                            assert_ne!(
                                original_identity, substitute_identity,
                                "the exact-byte substitute must be a distinct file object"
                            );
                            fs::rename(&observation.proposed_registry, &parked_original)
                                .expect("park the validated proposal object");
                            fs::rename(&substitute, &observation.proposed_registry)
                                .expect("replace proposal pathname with distinct object");
                            assert_eq!(
                                file_identity(&observation.proposed_registry),
                                substitute_identity,
                                "proposal pathname must now name the distinct object"
                            );
                            distinct_identities = Some((original_identity, substitute_identity));
                        } else {
                            let substituted_bytes = if case == "valid" {
                                b"[]".as_slice()
                            } else {
                                b"INVALID-FINAL-PROPOSAL".as_slice()
                            };
                            fs::write(&observation.proposed_registry, substituted_bytes)
                                .expect("substitute final proposed registry bytes");
                        }
                        substituted = true;
                    }
                    Ok(())
                },
            )
            .expect_err("a final proposal substitution must never commit");

        assert!(substituted, "case {case}");
        assert_eq!(error.code, DeletionErrorCode::TargetChanged, "case {case}");
        assert_eq!(
            bytes(&fixture.registry.registry_path()),
            registry_before,
            "case {case}"
        );
        assert_eq!(
            bytes(&target.join("profile-canary")),
            b"exact-profile",
            "case {case}"
        );
        assert_eq!(bytes(&outside), b"outside-final-proposal", "case {case}");
        if case == "identical-distinct" {
            let (original_identity, substitute_identity) =
                distinct_identities.expect("captured distinct proposal identities");
            assert_eq!(file_identity(&parked_original), original_identity);
            assert_eq!(
                file_identity(
                    &transaction_artifacts(&fixture.profiles)
                        .into_iter()
                        .find(|path| {
                            path.file_name()
                                .is_some_and(|name| name.to_string_lossy().ends_with(".proposed"))
                        })
                        .expect("unowned proposal pathname is retained")
                ),
                substitute_identity
            );
            let recovery_error = deletion
                .recover_pending_transactions()
                .expect_err("recovery must retain a journal for an unowned proposal pathname");
            assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
            assert_eq!(file_identity(&parked_original), original_identity);
        } else {
            assert!(
                transaction_artifacts(&fixture.profiles).is_empty(),
                "a certain rollback removes transaction artifacts for {case} bytes"
            );
        }
    }

    let fixture = Fixture::new("final-proposal-post-validation-race");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained.clone()]);
    let expected_proposal = serde_json::to_vec_pretty(std::slice::from_ref(&retained))
        .expect("serialize expected proposal");
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir(&target).expect("create disposable race profile");
    fs::write(target.join("profile-canary"), b"post-validation-profile")
        .expect("write race profile canary");
    let outside = fixture.root.join("outside-canary");
    fs::write(&outside, b"outside-post-validation-race").expect("write outside race canary");
    let parked_original = fixture.profiles.join("parked-finally-validated-proposal");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare final proposal race");
    let mut identities = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterFinalProposalValidated
                    && identities.is_none()
                {
                    let original_identity = file_identity(&observation.proposed_registry);
                    assert_eq!(
                        journal_proposal_identity(&observation.journal),
                        original_identity,
                        "post-validation handle remains the journaled proposal object"
                    );
                    let substitute = fixture.profiles.join("post-validation-exact-substitute");
                    fs::write(&substitute, &expected_proposal)
                        .expect("write exact post-validation substitute");
                    let substitute_identity = file_identity(&substitute);
                    assert_ne!(original_identity, substitute_identity);
                    fs::rename(&observation.proposed_registry, &parked_original)
                        .expect("move validated object after final validation");
                    fs::rename(&substitute, &observation.proposed_registry)
                        .expect("substitute pathname after final validation");
                    identities = Some((
                        original_identity,
                        substitute_identity,
                        observation.proposed_registry.clone(),
                    ));
                }
                Ok(())
            },
        )
        .expect_err("an unowned proposal pathname must prevent a success response");

    assert_eq!(error.code, DeletionErrorCode::CleanupPending);
    let (original_identity, substitute_identity, substituted_path) =
        identities.expect("post-validation race was injected");
    assert_eq!(
        file_identity(&fixture.registry.registry_path()),
        original_identity,
        "handle-based replacement installs the exact validated proposal object"
    );
    assert_ne!(
        file_identity(&fixture.registry.registry_path()),
        substitute_identity,
        "the equal-byte pathname substitute is never installed"
    );
    assert_eq!(bytes(&fixture.registry.registry_path()), expected_proposal);
    assert_eq!(file_identity(&substituted_path), substitute_identity);
    assert!(!parked_original.exists());
    assert!(!target.exists());
    assert_eq!(bytes(&outside), b"outside-post-validation-race");
    let recovery_error = deletion
        .recover_pending_transactions()
        .expect_err("recovery retains the unowned post-validation substitute");
    assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(file_identity(&substituted_path), substitute_identity);
}

#[test]
fn post_replace_registry_substitution_never_reaches_cleanup_or_success() {
    for case in ["original", "unrelated"] {
        let fixture = Fixture::new(&format!("post-replace-registry-substitution-{case}"));
        let removed = fixture.account("claude-work", "Claude Work");
        let retained = fixture.account("claude-home", "Claude Home");
        fixture.write_accounts(&[removed.clone(), retained.clone()]);
        let registry_before = bytes(&fixture.registry.registry_path());
        let unrelated_registry = serde_json::to_vec_pretty(&[Account {
            label: "Unrelated edit".to_owned(),
            ..retained
        }])
        .expect("serialize unrelated registry generation");
        let substituted_registry = if case == "original" {
            registry_before.as_slice()
        } else {
            unrelated_registry.as_slice()
        };
        let target = fixture.profiles.join(&removed.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("profile-canary"), b"post-replace-profile")
            .expect("write profile canary");
        let outside = fixture.root.join("outside-canary");
        fs::write(&outside, b"outside-post-replace").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
            .expect("prepare post-replace substitution");
        let mut substituted = false;
        let mut cleanup_observed = false;
        let mut quarantine = None;

        let error = deletion
            .commit_remove_account_at_with_observer(
                &plan.plan_id,
                &removed.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if point == TransactionFaultPoint::AfterRegistryReplaced && !substituted {
                        fs::write(fixture.registry.registry_path(), substituted_registry)
                            .expect("substitute installed registry bytes");
                        quarantine = Some(observation.quarantine.clone());
                        substituted = true;
                    }
                    if matches!(
                        point,
                        TransactionFaultPoint::BeforeCleanupEntry
                            | TransactionFaultPoint::AfterCleanupEntry
                            | TransactionFaultPoint::AfterCleanupComplete
                    ) {
                        cleanup_observed = true;
                    }
                    Ok(())
                },
            )
            .expect_err("post-replace registry substitution must not report success");

        assert!(substituted, "case {case}");
        assert_eq!(error.code, DeletionErrorCode::OutcomeUnknown, "case {case}");
        assert!(!cleanup_observed, "cleanup began for case {case}");
        assert_eq!(
            bytes(&fixture.registry.registry_path()),
            substituted_registry,
            "case {case}"
        );
        assert!(
            !target.exists(),
            "source remains quarantined for case {case}"
        );
        let quarantine = quarantine.expect("capture quarantine path");
        assert_eq!(
            bytes(&quarantine.join("profile-canary")),
            b"post-replace-profile",
            "case {case}"
        );
        assert_eq!(bytes(&outside), b"outside-post-replace", "case {case}");
        assert!(
            !artifact_bytes(&fixture.profiles).is_empty(),
            "recovery evidence remains for case {case}"
        );

        if case == "original" {
            let recovered = deletion
                .recover_pending_transactions()
                .expect("original generation deterministically restores");
            assert_eq!((recovered.restored, recovered.finalized), (1, 0));
            assert_eq!(
                bytes(&target.join("profile-canary")),
                b"post-replace-profile"
            );
        } else {
            let recovery_error = deletion
                .recover_pending_transactions()
                .expect_err("unrelated generation remains outcome-unknown");
            assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
            assert_eq!(
                bytes(&quarantine.join("profile-canary")),
                b"post-replace-profile"
            );
        }
    }
}

#[test]
fn oversized_committed_registry_fails_outcome_unknown_before_cleanup_without_disclosure() {
    const HOSTILE_MARKER: &[u8] = b"COMMITTED-REGISTRY-SECRET-MUST-NOT-LEAK";

    let fixture = Fixture::new("oversized-committed-registry");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(
        target.join("profile-canary"),
        b"COMMITTED-BOUND-PROFILE-CANARY",
    )
    .expect("write profile canary");
    let outside = fixture.root.join("outside-committed-bound-canary");
    fs::write(&outside, b"OUTSIDE-COMMITTED-BOUND-CANARY").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare committed registry growth test");
    let mut injected = false;
    let mut cleanup_observed = false;
    let mut quarantine = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterRegistryReplaced && !injected {
                    let mut hostile = vec![b'x'; MAX_ACCOUNT_REGISTRY_BYTES + 1];
                    hostile[..HOSTILE_MARKER.len()].copy_from_slice(HOSTILE_MARKER);
                    fs::write(fixture.registry.registry_path(), hostile)
                        .expect("grow installed registry to cap + 1");
                    quarantine = Some(observation.quarantine.clone());
                    injected = true;
                }
                if matches!(
                    point,
                    TransactionFaultPoint::BeforeCleanupEntry
                        | TransactionFaultPoint::AfterCleanupEntry
                        | TransactionFaultPoint::AfterCleanupComplete
                ) {
                    cleanup_observed = true;
                }
                Ok(())
            },
        )
        .expect_err("oversized installed registry must retain outcome-unknown evidence");

    assert!(injected);
    assert_eq!(
        error.code,
        DeletionErrorCode::OutcomeUnknown,
        "unexpected committed-registry failure: {error:?}"
    );
    assert!(!error
        .message
        .contains(std::str::from_utf8(HOSTILE_MARKER).expect("hostile marker is UTF-8")));
    assert!(!cleanup_observed);
    assert!(!target.exists(), "uncertain profile remains quarantined");
    let quarantine = quarantine.expect("capture quarantine path");
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"COMMITTED-BOUND-PROFILE-CANARY"
    );
    assert_eq!(bytes(&outside), b"OUTSIDE-COMMITTED-BOUND-CANARY");
    assert!(
        !transaction_artifacts(&fixture.profiles).is_empty(),
        "recovery evidence must be retained"
    );
    let recovery_error = deletion
        .recover_pending_transactions()
        .expect_err("oversized committed bytes prevent recovery from deciding transaction truth");
    assert_eq!(recovery_error.code, DeletionErrorCode::RecoveryRequired);
    assert!(!recovery_error
        .message
        .contains(std::str::from_utf8(HOSTILE_MARKER).expect("hostile marker is UTF-8")));
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"COMMITTED-BOUND-PROFILE-CANARY"
    );
}

#[test]
fn registry_replacement_failure_restores_the_exact_quarantined_profile() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new("registry-replace-restores");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"DISPOSABLE-RESTORE-CANARY").expect("write profile canary");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-restore-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare registry failure test");
    let held_registry = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.registry.registry_path())
        .expect("hold registry without delete sharing");

    let error = deletion
        .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_000)
        .expect_err("registry replacement must fail while its path denies delete sharing");
    drop(held_registry);

    assert_eq!(error.code, DeletionErrorCode::Io);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&profile_canary), b"DISPOSABLE-RESTORE-CANARY");
    assert_eq!(bytes(&outside), b"outside-restore-canary");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn uncertain_restore_retains_the_journal_and_never_reports_success() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new("registry-restore-uncertain");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create disposable profile");
    fs::write(
        target.join("original-canary"),
        b"original-quarantined-profile",
    )
    .expect("write original profile canary");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-uncertain-restore-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare uncertain restore test");
    let held_registry = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.registry.registry_path())
        .expect("hold registry without delete sharing");
    let mut collision_created = false;
    let mut quarantine = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::BeforeRegistryReplace && !collision_created {
                    fs::create_dir(&observation.source).expect("create restore collision");
                    fs::write(
                        observation.source.join("replacement-canary"),
                        b"replacement-profile",
                    )
                    .expect("write restore collision canary");
                    quarantine = Some(observation.quarantine.clone());
                    collision_created = true;
                }
                Ok(())
            },
        )
        .expect_err("uncertain restoration must never report success");
    drop(held_registry);

    assert!(collision_created);
    assert_eq!(error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(
        bytes(&target.join("replacement-canary")),
        b"replacement-profile"
    );
    let quarantine = quarantine.expect("observer captured quarantine path");
    assert_eq!(
        bytes(&quarantine.join("original-canary")),
        b"original-quarantined-profile"
    );
    assert_eq!(bytes(&outside), b"outside-uncertain-restore-canary");
    assert!(!artifact_bytes(&fixture.profiles).is_empty());
    let recovery_error = deletion
        .recover_pending_transactions()
        .expect_err("ambiguous source plus quarantine remains recovery-required");
    assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(
        bytes(&target.join("replacement-canary")),
        b"replacement-profile"
    );
    assert_eq!(
        bytes(&quarantine.join("original-canary")),
        b"original-quarantined-profile"
    );
    let replay = deletion
        .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_001)
        .expect_err("uncertain transaction plan is still single-use");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn cleanup_failure_keeps_a_committed_retry_record_until_recovery_finishes() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new("cleanup-retry");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(target.join("sessions")).expect("create disposable profile");
    fs::write(target.join("auth.json"), b"DISPOSABLE-CLEANUP-CANARY")
        .expect("write profile canary");
    fs::write(target.join("sessions").join("one.jsonl"), b"session")
        .expect("write disposable session");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-cleanup-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare cleanup failure test");
    let mut held_cleanup_file = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::BeforeCleanupEntry && held_cleanup_file.is_none()
                {
                    if let Some(entry) = observation.cleanup_entry.as_ref() {
                        if fs::symlink_metadata(entry)
                            .expect("cleanup entry metadata")
                            .is_file()
                        {
                            held_cleanup_file = Some(
                                fs::OpenOptions::new()
                                    .read(true)
                                    .share_mode(1)
                                    .open(entry)
                                    .expect("hold cleanup file without delete sharing"),
                            );
                        }
                    }
                }
                Ok(())
            },
        )
        .expect_err("denied quarantine cleanup remains retryable");

    assert!(held_cleanup_file.is_some());
    assert_eq!(error.code, DeletionErrorCode::CleanupPending);
    assert_eq!(
        fixture.registry.list().expect("read committed registry"),
        Vec::<Account>::new()
    );
    assert!(!target.exists());
    assert_eq!(bytes(&outside), b"outside-cleanup-canary");
    assert!(!artifact_bytes(&fixture.profiles).is_empty());
    drop(held_cleanup_file);

    let recovered = deletion
        .recover_pending_transactions()
        .expect("startup recovery retries committed cleanup");
    assert_eq!(
        (recovered.restored, recovered.finalized, recovered.pending),
        (0, 1, 0)
    );
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
    assert_eq!(bytes(&outside), b"outside-cleanup-canary");
}

#[test]
fn cleanup_removes_two_in_profile_hardlink_aliases_without_an_outside_link() {
    let fixture = Fixture::new("cleanup-in-profile-hardlinks");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"in-profile-hardlink-canary").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    assert_eq!(file_identity(&first), file_identity(&second));
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare in-profile hardlink cleanup");

    deletion
        .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_000)
        .expect("normal cleanup removes both transaction-owned hardlink names");

    assert!(fixture
        .registry
        .list()
        .expect("read committed registry")
        .is_empty());
    assert!(!target.exists());
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn cleanup_accepts_64_owned_aliases_and_fails_closed_at_65() {
    for alias_count in [64_usize, 65] {
        let fixture = Fixture::new(&format!("cleanup-alias-bound-{alias_count}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        let first = target.join("alias-000");
        fs::write(&first, b"alias-resource-bound-canary").expect("write first alias");
        for index in 1..alias_count {
            fs::hard_link(&first, target.join(format!("alias-{index:03}")))
                .expect("create bounded in-profile hardlink alias");
        }
        let identity = file_identity(&first);
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare alias-bound cleanup");
        let mut quarantine = None;
        let mut journal = None;
        let commit = deletion.commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterCommittedJournalFlushed {
                    quarantine = Some(observation.quarantine.clone());
                    journal = Some(observation.journal.clone());
                }
                Ok(())
            },
        );

        if alias_count == 64 {
            commit.expect("the exact hardlink-alias resource bound is accepted");
            assert!(transaction_artifacts(&fixture.profiles).is_empty());
        } else {
            assert!(matches!(
                commit,
                Err(ref error) if error.code == DeletionErrorCode::CleanupPending
            ));
            let quarantine = quarantine.expect("capture retained over-bound quarantine");
            let journal = journal.expect("capture retained over-bound journal");
            assert_eq!(
                (0..alias_count)
                    .map(|index| quarantine.join(format!("alias-{index:03}")))
                    .filter(|path| path.exists())
                    .count(),
                alias_count
            );
            assert_eq!(file_identity(&quarantine.join("alias-000")), identity);
            assert!(journal.exists());

            let recovery = deletion.recover_pending_transactions();

            assert!(matches!(
                recovery,
                Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
            ));
            assert_eq!(
                (0..alias_count)
                    .map(|index| quarantine.join(format!("alias-{index:03}")))
                    .filter(|path| path.exists())
                    .count(),
                alias_count
            );
            assert_eq!(file_identity(&quarantine.join("alias-000")), identity);
            assert!(quarantine.exists());
            assert!(journal.exists());
        }
    }
}

#[test]
fn cleanup_path_opens_are_linear_for_many_unique_entries() {
    let fixture = Fixture::new("cleanup-linear-path-opens");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    const FILE_COUNT: u64 = 256;
    for index in 0..FILE_COUNT {
        fs::write(target.join(format!("entry-{index:04}")), b"linear-canary")
            .expect("write synthetic unique cleanup entry");
    }
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare linear cleanup measurement");
    let mut measured_path_opens = None;

    deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterCleanupComplete {
                    measured_path_opens = Some(observation.cleanup_path_opens);
                }
                Ok(())
            },
        )
        .expect("cleanup many unique entries");

    let manifest_entries = FILE_COUNT + 1;
    let measured_path_opens = measured_path_opens.expect("capture cleanup path-open count");
    assert_eq!(measured_path_opens, 5 * manifest_entries - 2);
}

#[test]
fn recovery_finishes_after_the_first_in_profile_hardlink_alias_was_deleted() {
    let fixture = Fixture::new("recover-in-profile-hardlinks");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"in-profile-hardlink-recovery-canary").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    assert_eq!(file_identity(&first), file_identity(&second));
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare in-profile hardlink recovery");
    let mut interrupted = false;
    let mut journal = None;
    let mut quarantine = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::AfterDurableCleanupEntry && !interrupted {
                interrupted = true;
                journal = Some(observation.journal.clone());
                quarantine = Some(observation.quarantine.clone());
                return Err(());
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    assert!(interrupted);
    let journal = journal.expect("capture durable cleanup inventory journal");
    assert!(journal.exists());
    let quarantine = quarantine.expect("capture retained quarantine directory");
    let remaining_aliases = [
        quarantine.join("first-alias"),
        quarantine.join("second-alias"),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .count();
    assert_eq!(
        remaining_aliases, 1,
        "exactly one durable alias prefix was removed"
    );

    let recovered = deletion
        .recover_pending_transactions()
        .expect("recovery accepts only the manifest-owned hardlink-count decrease");
    assert_eq!(
        (recovered.restored, recovered.finalized, recovered.pending),
        (0, 1, 0)
    );
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
    assert!(!target.exists());
}

#[test]
fn cleanup_never_completes_after_hardlink_alias_path_laundering() {
    let fixture = Fixture::new("cleanup-hardlink-path-laundering");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"hardlink-path-laundering-canary").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    let identity = file_identity(&first);
    assert_eq!(file_identity(&second), identity);
    let parked = fixture.root.join("parked-original-alias");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare hardlink pathname laundering cleanup");
    let mut swapped = false;
    let mut quarantine = None;
    let mut journal = None;
    let mut replacement_path = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::BeforeCleanupEntry && !swapped {
                let entry = observation
                    .cleanup_entry
                    .as_ref()
                    .expect("cleanup entry is exposed at the observer boundary");
                let other =
                    if entry.file_name().and_then(|name| name.to_str()) == Some("first-alias") {
                        observation.quarantine.join("second-alias")
                    } else {
                        observation.quarantine.join("first-alias")
                    };
                fs::rename(entry, &parked).expect("park the original manifested pathname");
                fs::rename(&other, entry)
                    .expect("move the other manifested alias into the expected pathname");
                assert_eq!(file_identity(&parked), identity);
                assert_eq!(file_identity(entry), identity);
                replacement_path = Some(entry.clone());
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                swapped = true;
            }
            Ok(())
        },
    );

    assert!(swapped);
    let quarantine = quarantine.expect("capture retained quarantine");
    let journal = journal.expect("capture retained journal");
    let replacement_path = replacement_path.expect("capture replacement pathname");
    assert!(
        matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ),
        "path laundering must not report success: commit={commit:?}, parked={}, quarantine={}, journal={}",
        parked.exists(),
        quarantine.exists(),
        journal.exists()
    );
    assert!(parked.exists());
    assert_eq!(bytes(&parked), b"hardlink-path-laundering-canary");
    assert_eq!(file_identity(&parked), identity);
    assert!(replacement_path.exists());
    assert_eq!(bytes(&replacement_path), b"hardlink-path-laundering-canary");
    assert_eq!(file_identity(&replacement_path), identity);
    assert!(quarantine.exists());
    assert!(journal.exists());
    assert_eq!(journal_cleanup_progress(&journal), 0);
    assert!(fixture
        .registry
        .list()
        .expect("read committed registry")
        .is_empty());
}

#[test]
fn recovery_never_completes_after_hardlink_alias_path_laundering() {
    let fixture = Fixture::new("recover-hardlink-path-laundering");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"hardlink-recovery-laundering-canary").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    let identity = file_identity(&first);
    assert_eq!(file_identity(&second), identity);
    let parked = fixture.root.join("parked-recovery-alias");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare recovery pathname laundering cleanup");
    let mut swapped = false;
    let mut quarantine = None;
    let mut journal = None;
    let mut replacement_path = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::BeforeCleanupEntry && !swapped {
                let entry = observation
                    .cleanup_entry
                    .as_ref()
                    .expect("cleanup entry is exposed at the observer boundary");
                let other =
                    if entry.file_name().and_then(|name| name.to_str()) == Some("first-alias") {
                        observation.quarantine.join("second-alias")
                    } else {
                        observation.quarantine.join("first-alias")
                    };
                fs::rename(entry, &parked).expect("park the original manifested pathname");
                fs::rename(&other, entry)
                    .expect("move the other manifested alias into the expected pathname");
                assert_eq!(file_identity(&parked), identity);
                assert_eq!(file_identity(entry), identity);
                replacement_path = Some(entry.clone());
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                swapped = true;
                return Err(());
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    assert!(swapped);
    let quarantine = quarantine.expect("capture retained quarantine");
    let journal = journal.expect("capture retained journal");
    let replacement_path = replacement_path.expect("capture replacement pathname");
    assert!(parked.exists());
    assert!(replacement_path.exists());
    assert!(quarantine.exists());
    assert!(journal.exists());
    assert_eq!(journal_cleanup_progress(&journal), 0);

    let recovery = deletion.recover_pending_transactions();

    assert!(
        matches!(
            recovery,
            Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
        ),
        "recovery must not infer ownership from a missing pathname: recovery={recovery:?}, parked={}, quarantine={}, journal={}",
        parked.exists(),
        quarantine.exists(),
        journal.exists()
    );
    assert!(parked.exists());
    assert_eq!(bytes(&parked), b"hardlink-recovery-laundering-canary");
    assert_eq!(file_identity(&parked), identity);
    assert!(replacement_path.exists());
    assert_eq!(
        bytes(&replacement_path),
        b"hardlink-recovery-laundering-canary"
    );
    assert_eq!(file_identity(&replacement_path), identity);
    assert!(quarantine.exists());
    assert!(journal.exists());
    assert_eq!(journal_cleanup_progress(&journal), 0);
}

#[test]
fn bounded_identity_group_proof_pins_current_and_preserves_a_moved_peer() {
    for restart in [false, true] {
        let fixture = Fixture::new(if restart {
            "recover-bounded-group-laundering"
        } else {
            "cleanup-bounded-group-laundering"
        });
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        let first = target.join("first-alias");
        let second = target.join("second-alias");
        fs::write(&first, b"bounded-group-laundering-canary").expect("write first alias");
        fs::hard_link(&first, &second).expect("create second alias");
        let identity = file_identity(&first);
        let parked = fixture.root.join("parked-bounded-group-peer");
        let forbidden_current_park = fixture.root.join("must-not-park-current-alias");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare bounded-group laundering cleanup");
        let mut swapped = false;
        let mut replacement_path = None;
        let mut quarantine = None;
        let mut journal = None;

        let commit = deletion.commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::BeforeCleanupIdentityGroupValidation && !swapped
                {
                    let entry = observation
                        .cleanup_entry
                        .as_ref()
                        .expect("current cleanup entry is exposed");
                    let other = if entry.file_name().and_then(|name| name.to_str())
                        == Some("first-alias")
                    {
                        observation.quarantine.join("second-alias")
                    } else {
                        observation.quarantine.join("first-alias")
                    };
                    fs::rename(entry, &forbidden_current_park)
                        .expect_err("the open deletion handle pins the current pathname");
                    fs::rename(&other, &parked).expect("park future manifested alias");
                    assert_eq!(file_identity(&parked), identity);
                    assert_eq!(file_identity(entry), identity);
                    replacement_path = Some(entry.clone());
                    quarantine = Some(observation.quarantine.clone());
                    journal = Some(observation.journal.clone());
                    swapped = true;
                    if restart {
                        return Err(());
                    }
                }
                Ok(())
            },
        );

        assert!(swapped);
        assert!(matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ));
        let replacement_path = replacement_path.expect("capture replacement pathname");
        let quarantine = quarantine.expect("capture retained quarantine");
        let journal = journal.expect("capture retained journal");
        assert!(parked.exists());
        assert!(replacement_path.exists());
        assert!(!forbidden_current_park.exists());
        assert_eq!(bytes(&parked), b"bounded-group-laundering-canary");
        assert_eq!(bytes(&replacement_path), b"bounded-group-laundering-canary");
        assert_eq!(file_identity(&parked), identity);
        assert_eq!(file_identity(&replacement_path), identity);
        assert_eq!(journal_cleanup_progress(&journal), 0);

        if restart {
            let recovery = deletion.recover_pending_transactions();
            assert!(matches!(
                recovery,
                Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
            ));
            assert!(parked.exists());
            assert!(replacement_path.exists());
            assert!(!forbidden_current_park.exists());
            assert_eq!(bytes(&parked), b"bounded-group-laundering-canary");
            assert_eq!(bytes(&replacement_path), b"bounded-group-laundering-canary");
            assert_eq!(journal_cleanup_progress(&journal), 0);
        }
        assert!(quarantine.exists());
        assert!(journal.exists());
    }
}

#[test]
fn recovery_validates_a_reordered_four_alias_manifest_as_one_ownership_closure() {
    let fixture = Fixture::new("recover-reordered-four-alias-closure");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let alias_names = ["alias-a", "alias-b", "alias-c", "alias-d"];
    let aliases = alias_names.map(|name| target.join(name));
    fs::write(&aliases[0], b"four-alias-ownership-canary").expect("write first alias");
    for alias in aliases.iter().skip(1) {
        fs::hard_link(&aliases[0], alias).expect("create in-profile hardlink alias");
    }
    let identity = file_identity(&aliases[0]);
    assert!(aliases.iter().all(|alias| file_identity(alias) == identity));
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare four-alias cleanup");
    let mut quarantine = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::BeforeCleanupEntry {
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                return Err(());
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    let quarantine = quarantine.expect("capture retained quarantine");
    let journal = journal.expect("capture retained journal");
    let mut journal_value = read_journal(&journal);
    let manifest = journal_value
        .get_mut("cleanupManifest")
        .and_then(serde_json::Value::as_array_mut)
        .expect("journal records cleanup manifest");
    assert_eq!(manifest.len(), alias_names.len() + 1);
    manifest[..alias_names.len()].reverse();
    let current = quarantine.join(cleanup_manifest_entry_name(&manifest[0]));
    write_journal(&journal, &journal_value);

    let moved = alias_names
        .iter()
        .map(|name| quarantine.join(name))
        .find(|candidate| candidate != &current)
        .expect("select a future manifested alias");
    let parked = fixture.root.join("parked-four-alias-original");
    fs::rename(&current, &parked).expect("park the reordered current alias");
    fs::rename(&moved, &current).expect("move a future alias into the current pathname");
    assert_eq!(file_identity(&parked), identity);
    assert_eq!(file_identity(&current), identity);

    let recovery = deletion.recover_pending_transactions();

    assert!(matches!(
        recovery,
        Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
    ));
    assert!(parked.exists());
    assert!(current.exists());
    assert_eq!(bytes(&parked), b"four-alias-ownership-canary");
    assert_eq!(bytes(&current), b"four-alias-ownership-canary");
    assert_eq!(file_identity(&parked), identity);
    assert_eq!(file_identity(&current), identity);
    assert_eq!(
        alias_names
            .iter()
            .map(|name| quarantine.join(name))
            .filter(|path| path.exists())
            .count(),
        alias_names.len() - 1,
        "the replacement and both untouched manifest names survive"
    );
    assert!(quarantine.exists());
    assert!(journal.exists());
    assert_eq!(journal_cleanup_progress(&journal), 0);
}

#[test]
fn recovery_rejects_malformed_or_tampered_cleanup_cursor_and_manifest_without_mutation() {
    for case in [
        "cursor-past-end",
        "cursor-skips-live-entry",
        "duplicate-entry",
        "unsafe-component",
        "missing-root",
    ] {
        let fixture = Fixture::new(&format!("recover-tampered-cleanup-{case}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("profile-canary"), b"tampered-journal-canary")
            .expect("write profile canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare tampered cleanup recovery");
        let mut quarantine = None;
        let mut journal = None;
        let commit = deletion.commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::BeforeCleanupEntry {
                    quarantine = Some(observation.quarantine.clone());
                    journal = Some(observation.journal.clone());
                    return Err(());
                }
                Ok(())
            },
        );
        assert!(matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ));
        let quarantine = quarantine.expect("capture retained quarantine");
        let journal = journal.expect("capture retained journal");
        let canary = quarantine.join("profile-canary");
        let canary_identity = file_identity(&canary);
        let mut journal_value = read_journal(&journal);
        let manifest_len = journal_value
            .get("cleanupManifest")
            .and_then(serde_json::Value::as_array)
            .expect("journal records cleanup manifest")
            .len();
        match case {
            "cursor-past-end" => {
                journal_value["cleanupProgress"] = serde_json::json!(manifest_len + 1);
            }
            "cursor-skips-live-entry" => {
                journal_value["cleanupProgress"] = serde_json::json!(1);
            }
            "duplicate-entry" => {
                let manifest = journal_value["cleanupManifest"]
                    .as_array_mut()
                    .expect("journal records cleanup manifest");
                manifest.insert(0, manifest[0].clone());
            }
            "unsafe-component" => {
                journal_value["cleanupManifest"][0]["relativePath"][0] =
                    serde_json::json!([u16::from(b'\\')]);
            }
            "missing-root" => {
                journal_value["cleanupManifest"]
                    .as_array_mut()
                    .expect("journal records cleanup manifest")
                    .pop();
            }
            _ => unreachable!(),
        }
        write_journal(&journal, &journal_value);

        let recovery = deletion
            .recover_pending_transactions()
            .expect_err("tampered cleanup state must fail closed");

        let expected_code = if case == "cursor-past-end" {
            DeletionErrorCode::RecoveryRequired
        } else {
            DeletionErrorCode::OutcomeUnknown
        };
        assert_eq!(recovery.code, expected_code, "case {case}");
        assert!(canary.exists(), "case {case}");
        assert_eq!(bytes(&canary), b"tampered-journal-canary", "case {case}");
        assert_eq!(file_identity(&canary), canary_identity, "case {case}");
        assert!(quarantine.exists(), "case {case}");
        assert!(journal.exists(), "case {case}");
    }
}

#[test]
fn recovery_accepts_a_64_mib_journal_and_rejects_one_byte_more_without_mutation() {
    const JOURNAL_BYTE_CAP: usize = 64 * 1024 * 1024;
    for (case, encoded_len) in [
        ("at-cap", JOURNAL_BYTE_CAP),
        ("over-cap", JOURNAL_BYTE_CAP + 1),
    ] {
        let fixture = Fixture::new(&format!("recover-journal-byte-{case}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("profile-canary"), b"journal-byte-cap-canary")
            .expect("write profile canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare journal byte-cap recovery");
        let mut quarantine = None;
        let mut journal = None;
        let commit = deletion.commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterCommittedJournalFlushed {
                    quarantine = Some(observation.quarantine.clone());
                    journal = Some(observation.journal.clone());
                    return Err(());
                }
                Ok(())
            },
        );
        assert!(matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ));
        let quarantine = quarantine.expect("capture retained quarantine");
        let journal = journal.expect("capture retained journal");
        let canary = quarantine.join("profile-canary");
        let canary_identity = file_identity(&canary);
        pad_journal_with_spaces(&journal, encoded_len);

        let recovery = deletion.recover_pending_transactions();

        if case == "at-cap" {
            let recovery = recovery.expect("the exact journal byte cap is accepted");
            assert_eq!(
                (recovery.restored, recovery.finalized, recovery.pending),
                (0, 1, 0)
            );
            assert!(!quarantine.exists());
            assert!(!journal.exists());
        } else {
            assert!(matches!(
                recovery,
                Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
            ));
            assert!(canary.exists());
            assert_eq!(bytes(&canary), b"journal-byte-cap-canary");
            assert_eq!(file_identity(&canary), canary_identity);
            assert!(quarantine.exists());
            assert!(journal.exists());
        }
    }
}

#[test]
fn recovery_rejects_excess_journal_entries_before_mutating_an_earlier_transaction() {
    const JOURNAL_ENTRY_CAP: usize = 256;

    let fixture = Fixture::new("recover-journal-entry-cap");
    let (deletion, quarantine, journal) = retain_committed_transaction(&fixture, "claude-work");
    let journals = journal.parent().expect("journal directory");
    for index in 0..JOURNAL_ENTRY_CAP {
        fs::write(journals.join(format!("zzzz-{index:04}.json")), b"{}")
            .expect("write hostile journal entry");
    }

    let error = deletion
        .recover_pending_transactions()
        .expect_err("an over-bound journal directory must fail before recovery work");

    assert_eq!(error.code, DeletionErrorCode::RecoveryRequired);
    assert_eq!(
        error.message,
        "transaction journal directory exceeds its entry resource bound"
    );
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"recovery-bound-canary"
    );
    assert!(quarantine.exists());
    assert!(journal.exists());
}

#[test]
fn recovery_rejects_aggregate_journal_bytes_before_mutating_an_earlier_transaction() {
    const AGGREGATE_JOURNAL_BYTE_CAP: u64 = 64 * 1024 * 1024;

    let fixture = Fixture::new("recover-journal-aggregate-cap");
    let (deletion, quarantine, journal) = retain_committed_transaction(&fixture, "claude-work");
    let hostile = journal
        .parent()
        .expect("journal directory")
        .join("zzzz-aggregate.json");
    fs::File::create(&hostile)
        .expect("create sparse hostile journal")
        .set_len(AGGREGATE_JOURNAL_BYTE_CAP)
        .expect("size sparse hostile journal");

    let error = deletion
        .recover_pending_transactions()
        .expect_err("aggregate journal bytes must be admitted before recovery work");

    assert_eq!(error.code, DeletionErrorCode::RecoveryRequired);
    assert_eq!(
        error.message,
        "transaction journals exceed their aggregate encoded byte resource bound; records were retained"
    );
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"recovery-bound-canary"
    );
    assert!(quarantine.exists());
    assert!(journal.exists());
}

#[test]
fn recovery_bounds_the_account_registry_before_deciding_transaction_outcome() {
    const ACCOUNT_REGISTRY_BYTE_CAP: u64 = 4 * 1024 * 1024;

    let fixture = Fixture::new("recover-registry-byte-cap");
    let (deletion, quarantine, journal) = retain_committed_transaction(&fixture, "claude-work");
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.registry.registry_path())
        .expect("open registry for hostile growth")
        .set_len(ACCOUNT_REGISTRY_BYTE_CAP + 1)
        .expect("grow registry beyond its existing byte cap");

    let error = deletion
        .recover_pending_transactions()
        .expect_err("startup recovery must reject an over-bound registry read");

    assert_eq!(error.code, DeletionErrorCode::RecoveryRequired);
    assert_eq!(error.message, "account registry is invalid during recovery");
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"recovery-bound-canary"
    );
    assert!(quarantine.exists());
    assert!(journal.exists());
}

#[test]
fn recovery_accepts_every_durable_prefix_of_a_three_alias_cleanup() {
    for interrupted_after in 1..=4 {
        let fixture = Fixture::new(&format!("recover-three-alias-prefix-{interrupted_after}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        let aliases = [
            target.join("alias-a"),
            target.join("alias-b"),
            target.join("alias-c"),
        ];
        fs::write(&aliases[0], b"three-alias-prefix-canary").expect("write first alias");
        for alias in aliases.iter().skip(1) {
            fs::hard_link(&aliases[0], alias).expect("create in-profile hardlink alias");
        }
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare three-alias prefix cleanup");
        let mut completed = 0;
        let mut journal = None;
        let commit = deletion.commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterDurableCleanupEntry {
                    completed += 1;
                    if completed == interrupted_after {
                        journal = Some(observation.journal.clone());
                        return Err(());
                    }
                }
                Ok(())
            },
        );
        assert!(matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ));
        let journal = journal.expect("capture interrupted cleanup journal");
        assert_eq!(journal_cleanup_progress(&journal), interrupted_after);

        let recovery = deletion
            .recover_pending_transactions()
            .expect("recover valid durable hardlink cleanup prefix");

        assert_eq!(
            (recovery.restored, recovery.finalized, recovery.pending),
            (0, 1, 0),
            "prefix {interrupted_after}"
        );
        assert!(!target.exists(), "prefix {interrupted_after}");
        assert!(
            transaction_artifacts(&fixture.profiles).is_empty(),
            "prefix {interrupted_after}"
        );
    }
}

#[test]
fn recovery_never_reuses_a_completed_hardlink_manifest_path() {
    let fixture = Fixture::new("recover-completed-hardlink-path");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"completed-path-reoccupation-canary").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    let identity = file_identity(&first);
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare completed-path recovery cleanup");
    let mut reoccupied = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::AfterDurableCleanupEntry && reoccupied.is_none() {
                let completed = observation
                    .cleanup_entry
                    .as_ref()
                    .expect("completed cleanup entry is exposed")
                    .clone();
                let remaining = [
                    observation.quarantine.join("first-alias"),
                    observation.quarantine.join("second-alias"),
                ]
                .into_iter()
                .find(|path| path.exists())
                .expect("one original hardlink alias remains");
                fs::hard_link(&remaining, &completed)
                    .expect("reoccupy the completed pathname with a new alias");
                assert_eq!(file_identity(&completed), identity);
                reoccupied = Some(completed);
                journal = Some(observation.journal.clone());
                return Err(());
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    let reoccupied = reoccupied.expect("reoccupy a completed manifest pathname");
    let journal = journal.expect("capture retained journal");
    assert_eq!(journal_cleanup_progress(&journal), 1);

    let recovery = deletion.recover_pending_transactions();

    assert!(
        matches!(
            recovery,
            Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
        ),
        "a completed pathname occupant must never be adopted: recovery={recovery:?}, reoccupied={}, journal={}",
        reoccupied.exists(),
        journal.exists()
    );
    assert!(reoccupied.exists());
    assert_eq!(bytes(&reoccupied), b"completed-path-reoccupation-canary");
    assert_eq!(file_identity(&reoccupied), identity);
    assert!(journal.exists());
}

#[test]
fn cleanup_never_adopts_a_hardlink_with_an_outside_manifest_name() {
    let fixture = Fixture::new("cleanup-outside-hardlink");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let outside = fixture.root.join("outside-hardlink-canary");
    let inside = target.join("inside-name");
    fs::write(&outside, b"outside-hardlink-must-survive").expect("write outside canary");
    fs::hard_link(&outside, &inside).expect("create profile link to outside file object");
    let identity = file_identity(&outside);
    assert_eq!(file_identity(&inside), identity);
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare outside-hardlink cleanup");
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::AfterCommittedJournalFlushed {
                journal = Some(observation.journal.clone());
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    let journal = journal.expect("capture retained transaction journal");
    assert!(journal.exists());
    assert_eq!(bytes(&outside), b"outside-hardlink-must-survive");
    assert_eq!(file_identity(&outside), identity);
    let recovery = deletion.recover_pending_transactions();
    assert!(matches!(
        recovery,
        Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
    ));
    assert!(journal.exists());
    assert_eq!(bytes(&outside), b"outside-hardlink-must-survive");
    assert_eq!(file_identity(&outside), identity);
}

#[test]
fn cleanup_rejects_a_new_outside_link_that_offsets_an_owned_alias_deletion() {
    let fixture = Fixture::new("cleanup-new-outside-hardlink");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let first = target.join("first-alias");
    let second = target.join("second-alias");
    fs::write(&first, b"new-outside-hardlink-must-survive").expect("write in-profile file");
    fs::hard_link(&first, &second).expect("create second in-profile hardlink name");
    let identity = file_identity(&first);
    let outside = fixture.root.join("new-outside-hardlink");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare new-outside-hardlink cleanup");
    let mut inserted = false;
    let mut quarantine = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::AfterDurableCleanupEntry && !inserted {
                let remaining = [
                    observation.quarantine.join("first-alias"),
                    observation.quarantine.join("second-alias"),
                ]
                .into_iter()
                .find(|path| path.exists())
                .expect("one manifested alias remains");
                fs::hard_link(&remaining, &outside)
                    .expect("add an outside link after the owned unlink");
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                inserted = true;
            }
            Ok(())
        },
    );

    assert!(matches!(
        commit,
        Err(ref error) if error.code == DeletionErrorCode::CleanupPending
    ));
    assert!(inserted);
    let quarantine = quarantine.expect("capture retained quarantine");
    let journal = journal.expect("capture retained journal");
    assert!(journal.exists());
    assert_eq!(bytes(&outside), b"new-outside-hardlink-must-survive");
    assert_eq!(file_identity(&outside), identity);
    assert_eq!(
        [
            quarantine.join("first-alias"),
            quarantine.join("second-alias")
        ]
        .into_iter()
        .filter(|path| path.exists())
        .count(),
        1
    );
    let recovery = deletion.recover_pending_transactions();
    assert!(matches!(
        recovery,
        Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
    ));
    assert!(journal.exists());
    assert_eq!(bytes(&outside), b"new-outside-hardlink-must-survive");
    assert_eq!(file_identity(&outside), identity);
}

#[test]
fn cleanup_root_namespace_substitution_preserves_both_trees_and_recovery_record() {
    let fixture = Fixture::new("cleanup-root-namespace-substitution");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(
        target.join("profile-canary"),
        b"original-quarantined-profile",
    )
    .expect("write original profile canary");
    let parked_original = fixture.root.join("retained-original-quarantine");
    let replacement_fixture = fixture.root.join("replacement-quarantine-fixture");
    fs::create_dir(&replacement_fixture).expect("create replacement fixture");
    fs::write(
        replacement_fixture.join("profile-canary"),
        b"replacement-fixture-must-survive",
    )
    .expect("write replacement fixture canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare cleanup namespace substitution test");
    let mut swapped = false;
    let mut quarantine = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::BeforeCleanupEntry && !swapped {
                fs::rename(&observation.quarantine, &parked_original)
                    .expect("park the original quarantine tree");
                fs::rename(&replacement_fixture, &observation.quarantine)
                    .expect("substitute the quarantine namespace");
                quarantine = Some(observation.quarantine.clone());
                journal = Some(observation.journal.clone());
                swapped = true;
            }
            Ok(())
        },
    );

    let quarantine = quarantine.expect("cleanup reached the substitution boundary");
    let journal = journal.expect("capture the retained transaction journal");
    let journal_before_recovery = journal.exists();
    let recovery = deletion.recover_pending_transactions();
    let journal_after_recovery = journal.exists();
    let original_survives = parked_original.join("profile-canary").exists();
    let replacement_survives = quarantine.join("profile-canary").exists();

    assert!(
        matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ),
        "cleanup must stop instead of reporting success after the root namespace changes; \
         commit={commit:?}, recovery={recovery:?}, original_survives={original_survives}, \
         replacement_survives={replacement_survives}, \
         journal_before_recovery={journal_before_recovery}, \
         journal_after_recovery={journal_after_recovery}"
    );
    assert_eq!(
        bytes(&parked_original.join("profile-canary")),
        b"original-quarantined-profile"
    );
    assert_eq!(
        bytes(&quarantine.join("profile-canary")),
        b"replacement-fixture-must-survive"
    );
    assert!(journal_before_recovery);
    assert!(
        matches!(
            recovery,
            Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
        ),
        "startup recovery must retain uncertain transaction state"
    );
    assert!(journal_after_recovery);
    assert_eq!(
        fixture.registry.list().expect("read committed registry"),
        Vec::<Account>::new()
    );
    assert!(!target.exists());
}

#[test]
fn cleanup_file_identity_substitution_survives_startup_recovery() {
    assert_cleanup_descendant_identity_substitution_survives_startup_recovery("file");
}

#[test]
fn cleanup_directory_identity_substitution_survives_startup_recovery() {
    assert_cleanup_descendant_identity_substitution_survives_startup_recovery("directory");
}

fn assert_cleanup_descendant_identity_substitution_survives_startup_recovery(case: &str) {
    let fixture = Fixture::new(&format!("cleanup-descendant-substitution-{case}"));
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let original_entry = target.join("selected-entry");
    let replacement_fixture = fixture.root.join("replacement-entry-fixture");
    if case == "file" {
        fs::write(&original_entry, b"original-descendant").expect("write original descendant");
        fs::write(&replacement_fixture, b"replacement-descendant")
            .expect("write replacement descendant");
    } else {
        fs::create_dir(&original_entry).expect("create original descendant directory");
        fs::create_dir(&replacement_fixture).expect("create replacement descendant directory");
    }
    let parked_original = fixture.root.join("retained-original-entry");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare descendant substitution test");
    let mut swapped = false;
    let mut quarantine_entry = None;
    let mut journal = None;

    let commit = deletion.commit_remove_account_at_with_observer(
        &plan.plan_id,
        &account.label,
        &HashSet::new(),
        2_000,
        |point, observation| {
            if point == TransactionFaultPoint::BeforeCleanupEntry
                && observation.cleanup_entry.as_ref().is_some_and(|entry| {
                    entry
                        .file_name()
                        .is_some_and(|name| name == "selected-entry")
                })
                && !swapped
            {
                let entry = observation
                    .cleanup_entry
                    .as_ref()
                    .expect("cleanup entry is observed");
                fs::rename(entry, &parked_original).expect("park the enumerated descendant");
                fs::rename(&replacement_fixture, entry)
                    .expect("substitute the descendant namespace");
                quarantine_entry = Some(entry.clone());
                journal = Some(observation.journal.clone());
                swapped = true;
            }
            Ok(())
        },
    );

    let quarantine_entry = quarantine_entry.expect("selected descendant reached cleanup");
    let journal = journal.expect("capture the retained transaction journal");
    assert!(
        matches!(
            commit,
            Err(ref error) if error.code == DeletionErrorCode::CleanupPending
        ),
        "cleanup must stop on a changed {case} identity; commit={commit:?}, \
             original_exists={}, replacement_exists={}, journal_exists={}",
        parked_original.exists(),
        quarantine_entry.exists(),
        journal.exists()
    );
    assert!(parked_original.exists(), "original {case} survives");
    assert!(quarantine_entry.exists(), "replacement {case} survives");
    if case == "file" {
        assert_eq!(bytes(&parked_original), b"original-descendant");
        assert_eq!(bytes(&quarantine_entry), b"replacement-descendant");
    } else {
        assert!(fs::metadata(&parked_original)
            .expect("inspect parked directory")
            .is_dir());
        assert!(fs::metadata(&quarantine_entry)
            .expect("inspect replacement directory")
            .is_dir());
    }
    assert!(journal.exists());
    assert_eq!(
        fixture.registry.list().expect("read committed registry"),
        Vec::<Account>::new()
    );
    assert!(!target.exists());

    let recovery = deletion.recover_pending_transactions();
    assert!(
        matches!(
            recovery,
            Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
        ),
        "startup recovery must not adopt a replacement {case} as transaction-owned; \
             recovery={recovery:?}, original_exists={}, replacement_exists={}, journal_exists={}",
        parked_original.exists(),
        quarantine_entry.exists(),
        journal.exists()
    );
    assert!(
        parked_original.exists(),
        "original {case} survives recovery"
    );
    assert!(
        quarantine_entry.exists(),
        "replacement {case} survives recovery"
    );
    if case == "file" {
        assert_eq!(bytes(&parked_original), b"original-descendant");
        assert_eq!(bytes(&quarantine_entry), b"replacement-descendant");
    }
    assert!(
        journal.exists(),
        "uncertain {case} cleanup retains its journal"
    );

    let second_recovery = deletion.recover_pending_transactions();
    assert!(
        matches!(
            second_recovery,
            Err(ref error) if error.code == DeletionErrorCode::OutcomeUnknown
        ),
        "every retry remains bound to the original {case} identity; \
             recovery={second_recovery:?}"
    );
    assert!(parked_original.exists());
    assert!(quarantine_entry.exists());
    assert!(journal.exists());
}

#[test]
fn pending_cleanup_is_recovered_before_later_mutations_and_transactions() {
    for case in ["add", "rename", "remove", "second-transaction"] {
        let fixture = Fixture::new(&format!("cleanup-before-{case}"));
        let old = fixture.account("claude-old", "Claude Old");
        let other = fixture.account("claude-other", "Claude Other");
        let survivor = fixture.account("claude-survivor", "Claude Survivor");
        fixture.write_accounts(&[old.clone(), other.clone(), survivor.clone()]);
        let old_target = fixture.profiles.join(&old.id);
        fs::create_dir(&old_target).expect("create old disposable profile");
        fs::write(old_target.join("old-canary"), b"old-profile").expect("write old profile canary");
        let other_target = fixture.profiles.join(&other.id);
        fs::create_dir(&other_target).expect("create second disposable profile");
        fs::write(other_target.join("other-canary"), b"other-profile")
            .expect("write second profile canary");
        let outside = fixture.root.join("outside-canary");
        fs::write(&outside, b"outside-cleanup-lineage").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let old_plan = deletion
            .prepare_remove_account_at(&old.id, true, &HashSet::new(), 1_000)
            .expect("prepare old transaction");
        let mut old_quarantine = None;

        let old_error = deletion
            .commit_remove_account_at_with_observer(
                &old_plan.plan_id,
                &old.label,
                &HashSet::new(),
                2_000,
                |point, observation| {
                    if point == TransactionFaultPoint::AfterCommittedJournalFlushed {
                        old_quarantine = Some(observation.quarantine.clone());
                        Err(())
                    } else {
                        Ok(())
                    }
                },
            )
            .expect_err("leave a committed cleanup journal");
        assert_eq!(
            old_error.code,
            DeletionErrorCode::CleanupPending,
            "case {case}"
        );
        let old_quarantine = old_quarantine.expect("capture old quarantine");
        assert_eq!(
            bytes(&old_quarantine.join("old-canary")),
            b"old-profile",
            "case {case}"
        );

        match case {
            "add" => {
                fixture
                    .registry
                    .add("Added Later".to_owned(), "anthropic".to_owned(), 3_000)
                    .expect("add recovers pending cleanup before mutation");
            }
            "rename" => fixture
                .registry
                .rename(&other.id, "Renamed Later".to_owned())
                .expect("rename recovers pending cleanup before mutation"),
            "remove" => {
                let removed = fixture
                    .registry
                    .remove_entry(&other.id)
                    .expect("entry removal recovers pending cleanup before mutation");
                assert_eq!(removed.id, other.id);
            }
            "second-transaction" => {
                let second_plan = deletion
                    .prepare_remove_account_at(&other.id, true, &HashSet::new(), 3_000)
                    .expect("prepare second transaction while cleanup is pending");
                deletion
                    .commit_remove_account_at(
                        &second_plan.plan_id,
                        &other.label,
                        &HashSet::new(),
                        4_000,
                    )
                    .expect("second transaction recovers the first before committing");
                assert!(!other_target.exists());
            }
            _ => unreachable!(),
        }

        assert!(
            !old_quarantine.exists(),
            "old committed cleanup was finalized before {case}"
        );
        assert_eq!(bytes(&outside), b"outside-cleanup-lineage", "case {case}");
        let first_restart = deletion
            .recover_pending_transactions()
            .expect("first restart is deterministic after later mutation");
        assert_eq!(
            (
                first_restart.restored,
                first_restart.finalized,
                first_restart.pending
            ),
            (0, 0, 0),
            "case {case}"
        );
        let second_restart = deletion
            .recover_pending_transactions()
            .expect("second restart is idempotent");
        assert_eq!(
            (
                second_restart.restored,
                second_restart.finalized,
                second_restart.pending
            ),
            (0, 0, 0),
            "case {case}"
        );
        assert!(artifact_bytes(&fixture.profiles).is_empty(), "case {case}");
    }
}

#[test]
fn recovery_never_guesses_commit_from_account_absence_when_generation_is_ambiguous() {
    let fixture = Fixture::new("ambiguous-registry-recovery");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let target = fixture.profiles.join(&removed.id);
    fs::create_dir_all(&target).expect("create disposable profile");
    fs::write(target.join("auth.json"), b"DISPOSABLE-AMBIGUOUS-CANARY")
        .expect("write profile canary");
    let outside = fixture.root.join("outside-canary.txt");
    fs::write(&outside, b"outside-ambiguous-canary").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&removed.id, true, &HashSet::new(), 1_000)
        .expect("prepare ambiguous recovery test");
    let mut quarantine = None;
    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &removed.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterQuarantineRenamed {
                    quarantine = Some(observation.quarantine.clone());
                    Err(())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("stop after profile quarantine");
    assert_eq!(error.code, DeletionErrorCode::RecoveryRequired);
    let quarantine = quarantine.expect("capture quarantine path");
    let unrelated_registry = serde_json::to_vec_pretty(&Vec::<Account>::new())
        .expect("serialize unrelated registry mutation");
    fs::write(fixture.registry.registry_path(), &unrelated_registry)
        .expect("simulate external ambiguous registry mutation");

    let recovery_error = deletion
        .recover_pending_transactions()
        .expect_err("ambiguous generation must not be inferred from account absence");

    assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(bytes(&fixture.registry.registry_path()), unrelated_registry);
    assert_eq!(
        bytes(&quarantine.join("auth.json")),
        b"DISPOSABLE-AMBIGUOUS-CANARY"
    );
    assert!(!target.exists());
    assert_eq!(bytes(&outside), b"outside-ambiguous-canary");
    assert!(!artifact_bytes(&fixture.profiles).is_empty());
}

#[test]
fn cleanup_unlinks_a_late_reparse_without_traversing_its_outside_target() {
    let fixture = Fixture::new("cleanup-late-reparse");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(target.join("sessions")).expect("create disposable profile");
    fs::write(target.join("auth.json"), b"DISPOSABLE-REPARSE-CLEANUP")
        .expect("write profile canary");
    let outside = fixture.root.join("outside-reparse-target");
    fs::create_dir(&outside).expect("create outside directory");
    let outside_canary = outside.join("outside-canary.txt");
    fs::write(&outside_canary, b"outside-reparse-survives").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare late reparse cleanup test");
    let mut inserted = false;

    deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterCommittedJournalFlushed && !inserted {
                    create_directory_symlink(&outside, &observation.quarantine.join("late-link"));
                    inserted = true;
                }
                Ok(())
            },
        )
        .expect("cleanup unlinks the reparse itself without following it");

    assert!(inserted);
    assert_eq!(bytes(&outside_canary), b"outside-reparse-survives");
    assert!(!target.exists());
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn commit_requires_the_exact_prepared_label_and_consumes_a_mismatch() {
    let fixture = Fixture::new("label-mismatch");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("canary"), b"label-mismatch-profile").expect("write profile canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare label mismatch test");

    let error = deletion
        .commit_remove_account_at(&plan.plan_id, "claude work", &HashSet::new(), 2_000)
        .expect_err("case-changed typed label must not authorize deletion");

    assert_eq!(error.code, DeletionErrorCode::LabelMismatch);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&target.join("canary")), b"label-mismatch-profile");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
    let replay = deletion
        .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_001)
        .expect_err("a rejected label plan remains single-use");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn commit_revalidates_an_active_session_that_started_after_prepare() {
    let fixture = Fixture::new("active-after-prepare");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("canary"), b"active-profile").expect("write profile canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare while inactive");

    let error = deletion
        .commit_remove_account_at(
            &plan.plan_id,
            &account.label,
            &HashSet::from([account.id.clone()]),
            2_000,
        )
        .expect_err("newly active account must block commit");

    assert_eq!(error.code, DeletionErrorCode::PlanBlocked);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&target.join("canary")), b"active-profile");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn commit_rejects_shared_default_and_account_presence_registry_races() {
    for case in ["shared", "default", "missing"] {
        let fixture = Fixture::new(&format!("registry-race-{case}"));
        let account = fixture.account("claude-work", "Claude Work");
        let retained = fixture.account("claude-home", "Claude Home");
        fixture.write_accounts(&[account.clone(), retained.clone()]);
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create disposable profile");
        fs::write(target.join("canary"), b"registry-race-profile").expect("write profile canary");
        let outside = fixture.root.join("outside-canary.txt");
        fs::write(&outside, b"outside-registry-race").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare before registry race");

        match case {
            "shared" => {
                let mut other = retained;
                other.agent_dir = account.agent_dir.clone();
                fixture.write_accounts(&[account.clone(), other]);
            }
            "default" => {
                let mut changed = account.clone();
                changed.agent_dir = fixture
                    .registry
                    .default_agent_dir()
                    .to_string_lossy()
                    .into_owned();
                fixture.write_accounts(&[changed, retained]);
            }
            "missing" => fixture.write_accounts(std::slice::from_ref(&retained)),
            _ => unreachable!(),
        }
        let raced_registry = bytes(&fixture.registry.registry_path());

        let error = deletion
            .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_000)
            .expect_err("registry race must invalidate the prepared plan");

        assert_eq!(
            error.code,
            DeletionErrorCode::RegistryChanged,
            "case {case}"
        );
        assert_eq!(
            bytes(&fixture.registry.registry_path()),
            raced_registry,
            "case {case}"
        );
        assert_eq!(
            bytes(&target.join("canary")),
            b"registry-race-profile",
            "case {case}"
        );
        assert_eq!(bytes(&outside), b"outside-registry-race", "case {case}");
        assert!(
            transaction_artifacts(&fixture.profiles).is_empty(),
            "case {case}"
        );
    }
}

#[test]
fn commit_rejects_identity_leaf_reparse_and_subtree_reparse_swaps() {
    for case in ["identity", "leaf-reparse", "subtree-reparse"] {
        let fixture = Fixture::new(&format!("commit-target-race-{case}"));
        let account = fixture.account("claude-work", "Claude Work");
        fixture.write_accounts(std::slice::from_ref(&account));
        let registry_before = bytes(&fixture.registry.registry_path());
        let target = fixture.profiles.join(&account.id);
        fs::create_dir(&target).expect("create original disposable profile");
        fs::write(target.join("original-canary"), b"original-profile")
            .expect("write original canary");
        let outside = fixture.root.join("outside-target-race");
        fs::create_dir(&outside).expect("create outside target");
        let outside_canary = outside.join("outside-canary");
        fs::write(&outside_canary, b"outside-target-race").expect("write outside canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare before target race");

        match case {
            "identity" => {
                fs::rename(&target, fixture.profiles.join("parked-original"))
                    .expect("park original profile");
                fs::create_dir(&target).expect("create replacement profile");
                fs::write(target.join("replacement-canary"), b"replacement-profile")
                    .expect("write replacement canary");
            }
            "leaf-reparse" => {
                fs::rename(&target, fixture.profiles.join("parked-original"))
                    .expect("park original profile");
                create_directory_symlink(&outside, &target);
            }
            "subtree-reparse" => create_directory_symlink(&outside, &target.join("late-link")),
            _ => unreachable!(),
        }

        let error = deletion
            .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_000)
            .expect_err("target race must invalidate commit");

        let expected = if case == "identity" {
            DeletionErrorCode::TargetChanged
        } else {
            DeletionErrorCode::UnsafeTarget
        };
        assert_eq!(error.code, expected, "case {case}");
        assert_eq!(
            bytes(&fixture.registry.registry_path()),
            registry_before,
            "case {case}"
        );
        assert_eq!(
            bytes(&outside_canary),
            b"outside-target-race",
            "case {case}"
        );
        assert!(
            transaction_artifacts(&fixture.profiles).is_empty(),
            "case {case}"
        );
    }
}

#[test]
fn quarantine_collision_after_journal_creation_never_moves_the_profile() {
    let fixture = Fixture::new("quarantine-collision");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("profile-canary"), b"owned-profile").expect("write profile canary");
    let outside = fixture.root.join("outside-canary");
    fs::write(&outside, b"outside-quarantine-collision").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare quarantine collision test");
    let mut collision = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterJournalPrepared && collision.is_none() {
                    fs::create_dir(&observation.quarantine).expect("create quarantine collision");
                    fs::write(
                        observation.quarantine.join("collision-canary"),
                        b"collision",
                    )
                    .expect("write collision canary");
                    collision = Some(observation.quarantine.clone());
                }
                Ok(())
            },
        )
        .expect_err("a quarantine collision must fail closed");

    assert_eq!(error.code, DeletionErrorCode::QuarantineConflict);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(&target.join("profile-canary")), b"owned-profile");
    assert_eq!(bytes(&outside), b"outside-quarantine-collision");
    let collision = collision.expect("captured collision path");
    assert_eq!(bytes(&collision.join("collision-canary")), b"collision");
    assert!(artifact_bytes(&fixture.profiles).is_empty());
}

#[test]
fn quarantine_identity_substitution_retains_original_data_and_an_outcome_unknown_journal() {
    let fixture = Fixture::new("quarantine-substitution");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("original-canary"), b"original-profile").expect("write original canary");
    let parked = fixture.root.join("parked-original-quarantine");
    let outside = fixture.root.join("outside-canary");
    fs::write(&outside, b"outside-quarantine-substitution").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare quarantine substitution test");
    let mut substituted = None;

    let error = deletion
        .commit_remove_account_at_with_observer(
            &plan.plan_id,
            &account.label,
            &HashSet::new(),
            2_000,
            |point, observation| {
                if point == TransactionFaultPoint::AfterQuarantineRenamed && substituted.is_none() {
                    fs::rename(&observation.quarantine, &parked).expect("park original quarantine");
                    fs::create_dir(&observation.quarantine).expect("create substituted quarantine");
                    fs::write(
                        observation.quarantine.join("replacement-canary"),
                        b"replacement",
                    )
                    .expect("write replacement quarantine canary");
                    substituted = Some(observation.quarantine.clone());
                }
                Ok(())
            },
        )
        .expect_err("substituted quarantine identity must never commit");

    assert_eq!(error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert!(!target.exists());
    assert_eq!(bytes(&parked.join("original-canary")), b"original-profile");
    let substituted = substituted.expect("captured substituted quarantine");
    assert_eq!(
        bytes(&substituted.join("replacement-canary")),
        b"replacement"
    );
    assert_eq!(bytes(&outside), b"outside-quarantine-substitution");
    let recovery_error = deletion
        .recover_pending_transactions()
        .expect_err("substituted quarantine remains outcome-unknown");
    assert_eq!(recovery_error.code, DeletionErrorCode::OutcomeUnknown);
    assert_eq!(bytes(&parked.join("original-canary")), b"original-profile");
    assert_eq!(
        bytes(&substituted.join("replacement-canary")),
        b"replacement"
    );
}

#[test]
fn concurrent_commit_waits_for_the_transaction_lock_then_observes_plan_replay() {
    use std::sync::mpsc;
    use std::time::Duration;

    let fixture = Fixture::new("concurrent-commit");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("canary"), b"concurrent-profile").expect("write profile canary");
    let deletion = Arc::new(AccountDeletion::with_ttl(fixture.registry.clone(), 30_000));
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare concurrent commit test");
    let (at_journal_tx, at_journal_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let first_deletion = deletion.clone();
    let first_plan = plan.plan_id.clone();
    let first_label = account.label.clone();
    let first = std::thread::spawn(move || {
        first_deletion.commit_remove_account_at_with_observer(
            &first_plan,
            &first_label,
            &HashSet::new(),
            2_000,
            |point, _observation| {
                if point == TransactionFaultPoint::AfterJournalPrepared {
                    at_journal_tx.send(()).expect("signal durable journal");
                    resume_rx
                        .recv_timeout(Duration::from_secs(5))
                        .expect("resume first commit");
                    Err(())
                } else {
                    Ok(())
                }
            },
        )
    });
    at_journal_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first commit reached durable journal");
    let second_deletion = deletion.clone();
    let second_plan = plan.plan_id.clone();
    let second_label = account.label.clone();
    let second = std::thread::spawn(move || {
        second_deletion.commit_remove_account_at(
            &second_plan,
            &second_label,
            &HashSet::new(),
            2_001,
        )
    });
    resume_tx.send(()).expect("release first commit");

    let first_error = first
        .join()
        .expect("first commit thread")
        .expect_err("first commit receives injected interruption");
    let second_error = second
        .join()
        .expect("second commit thread")
        .expect_err("second commit must observe replay");
    assert_eq!(first_error.code, DeletionErrorCode::RecoveryRequired);
    assert_eq!(second_error.code, DeletionErrorCode::PlanReplayed);
    let recovered = deletion
        .recover_pending_transactions()
        .expect("recover interrupted first transaction");
    assert_eq!(
        (recovered.restored, recovered.finalized, recovered.pending),
        (1, 0, 0)
    );
    assert_eq!(bytes(&target.join("canary")), b"concurrent-profile");
}

#[test]
fn entry_only_commit_never_requires_a_typed_label_or_touches_profile_data() {
    let fixture = Fixture::new("entry-only-commit");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    let profile_canary = target.join("auth.json");
    fs::write(&profile_canary, b"ENTRY-ONLY-PROFILE-SURVIVES").expect("write profile canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, false, &HashSet::new(), 1_000)
        .expect("prepare entry-only removal");

    deletion
        .commit_remove_account_at(&plan.plan_id, "", &HashSet::new(), 2_000)
        .expect("entry-only commit does not require destructive confirmation text");

    assert_eq!(
        fixture.registry.list().expect("read entry-only registry"),
        Vec::<Account>::new()
    );
    assert_eq!(bytes(&profile_canary), b"ENTRY-ONLY-PROFILE-SURVIVES");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}

#[test]
fn registry_reparse_substitution_after_prepare_is_rejected_before_profile_movement() {
    let fixture = Fixture::new("registry-reparse-substitution");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_path = fixture.registry.registry_path();
    let registry_before = bytes(&registry_path);
    let target = fixture.profiles.join(&account.id);
    fs::create_dir(&target).expect("create disposable profile");
    fs::write(target.join("profile-canary"), b"registry-reparse-profile")
        .expect("write profile canary");
    let outside_registry = fixture.root.join("outside-registry.json");
    fs::write(&outside_registry, &registry_before).expect("write outside registry canary");
    let outside_data = fixture.root.join("outside-data-canary");
    fs::write(&outside_data, b"outside-registry-reparse").expect("write outside data canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare before registry reparse substitution");
    let parked_registry = fixture.profiles.join("parked-accounts.json");
    fs::rename(&registry_path, &parked_registry).expect("park original registry file");
    std::os::windows::fs::symlink_file(&outside_registry, &registry_path)
        .expect("create registry file reparse substitution");

    let error = deletion
        .commit_remove_account_at(&plan.plan_id, &account.label, &HashSet::new(), 2_000)
        .expect_err("registry reparse substitution must fail before transaction movement");

    assert!(
        matches!(
            error.code,
            DeletionErrorCode::UnsafeTarget | DeletionErrorCode::TargetChanged
        ),
        "unexpected registry substitution code: {:?}",
        error.code
    );
    assert_eq!(bytes(&outside_registry), registry_before);
    assert_eq!(bytes(&parked_registry), registry_before);
    assert_eq!(
        bytes(&target.join("profile-canary")),
        b"registry-reparse-profile"
    );
    assert_eq!(bytes(&outside_data), b"outside-registry-reparse");
    assert!(transaction_artifacts(&fixture.profiles).is_empty());
}
