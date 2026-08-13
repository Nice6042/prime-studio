use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use prime_studio_lib::project_catalog::{
    CatalogSnapshot, ProjectCatalog, ProjectChat, ProjectChatCommand,
};
use serde_json::{json, Value};
use uuid::Uuid;

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "prime-studio-project-catalog-{label}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&path).expect("create isolated catalog test directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn command(value: Value) -> ProjectChatCommand {
    serde_json::from_value(value).expect("test command matches the closed wire contract")
}

fn create_project(project_id: &str, name: &str, folder: &Path) -> ProjectChatCommand {
    command(json!({
        "type": "project.create",
        "projectId": project_id,
        "name": name,
        "folderPath": folder,
    }))
}

fn project_ids(snapshot: &CatalogSnapshot) -> Vec<&str> {
    snapshot
        .state
        .projects
        .iter()
        .map(|project| project.id.as_str())
        .collect()
}

#[test]
fn rust_initial_state_matches_the_task_one_canonical_v2_wire_fixture() {
    const TASK_ONE_INITIAL_STATE: &str =
        "{\"schemaVersion\":2,\"selectedProjectId\":\"project:personal\",\"projects\":[{\"id\":\"project:personal\",\"kind\":\"personal\",\"name\":\"Personal\",\"root\":{\"kind\":\"studio-managed-empty\"},\"pinned\":false,\"archived\":false,\"selectedChatId\":null,\"chats\":[]}]}";

    let root = TestDirectory::new("wire-fixture");
    let initial = ProjectCatalog::new(root.path().join("projects-v2.json"))
        .load()
        .expect("initial snapshot");
    assert_eq!(
        serde_json::to_string(&initial.state).expect("serialize Rust initial state"),
        TASK_ONE_INITIAL_STATE
    );
    assert_eq!(
        serde_json::from_str::<prime_studio_lib::project_catalog::ProjectChatState>(
            TASK_ONE_INITIAL_STATE
        )
        .expect("Rust accepts the Task 1 canonical fixture"),
        initial.state
    );
}

fn apply_json(catalog: &ProjectCatalog, revision: u64, value: Value) -> CatalogSnapshot {
    catalog
        .apply(revision, command(value))
        .expect("valid catalog command applies")
}

fn snapshot_value(snapshot: &CatalogSnapshot) -> Value {
    serde_json::to_value(snapshot).expect("catalog snapshot serializes")
}

fn write_value(path: &Path, value: &Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(value).expect("test catalog serializes");
    fs::write(path, &bytes).expect("write test catalog");
    bytes
}

fn assert_recovery_preserves(path: &Path, bytes: &[u8]) {
    let error = ProjectCatalog::new(path.to_path_buf())
        .load()
        .expect_err("hostile durable state requires recovery");
    assert_eq!(error.code(), "recoveryRequired");
    assert_eq!(fs::read(path).expect("read preserved hostile bytes"), bytes);
}

fn wait_until(label: &str, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !predicate() {
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link).expect("create directory reparse fixture");
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).expect("create file reparse fixture");
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create file symlink fixture");
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create directory symlink fixture");
}

#[cfg(windows)]
fn remove_directory_symlink(link: &Path) {
    fs::remove_dir(link).expect("remove directory reparse fixture");
}

#[cfg(unix)]
fn remove_directory_symlink(link: &Path) {
    fs::remove_file(link).expect("remove directory symlink fixture");
}

#[test]
fn a_reparse_ancestor_is_rejected_before_catalog_startup_mutates_its_target() {
    let root = TestDirectory::new("catalog-root-reparse-ancestor");
    let outside = root.path().join("outside");
    let alias = root.path().join("alias");
    fs::create_dir(&outside).expect("create outside target");
    create_directory_symlink(&outside, &alias);

    let catalog = ProjectCatalog::new(alias.join("projects-v2.json"));
    assert!(
        catalog.load().is_err(),
        "a catalog root reached through a reparse ancestor is never admitted"
    );
    assert_eq!(
        fs::read_dir(&outside)
            .expect("enumerate untouched outside target")
            .count(),
        0,
        "startup must not provision a lock through a reparse ancestor"
    );
}

#[test]
fn first_load_exact_revision_cas_and_restart_preserve_the_committed_snapshot() {
    let root = TestDirectory::new("restart");
    let folder = root.path().join("repo");
    fs::create_dir(&folder).expect("create project folder");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());

    let initial = catalog.load().expect("missing catalog has initial state");
    assert_eq!(initial.revision, 0);
    assert_eq!(project_ids(&initial), ["project:personal"]);
    assert!(
        !path.exists(),
        "a read-only first load must not create state"
    );

    let first = catalog
        .apply(0, create_project("p1", "Repo", &folder))
        .expect("the exact current revision commits");
    assert_eq!(first.revision, 1);
    assert_eq!(project_ids(&first), ["project:personal", "p1"]);

    let stale = catalog
        .apply(
            0,
            command(json!({
                "type": "project.rename",
                "projectId": "p1",
                "name": "Stale",
            })),
        )
        .expect_err("a stale caller cannot overwrite the committed state");
    assert_eq!(stale.code(), "revisionConflict");

    drop(catalog);
    assert_eq!(
        ProjectCatalog::new(path)
            .load()
            .expect("restart loads the durable state"),
        first
    );
}

