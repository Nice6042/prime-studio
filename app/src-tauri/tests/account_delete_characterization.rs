use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use prime_studio_lib::accounts::delete::{
    derive_deletion_target, AccountDeletion, DeletionErrorCode, RemovalBlocker, RemovalPlan,
    MAX_ESTIMATE_ITEMS,
};
use prime_studio_lib::accounts::{Account, AccountRegistry};

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
            "prime-studio-account-delete-{name}-{}-{nonce}",
            std::process::id()
        ));
        let profiles = root.join(".prime").join("profiles");
        fs::create_dir_all(&profiles).expect("create profiles fixture");
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
        let body = serde_json::to_vec_pretty(accounts).expect("serialize fixture registry");
        fs::write(self.registry.registry_path(), body).expect("write fixture registry");
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

fn assert_all_deletion_phases_reject_registry_bytes(
    case: &str,
    invalid_registry: impl Fn(&Account) -> Vec<u8>,
) {
    let prepare_fixture = Fixture::new(&format!("{case}-prepare"));
    let prepare_account = prepare_fixture.account("claude-work", "Claude Work");
    let prepare_bytes = invalid_registry(&prepare_account);
    fs::write(prepare_fixture.registry.registry_path(), &prepare_bytes)
        .expect("write invalid prepare registry");
    let prepare_deletion = AccountDeletion::with_ttl(prepare_fixture.registry.clone(), 30_000);

    let prepare_error = prepare_deletion
        .prepare_remove_account_at(&prepare_account.id, false, &HashSet::new(), 1_000)
        .expect_err("prepare must reject a registry the normal parser rejects");

    assert_eq!(prepare_error.code, DeletionErrorCode::RegistryInvalid);
    assert_eq!(
        bytes(&prepare_fixture.registry.registry_path()),
        prepare_bytes
    );

    let claim_fixture = Fixture::new(&format!("{case}-claim"));
    let claim_account = claim_fixture.account("claude-work", "Claude Work");
    claim_fixture.write_accounts(std::slice::from_ref(&claim_account));
    let claim_deletion = AccountDeletion::with_ttl(claim_fixture.registry.clone(), 30_000);
    let claim_plan = claim_deletion
        .prepare_remove_account_at(&claim_account.id, false, &HashSet::new(), 1_000)
        .expect("prepare valid claim plan");
    let claim_bytes = invalid_registry(&claim_account);
    fs::write(claim_fixture.registry.registry_path(), &claim_bytes)
        .expect("write invalid claim registry");

    let claim_error = claim_deletion
        .claim_plan_at(&claim_plan.plan_id, 2_000)
        .expect_err("claim must reject a registry the normal parser rejects");

    assert_eq!(claim_error.code, DeletionErrorCode::RegistryInvalid);
    assert_eq!(bytes(&claim_fixture.registry.registry_path()), claim_bytes);

    let commit_fixture = Fixture::new(&format!("{case}-commit"));
    let commit_account = commit_fixture.account("claude-work", "Claude Work");
    commit_fixture.write_accounts(std::slice::from_ref(&commit_account));
    let commit_deletion = AccountDeletion::with_ttl(commit_fixture.registry.clone(), 30_000);
    let commit_plan = commit_deletion
        .prepare_remove_account_at(&commit_account.id, false, &HashSet::new(), 1_000)
        .expect("prepare valid commit plan");
    let commit_bytes = invalid_registry(&commit_account);
    fs::write(commit_fixture.registry.registry_path(), &commit_bytes)
        .expect("write invalid commit registry");

    let commit_error = commit_deletion
        .commit_remove_account_at(&commit_plan.plan_id, "", &HashSet::new(), 2_000)
        .expect_err("commit must reject a registry the normal parser rejects");

    assert_eq!(commit_error.code, DeletionErrorCode::RegistryInvalid);
    assert_eq!(
        bytes(&commit_fixture.registry.registry_path()),
        commit_bytes
    );
}

