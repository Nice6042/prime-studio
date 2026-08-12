use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::harness::generated::{
    reject_duplicate_json_keys, ChildAgentSummary, CurrentChatUsage, HarnessCompatibility,
    MessageBlock, ParentMessage, RootSessionSnapshot, RuntimeIdentity, StudioEnvelope,
    StudioRequest, StudioResponse, HARNESS_FRAME_MAX_BYTES, STUDIO_HARNESS_PROTOCOL,
};
use crate::session_process::{
    contain_child, prepare_process_containment, suppress_console_window, ProcessContainment,
};

const MAX_EXECUTABLE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VERIFIED_RESOURCES: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DIAGNOSTIC_CHUNKS: usize = 200;
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HarnessError {
    VerificationFailed,
    SpawnFailed,
    EnvironmentUnavailable,
    TransportUnavailable,
    DeadlineExceeded { uncertain: bool },
    ProtocolViolation,
    SidecarClosed,
    OwnershipViolation,
    ChronologyViolation,
    StateViolation,
    RecoveryFailed,
}

impl HarnessError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::VerificationFailed => "verification",
            Self::SpawnFailed => "spawn",
            Self::EnvironmentUnavailable => "environment",
            Self::TransportUnavailable => "transport",
            Self::DeadlineExceeded { .. } => "deadline",
            Self::ProtocolViolation => "protocol",
            Self::SidecarClosed => "closed",
            Self::OwnershipViolation => "ownership",
            Self::ChronologyViolation => "chronology",
            Self::StateViolation => "state",
            Self::RecoveryFailed => "recovery",
        }
    }
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for HarnessError {}

struct VerifiedResource {
    path: PathBuf,
    digest: String,
}

pub struct VerifiedSidecarSpec {
    executable: PathBuf,
    executable_digest: String,
    arguments: Vec<String>,
    resources: Vec<VerifiedResource>,
    channel_nonce: String,
}

impl VerifiedSidecarSpec {
    pub(crate) fn verify(
        executable: PathBuf,
        executable_digest: String,
        arguments: Vec<String>,
        resources: Vec<(PathBuf, String)>,
    ) -> Result<Self, HarnessError> {
        if resources.len() > MAX_VERIFIED_RESOURCES {
            return Err(HarnessError::VerificationFailed);
        }
        verify_file(&executable, &executable_digest)?;
        let resources = resources
            .into_iter()
            .map(|(path, digest)| {
                verify_file(&path, &digest)?;
                Ok(VerifiedResource { path, digest })
            })
            .collect::<Result<Vec<_>, HarnessError>>()?;
        if arguments.len() > 32
            || arguments
                .iter()
                .any(|argument| argument.len() > 4096 || argument.contains('\0'))
        {
            return Err(HarnessError::VerificationFailed);
        }
        Ok(Self {
            executable,
            executable_digest,
            arguments,
            resources,
            channel_nonce: Uuid::new_v4().simple().to_string(),
        })
    }

    #[cfg(feature = "test-support-bin")]
    pub fn for_tests(
        executable: PathBuf,
        executable_digest: String,
        arguments: Vec<String>,
        resources: Vec<(PathBuf, String)>,
    ) -> Result<Self, HarnessError> {
        Self::verify(executable, executable_digest, arguments, resources)
    }

    fn lock_files(&self) -> Result<Vec<File>, HarnessError> {
        let mut files = vec![lock_verified_file(
            &self.executable,
            &self.executable_digest,
        )?];
        for resource in &self.resources {
            files.push(lock_verified_file(&resource.path, &resource.digest)?);
        }
        Ok(files)
    }
}

fn verify_file(path: &Path, expected_digest: &str) -> Result<(), HarnessError> {
    let _ = lock_verified_file(path, expected_digest)?;
    Ok(())
}

