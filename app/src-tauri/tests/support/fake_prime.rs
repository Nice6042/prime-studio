use std::collections::BTreeMap;
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn write_json(out: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, value)?;
    out.write_all(b"\n")
}

fn padded_json(kind: &str, encoded_len: usize) -> Vec<u8> {
    let empty = serde_json::to_vec(&json!({ "kind": kind, "padding": "" })).unwrap();
    assert!(
        empty.len() <= encoded_len,
        "fixture frame bound is too small"
    );
    serde_json::to_vec(&json!({
        "kind": kind,
        "padding": "x".repeat(encoded_len - empty.len()),
    }))
    .unwrap()
}

fn launch_contract(args: Vec<String>) -> io::Result<()> {
    let env: BTreeMap<String, String> = env::vars().collect();
    let event = json!({
        "type": "launch_contract",
        "executable": env::current_exe()?.to_string_lossy(),
        "args": args,
        "env": env,
        "cwd": env::current_dir()?.to_string_lossy(),
    });
    write_json(&mut io::stdout().lock(), &event)
}

fn frames(limit: usize) -> io::Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(&padded_json("boundary", limit))?;
    out.write_all(b"\n")?;
    out.write_all(&padded_json("oversized", limit + 1))?;
    out.write_all(b"\n")?;
    write_json(&mut out, &json!({ "kind": "after-fault" }))?;
    out.flush()?;
    block_on_input()
}

fn unterminated_oversized_frame(limit: usize) -> io::Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(&vec![b'x'; limit + 1])?;
    out.flush()?;
    block_on_input()
}

fn malformed_record(bytes: &[u8]) -> io::Result<()> {
    let mut out = io::stdout().lock();
    write_json(&mut out, &json!({ "kind": "before-fault" }))?;
    out.write_all(bytes)?;
    out.write_all(b"\n")?;
    write_json(&mut out, &json!({ "kind": "after-fault" }))?;
    out.flush()?;
    block_on_input()
}

fn reversed_responses() -> io::Result<()> {
    let mut input = io::stdin().lock().lines();
    let first: Value = serde_json::from_str(
        &input
            .next()
            .expect("first request is present")
            .expect("first request is readable"),
    )?;
    let second: Value = serde_json::from_str(
        &input
            .next()
            .expect("second request is present")
            .expect("second request is readable"),
    )?;
    let first_id = first["id"].as_str().expect("first wire id");
    let second_id = second["id"].as_str().expect("second wire id");
    let old_generation = first_id.replacen("/9/", "/8/", 1);

    let mut out = io::stdout().lock();
    write_json(
        &mut out,
        &json!({ "type": "response", "id": second_id, "success": true, "data": "second" }),
    )?;
    write_json(
        &mut out,
        &json!({ "type": "response", "id": first_id, "success": true, "data": "first" }),
    )?;
    write_json(
        &mut out,
        &json!({ "type": "response", "id": first_id, "success": true, "data": "first" }),
    )?;
    write_json(
        &mut out,
        &json!({ "type": "response", "id": old_generation, "success": true }),
    )?;
    write_json(
        &mut out,
        &json!({ "type": "response", "id": "foreign-id", "success": true }),
    )?;
    write_json(&mut out, &json!({ "kind": "after-rejections" }))?;
    out.flush()
}

fn conflicting_duplicate() -> io::Result<()> {
    let mut input = io::stdin().lock().lines();
    let request: Value = serde_json::from_str(
        &input
            .next()
            .expect("request is present")
            .expect("request is readable"),
    )?;
    let id = request["id"].as_str().expect("wire id");

    let mut out = io::stdout().lock();
    write_json(
        &mut out,
        &json!({ "type": "response", "id": id, "success": true, "data": "first" }),
    )?;
    write_json(
        &mut out,
        &json!({ "type": "response", "id": id, "success": true, "data": "conflict" }),
    )?;
    write_json(&mut out, &json!({ "kind": "after-fault" }))?;
    out.flush()?;
    block_on_input()
}

fn malformed_response() -> io::Result<()> {
    let mut out = io::stdout().lock();
    write_json(
        &mut out,
        &json!({ "type": "response", "success": true, "data": "missing id" }),
    )?;
    write_json(&mut out, &json!({ "kind": "after-fault" }))?;
    out.flush()?;
    block_on_input()
}

fn block_on_input() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).map(|_| ())
}

fn hold_until_input_closes() -> io::Result<()> {
    let mut out = io::stdout().lock();
    write_json(&mut out, &json!({ "kind": "ready" }))?;
    out.flush()?;

    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    write_json(
        &mut out,
        &json!({ "kind": "after-input-closed", "bytesRead": input.len() }),
    )?;
    out.flush()
}

