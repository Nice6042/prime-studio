use prime_studio_lib::runtime_manifest::{
    parse_manifest, verify_manifest, ManifestErrorCode, RuntimeOwnership, MANIFEST_SCHEMA_V1,
    MAX_MANIFEST_BYTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct SyntheticDir {
    path: PathBuf,
}

impl SyntheticDir {
    fn new(label: &str) -> Self {
        let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "prime-studio-runtime-manifest-{}-{unique}-{label}",
            std::process::id()
        ));
        assert!(
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("prime-studio-runtime-manifest-")),
            "test cleanup root has the expected fixed prefix"
        );
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create synthetic runtime root");
        Self { path }
    }
}

impl Drop for SyntheticDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct SyntheticRuntime {
    directory: SyntheticDir,
    manifest: Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn frame(hasher: &mut Sha256, value: &str) {
    hasher.update(u32::try_from(value.len()).unwrap().to_be_bytes());
    hasher.update(value.as_bytes());
}

fn test_artifact_closure_digest(artifacts: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"prime-studio.artifact-closure/v1\0");
    hasher.update(u32::try_from(artifacts.len()).unwrap().to_be_bytes());
    for artifact in artifacts {
        frame(&mut hasher, artifact["path"].as_str().unwrap());
        frame(&mut hasher, artifact["role"].as_str().unwrap());
        hasher.update(artifact["size"].as_u64().unwrap().to_be_bytes());
        frame(&mut hasher, artifact["sha256"].as_str().unwrap());
    }
    format!("{:x}", hasher.finalize())
}

fn test_capability_set_digest(capabilities: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"prime-studio.capability-set/v1\0");
    hasher.update(u32::try_from(capabilities.len()).unwrap().to_be_bytes());
    for capability in capabilities {
        frame(&mut hasher, capability["id"].as_str().unwrap());
        frame(&mut hasher, capability["state"].as_str().unwrap());
        match capability.get("value").and_then(Value::as_str) {
            Some(value) => {
                hasher.update([1]);
                frame(&mut hasher, value);
            }
            None => hasher.update([0]),
        }
    }
    format!("{:x}", hasher.finalize())
}

fn synthetic_runtime(label: &str, ownership: &str) -> SyntheticRuntime {
    let directory = SyntheticDir::new(label);
    let files = [
        (
            "bin/node.exe",
            "node-runtime",
            b"synthetic node runtime\n".as_slice(),
        ),
        (
            "bundle/cli.js",
            "prime-cli-entry",
            b"// synthetic prime entry\n".as_slice(),
        ),
        (
            "schemas/legacy.schema.json",
            "protocol-schema",
            br#"{"synthetic":true}"#.as_slice(),
        ),
        (
            "validators/legacy-validator.wasm",
            "protocol-validator",
            b"synthetic validator bytes\n".as_slice(),
        ),
    ];
    let mut artifacts = Vec::new();
    for (path, role, bytes) in files {
        let target = path
            .split('/')
            .fold(directory.path.clone(), |current, segment| {
                current.join(segment)
            });
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, bytes).unwrap();
        artifacts.push(json!({
            "path": path,
            "role": role,
            "size": u64::try_from(bytes.len()).unwrap(),
            "sha256": sha256_hex(bytes)
        }));
    }
    artifacts.sort_by(|left, right| {
        left["path"]
            .as_str()
            .unwrap()
            .cmp(right["path"].as_str().unwrap())
    });

    let capabilities = vec![
        json!({"id": "prime.extension-ui.method-count", "state": "present", "value": "9"}),
        json!({"id": "prime.rpc.legacy.command-count", "state": "present", "value": "45"}),
        json!({"id": "prime.rpc.rate-limits", "state": "absent"}),
    ];
    let schema_hash = artifacts
        .iter()
        .find(|artifact| artifact["role"] == "protocol-schema")
        .unwrap()["sha256"]
        .clone();
    let manifest = json!({
        "schemaVersion": MANIFEST_SCHEMA_V1,
        "manifestId": format!("fixture-{ownership}-{label}"),
        "runtime": {
            "ownership": ownership,
            "product": "prime-agent",
            "packageVersion": "0.0.0-fixture",
            "sourceRevision": "1111111111111111111111111111111111111111",
            "buildRevision": "2222222222222222222222222222222222222222",
            "sourceAttested": true,
            "dirty": false
        },
        "artifactClosure": {
            "complete": true,
            "sha256": test_artifact_closure_digest(&artifacts),
            "artifacts": artifacts
        },
        "protocol": {
            "profile": "prime-rpc-fixture",
            "schema": "prime-rpc-fixture/v1",
            "schemaArtifact": "schemas/legacy.schema.json",
            "schemaSha256": schema_hash
        },
        "capabilitySet": {
            "complete": true,
            "sha256": test_capability_set_digest(&capabilities),
            "capabilities": capabilities
        }
    });
    SyntheticRuntime {
        directory,
        manifest,
    }
}

