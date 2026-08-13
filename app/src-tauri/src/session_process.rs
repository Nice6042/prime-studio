//! Process and JSONL boundary used by the Tauri adapter and executable-level tests.
//!
//! This module is public only so tests outside the crate can exercise the real
//! process boundary. UI code reaches it through the private commands in `lib.rs`.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;
use uuid::Uuid;

#[cfg(windows)]
pub(crate) struct ProcessContainment {
    _job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
pub(crate) fn prepare_process_containment(_command: &mut Command) {}

#[cfg(windows)]
pub(crate) fn contain_child(child: &Child) -> io::Result<ProcessContainment> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ThreadEntry32 {
        size: u32,
        usage_count: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_priority: i32,
        priority_delta: i32,
        flags: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            information_class: i32,
            information: *const c_void,
            information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit_handle: i32, thread_id: u32) -> *mut c_void;
        fn ResumeThread(thread: *mut c_void) -> u32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0000_0002;

    let raw_job = unsafe { CreateJobObjectW(null(), null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = ExtendedLimitInformation::default();
    limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let length = u32::try_from(size_of::<ExtendedLimitInformation>())
        .expect("Windows job information fits in u32");
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &limits as *const _ as *const c_void,
            length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw_snapshot as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw_snapshot) };
    let mut entry = ThreadEntry32 {
        size: u32::try_from(size_of::<ThreadEntry32>()).expect("thread entry size fits u32"),
        ..ThreadEntry32::default()
    };
    let mut found = false;
    let mut has_entry = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while has_entry {
        if entry.owner_process_id == child.id() {
            let raw_thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
            if raw_thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(raw_thread) };
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            found = true;
        }
        has_entry = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    if !found {
        return Err(io::Error::other(
            "spawned process has no resumable initial thread",
        ));
    }
    Ok(ProcessContainment { _job: job })
}

#[cfg(unix)]
pub(crate) struct ProcessContainment(i32);

#[cfg(unix)]
impl Drop for ProcessContainment {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn kill(process_group: i32, signal: i32) -> i32;
        }
        unsafe {
            let _ = kill(-self.0, 9);
        }
    }
}

#[cfg(unix)]
pub(crate) fn prepare_process_containment(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(unix)]
pub(crate) fn contain_child(child: &Child) -> io::Result<ProcessContainment> {
    let group = i32::try_from(child.id()).map_err(|_| io::Error::other("child id exceeds i32"))?;
    Ok(ProcessContainment(group))
}

pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const DEFAULT_TOMBSTONES: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    FrameTooLarge {
        stream: ProcessStream,
        limit: usize,
    },
    MalformedUtf8 {
        stream: ProcessStream,
    },
    Read {
        stream: ProcessStream,
        error: String,
    },
    ResponseRejected {
        id: Option<String>,
        reason: ResponseRejection,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolFault {
    FrameTooLarge {
        stream: ProcessStream,
        limit: usize,
    },
    MalformedUtf8 {
        stream: ProcessStream,
    },
    MalformedJson {
        line: String,
        error: String,
    },
    MalformedResponse {
        id: Option<String>,
    },
    ConflictingDuplicate {
        id: String,
    },
    Read {
        stream: ProcessStream,
        error: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseRejection {
    Late,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseFault {
    Malformed,
    ConflictingDuplicate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponseDisposition {
    Current { client_id: String },
    Duplicate,
    Rejected(ResponseRejection),
    Fault(ResponseFault),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Tombstone {
    Completed(Value),
    Cancelled,
    Exited,
}

#[derive(Debug)]
pub struct RequestTracker {
    scope: String,
    generation: u64,
    next: u64,
    pending: HashMap<String, String>,
    tombstones: HashMap<String, Tombstone>,
    tombstone_order: VecDeque<String>,
    tombstone_limit: usize,
}

impl RequestTracker {
    pub fn fixture(scope: &str, generation: u64, tombstone_limit: usize) -> Self {
        Self::with_scope(normalize_scope(scope), generation, tombstone_limit)
    }

    pub fn random(session: &str, generation: u64, tombstone_limit: usize) -> Self {
        let scope = format!("{}-{}", normalize_scope(session), Uuid::new_v4().simple());
        Self::with_scope(scope, generation, tombstone_limit)
    }

    fn with_scope(scope: String, generation: u64, tombstone_limit: usize) -> Self {
        Self {
            scope,
            generation,
            next: 0,
            pending: HashMap::new(),
            tombstones: HashMap::new(),
            tombstone_order: VecDeque::new(),
            tombstone_limit,
        }
    }

    pub fn prepare(&mut self, client_id: impl Into<String>) -> String {
        self.next = self
            .next
            .checked_add(1)
            .expect("request sequence exhausted");
        let wire_id = format!(
            "prime-studio/{}/{}/{}",
            self.scope, self.generation, self.next
        );
        self.pending.insert(wire_id.clone(), client_id.into());
        wire_id
    }

    pub fn cancel(&mut self, wire_id: &str) -> bool {
        if self.pending.remove(wire_id).is_none() {
            return false;
        }
        self.remember(wire_id.to_string(), Tombstone::Cancelled);
        true
    }

    pub fn retire_all(&mut self) {
        let pending: Vec<String> = self.pending.drain().map(|(wire_id, _)| wire_id).collect();
        for wire_id in pending {
            self.remember(wire_id, Tombstone::Exited);
        }
    }

    pub fn classify_response(&mut self, response: &mut Value) -> ResponseDisposition {
        let Some(wire_id) = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return ResponseDisposition::Fault(ResponseFault::Malformed);
        };

        if let Some(client_id) = self.pending.remove(&wire_id) {
            self.remember(wire_id, Tombstone::Completed(response.clone()));
            response["id"] = Value::String(client_id.clone());
            return ResponseDisposition::Current { client_id };
        }

        if let Some(tombstone) = self.tombstones.get(&wire_id) {
            return match tombstone {
                Tombstone::Completed(completed) if completed == response => {
                    ResponseDisposition::Duplicate
                }
                Tombstone::Completed(_) => {
                    ResponseDisposition::Fault(ResponseFault::ConflictingDuplicate)
                }
                Tombstone::Cancelled | Tombstone::Exited => {
                    ResponseDisposition::Rejected(ResponseRejection::Late)
                }
            };
        }

        let rejection = if self.is_retired_scope(&wire_id) {
            ResponseRejection::Late
        } else {
            ResponseRejection::Unknown
        };
        ResponseDisposition::Rejected(rejection)
    }

    pub fn tombstone_len(&self) -> usize {
        self.tombstones.len()
    }

    fn remember(&mut self, wire_id: String, tombstone: Tombstone) {
        if self.tombstone_limit == 0 {
            return;
        }
        if !self.tombstones.contains_key(&wire_id) {
            self.tombstone_order.push_back(wire_id.clone());
        }
        self.tombstones.insert(wire_id, tombstone);
        while self.tombstone_order.len() > self.tombstone_limit {
            if let Some(evicted) = self.tombstone_order.pop_front() {
                self.tombstones.remove(&evicted);
            }
        }
    }

    fn is_retired_scope(&self, wire_id: &str) -> bool {
        let prefix = format!("prime-studio/{}/", self.scope);
        let Some(remainder) = wire_id.strip_prefix(&prefix) else {
            return false;
        };
        let Some((generation, sequence)) = remainder.split_once('/') else {
            return false;
        };
        let (Ok(generation), Ok(sequence)) = (generation.parse::<u64>(), sequence.parse::<u64>())
        else {
            return false;
        };
        generation != self.generation || sequence <= self.next
    }
}

fn normalize_scope(scope: &str) -> String {
    let normalized: String = scope
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if normalized.is_empty() {
        "session".to_string()
    } else {
        normalized
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProcessEvent {
    Json(Value),
    Stderr(String),
    ProtocolError(ProtocolError),
    ProtocolFault(ProtocolFault),
    Exited(ProcessExit),
}

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: ProcessEvent);
}

// Intentionally no `Debug`: the exact environment is not diagnostic material.
#[derive(Clone)]
pub struct ProcessSpec {
    executable: PathBuf,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    env: BTreeMap<OsString, OsString>,
    max_frame_bytes: usize,
    session_scope: String,
    generation: u64,
    randomize_scope: bool,
    tombstone_limit: usize,
}

impl ProcessSpec {
    /// Start a specification with an empty child environment.
    ///
    /// `executable` is rejected by [`spawn`] unless it is absolute. Callers must
    /// supply the complete, already-vetted environment returned by the shared
    /// environment policy; values are never merged with the ambient process.
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            session_scope: String::new(),
            generation: 0,
            randomize_scope: false,
            tombstone_limit: DEFAULT_TOMBSTONES,
        }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn envs<I, K, V>(mut self, env: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        self.env.extend(
            env.into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        self
    }

    pub fn max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = max_frame_bytes;
        self
    }

    pub fn session(mut self, scope: impl Into<String>, generation: u64) -> Self {
        self.session_scope = scope.into();
        self.generation = generation;
        self.randomize_scope = false;
        self
    }

    pub fn random_session(mut self, session: impl Into<String>, generation: u64) -> Self {
        self.session_scope = session.into();
        self.generation = generation;
        self.randomize_scope = true;
        self
    }

    pub fn tombstone_limit(mut self, tombstone_limit: usize) -> Self {
        self.tombstone_limit = tombstone_limit;
        self
    }
}

#[derive(Default)]
struct EventGate {
    in_flight: usize,
    pending_exit: Option<ProcessExit>,
    terminal_delivered: bool,
}

impl EventGate {
    fn open() -> Self {
        Self::default()
    }
}

struct Shared {
    child: Mutex<Option<Child>>,
    child_changed: Condvar,
    containment: Mutex<Option<ProcessContainment>>,
    natural_exit: Mutex<Option<ProcessExit>>,
    stdin: Mutex<Option<ChildStdin>>,
    accepting: AtomicBool,
    event_gate: Mutex<EventGate>,
    exit: Mutex<Option<ProcessExit>>,
    exit_ready: Condvar,
    readers: AtomicUsize,
    sink: Arc<dyn EventSink>,
    requests: Mutex<RequestTracker>,
    max_frame_bytes: usize,
}

struct DeliveryGuard<'a> {
    shared: &'a Shared,
}

impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) {
        self.shared.finish_event_delivery();
    }
}

impl Shared {
    fn emit(&self, event: ProcessEvent) {
        if self.begin_event_delivery() {
            let _delivery = DeliveryGuard { shared: self };
            self.sink.emit(event);
        }
    }

    fn begin_event_delivery(&self) -> bool {
        let mut gate = self.event_gate.lock().unwrap_or_else(|e| e.into_inner());
        if gate.terminal_delivered
            || gate.pending_exit.is_some()
            || !self.accepting.load(Ordering::Acquire)
        {
            return false;
        }
        gate.in_flight += 1;
        true
    }

    fn finish_event_delivery(&self) {
        let exit = {
            let mut gate = self.event_gate.lock().unwrap_or_else(|e| e.into_inner());
            gate.in_flight = gate
                .in_flight
                .checked_sub(1)
                .expect("every completed event has an in-flight reservation");
            if gate.in_flight == 0 {
                gate.pending_exit.take().inspect(|_| {
                    gate.terminal_delivered = true;
                })
            } else {
                None
            }
        };
        if let Some(exit) = exit {
            self.sink.emit(ProcessEvent::Exited(exit));
        }
    }

    fn publish_exit(&self, exit: ProcessExit) {
        let stored = {
            let mut terminal = self.exit.lock().unwrap_or_else(|e| e.into_inner());
            if terminal.is_some() {
                false
            } else {
                *terminal = Some(exit.clone());
                true
            }
        };
        if !stored {
            return;
        }
        self.exit_ready.notify_all();

        let deliver_now = {
            let mut gate = self.event_gate.lock().unwrap_or_else(|e| e.into_inner());
            if gate.in_flight == 0 {
                gate.terminal_delivered = true;
                true
            } else {
                gate.pending_exit = Some(exit.clone());
                false
            }
        };
        if deliver_now {
            self.sink.emit(ProcessEvent::Exited(exit));
        }
    }

    fn reader_done(self: &Arc<Self>) {
        if self.readers.fetch_sub(1, Ordering::AcqRel) == 1 {
            if let Some(exit) = self
                .natural_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
            {
                self.complete_process_exit(exit);
            } else {
                self.finish(false);
            }
        }
    }

    fn watch_child_exit(self: &Arc<Self>) {
        loop {
            let status = {
                let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
                let result = match child.as_mut() {
                    Some(child) => child.try_wait(),
                    None => return,
                };
                match result {
                    Ok(Some(status)) => {
                        child.take();
                        Some(Ok(status))
                    }
                    Ok(None) => {
                        let _ = self
                            .child_changed
                            .wait_timeout(child, Duration::from_millis(10))
                            .unwrap_or_else(|e| e.into_inner());
                        None
                    }
                    Err(error) => Some(Err(error)),
                }
            };

            match status {
                Some(Ok(status)) => {
                    *self.natural_exit.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(ProcessExit {
                            code: status.code(),
                            cancelled: false,
                        });
                    self.terminate_process_tree();
                    if self.readers.load(Ordering::Acquire) == 0 {
                        if let Some(exit) = self
                            .natural_exit
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take()
                        {
                            self.complete_process_exit(exit);
                        }
                    }
                    return;
                }
                Some(Err(_)) => {
                    self.finish(false);
                    return;
                }
                None => {}
            }
        }
    }

    fn emit_json(&self, mut value: Value) {
        if value.get("type").and_then(Value::as_str) != Some("response") {
            self.emit(ProcessEvent::Json(value));
            return;
        }

        let wire_id = value.get("id").and_then(Value::as_str).map(str::to_string);
        let disposition = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .classify_response(&mut value);
        match disposition {
            ResponseDisposition::Current { .. } => self.emit(ProcessEvent::Json(value)),
            ResponseDisposition::Duplicate => {}
            ResponseDisposition::Rejected(reason) => self.emit(ProcessEvent::ProtocolError(
                ProtocolError::ResponseRejected {
                    id: wire_id,
                    reason,
                },
            )),
            ResponseDisposition::Fault(ResponseFault::Malformed) => {
                self.protocol_fault(ProtocolFault::MalformedResponse { id: wire_id });
            }
            ResponseDisposition::Fault(ResponseFault::ConflictingDuplicate) => {
                self.protocol_fault(ProtocolFault::ConflictingDuplicate {
                    id: wire_id.unwrap_or_else(|| "<missing>".to_string()),
                });
            }
        }
    }

    fn protocol_fault(&self, fault: ProtocolFault) {
        let reserved = {
            let mut gate = self.event_gate.lock().unwrap_or_else(|e| e.into_inner());
            if gate.terminal_delivered
                || gate.pending_exit.is_some()
                || !self.accepting.swap(false, Ordering::AcqRel)
            {
                false
            } else {
                gate.in_flight += 1;
                true
            }
        };
        if reserved {
            self.requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retire_all();
            {
                let _delivery = DeliveryGuard { shared: self };
                self.sink.emit(ProcessEvent::ProtocolFault(fault));
            }
            self.finish(true);
        }
    }

    fn finish(&self, cancelled: bool) {
        self.accepting.store(false, Ordering::Release);
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.child_changed.notify_all();
        let Some(mut child) = child else {
            return;
        };

        let status = if cancelled {
            let _ = child.kill();
            self.terminate_process_tree();
            child.wait().ok()
        } else {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.terminate_process_tree();
                    Some(status)
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    self.terminate_process_tree();
                    child.wait().ok()
                }
            }
        };
        self.complete_exit(status, cancelled);
    }

    fn terminate_process_tree(&self) {
        drop(
            self.containment
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(),
        );
    }

    fn complete_exit(&self, status: Option<ExitStatus>, cancelled: bool) {
        self.complete_process_exit(ProcessExit {
            code: status.and_then(|status| status.code()),
            cancelled,
        });
    }

    fn complete_process_exit(&self, exit: ProcessExit) {
        self.accepting.store(false, Ordering::Release);
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retire_all();
        self.publish_exit(exit);
    }
}

