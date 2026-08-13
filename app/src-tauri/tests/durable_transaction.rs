#[path = "../src/durable_transaction.rs"]
mod durable_transaction;

use durable_transaction::{DurableTransaction, DurableTransactionError};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const CHILD_ROOT: &str = "PRIME_DURABLE_TRANSACTION_CHILD_ROOT";
const CHILD_READY: &str = "PRIME_DURABLE_TRANSACTION_CHILD_READY";
const CHILD_RELEASE: &str = "PRIME_DURABLE_TRANSACTION_CHILD_RELEASE";
const LOCK_NAME: &str = ".studio-durable-v1.lock";

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "prime-studio-durable-transaction-{}",
        uuid::Uuid::new_v4()
    ))
}

#[cfg(windows)]
fn symlink_directory(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link).expect("create directory reparse fixture");
}

#[cfg(unix)]
fn symlink_directory(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create directory symlink fixture");
}

#[test]
fn durable_transaction_process_child() {
    let Some(root) = std::env::var_os(CHILD_ROOT).map(PathBuf::from) else {
        return;
    };
    let ready = PathBuf::from(std::env::var_os(CHILD_READY).expect("child ready path"));
    let release = PathBuf::from(std::env::var_os(CHILD_RELEASE).expect("child release path"));
    let transaction = DurableTransaction::new(&root);
    transaction
        .with_lock(|| {
            fs::write(&ready, b"ready").unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !release.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(release.exists(), "parent releases child process lock");
        })
        .expect("child acquires process lock");
}

#[test]
fn independent_processes_serialize_on_the_same_durable_transaction_file() {
    let root = temp_root();
    fs::create_dir(&root).unwrap();
    let ready = root.join("ready");
    let release = root.join("release");
    let acquired = root.join("acquired");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("durable_transaction_process_child")
        .arg("--test-threads=1")
        .env(CHILD_ROOT, &root)
        .env(CHILD_READY, &ready)
        .env(CHILD_RELEASE, &release)
        .spawn()
        .expect("start lock-holder process");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "child reaches locked state");

    let contender_root = root.clone();
    let contender = std::thread::spawn(move || {
        let transaction = DurableTransaction::new(&contender_root);
        transaction
            .with_lock(|| fs::write(acquired, b"acquired").unwrap())
            .expect("contender acquires after release");
    });
    std::thread::sleep(Duration::from_millis(200));
    assert!(!root.join("acquired").exists(), "contender remains blocked");
    fs::write(&release, b"release").unwrap();
    assert!(child.wait().unwrap().success());
    contender.join().unwrap();
    assert!(root.join("acquired").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_a_config_root_reached_through_an_ancestor_alias() {
    let fixture = temp_root();
    let real_parent = fixture.join("real-parent");
    let root = real_parent.join("config");
    let alias_parent = fixture.join("alias-parent");
    fs::create_dir_all(&root).unwrap();
    symlink_directory(&real_parent, &alias_parent);

    let transaction = DurableTransaction::new(&alias_parent.join("config"));
    let result = transaction.with_lock(|| ());

    assert_eq!(result, Err(DurableTransactionError::Unavailable));
    assert!(!root.join(LOCK_NAME).exists());
    fs::remove_dir_all(fixture).unwrap();
}

#[test]
fn rejects_a_lock_file_replaced_after_provisioning() {
    let root = temp_root();
    fs::create_dir(&root).unwrap();
    let transaction = DurableTransaction::new(&root);
    let lock_path = root.join(LOCK_NAME);
    fs::remove_file(&lock_path).unwrap();
    fs::write(&lock_path, b"replacement").unwrap();
    let ran = AtomicBool::new(false);

    let result = transaction.with_lock(|| ran.store(true, Ordering::SeqCst));

    assert_eq!(result, Err(DurableTransactionError::Unavailable));
    assert!(!ran.load(Ordering::SeqCst));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reports_unknown_outcome_when_the_lock_identity_changes_during_the_operation() {
    let root = temp_root();
    fs::create_dir(&root).unwrap();
    let transaction = DurableTransaction::new(&root);
    let lock_path = root.join(LOCK_NAME);

    let result = transaction.with_lock(|| {
        fs::remove_file(&lock_path).expect("unlink the acquired lock fixture");
        fs::write(&lock_path, b"replacement").expect("replace the acquired lock fixture");
        "operation completed"
    });

    assert_eq!(
        result,
        Err(DurableTransactionError::PersistenceOutcomeUnknown)
    );
    fs::remove_dir_all(root).unwrap();
}
