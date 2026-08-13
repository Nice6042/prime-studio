use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::Barrier;
use std::thread;

use prime_studio_lib::chat_display::{ChatDisplayAuthority, MAX_CHAT_DISPLAY_BYTES};
use prime_studio_lib::project_catalog::{ProjectCatalog, ProjectChatCommand};
use serde_json::json;
use uuid::Uuid;

const CHILD_MODE: &str = "PRIME_CHAT_DISPLAY_CHILD_MODE";
const CHILD_ROOT: &str = "PRIME_CHAT_DISPLAY_CHILD_ROOT";
const CHILD_OUTPUT: &str = "PRIME_CHAT_DISPLAY_CHILD_OUTPUT";

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "prime-studio-chat-display-{label}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&path).expect("create isolated chat-display directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn catalog_with_chat(root: &Path, chat_id: &str) -> Arc<ProjectCatalog> {
    let catalog = Arc::new(ProjectCatalog::new(root.join("projects-v2.json")));
    let command: ProjectChatCommand = serde_json::from_value(json!({
        "type": "chat.create",
        "projectId": "project:personal",
        "chatId": chat_id,
        "title": "Canvas chat"
    }))
    .expect("valid test catalog command");
    catalog
        .apply(0, command)
        .expect("create durable catalog chat");
    catalog
}

#[test]
fn chat_display_process_child() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let root = PathBuf::from(std::env::var_os(CHILD_ROOT).expect("child root"));
    let output = PathBuf::from(std::env::var_os(CHILD_OUTPUT).expect("child output"));
    let catalog = Arc::new(ProjectCatalog::new(root.join("projects-v2.json")));
    let authority = ChatDisplayAuthority::new(root.join("chat-display-v1.json"), catalog);
    let transcript = root.join("session.jsonl");
    let transcript_before =
        fs::read(&transcript).expect("child reads transcript before authority use");
    match mode.as_str() {
        "writer" => {
            let committed = authority
                .apply(
                    1,
                    "chat:one",
                    "answer:one",
                    "Original answer",
                    "Studio-only revision",
                )
                .expect("writer commits display revision");
            fs::write(output, serde_json::to_vec(&committed).unwrap()).unwrap();
        }
        "reader" => {
            let snapshot = authority.load().expect("reader loads display revision");
            fs::write(output, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        }
        other => panic!("unexpected child mode {other}"),
    }
    assert_eq!(fs::read(transcript).unwrap(), transcript_before);
}

fn run_child(mode: &str, root: &Path, output: &Path) {
    let status = Command::new(std::env::current_exe().expect("resolve integration test binary"))
        .arg("--exact")
        .arg("chat_display_process_child")
        .arg("--test-threads=1")
        .env(CHILD_MODE, mode)
        .env(CHILD_ROOT, root)
        .env(CHILD_OUTPUT, output)
        .status()
        .expect("launch isolated chat-display process");
    assert!(status.success(), "{mode} child must exit successfully");
}

#[test]
fn process_restart_hydrates_the_exact_committed_display_revision_without_rewriting_transcript() {
    let root = TestDirectory::new("restart");
    drop(catalog_with_chat(root.path(), "chat:one"));
    let transcript = root.path().join("session.jsonl");
    let transcript_bytes = br#"{"role":"assistant","content":"original"}\n"#;
    fs::write(&transcript, transcript_bytes).expect("write transcript fixture");
    let writer_output = root.path().join("writer.json");
    let reader_output = root.path().join("reader.json");

    run_child("writer", root.path(), &writer_output);
    let committed: prime_studio_lib::chat_display::ChatDisplayRecord =
        serde_json::from_slice(&fs::read(&writer_output).unwrap()).unwrap();
    assert_eq!(committed.revision, 2);
    run_child("reader", root.path(), &reader_output);
    let snapshot: prime_studio_lib::chat_display::ChatDisplaySnapshot =
        serde_json::from_slice(&fs::read(&reader_output).unwrap()).unwrap();
    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.records, [committed]);
    assert_eq!(
        fs::read(transcript).expect("read transcript fixture"),
        transcript_bytes
    );
}

#[test]
fn stale_cas_and_unknown_catalog_chat_fail_closed_without_changing_committed_bytes() {
    let root = TestDirectory::new("cas");
    let catalog = catalog_with_chat(root.path(), "chat:one");
    let path = root.path().join("chat-display-v1.json");
    let authority = ChatDisplayAuthority::new(path.clone(), catalog);
    authority
        .apply(1, "chat:one", "answer:one", "original", "revision two")
        .unwrap();
    let committed = fs::read(&path).expect("read committed display bytes");

    assert_eq!(
        authority
            .apply(1, "chat:one", "answer:one", "original", "stale overwrite")
            .unwrap_err()
            .code(),
        "revisionConflict"
    );
    assert_eq!(
        authority
            .apply(1, "chat:missing", "answer:one", "original", "unknown chat")
            .unwrap_err()
            .code(),
        "unknownChat"
    );
    assert_eq!(
        fs::read(path).expect("read unchanged display bytes"),
        committed
    );
}