pub struct ProcessHandle {
    shared: Arc<Shared>,
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // Worker threads also retain `Shared`; the handle is the process owner's
        // RAII boundary, including failures before a caller can register it.
        self.shared.finish(true);
    }
}

impl ProcessHandle {
    pub fn send(&self, mut command: Value) -> io::Result<String> {
        self.ensure_accepting()?;
        let object = command.as_object_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "RPC command must be an object")
        })?;
        let client_id = match object.get("id") {
            Some(Value::String(id)) if !id.is_empty() => id.clone(),
            Some(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "RPC command id must be a non-empty string",
                ));
            }
            None => format!("client-{}", Uuid::new_v4().simple()),
        };
        let wire_id = self
            .shared
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .prepare(client_id.clone());
        object.insert("id".to_string(), Value::String(wire_id.clone()));
        let mut line = serde_json::to_vec(&command)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if line.len() > self.shared.max_frame_bytes {
            self.shared
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel(&wire_id);
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "RPC command exceeds the encoded frame limit",
            ));
        }
        line.push(b'\n');

        if let Err(error) = self.ensure_accepting() {
            self.shared
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel(&wire_id);
            return Err(error);
        }

        let result = {
            let mut stdin = self.shared.stdin.lock().unwrap_or_else(|e| e.into_inner());
            match stdin.as_mut() {
                Some(stdin) => stdin.write_all(&line).and_then(|()| stdin.flush()),
                None => Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "process input is closed",
                )),
            }
        };
        if let Err(error) = result {
            self.shared
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel(&wire_id);
            return Err(error);
        }
        Ok(client_id)
    }

    fn ensure_accepting(&self) -> io::Result<()> {
        if self.shared.accepting.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "process session is closed or quarantined",
            ))
        }
    }

    pub fn close_input(&self) -> io::Result<()> {
        let stdin = self
            .shared
            .stdin
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        drop(stdin);
        Ok(())
    }

    pub fn cancel(&self) -> io::Result<()> {
        self.shared.finish(true);
        Ok(())
    }

    pub fn wait_for_exit(&self, timeout: Duration) -> Option<ProcessExit> {
        let exit = self.shared.exit.lock().unwrap_or_else(|e| e.into_inner());
        let (exit, _) = self
            .shared
            .exit_ready
            .wait_timeout_while(exit, timeout, |exit| exit.is_none())
            .unwrap_or_else(|e| e.into_inner());
        exit.clone()
    }
}