fn lock_verified_file(path: &Path, expected_digest: &str) -> Result<File, HarnessError> {
    if !path.is_absolute()
        || !matches!(expected_digest.strip_prefix("sha256:"), Some(value) if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    {
        return Err(HarnessError::VerificationFailed);
    }
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| HarnessError::VerificationFailed)?;
        if metadata.file_type().is_symlink() {
            return Err(HarnessError::VerificationFailed);
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| HarnessError::VerificationFailed)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_EXECUTABLE_BYTES
    {
        return Err(HarnessError::VerificationFailed);
    }
    let mut file = open_locked_read(path)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| HarnessError::VerificationFailed)?;
    if !opened_metadata.is_file() || opened_metadata.len() != metadata.len() {
        return Err(HarnessError::VerificationFailed);
    }
    let mut hasher = Sha256::new();
    let copied =
        std::io::copy(&mut file, &mut hasher).map_err(|_| HarnessError::VerificationFailed)?;
    if copied != metadata.len() {
        return Err(HarnessError::VerificationFailed);
    }
    let actual = format!("sha256:{:x}", hasher.finalize());
    if actual != expected_digest {
        return Err(HarnessError::VerificationFailed);
    }
    Ok(file)
}

#[cfg(windows)]
fn open_locked_read(path: &Path) -> Result<File, HarnessError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| HarnessError::VerificationFailed)
}

#[cfg(not(windows))]
fn open_locked_read(path: &Path) -> Result<File, HarnessError> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| HarnessError::VerificationFailed)
}

pub struct SidecarSupervisor;

impl SidecarSupervisor {
    pub fn start(spec: VerifiedSidecarSpec) -> Result<SidecarHandle, HarnessError> {
        let locked_files = spec.lock_files()?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        apply_environment(&mut command, &spec.channel_nonce)?;
        prepare_process_containment(&mut command);
        suppress_console_window(&mut command);
        let mut child = command.spawn().map_err(|_| HarnessError::SpawnFailed)?;
        let containment = match contain_child(&child) {
            Ok(containment) => containment,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HarnessError::SpawnFailed);
            }
        };
        let stdin = child.stdin.take().ok_or(HarnessError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(HarnessError::SpawnFailed)?;
        let stderr = child.stderr.take().ok_or(HarnessError::SpawnFailed)?;
        let (sender, receiver) = mpsc::sync_channel(32);
        std::thread::spawn(move || read_responses(stdout, sender));
        let diagnostics = Arc::new(Mutex::new(VecDeque::new()));
        let diagnostic_writer = diagnostics.clone();
        std::thread::spawn(move || read_diagnostics(stderr, diagnostic_writer));
        Ok(SidecarHandle {
            inner: Arc::new(SidecarInner {
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(Some(stdin)),
                responses: Mutex::new(receiver),
                containment: Mutex::new(Some(containment)),
                request_gate: Mutex::new(()),
                diagnostics,
                _locked_files: locked_files,
            }),
        })
    }
}

#[cfg(windows)]
fn apply_environment(command: &mut Command, channel_nonce: &str) -> Result<(), HarnessError> {
    use crate::process_env_policy::build_child_environment;
    let runtime_names: Vec<OsString> = std::env::vars_os().map(|(name, _)| name).collect();
    let nonce_name = OsString::from("PRIME_STUDIO_CHANNEL_NONCE");
    let environment = build_child_environment(
        runtime_names,
        |name| std::env::var_os(name),
        [nonce_name.clone()],
        [(nonce_name, OsString::from(channel_nonce))],
    )
    .map_err(|error| {
        let _names_only = error.diagnostics();
        HarnessError::EnvironmentUnavailable
    })?;
    let _names_only = environment.diagnostics();
    command.envs(environment.variables().iter().cloned());
    Ok(())
}

#[cfg(not(windows))]
fn apply_environment(command: &mut Command, channel_nonce: &str) -> Result<(), HarnessError> {
    command.env("PRIME_STUDIO_CHANNEL_NONCE", channel_nonce);
    for name in ["LANG", "LC_ALL", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    Ok(())
}

struct SidecarInner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    responses: Mutex<Receiver<Result<StudioEnvelope<StudioResponse>, HarnessError>>>,
    containment: Mutex<Option<ProcessContainment>>,
    request_gate: Mutex<()>,
    diagnostics: Arc<Mutex<VecDeque<String>>>,
    _locked_files: Vec<File>,
}

impl Drop for SidecarInner {
    fn drop(&mut self) {
        if let Ok(stdin) = self.stdin.get_mut() {
            stdin.take();
        }
        if let Ok(containment) = self.containment.get_mut() {
            containment.take();
        }
        if let Ok(child) = self.child.get_mut() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Clone)]