fn verify_value(
    value: &Value,
    root: &Path,
) -> Result<
    prime_studio_lib::runtime_manifest::VerifiedManifest,
    prime_studio_lib::runtime_manifest::ManifestError,
> {
    verify_manifest(parse_value(value)?, root)
}

fn supported_manifest(ownership: &str) -> Value {
    json!({
        "schemaVersion": MANIFEST_SCHEMA_V1,
        "manifestId": format!("fixture-{ownership}"),
        "runtime": {
            "ownership": ownership,
            "product": "prime-agent",
            "packageVersion": "0.0.0-fixture",
            "sourceRevision": "1111111111111111111111111111111111111111",
            "buildRevision": "2222222222222222222222222222222222222222",
            "sourceAttested": true,
            "dirty": false
        },
        "artifactClosure": {
            "complete": true,
            "sha256": SHA_A,
            "artifacts": [
                {
                    "path": "bin/node.exe",
                    "role": "node-runtime",
                    "size": 1,
                    "sha256": SHA_A
                },
                {
                    "path": "bundle/cli.js",
                    "role": "prime-cli-entry",
                    "size": 1,
                    "sha256": SHA_A
                },
                {
                    "path": "schemas/protocol.schema.json",
                    "role": "protocol-schema",
                    "size": 2,
                    "sha256": SHA_B
                },
                {
                    "path": "validators/protocol-validator.wasm",
                    "role": "protocol-validator",
                    "size": 1,
                    "sha256": SHA_A
                }
            ]
        },
        "protocol": {
            "profile": "prime-rpc-fixture",
            "schema": "prime-rpc-fixture/v1",
            "schemaArtifact": "schemas/protocol.schema.json",
            "schemaSha256": SHA_B
        },
        "capabilitySet": {
            "complete": true,
            "sha256": SHA_C,
            "capabilities": [
                {"id": "prime.rpc.prompt", "state": "present", "value": "v1"}
            ]
        }
    })
}

fn unidentified_manifest() -> Value {
    let artifacts = vec![json!({
        "path": "bundle/cli.js",
        "role": "prime-cli-entry",
        "size": 1,
        "sha256": SHA_B
    })];
    let capabilities = vec![
        json!({"id": "prime.rpc.legacy.command-count", "state": "present", "value": "45"}),
        json!({"id": "prime.rpc.rate-limits", "state": "absent"}),
    ];
    json!({
        "schemaVersion": MANIFEST_SCHEMA_V1,
        "manifestId": "fixture-unidentified",
        "runtime": {
            "ownership": "unidentified",
            "product": "prime-agent",
            "packageVersion": "0.7.1",
            "sourceRevision": null,
            "buildRevision": null,
            "sourceAttested": false,
            "dirty": true
        },
        "artifactClosure": {
            "complete": false,
            "sha256": test_artifact_closure_digest(&artifacts),
            "artifacts": artifacts
        },
        "protocol": null,
        "capabilitySet": {
            "complete": false,
            "sha256": test_capability_set_digest(&capabilities),
            "capabilities": capabilities
        }
    })
}

fn parse_value(
    value: &Value,
) -> Result<
    prime_studio_lib::runtime_manifest::CompatibilityManifest,
    prime_studio_lib::runtime_manifest::ManifestError,
> {
    parse_manifest(&serde_json::to_vec(value).expect("test manifest serializes"))
}

#[test]
fn parser_defaults_execution_permission_to_false_for_every_ownership() {
    for (value, expected) in [
        (supported_manifest("managed"), RuntimeOwnership::Managed),
        (supported_manifest("external"), RuntimeOwnership::External),
        (unidentified_manifest(), RuntimeOwnership::Unidentified),
    ] {
        let parsed = parse_value(&value).expect("strict synthetic manifest parses");
        assert_eq!(parsed.runtime().ownership(), expected);
    }
}