enum BoundedFrame {
    Bytes(Vec<u8>),
    TooLarge,
}

fn read_bounded_frames(
    mut reader: impl BufRead,
    limit: usize,
    mut consume_frame: impl FnMut(BoundedFrame) -> bool,
) -> io::Result<()> {
    let retained_limit = limit
        .checked_add(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame limit is too large"))?;
    let mut frame = Vec::with_capacity(retained_limit.min(8192));
    let mut oversized = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !oversized && !frame.is_empty() {
                let _ = consume_frame(BoundedFrame::Bytes(std::mem::take(&mut frame)));
            }
            return Ok(());
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let body_len = newline.unwrap_or(available.len());
        if !oversized {
            let keep = retained_limit.saturating_sub(frame.len()).min(body_len);
            frame.extend_from_slice(&available[..keep]);
            oversized = keep < body_len || frame.len() > limit;
            if oversized && !consume_frame(BoundedFrame::TooLarge) {
                return Ok(());
            }
        }

        let consumed = body_len + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            let continue_reading = if oversized {
                true
            } else {
                consume_frame(BoundedFrame::Bytes(std::mem::take(&mut frame)))
            };
            if !continue_reading {
                return Ok(());
            }
            frame.clear();
            oversized = false;
        }
    }
}

fn stdout_reader(reader: impl BufRead, limit: usize, shared: &Shared) {
    let result = read_bounded_frames(reader, limit, |frame| match frame {
        BoundedFrame::TooLarge => {
            shared.protocol_fault(ProtocolFault::FrameTooLarge {
                stream: ProcessStream::Stdout,
                limit,
            });
            false
        }
        BoundedFrame::Bytes(mut bytes) => {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            match std::str::from_utf8(&bytes) {
                Err(_) => {
                    shared.protocol_fault(ProtocolFault::MalformedUtf8 {
                        stream: ProcessStream::Stdout,
                    });
                    false
                }
                Ok(line) => match serde_json::from_str(line) {
                    Ok(value) => {
                        shared.emit_json(value);
                        shared.accepting.load(Ordering::Acquire)
                    }
                    Err(error) => {
                        shared.protocol_fault(ProtocolFault::MalformedJson {
                            line: line.to_string(),
                            error: error.to_string(),
                        });
                        false
                    }
                },
            }
        }
    });
    if let Err(error) = result {
        shared.protocol_fault(ProtocolFault::Read {
            stream: ProcessStream::Stdout,
            error: error.to_string(),
        });
    }
}