pub struct SidecarHandle {
    inner: Arc<SidecarInner>,
}

impl SidecarHandle {
    pub async fn request(
        &self,
        request: StudioRequest,
        deadline: Instant,
    ) -> Result<StudioResponse, HarnessError> {
        let handle = self.clone();
        tauri::async_runtime::spawn_blocking(move || handle.request_blocking(request, deadline))
            .await
            .map_err(|_| HarnessError::TransportUnavailable)?
    }

    pub fn request_blocking(
        &self,
        request: StudioRequest,
        deadline: Instant,
    ) -> Result<StudioResponse, HarnessError> {
        let _request_guard = self
            .inner
            .request_gate
            .lock()
            .map_err(|_| HarnessError::TransportUnavailable)?;
        let request_id = Uuid::new_v4().to_string();
        let envelope = StudioEnvelope {
            studio_protocol: STUDIO_HARNESS_PROTOCOL,
            request_id: request_id.clone(),
            payload: request,
        };
        let bytes = serde_json::to_vec(&envelope).map_err(|_| HarnessError::ProtocolViolation)?;
        if bytes.is_empty() || bytes.len() > HARNESS_FRAME_MAX_BYTES {
            return Err(HarnessError::ProtocolViolation);
        }
        let write_failed = {
            let mut writer_guard = self
                .inner
                .stdin
                .lock()
                .map_err(|_| HarnessError::TransportUnavailable)?;
            let writer = writer_guard.as_mut().ok_or(HarnessError::SidecarClosed)?;
            writer
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .and_then(|_| writer.write_all(&bytes))
                .and_then(|_| writer.flush())
                .is_err()
        };
        if write_failed {
            self.terminate();
            return Err(HarnessError::TransportUnavailable);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            self.terminate();
            return Err(HarnessError::DeadlineExceeded { uncertain: true });
        };
        let response = self
            .inner
            .responses
            .lock()
            .map_err(|_| HarnessError::TransportUnavailable)?
            .recv_timeout(remaining);
        let envelope = match response {
            Ok(Ok(envelope)) => envelope,
            Ok(Err(error)) => {
                self.terminate();
                return Err(error);
            }
            Err(RecvTimeoutError::Timeout) => {
                self.terminate();
                return Err(HarnessError::DeadlineExceeded { uncertain: true });
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.terminate();
                return Err(HarnessError::SidecarClosed);
            }
        };
        if envelope.studio_protocol != STUDIO_HARNESS_PROTOCOL || envelope.request_id != request_id
        {
            self.terminate();
            return Err(HarnessError::ProtocolViolation);
        }
        Ok(envelope.payload)
    }

