use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Barrier, Condvar, Mutex};
use std::time::{Duration, Instant};

use prime_studio_lib::session_process::{
    spawn, EventSink, ProcessEvent, ProcessExit, ProcessHandle, ProcessSpec, ProcessStream,
    ProtocolError, ProtocolFault, RequestTracker, ResponseDisposition, ResponseFault,
    ResponseRejection,
};
use serde_json::Value;
use uuid::Uuid;

const WAIT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<ProcessEvent>>,
    changed: Condvar,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: ProcessEvent) {
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }
}

impl RecordingSink {
    fn until_exit(&self) -> Vec<ProcessEvent> {
        let events = self.events.lock().unwrap();
        let (events, timeout) = self
            .changed
            .wait_timeout_while(events, WAIT, |events| {
                !events
                    .iter()
                    .any(|event| matches!(event, ProcessEvent::Exited(_)))
            })
            .unwrap();
        assert!(!timeout.timed_out(), "fake Prime never emitted an exit");
        events.clone()
    }

    fn until_json_kind(&self, kind: &str) {
        let events = self.events.lock().unwrap();
        let (_events, timeout) = self
            .changed
            .wait_timeout_while(events, WAIT, |events| {
                !events.iter().any(
                    |event| matches!(event, ProcessEvent::Json(value) if value["kind"] == kind),
                )
            })
            .unwrap();
        assert!(!timeout.timed_out(), "fake Prime never emitted {kind:?}");
    }

    fn wait_for_fault(&self, timeout: Duration) -> bool {
        let events = self.events.lock().unwrap();
        let (events, _) = self
            .changed
            .wait_timeout_while(events, timeout, |events| {
                !events
                    .iter()
                    .any(|event| matches!(event, ProcessEvent::ProtocolFault(_)))
            })
            .unwrap();
        events
            .iter()
            .any(|event| matches!(event, ProcessEvent::ProtocolFault(_)))
    }

    fn exit_within(&self, timeout: Duration) -> Option<ProcessExit> {
        let events = self.events.lock().unwrap();
        let (events, _) = self
            .changed
            .wait_timeout_while(events, timeout, |events| {
                !events
                    .iter()
                    .any(|event| matches!(event, ProcessEvent::Exited(_)))
            })
            .unwrap();
        events.iter().find_map(|event| match event {
            ProcessEvent::Exited(exit) => Some(exit.clone()),
            _ => None,
        })
    }
}

#[derive(Default)]
struct ReentrantFaultSink {
    events: Mutex<Vec<ProcessEvent>>,
    process: Mutex<Option<Arc<ProcessHandle>>>,
    send_after_fault: Mutex<Option<std::io::Result<String>>>,
}

type ReentrantOutcome = (std::io::Result<()>, Option<ProcessExit>);

struct ReentrantCancelSink {
    events: Mutex<Vec<ProcessEvent>>,
    changed: Condvar,
    process: Mutex<Option<Arc<ProcessHandle>>>,
    outcome: Mutex<Option<mpsc::Sender<ReentrantOutcome>>>,
}