#[test]
fn corrupt_catalog_bytes_fail_closed_and_remain_byte_identical() {
    let root = TestDirectory::new("corruption");
    let path = root.path().join("projects-v2.json");
    let corrupt = b"{\"revision\":1,\"state\":\xff}";
    fs::write(&path, corrupt).expect("write hostile catalog bytes");
    let catalog = ProjectCatalog::new(path.clone());

    let load_error = catalog
        .load()
        .expect_err("invalid UTF-8 cannot become default state");
    assert_eq!(load_error.code(), "recoveryRequired");
    assert_eq!(fs::read(&path).expect("read preserved catalog"), corrupt);

    let apply_error = catalog
        .apply(
            1,
            command(json!({
                "type": "selection.select-project",
                "projectId": "project:personal",
            })),
        )
        .expect_err("mutation cannot replace corrupt durable state");
    assert_eq!(apply_error.code(), "recoveryRequired");
    assert_eq!(fs::read(path).expect("read preserved catalog"), corrupt);
}

#[test]
fn catalog_symlink_leaf_never_adopts_external_bytes_as_authority() {
    let root = TestDirectory::new("catalog-symlink");
    let path = root.path().join("projects-v2.json");
    let external = root.path().join("external.json");
    let initial = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    let bytes = serde_json::to_vec(&initial).expect("serialize valid external bytes");
    fs::write(&external, &bytes).expect("write external catalog-shaped file");
    create_file_symlink(&external, &path);

    let error = ProjectCatalog::new(path)
        .load()
        .expect_err("catalog authority cannot cross a reparse leaf");
    assert_eq!(error.code(), "recoveryRequired");
    assert_eq!(
        fs::read(external).expect("external file remains intact"),
        bytes
    );
}

#[test]
fn concurrent_catalog_instances_allow_only_one_writer_for_an_expected_revision() {
    let root = TestDirectory::new("concurrent");
    let first_folder = root.path().join("first");
    let second_folder = root.path().join("second");
    fs::create_dir(&first_folder).expect("create first project folder");
    fs::create_dir(&second_folder).expect("create second project folder");
    let path = root.path().join("projects-v2.json");

    let barrier = Arc::new(Barrier::new(3));
    let writers = [
        ("p1", "First", first_folder),
        ("p2", "Second", second_folder),
    ]
    .into_iter()
    .map(|(project_id, name, folder)| {
        let barrier = Arc::clone(&barrier);
        let catalog = ProjectCatalog::new(path.clone());
        thread::spawn(move || {
            barrier.wait();
            catalog.apply(0, create_project(project_id, name, &folder))
        })
    })
    .collect::<Vec<_>>();

    barrier.wait();
    let results = writers
        .into_iter()
        .map(|writer| writer.join().expect("writer thread did not panic"))
        .collect::<Vec<_>>();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .filter(|error| error.code() == "revisionConflict")
            .count(),
        1
    );
    let durable = ProjectCatalog::new(path)
        .load()
        .expect("the winning writer leaves a valid catalog");
    assert_eq!(durable.revision, 1);
    assert_eq!(durable.state.projects.len(), 2);
}

#[test]
fn project_commands_preserve_personal_and_live_selection_invariants() {
    let root = TestDirectory::new("project-commands");
    let folder = root.path().join("repo");
    fs::create_dir(&folder).expect("create project folder");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));

    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": folder,
        }),
    );
    let pinned = apply_json(
        &catalog,
        created.revision,
        json!({ "type": "project.set-pinned", "projectId": "p1", "pinned": true }),
    );
    assert!(pinned.state.projects[1].pinned);

    let archived = apply_json(
        &catalog,
        pinned.revision,
        json!({ "type": "project.archive", "projectId": "p1" }),
    );
    assert!(archived.state.projects[1].archived);
    assert_eq!(archived.state.selected_project_id, "project:personal");

    let restored = apply_json(
        &catalog,
        archived.revision,
        json!({ "type": "project.restore", "projectId": "p1" }),
    );
    let selected = apply_json(
        &catalog,
        restored.revision,
        json!({ "type": "selection.select-project", "projectId": "p1" }),
    );
    assert_eq!(selected.state.selected_project_id, "p1");

    let immutable = catalog
        .apply(
            selected.revision,
            command(json!({
                "type": "project.rename",
                "projectId": "project:personal",
                "name": "Mine",
            })),
        )
        .expect_err("Personal cannot be renamed");
    assert_eq!(immutable.code(), "invalidCommand");
    assert_eq!(catalog.load().expect("catalog remains readable"), selected);
}