fn assert_blocked_plan_is_consumed(
    fixture: &Fixture,
    deletion: &AccountDeletion,
    plan: &RemovalPlan,
    expected_blocker: RemovalBlocker,
    canary: &Path,
) {
    assert!(plan.delete_data);
    assert!(plan.blockers.contains(&expected_blocker));
    let registry_before = bytes(&fixture.registry.registry_path());
    let canary_before = bytes(canary);

    let error = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("a blocked data-deletion plan must not authorize a commit");

    assert_eq!(error.code, DeletionErrorCode::PlanBlocked);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(bytes(canary), canary_before);
    let replay = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("a rejected blocked plan is still single-use");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn add_rejects_control_and_bidirectional_labels_before_creating_registry_state() {
    let invalid = [
        ("line-feed", "Claude\nwork"),
        ("carriage-return", "Claude\rwork"),
        ("tab", "Claude\twork"),
        ("line-separator", "Claude\u{2028}work"),
        ("right-to-left-override", "invoice\u{202e}cod.exe"),
        ("left-to-right-isolate", "Claude\u{2066}work\u{2069}"),
        ("arabic-letter-mark", "Claude\u{061c}work"),
        ("zero-width-joiner", "Claude\u{200d}work"),
        ("zero-width-space", "Claude\u{200b}work"),
    ];

    for (case, label) in invalid {
        let fixture = Fixture::new(&format!("reject-add-label-{case}"));
        let error = fixture
            .registry
            .add(label.to_owned(), "anthropic".to_owned(), 1)
            .expect_err("unsafe labels must be rejected before profile creation");

        assert!(error.contains("control or bidirectional"));
        assert!(
            !error.contains(label),
            "the rejected label is not reflected"
        );
        assert!(!fixture.registry.registry_path().exists());
        assert_eq!(
            fs::read_dir(&fixture.profiles)
                .expect("read empty profiles fixture")
                .count(),
            0
        );
    }

    let fixture = Fixture::new("accept-normal-unicode-label");
    let account = fixture
        .registry
        .add(
            "  Claude 👩\u{200d}💻 work  ".to_owned(),
            "anthropic".to_owned(),
            1,
        )
        .expect("ordinary Unicode and emoji joiners remain valid");
    assert_eq!(account.label, "Claude 👩\u{200d}💻 work");
}

#[test]
fn add_at_exact_capacity_rejects_repeated_unique_ids_without_any_mutation() {
    let fixture = Fixture::new("add-at-exact-capacity");
    let accounts = (0..256)
        .map(|index| fixture.account(&format!("account-{index}"), &format!("Account {index}")))
        .collect::<Vec<_>>();
    fixture.write_accounts(&accounts);

    let registry_before = bytes(&fixture.registry.registry_path());
    let entries = || {
        let mut entries = fs::read_dir(&fixture.profiles)
            .expect("read profiles fixture")
            .map(|entry| {
                let entry = entry.expect("read profiles entry");
                (
                    entry.file_name(),
                    entry
                        .file_type()
                        .expect("read profiles entry type")
                        .is_dir(),
                )
            })
            .collect::<Vec<_>>();
        entries.sort();
        entries
    };
    let entries_before = entries();

    for label in ["Overflow Alpha", "Overflow Beta", "Overflow Gamma"] {
        let error = fixture
            .registry
            .add(label.to_owned(), "anthropic".to_owned(), 2)
            .expect_err("an account at exact capacity must be rejected");
        assert!(error.contains("account limit"));
    }

    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(entries(), entries_before);
    for orphan in ["overflow-alpha", "overflow-beta", "overflow-gamma"] {
        assert!(
            !fixture.profiles.join(orphan).exists(),
            "a rejected unique account ID must not leave an orphan profile"
        );
    }
}

#[test]
fn rename_rejects_control_and_bidirectional_labels_without_rewriting_the_registry() {
    let fixture = Fixture::new("reject-rename-label");
    let account = fixture.account("claude-work", "Claude work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let before = bytes(&fixture.registry.registry_path());

    for label in [
        "Claude\nwork",
        "Claude\u{2029}work",
        "invoice\u{202e}cod.exe",
        "Claude\u{200f}work",
    ] {
        let error = fixture
            .registry
            .rename(&account.id, label.to_owned())
            .expect_err("unsafe rename must be rejected");
        assert!(error.contains("control or bidirectional"));
        assert_eq!(bytes(&fixture.registry.registry_path()), before);
    }

    fixture
        .registry
        .rename(&account.id, "Claude home".to_owned())
        .expect("ordinary rename remains compatible");
    assert_eq!(
        fixture
            .registry
            .find(&account.id)
            .expect("renamed account")
            .label,
        "Claude home"
    );
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link).expect("create directory reparse fixture");
}

#[cfg(windows)]
fn short_path_if_available(path: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let required = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if required == 0 {
        return None;
    }
    let mut short = vec![0; required as usize];
    let written =
        unsafe { GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
    if written == 0 || written as usize >= short.len() {
        return None;
    }
    short.truncate(written as usize);
    let short = PathBuf::from(OsString::from_wide(&short));
    (short != path).then_some(short)
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create directory symlink fixture");
}

#[test]
fn entry_only_removal_atomically_replaces_registry_without_touching_profile_data() {
    let fixture = Fixture::new("entry-only");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained.clone()]);

    let profile = fixture.profiles.join(&removed.id);
    let canary = profile.join("sessions").join("canary.jsonl");
    fs::create_dir_all(canary.parent().expect("canary parent")).expect("create profile");
    fs::write(&canary, b"outside-registry-canary").expect("write canary");
    let before = bytes(&canary);

    fixture
        .registry
        .remove_entry(&removed.id)
        .expect("entry-only removal succeeds");

    assert_eq!(
        fixture.registry.list().expect("read replacement registry"),
        vec![retained]
    );
    assert!(
        profile.is_dir(),
        "entry-only removal must retain the profile directory"
    );
    assert_eq!(
        bytes(&canary),
        before,
        "entry-only removal must not alter profile bytes"
    );
}