#[test]
fn parser_accepts_explicit_false_but_rejects_execution_opt_in() {
    let mut denied = supported_manifest("managed");
    denied["executionAllowed"] = json!(false);
    parse_value(&denied).expect("an explicit denial remains valid");

    let mut requested = supported_manifest("managed");
    requested["executionAllowed"] = json!(true);
    let error = parse_value(&requested).expect_err("foundation cannot activate execution");
    assert_eq!(error.code(), ManifestErrorCode::ExecutionUnsupported);
}

#[test]
fn parser_requires_nullable_wire_fields_to_be_present() {
    for pointer in [
        "/runtime/packageVersion",
        "/runtime/sourceRevision",
        "/runtime/buildRevision",
        "/protocol",
    ] {
        let mut manifest = unidentified_manifest();
        manifest
            .pointer_mut(pointer.rsplit_once('/').unwrap().0)
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove(pointer.rsplit_once('/').unwrap().1);
        let error = parse_value(&manifest)
            .expect_err("required nullable keys cannot be confused with omitted evidence");
        assert_eq!(error.code(), ManifestErrorCode::Malformed, "{pointer}");
    }
}

#[test]
fn parser_and_schema_share_ascii_text_and_complete_closure_rules() {
    let mut non_ascii_package = unidentified_manifest();
    non_ascii_package["runtime"]["packageVersion"] = json!("0.7.1–local");
    let error = parse_value(&non_ascii_package)
        .expect_err("wire text uses bounded canonical ASCII, not Unicode code-point lengths");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);

    let mut non_ascii_capability = unidentified_manifest();
    non_ascii_capability["capabilitySet"]["capabilities"][0]["value"] = json!("45 ");
    let error =
        parse_value(&non_ascii_capability).expect_err("capability evidence is canonical ASCII");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);

    let mut incomplete_roles = unidentified_manifest();
    incomplete_roles["artifactClosure"]["complete"] = json!(true);
    let error = parse_value(&incomplete_roles)
        .expect_err("every closure claiming completeness has the required runnable roles");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);
}

#[test]
fn parser_rejects_unknown_and_duplicate_json_fields() {
    let mut unknown = supported_manifest("managed");
    unknown["runtime"]["marketingVersion"] = json!("0.7.1");
    let error = parse_value(&unknown).expect_err("unknown fields must fail closed");
    assert_eq!(error.code(), ManifestErrorCode::Malformed);

    let duplicate = format!(
        r#"{{"schemaVersion":"{MANIFEST_SCHEMA_V1}","schemaVersion":"{MANIFEST_SCHEMA_V1}"}}"#
    );
    let error = parse_manifest(duplicate.as_bytes()).expect_err("duplicate fields are ambiguous");
    assert_eq!(error.code(), ManifestErrorCode::Malformed);
}

#[test]
fn parser_rejects_unsupported_schema_and_oversized_input() {
    let mut unsupported = supported_manifest("managed");
    unsupported["schemaVersion"] = json!("prime-studio.runtime-compatibility/v2");
    let error = parse_value(&unsupported).expect_err("unknown validators cannot be activated");
    assert_eq!(error.code(), ManifestErrorCode::UnsupportedSchema);

    let oversized = vec![b' '; MAX_MANIFEST_BYTES + 1];
    let error = parse_manifest(&oversized).expect_err("manifest parsing is bounded");
    assert_eq!(error.code(), ManifestErrorCode::TooLarge);
}

#[test]
fn parser_rejects_noncanonical_hashes_and_duplicate_capabilities() {
    let mut uppercase = supported_manifest("managed");
    uppercase["artifactClosure"]["sha256"] = json!(SHA_A.to_ascii_uppercase());
    let error = parse_value(&uppercase).expect_err("hash spelling is canonical lowercase");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);

    let mut duplicate = supported_manifest("external");
    duplicate["capabilitySet"]["capabilities"] = json!([
        {"id": "prime.rpc.prompt", "state": "present", "value": "v1"},
        {"id": "prime.rpc.prompt", "state": "present", "value": "v1"}
    ]);
    let error = parse_value(&duplicate).expect_err("capability aliases are ambiguous");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);
}

