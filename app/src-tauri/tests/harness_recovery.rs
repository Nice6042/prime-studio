use std::fs;

use prime_studio_lib::harness::generated::HarnessCursor;
use prime_studio_lib::harness::recovery::{RecoveredSession, RecoveryRecord, RecoveryStore};
use uuid::Uuid;

fn record(revision: u64) -> RecoveryRecord {
    RecoveryRecord {
        schema_version: 1,
        projection_schema_version: 1,
        revision,
        runtime_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_owned(),
        profile: "daemon-v7-schema13".to_owned(),
        sessions: vec![RecoveredSession {
            session_id: "root".to_owned(),
            account_id: Some("account".to_owned()),
            project_id: "project".to_owned(),
            chat_id: "chat".to_owned(),
            cursor: HarnessCursor {
                runtime_generation: "generation".to_owned(),
                sequence: 7,
            },
        }],
    }
}

fn temporary_store() -> (std::path::PathBuf, RecoveryStore) {
    let root =
        std::env::temp_dir().join(format!("prime-studio-harness-recovery-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let store = RecoveryStore::new(root.join("harness-recovery.json")).unwrap();
    (root, store)
}

#[test]
fn recovery_is_exact_revision_bounded_and_round_trips() {
    let (root, store) = temporary_store();
    assert_eq!(store.load().unwrap(), None);
    store.save(0, &record(1)).unwrap();
    assert_eq!(store.load().unwrap(), Some(record(1)));
    assert!(store.save(0, &record(2)).is_err());
    store.save(1, &record(2)).unwrap();
    assert_eq!(store.load().unwrap(), Some(record(2)));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_duplicate_and_oversized_records_fail_closed() {
    let (root, store) = temporary_store();
    fs::write(store.path(), br#"{"schemaVersion":1,"schemaVersion":1}"#).unwrap();
    assert!(store.load().is_err());
    fs::remove_file(store.path()).unwrap();
    fs::write(root.join(".harness-recovery.next"), b"incomplete").unwrap();
    assert!(store.load().is_err());
    fs::remove_file(root.join(".harness-recovery.next")).unwrap();
    fs::write(store.path(), vec![b' '; RecoveryStore::MAX_BYTES + 1]).unwrap();
    assert!(store.load().is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn recovery_rejects_reparse_and_non_file_destinations() {
    let root =
        std::env::temp_dir().join(format!("prime-studio-harness-reparse-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    assert!(RecoveryStore::new(root.join("directory")).is_ok());
    fs::create_dir(root.join("directory")).unwrap();
    assert!(RecoveryStore::new(root.join("directory")).is_err());

    let target = root.join("target.json");
    let link = root.join("link.json");
    fs::write(&target, b"{}").unwrap();
    if std::os::windows::fs::symlink_file(&target, &link).is_ok() {
        assert!(RecoveryStore::new(link).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_bytes_never_contain_transcript_or_credential_material() {
    let (root, store) = temporary_store();
    store.save(0, &record(1)).unwrap();
    let text = fs::read_to_string(store.path()).unwrap();
    for forbidden in [
        "parentMessages",
        "children",
        "Bearer",
        "refreshToken",
        "apiKey",
    ] {
        assert!(!text.contains(forbidden));
    }
    fs::remove_dir_all(root).unwrap();
}