struct BlockingFirstJsonSink {
    events: Mutex<Vec<ProcessEvent>>,
    changed: Condvar,
    first_json: Mutex<bool>,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl EventSink for BlockingFirstJsonSink {
    fn emit(&self, event: ProcessEvent) {
        let block = if matches!(event, ProcessEvent::Json(_)) {
            let mut first = self.first_json.lock().unwrap();
            std::mem::replace(&mut *first, false)
        } else {
            false
        };
        if block {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            self.release
                .lock()
                .unwrap()
                .recv()
                .expect("the test releases the blocked callback");
        }
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }
}

impl BlockingFirstJsonSink {
    fn until_exit(&self) -> Vec<ProcessEvent> {
        let events = self.events.lock().unwrap();
        let (events, timeout) = self
            .changed
            .wait_timeout_while(events, WAIT, |events| terminal_count(events) == 0)
            .unwrap();
        assert!(!timeout.timed_out(), "fake Prime never emitted an exit");
        events.clone()
    }
}

impl EventSink for ReentrantCancelSink {
    fn emit(&self, event: ProcessEvent) {
        let reenter = matches!(event, ProcessEvent::Json(_));
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
        if reenter {
            let process = self
                .process
                .lock()
                .unwrap()
                .clone()
                .expect("the request installs its process before the response");
            let cancel = process.cancel();
            let exit = process.wait_for_exit(Duration::from_secs(1));
            if let Some(tx) = self.outcome.lock().unwrap().take() {
                let _ = tx.send((cancel, exit));
            }
        }
    }
}

impl EventSink for ReentrantFaultSink {
    fn emit(&self, event: ProcessEvent) {
        if matches!(event, ProcessEvent::ProtocolFault(_)) {
            let process = self
                .process
                .lock()
                .unwrap()
                .clone()
                .expect("the request installs its process before a response can fault");
            let result = process.send(serde_json::json!({
                "type": "must-not-reach-quarantined-child",
                "id": "ui-after-fault",
            }));
            *self.send_after_fault.lock().unwrap() = Some(result);
        }
        self.events.lock().unwrap().push(event);
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "prime-studio-process-{name}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fake_prime() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-prime-jsonl"))
}

fn wait_for_path(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::yield_now();
    }
    true
}

fn json_events(events: &[ProcessEvent]) -> Vec<&Value> {
    events
        .iter()
        .filter_map(|event| match event {
            ProcessEvent::Json(value) => Some(value),
            _ => None,
        })
        .collect()
}

fn poison(mutex: &Mutex<()>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = mutex.lock().unwrap();
        panic!("poison registration lock fixture");
    }));
    assert!(mutex.is_poisoned());
}

fn simulate_post_spawn_registration(
    process: ProcessHandle,
    roots: &Mutex<()>,
    sessions: &Mutex<()>,
) -> Result<(), &'static str> {
    let _roots = roots.lock().map_err(|_| "roots lock poisoned")?;
    let _sessions = sessions.lock().map_err(|_| "sessions lock poisoned")?;
    drop(process);
    Ok(())
}

#[test]
fn post_spawn_registration_errors_do_not_orphan_real_children() {
    let mut orphaned = Vec::new();
    for poisoned in ["roots", "sessions"] {
        let roots = Mutex::new(());
        let sessions = Mutex::new(());
        poison(if poisoned == "roots" {
            &roots
        } else {
            &sessions
        });

        let sink = Arc::new(RecordingSink::default());
        let process = spawn(
            ProcessSpec::new(fake_prime())
                .args(["hold"])
                .session(format!("fixture-poisoned-{poisoned}"), 1),
            sink.clone(),
        )
        .expect("the explicit fake executable spawns");
        sink.until_json_kind("ready");

        let error = simulate_post_spawn_registration(process, &roots, &sessions)
            .expect_err("the selected registration lock is poisoned");
        assert!(error.contains(poisoned));
        match sink.exit_within(Duration::from_millis(500)) {
            Some(exit) if exit.cancelled => {}
            _ => orphaned.push(poisoned),
        }
    }

    assert!(
        orphaned.is_empty(),
        "post-spawn registration errors orphaned fake children for: {}",
        orphaned.join(", ")
    );
}