    pub fn diagnostics(&self) -> Vec<String> {
        self.inner
            .diagnostics
            .lock()
            .map(|lines| lines.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn shutdown(self, deadline: Instant) -> Result<(), HarnessError> {
        tauri::async_runtime::spawn_blocking(move || self.shutdown_blocking(deadline))
            .await
            .map_err(|_| HarnessError::TransportUnavailable)?
    }

    pub fn shutdown_blocking(&self, deadline: Instant) -> Result<(), HarnessError> {
        self.terminate();
        loop {
            let mut child_guard = self
                .inner
                .child
                .lock()
                .map_err(|_| HarnessError::TransportUnavailable)?;
            let Some(child) = child_guard.as_mut() else {
                return Ok(());
            };
            match child.try_wait() {
                Ok(Some(_)) => {
                    child
                        .wait()
                        .map_err(|_| HarnessError::TransportUnavailable)?;
                    *child_guard = None;
                    return Ok(());
                }
                Ok(None) if Instant::now() < deadline => {}
                Ok(None) => return Err(HarnessError::DeadlineExceeded { uncertain: false }),
                Err(_) => return Err(HarnessError::TransportUnavailable),
            }
            drop(child_guard);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn terminate(&self) {
        let _ = self.inner.stdin.lock().map(|mut stdin| stdin.take());
        let _ = self
            .inner
            .containment
            .lock()
            .map(|mut containment| containment.take());
        if let Ok(mut child) = self.inner.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn read_responses(
    mut reader: impl Read,
    sender: mpsc::SyncSender<Result<StudioEnvelope<StudioResponse>, HarnessError>>,
) {
    loop {
        let mut length = [0_u8; 4];
        if let Err(error) = reader.read_exact(&mut length) {
            let failure = if error.kind() == std::io::ErrorKind::UnexpectedEof {
                HarnessError::SidecarClosed
            } else {
                HarnessError::TransportUnavailable
            };
            let _ = sender.send(Err(failure));
            return;
        }
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > HARNESS_FRAME_MAX_BYTES {
            let _ = sender.send(Err(HarnessError::ProtocolViolation));
            return;
        }
        let mut bytes = vec![0_u8; length];
        if reader.read_exact(&mut bytes).is_err() || reject_duplicate_json_keys(&bytes).is_err() {
            let _ = sender.send(Err(HarnessError::ProtocolViolation));
            return;
        }
        match serde_json::from_slice::<StudioEnvelope<StudioResponse>>(&bytes) {
            Ok(envelope) if validate_studio_response(&envelope.payload) => {
                if sender.send(Ok(envelope)).is_err() {
                    return;
                }
            }
            Ok(_) | Err(_) => {
                let _ = sender.send(Err(HarnessError::ProtocolViolation));
                return;
            }
        }
    }
}

fn validate_studio_response(response: &StudioResponse) -> bool {
    match response {
        StudioResponse::DiscoverRuntimeResult {
            runtime,
            compatibility,
        } => runtime.as_ref().is_none_or(valid_runtime) && valid_compatibility(compatibility),
        StudioResponse::BootstrapResult {
            compatibility,
            sessions,
        } => {
            valid_compatibility(compatibility)
                && sessions.len() <= 256
                && sessions.iter().all(validate_root_snapshot)
        }
        StudioResponse::SnapshotResult { snapshot } => validate_root_snapshot(snapshot),
        StudioResponse::CommandResult {
            command_id,
            snapshot,
            ..
        } => valid_id(command_id) && validate_root_snapshot(snapshot),
        StudioResponse::ResidentCreated {
            creation_id,
            snapshot,
        } => valid_id(creation_id) && validate_root_snapshot(snapshot),
        StudioResponse::InspectorResult { details_json } => valid_text(details_json),
        StudioResponse::StudioOperationResult {
            operation_id,
            command_id,
            position,
            revision,
            reason,
            snapshot,
            ..
        } => {
            valid_id(operation_id)
                && command_id.as_ref().is_none_or(|value| valid_id(value))
                && position.is_none_or(|value| value <= MAX_SAFE_INTEGER)
                && revision.as_ref().is_none_or(|value| valid_id(value))
                && reason.as_ref().is_none_or(|value| valid_label(value))
                && snapshot
                    .as_ref()
                    .is_none_or(|value| validate_root_snapshot(value))
        }
        StudioResponse::Error { code, message } => valid_id(code) && valid_label(message),
    }
}

fn valid_runtime(runtime: &RuntimeIdentity) -> bool {
    runtime.package_name == "prime-agent"
        && valid_bounded(&runtime.package_version, 64)
        && valid_digest(&runtime.package_digest)
        && valid_digest(&runtime.entrypoint_digest)
        && valid_bounded(&runtime.protocol_name, 64)
        && valid_bounded(&runtime.schema_id, 128)
        && unique_bounded(&runtime.capabilities, 128)
}

fn valid_compatibility(compatibility: &HarnessCompatibility) -> bool {
    match compatibility {
        HarnessCompatibility::Ready {
            profile,
            capabilities,
        } => valid_id(profile) && unique_bounded(capabilities, 128),
        HarnessCompatibility::Degraded {
            profile,
            capabilities,
            unavailable,
        } => valid_id(profile) && unique_bounded(capabilities, 128) && unavailable.len() <= 128,
        HarnessCompatibility::ReadOnly { runtime, .. } => {
            runtime.as_ref().is_none_or(valid_runtime)
        }
        HarnessCompatibility::Unavailable { .. } => true,
    }
}

pub(crate) fn validate_root_snapshot(snapshot: &RootSessionSnapshot) -> bool {
    valid_id(&snapshot.session_id)
        && snapshot
            .account_id
            .as_ref()
            .is_none_or(|value| valid_id(value))
        && valid_id(&snapshot.project_id)
        && valid_id(&snapshot.chat_id)
        && valid_id(&snapshot.cursor.runtime_generation)
        && snapshot.cursor.sequence <= MAX_SAFE_INTEGER
        && snapshot.parent_messages.len() <= 300
        && snapshot.parent_messages.iter().all(valid_parent_message)
        && snapshot.children.len() <= 256
        && snapshot.children.iter().all(valid_child)
        && snapshot.queue.len() <= 256
        && snapshot
            .queue
            .iter()
            .all(|item| valid_id(&item.id) && valid_label(&item.label))
        && snapshot.tools.len() <= 512
        && snapshot
            .tools
            .iter()
            .all(|tool| valid_id(&tool.id) && valid_label(&tool.label))
        && snapshot.resources.len() <= 512
        && snapshot.resources.iter().all(|resource| {
            valid_id(&resource.id) && valid_label(&resource.label) && valid_id(&resource.kind)
        })
        && valid_usage(&snapshot.usage)
}

fn valid_parent_message(message: &ParentMessage) -> bool {
    match message {
        ParentMessage::User {
            id,
            text,
            emitted_at_ms,
            ..
        }
        | ParentMessage::Notice {
            id,
            text,
            emitted_at_ms,
            ..
        } => valid_id(id) && valid_text(text) && *emitted_at_ms <= MAX_SAFE_INTEGER,
        ParentMessage::Assistant {
            id,
            blocks,
            emitted_at_ms,
            ..
        } => {
            valid_id(id)
                && *emitted_at_ms <= MAX_SAFE_INTEGER
                && blocks.len() <= 1024
                && blocks.iter().all(valid_message_block)
        }
    }
}

fn valid_message_block(block: &MessageBlock) -> bool {
    match block {
        MessageBlock::Text { text } | MessageBlock::Thinking { text, .. } => valid_text(text),
        MessageBlock::ToolCall {
            tool_call_id,
            tool_id,
            ..
        } => valid_id(tool_call_id) && valid_id(tool_id),
    }
}

fn valid_child(child: &ChildAgentSummary) -> bool {
    valid_id(&child.id)
        && valid_label(&child.task)
        && child
            .provider
            .as_ref()
            .is_none_or(|value| valid_label(value))
        && child.model.as_ref().is_none_or(|value| valid_label(value))
        && child
            .progress
            .is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
}

fn valid_usage(usage: &CurrentChatUsage) -> bool {
    [
        usage.input,
        usage.output,
        usage.cache_read,
        usage.cache_write,
        usage.total_tokens,
    ]
    .into_iter()
    .all(|value| value <= MAX_SAFE_INTEGER)
        && usage
            .cost
            .is_none_or(|value| value.is_finite() && (0.0..=1e15).contains(&value))
}

fn unique_bounded<T: PartialEq>(values: &[T], maximum: usize) -> bool {
    values.len() <= maximum
        && values
            .iter()
            .enumerate()
            .all(|(index, value)| !values[..index].contains(value))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_label(value: &str) -> bool {
    valid_bounded(value, 200)
}

fn valid_text(value: &str) -> bool {
    value.chars().count() <= 131_072
}

fn valid_bounded(value: &str, maximum: usize) -> bool {
    let count = value.chars().count();
    count > 0 && count <= maximum
}

fn valid_digest(value: &str) -> bool {
    matches!(value.strip_prefix("sha256:"), Some(digest) if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn read_diagnostics(mut reader: impl Read, diagnostics: Arc<Mutex<VecDeque<String>>>) {
    let mut observed = 0_usize;
    let mut buffer = [0_u8; 1024];
    while observed < MAX_DIAGNOSTIC_BYTES {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        observed = observed.saturating_add(count);
        if let Ok(mut lines) = diagnostics.lock() {
            if lines.len() == MAX_DIAGNOSTIC_CHUNKS {
                lines.pop_front();
            }
            lines.push_back("[REDACTED_SIDECAR_DIAGNOSTIC]".to_owned());
        }
    }
}
