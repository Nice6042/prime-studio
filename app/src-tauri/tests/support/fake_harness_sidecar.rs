use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

const MAX_FRAME: usize = 4 * 1024 * 1024;

fn read_frame() -> Value {
    let mut length = [0_u8; 4];
    std::io::stdin().read_exact(&mut length).unwrap();
    let length = u32::from_be_bytes(length) as usize;
    assert!(length <= MAX_FRAME);
    let mut bytes = vec![0; length];
    std::io::stdin().read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn write_frame(value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    std::io::stdout()
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    std::io::stdout().write_all(&bytes).unwrap();
    std::io::stdout().flush().unwrap();
}

fn broker_runtime() -> Value {
    json!({
        "packageName":"prime-agent","packageVersion":"0.7.1",
        "packageDigest":"sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900",
        "entrypointDigest":"sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b",
        "protocolName":"prime-agent.daemon","protocolVersion":7,"schemaRevision":13,
        "schemaId":"protocol-7-schema-13-816309b1cd50",
        "capabilities":["attach_snapshot","chunked_snapshot","delete_child","event_sequence","extension_ui","heartbeat_catalog","heartbeat_management","model_catalog","prompt_admission_cancellation","queue_management","resident_sessions","resource_snapshot","session_input_admission","side_question_transcript","transient_bash"]
    })
}

fn broker_compatibility(profile: &str) -> Value {
    json!({
        "status":"ready","profile":profile,
        "capabilities":["attach_snapshot","chunked_snapshot","delete_child","event_sequence","extension_ui","heartbeat_catalog","heartbeat_management","model_catalog","prompt_admission_cancellation","queue_management","resident_sessions","resource_snapshot","session_input_admission","side_question_transcript","transient_bash"]
    })
}

fn quarantine_snapshot(session_id: &str, sequence: u64) -> Value {
    let suffix = session_id.strip_prefix("root-").unwrap();
    json!({
        "sessionId":session_id,"accountId":"account",
        "projectId":format!("project-{suffix}"),"chatId":format!("chat-{suffix}"),
        "cursor":{"runtimeGeneration":"generation","sequence":sequence},"state":"idle",
        "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
        "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
    })
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "echo".to_owned());
    match mode.as_str() {
        "descendant-child" => {
            let marker = PathBuf::from(std::env::args().nth(2).expect("marker path"));
            #[cfg(windows)]
            let mut file = {
                use std::os::windows::fs::OpenOptionsExt;
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .share_mode(0)
                    .open(marker)
                    .unwrap()
            };
            #[cfg(not(windows))]
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(marker)
                .unwrap();
            file.write_all(b"ready").unwrap();
            file.flush().unwrap();
            std::thread::sleep(Duration::from_secs(30));
        }
        "descendant" => {
            let marker = std::env::args().nth(2).expect("marker path");
            let request = read_frame();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["descendant-child", &marker])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let child_id = child.id();
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {"type":"error","code":"spawned","message":child_id.to_string()}
            }));
            std::thread::sleep(Duration::from_secs(30));
        }
        "silent" => std::thread::sleep(Duration::from_secs(30)),
        "invalid" => {
            std::io::stdout().write_all(&[0, 0, 0, 1, b'{']).unwrap();
            std::io::stdout().flush().unwrap();
        }
        "flood" => {
            std::io::stdout()
                .write_all(&((MAX_FRAME as u32) + 1).to_be_bytes())
                .unwrap();
            std::io::stdout().flush().unwrap();
        }
        "oversized-valid" => {
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {"type":"error","code":"closed","message":"x".repeat(201)}
            }));
        }
        "unsafe-integer" => {
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {
                    "type":"bootstrap_result",
                    "compatibility":{"status":"unavailable","reason":"not_installed"},
                    "sessions":[{
                        "sessionId":"session","accountId":null,"projectId":"project","chatId":"chat",
                        "cursor":{"runtimeGeneration":"generation","sequence":0},"state":"idle",
                        "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
                        "usage":{"input":9007199254740992_u64,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                        "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                    }]
                }
            }));
        }
        "duplicate-capability" => {
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {
                    "type":"discover_runtime_result",
                    "runtime":null,
                    "compatibility":{"status":"ready","profile":"profile","capabilities":["attach_snapshot","attach_snapshot"]}
                }
            }));
        }
        "broker-bootstrap" | "broker-wrong-profile" | "broker-generation-transition" => {
            let profile = if mode != "broker-wrong-profile" {
                "prime-agent-daemon-v7-schema13-816309b1cd50"
            } else {
                "wrong-profile"
            };
            let discovery = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": discovery["requestId"],
                "payload": {
                    "type":"discover_runtime_result",
                    "runtime":broker_runtime(),
                    "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50")
                }
            }));
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {
                    "type":"bootstrap_result",
                    "compatibility":broker_compatibility(profile),
                    "sessions":[{
                        "sessionId":"root","accountId":"account","projectId":"project","chatId":"chat",
                        "cursor":{"runtimeGeneration":"generation","sequence":1},"state":"idle",
                        "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
                        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                        "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                    }]
                }
            }));
            if mode == "broker-generation-transition" {
                let refresh = read_frame();
                write_frame(&json!({
                    "studioProtocol": 1,
                    "requestId": refresh["requestId"],
                    "payload": {"type":"error","code":"generation_changed","message":"rebootstrap required"}
                }));
                let rediscovery = read_frame();
                write_frame(&json!({
                    "studioProtocol": 1,
                    "requestId": rediscovery["requestId"],
                    "payload": {
                        "type":"discover_runtime_result",
                        "runtime":broker_runtime(),
                        "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50")
                    }
                }));
                let rebootstrap = read_frame();
                write_frame(&json!({
                    "studioProtocol": 1,
                    "requestId": rebootstrap["requestId"],
                    "payload": {
                        "type":"bootstrap_result",
                        "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50"),
                        "sessions":[{
                            "sessionId":"root","accountId":"account","projectId":"project","chatId":"chat",
                            "cursor":{"runtimeGeneration":"generation-b","sequence":1},"state":"idle",
                            "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
                            "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                            "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                        }]
                    }
                }));
            }
        }
        "broker-resident-create" | "broker-resident-mismatch" | "broker-resident-self-child" => {
            let discovery = read_frame();
            write_frame(&json!({
                "studioProtocol": 1, "requestId": discovery["requestId"],
                "payload": { "type":"discover_runtime_result", "runtime":broker_runtime(), "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50") }
            }));
            let bootstrap = read_frame();
            write_frame(&json!({
                "studioProtocol": 1, "requestId": bootstrap["requestId"],
                "payload": { "type":"bootstrap_result", "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50"), "sessions":[] }
            }));
            let create = read_frame();
            assert_eq!(create["payload"]["type"], "create_resident");
            let expected_creation = match mode.as_str() {
                "broker-resident-create" => "creation-00000001",
                "broker-resident-mismatch" => "creation-00000002",
                _ => "creation-00000004",
            };
            assert_eq!(create["payload"]["creationId"], expected_creation);
            let project_id = if mode == "broker-resident-create" {
                "project-resident"
            } else if mode == "broker-resident-mismatch" {
                "project-attacker"
            } else {
                "project-resident"
            };
            let children = if mode == "broker-resident-self-child" {
                json!([{"id":"resident-root","status":"running","task":"Recursive collision","provider":null,"model":null,"progress":null}])
            } else {
                json!([])
            };
            write_frame(&json!({
                "studioProtocol": 1, "requestId": create["requestId"],
                "payload": {
                    "type":"resident_created", "creationId":create["payload"]["creationId"],
                    "snapshot": {
                        "sessionId":"resident-root", "accountId":null, "projectId":project_id, "chatId":"resident-chat",
                        "cursor":{"runtimeGeneration":"generation","sequence":1}, "state":"idle",
                        "parentMessages":[], "children":children, "queue":[], "tools":[], "resources":[],
                        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                        "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                    }
                }
            }));
        }
        "broker-resident-branch" => {
            let discovery = read_frame();
            write_frame(&json!({
                "studioProtocol": 1, "requestId": discovery["requestId"],
                "payload": { "type":"discover_runtime_result", "runtime":broker_runtime(), "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50") }
            }));
            let bootstrap = read_frame();
            write_frame(&json!({
                "studioProtocol": 1, "requestId": bootstrap["requestId"],
                "payload": { "type":"bootstrap_result", "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50"), "sessions":[{
                    "sessionId":"root","accountId":"account","projectId":"project","chatId":"chat",
                    "cursor":{"runtimeGeneration":"generation-source","sequence":1},"state":"idle",
                    "parentMessages":[{"channel":"parent","kind":"user","id":"message-1","text":"Branch here","emittedAtMs":1}],
                    "children":[],"queue":[],"tools":[],"resources":[],
                    "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                    "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                }] }
            }));
            let branch = read_frame();
            assert_eq!(branch["payload"]["type"], "branch_resident");
            assert_eq!(branch["payload"]["creationId"], "studio-branch-1");
            assert_eq!(branch["payload"]["sourceSessionId"], "root");
            assert_eq!(branch["payload"]["entryId"], "message-1");
            write_frame(&json!({
                "studioProtocol": 1, "requestId": branch["requestId"],
                "payload": {
                    "type":"resident_branched","creationId":"studio-branch-1","sourceSessionId":"root","entryId":"message-1",
                    "snapshot": {
                        "sessionId":"branch-root","accountId":"account","projectId":"project","chatId":"branch-chat",
                        "cursor":{"runtimeGeneration":"generation-branch","sequence":1},"state":"idle",
                        "parentMessages":[{"channel":"parent","kind":"user","id":"message-1","text":"Branch here","emittedAtMs":1}],
                        "children":[],"queue":[],"tools":[],"resources":[],
                        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                        "workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}
                    }
                }
            }));
        }
        "broker-owned-bootstrap" => {
            let discovery = read_frame();
            assert_eq!(discovery["payload"]["type"], "discover_runtime");
            write_frame(
                &json!({"studioProtocol":1,"requestId":discovery["requestId"],"payload":{"type":"discover_runtime_result","runtime":broker_runtime(),"compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50")}}),
            );
            let attach = read_frame();
            assert_eq!(attach["payload"]["type"], "attach_session");
            assert_eq!(attach["payload"]["sessionId"], "root");
            write_frame(
                &json!({"studioProtocol":1,"requestId":attach["requestId"],"payload":{"type":"snapshot_result","snapshot":{"sessionId":"root","accountId":"account","projectId":"project","chatId":"chat","cursor":{"runtimeGeneration":"generation","sequence":1},"state":"idle","parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},"workerRecovery":{"status":"ready","closureReason":null,"observationId":null,"automaticRetryCount":0,"detail":null}}}}),
            );
        }
        "broker-worker-recovery" => {
            let discovery = read_frame();
            write_frame(
                &json!({"studioProtocol":1,"requestId":discovery["requestId"],"payload":{"type":"discover_runtime_result","runtime":broker_runtime(),"compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50")}}),
            );
            let attach = read_frame();
            assert_eq!(attach["payload"]["type"], "attach_session");
            let observation_id = "worker-recovery-0123456789abcdef012345";
            write_frame(
                &json!({"studioProtocol":1,"requestId":attach["requestId"],"payload":{"type":"snapshot_result","snapshot":{
                    "sessionId":"root","accountId":"account","projectId":"project","chatId":"chat",
                    "cursor":{"runtimeGeneration":"generation","sequence":1},"state":"failed",
                    "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
                    "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                    "workerRecovery":{"status":"retryable_failure","closureReason":"supervisor_recovery_exhausted","observationId":observation_id,"automaticRetryCount":0,"detail":"Verified supervisor recovery exhausted"}
                }}}),
            );
            let retry = read_frame();
            assert_eq!(retry["payload"]["type"], "retry_worker");
            assert_eq!(retry["payload"]["sessionId"], "root");
            assert_eq!(retry["payload"]["observationId"], observation_id);
            write_frame(
                &json!({"studioProtocol":1,"requestId":retry["requestId"],"payload":{"type":"worker_retry_result","observationId":observation_id,"outcome":"recovered","snapshot":{
                    "sessionId":"root","accountId":"account","projectId":"project","chatId":"chat",
                    "cursor":{"runtimeGeneration":"generation","sequence":2},"state":"idle",
                    "parentMessages":[],"children":[],"queue":[],"tools":[],"resources":[],
                    "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null},
                    "workerRecovery":{"status":"recovered","closureReason":"supervisor_recovery_exhausted","observationId":observation_id,"automaticRetryCount":1,"detail":null}
                }}}),
            );
        }
        "broker-quarantine" => {
            let discovery = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": discovery["requestId"],
                "payload": {
                    "type":"discover_runtime_result",
                    "runtime":broker_runtime(),
                    "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50")
                }
            }));
            let bootstrap = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": bootstrap["requestId"],
                "payload": {
                    "type":"bootstrap_result",
                    "compatibility":broker_compatibility("prime-agent-daemon-v7-schema13-816309b1cd50"),
                    "sessions":[quarantine_snapshot("root-a", 1), quarantine_snapshot("root-b", 1)]
                }
            }));
            let mut sequences = std::collections::BTreeMap::from([
                ("root-a".to_owned(), 1_u64),
                ("root-b".to_owned(), 1_u64),
            ]);
            let mut unknown_operations = std::collections::BTreeSet::new();
            loop {
                let request = read_frame();
                let payload = &request["payload"];
                let session_id = payload["sessionId"].as_str().unwrap();
                let mut next_snapshot = || {
                    let sequence = sequences.get_mut(session_id).unwrap();
                    *sequence += 1;
                    quarantine_snapshot(session_id, *sequence)
                };
                let response = match payload["type"].as_str().unwrap() {
                    "attach_session" | "refresh_session" => json!({
                        "type":"snapshot_result", "snapshot":next_snapshot()
                    }),
                    "session_command" => json!({
                        "type":"command_result",
                        "commandId":payload["commandId"],
                        "outcome":"accepted",
                        "snapshot":next_snapshot()
                    }),
                    "studio_operation" => {
                        let operation_id = payload["operationId"].as_str().unwrap();
                        if operation_id.starts_with("unknown-") {
                            let tombstone = (
                                session_id.to_owned(),
                                operation_id.to_owned(),
                                payload["idempotencyKey"].as_str().map(str::to_owned),
                            );
                            let first_admission = unknown_operations.insert(tombstone);
                            json!({
                                "type":"studio_operation_result","operationId":operation_id,
                                "status":"unknown_outcome","commandId":null,"position":null,
                                "revision":null,
                                "reason":if first_admission { "outcome uncertain" } else { "operation remains tombstoned" },
                                "retryable":false,
                                "snapshot":null
                            })
                        } else {
                            json!({
                                "type":"studio_operation_result","operationId":operation_id,
                                "status":"updated","commandId":null,"position":null,
                                "revision":null,"reason":null,"retryable":null,
                                "snapshot":next_snapshot()
                            })
                        }
                    }
                    other => panic!("unexpected quarantine request: {other}"),
                };
                write_frame(&json!({
                    "studioProtocol":1,
                    "requestId":request["requestId"],
                    "payload":response
                }));
            }
        }
        "diagnostic" => {
            eprintln!(
                "{}",
                concat!("Bearer TOPSECRET C:", "\\Users\\Private\\AppData\\Local")
            );
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {"type":"error","code":"clean","message":"diagnostic recorded"}
            }));
        }
        "environment" => {
            let request = read_frame();
            let clean = std::env::var_os("HARNESS_TEST_SECRET").is_none()
                && std::env::var_os("PRIME_STUDIO_CHANNEL_NONCE").is_some();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {
                    "type":"error",
                    "code": if clean { "clean" } else { "leaked" },
                    "message":"environment checked"
                }
            }));
        }
        _ => {
            let request = read_frame();
            write_frame(&json!({
                "studioProtocol": 1,
                "requestId": request["requestId"],
                "payload": {"type":"error","code":"echo","message":"closed response"}
            }));
        }
    }
}