#[test]
fn parser_rejects_complete_supported_label_without_required_runtime_roles() {
    for ownership in ["managed", "external"] {
        let mut manifest = supported_manifest(ownership);
        manifest["artifactClosure"]["artifacts"] = json!([
            {
                "path": "schemas/protocol.schema.json",
                "role": "protocol-schema",
                "size": 2,
                "sha256": SHA_B
            }
        ]);
        let error = parse_value(&manifest)
            .expect_err("a schema file alone is not a complete runnable Prime closure");
        assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);
    }
}

#[test]
fn parser_requires_complete_provenance_for_managed_and_external_runtimes() {
    for ownership in ["managed", "external"] {
        let mut missing_package = supported_manifest(ownership);
        missing_package["runtime"]["packageVersion"] = Value::Null;
        let error = parse_value(&missing_package)
            .expect_err("supported ownership requires recorded package metadata");
        assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);

        let mut unattested_source = supported_manifest(ownership);
        unattested_source["runtime"]["sourceAttested"] = json!(false);
        let error = parse_value(&unattested_source)
            .expect_err("supported ownership requires an attested source revision");
        assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);
    }
}

#[test]
fn parser_rejects_a_non_prime_product_for_this_schema() {
    let mut manifest = supported_manifest("managed");
    manifest["runtime"]["product"] = json!("lookalike-agent");
    let error =
        parse_value(&manifest).expect_err("this schema cannot bless a different runtime product");
    assert_eq!(error.code(), ManifestErrorCode::InvalidManifest);
}

#[test]
fn verifier_accepts_exact_managed_and_external_synthetic_closures_read_export_only() {
    for ownership in ["managed", "external"] {
        let runtime = synthetic_runtime(&format!("valid-{ownership}"), ownership);
        let verified = verify_value(&runtime.manifest, &runtime.directory.path)
            .expect("exact synthetic closure verifies");
        assert_eq!(
            verified.runtime_ownership(),
            if ownership == "managed" {
                RuntimeOwnership::Managed
            } else {
                RuntimeOwnership::External
            }
        );
        assert_eq!(verified.artifact_count(), 4);
        assert!(!verified.execution_allowed());
    }
}

#[test]
fn verifier_rejects_unidentified_runtime_before_filesystem_access() {
    let manifest = parse_value(&unidentified_manifest()).expect("audit-shaped record parses");
    let error = verify_manifest(manifest, Path::new("Z:/path-that-must-not-be-opened"))
        .expect_err("unidentified observations never become supported runtimes");
    assert_eq!(error.code(), ManifestErrorCode::UnidentifiedRuntime);
}

#[test]
fn verifier_checks_unidentified_record_digests_without_accessing_its_runtime_path() {
    let mut value = unidentified_manifest();
    value["artifactClosure"]["sha256"] = json!(SHA_A);
    let manifest = parse_value(&value).expect("tampered digest remains structurally parseable");
    let error = verify_manifest(manifest, Path::new("Z:/path-that-must-not-be-opened"))
        .expect_err("unidentified evidence remains tamper-evident");
    assert_eq!(error.code(), ManifestErrorCode::ClosureDigestMismatch);
}

#[test]
fn compatibility_manifest_is_only_constructed_by_the_strict_parser() {
    let runtime = synthetic_runtime("validated-constructor", "managed");
    let parsed = parse_value(&runtime.manifest).expect("strict parser constructs domain value");
    let verified = verify_manifest(parsed, &runtime.directory.path)
        .expect("validated domain value verifies its exact closure");
    assert!(!verified.execution_allowed());
}

#[test]
fn verifier_rejects_file_hash_size_missing_and_unexpected_artifact_changes() {
    let runtime = synthetic_runtime("artifact-mutations", "managed");
    let cli = runtime.directory.path.join("bundle").join("cli.js");
    let original = fs::read(&cli).unwrap();

    let mut same_size = original.clone();
    same_size[0] ^= 1;
    fs::write(&cli, same_size).unwrap();
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("same-size byte changes must be detected");
    assert_eq!(error.code(), ManifestErrorCode::ArtifactHashMismatch);

    fs::write(&cli, [original.as_slice(), b"x"].concat()).unwrap();
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("size changes must be detected before activation");
    assert_eq!(error.code(), ManifestErrorCode::ArtifactSizeMismatch);

    fs::remove_file(&cli).unwrap();
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("missing closure members fail closed");
    assert_eq!(error.code(), ManifestErrorCode::MissingArtifact);

    fs::write(&cli, &original).unwrap();
    fs::write(
        runtime.directory.path.join("unlisted-runtime-file.js"),
        b"extra",
    )
    .unwrap();
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("a complete closure rejects unlisted files");
    assert_eq!(error.code(), ManifestErrorCode::UnexpectedArtifact);
}