#[test]
fn entry_only_removal_replaces_instead_of_rewriting_the_open_registry_file() {
    let fixture = Fixture::new("atomic-replace");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let registry_path = fixture.registry.registry_path();
    let before = bytes(&registry_path);

    let mut old_file = fs::File::open(&registry_path).expect("hold old registry object open");
    fixture
        .registry
        .remove_entry(&removed.id)
        .expect("replace registry");

    old_file
        .seek(SeekFrom::Start(0))
        .expect("rewind old registry handle");
    let mut held_bytes = Vec::new();
    old_file
        .read_to_end(&mut held_bytes)
        .expect("read old registry object");
    assert_eq!(
        held_bytes, before,
        "an atomic replacement leaves already-open handles attached to the old bytes"
    );
    assert_ne!(
        bytes(&registry_path),
        before,
        "the registry path must name the replacement bytes"
    );
}

#[test]
fn prepare_returns_an_expiring_opaque_plan_for_the_exact_derived_profile() {
    let fixture = Fixture::new("prepare-owned");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(target.join("sessions")).expect("create owned profile");
    fs::write(target.join("auth.json"), b"1234567").expect("write first estimate file");
    fs::write(target.join("sessions").join("one.jsonl"), b"12345")
        .expect("write second estimate file");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare owned profile deletion");

    assert_eq!(plan.account_label, account.label);
    assert_eq!(plan.target_path, target.to_string_lossy());
    assert_eq!(plan.expires_at_ms, 31_000);
    assert_eq!(
        plan.plan_id.len(),
        32,
        "UUID v4 is returned without formatting metadata"
    );
    assert!(!plan.plan_id.contains(&account.id));
    assert!(!plan.plan_id.contains("Claude"));
    assert_eq!(
        plan.registry_generation.len(),
        64,
        "SHA-256 registry generation"
    );
    assert!(
        plan.target_identity.is_some(),
        "an existing directory has a stable file identity"
    );
    assert_eq!(
        plan.estimate.items, 4,
        "profile, sessions directory, and two files"
    );
    assert_eq!(plan.estimate.bytes, 12);
    assert!(!plan.estimate.truncated);
    assert!(plan.checks.data_deletion_allowed);
    assert!(plan.blockers.is_empty());
}

#[test]
fn every_deletion_phase_rejects_duplicate_account_ids() {
    assert_all_deletion_phases_reject_registry_bytes("duplicate-registry", |account| {
        serde_json::to_vec_pretty(&[account, account]).expect("serialize duplicate registry")
    });
}

#[test]
fn every_deletion_phase_rejects_a_registry_over_the_byte_ceiling() {
    const MAX_ACCOUNT_REGISTRY_BYTES: usize = 4 * 1024 * 1024;

    assert_all_deletion_phases_reject_registry_bytes("oversized-registry", |account| {
        let mut registry =
            serde_json::to_vec_pretty(std::slice::from_ref(account)).expect("serialize registry");
        registry.resize(MAX_ACCOUNT_REGISTRY_BYTES + 1, b' ');
        registry
    });
}

#[test]
fn a_known_plan_is_consumed_when_claim_rejects_an_invalid_registry() {
    let fixture = Fixture::new("invalid-registry-consumes-claim");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let valid_registry = bytes(&fixture.registry.registry_path());
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, false, &HashSet::new(), 1_000)
        .expect("prepare valid claim plan");
    let duplicate_registry =
        serde_json::to_vec_pretty(&[&account, &account]).expect("serialize duplicate registry");
    fs::write(fixture.registry.registry_path(), &duplicate_registry)
        .expect("write duplicate registry");

    let invalid = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("invalid registry must reject the known plan");
    assert_eq!(invalid.code, DeletionErrorCode::RegistryInvalid);

    fs::write(fixture.registry.registry_path(), valid_registry).expect("restore valid registry");
    let replay = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("restoring registry bytes must not restore consumed authority");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn a_missing_registry_remains_an_io_error_and_consumes_a_known_claim() {
    let fixture = Fixture::new("missing-registry-consumes-claim");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let valid_registry = bytes(&fixture.registry.registry_path());
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, false, &HashSet::new(), 1_000)
        .expect("prepare valid claim plan");
    fs::remove_file(fixture.registry.registry_path()).expect("remove registry");

    let missing = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("missing registry must reject the known plan");
    assert_eq!(missing.code, DeletionErrorCode::Io);

    fs::write(fixture.registry.registry_path(), valid_registry).expect("restore valid registry");
    let replay = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("restoring registry bytes must not restore consumed authority");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn claiming_a_missing_plan_returns_a_typed_error_without_mutation() {
    let fixture = Fixture::new("missing-plan");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let registry_before = bytes(&fixture.registry.registry_path());
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let error = deletion
        .claim_plan_at("not-a-real-plan", 1_000)
        .expect_err("missing plan fails");

    assert_eq!(error.code, DeletionErrorCode::PlanNotFound);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
}

