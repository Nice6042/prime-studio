use std::fmt;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::accounts::atomic_replace;
use crate::bounded_io::read_bounded;

const SCHEDULER_SCHEMA_VERSION: u32 = 1;
const MAX_JS_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const MAX_SCHEDULER_STATE_BYTES: usize = 64 * 1024;

fn lock_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".lock");
    PathBuf::from(value)
}

struct NativeStoreLock {
    _file: fs::File,
}

impl NativeStoreLock {
    fn acquire(state_path: &Path) -> Result<Self, SchedulerStoreError> {
        let path = lock_path(state_path);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| SchedulerStoreError::Io)?;
        file.try_lock().map_err(|_| SchedulerStoreError::Io)?;
        Ok(Self { _file: file })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SchedulerStatus {
    Planned,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SchedulerProjection {
    schema_version: u32,
    revision: Option<u64>,
    status: SchedulerStatus,
    dispatch_available: bool,
}

impl SchedulerProjection {
    fn planned(revision: u64) -> Self {
        Self {
            schema_version: SCHEDULER_SCHEMA_VERSION,
            revision: Some(revision),
            status: SchedulerStatus::Planned,
            dispatch_available: false,
        }
    }

    fn unavailable() -> Self {
        Self {
            schema_version: SCHEDULER_SCHEMA_VERSION,
            revision: None,
            status: SchedulerStatus::Unavailable,
            dispatch_available: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StoredSchedulerStatus {
    Planned,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchedulerDocument {
    schema_version: u32,
    revision: u64,
    status: StoredSchedulerStatus,
}

impl Default for SchedulerDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEDULER_SCHEMA_VERSION,
            revision: 0,
            status: StoredSchedulerStatus::Planned,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
enum SchedulerStoreError {
    Io,
    CorruptState,
    UnsupportedSchema,
    UnsafeRevision,
    RevisionConflict { expected: u64, actual: u64 },
    RevisionExhausted,
    StateChanged,
}

impl fmt::Display for SchedulerStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io => formatter.write_str("scheduler state is unavailable"),
            Self::CorruptState => formatter.write_str("scheduler state is corrupt"),
            Self::UnsupportedSchema => formatter.write_str("scheduler state schema is unsupported"),
            Self::UnsafeRevision => {
                formatter.write_str("scheduler revision is not JavaScript-safe")
            }
            Self::RevisionConflict { expected, actual } => {
                write!(
                    formatter,
                    "scheduler revision conflict: expected {expected}, actual {actual}"
                )
            }
            Self::RevisionExhausted => formatter.write_str("scheduler revision is exhausted"),
            Self::StateChanged => {
                formatter.write_str("scheduler state changed outside its native authority")
            }
        }
    }
}

impl std::error::Error for SchedulerStoreError {}

#[derive(Debug)]
struct SchedulerStore {
    path: PathBuf,
    document: SchedulerDocument,
}

impl SchedulerStore {
    fn open(path: PathBuf) -> Result<Self, SchedulerStoreError> {
        let parent = path.parent().ok_or(SchedulerStoreError::Io)?;
        fs::create_dir_all(parent).map_err(|_| SchedulerStoreError::Io)?;
        let _lock = NativeStoreLock::acquire(&path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let bytes = Self::encode(&SchedulerDocument::default())?;
                atomic_replace(&path, &bytes).map_err(|_| SchedulerStoreError::Io)?;
            }
            Err(_) => return Err(SchedulerStoreError::Io),
        }

        let document = Self::load(&path)?;
        Ok(Self { path, document })
    }

    fn load(path: &std::path::Path) -> Result<SchedulerDocument, SchedulerStoreError> {
        let bytes = read_bounded(path, MAX_SCHEDULER_STATE_BYTES)
            .map_err(|_| SchedulerStoreError::CorruptState)?
            .bytes;
        let document: SchedulerDocument =
            serde_json::from_slice(&bytes).map_err(|_| SchedulerStoreError::CorruptState)?;
        if document.schema_version != SCHEDULER_SCHEMA_VERSION {
            return Err(SchedulerStoreError::UnsupportedSchema);
        }
        if document.revision > MAX_JS_SAFE_REVISION {
            return Err(SchedulerStoreError::UnsafeRevision);
        }
        Ok(document)
    }

    fn encode(document: &SchedulerDocument) -> Result<Vec<u8>, SchedulerStoreError> {
        serde_json::to_vec_pretty(document).map_err(|_| SchedulerStoreError::CorruptState)
    }

    fn revision(&self) -> u64 {
        self.document.revision
    }

    /// Native-only exact compare-and-swap. There is intentionally no Tauri
    /// command that can reach this mutation path in the read-only milestone.
    #[cfg_attr(not(test), allow(dead_code))]
    fn compare_and_swap(&mut self, expected_revision: u64) -> Result<u64, SchedulerStoreError> {
        let _lock = NativeStoreLock::acquire(&self.path)?;
        let disk = Self::load(&self.path)?;
        if expected_revision != disk.revision {
            return Err(SchedulerStoreError::RevisionConflict {
                expected: expected_revision,
                actual: disk.revision,
            });
        }
        if disk != self.document {
            return Err(SchedulerStoreError::StateChanged);
        }
        let revision = self
            .document
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_JS_SAFE_REVISION)
            .ok_or(SchedulerStoreError::RevisionExhausted)?;
        let mut next = self.document.clone();
        next.revision = revision;
        let bytes = Self::encode(&next)?;
        atomic_replace(&self.path, &bytes).map_err(|_| SchedulerStoreError::Io)?;
        self.document = next;
        Ok(revision)
    }
}

#[derive(Debug)]
pub(super) struct SchedulerService {
    path: PathBuf,
    store: Mutex<Option<SchedulerStore>>,
}

impl SchedulerService {
    pub(super) fn open(path: PathBuf) -> Self {
        let store = SchedulerStore::open(path.clone()).ok();
        Self {
            path,
            store: Mutex::new(store),
        }
    }