#[test]
fn verifier_rejects_unlisted_directory_topology() {
    let runtime = synthetic_runtime("unexpected-directory", "managed");
    fs::create_dir(runtime.directory.path.join("unlisted-empty-directory"))
        .expect("create unlisted empty directory");
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("a complete closure binds its directory topology as well as file bytes");
    assert_eq!(error.code(), ManifestErrorCode::UnexpectedArtifact);
}

#[test]
fn verifier_rejects_closure_capability_and_protocol_schema_binding_mismatches() {
    let runtime = synthetic_runtime("binding-mismatches", "external");

    let mut closure = runtime.manifest.clone();
    closure["artifactClosure"]["sha256"] = json!(SHA_A);
    let error = verify_value(&closure, &runtime.directory.path)
        .expect_err("closure record digest binds path, role, size, and file hash");
    assert_eq!(error.code(), ManifestErrorCode::ClosureDigestMismatch);

    let mut capabilities = runtime.manifest.clone();
    capabilities["capabilitySet"]["sha256"] = json!(SHA_C);
    let error = verify_value(&capabilities, &runtime.directory.path)
        .expect_err("capability inventory digest must match");
    assert_eq!(error.code(), ManifestErrorCode::CapabilityDigestMismatch);

    let mut schema = runtime.manifest.clone();
    schema["protocol"]["schemaSha256"] = json!(SHA_B);
    let error = verify_value(&schema, &runtime.directory.path)
        .expect_err("protocol schema must name the exact closure artifact hash");
    assert_eq!(error.code(), ManifestErrorCode::SchemaBindingMismatch);

    let mut schema_case_alias = runtime.manifest.clone();
    schema_case_alias["protocol"]["schemaArtifact"] = json!("SCHEMAS/legacy.schema.json");
    let error = verify_value(&schema_case_alias, &runtime.directory.path)
        .expect_err("protocol schema binding uses one exact canonical path spelling");
    assert_eq!(error.code(), ManifestErrorCode::SchemaBindingMismatch);
}

#[test]
fn verifier_rejects_unsafe_windows_artifact_paths_and_case_alias_duplicates() {
    let runtime = synthetic_runtime("unsafe-paths", "managed");
    let unsafe_paths = [
        "../node.exe",
        "/node.exe",
        "C:/node.exe",
        "//server/share/node.exe",
        r"\\server\share\node.exe",
        r"\\?\C:\node.exe",
        "bin/node.exe:stream",
        "bin/../node.exe",
        "bin/con",
        "bin/CONIN$",
        "bin/CONOUT$.txt",
        "bin/CLOCK$.data",
        "bin/COM0",
        "bin/LPT0",
        "bin/NUL.txt",
        "bin/file.",
        "bin/file ",
        "bin//file",
        r"bin\file",
        "bin/<file>",
    ];
    for path in unsafe_paths {
        let mut manifest = runtime.manifest.clone();
        manifest["artifactClosure"]["artifacts"][0]["path"] = json!(path);
        let error = parse_value(&manifest).expect_err("unsafe Windows path must fail closed");
        assert_eq!(error.code(), ManifestErrorCode::UnsafePath, "path={path}");
    }

    let mut duplicate = runtime.manifest.clone();
    duplicate["artifactClosure"]["artifacts"][1]["path"] = json!("BIN/NODE.EXE");
    let error = parse_value(&duplicate).expect_err("case aliases duplicate on Windows");
    assert_eq!(error.code(), ManifestErrorCode::DuplicateArtifact);
}

#[cfg(windows)]
#[test]
fn verifier_rejects_noncanonical_case_alias_for_an_existing_windows_file() {
    let runtime = synthetic_runtime("case-alias", "managed");
    let mut manifest = runtime.manifest.clone();
    manifest["artifactClosure"]["artifacts"][0]["path"] = json!("BIN/node.exe");
    let digest =
        test_artifact_closure_digest(manifest["artifactClosure"]["artifacts"].as_array().unwrap());
    manifest["artifactClosure"]["sha256"] = json!(digest);
    let error = verify_value(&manifest, &runtime.directory.path)
        .expect_err("one on-disk path must have one exact manifest spelling");
    assert_eq!(error.code(), ManifestErrorCode::UnsafePath);
}