#[test]
fn claiming_an_expired_plan_returns_a_typed_error_without_mutation() {
    let fixture = Fixture::new("expired-plan");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare plan");
    let registry_before = bytes(&fixture.registry.registry_path());

    let error = deletion
        .claim_plan_at(&plan.plan_id, 31_001)
        .expect_err("expired plan fails");

    assert_eq!(error.code, DeletionErrorCode::PlanExpired);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
}

#[test]
fn claiming_a_plan_twice_rejects_the_replay() {
    let fixture = Fixture::new("replayed-plan");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare plan");

    deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect("first claim succeeds");
    let error = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("replay fails");

    assert_eq!(error.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn claiming_any_blocked_delete_data_plan_fails_closed_and_consumes_the_plan() {
    {
        let fixture = Fixture::new("claim-blocked-active");
        let account = fixture.account("claude-active", "Claude Active");
        fixture.write_accounts(std::slice::from_ref(&account));
        let canary = fixture.profiles.join(&account.id).join("active-canary");
        fs::create_dir_all(canary.parent().expect("active canary parent"))
            .expect("create active profile");
        fs::write(&canary, b"active-survives").expect("write active canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(
                &account.id,
                true,
                &HashSet::from([account.id.clone()]),
                1_000,
            )
            .expect("prepare active blocked plan");
        assert_blocked_plan_is_consumed(
            &fixture,
            &deletion,
            &plan,
            RemovalBlocker::ActiveSession,
            &canary,
        );
    }

    {
        let fixture = Fixture::new("claim-blocked-shared");
        let owner = fixture.account("shared-owner", "Shared Owner");
        let mut other = fixture.account("shared-other", "Shared Other");
        other.agent_dir = owner.agent_dir.clone();
        fixture.write_accounts(&[owner.clone(), other]);
        let canary = fixture.profiles.join(&owner.id).join("shared-canary");
        fs::create_dir_all(canary.parent().expect("shared canary parent"))
            .expect("create shared profile");
        fs::write(&canary, b"shared-survives").expect("write shared canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&owner.id, true, &HashSet::new(), 1_000)
            .expect("prepare shared blocked plan");
        assert_blocked_plan_is_consumed(
            &fixture,
            &deletion,
            &plan,
            RemovalBlocker::SharedProfile,
            &canary,
        );
    }

    {
        let fixture = Fixture::new("claim-blocked-default");
        let mut account = fixture.account("default-anthropic", "Default Claude");
        account.agent_dir = fixture
            .registry
            .default_agent_dir()
            .to_string_lossy()
            .into_owned();
        fixture.write_accounts(std::slice::from_ref(&account));
        let canary = fixture.profiles.join(&account.id).join("default-canary");
        fs::create_dir_all(canary.parent().expect("default canary parent"))
            .expect("create derived default profile");
        fs::write(&canary, b"default-survives").expect("write default canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare default blocked plan");
        assert_blocked_plan_is_consumed(
            &fixture,
            &deletion,
            &plan,
            RemovalBlocker::DefaultOrMigrated,
            &canary,
        );
    }

    {
        let fixture = Fixture::new("claim-blocked-mismatch");
        let mut account = fixture.account("mismatched-owner", "Mismatched Owner");
        account.agent_dir = r"\\hostile-server\share\credential-profile".to_owned();
        fixture.write_accounts(std::slice::from_ref(&account));
        let canary = fixture.profiles.join(&account.id).join("mismatch-canary");
        fs::create_dir_all(canary.parent().expect("mismatch canary parent"))
            .expect("create mismatched profile");
        fs::write(&canary, b"mismatch-survives").expect("write mismatch canary");
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare mismatch blocked plan");
        assert_blocked_plan_is_consumed(
            &fixture,
            &deletion,
            &plan,
            RemovalBlocker::StoredPathMismatch,
            &canary,
        );
    }

    {
        let fixture = Fixture::new("claim-blocked-reparse");
        let account = fixture.account("reparse-owner", "Reparse Owner");
        fixture.write_accounts(std::slice::from_ref(&account));
        let outside = fixture.root.join("outside-reparse-target");
        fs::create_dir_all(&outside).expect("create outside reparse target");
        let canary = outside.join("reparse-canary");
        fs::write(&canary, b"reparse-survives").expect("write reparse canary");
        let target = fixture.profiles.join(&account.id);
        create_directory_symlink(&outside, &target);
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
        let plan = deletion
            .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
            .expect("prepare reparse blocked plan");
        assert_blocked_plan_is_consumed(
            &fixture,
            &deletion,
            &plan,
            RemovalBlocker::ReparsePoint,
            &canary,
        );
        assert!(
            fs::symlink_metadata(&target)
                .expect("inspect retained reparse")
                .file_type()
                .is_symlink(),
            "claim must not remove the blocked profile reparse"
        );
    }
}

#[test]
fn claiming_a_plan_rejects_a_registry_generation_race() {
    let fixture = Fixture::new("registry-race");
    let target_account = fixture.account("claude-work", "Claude Work");
    let concurrent_account = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[target_account.clone(), concurrent_account.clone()]);
    let target = fixture.profiles.join(&target_account.id);
    fs::create_dir_all(&target).expect("create target profile");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&target_account.id, true, &HashSet::new(), 1_000)
        .expect("prepare plan");

    fixture
        .registry
        .remove_entry(&concurrent_account.id)
        .expect("simulate concurrent registry mutation");
    let registry_after_race = bytes(&fixture.registry.registry_path());
    let error = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("stale plan fails");

    assert_eq!(error.code, DeletionErrorCode::RegistryChanged);
    assert_eq!(
        bytes(&fixture.registry.registry_path()),
        registry_after_race
    );
    assert!(
        target.is_dir(),
        "claim validation must not touch profile data"
    );
}

#[test]
fn claim_rejects_target_identity_change_after_prepare() {
    let fixture = Fixture::new("claim-target-identity-swap");
    let account = fixture.account("identity-owner", "Identity Owner");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create original target");
    let original_canary = target.join("original-canary");
    fs::write(&original_canary, b"original-survives").expect("write original canary");
    let outside_canary = fixture.root.join("outside-identity-canary");
    fs::write(&outside_canary, b"outside-survives").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare identity-bound plan");
    assert!(plan.target_identity.is_some());
    let registry_before = bytes(&fixture.registry.registry_path());

    let parked_original = fixture.profiles.join("parked-original-profile");
    fs::rename(&target, &parked_original).expect("park original target");
    fs::create_dir_all(&target).expect("create replacement target");
    let replacement_canary = target.join("replacement-canary");
    fs::write(&replacement_canary, b"replacement-survives").expect("write replacement canary");

    let error = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("identity swap must invalidate the plan");

    assert_eq!(error.code, DeletionErrorCode::TargetChanged);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(
        bytes(&parked_original.join("original-canary")),
        b"original-survives"
    );
    assert_eq!(bytes(&replacement_canary), b"replacement-survives");
    assert_eq!(bytes(&outside_canary), b"outside-survives");
    let replay = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("stale identity plan was consumed");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn claim_rejects_reparse_swap_after_prepare() {
    let fixture = Fixture::new("claim-reparse-swap");
    let account = fixture.account("reparse-swap-owner", "Reparse Swap Owner");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create original target");
    fs::write(target.join("original-canary"), b"original-survives").expect("write original canary");
    let outside = fixture.root.join("outside-reparse-swap");
    fs::create_dir_all(&outside).expect("create outside reparse target");
    let outside_canary = outside.join("outside-canary");
    fs::write(&outside_canary, b"outside-survives").expect("write outside canary");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare non-reparse plan");
    assert!(!plan.checks.reparse_point);
    let registry_before = bytes(&fixture.registry.registry_path());

    let parked_original = fixture.profiles.join("parked-before-reparse-swap");
    fs::rename(&target, &parked_original).expect("park original target");
    create_directory_symlink(&outside, &target);

    let error = deletion
        .claim_plan_at(&plan.plan_id, 2_000)
        .expect_err("reparse swap must invalidate the plan");

    assert_eq!(error.code, DeletionErrorCode::UnsafeTarget);
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert_eq!(
        bytes(&parked_original.join("original-canary")),
        b"original-survives"
    );
    assert_eq!(bytes(&outside_canary), b"outside-survives");
    assert!(
        fs::symlink_metadata(&target)
            .expect("inspect retained swapped reparse")
            .file_type()
            .is_symlink(),
        "claim must not remove the swapped profile reparse"
    );
    let replay = deletion
        .claim_plan_at(&plan.plan_id, 2_001)
        .expect_err("unsafe reparse plan was consumed");
    assert_eq!(replay.code, DeletionErrorCode::PlanReplayed);
}

#[test]
fn prepare_rejects_invalid_account_path_components_before_touching_data() {
    let fixture = Fixture::new("invalid-id");
    let outside_canary = fixture.root.join("outside-canary.txt");
    fs::write(&outside_canary, b"outside-must-survive").expect("write outside canary");
    let invalid_ids = [
        "",
        ".",
        "..",
        "../victim",
        "nested/path",
        r"nested\path",
        r"C:\",
        r"\\server\share",
        r"\\?\C:\victim",
        "work:secret",
        "con",
        "account.",
        "account ",
        "UPPERCASE",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];

    for id in invalid_ids {
        let account = fixture.account(id, "Hostile Registry Entry");
        fixture.write_accounts(&[account]);
        let registry_before = bytes(&fixture.registry.registry_path());
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

        let error = deletion
            .prepare_remove_account_at(id, true, &HashSet::new(), 1_000)
            .expect_err("invalid path component must fail");

        assert_eq!(error.code, DeletionErrorCode::InvalidAccountId, "id {id:?}");
        assert_eq!(
            bytes(&fixture.registry.registry_path()),
            registry_before,
            "id {id:?}"
        );
        assert_eq!(bytes(&outside_canary), b"outside-must-survive", "id {id:?}");
        for hostile_fragment in ["victim", "secret", "server", "UPPERCASE"] {
            assert!(
                !error.message.contains(hostile_fragment),
                "diagnostic reflected hostile fragment from {id:?}"
            );
        }
    }
}

#[test]
fn prepare_never_uses_or_exposes_stored_unc_device_ads_or_volume_root_paths() {
    let fixture = Fixture::new("stored-path-mismatch");
    let dangerous_paths = [
        r"\\attacker-host\share\profile",
        r"\\?\Z:\device-payload",
        r"Z:\",
        r"Z:\safe\profile:credential-stream",
    ];

    for (index, dangerous_path) in dangerous_paths.into_iter().enumerate() {
        let id = format!("owned-{index}");
        let mut account = fixture.account(&id, "Owned Account");
        account.agent_dir = dangerous_path.to_owned();
        fixture.write_accounts(&[account]);
        let registry_before = bytes(&fixture.registry.registry_path());
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

        let plan = deletion
            .prepare_remove_account_at(&id, true, &HashSet::new(), 1_000)
            .expect("mismatched stored path yields a blocked plan");

        assert_eq!(
            plan.target_path,
            fixture.profiles.join(&id).to_string_lossy()
        );
        assert!(!plan.checks.stored_path_matches);
        assert!(!plan.checks.data_deletion_allowed);
        assert!(plan.blockers.contains(&RemovalBlocker::StoredPathMismatch));
        assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
        let diagnostic = serde_json::to_string(&plan).expect("serialize plan diagnostics");
        for secret_fragment in ["attacker-host", "device-payload", "credential-stream"] {
            assert!(!diagnostic.contains(secret_fragment));
        }
    }
}

#[test]
fn prepare_blocks_default_and_migrated_profiles_from_data_deletion() {
    let fixture = Fixture::new("default-migrated");
    let cases = ["default-anthropic", "legacy-claude"];

    for id in cases {
        let mut account = fixture.account(id, "Protected Account");
        account.agent_dir = fixture
            .registry
            .default_agent_dir()
            .to_string_lossy()
            .into_owned();
        fixture.write_accounts(&[account]);
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

        let plan = deletion
            .prepare_remove_account_at(id, true, &HashSet::new(), 1_000)
            .expect("protected account yields blocked plan");

        assert!(plan.checks.default_or_migrated, "id {id}");
        assert!(!plan.checks.data_deletion_allowed, "id {id}");
        assert!(
            plan.blockers.contains(&RemovalBlocker::DefaultOrMigrated),
            "id {id}"
        );
        assert_eq!(
            plan.estimate.items, 0,
            "the original agent home is never enumerated"
        );
    }
}

#[test]
fn prepare_blocks_a_profile_referenced_by_another_account() {
    let fixture = Fixture::new("shared-profile");
    let owner = fixture.account("shared-owner", "Shared Owner");
    let mut other = fixture.account("other-account", "Other Account");
    other.agent_dir = owner.agent_dir.clone();
    fixture.write_accounts(&[owner.clone(), other]);
    fs::create_dir_all(fixture.profiles.join(&owner.id)).expect("create shared profile");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let plan = deletion
        .prepare_remove_account_at(&owner.id, true, &HashSet::new(), 1_000)
        .expect("shared profile yields blocked plan");

    assert!(plan.checks.stored_path_matches);
    assert!(plan.checks.shared_profile);
    assert!(!plan.checks.data_deletion_allowed);
    assert!(plan.blockers.contains(&RemovalBlocker::SharedProfile));
}

#[cfg(windows)]
#[test]
fn prepare_blocks_canonically_equivalent_shared_profile_spellings() {
    let fixture = Fixture::new("canonical-shared-profile");
    let owner = fixture.account("canonical-owner", "Canonical Owner");
    let target = fixture.profiles.join(&owner.id);
    fs::create_dir_all(&target).expect("create canonical owner profile");
    let canonical_target = fs::canonicalize(&target).expect("canonicalize target");
    let normalization_marker = fixture.profiles.join("HOSTILE-CREDENTIAL-ALIAS");
    fs::create_dir_all(&normalization_marker).expect("create normalization marker");

    let mut aliases = vec![
        ("forward slash", target.to_string_lossy().replace('\\', "/")),
        (
            "normalized segment",
            normalization_marker
                .join("..")
                .join(&owner.id)
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "extended path",
            canonical_target.to_string_lossy().into_owned(),
        ),
    ];
    if let Some(short) = short_path_if_available(&target) {
        aliases.push(("short name", short.to_string_lossy().into_owned()));
    }

    for (case, alias) in aliases {
        assert_eq!(
            fs::canonicalize(Path::new(&alias)).expect("canonicalize stored alias"),
            canonical_target,
            "case {case}"
        );
        let mut other = fixture.account("canonical-other", "Canonical Other");
        other.agent_dir = alias.clone();
        fixture.write_accounts(&[owner.clone(), other]);
        let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

        let plan = deletion
            .prepare_remove_account_at(&owner.id, true, &HashSet::new(), 1_000)
            .expect("canonical alias yields a blocked plan");

        assert!(plan.checks.shared_profile, "case {case}");
        assert!(!plan.checks.data_deletion_allowed, "case {case}");
        assert!(
            plan.blockers.contains(&RemovalBlocker::SharedProfile),
            "case {case}"
        );
        let diagnostics = serde_json::to_string(&plan).expect("serialize plan");
        assert!(
            !diagnostics.contains(&alias),
            "raw stored alias leaked for case {case}"
        );
        assert!(!diagnostics.contains("HOSTILE-CREDENTIAL-ALIAS"));
    }
}

#[test]
fn prepare_blocks_data_deletion_while_the_account_has_an_active_session() {
    let fixture = Fixture::new("active-session");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create profile");
    let registry_before = bytes(&fixture.registry.registry_path());
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);
    let active = HashSet::from([account.id.clone()]);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &active, 1_000)
        .expect("active account yields blocked plan");

    assert!(plan.checks.active_session);
    assert!(!plan.checks.data_deletion_allowed);
    assert!(plan.blockers.contains(&RemovalBlocker::ActiveSession));
    assert_eq!(bytes(&fixture.registry.registry_path()), registry_before);
    assert!(target.is_dir());
}