#[test]
fn chat_commands_enforce_global_ownership_and_deterministic_live_selection() {
    let root = TestDirectory::new("chat-commands");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));

    let first = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "First",
        }),
    );
    let second = apply_json(
        &catalog,
        first.revision,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c2",
            "title": "Second",
        }),
    );
    let renamed = apply_json(
        &catalog,
        second.revision,
        json!({
            "type": "chat.rename",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "Renamed",
        }),
    );
    let pinned = apply_json(
        &catalog,
        renamed.revision,
        json!({
            "type": "chat.set-pinned",
            "projectId": "project:personal",
            "chatId": "c1",
            "pinned": true,
        }),
    );
    let selected = apply_json(
        &catalog,
        pinned.revision,
        json!({
            "type": "selection.select-chat",
            "projectId": "project:personal",
            "chatId": "c1",
        }),
    );
    let archived = apply_json(
        &catalog,
        selected.revision,
        json!({
            "type": "chat.archive",
            "projectId": "project:personal",
            "chatId": "c1",
        }),
    );
    assert_eq!(
        archived.state.projects[0].selected_chat_id.as_deref(),
        Some("c2")
    );
    assert!(archived.state.projects[0].chats[0].archived);

    let restored = apply_json(
        &catalog,
        archived.revision,
        json!({
            "type": "chat.restore",
            "projectId": "project:personal",
            "chatId": "c1",
        }),
    );
    assert_eq!(restored.state.projects[0].chats[0].title, "Renamed");
    assert!(restored.state.projects[0].chats[0].pinned);

    let duplicate = catalog
        .apply(
            restored.revision,
            command(json!({
                "type": "chat.create",
                "projectId": "project:personal",
                "chatId": "c1",
                "title": "Duplicate",
            })),
        )
        .expect_err("chat ids are globally unique");
    assert_eq!(duplicate.code(), "invalidCommand");
}

#[test]
fn prime_binding_is_immutable_except_for_an_identical_idempotent_replay() {
    let root = TestDirectory::new("binding");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "First",
        }),
    );
    let binding = json!({
        "kind": "prime-session",
        "accountId": "account-1",
        "sessionId": "session-1",
        "sessionFile": "session-1.jsonl",
        "agentId": "agent-1",
    });
    let bound = apply_json(
        &catalog,
        created.revision,
        json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": binding,
        }),
    );
    assert_eq!(
        bound.state.projects[0].chats[0]
            .binding
            .as_ref()
            .unwrap()
            .session_id,
        "session-1"
    );

    let replayed = apply_json(
        &catalog,
        bound.revision,
        json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": binding,
        }),
    );
    assert_eq!(replayed, bound, "an identical replay performs no write");

    let conflict = catalog
        .apply(
            bound.revision,
            command(json!({
                "type": "chat.bind-prime-session",
                "projectId": "project:personal",
                "chatId": "c1",
                "binding": {
                    "kind": "prime-session",
                    "accountId": "account-1",
                    "sessionId": "other",
                    "sessionFile": "other.jsonl",
                    "agentId": "agent-1",
                },
            })),
        )
        .expect_err("a bound chat cannot change durable Prime identity");
    assert_eq!(conflict.code(), "invalidCommand");
    assert_eq!(catalog.load().expect("binding remains readable"), bound);
}

#[test]
fn every_command_variant_rejects_unknown_fields() {
    let commands = [
        json!({ "type": "project.create", "projectId": "p", "name": "P", "folderPath": "x", "extra": 1 }),
        json!({ "type": "chat.create", "projectId": "p", "chatId": "c", "title": "C", "extra": 1 }),
        json!({ "type": "chat.bind-prime-session", "projectId": "p", "chatId": "c", "binding": { "kind": "prime-session", "accountId": null, "sessionId": "s", "sessionFile": "s.jsonl", "agentId": null }, "extra": 1 }),
        json!({ "type": "project.rename", "projectId": "p", "name": "P", "extra": 1 }),
        json!({ "type": "project.archive", "projectId": "p", "extra": 1 }),
        json!({ "type": "project.restore", "projectId": "p", "extra": 1 }),
        json!({ "type": "project.set-pinned", "projectId": "p", "pinned": true, "extra": 1 }),
        json!({ "type": "chat.rename", "projectId": "p", "chatId": "c", "title": "C", "extra": 1 }),
        json!({ "type": "chat.archive", "projectId": "p", "chatId": "c", "extra": 1 }),
        json!({ "type": "chat.restore", "projectId": "p", "chatId": "c", "extra": 1 }),
        json!({ "type": "chat.set-pinned", "projectId": "p", "chatId": "c", "pinned": true, "extra": 1 }),
        json!({ "type": "selection.select-project", "projectId": "p", "extra": 1 }),
        json!({ "type": "selection.select-chat", "projectId": "p", "chatId": "c", "extra": 1 }),
    ];
    for hostile in commands {
        assert!(
            serde_json::from_value::<ProjectChatCommand>(hostile).is_err(),
            "command structs are a closed wire contract"
        );
    }
}

#[test]
fn persisted_envelope_state_project_root_chat_and_binding_are_closed() {
    let root = TestDirectory::new("closed-state");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "First",
        }),
    );
    let bound = apply_json(
        &catalog,
        created.revision,
        json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": {
                "kind": "prime-session",
                "accountId": null,
                "sessionId": "session-1",
                "sessionFile": "session-1.jsonl",
                "agentId": null,
            },
        }),
    );
    let selectors: [fn(&mut Value) -> &mut Value; 6] = [
        |value| value,
        |value| &mut value["state"],
        |value| &mut value["state"]["projects"][0],
        |value| &mut value["state"]["projects"][0]["root"],
        |value| &mut value["state"]["projects"][0]["chats"][0],
        |value| &mut value["state"]["projects"][0]["chats"][0]["binding"],
    ];

    for select in selectors {
        let mut hostile = snapshot_value(&bound);
        select(&mut hostile)["unknown"] = json!(true);
        let bytes = write_value(&path, &hostile);
        assert_recovery_preserves(&path, &bytes);
    }
}