#[test]
fn launch_contract_uses_the_exact_executable_arguments_cwd_and_environment() {
    assert!(
        std::env::var_os("PATH").is_some(),
        "the parent must have a search path for this inheritance check"
    );
    #[cfg(windows)]
    assert!(
        std::env::var_os("PATHEXT").is_some(),
        "the Windows parent must have PATHEXT for this inheritance check"
    );
    let cwd = TempDir::new("launch");
    let sink = Arc::new(RecordingSink::default());
    let spec = ProcessSpec::new(fake_prime())
        .args([
            "launch-contract",
            "argument with spaces",
            "--literal=$VALUE",
        ])
        .cwd(&cwd.0)
        .env("HARNESS_MARKER", "exact-value")
        .session("fixture-launch", 3);

    let process = spawn(spec, sink.clone()).expect("the explicit fake executable spawns");
    let exit = process.wait_for_exit(WAIT).expect("the fake exits");
    assert_eq!(exit.code, Some(11));
    assert!(!exit.cancelled);

    let events = sink.until_exit();
    let contract = json_events(&events)[0];
    assert_eq!(
        Path::new(contract["executable"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        fake_prime().canonicalize().unwrap(),
        "the test never resolves node or an installed prime-agent"
    );
    assert_eq!(
        contract["args"],
        serde_json::json!(["argument with spaces", "--literal=$VALUE"])
    );
    assert_eq!(
        Path::new(contract["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        cwd.0.canonicalize().unwrap()
    );
    assert_eq!(
        contract["env"],
        serde_json::json!({ "HARNESS_MARKER": "exact-value" }),
        "PATH, provider keys, proxy settings, and every other parent variable are absent"
    );
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn launch_rejects_a_search_path_executable_before_process_creation() {
    let sink = Arc::new(RecordingSink::default());
    let result = spawn(
        ProcessSpec::new("fake-prime-jsonl").session("fixture-relative-executable", 1),
        sink,
    );
    let error = match result {
        Ok(_) => panic!("an executable search-path lookup must never be attempted"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("absolute"));
}

#[test]
fn framing_overflow_is_a_typed_terminal_fault_and_later_bytes_are_rejected() {
    const MAX_FRAME: usize = 96;
    let sink = Arc::new(RecordingSink::default());
    let spec = ProcessSpec::new(fake_prime())
        .args(["frames".to_string(), MAX_FRAME.to_string()])
        .max_frame_bytes(MAX_FRAME)
        .session("fixture-frames", 1);

    let process = spawn(spec, sink.clone()).expect("the fake spawns");
    let exit = process.wait_for_exit(WAIT).expect("the fake exits");
    assert!(
        exit.cancelled,
        "the runtime stops the protocol-unsafe child"
    );

    let events = sink.until_exit();
    let json = json_events(&events);
    assert_eq!(json.len(), 1, "later buffered bytes are never accepted");
    assert_eq!(json[0]["kind"], "boundary");
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::FrameTooLarge {
            stream: ProcessStream::Stdout,
            limit: MAX_FRAME,
        })
    )));
    assert_eq!(fault_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn framing_unterminated_overflow_faults_at_limit_plus_one_without_waiting_for_eof() {
    const MAX_FRAME: usize = 96;
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["unterminated-oversized".to_string(), MAX_FRAME.to_string()])
            .max_frame_bytes(MAX_FRAME)
            .session("fixture-unterminated-overflow", 1),
        sink.clone(),
    )
    .expect("the fake spawns");

    let fault_arrived = sink.wait_for_fault(Duration::from_secs(1));
    if !fault_arrived {
        process.cancel().expect("cleanup cancellation succeeds");
    }
    process.wait_for_exit(WAIT).expect("the fake exits");
    assert!(
        fault_arrived,
        "the reader waited for LF or EOF after retaining limit + 1 bytes"
    );
    let events = sink.until_exit();
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::FrameTooLarge {
            stream: ProcessStream::Stdout,
            limit: MAX_FRAME,
        })
    )));
    assert_eq!(fault_count(&events), 1);
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn framing_malformed_json_is_a_typed_terminal_fault() {
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["malformed-json"])
            .session("fixture-malformed-json", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    assert!(process.wait_for_exit(WAIT).unwrap().cancelled);

    let events = sink.until_exit();
    assert_eq!(json_events(&events).len(), 1);
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::MalformedJson { line, .. })
            if line == "not-json"
    )));
    assert_eq!(fault_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn framing_malformed_utf8_is_a_typed_terminal_fault() {
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["malformed-utf8"])
            .session("fixture-malformed-utf8", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    assert!(process.wait_for_exit(WAIT).unwrap().cancelled);

    let events = sink.until_exit();
    assert_eq!(json_events(&events).len(), 1);
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::MalformedUtf8 {
            stream: ProcessStream::Stdout,
        })
    )));
    assert_eq!(fault_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn framing_empty_or_whitespace_stdout_record_is_a_terminal_malformed_json_fault() {
    for (scenario, expected_line) in [("blank-record", ""), ("whitespace-record", " \t")] {
        let sink = Arc::new(RecordingSink::default());
        let process = spawn(
            ProcessSpec::new(fake_prime())
                .args([scenario])
                .session(format!("fixture-{scenario}"), 1),
            sink.clone(),
        )
        .expect("the fake spawns");

        let fault_arrived = sink.wait_for_fault(Duration::from_secs(1));
        if !fault_arrived {
            process.cancel().expect("cleanup cancellation succeeds");
        }
        process.wait_for_exit(WAIT).expect("the fake exits");
        assert!(
            fault_arrived,
            "{scenario} was silently skipped instead of rejected"
        );
        let events = sink.until_exit();
        assert!(events.iter().any(|event| matches!(
            event,
            ProcessEvent::ProtocolFault(ProtocolFault::MalformedJson { line, .. })
                if line == expected_line
        )));
        assert_eq!(fault_count(&events), 1);
        assert_eq!(terminal_count(&events), 1);
        assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
    }
}

#[test]
fn framing_rejects_an_outbound_command_over_the_encoded_byte_limit() {
    const MAX_FRAME: usize = 128;
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["hold"])
            .max_frame_bytes(MAX_FRAME)
            .session("fixture-outbound-bound", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    sink.until_json_kind("ready");

    let payload = "é".repeat(30);
    let predicted_wire = serde_json::to_string(&serde_json::json!({
        "type": "oversized",
        "id": "prime-studio/fixture-outbound-bound/1/1",
        "payload": &payload,
    }))
    .unwrap();
    assert!(predicted_wire.chars().count() <= MAX_FRAME);
    assert!(predicted_wire.len() > MAX_FRAME);
    let error = process
        .send(serde_json::json!({
            "type": "oversized",
            "id": "ui-oversized",
            "payload": payload,
        }))
        .expect_err("the encoded command must not reach the child");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    process.cancel().unwrap();
    let events = sink.until_exit();
    assert_eq!(terminal_count(&events), 1);
}

#[test]
fn lifecycle_cancel_does_not_wait_for_a_blocked_stdin_writer() {
    let temp = TempDir::new("blocked-stdin");
    let sentinel = temp.0.join("release-hostile-child");
    let sink = Arc::new(RecordingSink::default());
    let process = Arc::new(
        spawn(
            ProcessSpec::new(fake_prime())
                .args(["block-stdin", sentinel.to_string_lossy().as_ref()])
                .max_frame_bytes(8 * 1024 * 1024)
                .session("fixture-blocked-stdin", 1),
            sink.clone(),
        )
        .expect("the fake spawns"),
    );
    sink.until_json_kind("ready");

    let (send_tx, send_rx) = mpsc::channel();
    let sender = process.clone();
    std::thread::spawn(move || {
        let result = sender.send(serde_json::json!({
            "type": "fill-the-pipe",
            "id": "ui-blocked-write",
            "payload": "x".repeat(4 * 1024 * 1024),
        }));
        let _ = send_tx.send(result);
    });
    let send_was_blocked = send_rx.recv_timeout(Duration::from_millis(200)).is_err();

    let (cancel_tx, cancel_rx) = mpsc::channel();
    let canceller = process.clone();
    std::thread::spawn(move || {
        let _ = cancel_tx.send(canceller.cancel());
    });
    let cancel_before_cleanup = cancel_rx.recv_timeout(Duration::from_secs(1));
    let cancel_completed = cancel_before_cleanup.is_ok();

    std::fs::write(&sentinel, b"release").unwrap();
    let send_result = send_rx
        .recv_timeout(WAIT)
        .expect("blocked send is released");
    let cancel_result = match cancel_before_cleanup {
        Ok(result) => result,
        Err(_) => cancel_rx
            .recv_timeout(WAIT)
            .expect("cleanup eventually releases the old cancellation path"),
    };
    cancel_result.expect("cancellation succeeds");
    assert!(
        send_was_blocked,
        "the hostile child must fill its stdin pipe"
    );
    assert!(
        cancel_completed,
        "cancellation waited on the mutex held by the blocked writer"
    );
    assert!(
        send_result.is_err(),
        "killing the child releases the writer"
    );
    assert!(process.wait_for_exit(WAIT).is_some());
    assert_eq!(terminal_count(&sink.until_exit()), 1);
}

#[test]
fn lifecycle_output_eof_force_terminates_a_child_that_remains_alive() {
    let temp = TempDir::new("output-eof");
    let sentinel = temp.0.join("release-hostile-child");
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["close-output-hold", sentinel.to_string_lossy().as_ref()])
            .session("fixture-output-eof", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    sink.until_json_kind("ready");

    let exit_before_cleanup = process.wait_for_exit(Duration::from_secs(2));
    process.cancel().expect("late cancellation is idempotent");
    let exit_after_cancel = process.wait_for_exit(Duration::from_millis(200));

    std::fs::write(&sentinel, b"release").unwrap();
    let cleanup_exit = process
        .wait_for_exit(WAIT)
        .expect("the hostile fixture is always cleaned up");
    let exit = exit_before_cleanup
        .or(exit_after_cancel)
        .expect("output EOF left a live child with no cancellable handle");
    assert_eq!(exit, cleanup_exit);
    assert!(!exit.cancelled, "EOF is not reported as user cancellation");
    let events = sink.until_exit();
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn lifecycle_direct_child_exit_is_not_blocked_by_descendant_output_handles() {
    let temp = TempDir::new("inherited-output");
    let cleanup = temp.0.join("release-hostile-grandchild");
    let stopped = temp.0.join("hostile-grandchild-stopped");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sink = Arc::new(BlockingFirstJsonSink {
        events: Mutex::new(Vec::new()),
        changed: Condvar::new(),
        first_json: Mutex::new(true),
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args([
                "exit-with-inheriting-grandchild",
                cleanup.to_string_lossy().as_ref(),
                stopped.to_string_lossy().as_ref(),
            ])
            .session("fixture-inherited-output", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    process
        .send(serde_json::json!({ "type": "start-grandchild", "id": "ui-start" }))
        .expect("the process starts only after containment is installed");

    entered_rx
        .recv_timeout(WAIT)
        .expect("the first direct-child payload reached the sink");
    let premature_exit = process.wait_for_exit(Duration::from_millis(200));
    release_tx
        .send(())
        .expect("the blocked callback remains alive");
    let natural = process.wait_for_exit(Duration::from_secs(2));
    if natural.is_none() {
        process
            .cancel()
            .expect("the old path is cancellable for fixture cleanup");
        std::fs::write(&cleanup, b"release").unwrap();
        assert!(
            wait_for_path(&stopped, WAIT),
            "the hostile grandchild did not release during fallback cleanup"
        );
    }

    assert!(
        premature_exit.is_none(),
        "terminal state was published before buffered direct-child payload drained"
    );
    let exit = natural.expect("direct-child exit waited for descendant pipe EOF");
    assert!(
        !cleanup.exists() && !stopped.exists(),
        "normal completion must contain and terminate the descendant without fixture cleanup"
    );
    assert_eq!(exit.code, Some(26));
    assert!(!exit.cancelled);
    let events = sink.until_exit();
    assert_eq!(
        json_events(&events)
            .iter()
            .map(|value| value["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["direct-first", "direct-final"]
    );
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn request_ids_are_session_generation_scoped_and_random_unless_fixture_fixed() {
    let mut fixed = RequestTracker::fixture("session-a", 7, 8);
    assert_eq!(
        fixed.prepare("ui-1"),
        "prime-studio/session-a/7/1",
        "fixture scopes make integration assertions deterministic"
    );
    assert_eq!(fixed.prepare("ui-2"), "prime-studio/session-a/7/2");

    let mut next_generation = RequestTracker::fixture("session-a", 8, 8);
    assert_ne!(
        next_generation.prepare("ui-1"),
        "prime-studio/session-a/7/1"
    );

    let mut random_a = RequestTracker::random("session-a", 7, 8);
    let mut random_b = RequestTracker::random("session-a", 7, 8);
    assert_ne!(
        random_a.prepare("ui-1"),
        random_b.prepare("ui-1"),
        "separate live sessions cannot collide after process restart"
    );
}

#[test]
fn request_tombstones_classify_identical_duplicate_conflict_late_unknown_and_malformed() {
    let mut tracker = RequestTracker::fixture("session-a", 7, 2);
    let completed = tracker.prepare("ui-completed");
    let cancelled = tracker.prepare("ui-cancelled");

    let completed_response =
        serde_json::json!({ "type": "response", "id": completed, "data": "stable" });
    let mut current = completed_response.clone();
    assert_eq!(
        tracker.classify_response(&mut current),
        ResponseDisposition::Current {
            client_id: "ui-completed".into()
        }
    );
    assert_eq!(
        current["id"], "ui-completed",
        "wire id is hidden from the UI"
    );

    let mut duplicate = completed_response;
    assert_eq!(
        tracker.classify_response(&mut duplicate),
        ResponseDisposition::Duplicate
    );
    let mut conflict =
        serde_json::json!({ "type": "response", "id": completed, "data": "changed" });
    assert_eq!(
        tracker.classify_response(&mut conflict),
        ResponseDisposition::Fault(ResponseFault::ConflictingDuplicate)
    );

    assert!(tracker.cancel(&cancelled));
    let mut late_cancelled = serde_json::json!({ "type": "response", "id": cancelled });
    assert_eq!(
        tracker.classify_response(&mut late_cancelled),
        ResponseDisposition::Rejected(ResponseRejection::Late)
    );

    let mut old_generation =
        serde_json::json!({ "type": "response", "id": "prime-studio/session-a/6/99" });
    assert_eq!(
        tracker.classify_response(&mut old_generation),
        ResponseDisposition::Rejected(ResponseRejection::Late)
    );
    let mut unknown = serde_json::json!({ "type": "response", "id": "foreign-id" });
    assert_eq!(
        tracker.classify_response(&mut unknown),
        ResponseDisposition::Rejected(ResponseRejection::Unknown)
    );
    let mut malformed = serde_json::json!({ "type": "response" });
    assert_eq!(
        tracker.classify_response(&mut malformed),
        ResponseDisposition::Fault(ResponseFault::Malformed)
    );
    assert!(tracker.tombstone_len() <= 2, "tombstones are hard bounded");

    let pending = tracker.prepare("ui-pending");
    tracker.retire_all();
    assert!(tracker.tombstone_len() <= 2, "tombstones stay hard bounded");
    let mut after_exit = serde_json::json!({ "type": "response", "id": pending });
    assert_eq!(
        tracker.classify_response(&mut after_exit),
        ResponseDisposition::Rejected(ResponseRejection::Late)
    );
}

#[test]
fn request_responses_may_arrive_out_of_order_and_identical_duplicates_are_idempotent() {
    let sink = Arc::new(RecordingSink::default());
    let spec = ProcessSpec::new(fake_prime())
        .args(["responses-reversed"])
        .session("fixture-requests", 9);
    let process = spawn(spec, sink.clone()).expect("the fake spawns");

    process
        .send(serde_json::json!({ "type": "first", "id": "ui-a" }))
        .unwrap();
    process
        .send(serde_json::json!({ "type": "second", "id": "ui-b" }))
        .unwrap();
    assert_eq!(process.wait_for_exit(WAIT).unwrap().code, Some(19));

    let events = sink.until_exit();
    let response_ids: Vec<_> = json_events(&events)
        .into_iter()
        .filter(|event| event["type"] == "response")
        .map(|event| event["id"].as_str().unwrap())
        .collect();
    assert_eq!(response_ids, ["ui-b", "ui-a"]);
    for reason in [ResponseRejection::Late, ResponseRejection::Unknown] {
        assert!(events.iter().any(|event| matches!(
            event,
            ProcessEvent::ProtocolError(ProtocolError::ResponseRejected { reason: got, .. })
                if *got == reason
        )));
    }
    assert!(json_events(&events)
        .iter()
        .any(|event| event["kind"] == "after-rejections"));
    assert_eq!(fault_count(&events), 0);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn request_conflicting_duplicate_is_a_terminal_protocol_fault() {
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["response-conflict"])
            .session("fixture-response-conflict", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    process
        .send(serde_json::json!({ "type": "request", "id": "ui-current" }))
        .unwrap();
    assert!(process.wait_for_exit(WAIT).unwrap().cancelled);

    let events = sink.until_exit();
    let json = json_events(&events);
    assert_eq!(
        json.iter()
            .filter(|event| event["type"] == "response")
            .count(),
        1
    );
    assert!(!json.iter().any(|event| event["kind"] == "after-fault"));
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::ConflictingDuplicate { .. })
    )));
    assert_eq!(fault_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn request_send_from_the_terminal_fault_boundary_is_rejected() {
    let sink = Arc::new(ReentrantFaultSink::default());
    let process = Arc::new(
        spawn(
            ProcessSpec::new(fake_prime())
                .args(["response-conflict"])
                .session("fixture-no-send-after-fault", 1),
            sink.clone(),
        )
        .expect("the fake spawns"),
    );
    *sink.process.lock().unwrap() = Some(process.clone());
    process
        .send(serde_json::json!({ "type": "request", "id": "ui-current" }))
        .unwrap();
    assert!(process.wait_for_exit(WAIT).unwrap().cancelled);

    let result = sink
        .send_after_fault
        .lock()
        .unwrap()
        .take()
        .expect("the terminal fault attempted a reentrant send");
    let error = result.expect_err("a quarantined session cannot accept another request");
    assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    let events = sink.events.lock().unwrap();
    assert_eq!(fault_count(&events), 1);
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn lifecycle_sink_can_reenter_cancel_and_observe_exit_without_deadlock() {
    let (outcome_tx, outcome_rx) = mpsc::channel();
    let sink = Arc::new(ReentrantCancelSink {
        events: Mutex::new(Vec::new()),
        changed: Condvar::new(),
        process: Mutex::new(None),
        outcome: Mutex::new(Some(outcome_tx)),
    });
    let process = Arc::new(
        spawn(
            ProcessSpec::new(fake_prime())
                .args(["response-conflict"])
                .session("fixture-reentrant-cancel", 1),
            sink.clone(),
        )
        .expect("the fake spawns"),
    );
    *sink.process.lock().unwrap() = Some(process.clone());
    process
        .send(serde_json::json!({ "type": "request", "id": "ui-current" }))
        .unwrap();

    let outcome = outcome_rx.recv_timeout(Duration::from_secs(2));
    if outcome.is_err() {
        let _ = process.cancel();
    }
    let (cancel, observed_exit) = outcome.expect("sink reentrant cancellation deadlocked");
    cancel.expect("reentrant cancellation succeeds");
    assert!(
        observed_exit.is_some(),
        "terminal state is stored before Exited delivery"
    );
    assert!(process.wait_for_exit(WAIT).is_some());
    let events = sink.events.lock().unwrap();
    let (events, timeout) = sink
        .changed
        .wait_timeout_while(events, WAIT, |events| terminal_count(events) == 0)
        .unwrap();
    assert!(
        !timeout.timed_out(),
        "Exited delivery never followed callback"
    );
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn request_missing_sequence_id_is_a_terminal_protocol_fault() {
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["response-malformed"])
            .session("fixture-response-malformed", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    assert!(process.wait_for_exit(WAIT).unwrap().cancelled);

    let events = sink.until_exit();
    assert!(json_events(&events).is_empty());
    assert!(events.iter().any(|event| matches!(
        event,
        ProcessEvent::ProtocolFault(ProtocolFault::MalformedResponse { .. })
    )));
    assert_eq!(fault_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

fn terminal_count(events: &[ProcessEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ProcessEvent::Exited(_)))
        .count()
}

fn fault_count(events: &[ProcessEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ProcessEvent::ProtocolFault(_)))
        .count()
}

#[test]
fn lifecycle_cancel_is_idempotent_and_terminal_is_exactly_once_and_last() {
    let sink = Arc::new(RecordingSink::default());
    let process = Arc::new(
        spawn(
            ProcessSpec::new(fake_prime())
                .args(["hold"])
                .session("fixture-cancel", 1),
            sink.clone(),
        )
        .expect("the fake spawns"),
    );
    sink.until_json_kind("ready");

    let callers = 4;
    let barrier = Arc::new(Barrier::new(callers + 1));
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for _ in 0..callers {
            let process = process.clone();
            let barrier = barrier.clone();
            joins.push(scope.spawn(move || {
                barrier.wait();
                process.cancel()
            }));
        }
        barrier.wait();
        for join in joins {
            join.join()
                .unwrap()
                .expect("duplicate cancel is idempotent");
        }
    });

    let exit = process.wait_for_exit(WAIT).expect("cancelled child exits");
    assert!(exit.cancelled);
    let events = sink.until_exit();
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
    assert!(!json_events(&events)
        .iter()
        .any(|event| event["kind"] == "after-input-closed"));
}

#[test]
fn lifecycle_input_eof_and_cancel_race_has_one_linearized_outcome() {
    let sink = Arc::new(RecordingSink::default());
    let process = Arc::new(
        spawn(
            ProcessSpec::new(fake_prime())
                .args(["hold"])
                .session("fixture-eof-race", 1),
            sink.clone(),
        )
        .expect("the fake spawns"),
    );
    sink.until_json_kind("ready");

    let barrier = Arc::new(Barrier::new(3));
    std::thread::scope(|scope| {
        let close = {
            let process = process.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                process.close_input()
            })
        };
        let cancel = {
            let process = process.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                process.cancel()
            })
        };
        barrier.wait();
        close.join().unwrap().expect("closing input is idempotent");
        cancel.join().unwrap().expect("cancellation is idempotent");
    });

    process
        .wait_for_exit(WAIT)
        .expect("race reaches a terminal state");
    let events = sink.until_exit();
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}

#[test]
fn lifecycle_cancel_after_natural_exit_does_not_duplicate_terminal_or_reopen_input() {
    let sink = Arc::new(RecordingSink::default());
    let process = spawn(
        ProcessSpec::new(fake_prime())
            .args(["launch-contract"])
            .env("ONLY", "fixture")
            .session("fixture-already-exited", 1),
        sink.clone(),
    )
    .expect("the fake spawns");
    let natural = process
        .wait_for_exit(WAIT)
        .expect("the fake exits naturally");
    assert!(!natural.cancelled);

    process.cancel().expect("late cancellation is a no-op");
    process.close_input().expect("late close is a no-op");
    let events = sink.until_exit();
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(events.last(), Some(ProcessEvent::Exited(_))));
}