fn stderr_reader(reader: impl BufRead, limit: usize, shared: &Shared) {
    let result = read_bounded_frames(reader, limit, |frame| match frame {
        BoundedFrame::TooLarge => {
            shared.emit(ProcessEvent::ProtocolError(ProtocolError::FrameTooLarge {
                stream: ProcessStream::Stderr,
                limit,
            }));
            true
        }
        BoundedFrame::Bytes(mut bytes) => {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            match String::from_utf8(bytes) {
                Ok(line) => shared.emit(ProcessEvent::Stderr(line)),
                Err(_) => shared.emit(ProcessEvent::ProtocolError(ProtocolError::MalformedUtf8 {
                    stream: ProcessStream::Stderr,
                })),
            }
            true
        }
    });
    if let Err(error) = result {
        shared.emit(ProcessEvent::ProtocolError(ProtocolError::Read {
            stream: ProcessStream::Stderr,
            error: error.to_string(),
        }));
    }
}

/// Own a newly spawned child until containment and pipe extraction complete.
/// Any early return kills and waits instead of leaking an unregistered process.
struct PendingChild(Option<Child>);

impl PendingChild {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn child(&self) -> &Child {
        self.0.as_ref().expect("pending child is still armed")
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("pending child is still armed")
    }

    fn into_child(mut self) -> Child {
        self.0.take().expect("pending child is still armed")
    }