#[test]
fn nullable_wire_fields_are_required_and_personal_root_rejects_even_null_path() {
    let root = TestDirectory::new("required-nullable-state");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "First",
        }),
    );
    let bound = apply_json(
        &catalog,
        created.revision,
        json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": {
                "kind": "prime-session",
                "accountId": null,
                "sessionId": "session-1",
                "sessionFile": "session-1.jsonl",
                "agentId": null,
            },
        }),
    );

    let mut missing_selected_chat = snapshot_value(&bound);
    missing_selected_chat["state"]["projects"][0]
        .as_object_mut()
        .unwrap()
        .remove("selectedChatId");
    let bytes = write_value(&path, &missing_selected_chat);
    assert_recovery_preserves(&path, &bytes);

    let mut missing_chat_binding = snapshot_value(&bound);
    missing_chat_binding["state"]["projects"][0]["chats"][0]
        .as_object_mut()
        .unwrap()
        .remove("binding");
    let bytes = write_value(&path, &missing_chat_binding);
    assert_recovery_preserves(&path, &bytes);

    for field in ["accountId", "agentId"] {
        let mut missing_binding_field = snapshot_value(&bound);
        missing_binding_field["state"]["projects"][0]["chats"][0]["binding"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        let bytes = write_value(&path, &missing_binding_field);
        assert_recovery_preserves(&path, &bytes);
    }

    let mut personal_null_path = snapshot_value(&bound);
    personal_null_path["state"]["projects"][0]["root"]["path"] = Value::Null;
    let bytes = write_value(&path, &personal_null_path);
    assert_recovery_preserves(&path, &bytes);

    for missing in ["accountId", "agentId"] {
        let mut hostile = json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": {
                "kind": "prime-session",
                "accountId": null,
                "sessionId": "session-1",
                "sessionFile": "session-1.jsonl",
                "agentId": null,
            },
        });
        hostile["binding"].as_object_mut().unwrap().remove(missing);
        assert!(serde_json::from_value::<ProjectChatCommand>(hostile).is_err());
    }
}

#[test]
fn duplicate_json_keys_and_truncated_json_fail_closed() {
    let root = TestDirectory::new("strict-json");
    let path = root.path().join("projects-v2.json");
    let initial = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    let canonical = serde_json::to_string(&initial).expect("serialize initial snapshot");
    let duplicate = canonical.replacen("\"revision\":0", "\"revision\":0,\"revision\":0", 1);
    fs::write(&path, duplicate.as_bytes()).expect("write duplicate-key catalog");
    assert_recovery_preserves(&path, duplicate.as_bytes());

    let truncated = &canonical.as_bytes()[..canonical.len() - 1];
    fs::write(&path, truncated).expect("write truncated catalog");
    assert_recovery_preserves(&path, truncated);
}