#[test]
fn verifier_rejects_reparse_components_and_hardlink_aliases() {
    let runtime = synthetic_runtime("filesystem-aliases", "external");
    let bundle = runtime.directory.path.join("bundle");
    let outside = SyntheticDir::new("outside-reparse-target");
    fs::rename(&bundle, outside.path.join("bundle")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(outside.path.join("bundle"), &bundle)
        .expect("create synthetic directory reparse point");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path.join("bundle"), &bundle)
        .expect("create synthetic directory symlink");
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("closure traversal cannot cross a reparse boundary");
    assert_eq!(error.code(), ManifestErrorCode::ReparsePoint);

    fs::remove_dir(&bundle).unwrap();
    fs::rename(outside.path.join("bundle"), &bundle).unwrap();
    let alias_directory = SyntheticDir::new("outside-hardlink-alias");
    fs::hard_link(
        runtime.directory.path.join("bin").join("node.exe"),
        alias_directory.path.join("node-alias.exe"),
    )
    .expect("create synthetic hardlink alias");
    let error = verify_value(&runtime.manifest, &runtime.directory.path)
        .expect_err("multiply linked runtime artifacts are mutable through aliases");
    assert_eq!(error.code(), ManifestErrorCode::HardLinkedArtifact);
}

#[cfg(windows)]
#[test]
fn verifier_rejects_unlisted_ntfs_alternate_data_streams() {
    let runtime = synthetic_runtime("alternate-data-stream", "managed");
    let node = runtime.directory.path.join("bin").join("node.exe");
    let stream = PathBuf::from(format!("{}:unlisted", node.display()));
    match fs::write(&stream, b"hidden synthetic bytes") {
        Ok(()) => {
            let error = verify_value(&runtime.manifest, &runtime.directory.path)
                .expect_err("an alternate stream is an unlisted mutable artifact alias");
            assert_eq!(error.code(), ManifestErrorCode::AlternateDataStream);
        }
        Err(error) if error.raw_os_error() == Some(50) => {
            // Some temporary filesystems do not support named streams. On those
            // filesystems there is no stream to hide and therefore nothing to test.
        }
        Err(error) => panic!("create NTFS alternate data stream: {error}"),
    }
}

#[cfg(windows)]
#[test]
fn verifier_rejects_alternate_streams_on_root_and_nested_directories() {
    for (label, directory_selector) in [
        ("root-directory-stream", ""),
        ("nested-directory-stream", "bundle"),
    ] {
        let runtime = synthetic_runtime(label, "managed");
        let directory = if directory_selector.is_empty() {
            runtime.directory.path.clone()
        } else {
            runtime.directory.path.join(directory_selector)
        };
        let stream = PathBuf::from(format!("{}:unlisted", directory.display()));
        match fs::write(&stream, b"hidden directory stream bytes") {
            Ok(()) => {
                let error = verify_value(&runtime.manifest, &runtime.directory.path)
                    .expect_err("directory alternate streams are outside the complete closure");
                assert_eq!(error.code(), ManifestErrorCode::AlternateDataStream);
            }
            Err(error) if error.raw_os_error() == Some(50) => {}
            Err(error) => panic!("create directory alternate data stream: {error}"),
        }
    }
}