fn block_without_reading_stdin(cleanup_sentinel: &Path) -> io::Result<()> {
    let mut out = io::stdout().lock();
    write_json(&mut out, &json!({ "kind": "ready" }))?;
    out.flush()?;
    while !cleanup_sentinel.exists() {
        std::thread::yield_now();
    }
    Ok(())
}

fn close_outputs_and_hold(cleanup_sentinel: &Path) -> io::Result<()> {
    {
        let mut out = io::stdout().lock();
        write_json(&mut out, &json!({ "kind": "ready" }))?;
        out.flush()?;
    }
    close_output_handles();
    while !cleanup_sentinel.exists() {
        std::thread::yield_now();
    }
    Ok(())
}

fn spawn_inheriting_output_grandchild(
    cleanup_sentinel: &Path,
    stopped_sentinel: &Path,
) -> io::Result<()> {
    let mut start = String::new();
    io::stdin().read_line(&mut start)?;
    {
        let mut out = io::stdout().lock();
        write_json(&mut out, &json!({ "kind": "direct-first" }))?;
        write_json(&mut out, &json!({ "kind": "direct-final" }))?;
        out.flush()?;
    }
    Command::new(env::current_exe()?)
        .args([
            "hold-inherited-outputs",
            cleanup_sentinel.to_string_lossy().as_ref(),
            stopped_sentinel.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    Ok(())
}

fn hold_inherited_outputs(cleanup_sentinel: &Path, stopped_sentinel: &Path) -> io::Result<()> {
    while !cleanup_sentinel.exists() {
        std::thread::yield_now();
    }
    std::fs::write(stopped_sentinel, b"stopped")
}

#[cfg(windows)]
fn close_output_handles() {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetStdHandle(handle: u32) -> *mut c_void;
    }

    for handle in [-11_i32 as u32, -12_i32 as u32] {
        unsafe {
            let _ = CloseHandle(GetStdHandle(handle));
        }
    }
}

#[cfg(unix)]
fn close_output_handles() {
    unsafe extern "C" {
        fn close(fd: i32) -> i32;
    }

    for fd in [1, 2] {
        unsafe {
            let _ = close(fd);
        }
    }
}

fn main() -> io::Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("launch-contract") => {
            launch_contract(args.collect())?;
            std::process::exit(11);
        }
        Some("frames") => {
            let limit = args
                .next()
                .expect("frames requires a byte limit")
                .parse()
                .expect("frame byte limit is numeric");
            frames(limit)?;
            std::process::exit(17);
        }
        Some("unterminated-oversized") => {
            let limit = args
                .next()
                .expect("unterminated-oversized requires a byte limit")
                .parse()
                .expect("frame byte limit is numeric");
            unterminated_oversized_frame(limit)?;
            std::process::exit(17);
        }
        Some("malformed-json") => {
            malformed_record(b"not-json")?;
            std::process::exit(18);
        }
        Some("malformed-utf8") => {
            malformed_record(b"\xff")?;
            std::process::exit(18);
        }
        Some("blank-record") => {
            malformed_record(b"")?;
            std::process::exit(18);
        }
        Some("whitespace-record") => {
            malformed_record(b" \t\r")?;
            std::process::exit(18);
        }
        Some("responses-reversed") => {
            reversed_responses()?;
            std::process::exit(19);
        }
        Some("response-conflict") => {
            conflicting_duplicate()?;
            std::process::exit(20);
        }
        Some("response-malformed") => {
            malformed_response()?;
            std::process::exit(21);
        }
        Some("hold") => {
            hold_until_input_closes()?;
            std::process::exit(23);
        }
        Some("block-stdin") => {
            let sentinel = args
                .next()
                .expect("block-stdin requires a cleanup sentinel");
            block_without_reading_stdin(Path::new(&sentinel))?;
            std::process::exit(24);
        }
        Some("close-output-hold") => {
            let sentinel = args
                .next()
                .expect("close-output-hold requires a cleanup sentinel");
            close_outputs_and_hold(Path::new(&sentinel))?;
            std::process::exit(25);
        }
        Some("exit-with-inheriting-grandchild") => {
            let cleanup = args
                .next()
                .expect("exit-with-inheriting-grandchild requires a cleanup sentinel");
            let stopped = args
                .next()
                .expect("exit-with-inheriting-grandchild requires a stopped sentinel");
            spawn_inheriting_output_grandchild(Path::new(&cleanup), Path::new(&stopped))?;
            std::process::exit(26);
        }
        Some("hold-inherited-outputs") => {
            let cleanup = args
                .next()
                .expect("hold-inherited-outputs requires a cleanup sentinel");
            let stopped = args
                .next()
                .expect("hold-inherited-outputs requires a stopped sentinel");
            hold_inherited_outputs(Path::new(&cleanup), Path::new(&stopped))?;
            std::process::exit(27);
        }
        other => panic!("unknown fake Prime scenario: {other:?}"),
    }
}