#[test]
fn an_existing_revision_rejects_a_forged_source_version_without_changing_bytes() {
    let root = TestDirectory::new("source-cas");
    let catalog = catalog_with_chat(root.path(), "chat:one");
    let path = root.path().join("chat-display-v1.json");
    let authority = ChatDisplayAuthority::new(path.clone(), catalog);
    authority
        .apply(1, "chat:one", "answer:one", "version one", "revision two")
        .unwrap();
    let committed = fs::read(&path).unwrap();
    assert_eq!(
        authority
            .apply(
                2,
                "chat:one",
                "answer:one",
                "version two",
                "forged revision"
            )
            .unwrap_err()
            .code(),
        "revisionConflict"
    );
    assert_eq!(fs::read(path).unwrap(), committed);
}

#[test]
fn independent_authority_instances_serialize_cas_and_admit_only_one_successor() {
    let root = TestDirectory::new("concurrent-cas");
    let catalog = catalog_with_chat(root.path(), "chat:one");
    let path = root.path().join("chat-display-v1.json");
    let barrier = Arc::new(Barrier::new(3));
    let workers = ["first", "second"].map(|content| {
        let path = path.clone();
        let catalog = catalog.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            let authority = ChatDisplayAuthority::new(path, catalog);
            barrier.wait();
            authority.apply(1, "chat:one", "answer:one", "original", content)
        })
    });
    barrier.wait();
    let outcomes = workers.map(|worker| worker.join().expect("display writer exits"));
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter_map(|outcome| outcome.as_ref().err())
            .map(|error| error.code())
            .collect::<Vec<_>>(),
        ["revisionConflict"]
    );
    let restarted = ChatDisplayAuthority::new(path, catalog);
    let record = restarted
        .load()
        .unwrap()
        .records
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(record.revision, 2);
    assert!(["first", "second"].contains(&record.content.as_str()));
}

#[test]
fn malformed_oversized_duplicate_and_control_hostile_state_is_rejected_and_preserved() {
    let cases = [
        ("malformed", br#"{"schemaVersion":1,"records":["#.to_vec()),
        ("duplicate", br#"{"schemaVersion":1,"records":[{"chatId":"chat:one","messageId":"answer:one","revision":2,"sourceContent":"original","content":"a"},{"chatId":"chat:one","messageId":"answer:one","revision":3,"sourceContent":"original","content":"b"}]}"#.to_vec()),
        ("control", br#"{"schemaVersion":1,"records":[{"chatId":"chat:one","messageId":"answer:\u0000one","revision":2,"sourceContent":"original","content":"a"}]}"#.to_vec()),
        ("oversized", vec![b' '; MAX_CHAT_DISPLAY_BYTES + 1]),
    ];
    for (label, bytes) in cases {
        let root = TestDirectory::new(label);
        let catalog = catalog_with_chat(root.path(), "chat:one");
        let path = root.path().join("chat-display-v1.json");
        fs::write(&path, &bytes).expect("write hostile display bytes");
        let authority = ChatDisplayAuthority::new(path.clone(), catalog);
        assert_eq!(
            authority.load().unwrap_err().code(),
            "recoveryRequired",
            "{label}"
        );
        assert_eq!(
            fs::read(path).expect("read preserved hostile bytes"),
            bytes,
            "{label}"
        );
    }
}

#[test]
fn apply_rejects_invalid_identifiers_content_controls_and_non_successor_revisions() {
    let root = TestDirectory::new("input-bounds");
    let catalog = catalog_with_chat(root.path(), "chat:one");
    let authority = ChatDisplayAuthority::new(root.path().join("chat-display-v1.json"), catalog);

    for (chat_id, message_id, content, revision) in [
        (" chat:one", "answer:one", "content", 1),
        ("chat:one", "answer:\u{0}one", "content", 1),
        ("chat:one", "answer:one", "bad\u{0}content", 1),
        ("chat:one", "answer:one", "bidirectional \u{202e}content", 1),
        ("chat:one", "answer:one", "content", 0),
        ("chat:one", "answer:one", "content", 9_007_199_254_740_991),
    ] {
        assert_eq!(
            authority
                .apply(revision, chat_id, message_id, "original", content)
                .unwrap_err()
                .code(),
            "invalidInput"
        );
    }
}

#[cfg(windows)]
#[test]
fn reparse_ancestor_is_rejected_before_lock_or_display_state_can_be_created() {
    let root = TestDirectory::new("reparse");
    let outside = root.path().join("outside");
    let alias = root.path().join("alias");
    fs::create_dir(&outside).expect("create outside directory");
    std::os::windows::fs::symlink_dir(&outside, &alias).expect("create directory reparse fixture");
    let catalog = Arc::new(ProjectCatalog::new(outside.join("projects-v2.json")));

    let authority = ChatDisplayAuthority::new(alias.join("chat-display-v1.json"), catalog);
    assert_eq!(authority.load().unwrap_err().code(), "recoveryRequired");
    assert_eq!(
        fs::read_dir(outside)
            .expect("enumerate outside target")
            .count(),
        1,
        "only catalog lock provisioning may exist; display authority must not cross alias"
    );
}