    fn kill_and_wait(&mut self) -> io::Result<ExitStatus> {
        let mut child = self.0.take().expect("pending child is still armed");
        let _ = child.kill();
        child.wait()
    }
}

impl Drop for PendingChild {
    fn drop(&mut self) {
        if self.0.is_some() {
            let _ = self.kill_and_wait();
        }
    }
}

pub fn spawn(spec: ProcessSpec, sink: Arc<dyn EventSink>) -> io::Result<ProcessHandle> {
    if spec.max_frame_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "maximum frame size must be greater than zero",
        ));
    }
    if spec.session_scope.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session scope must not be empty",
        ));
    }
    if !spec.executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process executable must be an explicit absolute path",
        ));
    }
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    suppress_console_window(&mut command);
    prepare_process_containment(&mut command);

    let mut pending = PendingChild::new(command.spawn()?);
    let containment = contain_child(pending.child())?;
    let stdin = pending
        .child_mut()
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("child has no stdin"))?;
    let stdout = pending
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("child has no stdout"))?;
    let stderr = pending
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("child has no stderr"))?;
    let child = pending.into_child();

    let requests = if spec.randomize_scope {
        RequestTracker::random(&spec.session_scope, spec.generation, spec.tombstone_limit)
    } else {
        RequestTracker::fixture(&spec.session_scope, spec.generation, spec.tombstone_limit)
    };
    let shared = Arc::new(Shared {
        child: Mutex::new(Some(child)),
        child_changed: Condvar::new(),
        containment: Mutex::new(Some(containment)),
        natural_exit: Mutex::new(None),
        stdin: Mutex::new(Some(stdin)),
        accepting: AtomicBool::new(true),
        event_gate: Mutex::new(EventGate::open()),
        exit: Mutex::new(None),
        exit_ready: Condvar::new(),
        readers: AtomicUsize::new(2),
        sink,
        requests: Mutex::new(requests),
        max_frame_bytes: spec.max_frame_bytes,
    });

    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            stdout_reader(BufReader::new(stdout), spec.max_frame_bytes, &shared);
            shared.reader_done();
        });
    }
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            stderr_reader(BufReader::new(stderr), spec.max_frame_bytes, &shared);
            shared.reader_done();
        });
    }
    {
        let shared = shared.clone();
        std::thread::spawn(move || shared.watch_child_exit());
    }

    Ok(ProcessHandle { shared })
}