#[test]
fn every_nested_authority_object_rejects_duplicate_raw_json_keys() {
    const CATALOG: &str = r#"{"revision":2,"state":{"schemaVersion":2,"selectedProjectId":"project:personal","projects":[{"id":"project:personal","kind":"personal","name":"Personal","root":{"kind":"studio-managed-empty"},"pinned":false,"archived":false,"selectedChatId":"c1","chats":[{"id":"c1","projectId":"project:personal","title":"First","pinned":false,"archived":false,"binding":{"kind":"prime-session","accountId":null,"sessionId":"session-1","sessionFile":"session-1.jsonl","agentId":null}}]}]}}"#;
    let duplicate_fields = [
        (
            r#""state":{"schemaVersion":2"#,
            r#""state":{"schemaVersion":2,"schemaVersion":2"#,
        ),
        (
            r#""projects":[{"id":"project:personal""#,
            r#""projects":[{"id":"project:personal","id":"project:personal""#,
        ),
        (
            r#""root":{"kind":"studio-managed-empty"}"#,
            r#""root":{"kind":"studio-managed-empty","kind":"studio-managed-empty"}"#,
        ),
        (r#""chats":[{"id":"c1""#, r#""chats":[{"id":"c1","id":"c1""#),
        (
            r#""binding":{"kind":"prime-session""#,
            r#""binding":{"kind":"prime-session","kind":"prime-session""#,
        ),
        (
            r#""accountId":null"#,
            r#""accountId":null,"accountId":null"#,
        ),
        (
            r#""sessionId":"session-1""#,
            r#""sessionId":"session-1","sessionId":"session-1""#,
        ),
        (
            r#""sessionFile":"session-1.jsonl""#,
            r#""sessionFile":"session-1.jsonl","sessionFile":"session-1.jsonl""#,
        ),
        (r#""agentId":null"#, r#""agentId":null,"agentId":null"#),
    ];
    let root = TestDirectory::new("nested-duplicate-keys");
    let path = root.path().join("projects-v2.json");
    assert!(
        serde_json::from_str::<CatalogSnapshot>(CATALOG).is_ok(),
        "hand-checked baseline must remain valid"
    );

    for (needle, duplicate) in duplicate_fields {
        let hostile = CATALOG.replacen(needle, duplicate, 1);
        assert_ne!(hostile, CATALOG, "fixture needle must be present: {needle}");
        fs::write(&path, hostile.as_bytes()).expect("write duplicate nested catalog key");
        match ProjectCatalog::new(path.clone()).load() {
            Err(error) => assert_eq!(error.code(), "recoveryRequired"),
            Ok(snapshot) => panic!("duplicate nested key was accepted ({needle}): {snapshot:?}"),
        }
        assert_eq!(
            fs::read(&path).expect("read preserved duplicate nested catalog"),
            hostile.as_bytes()
        );
    }

    const COMMAND: &str = r#"{"type":"chat.bind-prime-session","projectId":"project:personal","chatId":"c1","binding":{"kind":"prime-session","accountId":null,"sessionId":"session-1","sessionFile":"session-1.jsonl","agentId":null}}"#;
    for (needle, duplicate) in duplicate_fields.into_iter().skip(4) {
        let hostile = COMMAND.replacen(needle, duplicate, 1);
        assert_ne!(hostile, COMMAND, "command fixture must contain {needle}");
        assert!(
            serde_json::from_str::<ProjectChatCommand>(&hostile).is_err(),
            "raw commands reject duplicate nested binding key {needle}"
        );
    }
}

#[test]
fn duplicate_ids_and_archived_selections_require_recovery() {
    let root = TestDirectory::new("invalid-invariants");
    let path = root.path().join("projects-v2.json");
    let folder = root.path().join("repo");
    fs::create_dir(&folder).expect("create project folder");
    let catalog = ProjectCatalog::new(path.clone());
    let project = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": folder,
        }),
    );

    let mut duplicate_projects = snapshot_value(&project);
    let duplicate = duplicate_projects["state"]["projects"][1].clone();
    duplicate_projects["state"]["projects"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let bytes = write_value(&path, &duplicate_projects);
    assert_recovery_preserves(&path, &bytes);

    let mut archived_project = snapshot_value(&project);
    archived_project["state"]["projects"][1]["archived"] = json!(true);
    let bytes = write_value(&path, &archived_project);
    assert_recovery_preserves(&path, &bytes);

    fs::write(
        &path,
        serde_json::to_vec(&project).expect("restore valid project snapshot"),
    )
    .expect("restore valid project snapshot");
    let chat = apply_json(
        &catalog,
        project.revision,
        json!({
            "type": "chat.create",
            "projectId": "p1",
            "chatId": "c1",
            "title": "First",
        }),
    );
    let mut duplicate_chats = snapshot_value(&chat);
    let duplicate = duplicate_chats["state"]["projects"][1]["chats"][0].clone();
    duplicate_chats["state"]["projects"][1]["chats"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let bytes = write_value(&path, &duplicate_chats);
    assert_recovery_preserves(&path, &bytes);

    let mut archived_chat = snapshot_value(&chat);
    archived_chat["state"]["projects"][1]["chats"][0]["archived"] = json!(true);
    let bytes = write_value(&path, &archived_chat);
    assert_recovery_preserves(&path, &bytes);
}

#[test]
fn revision_overflow_fails_without_rewriting_the_catalog() {
    const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

    let root = TestDirectory::new("overflow");
    let folder = root.path().join("repo");
    fs::create_dir(&folder).expect("create project folder");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": folder,
        }),
    );
    let mut overflowed = snapshot_value(&created);
    overflowed["revision"] = json!(MAX_SAFE_REVISION);
    let bytes = write_value(&path, &overflowed);

    let error = catalog
        .apply(
            MAX_SAFE_REVISION,
            command(json!({
                "type": "project.rename",
                "projectId": "p1",
                "name": "Changed",
            })),
        )
        .expect_err("revision increment cannot wrap");
    assert_eq!(error.code(), "revisionOverflow");
    assert_eq!(fs::read(path).expect("read overflow catalog"), bytes);
}

#[test]
fn an_on_disk_revision_above_javascript_max_safe_integer_requires_recovery() {
    const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

    let root = TestDirectory::new("unsafe-revision");
    let path = root.path().join("projects-v2.json");
    let snapshot = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    let mut unsafe_revision = snapshot_value(&snapshot);
    unsafe_revision["revision"] = json!(MAX_SAFE_REVISION + 1);
    let bytes = write_value(&path, &unsafe_revision);
    assert_recovery_preserves(&path, &bytes);
}

#[test]
fn project_create_stores_the_canonical_existing_directory_not_a_symlink_alias() {
    let root = TestDirectory::new("canonical-root");
    let target = root.path().join("target");
    let alias = root.path().join("alias");
    fs::create_dir(&target).expect("create real project directory");
    create_directory_symlink(&target, &alias);
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));

    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": alias,
        }),
    );
    assert_eq!(
        created.state.projects[1].root.path.as_deref(),
        fs::canonicalize(target).unwrap().to_str()
    );
}

#[test]
fn replacing_a_valid_folder_root_with_a_symlink_blocks_the_next_commit() {
    let root = TestDirectory::new("root-substitution");
    let folder = root.path().join("repo");
    let outside = root.path().join("outside");
    fs::create_dir(&folder).expect("create original project folder");
    fs::create_dir(&outside).expect("create replacement target");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": folder,
        }),
    );
    let bytes = fs::read(&path).expect("read valid committed catalog");
    fs::remove_dir(root.path().join("repo")).expect("remove original empty folder");
    create_directory_symlink(&outside, &root.path().join("repo"));

    let error = catalog
        .apply(
            created.revision,
            command(json!({
                "type": "project.rename",
                "projectId": "p1",
                "name": "Must not commit",
            })),
        )
        .expect_err("root substitution invalidates the durable state");
    assert_eq!(error.code(), "recoveryRequired");
    assert_eq!(fs::read(path).expect("read preserved catalog"), bytes);
}

