use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use prime_studio_lib::harness::generated::{StudioRequest, StudioResponse};
use prime_studio_lib::harness::sidecar::{HarnessError, SidecarSupervisor, VerifiedSidecarSpec};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn fake_sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-harness-sidecar"))
}

fn digest(path: &Path) -> String {
    format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap()))
}

fn spec(mode: &str) -> VerifiedSidecarSpec {
    let executable = fake_sidecar();
    VerifiedSidecarSpec::for_tests(
        executable.clone(),
        digest(&executable),
        vec![mode.to_owned()],
        Vec::new(),
    )
    .unwrap()
}

fn wait_until(deadline: Instant, mut predicate: impl FnMut() -> bool) -> bool {
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    predicate()
}

#[test]
fn response_is_bound_to_the_exact_request() {
    let handle = SidecarSupervisor::start(spec("echo")).unwrap();
    let response = handle
        .request_blocking(
            StudioRequest::Bootstrap,
            Instant::now() + Duration::from_secs(3),
        )
        .unwrap();
    assert!(matches!(response, StudioResponse::Error { code, .. } if code == "echo"));
    handle
        .shutdown_blocking(Instant::now() + Duration::from_secs(3))
        .unwrap();
}

#[test]
fn silent_invalid_and_flooding_children_fail_within_the_deadline() {
    for (mode, expected) in [
        ("silent", "deadline"),
        ("invalid", "protocol"),
        ("flood", "protocol"),
        ("oversized-valid", "protocol"),
        ("unsafe-integer", "protocol"),
        ("duplicate-capability", "protocol"),
    ] {
        let handle = SidecarSupervisor::start(spec(mode)).unwrap();
        let started = Instant::now();
        let error = handle
            .request_blocking(
                StudioRequest::Bootstrap,
                started + Duration::from_millis(500),
            )
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(error.code(), expected);
    }
}

#[test]
fn launch_revalidates_the_executable_after_spec_creation() {
    let source = fake_sidecar();
    let root = std::env::temp_dir().join(format!("prime-studio-sidecar-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let copy = root.join("sidecar.exe");
    fs::copy(&source, &copy).unwrap();
    let verified = VerifiedSidecarSpec::for_tests(
        copy.clone(),
        digest(&copy),
        vec!["echo".to_owned()],
        Vec::new(),
    )
    .unwrap();
    fs::write(&copy, b"replaced").unwrap();
    assert!(matches!(
        SidecarSupervisor::start(verified),
        Err(HarnessError::VerificationFailed)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn wrong_executable_is_rejected_without_running_content() {
    let root = std::env::temp_dir().join(format!("prime-studio-wrong-sidecar-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let wrong = root.join("not-a-sidecar.exe");
    fs::write(&wrong, b"not an executable").unwrap();
    let verified =
        VerifiedSidecarSpec::for_tests(wrong.clone(), digest(&wrong), Vec::new(), Vec::new())
            .unwrap();
    assert!(matches!(
        SidecarSupervisor::start(verified),
        Err(HarnessError::SpawnFailed)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn verified_resources_remain_locked_for_the_process_lifetime() {
    let root =
        std::env::temp_dir().join(format!("prime-studio-sidecar-resource-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let resource = root.join("adapter.js");
    fs::write(&resource, b"verified adapter").unwrap();
    let executable = fake_sidecar();
    let verified = VerifiedSidecarSpec::for_tests(
        executable.clone(),
        digest(&executable),
        vec!["echo".to_owned()],
        vec![(resource.clone(), digest(&resource))],
    )
    .unwrap();
    let handle = SidecarSupervisor::start(verified).unwrap();
    assert!(fs::write(&resource, b"replacement").is_err());
    handle
        .shutdown_blocking(Instant::now() + Duration::from_secs(3))
        .unwrap();
    drop(handle);
    fs::write(&resource, b"replacement").unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn shutdown_terminates_descendants_and_releases_their_handles() {
    let root = std::env::temp_dir().join(format!("prime-studio-sidecar-tree-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let marker = root.join("descendant.lock");
    let executable = fake_sidecar();
    let verified = VerifiedSidecarSpec::for_tests(
        executable.clone(),
        digest(&executable),
        vec!["descendant".to_owned(), marker.display().to_string()],
        Vec::new(),
    )
    .unwrap();
    let handle = SidecarSupervisor::start(verified).unwrap();
    let response = handle
        .request_blocking(
            StudioRequest::Bootstrap,
            Instant::now() + Duration::from_secs(3),
        )
        .unwrap();
    assert!(matches!(response, StudioResponse::Error { code, .. } if code == "spawned"));
    assert!(wait_until(Instant::now() + Duration::from_secs(3), || {
        marker.exists()
    }));
    assert!(
        fs::remove_file(&marker).is_err(),
        "live descendant must hold its marker"
    );
    handle
        .shutdown_blocking(Instant::now() + Duration::from_secs(3))
        .unwrap();
    assert!(wait_until(Instant::now() + Duration::from_secs(3), || {
        fs::remove_file(&marker).is_ok()
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn child_environment_is_cleared_and_diagnostics_are_content_free() {
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    std::env::set_var("HARNESS_TEST_SECRET", "must-not-cross");
    let environment = SidecarSupervisor::start(spec("environment")).unwrap();
    let response = environment
        .request_blocking(
            StudioRequest::Bootstrap,
            Instant::now() + Duration::from_secs(3),
        )
        .unwrap();
    std::env::remove_var("HARNESS_TEST_SECRET");
    assert!(matches!(response, StudioResponse::Error { code, .. } if code == "clean"));
    environment
        .shutdown_blocking(Instant::now() + Duration::from_secs(3))
        .unwrap();

    let diagnostic = SidecarSupervisor::start(spec("diagnostic")).unwrap();
    let _ = diagnostic
        .request_blocking(
            StudioRequest::Bootstrap,
            Instant::now() + Duration::from_secs(3),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let lines = diagnostic.diagnostics();
    assert!(!lines.is_empty());
    let text = lines.join("\n");
    assert!(!text.contains("TOPSECRET"));
    assert!(!text.contains("Private"));
    diagnostic
        .shutdown_blocking(Instant::now() + Duration::from_secs(3))
        .unwrap();
}
