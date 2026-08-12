use std::fs;

use prime_studio_lib::commands::editor::{
    ArtifactAdmission, ArtifactAuthority, ArtifactOpenRequest, ArtifactOpenResult, ArtifactRef,
    ArtifactSaveCopyResult, ArtifactSaveRequest, ArtifactSaveResult,
};
use serde_json::json;

struct Fixture {
    root: std::path::PathBuf,
    file: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("prime-studio-editor-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).expect("fixture directory");
        let file = root.join("artifact.txt");
        fs::write(&file, "first\n").expect("fixture file");
        Self { root, file }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn admitted(authority: &ArtifactAuthority, fixture: &Fixture) -> ArtifactRef {
    authority
        .admit_harness_artifact(ArtifactAdmission::new(
            "broker-1",
            "session-1",
            "artifact-1",
            &fixture.root,
            &fixture.file,
            true,
        ))
        .expect("native Harness admission")
}

#[test]
fn artifact_open_request_cannot_smuggle_a_renderer_path() {
    assert!(serde_json::from_value::<ArtifactOpenRequest>(json!({
        "artifactRef": {
            "brokerId": "broker-1",
            "rootSessionId": "session-1",
            "artifactId": "artifact-1",
            "revision": 1
        }
    }))
    .is_ok());
    assert!(serde_json::from_value::<ArtifactOpenRequest>(json!({
        "artifactRef": {
            "brokerId": "broker-1",
            "rootSessionId": "session-1",
            "artifactId": "artifact-1",
            "revision": 1,
            "path": "C:\\renderer-controlled.txt"
        }
    }))
    .is_err());
}

#[test]
fn only_a_native_admitted_identity_bound_reference_opens() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let opened = authority.open(&artifact_ref);
    let ArtifactOpenResult::Opened { document } = opened else {
        panic!("native admitted artifact must open")
    };
    assert_eq!(document.content(), "first\n");
    assert_eq!(document.artifact_ref(), &artifact_ref);

    let forged = ArtifactRef::new("broker-1", "session-1", "forged", 1);
    assert!(matches!(
        authority.open(&forged),
        ArtifactOpenResult::Unsupported { .. }
    ));
}

#[test]
fn save_requires_exact_revision_identity_and_preserves_file_on_conflict() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let ArtifactOpenResult::Opened { document } = authority.open(&artifact_ref) else {
        panic!("open admitted artifact")
    };

    fs::write(&fixture.file, "external change\n").expect("simulate competing writer");
    let result = authority.save(ArtifactSaveRequest::new(
        artifact_ref,
        document.identity().to_owned(),
        1,
        "renderer edit\n".to_owned(),
    ));
    assert!(matches!(result, ArtifactSaveResult::Conflict { .. }));
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "external change\n"
    );
}

#[test]
fn exact_save_returns_a_new_revision_and_rejects_stale_replay() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let ArtifactOpenResult::Opened { document } = authority.open(&artifact_ref) else {
        panic!("open admitted artifact")
    };
    let request = ArtifactSaveRequest::new(
        artifact_ref,
        document.identity().to_owned(),
        1,
        "second\n".to_owned(),
    );
    let first = authority.save(request.clone());
    assert!(matches!(
        first,
        ArtifactSaveResult::Saved { revision: 2, .. }
    ));
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "second\n");
    assert!(matches!(
        authority.save(request),
        ArtifactSaveResult::Conflict { .. }
    ));
}

#[test]
fn reopening_a_saved_artifact_returns_a_real_bounded_structured_diff() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let ArtifactOpenResult::Opened { document } = authority.open(&artifact_ref) else {
        panic!("open admitted artifact")
    };
    let ArtifactSaveResult::Saved { revision, .. } = authority.save(ArtifactSaveRequest::new(
        artifact_ref.clone(),
        document.identity().to_owned(),
        1,
        "first\nsecond\n".to_owned(),
    )) else {
        panic!("exact save")
    };
    let next_ref = ArtifactRef::new("broker-1", "session-1", "artifact-1", revision);
    let ArtifactOpenResult::Opened { document } = authority.open(&next_ref) else {
        panic!("reopen saved artifact")
    };
    let encoded = serde_json::to_value(document).expect("serialize document");
    assert_eq!(encoded["diffTruncated"], false);
    assert_eq!(encoded["diff"], json!([
        {"kind":"context","oldLine":1,"newLine":1,"text":"first"},
        {"kind":"add","oldLine":null,"newLine":2,"text":"second"}
    ]));
}

#[test]
fn explicit_reload_rebinds_a_changed_disk_identity_without_accepting_a_new_path() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    fs::write(&fixture.file, "external change\n").expect("simulate competing writer");
    let ArtifactOpenResult::Opened { document } = authority.reload(&artifact_ref) else {
        panic!("explicit reload must rebind the held artifact")
    };
    assert_eq!(document.content(), "external change\n");
    assert_eq!(document.artifact_ref().revision(), 2);
}

#[test]
fn save_copy_uses_the_held_artifact_authority_and_a_native_selected_destination() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let destination = fixture.root.join("artifact-copy.txt");
    let result = authority.save_copy_at(&artifact_ref, "unsaved recovery\n", &destination);
    assert!(matches!(result, ArtifactSaveCopyResult::SavedCopy { .. }));
    assert_eq!(fs::read_to_string(destination).unwrap(), "unsaved recovery\n");

    let forged = ArtifactRef::new("broker-1", "session-1", "forged", 1);
    let denied = fixture.root.join("forged-copy.txt");
    assert!(matches!(authority.save_copy_at(&forged, "secret", &denied), ArtifactSaveCopyResult::Unsupported { .. }));
    assert!(!denied.exists());
}

#[test]
fn oversized_editor_content_is_rejected_without_writing() {
    let fixture = Fixture::new();
    let authority = ArtifactAuthority::default();
    let artifact_ref = admitted(&authority, &fixture);
    let ArtifactOpenResult::Opened { document } = authority.open(&artifact_ref) else {
        panic!("open admitted artifact")
    };
    let result = authority.save(ArtifactSaveRequest::new(
        artifact_ref,
        document.identity().to_owned(),
        1,
        "x".repeat(2 * 1024 * 1024 + 1),
    ));
    assert!(matches!(result, ArtifactSaveResult::Error { .. }));
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "first\n");
}

#[test]
fn hard_linked_artifact_is_rejected_during_native_admission() {
    let fixture = Fixture::new();
    let alias = fixture.root.join("artifact-alias.txt");
    fs::hard_link(&fixture.file, &alias).expect("create hard-link alias");
    let authority = ArtifactAuthority::default();
    let result = authority.admit_harness_artifact(ArtifactAdmission::new(
        "broker-1",
        "session-1",
        "artifact-1",
        &fixture.root,
        &fixture.file,
        true,
    ));
    assert!(
        result.is_err(),
        "shared hard-link identity must not be writable"
    );
}