#[test]
fn failed_atomic_replace_leaves_the_old_catalog_byte_identical() {
    let root = TestDirectory::new("write-failure");
    let folder = root.path().join("repo");
    fs::create_dir(&folder).expect("create project folder");
    let path = root.path().join("projects-v2.json");
    let catalog = ProjectCatalog::new(path.clone());
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "project.create",
            "projectId": "p1",
            "name": "Repo",
            "folderPath": folder,
        }),
    );
    let bytes = fs::read(&path).expect("read old catalog bytes");

    #[cfg(windows)]
    let error = {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let _replacement_blocker = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .expect("open destination without delete sharing");
        catalog
            .apply(
                created.revision,
                command(json!({
                    "type": "project.rename",
                    "projectId": "p1",
                    "name": "Must not commit",
                })),
            )
            .expect_err("atomic replacement is blocked")
    };

    #[cfg(unix)]
    let error = {
        use std::os::unix::fs::PermissionsExt;

        let original = fs::metadata(root.path()).unwrap().permissions();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = catalog
            .apply(
                created.revision,
                command(json!({
                    "type": "project.rename",
                    "projectId": "p1",
                    "name": "Must not commit",
                })),
            )
            .expect_err("atomic replacement is blocked");
        fs::set_permissions(root.path(), original).unwrap();
        result
    };

    assert_eq!(error.code(), "writeFailed");
    assert_eq!(fs::read(path).expect("read preserved old catalog"), bytes);
}

#[test]
fn catalog_byte_cap_is_inclusive_and_rejects_one_byte_more() {
    const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

    let root = TestDirectory::new("byte-cap");
    let path = root.path().join("projects-v2.json");
    let initial = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    let mut bytes = serde_json::to_vec(&initial).expect("serialize initial catalog");
    bytes.resize(MAX_CATALOG_BYTES, b' ');
    fs::write(&path, &bytes).expect("write exact-limit catalog");
    assert_eq!(
        ProjectCatalog::new(path.clone())
            .load()
            .expect("exact byte cap remains valid"),
        initial
    );

    bytes.push(b' ');
    fs::write(&path, &bytes).expect("write over-limit catalog");
    assert_recovery_preserves(&path, &bytes);
}

#[test]
fn catalog_container_node_cap_is_inclusive_and_rejects_one_more_chat() {
    const CHATS_AT_NODE_CAP: usize = 9_995;

    let root = TestDirectory::new("node-cap");
    let path = root.path().join("projects-v2.json");
    let mut snapshot = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    snapshot.state.projects[0].chats = (0..CHATS_AT_NODE_CAP)
        .map(|index| ProjectChat {
            id: format!("c{index}"),
            project_id: "project:personal".to_owned(),
            title: "Chat".to_owned(),
            pinned: false,
            archived: false,
            binding: None,
        })
        .collect();
    let bytes = serde_json::to_vec(&snapshot).expect("serialize node-limit catalog");
    fs::write(&path, bytes).expect("write node-limit catalog");
    assert_eq!(
        ProjectCatalog::new(path.clone())
            .load()
            .expect("exact node cap remains valid")
            .state
            .projects[0]
            .chats
            .len(),
        CHATS_AT_NODE_CAP
    );

    snapshot.state.projects[0].chats.push(ProjectChat {
        id: "over-node-cap".to_owned(),
        project_id: "project:personal".to_owned(),
        title: "Chat".to_owned(),
        pinned: false,
        archived: false,
        binding: None,
    });
    let bytes = serde_json::to_vec(&snapshot).expect("serialize over-limit catalog");
    fs::write(&path, &bytes).expect("write over-limit catalog");
    assert_recovery_preserves(&path, &bytes);
}

#[test]
fn ids_and_labels_enforce_the_exact_hostile_input_contract() {
    let root = TestDirectory::new("hostile-inputs");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));

    for hostile_id in [
        String::new(),
        "é".to_owned(),
        "line\nbreak".to_owned(),
        "delete\u{7f}".to_owned(),
        " edge".to_owned(),
        "edge ".to_owned(),
        "x".repeat(129),
    ] {
        let error = catalog
            .apply(
                0,
                command(json!({
                    "type": "chat.create",
                    "projectId": "project:personal",
                    "chatId": hostile_id,
                    "title": "Chat",
                })),
            )
            .expect_err("hostile id is rejected");
        assert_eq!(error.code(), "invalidCommand");
    }

    for hostile_label in [
        String::new(),
        " leading".to_owned(),
        "trailing ".to_owned(),
        "line\nbreak".to_owned(),
        "format\u{2060}mark".to_owned(),
        "separator\u{2028}line".to_owned(),
        "x".repeat(201),
    ] {
        let error = catalog
            .apply(
                0,
                command(json!({
                    "type": "chat.create",
                    "projectId": "project:personal",
                    "chatId": "valid-id",
                    "title": hostile_label,
                })),
            )
            .expect_err("hostile label is rejected");
        assert_eq!(error.code(), "invalidCommand");
    }

    let accepted = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "printable id.with-punctuation_",
            "title": format!("{}A\u{17b4}", "界".repeat(198)),
        }),
    );
    assert_eq!(
        accepted.state.projects[0].chats[0].title.chars().count(),
        200
    );
}

