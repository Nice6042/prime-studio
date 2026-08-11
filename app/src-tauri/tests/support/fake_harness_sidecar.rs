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
                        "usage":{"input":9007199254740992_u64,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":null}
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
        "diagnostic" => {
            eprintln!("Bearer TOPSECRET C:\\Users\\Private\\AppData\\Local");
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