    pub(super) fn projection(&self) -> SchedulerProjection {
        let Ok(mut store) = self.store.lock() else {
            return SchedulerProjection::unavailable();
        };
        if store.is_none() {
            *store = SchedulerStore::open(self.path.clone()).ok();
        }
        store
            .as_ref()
            .map(|store| SchedulerProjection::planned(store.revision()))
            .unwrap_or_else(SchedulerProjection::unavailable)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{
        lock_path, NativeStoreLock, SchedulerProjection, SchedulerService, SchedulerStatus,
        SchedulerStore, SchedulerStoreError, MAX_JS_SAFE_REVISION, SCHEDULER_SCHEMA_VERSION,
    };

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "prime-studio-scheduler-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("create scheduler test directory");
            Self(path)
        }

        fn state_path(&self) -> PathBuf {
            self.0.join("scheduler-state.json")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read(path: &Path) -> Vec<u8> {
        fs::read(path).expect("read scheduler state")
    }

    #[test]
    fn missing_state_is_initialized_durably_and_projected_as_planned() {
        let root = TestDir::new("initialize");
        let path = root.state_path();

        let service = SchedulerService::open(path.clone());

        assert_eq!(
            service.projection(),
            SchedulerProjection {
                schema_version: SCHEDULER_SCHEMA_VERSION,
                revision: Some(0),
                status: SchedulerStatus::Planned,
                dispatch_available: false,
            }
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&read(&path)).expect("valid JSON"),
            serde_json::json!({
                "schemaVersion": SCHEDULER_SCHEMA_VERSION,
                "revision": 0,
                "status": "planned"
            })
        );
    }

    #[test]
    fn corruption_fails_closed_without_replacing_existing_bytes() {
        let root = TestDir::new("corrupt");
        let path = root.state_path();
        let corrupt = br#"{"schemaVersion":1,"revision":0,"status":"planned"#;
        fs::write(&path, corrupt).expect("write corrupt fixture");

        let service = SchedulerService::open(path.clone());

        assert_eq!(
            service.projection(),
            SchedulerProjection {
                schema_version: SCHEDULER_SCHEMA_VERSION,
                revision: None,
                status: SchedulerStatus::Unavailable,
                dispatch_available: false,
            }
        );
        assert_eq!(read(&path), corrupt);
    }

    #[test]
    fn unknown_fields_and_unsafe_revisions_fail_closed_without_rewrite() {
        for (name, bytes) in [
            (
                "unknown-field",
                br#"{"schemaVersion":1,"revision":0,"status":"planned","extra":true}"#.as_slice(),
            ),
            (
                "unsafe-revision",
                br#"{"schemaVersion":1,"revision":9007199254740992,"status":"planned"}"#.as_slice(),
            ),
            (
                "unsupported-schema",
                br#"{"schemaVersion":2,"revision":0,"status":"planned"}"#.as_slice(),
            ),
        ] {
            let root = TestDir::new(name);
            let path = root.state_path();
            fs::write(&path, bytes).expect("write invalid fixture");

            let service = SchedulerService::open(path.clone());

            assert_eq!(service.projection().status, SchedulerStatus::Unavailable);
            assert_eq!(service.projection().revision, None);
            assert_eq!(read(&path), bytes);
        }
    }

    #[test]
    fn compare_and_swap_requires_the_exact_revision_and_commits_once() {
        let root = TestDir::new("cas");
        let path = root.state_path();
        let mut store = SchedulerStore::open(path.clone()).expect("open store");

        assert_eq!(store.compare_and_swap(0), Ok(1));
        let committed = read(&path);
        assert_eq!(store.revision(), 1);

        assert_eq!(
            store.compare_and_swap(0),
            Err(SchedulerStoreError::RevisionConflict {
                expected: 0,
                actual: 1,
            })
        );
        assert_eq!(store.revision(), 1);
        assert_eq!(read(&path), committed);
    }