#[test]
fn session_file_is_bounded_relative_basename_metadata_not_a_path() {
    let root = TestDirectory::new("session-file-metadata");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));
    let created = apply_json(
        &catalog,
        0,
        json!({
            "type": "chat.create",
            "projectId": "project:personal",
            "chatId": "c1",
            "title": "First",
        }),
    );

    for hostile in [
        String::new(),
        ".".to_owned(),
        "..".to_owned(),
        "../session.jsonl".to_owned(),
        "folder/session.jsonl".to_owned(),
        "folder\\session.jsonl".to_owned(),
        "C:session.jsonl".to_owned(),
        "/session.jsonl".to_owned(),
        " session.jsonl".to_owned(),
        "session.jsonl ".to_owned(),
        "session:name.jsonl".to_owned(),
        "séssion.jsonl".to_owned(),
        "x".repeat(256),
    ] {
        let error = catalog
            .apply(
                created.revision,
                command(json!({
                    "type": "chat.bind-prime-session",
                    "projectId": "project:personal",
                    "chatId": "c1",
                    "binding": {
                        "kind": "prime-session",
                        "accountId": null,
                        "sessionId": "session-1",
                        "sessionFile": hostile,
                        "agentId": null,
                    },
                })),
            )
            .expect_err("session file path syntax is rejected as non-authoritative metadata");
        assert_eq!(error.code(), "invalidCommand");
    }

    let basename = format!("{}.jsonl", "x".repeat(249));
    assert_eq!(basename.len(), 255);
    let bound = apply_json(
        &catalog,
        created.revision,
        json!({
            "type": "chat.bind-prime-session",
            "projectId": "project:personal",
            "chatId": "c1",
            "binding": {
                "kind": "prime-session",
                "accountId": null,
                "sessionId": "session-1",
                "sessionFile": basename,
                "agentId": null,
            },
        }),
    );
    assert_eq!(
        bound.state.projects[0].chats[0]
            .binding
            .as_ref()
            .unwrap()
            .session_file,
        basename
    );
}

#[test]
fn cross_process_writer_child() {
    let Ok(path) = std::env::var("PRIME_CATALOG_CHILD_PATH") else {
        return;
    };
    let ready = PathBuf::from(std::env::var("PRIME_CATALOG_CHILD_READY").unwrap());
    let start = PathBuf::from(std::env::var("PRIME_CATALOG_CHILD_START").unwrap());
    let result = PathBuf::from(std::env::var("PRIME_CATALOG_CHILD_RESULT").unwrap());
    let chat_id = std::env::var("PRIME_CATALOG_CHILD_CHAT").unwrap();
    let catalog = ProjectCatalog::new(PathBuf::from(path));
    fs::write(&ready, b"ready").expect("announce child readiness");
    wait_until("cross-process start marker", || start.exists());

    let outcome = catalog.apply(
        0,
        command(json!({
            "type": "chat.set-pinned",
            "projectId": "project:personal",
            "chatId": chat_id,
            "pinned": true,
        })),
    );
    let value = match outcome {
        Ok(_) => "ok",
        Err(error) => error.code(),
    };
    fs::write(result, value).expect("record child outcome");
}

#[test]
fn retargeting_an_alias_cannot_split_two_processes_across_catalog_locks() {
    let root = TestDirectory::new("cross-process-split-lock");
    let first_root = root.path().join("first");
    let second_root = root.path().join("second");
    let alias = root.path().join("alias");
    fs::create_dir(&first_root).expect("create first catalog root");
    fs::create_dir(&second_root).expect("create second catalog root");
    let first_path = first_root.join("projects-v2.json");
    let second_path = second_root.join("projects-v2.json");
    for path in [&first_path, &second_path] {
        let mut snapshot = ProjectCatalog::new(path.clone())
            .load()
            .expect("initial split-lock snapshot");
        snapshot.state.projects[0].chats.push(ProjectChat {
            id: "c0".to_owned(),
            project_id: "project:personal".to_owned(),
            title: "Chat".to_owned(),
            pinned: false,
            archived: false,
            binding: None,
        });
        fs::write(path, serde_json::to_vec(&snapshot).unwrap()).expect("write split-lock snapshot");
    }
    create_directory_symlink(&first_root, &alias);

    let executable = std::env::current_exe().expect("locate integration test executable");
    let start = root.path().join("start");
    let direct_ready = root.path().join("direct-ready");
    let alias_ready = root.path().join("alias-ready");
    let direct_result = root.path().join("direct-result");
    let alias_result = root.path().join("alias-result");
    let spawn = |path: &Path, ready: &Path, result: &Path| {
        ProcessCommand::new(&executable)
            .arg("--exact")
            .arg("cross_process_writer_child")
            .arg("--test-threads=1")
            .env("PRIME_CATALOG_CHILD_PATH", path)
            .env("PRIME_CATALOG_CHILD_READY", ready)
            .env("PRIME_CATALOG_CHILD_START", &start)
            .env("PRIME_CATALOG_CHILD_RESULT", result)
            .env("PRIME_CATALOG_CHILD_CHAT", "c0")
            .spawn()
            .expect("spawn split-lock child")
    };
    let mut direct_child = spawn(&first_path, &direct_ready, &direct_result);
    let mut alias_child = spawn(&alias.join("projects-v2.json"), &alias_ready, &alias_result);
    wait_until("both split-lock children", || {
        direct_ready.exists() && alias_ready.exists()
    });
    remove_directory_symlink(&alias);
    create_directory_symlink(&second_root, &alias);
    fs::write(&start, b"start").expect("release split-lock children");
    assert!(direct_child
        .wait()
        .expect("wait for direct child")
        .success());
    assert!(alias_child.wait().expect("wait for alias child").success());

    assert_eq!(
        fs::read_to_string(direct_result).expect("read direct outcome"),
        "ok"
    );
    assert_eq!(
        fs::read_to_string(alias_result).expect("read alias outcome"),
        "recoveryRequired"
    );
    assert_eq!(
        ProjectCatalog::new(second_path)
            .load()
            .expect("second catalog remains unchanged")
            .revision,
        0
    );
}