#[test]
fn prepare_blocks_a_reparse_point_profile_leaf_without_following_it() {
    let fixture = Fixture::new("reparse-leaf");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let outside = fixture.root.join("outside-profile");
    fs::create_dir_all(&outside).expect("create outside target");
    let outside_canary = outside.join("secret.txt");
    fs::write(&outside_canary, b"outside-reparse-canary").expect("write outside canary");
    let target = fixture.profiles.join(&account.id);
    create_directory_symlink(&outside, &target);
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("reparse leaf yields blocked plan");

    assert!(plan.checks.reparse_point);
    assert!(!plan.checks.data_deletion_allowed);
    assert!(plan.blockers.contains(&RemovalBlocker::ReparsePoint));
    assert_eq!(
        plan.estimate.items, 1,
        "the linked target is never enumerated"
    );
    assert_eq!(bytes(&outside_canary), b"outside-reparse-canary");
}

#[test]
fn prepare_blocks_a_reparse_point_ancestor_of_the_profile() {
    let fixture = Fixture::new("reparse-ancestor");
    let real_profiles = fixture.root.join("real-profiles");
    let linked_profiles = fixture.root.join("linked-profiles");
    fs::create_dir_all(&real_profiles).expect("create real profiles directory");
    create_directory_symlink(&real_profiles, &linked_profiles);
    let registry = Arc::new(AccountRegistry::new(
        linked_profiles.clone(),
        fixture.root.join("default-agent"),
    ));
    let account = Account {
        id: "claude-work".to_owned(),
        label: "Claude Work".to_owned(),
        provider: "anthropic".to_owned(),
        agent_dir: linked_profiles
            .join("claude-work")
            .to_string_lossy()
            .into_owned(),
        created_at: 1,
    };
    fs::write(
        registry.registry_path(),
        serde_json::to_vec_pretty(std::slice::from_ref(&account)).expect("serialize registry"),
    )
    .expect("write registry through linked profiles directory");
    let real_target = real_profiles.join(&account.id);
    fs::create_dir_all(&real_target).expect("create real target directory");
    fs::write(
        real_target.join("must-not-be-enumerated.txt"),
        b"outside-boundary",
    )
    .expect("write target behind reparse ancestor");
    let deletion = AccountDeletion::with_ttl(registry, 30_000);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("reparse ancestor yields blocked plan");

    assert!(plan.checks.reparse_point);
    assert!(!plan.checks.data_deletion_allowed);
    assert!(plan.blockers.contains(&RemovalBlocker::ReparsePoint));
    assert_eq!(
        plan.estimate.items, 0,
        "planning stops at the reparse ancestor"
    );
    assert!(
        plan.target_identity.is_none(),
        "identity lookup must not cross the reparse ancestor"
    );
}