#[cfg(windows)]
pub(crate) fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

#[cfg(not(windows))]
pub(crate) fn suppress_console_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_does_not_resynchronize_after_a_terminal_consumer_decision() {
        let mut seen = Vec::new();
        read_bounded_frames(Cursor::new(b"malformed\nlater\n"), 32, |frame| {
            match frame {
                BoundedFrame::Bytes(bytes) => seen.push(bytes),
                BoundedFrame::TooLarge => panic!("fixture records are within the bound"),
            }
            false
        })
        .unwrap();

        assert_eq!(seen, [b"malformed".to_vec()]);
    }

    #[test]
    fn pending_child_cleanup_kills_and_waits_a_real_process() {
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args([
                "--exact",
                "tests::oversized_process_output_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_OUTPUT_FIXTURE", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().expect("spawn long-lived fixture");
        let mut pending = PendingChild::new(child);

        let status = pending
            .kill_and_wait()
            .expect("pre-registration cleanup waits for termination");
        assert!(!status.success(), "killed child cannot report success");
    }

    #[test]
    fn live_process_lines_fail_before_unbounded_growth() {
        let mut reader = BufReader::with_capacity(1, Cursor::new(b"123456789\nstill-here\n"));
        let mut overflow_faults = 0;
        read_bounded_frames(&mut reader, 8, |frame| match frame {
            BoundedFrame::TooLarge => {
                overflow_faults += 1;
                false
            }
            BoundedFrame::Bytes(_) => panic!("the oversized line cannot be delivered"),
        })
        .expect("bounded live read completes at the terminal consumer decision");

        assert_eq!(overflow_faults, 1);
        assert_eq!(
            reader.fill_buf().expect("inspect unread live bytes"),
            b"9",
            "the reader must fault at limit + 1 without consuming the remaining line"
        );

        let mut reader = BufReader::with_capacity(1, Cursor::new(b"12345678\n"));
        let mut delivered = None;
        read_bounded_frames(&mut reader, 8, |frame| {
            match frame {
                BoundedFrame::Bytes(bytes) => delivered = Some(bytes),
                BoundedFrame::TooLarge => panic!("the exact boundary is allowed"),
            }
            false
        })
        .expect("the exact boundary remains readable");
        assert_eq!(delivered, Some(b"12345678".to_vec()));
    }
}