#[test]
fn separate_processes_cannot_both_commit_the_same_expected_revision() {
    const WORKERS: usize = 4;
    const CHATS_AT_NODE_CAP: usize = 9_994;

    let root = TestDirectory::new("cross-process-cas");
    let path = root.path().join("projects-v2.json");
    let start = root.path().join("start");
    let mut snapshot = ProjectCatalog::new(path.clone())
        .load()
        .expect("initial snapshot");
    snapshot.state.projects[0].chats = (0..CHATS_AT_NODE_CAP)
        .map(|index| ProjectChat {
            id: format!("c{index}"),
            project_id: "project:personal".to_owned(),
            title: "Chat".to_owned(),
            pinned: false,
            archived: false,
            binding: None,
        })
        .collect();
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).expect("write large valid catalog");

    let executable = std::env::current_exe().expect("locate integration test executable");
    let mut children = Vec::new();
    let mut ready_paths = Vec::new();
    let mut result_paths = Vec::new();
    for index in 0..WORKERS {
        let ready = root.path().join(format!("ready-{index}"));
        let result = root.path().join(format!("result-{index}"));
        let child = ProcessCommand::new(&executable)
            .arg("--exact")
            .arg("cross_process_writer_child")
            .arg("--test-threads=1")
            .env("PRIME_CATALOG_CHILD_PATH", &path)
            .env("PRIME_CATALOG_CHILD_READY", &ready)
            .env("PRIME_CATALOG_CHILD_START", &start)
            .env("PRIME_CATALOG_CHILD_RESULT", &result)
            .env("PRIME_CATALOG_CHILD_CHAT", format!("c{index}"))
            .spawn()
            .expect("spawn catalog writer process");
        children.push(child);
        ready_paths.push(ready);
        result_paths.push(result);
    }
    wait_until("all catalog writer processes", || {
        ready_paths.iter().all(|path| path.exists())
    });
    fs::write(&start, b"start").expect("release cross-process writers");
    for child in &mut children {
        assert!(child.wait().expect("wait for catalog writer").success());
    }

    let results = result_paths
        .iter()
        .map(|path| fs::read_to_string(path).expect("read writer outcome"))
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_str() == "ok")
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_str() == "revisionConflict")
            .count(),
        WORKERS - 1
    );
}

#[test]
fn duplicate_move_and_delete_preserve_catalog_authority_and_selection() {
    let root = TestDirectory::new("duplicate-move-delete");
    let folder = root.path().join("target");
    fs::create_dir(&folder).expect("create target folder");
    let catalog = ProjectCatalog::new(root.path().join("projects-v2.json"));
    let mut snapshot = catalog.load().expect("initial catalog");
    snapshot = catalog
        .apply(
            snapshot.revision,
            create_project("project:target", "Target", &folder),
        )
        .expect("create target project");
    snapshot = apply_json(
        &catalog,
        snapshot.revision,
        json!({ "type": "chat.create", "projectId": "project:personal", "chatId": "chat:source", "title": "Source" }),
    );
    snapshot = apply_json(
        &catalog,
        snapshot.revision,
        json!({
            "type": "chat.bind-prime-session", "projectId": "project:personal", "chatId": "chat:source",
            "binding": { "kind": "prime-session", "accountId": "account-1", "sessionId": "session-1", "sessionFile": "session-1.jsonl", "agentId": null }
        }),
    );
    snapshot = apply_json(
        &catalog,
        snapshot.revision,
        json!({ "type": "chat.duplicate", "projectId": "project:personal", "chatId": "chat:source", "newChatId": "chat:copy", "title": "Source copy" }),
    );
    let personal = snapshot
        .state
        .projects
        .iter()
        .find(|project| project.id == "project:personal")
        .expect("personal");
    assert!(personal
        .chats
        .iter()
        .find(|chat| chat.id == "chat:copy")
        .expect("copy")
        .binding
        .is_none());

    snapshot = apply_json(
        &catalog,
        snapshot.revision,
        json!({ "type": "chat.move", "projectId": "project:personal", "chatId": "chat:copy", "targetProjectId": "project:target" }),
    );
    assert_eq!(snapshot.state.selected_project_id, "project:target");
    let target = snapshot
        .state
        .projects
        .iter()
        .find(|project| project.id == "project:target")
        .expect("target");
    assert_eq!(target.selected_chat_id.as_deref(), Some("chat:copy"));
    assert_eq!(target.chats[0].project_id, "project:target");

    snapshot = apply_json(
        &catalog,
        snapshot.revision,
        json!({ "type": "chat.delete", "projectId": "project:target", "chatId": "chat:copy" }),
    );
    let target = snapshot
        .state
        .projects
        .iter()
        .find(|project| project.id == "project:target")
        .expect("target");
    assert!(target.chats.is_empty());
    assert_eq!(target.selected_chat_id, None);
}