#[test]
fn fixture_schema_is_strict_draft_2020_12_and_matches_the_rust_parser_corpus() {
    let schema: Value = serde_json::from_str(include_str!(
        "../schemas/runtime-compatibility-manifest.schema.json"
    ))
    .expect("checked-in compatibility schema is valid JSON");
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["executionAllowed"]["default"], false);
    assert_eq!(schema["properties"]["executionAllowed"]["const"], false);

    let validator = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&schema)
        .expect("checked-in document is a valid Draft 2020-12 schema");

    let fixture_directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-manifest");
    for name in [
        "managed-read-export.json",
        "external-read-export.json",
        "unidentified-observed-rejected.json",
    ] {
        let fixture: Value = serde_json::from_slice(
            &fs::read(fixture_directory.join(name))
                .unwrap_or_else(|error| panic!("read fixture {name}: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse fixture {name}: {error}"));
        assert!(
            validator.is_valid(&fixture),
            "schema rejects checked-in fixture {name}"
        );
        parse_value(&fixture)
            .unwrap_or_else(|error| panic!("Rust rejects fixture {name}: {error}"));
    }

    let mut decimal_integer_spelling = supported_manifest("managed");
    decimal_integer_spelling["artifactClosure"]["artifacts"][0]["size"] = json!(1.0);
    for valid in [
        supported_manifest("managed"),
        unidentified_manifest(),
        decimal_integer_spelling,
    ] {
        assert!(
            validator.is_valid(&valid),
            "schema rejects valid corpus item"
        );
        parse_value(&valid).expect("Rust parser accepts valid corpus item");
    }

    let mut missing_nullable = unidentified_manifest();
    missing_nullable["runtime"]
        .as_object_mut()
        .unwrap()
        .remove("sourceRevision");
    let mut non_ascii = unidentified_manifest();
    non_ascii["runtime"]["packageVersion"] = json!("0.7.1–local");
    let mut complete_without_roles = unidentified_manifest();
    complete_without_roles["artifactClosure"]["complete"] = json!(true);
    let mut attested_without_revision = unidentified_manifest();
    attested_without_revision["runtime"]["sourceAttested"] = json!(true);
    attested_without_revision["runtime"]["dirty"] = json!(false);
    let mut attested_and_dirty = unidentified_manifest();
    attested_and_dirty["runtime"]["sourceAttested"] = json!(true);
    attested_and_dirty["runtime"]["sourceRevision"] =
        json!("1111111111111111111111111111111111111111");
    let mut complete_without_capabilities = unidentified_manifest();
    complete_without_capabilities["capabilitySet"]["complete"] = json!(true);
    complete_without_capabilities["capabilitySet"]["capabilities"] = json!([]);
    let mut present_with_null_value = unidentified_manifest();
    present_with_null_value["capabilitySet"]["capabilities"][0]["value"] = Value::Null;
    let mut absent_with_null_value = unidentified_manifest();
    absent_with_null_value["capabilitySet"]["capabilities"][1]["value"] = Value::Null;
    let mut execution = supported_manifest("external");
    execution["executionAllowed"] = json!(true);
    let mut unknown = supported_manifest("managed");
    unknown["runtime"]["marketingVersion"] = json!("latest");

    for invalid in [
        missing_nullable,
        non_ascii,
        complete_without_roles,
        attested_without_revision,
        attested_and_dirty,
        complete_without_capabilities,
        present_with_null_value,
        absent_with_null_value,
        execution,
        unknown,
    ] {
        assert!(
            !validator.is_valid(&invalid),
            "schema accepts invalid corpus item"
        );
        parse_value(&invalid).expect_err("Rust parser rejects invalid corpus item");
    }
}

#[test]
fn fixture_managed_and_external_examples_verify_the_checked_in_synthetic_bytes() {
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-manifest")
        .join("runtime");
    for (name, expected) in [
        ("managed-read-export.json", RuntimeOwnership::Managed),
        ("external-read-export.json", RuntimeOwnership::External),
    ] {
        let bytes = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("runtime-manifest")
                .join(name),
        )
        .unwrap_or_else(|error| panic!("read fixture {name}: {error}"));
        let manifest = parse_manifest(&bytes).unwrap_or_else(|error| {
            panic!("parse fixture {name}: {error}");
        });
        let verified = verify_manifest(manifest, &fixture_root).unwrap_or_else(|error| {
            panic!("verify fixture {name}: {error}");
        });
        assert_eq!(verified.runtime_ownership(), expected);
        assert!(!verified.execution_allowed());
    }
}

#[test]
fn fixture_observed_unidentified_install_is_rejected_without_touching_a_real_install() {
    let bytes = include_bytes!("fixtures/runtime-manifest/unidentified-observed-rejected.json");
    let manifest = parse_manifest(bytes).expect("rejected observation remains parseable evidence");
    assert_eq!(
        manifest.runtime().ownership(),
        RuntimeOwnership::Unidentified
    );
    let error = verify_manifest(manifest, Path::new("Z:/never-inspect-a-real-prime-install"))
        .expect_err("observed loader and Node hashes are not a complete runtime closure");
    assert_eq!(error.code(), ManifestErrorCode::UnidentifiedRuntime);
}