#[cfg(windows)]
#[test]
fn derived_targets_reject_unc_device_ads_and_volume_root_profile_inputs() {
    let unsafe_roots = [
        r"\\attacker-host\share\profiles",
        r"\\?\C:\profiles",
        r"C:\",
        r"C:\safe\profiles:credential-stream",
    ];

    for root in unsafe_roots {
        let error = derive_deletion_target(Path::new(root), "owned-account")
            .expect_err("unsafe profiles root must fail before filesystem access");
        assert_eq!(error.code, DeletionErrorCode::UnsafeTarget, "root {root:?}");
    }
}

#[cfg(windows)]
#[test]
fn failed_atomic_registry_replacement_preserves_registry_and_all_canaries() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new("atomic-failure");
    let removed = fixture.account("claude-work", "Claude Work");
    let retained = fixture.account("claude-home", "Claude Home");
    fixture.write_accounts(&[removed.clone(), retained]);
    let profile_canary = fixture.profiles.join(&removed.id).join("canary.txt");
    fs::create_dir_all(profile_canary.parent().expect("profile parent")).expect("create profile");
    fs::write(&profile_canary, b"profile-canary").expect("write profile canary");
    let outside_canary = fixture.root.join("outside-canary.txt");
    fs::write(&outside_canary, b"outside-canary").expect("write outside canary");
    let registry_path = fixture.registry.registry_path();
    let registry_before = bytes(&registry_path);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ only: deny replacement/delete sharing.
        .open(&registry_path)
        .expect("hold registry without delete sharing");

    let error = fixture
        .registry
        .remove_entry(&removed.id)
        .expect_err("replacement must fail");
    drop(held);

    assert!(error.contains("could not replace account registry"));
    assert_eq!(bytes(&registry_path), registry_before);
    assert_eq!(bytes(&profile_canary), b"profile-canary");
    assert_eq!(bytes(&outside_canary), b"outside-canary");
    let temporary_files = fs::read_dir(&fixture.profiles)
        .expect("list profiles")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".accounts.json.")
        })
        .count();
    assert_eq!(
        temporary_files, 0,
        "failed replacement cleans its same-directory temporary"
    );
}