    #[test]
    fn a_second_native_store_observes_the_first_commit_as_a_revision_conflict() {
        let root = TestDir::new("two-store-cas");
        let path = root.state_path();
        let mut first = SchedulerStore::open(path.clone()).expect("open first store");
        let mut second = SchedulerStore::open(path.clone()).expect("open second store");

        assert_eq!(first.compare_and_swap(0), Ok(1));
        let committed = read(&path);
        assert_eq!(
            second.compare_and_swap(0),
            Err(SchedulerStoreError::RevisionConflict {
                expected: 0,
                actual: 1,
            })
        );
        assert_eq!(read(&path), committed);
    }

    #[test]
    fn a_committed_revision_survives_service_restart() {
        let root = TestDir::new("service-restart");
        let path = root.state_path();
        let mut store = SchedulerStore::open(path.clone()).expect("open store");
        assert_eq!(store.compare_and_swap(0), Ok(1));
        drop(store);

        let restarted = SchedulerService::open(path);

        assert_eq!(
            restarted.projection(),
            SchedulerProjection {
                schema_version: SCHEDULER_SCHEMA_VERSION,
                revision: Some(1),
                status: SchedulerStatus::Planned,
                dispatch_available: false,
            }
        );
    }

    #[test]
    fn an_unlocked_leftover_lock_file_does_not_disable_restart() {
        let root = TestDir::new("leftover-store-lock");
        let path = root.state_path();
        let initial = SchedulerStore::open(path.clone()).expect("initialize state");
        assert_eq!(initial.revision(), 0);
        drop(initial);
        let bytes = read(&path);
        fs::write(lock_path(&path), b"left behind by a terminated process")
            .expect("write leftover scheduler lock fixture");

        let restarted = SchedulerStore::open(path.clone()).expect("ignore unlocked lock file");

        assert_eq!(restarted.revision(), 0);
        assert_eq!(read(&path), bytes);
    }

    #[test]
    fn live_lock_projects_unavailable_then_recovers_without_restarting_the_service() {
        let root = TestDir::new("live-store-lock");
        let path = root.state_path();
        let initial = SchedulerStore::open(path.clone()).expect("initialize state");
        drop(initial);
        let held = NativeStoreLock::acquire(&path).expect("hold native scheduler lock");
        let service = SchedulerService::open(path);
        assert_eq!(service.projection().status, SchedulerStatus::Unavailable);

        drop(held);

        assert_eq!(service.projection().status, SchedulerStatus::Planned);
        assert_eq!(service.projection().revision, Some(0));
    }

    const LOCK_CHILD_ENV: &str = "PRIME_STUDIO_SCHEDULER_LOCK_CHILD";

    #[test]
    fn native_store_lock_child_fixture() {
        let Some(path) = std::env::var_os(LOCK_CHILD_ENV).map(PathBuf::from) else {
            return;
        };
        let _held = NativeStoreLock::acquire(&path).expect("child acquires scheduler lock");
        fs::write(path.with_extension("ready"), b"ready").expect("announce held scheduler lock");
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    #[test]
    fn forced_process_termination_releases_the_native_store_lock() {
        let root = TestDir::new("terminated-store-lock");
        let path = root.state_path();
        let ready = path.with_extension("ready");
        let mut child = std::process::Command::new(
            std::env::current_exe().expect("current scheduler test executable"),
        )
        .args([
            "--exact",
            "scheduler::tests::native_store_lock_child_fixture",
            "--nocapture",
        ])
        .env(LOCK_CHILD_ENV, &path)
        .spawn()
        .expect("spawn lock holder");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !ready.exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lock holder did not become ready");
        }
        child.kill().expect("terminate lock holder");
        child.wait().expect("reap lock holder");

        let recovered = SchedulerStore::open(path).expect("OS releases lock after termination");
        assert_eq!(recovered.revision(), 0);
    }

    #[test]
    fn compare_and_swap_rejects_revision_exhaustion_without_rewrite() {
        let root = TestDir::new("revision-exhaustion");
        let path = root.state_path();
        let bytes = format!(
            "{{\"schemaVersion\":1,\"revision\":{MAX_JS_SAFE_REVISION},\"status\":\"planned\"}}"
        );
        fs::write(&path, bytes.as_bytes()).expect("write max revision fixture");
        let mut store = SchedulerStore::open(path.clone()).expect("open max revision store");

        assert_eq!(
            store.compare_and_swap(MAX_JS_SAFE_REVISION),
            Err(SchedulerStoreError::RevisionExhausted)
        );
        assert_eq!(store.revision(), MAX_JS_SAFE_REVISION);
        assert_eq!(read(&path), bytes.as_bytes());
    }
}