#[test]
fn plans_and_errors_never_expose_credential_contents() {
    let fixture = Fixture::new("credential-redaction");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create profile");
    let secrets = ["ACCESS-TOKEN-DO-NOT-LEAK", "REFRESH-TOKEN-DO-NOT-LEAK"];
    fs::write(
        target.join("auth.json"),
        format!(
            r#"{{"access":"{}","refresh":"{}"}}"#,
            secrets[0], secrets[1]
        ),
    )
    .expect("write credential fixture");
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare plan");
    let error = deletion
        .claim_plan_at("missing-plan", 2_000)
        .expect_err("missing plan");
    let diagnostics = format!(
        "{}\n{plan:?}\n{error:?}",
        serde_json::to_string(&plan).expect("serialize plan")
    );

    for secret in secrets {
        assert!(!diagnostics.contains(secret));
    }
}

#[test]
fn profile_estimates_stop_at_the_public_item_bound() {
    let fixture = Fixture::new("bounded-estimate");
    let account = fixture.account("claude-work", "Claude Work");
    fixture.write_accounts(std::slice::from_ref(&account));
    let target = fixture.profiles.join(&account.id);
    fs::create_dir_all(&target).expect("create profile");
    for index in 0..=MAX_ESTIMATE_ITEMS {
        fs::write(target.join(format!("item-{index:05}")), b"").expect("write estimate item");
    }
    let deletion = AccountDeletion::with_ttl(fixture.registry.clone(), 30_000);

    let plan = deletion
        .prepare_remove_account_at(&account.id, true, &HashSet::new(), 1_000)
        .expect("prepare bounded estimate");

    assert_eq!(plan.estimate.items, MAX_ESTIMATE_ITEMS);
    assert!(plan.estimate.truncated);
}
