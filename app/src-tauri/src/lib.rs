//! Prime Studio backend: owns `prime-agent --mode rpc` child processes so the UI
//! never touches a terminal.
//!
//! Events emitted to the frontend:
//!   prime://event   {sessionKey, event}   one parsed JSONL line from child stdout
//!   prime://stderr  {sessionKey, line}    child stderr, plus any unparseable stdout
//!   prime://exited  {sessionKey, code}    child gone. prime exits non-zero (1, 13)
//!                                         even on success — NOT an error signal.

pub mod accounts;
pub mod app_state;
pub mod authority;
mod bounded_io;
pub mod browser;
pub mod commands;
pub mod computer_use;
pub mod harness;
mod process_env_policy;
pub mod project_catalog;
mod provider_product;
pub mod runtime_manifest;
mod scheduler;
#[doc(hidden)]
pub mod session_process;

use accounts::delete::{AccountDeletion, DeletionError, DeletionErrorCode, RemovalPlan};
use accounts::{Account, AccountRegistry, MAX_AUTH_FILE_BYTES};
use authority::{
    authorize_known_session_rpc, authorize_tauri_invoke, run_guarded_tauri_command, AuthorityGate,
    EffectClass, TauriCommand,
};
use bounded_io::{
    entry_metadata_no_follow, read_bounded, read_bounded_under, read_dir_bounded,
    read_jsonl_bounded, read_jsonl_prefix_bounded, JsonlLimits,
};
use browser::{
    BrowserBroker, BrowserIntentAdmission, BrowserIntentAdmissionRequest, BrowserSecurityStatus,
};
use commands::editor::{editor_artifact_open, editor_artifact_save, ArtifactAuthority};
use commands::harness::{
    harness_attach_session, harness_bootstrap, harness_create_resident_chat, harness_inspector,
    harness_projection, harness_refresh_session, harness_session_command, harness_studio_operation,
};
use commands::settings::{get_layout_preferences, set_layout_preferences};
use commands::usage::export_account_usage_csv;
use computer_use::{ComputerUseBroker, ComputerUseReadinessProjection};
use project_catalog::{CatalogSnapshot, ProjectCatalog};
use provider_product::provider_product_snapshot_from_registry;
use scheduler::{SchedulerProjection, SchedulerService};
use session_process::{
    spawn as spawn_process, EventSink, ProcessEvent, ProcessHandle, ProcessSpec,
};
use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const STDERR_RING: usize = 200;
/// Only scan a small prefix of a session file for metadata and a title.
const SUMMARY_SCAN_RECORDS: usize = 200;
const MAX_SUMMARY_SCAN_BYTES: usize = 256 * 1024;
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
const MAX_JOURNAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
const MAX_JOURNAL_RECORDS: usize = 100_000;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_SESSION_FILES: usize = 5_000;
const MAX_USAGE_ROWS: usize = 100_000;
const MAX_TRANSCRIPT_MESSAGES: usize = 50_000;
const MAX_CODEX_TREE_DEPTH: usize = 4;
const MAX_PROCESS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const PROCESS_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// How many Codex session logs to try before giving up on a rate-limit snapshot.
/// The newest is usually right, but a session opened and left idle has no
/// `rate_limits` line yet.
const CODEX_SCAN_FILES: usize = 5;

// ---------------------------------------------------------------- paths / spawn

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// The agent home every install starts with. Holds the user's original logins.
fn default_agent_dir() -> PathBuf {
    home().join(".prime").join("agent")
}

fn profiles_dir() -> PathBuf {
    home().join(".prime").join("profiles")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ------------------------------------------------- prime-agent CLI resolution
//
// prime-agent installs differently per machine: global npm on Windows
// (%APPDATA%\npm), a `curl … | sh` installer on Linux/macOS, or wherever the user
// pointed npm's prefix. Nothing here may assume one layout — resolution is
// layered, first match wins, and a failure reports every location it tried so the
// UI can show it.

/// Where prime-agent's JS entry point lives, plus the optional Windows console
/// shim that sits next to it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimeCli {
    /// `dist/bundle/cli.js` — always launched as `node <cli>`; on Windows the
    /// PATH entry is a `.cmd` shim that CreateProcess cannot execute.
    cli: PathBuf,
    /// `dist/windowshide-shim.cjs` when present. A local patch that stops
    /// prime's child spawns flashing console windows; a fresh prime install may
    /// not have it (an upstream source fix is in flight), so it is optional and
    /// the `--require` pair is only passed when this is `Some`.
    shim: Option<PathBuf>,
    /// Which resolution layer won, for the settings UI.
    source: String,
}

/// npm's Windows global root, `%APPDATA%\npm`.
#[cfg(windows)]
fn appdata_npm() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Roaming"))
        .join("npm")
}

/// Accept any of the shapes a user might reasonably configure or that a PATH
/// lookup might yield, and return the `cli.js` inside it.
fn normalize_cli(p: &Path) -> Option<PathBuf> {
    // A direct path to the entry script.
    if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("js") {
        return Some(p.to_path_buf());
    }
    // `…/dist`, `…/dist/bundle`, or the package root `…/prime-agent`. A source
    // checkout builds `dist/cli.js` without a `bundle/`, so both shapes are tried.
    for tail in [
        Path::new("bundle").join("cli.js"),
        PathBuf::from("cli.js"),
        Path::new("dist").join("bundle").join("cli.js"),
        Path::new("dist").join("cli.js"),
    ] {
        let candidate = p.join(tail);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn cli_at(path: &Path, source: &str) -> Option<PrimeCli> {
    let cli = normalize_cli(path)?;
    // The shim sits in `dist/`, which is the parent of a `dist/cli.js` entry and
    // the grandparent of a `dist/bundle/cli.js` one.
    let shim = [cli.parent(), cli.parent().and_then(|b| b.parent())]
        .into_iter()
        .flatten()
        .map(|dist| dist.join("windowshide-shim.cjs"))
        .find(|s| s.is_file());
    Some(PrimeCli {
        cli,
        shim,
        source: source.to_string(),
    })
}

// ------------------------------------------------------- daemon capability
//
// Daemon-backed sessions (`-d`, and an `attach` that speaks RPC) exist only in
// newer prime builds. Everything in the app that depends on them is gated on
// this probe rather than on a version number, because a user can point the app
// at any build they like.

/// `-d, --background` in the run options *and* an `attach` command. Stock prime
/// ships `attach` (interactive UI only) and no `--background`, so the flag is
/// what actually discriminates; both are required so a half-built tree cannot
/// pass.
#[cfg(test)]
fn help_has_daemon(help: &str) -> bool {
    help.contains("--background") && help.contains("attach")
}

/// Capability probing is execution and therefore stays fail-closed until the
/// shared runtime verifier and environment policy can supply a complete process
/// specification. A resolved `cli.js` path alone is not launch authority.
fn daemon_supported(_cli: &Path) -> bool {
    false
}

/// Which daemon to talk to. Unset means prime's own default socket — the one a
/// terminal `prime-agent list` uses, which is the point: the app and the CLI
/// must see the same fleet. Overridable so tests never touch the user's daemon.
fn daemon_socket() -> Option<String> {
    std::env::var("PRIME_STUDIO_DAEMON_SOCKET")
        .ok()
        .or_else(|| read_settings().daemon_socket)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `--daemon-socket <path>`, or nothing. Every spawn, attach, list and stop
/// appends this so they all talk to the same daemon.
fn socket_args() -> Vec<String> {
    match daemon_socket() {
        Some(s) => vec!["--daemon-socket".into(), s],
        None => Vec::new(),
    }
}

/// Directories on PATH holding a `prime-agent` launcher, mapped to the install
/// root that launcher points at.
///
/// Scanned in-process rather than shelling out to `where`/`which`: same answer,
/// no subprocess and no console window to suppress.
fn path_candidates() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["prime-agent.cmd", "prime-agent.exe", "prime-agent"]
    } else {
        &["prime-agent"]
    };
    let mut out = Vec::new();
    for dir in std::env::var_os("PATH")
        .iter()
        .flat_map(std::env::split_paths)
    {
        for name in names {
            let bin = dir.join(name);
            if !bin.exists() {
                continue;
            }
            // Unix: the bin is a symlink straight to dist/bundle/cli.js.
            if let Ok(real) = bin.canonicalize() {
                out.push(real);
            }
            // Windows global npm: the .cmd shim lives beside node_modules.
            out.push(dir.join("node_modules").join("prime-agent").join("dist"));
            // Unix global npm: <prefix>/bin/prime-agent -> <prefix>/lib/node_modules/…
            out.push(
                dir.join("..")
                    .join("lib")
                    .join("node_modules")
                    .join("prime-agent")
                    .join("dist"),
            );
        }
    }
    out
}

/// Per-OS install locations, in the order they are worth trying.
fn default_candidates() -> Vec<PathBuf> {
    let npm_pkg = Path::new("node_modules").join("prime-agent").join("dist");
    #[cfg(windows)]
    let mut out = vec![appdata_npm().join(&npm_pkg)];
    #[cfg(not(windows))]
    let mut out = Vec::new();
    #[cfg(not(windows))]
    for lib in [
        PathBuf::from("/usr/local/lib"),
        PathBuf::from("/usr/lib"),
        PathBuf::from("/opt/homebrew/lib"),
        home().join(".npm-global").join("lib"),
        home().join(".local").join("lib"),
    ] {
        out.push(lib.join(&npm_pkg));
    }
    // prime's own `curl … | sh` installer keeps its tree under ~/.prime.
    out.push(home().join(".prime").join(&npm_pkg));
    out.push(home().join(".prime").join("prime-agent").join("dist"));
    out
}

/// `npm root -g`, the authoritative global module dir. Only consulted when
/// everything cheaper has already failed, since it costs a process spawn.
fn npm_root_g() -> Option<PathBuf> {
    #[cfg(windows)]
    // npm is npm.cmd on Windows and CreateProcess cannot run a .cmd directly.
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/c", "npm", "root", "-g"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("npm");
        c.args(["root", "-g"]);
        c
    };
    no_window(&mut cmd);
    let out =
        command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, PROCESS_PROBE_TIMEOUT).ok()?;
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!root.is_empty()).then(|| Path::new(&root).join("prime-agent").join("dist"))
}

/// Layered resolution. `explicit` is `(source label, path)` from the user setting
/// and env overrides, highest priority first — an explicit path that does not
/// resolve is a hard error, never a silent fall-through to autodetection.
fn resolve_cli_from(explicit: &[(String, String)]) -> Result<PrimeCli, String> {
    let mut tried = Vec::new();
    for (source, path) in explicit {
        if path.trim().is_empty() {
            continue;
        }
        if let Some(found) = cli_at(Path::new(path.trim()), source) {
            return Ok(found);
        }
        return Err(format!(
            "{source} points at `{path}`, but there is no prime-agent cli.js there. \
             Expected the file itself, or a directory containing bundle/cli.js."
        ));
    }
    for path in path_candidates() {
        if let Some(found) = cli_at(&path, "prime-agent on PATH") {
            return Ok(found);
        }
        tried.push(format!("PATH: {}", path.display()));
    }
    for path in default_candidates() {
        if let Some(found) = cli_at(&path, "default install location") {
            return Ok(found);
        }
        tried.push(path.display().to_string());
    }
    if let Some(path) = npm_root_g() {
        if let Some(found) = cli_at(&path, "npm root -g") {
            return Ok(found);
        }
        tried.push(format!("npm root -g: {}", path.display()));
    }
    Err(format!(
        "prime-agent not found. Install it (https://github.com/PrimeIntellect-ai/prime-agent), \
         or set the CLI path in Accounts → Prime agent CLI. Tried:\n{}",
        tried.join("\n")
    ))
}

/// The explicit layers, highest priority first: the saved setting, then env.
fn explicit_cli_sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(p) = read_settings().cli_path {
        out.push(("The configured CLI path".to_string(), p));
    }
    for var in ["PRIME_STUDIO_CLI", "PRIME_AGENT_CLI"] {
        if let Some(v) = std::env::var_os(var).and_then(|v| v.into_string().ok()) {
            out.push((format!("${var}"), v));
        }
    }
    out
}

fn prime_cli() -> Result<PrimeCli, String> {
    resolve_cli_from(&explicit_cli_sources())
}

// ---------------------------------------------------------------- app settings

/// Per-OS config dir for our own settings file. Derived from env rather than
/// Tauri's path API so plain functions and tests can reach it.
fn config_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Roaming"));
    #[cfg(target_os = "macos")]
    let base = home().join("Library").join("Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"));
    base.join("prime-studio")
}

/// Everything the settings window persists. One file, one struct — a second
/// store would only be another thing to keep in sync.
///
/// Nothing here is ever a credential: paths, ids and preferences only.
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// User-chosen path to prime-agent's `dist`, its package root, or `cli.js`.
    /// Owned by `set_prime_cli`, which re-resolves — not by `set_app_setting`.
    cli_path: Option<String>,
    /// "dark" | "light" | "system".
    theme: Option<String>,
    /// Account new tabs open on.
    default_account: Option<String>,
    /// Provider + model new sessions spawn with. Both or neither.
    default_provider: Option<String>,
    default_model: Option<String>,
    default_thinking: Option<String>,
    default_cwd: Option<String>,
    /// The settings section to reopen on.
    last_section: Option<String>,
    file_open_destination: Option<String>,
    language: Option<String>,
    bottom_panel: Option<String>,
    density: Option<String>,
    reduced_motion: Option<String>,
    send_shortcut: Option<String>,
    prompt_suggestions: Option<String>,
    token_estimate: Option<String>,
    drafts: Option<String>,
    max_concurrent_agents: Option<String>,
    autonomous_max_turns: Option<String>,
    retry_silent_workers: Option<String>,
    context_discovery: Option<String>,
    tools_enabled: Option<String>,
    git_auto_refresh: Option<String>,
    environment_mode: Option<String>,
    telemetry: Option<String>,
    crash_reports: Option<String>,
    local_only: Option<String>,
    /// `--daemon-socket` for every spawn/attach/list/stop. Unset = prime's
    /// default socket, so the app shares a fleet with the terminal CLI.
    daemon_socket: Option<String>,
}

/// Settable through `set_app_setting`. An allowlist, so a typo'd key is an error
/// the UI can show rather than a value silently dropped on the next round-trip.
const SETTING_KEYS: [&str; 27] = [
    "theme",
    "defaultAccount",
    "defaultProvider",
    "defaultModel",
    "defaultThinking",
    "defaultCwd",
    "lastSection",
    "fileOpenDestination",
    "language",
    "bottomPanel",
    "density",
    "reducedMotion",
    "sendShortcut",
    "promptSuggestions",
    "tokenEstimate",
    "drafts",
    "maxConcurrentAgents",
    "autonomousMaxTurns",
    "retrySilentWorkers",
    "contextDiscovery",
    "toolsEnabled",
    "gitAutoRefresh",
    "environmentMode",
    "telemetry",
    "crashReports",
    "localOnly",
    "daemonSocket",
];

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

fn scheduler_state_path() -> PathBuf {
    config_dir().join("scheduler-state.json")
}

fn project_catalog_path() -> PathBuf {
    config_dir().join("projects-v2.json")
}

fn read_settings() -> Settings {
    let root = config_dir().canonicalize().ok();
    root.as_deref()
        .and_then(|root| read_bounded_under(root, &settings_path(), MAX_SETTINGS_BYTES).ok())
        .and_then(|bounded| serde_json::from_slice(&bounded.bytes).ok())
        .unwrap_or_default()
}

fn write_settings(s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir())
        .map_err(|e| format!("{}: {e}", config_dir().display()))?;
    let body = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), body).map_err(|e| format!("{}: {e}", settings_path().display()))
}

#[tauri::command]
fn get_app_settings() -> Settings {
    read_settings()
}

/// Set (or clear, with an empty/absent value) one key and return the whole file
/// back, so the UI never has to guess what it now holds.
fn set_app_setting_impl(key: String, value: Option<String>) -> Result<Settings, String> {
    if !SETTING_KEYS.contains(&key.as_str()) {
        return Err(format!("unknown setting: {key}"));
    }
    let mut doc = serde_json::to_value(read_settings()).map_err(|e| e.to_string())?;
    doc[&key] = match value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        Some(v) => Value::String(v),
        None => Value::Null,
    };
    let next: Settings = serde_json::from_value(doc).map_err(|e| e.to_string())?;
    write_settings(&next)?;
    Ok(next)
}

#[tauri::command]
fn set_app_setting(
    state: State<AppState>,
    key: String,
    value: Option<String>,
) -> Result<Settings, String> {
    require_tauri_authority(&state, TauriCommand::SetAppSetting)?;
    set_app_setting_impl(key, value)
}

/// What the settings UI and the startup banner render. Never an `Err` for "not
/// installed" — that is a state to display, not a crash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatus {
    /// Resolved `cli.js`, or None when nothing was found.
    path: Option<String>,
    /// Which layer won.
    source: Option<String>,
    /// Whether the Windows console shim was found next to it.
    shim: bool,
    /// The saved setting, so the UI can prefill its input.
    configured: Option<String>,
    /// Feature-detected: this build supports `-d` and headless `attach`, so
    /// sessions can outlive the window and the Fleet view has a fleet to show.
    daemon: bool,
    /// The `--daemon-socket` in force, when one is set.
    daemon_socket: Option<String>,
    /// Human-readable failure, including every location tried.
    error: Option<String>,
}

fn cli_status() -> CliStatus {
    let configured = read_settings().cli_path;
    let daemon_socket = daemon_socket();
    match prime_cli() {
        Ok(c) => CliStatus {
            daemon: daemon_supported(&c.cli),
            path: Some(c.cli.to_string_lossy().into_owned()),
            source: Some(c.source),
            shim: c.shim.is_some(),
            configured,
            daemon_socket,
            error: None,
        },
        Err(e) => CliStatus {
            path: None,
            source: None,
            shim: false,
            configured,
            daemon: false,
            daemon_socket,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn resolve_prime_cli(state: State<AppState>) -> Result<CliStatus, String> {
    require_tauri_authority(&state, TauriCommand::ResolvePrimeCli)?;
    Ok(cli_status())
}

/// Save (or clear, with an empty/absent path) the CLI path and re-resolve.
/// Clearing is how the settings UI's "Detect" button falls back to autodetection.
fn set_prime_cli_impl(path: Option<String>) -> Result<CliStatus, String> {
    // Read-modify-write: the file holds every other setting too.
    let mut settings = read_settings();
    settings.cli_path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    write_settings(&settings)?;
    Ok(cli_status())
}

#[tauri::command]
fn set_prime_cli(state: State<AppState>, path: Option<String>) -> Result<CliStatus, String> {
    require_tauri_authority(&state, TauriCommand::SetPrimeCli)?;
    set_prime_cli_impl(path)
}

/// Validity check for the settings UI: `node <cli> --version`. Without `path`,
/// checks whatever currently resolves.
fn check_prime_cli_impl(path: Option<String>) -> Result<String, String> {
    let cli = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => cli_at(Path::new(&p), "checked path")
            .ok_or_else(|| format!("no prime-agent cli.js at `{p}`"))?,
        None => prime_cli()?,
    };
    let mut cmd = Command::new("node");
    cmd.arg(&cli.cli)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, PROCESS_PROBE_TIMEOUT)
        .map_err(|e| format!("could not run node (is Node.js 22+ on PATH?): {e}"))?;
    // prime prints `--version` to STDERR, not stdout (same as `model list`).
    // Read both so this keeps working if that ever changes.
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let text = if stdout.is_empty() { stderr } else { stdout };
    if text.is_empty() {
        return Err(format!(
            "`node {} --version` printed nothing",
            cli.cli.display()
        ));
    }
    if !out.status.success() && !text.contains(char::is_numeric) {
        return Err(text);
    }
    Ok(text)
}

#[tauri::command]
fn check_prime_cli(state: State<AppState>, path: Option<String>) -> Result<String, String> {
    require_tauri_authority(&state, TauriCommand::CheckPrimeCli)?;
    check_prime_cli_impl(path)
}

// CREATE_NO_WINDOW (0x08000000). Without it every spawn flashes a console
// window over the app. Applied to every child we start on Windows.
// ---------------------------------------------------------------- kernel
//
// prime's ONLY built-in tool is `ipython`, so a Python without ipykernel means
// no tool calls at all. Read-only status: the child inherits the app's
// environment, so PRIME_AGENT_KERNEL_PYTHON has to be set before Prime Studio
// starts — the UI says so rather than pretending it can change it live.

/// Verified against prime-agent 0.7.1's bundle (`ensureKernelPythonUncached`):
/// `PRIME_AGENT_KERNEL_PYTHON` wins outright; otherwise prime bootstraps a venv
/// at `PRIME_AGENT_KERNEL_VENV` or `~/.prime/agent/kernel-venv`.
fn kernel_python(deadline: Instant) -> (PathBuf, String) {
    if let Some(p) = std::env::var_os("PRIME_AGENT_KERNEL_PYTHON").filter(|v| !v.is_empty()) {
        return (PathBuf::from(p), "PRIME_AGENT_KERNEL_PYTHON".into());
    }

    // Several venvs can exist side by side and only some are usable: prime's own
    // Windows bootstrap creates `kernel-venv` but fails to install ipykernel into
    // it, while a repaired one lives next door. An interpreter without ipykernel
    // cannot run a single tool call, so "has ipykernel" — not "exists" — is the
    // predicate worth resolving on.
    let mut venvs: Vec<(PathBuf, String)> = Vec::new();
    if let Some(v) = std::env::var_os("PRIME_AGENT_KERNEL_VENV").filter(|s| !s.is_empty()) {
        venvs.push((
            PathBuf::from(v),
            "PRIME_AGENT_KERNEL_VENV (prime's managed venv)".into(),
        ));
    }
    let home = default_agent_dir();
    venvs.push((
        home.join("kernel-venv"),
        "prime's managed venv (default)".into(),
    ));
    if cfg!(windows) {
        venvs.push((
            home.join("kernel-venv-win"),
            "repaired Windows kernel venv".into(),
        ));
    }

    // The venv is built by uv, so it has the platform's own layout —
    // `Scripts\python.exe` on Windows, `bin/python` elsewhere. Probe rather than
    // assume: prime's own code joins `bin/python` unconditionally.
    let interpreters = |venv: &Path| {
        [
            venv.join("Scripts").join("python.exe"),
            venv.join("bin").join("python"),
            venv.join("bin").join("python3"),
        ]
    };

    let mut first_present: Option<(PathBuf, String)> = None;
    'venvs: for (venv, source) in &venvs {
        for cand in interpreters(venv) {
            if Instant::now() >= deadline {
                break 'venvs;
            }
            if !cand.is_file() {
                continue;
            }
            if has_ipykernel(&cand, deadline) {
                return (cand, source.clone());
            }
            first_present.get_or_insert((cand, source.clone()));
        }
    }
    // Nothing usable. Return something real if it is on disk so the UI can say
    // "no ipykernel" rather than "no interpreter", which are different repairs.
    first_present.unwrap_or_else(|| {
        let (venv, source) = venvs.swap_remove(0);
        let fallback = if cfg!(windows) { 0 } else { 1 };
        (interpreters(&venv)[fallback].clone(), source)
    })
}

// ---------------------------------------------------------- files touched
//
// The handoff's FILES TOUCHED block is labelled "applied · review in git", and
// that label is literally the implementation: prime has no protocol event for
// edited files, but every edit it makes lands in the working tree, so git is the
// honest source. Nothing here implies an approval queue — the work already ran.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TouchedFile {
    path: String,
    added: u32,
    removed: u32,
    /// Untracked files have no diff to count, so the UI says "new" instead of +0.
    untracked: bool,
}

/// `git diff --numstat HEAD` plus untracked files. Empty when the folder is not
/// a repo, which is also the honest answer: nothing is reviewable in git.
fn files_touched_impl(cwd: String) -> Vec<TouchedFile> {
    let git = |args: &[&str]| -> Option<String> {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        no_window(&mut cmd);
        let out = command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, PROCESS_PROBE_TIMEOUT)
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };

    let mut files = Vec::new();
    if let Some(numstat) = git(&["diff", "--numstat", "HEAD"]) {
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            let (a, r, path) = (cols.next(), cols.next(), cols.next());
            if let (Some(a), Some(r), Some(path)) = (a, r, path) {
                files.push(TouchedFile {
                    path: path.to_string(),
                    // "-" is git's marker for a binary file, not a zero.
                    added: a.parse().unwrap_or(0),
                    removed: r.parse().unwrap_or(0),
                    untracked: false,
                });
            }
        }
    }
    if let Some(untracked) = git(&["ls-files", "--others", "--exclude-standard"]) {
        for path in untracked.lines().filter(|l| !l.is_empty()) {
            files.push(TouchedFile {
                path: path.to_string(),
                added: 0,
                removed: 0,
                untracked: true,
            });
        }
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.added + file.removed));
    files.truncate(40);
    files
}

#[tauri::command]
fn files_touched(state: State<AppState>, cwd: String) -> Result<Vec<TouchedFile>, String> {
    require_tauri_authority(&state, TauriCommand::FilesTouched)?;
    Ok(files_touched_impl(cwd))
}

/// One cheap spawn per candidate, and only until the first hit. Results are not
/// cached here — `kernel_status` is probed once per app run by the frontend, and
/// `start_session` needs the answer at most once per tab.
fn has_ipykernel(python: &Path, deadline: Instant) -> bool {
    let Some(timeout) = deadline.checked_duration_since(Instant::now()) else {
        return false;
    };
    if timeout.is_zero() {
        return false;
    }
    let mut cmd = Command::new(python);
    cmd.args(["-c", "import ipykernel"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    matches!(
        command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, timeout),
        Ok(output) if output.status.success()
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStatus {
    python: String,
    /// Which layer produced that path.
    source: String,
    exists: bool,
    /// Python's own version, when it ran at all.
    version: Option<String>,
    /// ipykernel's version. `None` means prime cannot run a single tool call.
    ipykernel: Option<String>,
    error: Option<String>,
}

/// Probes the resolved interpreter once. Both facts come from one spawn: line 1
/// of stdout proves Python ran, line 2 proves `import ipykernel` worked.
fn kernel_status_impl() -> KernelStatus {
    let deadline = Instant::now() + PROCESS_PROBE_TIMEOUT;
    let (python, source) = kernel_python(deadline);
    let mut cmd = Command::new(&python);
    cmd.args([
        "-c",
        "import sys;print(sys.version.split()[0]);import ipykernel;print(ipykernel.__version__)",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut status = KernelStatus {
        python: python.to_string_lossy().into_owned(),
        source,
        exists: python.is_file(),
        version: None,
        ipykernel: None,
        error: None,
    };
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        status.error = Some(format!(
            "kernel resolution/probe timed out after {} ms",
            PROCESS_PROBE_TIMEOUT.as_millis()
        ));
        return status;
    };
    if remaining.is_zero() {
        status.error = Some(format!(
            "kernel resolution/probe timed out after {} ms",
            PROCESS_PROBE_TIMEOUT.as_millis()
        ));
        return status;
    }
    match command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, remaining) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
            status.version = lines.next().map(str::to_string);
            status.ipykernel = lines.next().map(str::to_string);
            if status.ipykernel.is_none() {
                let stderr: String = String::from_utf8_lossy(&out.stderr)
                    .trim()
                    .chars()
                    .take(400)
                    .collect();
                status.error = Some(if status.version.is_some() {
                    format!("that Python runs, but `import ipykernel` failed: {stderr}")
                } else if stderr.is_empty() {
                    "that Python printed nothing".into()
                } else {
                    stderr
                });
            }
        }
        Err(e) => status.error = Some(format!("could not run {}: {e}", python.display())),
    }
    status
}

#[tauri::command]
fn kernel_status(state: State<AppState>) -> Result<KernelStatus, String> {
    require_tauri_authority(&state, TauriCommand::KernelStatus)?;
    Ok(kernel_status_impl())
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

#[cfg(windows)]
mod windows_process_ffi {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::HANDLE;

    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    pub const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    pub const THREAD_SUSPEND_RESUME: u32 = 0x0000_0002;

    #[repr(C)]
    #[derive(Default)]
    pub struct JobObjectBasicLimitInformation {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct IoCounters {
        pub read_operation_count: u64,
        pub write_operation_count: u64,
        pub other_operation_count: u64,
        pub read_transfer_count: u64,
        pub write_transfer_count: u64,
        pub other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct JobObjectExtendedLimitInformation {
        pub basic_limit_information: JobObjectBasicLimitInformation,
        pub io_info: IoCounters,
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct ThreadEntry32 {
        pub size: u32,
        pub usage_count: u32,
        pub thread_id: u32,
        pub owner_process_id: u32,
        pub base_priority: i32,
        pub priority_delta: i32,
        pub flags: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "CreateJobObjectW"]
        pub fn create_job_object_w(attributes: *const c_void, name: *const u16) -> HANDLE;
        #[link_name = "SetInformationJobObject"]
        pub fn set_information_job_object(
            job: HANDLE,
            information_class: i32,
            information: *const c_void,
            information_length: u32,
        ) -> i32;
        #[link_name = "AssignProcessToJobObject"]
        pub fn assign_process_to_job_object(job: HANDLE, process: HANDLE) -> i32;
        #[link_name = "CreateToolhelp32Snapshot"]
        pub fn create_toolhelp32_snapshot(flags: u32, process_id: u32) -> HANDLE;
        #[link_name = "Thread32First"]
        pub fn thread32_first(snapshot: HANDLE, entry: *mut ThreadEntry32) -> i32;
        #[link_name = "Thread32Next"]
        pub fn thread32_next(snapshot: HANDLE, entry: *mut ThreadEntry32) -> i32;
        #[link_name = "OpenThread"]
        pub fn open_thread(access: u32, inherit_handle: i32, thread_id: u32) -> HANDLE;
        #[link_name = "ResumeThread"]
        pub fn resume_thread(thread: HANDLE) -> u32;
        #[link_name = "PeekNamedPipe"]
        pub fn peek_named_pipe(
            pipe: HANDLE,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_bytes_available: *mut u32,
            bytes_left_this_message: *mut u32,
        ) -> i32;
    }
}

#[cfg(windows)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessTree {
    fn configure(command: &mut Command) -> Result<Self, String> {
        use std::os::windows::process::CommandExt as _;
        use windows_process_ffi::{
            create_job_object_w, set_information_job_object, JobObjectExtendedLimitInformation,
            CREATE_NO_WINDOW, CREATE_SUSPENDED, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // Suspending the initial thread closes the otherwise unavoidable race where a
        // child could create an uncontained descendant before job assignment.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let job = unsafe { create_job_object_w(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!(
                "could not create process containment job: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits = JobObjectExtendedLimitInformation::default();
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            set_information_job_object(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!(
                "could not configure process containment job: {error}"
            ));
        }
        Ok(Self { job })
    }

    fn admit_and_start(&self, child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_process_ffi::{
            assign_process_to_job_object, create_toolhelp32_snapshot, open_thread, resume_thread,
            thread32_first, thread32_next, ThreadEntry32, TH32CS_SNAPTHREAD, THREAD_SUSPEND_RESUME,
        };

        let assigned =
            unsafe { assign_process_to_job_object(self.job, child.as_raw_handle().cast()) };
        if assigned == 0 {
            return Err(format!(
                "could not contain child process: {}",
                std::io::Error::last_os_error()
            ));
        }

        let snapshot = unsafe { create_toolhelp32_snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(format!(
                "could not enumerate suspended child threads: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut entry = ThreadEntry32 {
            size: std::mem::size_of::<ThreadEntry32>() as u32,
            ..ThreadEntry32::default()
        };
        let mut found = false;
        let mut next = unsafe { thread32_first(snapshot, &mut entry) };
        while next != 0 {
            if entry.owner_process_id == child.id() {
                let thread = unsafe { open_thread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
                if thread.is_null() {
                    unsafe {
                        windows_sys::Win32::Foundation::CloseHandle(snapshot);
                    }
                    return Err(format!(
                        "could not open suspended child thread: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let resumed = unsafe { resume_thread(thread) };
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(thread);
                }
                if resumed == u32::MAX {
                    unsafe {
                        windows_sys::Win32::Foundation::CloseHandle(snapshot);
                    }
                    return Err(format!(
                        "could not resume contained child process: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                found = true;
            }
            next = unsafe { thread32_next(snapshot, &mut entry) };
        }
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(snapshot);
        }
        found
            .then_some(())
            .ok_or_else(|| "contained child process had no resumable thread".to_string())
    }

    fn terminate(&mut self) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
            self.job = std::ptr::null_mut();
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(unix)]
struct ProcessTree {
    process_group: Option<i32>,
}

#[cfg(unix)]
impl ProcessTree {
    fn configure(command: &mut Command) -> Result<Self, String> {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
        Ok(Self {
            process_group: None,
        })
    }

    fn admit_and_start(&mut self, child: &std::process::Child) -> Result<(), String> {
        self.process_group = i32::try_from(child.id()).ok();
        self.process_group
            .map(|_| ())
            .ok_or_else(|| "child process id cannot identify its process group".to_string())
    }

    fn terminate(&mut self) {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        if let Some(process_group) = self.process_group.take() {
            unsafe {
                kill(-process_group, 9);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PipePoll {
    Data(usize),
    Pending,
    Eof,
}

#[cfg(unix)]
trait ProcessPipe: Read {}

#[cfg(unix)]
impl<T: Read> ProcessPipe for T {}

#[cfg(windows)]
trait ProcessPipe: Read + std::os::windows::io::AsRawHandle {}

#[cfg(windows)]
impl<T: Read + std::os::windows::io::AsRawHandle> ProcessPipe for T {}

#[cfg(unix)]
fn prepare_process_pipe<T: std::os::fd::AsRawFd>(pipe: &T) -> std::io::Result<()> {
    unsafe extern "C" {
        fn fcntl(file_descriptor: i32, command: i32, ...) -> i32;
    }
    const F_GETFL: i32 = 3;
    const F_SETFL: i32 = 4;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NONBLOCK: i32 = 0x800;
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    const O_NONBLOCK: i32 = 0x4;

    let fd = pipe.as_raw_fd();
    let flags = unsafe { fcntl(fd, F_GETFL) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn prepare_process_pipe<T>(_pipe: &T) -> std::io::Result<()> {
    // Windows anonymous pipes cannot reliably be switched to PIPE_NOWAIT with
    // their read-only handles. `poll_process_pipe` uses PeekNamedPipe instead.
    Ok(())
}

#[cfg(unix)]
fn poll_process_pipe<R: Read>(reader: &mut R, chunk: &mut [u8]) -> std::io::Result<PipePoll> {
    loop {
        match reader.read(chunk) {
            Ok(0) => return Ok(PipePoll::Eof),
            Ok(read) => return Ok(PipePoll::Data(read)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(PipePoll::Pending)
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn poll_process_pipe<R: Read + std::os::windows::io::AsRawHandle>(
    reader: &mut R,
    chunk: &mut [u8],
) -> std::io::Result<PipePoll> {
    use windows_process_ffi::peek_named_pipe;
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED,
    };

    let mut available = 0_u32;
    let peeked = unsafe {
        peek_named_pipe(
            reader.as_raw_handle().cast(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if peeked == 0 {
        let error = std::io::Error::last_os_error();
        let code = error.raw_os_error().map(|value| value as u32);
        if matches!(
            code,
            Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
        ) {
            return Ok(PipePoll::Eof);
        }
        return Err(error);
    }
    if available == 0 {
        return Ok(PipePoll::Pending);
    }
    let available = usize::try_from(available)
        .unwrap_or(usize::MAX)
        .min(chunk.len());
    loop {
        match reader.read(&mut chunk[..available]) {
            Ok(0) => return Ok(PipePoll::Eof),
            Ok(read) => return Ok(PipePoll::Data(read)),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn poll_bounded_process_pipe<R>(
    reader: &mut R,
    stored: &mut Vec<u8>,
    total: &mut usize,
    max_bytes: usize,
) -> Result<(PipePoll, bool), String>
where
    R: ProcessPipe,
{
    let mut chunk = [0_u8; 8192];
    let polled = poll_process_pipe(reader, &mut chunk).map_err(|error| error.to_string())?;
    let PipePoll::Data(read) = polled else {
        return Ok((polled, false));
    };
    let keep = max_bytes.saturating_sub(*total).min(read);
    stored.extend_from_slice(&chunk[..keep]);
    *total = total.saturating_add(read);
    Ok((polled, keep < read))
}

#[allow(clippy::zombie_processes)] // `try_wait` returning Some has already reaped that child.
fn child_reaper() -> Result<&'static std::sync::mpsc::Sender<std::process::Child>, String> {
    static REAPER: OnceLock<Result<std::sync::mpsc::Sender<std::process::Child>, String>> =
        OnceLock::new();
    match REAPER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<std::process::Child>();
        std::thread::Builder::new()
            .name("bounded-command-reaper".to_string())
            .spawn(move || {
                let mut children = Vec::new();
                loop {
                    match receiver.recv_timeout(Duration::from_millis(5)) {
                        Ok(child) => children.push(child),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                    while let Ok(child) = receiver.try_recv() {
                        children.push(child);
                    }
                    let mut index = 0;
                    while index < children.len() {
                        if matches!(children[index].try_wait(), Ok(Some(_))) {
                            children.swap_remove(index);
                        } else {
                            index += 1;
                        }
                    }
                }
            })
            .map(|_| sender)
            .map_err(|error| format!("could not start bounded command reaper: {error}"))
    }) {
        Ok(sender) => Ok(sender),
        Err(error) => Err(error.clone()),
    }
}

fn reap_child_async(child: std::process::Child) {
    // The reaper is initialized before process creation, and its receiver loop
    // cannot terminate while this static sender exists.
    child_reaper()
        .expect("bounded command reaper was initialized before process creation")
        .send(child)
        .expect("bounded command reaper receiver remains live");
}

fn stop_failed_child(process_tree: &mut ProcessTree, mut child: std::process::Child) {
    process_tree.terminate();
    let _ = child.kill();
    if !matches!(child.try_wait(), Ok(Some(_))) {
        reap_child_async(child);
    }
}

/// Capture a child's combined stdout/stderr under one hard memory ceiling and
/// post-spawn wall-clock deadline. Failures stop the contained tree and arrange
/// reaping without letting a retained output pipe or stuck wait extend the API.
fn command_output_bounded(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Output, String> {
    let started = Instant::now();
    // Fail before creating a process if the nonblocking reaping path cannot be
    // provisioned. This keeps every later cleanup path both bounded and reaped.
    child_reaper()?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut process_tree = ProcessTree::configure(command)?;
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Err(error) = process_tree.admit_and_start(&child) {
        stop_failed_child(&mut process_tree, child);
        return Err(error);
    }
    let Some(stdout) = child.stdout.take() else {
        stop_failed_child(&mut process_tree, child);
        return Err("child has no stdout".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        stop_failed_child(&mut process_tree, child);
        return Err("child has no stderr".to_string());
    };
    let mut stdout = stdout;
    let mut stderr = stderr;
    if let Err(error) = prepare_process_pipe(&stdout).and_then(|_| prepare_process_pipe(&stderr)) {
        stop_failed_child(&mut process_tree, child);
        return Err(format!("could not make child output nonblocking: {error}"));
    }

    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut total = 0_usize;
    loop {
        if started.elapsed() >= timeout {
            stop_failed_child(&mut process_tree, child);
            return Err(format!(
                "process timed out after {} ms",
                timeout.as_millis()
            ));
        }
        let polled = (|| {
            let stdout =
                poll_bounded_process_pipe(&mut stdout, &mut stdout_bytes, &mut total, max_bytes)?;
            let stderr =
                poll_bounded_process_pipe(&mut stderr, &mut stderr_bytes, &mut total, max_bytes)?;
            Ok::<_, String>((stdout, stderr))
        })();
        let ((stdout_poll, stdout_exceeded), (stderr_poll, stderr_exceeded)) = match polled {
            Ok(polled) => polled,
            Err(error) => {
                stop_failed_child(&mut process_tree, child);
                return Err(error);
            }
        };
        if stdout_exceeded || stderr_exceeded {
            stop_failed_child(&mut process_tree, child);
            return Err(format!("process output exceeded {max_bytes} bytes"));
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                // The direct command is complete. Descendants are not authorized to
                // extend its lifetime or contribute later output. Terminate the best-
                // effort tree, drain only bytes already readable, then close our pipes.
                process_tree.terminate();
                loop {
                    if started.elapsed() >= timeout {
                        return Err(format!(
                            "process timed out after {} ms",
                            timeout.as_millis()
                        ));
                    }
                    let (stdout_poll, stdout_exceeded) = poll_bounded_process_pipe(
                        &mut stdout,
                        &mut stdout_bytes,
                        &mut total,
                        max_bytes,
                    )?;
                    let (stderr_poll, stderr_exceeded) = poll_bounded_process_pipe(
                        &mut stderr,
                        &mut stderr_bytes,
                        &mut total,
                        max_bytes,
                    )?;
                    if stdout_exceeded || stderr_exceeded {
                        return Err(format!("process output exceeded {max_bytes} bytes"));
                    }
                    if !matches!(stdout_poll, PipePoll::Data(_))
                        && !matches!(stderr_poll, PipePoll::Data(_))
                    {
                        break;
                    }
                }
                return Ok(Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                });
            }
            Ok(None) => {}
            Err(error) => {
                stop_failed_child(&mut process_tree, child);
                return Err(error.to_string());
            }
        }
        if !matches!(stdout_poll, PipePoll::Data(_)) && !matches!(stderr_poll, PipePoll::Data(_)) {
            let remaining = timeout.saturating_sub(started.elapsed());
            std::thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }
}

// ---------------------------------------------------------------- accounts
//
// `<agentDir>\auth.json` is Record<providerId, credential> — one credential per
// provider — so a second Claude login needs a second agent dir. Setting
// PRIME_AGENT_CODING_AGENT_DIR relocates the whole agent home (auth.json,
// sessions/, settings.json), which is the entire multi-account mechanism.
//
// Credential values (access/refresh tokens) are NEVER returned, logged, copied,
// or formatted into an error anywhere below — only key presence and `expires`.

const MAX_AUTH_CREDENTIAL_FIELDS: usize = 64;
const MAX_AUTH_NESTED_OBJECT_FIELDS: usize = 256;
const MAX_AUTH_NESTED_ARRAY_ITEMS: usize = 4_096;
const MAX_AUTH_JSON_DEPTH: usize = 64;
const MAX_AUTH_JSON_NODES: usize = 65_536;
const MAX_AUTH_FIELD_NAME_BYTES: usize = 256;

#[derive(Clone)]
struct AccountAuthCredential {
    expires_ms: Option<u64>,
}

struct AccountAuthParseBudget {
    nodes: Cell<usize>,
}

impl AccountAuthParseBudget {
    fn new() -> Self {
        Self {
            nodes: Cell::new(0),
        }
    }

    fn consume<E: serde::de::Error>(&self) -> Result<(), E> {
        let nodes = self.nodes.get();
        if nodes >= MAX_AUTH_JSON_NODES {
            return Err(E::custom("auth document exceeds the structural work limit"));
        }
        self.nodes.set(nodes + 1);
        Ok(())
    }
}

struct StrictIgnoredAuthValueSeed<'a> {
    budget: &'a AccountAuthParseBudget,
    depth: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for StrictIgnoredAuthValueSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if self.depth > MAX_AUTH_JSON_DEPTH {
            return Err(<D::Error as serde::de::Error>::custom(
                "auth document exceeds the nesting limit",
            ));
        }
        self.budget.consume::<D::Error>()?;
        deserializer.deserialize_any(StrictIgnoredAuthValueVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

struct StrictIgnoredAuthValueVisitor<'a> {
    budget: &'a AccountAuthParseBudget,
    depth: usize,
}

impl<'de> serde::de::Visitor<'de> for StrictIgnoredAuthValueVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded JSON credential value without duplicate object keys")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        for _ in 0..MAX_AUTH_NESTED_ARRAY_ITEMS {
            if sequence
                .next_element_seed(StrictIgnoredAuthValueSeed {
                    budget: self.budget,
                    depth: self.depth + 1,
                })?
                .is_none()
            {
                return Ok(());
            }
        }
        sequence
            .next_element_seed(RejectAuthValueSeed("auth array exceeds the item limit"))?
            .map_or(Ok(()), |_| unreachable!())
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut fields = HashSet::new();
        for _ in 0..MAX_AUTH_NESTED_OBJECT_FIELDS {
            let Some(field) = object.next_key::<String>()? else {
                return Ok(());
            };
            self.budget.consume::<A::Error>()?;
            if field.is_empty() || field.len() > MAX_AUTH_FIELD_NAME_BYTES || !fields.insert(field)
            {
                return Err(<A::Error as serde::de::Error>::custom(
                    "auth object fields are invalid",
                ));
            }
            object.next_value_seed(StrictIgnoredAuthValueSeed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
        }
        if object.next_key::<serde::de::IgnoredAny>()?.is_some() {
            return Err(<A::Error as serde::de::Error>::custom(
                "auth object exceeds the field limit",
            ));
        }
        Ok(())
    }
}

struct RejectAuthValueSeed(&'static str);

impl<'de> serde::de::DeserializeSeed<'de> for RejectAuthValueSeed {
    type Value = ();

    fn deserialize<D>(self, _deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Err(<D::Error as serde::de::Error>::custom(self.0))
    }
}

struct AccountAuthExpirySeed;

impl<'de> serde::de::DeserializeSeed<'de> for AccountAuthExpirySeed {
    type Value = u64;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(AccountAuthExpiryVisitor)
    }
}

struct AccountAuthExpiryVisitor;

impl serde::de::Visitor<'_> for AccountAuthExpiryVisitor {
    type Value = u64;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a positive JavaScript-safe integer expiry")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        (value > 0 && value <= MAX_JS_SAFE_INTEGER_U64)
            .then_some(value)
            .ok_or_else(|| E::custom("credential expiry is invalid"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let bytes = value.as_bytes();
        if bytes.is_empty()
            || !matches!(bytes[0], b'1'..=b'9')
            || !bytes[1..].iter().all(u8::is_ascii_digit)
        {
            return Err(E::custom("credential expiry is invalid"));
        }
        value
            .parse::<u64>()
            .ok()
            .filter(|expiry| *expiry > 0 && *expiry <= MAX_JS_SAFE_INTEGER_U64)
            .ok_or_else(|| E::custom("credential expiry is invalid"))
    }
}

struct AccountAuthCredentialSeed<'a> {
    budget: &'a AccountAuthParseBudget,
}

impl<'de> serde::de::DeserializeSeed<'de> for AccountAuthCredentialSeed<'_> {
    type Value = AccountAuthCredential;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(AccountAuthCredentialVisitor {
            budget: self.budget,
        })
    }
}

struct AccountAuthCredentialVisitor<'a> {
    budget: &'a AccountAuthParseBudget,
}

impl<'de> serde::de::Visitor<'de> for AccountAuthCredentialVisitor<'_> {
    type Value = AccountAuthCredential;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded provider credential object")
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut fields = HashSet::new();
        let mut expires_ms = None;
        for _ in 0..MAX_AUTH_CREDENTIAL_FIELDS {
            let Some(field) = object.next_key::<String>()? else {
                return Ok(AccountAuthCredential { expires_ms });
            };
            self.budget.consume::<A::Error>()?;
            if field.is_empty()
                || field.len() > MAX_AUTH_FIELD_NAME_BYTES
                || !fields.insert(field.clone())
            {
                return Err(<A::Error as serde::de::Error>::custom(
                    "credential fields are invalid",
                ));
            }
            if field == "expires" {
                expires_ms = Some(object.next_value_seed(AccountAuthExpirySeed)?);
            } else {
                object.next_value_seed(StrictIgnoredAuthValueSeed {
                    budget: self.budget,
                    depth: 1,
                })?;
            }
        }
        if object.next_key::<serde::de::IgnoredAny>()?.is_some() {
            return Err(<A::Error as serde::de::Error>::custom(
                "credential exceeds the field limit",
            ));
        }
        Ok(AccountAuthCredential { expires_ms })
    }
}

struct AccountAuthDocumentSeed<'a> {
    budget: &'a AccountAuthParseBudget,
}

impl<'de> serde::de::DeserializeSeed<'de> for AccountAuthDocumentSeed<'_> {
    type Value = HashMap<String, AccountAuthCredential>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(AccountAuthDocumentVisitor {
            budget: self.budget,
        })
    }
}

struct AccountAuthDocumentVisitor<'a> {
    budget: &'a AccountAuthParseBudget,
}

impl<'de> serde::de::Visitor<'de> for AccountAuthDocumentVisitor<'_> {
    type Value = HashMap<String, AccountAuthCredential>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded provider credential map")
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut providers = HashMap::new();
        for _ in 0..accounts::MAX_PROVIDER_PRODUCT_PROVIDERS {
            let Some(provider) = object.next_key::<String>()? else {
                return Ok(providers);
            };
            self.budget.consume::<A::Error>()?;
            if !accounts::valid_provider_product_provider_id(&provider)
                || providers.contains_key(&provider)
            {
                return Err(<A::Error as serde::de::Error>::custom(
                    "auth provider inventory is invalid",
                ));
            }
            let credential = object.next_value_seed(AccountAuthCredentialSeed {
                budget: self.budget,
            })?;
            providers.insert(provider, credential);
        }
        if object.next_key::<serde::de::IgnoredAny>()?.is_some() {
            return Err(<A::Error as serde::de::Error>::custom(
                "auth provider inventory exceeds the provider limit",
            ));
        }
        Ok(providers)
    }
}

fn parse_account_auth_document(bytes: &[u8]) -> Result<HashMap<String, AccountAuthCredential>, ()> {
    let budget = AccountAuthParseBudget::new();
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let providers = serde::de::DeserializeSeed::deserialize(
        AccountAuthDocumentSeed { budget: &budget },
        &mut deserializer,
    )
    .map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    Ok(providers)
}

/// Parsed auth state. The caller may only inspect provider-key presence and
/// `expires`; credential values are discarded during parsing and never enter
/// the status model, a log, an error, or an IPC value.
#[derive(Clone)]
enum AccountAuthDocument {
    Missing,
    Present(HashMap<String, AccountAuthCredential>),
    Unavailable,
}

/// Read one bounded credential document without ever returning its contents to
/// the renderer. Missing is positive signed-out evidence; every other failure
/// stays unavailable instead of being rewritten as absence.
fn read_account_auth_document(agent_dir: &Path) -> AccountAuthDocument {
    let Ok(root) = agent_dir.canonicalize() else {
        return AccountAuthDocument::Unavailable;
    };
    let auth_path = root.join("auth.json");
    match std::fs::symlink_metadata(&auth_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AccountAuthDocument::Missing,
        Err(_) => AccountAuthDocument::Unavailable,
        Ok(metadata) if !metadata.file_type().is_file() => AccountAuthDocument::Unavailable,
        Ok(_) => read_bounded_under(&root, &auth_path, MAX_AUTH_FILE_BYTES)
            .ok()
            .and_then(|bounded| parse_account_auth_document(&bounded.bytes).ok())
            .map(AccountAuthDocument::Present)
            .unwrap_or(AccountAuthDocument::Unavailable),
    }
}

const DELETE_PLAN_TTL_MS: u64 = 5 * 60 * 1_000;
static ACCOUNT_REGISTRY: OnceLock<Arc<AccountRegistry>> = OnceLock::new();
static ACCOUNT_DELETION: OnceLock<AccountDeletion> = OnceLock::new();
static ACCOUNT_SESSION_GATE: Mutex<()> = Mutex::new(());

fn account_registry() -> &'static Arc<AccountRegistry> {
    ACCOUNT_REGISTRY
        .get_or_init(|| Arc::new(AccountRegistry::new(profiles_dir(), default_agent_dir())))
}

fn account_deletion() -> &'static AccountDeletion {
    ACCOUNT_DELETION
        .get_or_init(|| AccountDeletion::with_ttl(account_registry().clone(), DELETE_PLAN_TTL_MS))
}

fn find_account(id: &str) -> Result<Account, String> {
    account_registry().find(id)
}

/// `None`/empty id = the original `~\.prime\agent`, so every existing caller
/// keeps its old behaviour.
fn agent_dir_for(account_id: Option<&str>) -> Result<PathBuf, String> {
    match account_id.filter(|s| !s.is_empty()) {
        Some(id) => Ok(PathBuf::from(find_account(id)?.agent_dir)),
        None => Ok(default_agent_dir()),
    }
}

fn sessions_dir(account_id: Option<&str>) -> Result<PathBuf, String> {
    Ok(agent_dir_for(account_id)?.join("sessions"))
}

#[tauri::command]
fn list_accounts() -> Result<Vec<Account>, String> {
    account_registry().list()
}

#[tauri::command]
fn get_provider_product_snapshot(state: State<AppState>) -> Result<String, String> {
    provider_product_snapshot_from_registry(&state.authority, account_registry())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn add_account(label: String, provider: String) -> Result<Account, String> {
    account_registry().add(label, provider, now_ms())
}

#[tauri::command]
fn prepare_remove_account(
    state: State<AppState>,
    id: String,
    delete_data: bool,
) -> Result<RemovalPlan, DeletionError> {
    let _session_gate = ACCOUNT_SESSION_GATE.lock().map_err(|_| DeletionError {
        code: DeletionErrorCode::Io,
        message: "account session gate is unavailable".to_owned(),
    })?;
    let active_account_ids: HashSet<String> = lock(&state.sessions)
        .map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "active sessions could not be inspected".to_owned(),
        })?
        .values()
        .filter_map(|session| session.account_id.clone())
        .collect();
    account_deletion().prepare_remove_account_at(&id, delete_data, &active_account_ids, now_ms())
}

#[tauri::command]
fn commit_remove_account(
    state: State<AppState>,
    plan_id: String,
    typed_label: String,
) -> Result<(), DeletionError> {
    let _session_gate = ACCOUNT_SESSION_GATE.lock().map_err(|_| DeletionError {
        code: DeletionErrorCode::Io,
        message: "account session gate is unavailable".to_owned(),
    })?;
    let active_account_ids: HashSet<String> = lock(&state.sessions)
        .map_err(|_| DeletionError {
            code: DeletionErrorCode::Io,
            message: "active sessions could not be inspected".to_owned(),
        })?
        .values()
        .filter_map(|session| session.account_id.clone())
        .collect();
    account_deletion().commit_remove_account_at(
        &plan_id,
        &typed_label,
        &active_account_ids,
        now_ms(),
    )
}

#[tauri::command]
fn rename_account(id: String, label: String) -> Result<(), String> {
    account_registry().rename(&id, label)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatus {
    authed: bool,
    /// The credential's `expires` as a string (it is epoch millis on disk).
    /// Nothing else from the credential ever leaves this function.
    expires: Option<String>,
    provider: String,
    /// Derived auth health — see `auth_health`. The UI renders this, not the
    /// raw timestamp: an expired token kills a running session.
    health: String,
    /// Runway in millis, negative once expired. Formats the countdown.
    expires_in_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatusSnapshot {
    account_id: String,
    available: bool,
    status: Option<AccountStatus>,
}

struct AccountStatusIds(Vec<String>);

struct AccountStatusIdSeed;

impl<'de> serde::de::DeserializeSeed<'de> for AccountStatusIdSeed {
    type Value = String;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_str(self)
    }
}

impl serde::de::Visitor<'_> for AccountStatusIdSeed {
    type Value = String;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a canonical bounded account ID")
    }

    fn visit_borrowed_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if !accounts::valid_provider_product_account_id(value) {
            return Err(E::custom(
                "account status request contains an invalid account ID",
            ));
        }
        Ok(value.to_owned())
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_borrowed_str(value)
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if !accounts::valid_provider_product_account_id(&value) {
            return Err(E::custom(
                "account status request contains an invalid account ID",
            ));
        }
        Ok(value)
    }
}

struct AccountStatusIdsVisitor;

impl<'de> serde::de::Visitor<'de> for AccountStatusIdsVisitor {
    type Value = AccountStatusIds;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded array of unique canonical account IDs")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        let mut ids = Vec::with_capacity(
            sequence
                .size_hint()
                .unwrap_or(0)
                .min(accounts::MAX_PROVIDER_PRODUCT_ACCOUNTS),
        );
        let mut unique = HashSet::with_capacity(ids.capacity());
        for _ in 0..accounts::MAX_PROVIDER_PRODUCT_ACCOUNTS {
            let Some(id) = sequence.next_element_seed(AccountStatusIdSeed)? else {
                return Ok(AccountStatusIds(ids));
            };
            if !unique.insert(id.clone()) {
                return Err(<A::Error as serde::de::Error>::custom(
                    "account status request contains a duplicate account ID",
                ));
            }
            ids.push(id);
        }
        if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
            return Err(<A::Error as serde::de::Error>::custom(
                "account status request exceeds the account limit",
            ));
        }
        Ok(AccountStatusIds(ids))
    }
}

impl<'de> Deserialize<'de> for AccountStatusIds {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(AccountStatusIdsVisitor)
    }
}

/// Runway below which "signed in" stops being the honest answer. Three days, so
/// there is time to act and a "Expires in 2d" state actually exists.
const EXPIRY_WARN_MS: u64 = 3 * 24 * 60 * 60 * 1000;

/// The one place auth health is decided, so no two surfaces can disagree.
/// A credential with no `expires` counts as signed in — that is what prime does
/// with it. Nothing here reads the credential's value.
fn auth_health(authed: bool, expires_ms: Option<u64>, now: u64) -> &'static str {
    if !authed {
        return "signedOut";
    }
    match expires_ms {
        Some(e) if e <= now => "expired",
        Some(e) if e - now <= EXPIRY_WARN_MS => "expiringSoon",
        _ => "signedIn",
    }
}

const MAX_JS_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;

fn status_from_auth_document(
    account: &Account,
    document: &AccountAuthDocument,
    now: u64,
) -> Option<AccountStatus> {
    let credential = match document {
        AccountAuthDocument::Unavailable => return None,
        AccountAuthDocument::Missing => None,
        AccountAuthDocument::Present(providers) => providers.get(&account.provider),
    };

    let Some(credential) = credential else {
        return Some(AccountStatus {
            authed: false,
            expires: None,
            provider: account.provider.clone(),
            health: auth_health(false, None, now).into(),
            expires_in_ms: None,
        });
    };
    let expires_ms = credential.expires_ms;
    let expires_in_ms = expires_ms.map(|expires| {
        let delta = i128::from(expires) - i128::from(now);
        delta.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
    });
    Some(AccountStatus {
        authed: true,
        expires: expires_ms.map(|expires| expires.to_string()),
        provider: account.provider.clone(),
        health: auth_health(true, expires_ms, now).into(),
        expires_in_ms,
    })
}

fn account_statuses_from_accounts<F>(
    accounts: &[Account],
    ids: &[String],
    now: u64,
    mut read_auth: F,
) -> Result<Vec<AccountStatusSnapshot>, String>
where
    F: FnMut(&Path) -> AccountAuthDocument,
{
    if ids.len() > accounts::MAX_PROVIDER_PRODUCT_ACCOUNTS {
        return Err("account status request exceeds the account limit".to_owned());
    }
    let mut requested = HashSet::with_capacity(ids.len());
    for id in ids {
        if !accounts::valid_provider_product_account_id(id) || !requested.insert(id.as_str()) {
            return Err("account status request contains an invalid account ID".to_owned());
        }
    }

    let by_id = accounts
        .iter()
        .map(|account| (account.id.as_str(), account))
        .collect::<HashMap<_, _>>();
    let selected = ids
        .iter()
        .map(|id| {
            by_id
                .get(id.as_str())
                .copied()
                .ok_or_else(|| format!("no such account: {id}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut documents = HashMap::<PathBuf, AccountAuthDocument>::new();
    let mut snapshots = Vec::with_capacity(selected.len());
    for account in selected {
        let agent_dir = PathBuf::from(&account.agent_dir);
        let auth_key = agent_dir.canonicalize().unwrap_or(agent_dir);
        let document = documents
            .entry(auth_key.clone())
            .or_insert_with(|| read_auth(&auth_key));
        let status = status_from_auth_document(account, document, now);
        snapshots.push(AccountStatusSnapshot {
            account_id: account.id.clone(),
            available: status.is_some(),
            status,
        });
    }
    Ok(snapshots)
}

#[tauri::command]
fn account_statuses(ids: AccountStatusIds) -> Result<Vec<AccountStatusSnapshot>, String> {
    let accounts = account_registry().list()?;
    account_statuses_from_accounts(&accounts, &ids.0, now_ms(), read_account_auth_document)
}

/// Opens a terminal running prime-agent's interactive TUI under this profile's
/// agent dir so the user can run `/login`.
///
/// Windows only: driving a native terminal emulator is not portable, so on other
/// platforms this returns the exact command to run instead of guessing at
/// `x-terminal-emulator` / `open -a Terminal`.
fn begin_account_login_impl(id: String) -> Result<(), String> {
    let account = find_account(&id)?;
    std::fs::create_dir_all(&account.agent_dir)
        .map_err(|e| format!("{}: {e}", account.agent_dir))?;
    #[cfg(windows)]
    {
        // `start`'s first quoted arg is the window title and passes through cmd, so
        // keep it to harmless characters.
        let safe: String = account
            .label
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
            .take(40)
            .collect();
        let title = format!("Prime login {safe}");
        // Launch the resolved cli.js through node rather than the `prime-agent`
        // PATH shim, so a user who configured a custom CLI path logs in with THAT
        // install.
        let cli = prime_cli()?.cli.to_string_lossy().into_owned();
        // The ONE intentional visible console: /login is an interactive TUI flow with
        // a browser OAuth round-trip, so the user has to see and drive it. The env var
        // rides on the process (inherited through `start`) rather than a
        // `set X=… && prime-agent` string — cmd folds the trailing space before `&&`
        // into the value and corrupts the path.
        Command::new("cmd")
            .args([
                "/c",
                "start",
                title.as_str(),
                "cmd",
                "/k",
                "node",
                cli.as_str(),
            ])
            .env("PRIME_AGENT_CODING_AGENT_DIR", &account.agent_dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open a login console: {e}"))
    }
    // A block, not a bare expression: `#[cfg]` on a tail expression is unstable.
    #[cfg(not(windows))]
    {
        Err(format!(
            "Run this in a terminal, then type /login:\n\
             PRIME_AGENT_CODING_AGENT_DIR={} prime-agent",
            account.agent_dir
        ))
    }
}

#[tauri::command]
fn begin_account_login(state: State<AppState>, id: String) -> Result<(), String> {
    require_tauri_authority(&state, TauriCommand::BeginAccountLogin)?;
    begin_account_login_impl(id)
}

// ---------------------------------------------------------------- account usage

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    /// Mirrors `tokens.cost`; the top-level field is what the UI reads.
    cost: f64,
    tokens: Usage,
    sessions: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageReport {
    today: Bucket,
    week: Bucket,
    all: Bucket,
}

fn add_bucket(b: &mut Bucket, u: &Usage) {
    b.tokens.input += u.input;
    b.tokens.output += u.output;
    b.tokens.cache_read += u.cache_read;
    b.tokens.cache_write += u.cache_write;
    b.tokens.total_tokens += u.total_tokens;
    b.tokens.cost += u.cost;
    b.cost = b.tokens.cost;
    b.sessions += 1;
}

/// Per-account API-equivalent spend, summed from that profile's session logs.
///
/// `since` (epoch millis) is the cutoff for the `today` bucket: Rust std has no
/// timezone, so the UI passes its own local midnight. Absent = last 24h.
#[tauri::command]
fn account_usage(id: String, since: Option<u64>) -> Result<UsageReport, String> {
    let dir = sessions_dir(Some(&id))?;
    let mut report = UsageReport::default();
    let now = now_ms();
    let day_cut = since.unwrap_or_else(|| now.saturating_sub(86_400_000));
    let week_cut = now.saturating_sub(7 * 86_400_000);

    // A brand-new profile has no sessions dir yet — that is zero usage, not an error.
    if !dir.exists() {
        return Ok(report);
    }
    let entries = read_dir_bounded(&dir, MAX_DIRECTORY_ENTRIES)?;
    let mut session_files = 0_usize;

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        session_files += 1;
        if session_files > MAX_SESSION_FILES {
            return Err(format!(
                "{} exceeds {MAX_SESSION_FILES} session files",
                dir.display()
            ));
        }
        let (meta, records) = read_jsonl_bounded(
            &path,
            JsonlLimits::new(
                MAX_JOURNAL_BYTES,
                MAX_JSONL_LINE_BYTES,
                MAX_JOURNAL_RECORDS,
                MAX_JOURNAL_RECORDS,
            ),
        )?;
        let mtime = mtime_ms(&meta);

        let mut usage = Usage::default();
        for v in records {
            match v["type"].as_str() {
                Some("message") => add_usage(&mut usage, &v["message"]["usage"]),
                // Fan-out cost. childUsage only — aggregateUsage is cumulative.
                Some("child_usage_attributed") => add_usage(&mut usage, &v["childUsage"]),
                _ => {}
            }
        }

        // ponytail: a session is bucketed whole by file mtime, so one spanning
        // midnight lands entirely in the newer bucket. Split per-message by
        // timestamp only if someone ever cares about that boundary.
        add_bucket(&mut report.all, &usage);
        if mtime >= week_cut {
            add_bucket(&mut report.week, &usage);
        }
        if mtime >= day_cut {
            add_bucket(&mut report.today, &usage);
        }
    }
    Ok(report)
}

/// One usage event (assistant message or fan-out child) with its epoch-millis
/// timestamp, for the usage page's daily chart and 7/30/90-day windows.
///
/// Deliberately NOT pre-bucketed by day: Rust std has no timezone, so the UI
/// owns the day boundary — same division as `account_usage`'s `since`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageRow {
    ts: u64,
    provider: String,
    cost: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

/// Per-event usage for one account over the last `days` days.
///
/// Rows carry `provider` because the migrated `default-*` accounts share ONE
/// agent dir: without it, a shared dir's Claude and ChatGPT traffic could not be
/// told apart. `account_usage` is untouched.
#[tauri::command]
fn account_usage_series(id: String, days: u64) -> Result<Vec<UsageRow>, String> {
    let dir = sessions_dir(Some(&id))?;
    // One extra day of slack: the UI trims to ITS local midnight, which can sit
    // up to a day behind this UTC-ish cutoff.
    let cutoff = now_ms().saturating_sub((days.clamp(1, 400) + 1) * 86_400_000);
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    let entries = read_dir_bounded(&dir, MAX_DIRECTORY_ENTRIES)?;
    let mut session_files = 0_usize;

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        session_files += 1;
        if session_files > MAX_SESSION_FILES {
            return Err(format!(
                "{} exceeds {MAX_SESSION_FILES} session files",
                dir.display()
            ));
        }
        let (meta, records) = read_jsonl_bounded(
            &path,
            JsonlLimits::new(
                MAX_JOURNAL_BYTES,
                MAX_JSONL_LINE_BYTES,
                MAX_JOURNAL_RECORDS,
                MAX_JOURNAL_RECORDS,
            ),
        )?;
        // A file last written before the cutoff cannot hold an event inside it.
        let mtime = mtime_ms(&meta);
        if mtime < cutoff {
            continue;
        }

        let (mut last_ts, mut last_provider) = (mtime, String::new());
        for v in records {
            let usage = match v["type"].as_str() {
                Some("message") => {
                    if let Some(t) = v["message"]["timestamp"].as_u64() {
                        last_ts = t;
                    }
                    if let Some(p) = v["message"]["provider"].as_str() {
                        last_provider = p.to_string();
                    }
                    &v["message"]["usage"]
                }
                // Fan-out cost. childUsage only — aggregateUsage is cumulative.
                // Its own `timestamp` is an ISO string, so it inherits the
                // preceding message's millis instead of pulling in a date parser.
                Some("child_usage_attributed") => &v["childUsage"],
                _ => continue,
            };
            if !usage.is_object() || last_ts < cutoff {
                continue;
            }
            if out.len() >= MAX_USAGE_ROWS {
                return Err(format!("usage response exceeds {MAX_USAGE_ROWS} rows"));
            }
            let mut u = Usage::default();
            add_usage(&mut u, usage);
            out.push(UsageRow {
                ts: last_ts,
                provider: last_provider.clone(),
                cost: u.cost,
                input: u.input,
                output: u.output,
                cache_read: u.cache_read,
                cache_write: u.cache_write,
            });
        }
    }
    Ok(out)
}

// ------------------------------------------------- codex subscription quota
//
// ChatGPT/Codex quota is ACCOUNT-level and Prime does not expose it. The Codex
// CLI does: its session logs carry a `rate_limits` object with the real
// subscription percentage. That snapshot only moves when the Codex CLI runs, so
// every consumer gets `staleAsOf` and the UI must render it as "as of <time>".

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RateWindow {
    used_percent: f64,
    window_minutes: u64,
    resets_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexSubscription {
    used_percent: f64,
    window_minutes: u64,
    resets_at: u64,
    plan_type: Option<String>,
    secondary: Option<RateWindow>,
    /// mtime of the log this came from. NOT "now" — see the note above.
    stale_as_of: u64,
}

fn codex_sessions_dir() -> PathBuf {
    home().join(".codex").join("sessions")
}

/// `.jsonl` files under `dir`, recursively, as (mtime, path).
/// ponytail: plain recursion — the tree is year/month/day, three levels deep.
fn collect_jsonl(
    dir: &Path,
    depth: usize,
    visited: &mut usize,
    out: &mut Vec<(u64, PathBuf)>,
) -> Result<(), String> {
    if depth > MAX_CODEX_TREE_DEPTH {
        return Err(format!(
            "{} exceeds directory depth {MAX_CODEX_TREE_DEPTH}",
            dir.display()
        ));
    }
    if !dir.exists() {
        return Ok(());
    }
    for entry in read_dir_bounded(dir, MAX_DIRECTORY_ENTRIES)? {
        *visited += 1;
        if *visited > MAX_DIRECTORY_ENTRIES {
            return Err(format!(
                "{} exceeds {MAX_DIRECTORY_ENTRIES} total entries",
                dir.display()
            ));
        }
        let path = entry.path();
        let meta = entry_metadata_no_follow(&entry)?;
        if meta.is_dir() {
            collect_jsonl(&path, depth + 1, visited, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if out.len() >= MAX_SESSION_FILES {
                return Err(format!("Codex inventory exceeds {MAX_SESSION_FILES} files"));
            }
            out.push((mtime_ms(&meta), path));
        }
    }
    Ok(())
}

/// First `rate_limits` object anywhere in a parsed line. It sits at
/// `payload.rate_limits` today; the walk survives that moving.
fn find_rate_limits(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(map) => map
            .get("rate_limits")
            .filter(|r| r.is_object())
            .or_else(|| map.values().find_map(find_rate_limits)),
        _ => None,
    }
}

/// The LAST `rate_limits` object in a session log.
///
/// Scans lines in reverse and JSON-parses only the ones that mention the key, so
/// a 300KB log costs one substring pass, not thousands of parses.
fn last_rate_limits(text: &str) -> Option<Value> {
    text.lines()
        .rev()
        .filter(|line| line.contains("rate_limits"))
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| find_rate_limits(&v).cloned())
        })
}

fn rate_window(v: &Value) -> Option<RateWindow> {
    v.is_object().then(|| RateWindow {
        used_percent: v["used_percent"].as_f64().unwrap_or(0.0),
        window_minutes: v["window_minutes"].as_u64().unwrap_or(0),
        resets_at: v["resets_at"].as_u64().unwrap_or(0),
    })
}

/// Real ChatGPT/Codex subscription usage, or `None` when no log has it yet.
/// Missing data is not an error — a user who has never run the Codex CLI is fine.
#[tauri::command]
fn codex_subscription_usage() -> Result<Option<CodexSubscription>, String> {
    let mut files = Vec::new();
    let mut visited = 0;
    collect_jsonl(&codex_sessions_dir(), 0, &mut visited, &mut files)?;
    files.sort_by_key(|file| std::cmp::Reverse(file.0));

    for (mtime, path) in files.iter().take(CODEX_SCAN_FILES) {
        let bounded = read_bounded(path, MAX_JOURNAL_BYTES)?;
        let Some(limits) = last_rate_limits(&String::from_utf8_lossy(&bounded.bytes)) else {
            continue;
        };
        // No primary window = nothing to show a percentage for.
        let Some(primary) = rate_window(&limits["primary"]) else {
            continue;
        };
        return Ok(Some(CodexSubscription {
            used_percent: primary.used_percent,
            window_minutes: primary.window_minutes,
            resets_at: primary.resets_at,
            plan_type: limits["plan_type"].as_str().map(str::to_string),
            secondary: rate_window(&limits["secondary"]),
            stale_as_of: *mtime,
        }));
    }
    Ok(None)
}

// ---------------------------------------------------------------- state

struct Session {
    process: ProcessHandle,
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
    /// Account whose profile was selected when this client was spawned.
    account_id: Option<String>,
    /// Which daemon agent this client is driving, once the UI has learned it
    /// (`note_agent`). Only the frontend sees the RPC responses that carry it.
    /// Absent on a stock build, where the session has no identity outside this
    /// process.
    agent: Option<String>,
    session_file: Option<String>,
}

struct AppState {
    sessions: Mutex<HashMap<String, Session>>,
    /// Canonicalized directories the UI is allowed to read files from.
    roots: Mutex<HashSet<PathBuf>>,
    next_id: AtomicU64,
    authority: AuthorityGate,
    computer_use: ComputerUseBroker,
    browser: BrowserBroker,
    /// The sole native scheduler authority. The WebView receives projections,
    /// never the durable store or a mutation handle.
    scheduler: SchedulerService,
    harness: app_state::HarnessState,
    project_catalog: Arc<ProjectCatalog>,
    artifacts: ArtifactAuthority,
}

impl AppState {
    fn from_verified_computer_use(
        verified: Option<computer_use::VerifiedComputerUseAuthority>,
    ) -> Self {
        let computer_use = verified
            .map(ComputerUseBroker::admit_verified_authority)
            .unwrap_or_else(ComputerUseBroker::phase_zero);
        Self {
            sessions: Mutex::new(HashMap::new()),
            roots: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(0),
            authority: AuthorityGate::phase_zero(),
            computer_use,
            browser: BrowserBroker::admission_only(),
            scheduler: SchedulerService::open(scheduler_state_path()),
            harness: app_state::HarnessState::default(),
            project_catalog: Arc::new(ProjectCatalog::new(project_catalog_path())),
            artifacts: ArtifactAuthority::default(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::from_verified_computer_use(None)
    }
}

fn computer_use_readiness_for_state(state: &AppState) -> ComputerUseReadinessProjection {
    state.computer_use.readiness()
}

#[tauri::command]
fn computer_use_readiness(state: State<AppState>) -> ComputerUseReadinessProjection {
    computer_use_readiness_for_state(&state)
}

fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    m.lock()
        .map_err(|_| "internal state lock poisoned".to_string())
}

fn require_tauri_authority(state: &AppState, command: TauriCommand) -> Result<(), String> {
    run_guarded_tauri_command(&state.authority, command, || ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn browser_security_status(state: State<AppState>) -> BrowserSecurityStatus {
    state
        .browser
        .security_status(state.authority.readiness(EffectClass::BrowserExecution))
}

#[tauri::command]
fn browser_check_intent_admission(
    state: State<AppState>,
    request: BrowserIntentAdmissionRequest,
) -> BrowserIntentAdmission {
    state.browser.check_intent_admission(
        state.authority.readiness(EffectClass::BrowserExecution),
        request,
    )
}

#[tauri::command]
fn scheduler_projection(state: State<AppState>) -> SchedulerProjection {
    state.scheduler.projection()
}

#[tauri::command]
fn project_catalog_load(state: State<AppState>) -> Result<CatalogSnapshot, String> {
    state
        .project_catalog
        .load()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_catalog_apply(
    state: State<AppState>,
    expected_revision: u64,
    command: project_catalog::ProjectChatCommand,
) -> Result<CatalogSnapshot, String> {
    state
        .project_catalog
        .apply(expected_revision, command)
        .map_err(|error| error.to_string())
}

/// Put the real Tauri-generated dispatcher behind the single Phase 0 choke
/// point. Returning `true` after rejection marks even an unknown registered
/// handler as consumed, so Tauri cannot fall through to another dispatcher.
fn authority_invoke_handler<R, F>(generated: F) -> impl Fn(tauri::ipc::Invoke<R>) -> bool
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        let authorization = invoke
            .message
            .state_ref()
            .try_get::<AppState>()
            .ok_or_else(|| "security gate state is unavailable".to_string())
            .and_then(|state| {
                let payload = match invoke.message.payload() {
                    tauri::ipc::InvokeBody::Json(payload) => payload,
                    tauri::ipc::InvokeBody::Raw(_) => {
                        return Err("security gate denied raw Tauri payload".to_string())
                    }
                };
                run_authorized_invoke(&state.authority, invoke.message.command(), payload, || ())
            });
        match authorization {
            Ok(()) => generated(invoke),
            Err(error) => {
                invoke.resolver.reject(error);
                true
            }
        }
    }
}

fn run_authorized_invoke<T>(
    gate: &AuthorityGate,
    command_name: &str,
    payload: &Value,
    dispatch: impl FnOnce() -> T,
) -> Result<T, String> {
    authorize_tauri_invoke(gate, command_name, payload).map_err(|error| error.to_string())?;
    Ok(dispatch())
}

fn push_stderr(app: &AppHandle, ring: &Mutex<VecDeque<String>>, key: &str, line: &str) {
    if let Ok(mut r) = ring.lock() {
        if r.len() >= STDERR_RING {
            r.pop_front();
        }
        r.push_back(line.to_string());
    }
    let _ = app.emit("prime://stderr", json!({ "sessionKey": key, "line": line }));
}

struct TauriProcessSink {
    app: AppHandle,
    key: String,
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
    exited: AtomicBool,
}

impl EventSink for TauriProcessSink {
    fn emit(&self, event: ProcessEvent) {
        match event {
            ProcessEvent::Json(event) => {
                let _ = self.app.emit(
                    "prime://event",
                    json!({ "sessionKey": &self.key, "event": event }),
                );
            }
            ProcessEvent::Stderr(line) => {
                push_stderr(&self.app, &self.stderr_ring, &self.key, &line);
            }
            ProcessEvent::ProtocolError(error) => {
                push_stderr(
                    &self.app,
                    &self.stderr_ring,
                    &self.key,
                    &format!("prime process protocol error: {error:?}"),
                );
            }
            ProcessEvent::ProtocolFault(fault) => {
                push_stderr(
                    &self.app,
                    &self.stderr_ring,
                    &self.key,
                    &format!("prime process terminal protocol fault: {fault:?}"),
                );
            }
            ProcessEvent::Exited(exit) => {
                self.exited.store(true, Ordering::Release);
                if let Ok(mut sessions) = self.app.state::<AppState>().sessions.lock() {
                    sessions.remove(&self.key);
                }
                let _ = self.app.emit(
                    "prime://exited",
                    json!({ "sessionKey": &self.key, "code": exit.code }),
                );
            }
        }
    }
}

/// Remove the session and initiate detach/cancellation. The process seam owns the
/// exactly-once `prime://exited` emit, including races with a reader hitting EOF.
///
/// `kill: false` is a **detach**: closing stdin is prime's graceful client
/// disconnect. On a daemon-backed session the agent stays resident (verified:
/// `prime-agent list` still shows it, with `clients 0`); on a stock build the
/// child has nowhere to live and shuts itself down.
fn reap(app: &AppHandle, key: &str, kill: bool) -> bool {
    let taken = app
        .state::<AppState>()
        .sessions
        .lock()
        .ok()
        .and_then(|mut m| m.remove(key));
    if let Some(session) = taken {
        if kill {
            let _ = session.process.cancel();
        } else {
            let _ = session.process.close_input();
        }
        true
    } else {
        false
    }
}

/// Build the complete production process specification.
///
/// This intentionally fails closed until the verified-runtime and environment-
/// policy branches are integrated. This layer must never resolve `node` through
/// PATH or reconstruct an ambient-variable allowlist. Its eventual implementation
/// consumes the absolute executable and complete child environment produced by
/// those shared policy modules.
fn verified_prime_process_spec<BuildArgs>(
    _build_args: BuildArgs,
    _cwd: Option<&str>,
    _agent_dir: Option<&Path>,
    _session_scope: &str,
    _generation: u64,
) -> Result<ProcessSpec, String>
where
    BuildArgs: FnOnce() -> Result<Vec<String>, String>,
{
    Err(
        "Prime launch requires an explicit verified runtime and environment policy result"
            .to_string(),
    )
}

/// Spawn a verified Prime process specification and wire its stdout/stderr to
/// the frontend. Shared by a fresh `start_session` and an `attach_session`
/// reconnect; the only difference between them is the eventual policy input.
fn spawn_client<BuildArgs>(
    app: &AppHandle,
    state: &AppState,
    build_args: BuildArgs,
    cwd: Option<&str>,
    agent_dir: Option<&Path>,
    account_id: Option<&str>,
) -> Result<String, String>
where
    BuildArgs: FnOnce() -> Result<Vec<String>, String>,
{
    let generation = state.next_id.fetch_add(1, Ordering::Relaxed);
    let key = format!("session-{generation}");
    let spec = verified_prime_process_spec(build_args, cwd, agent_dir, &key, generation)?;

    let ring = Arc::new(Mutex::new(VecDeque::new()));
    let sink = Arc::new(TauriProcessSink {
        app: app.clone(),
        key: key.clone(),
        stderr_ring: ring.clone(),
        exited: AtomicBool::new(false),
    });
    let process = spawn_process(spec, sink.clone())
        .map_err(|e| format!("failed to spawn verified Prime runtime: {e}"))?;

    // The working directory becomes a readable root for the artifact pane.
    let root = cwd
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(root) = root.and_then(|root| root.canonicalize().ok()) {
        lock(&state.roots)?.insert(root);
    }

    {
        let mut sessions = lock(&state.sessions)?;
        sessions.insert(
            key.clone(),
            Session {
                process,
                stderr_ring: ring,
                account_id: account_id.map(str::to_owned),
                agent: None,
                session_file: None,
            },
        );
        // The readers start immediately. If a broken CLI exits between spawn and
        // registration, the sink records that race and this check removes the
        // just-inserted dead entry. Every other interleaving is removed by emit().
        if sink.exited.load(Ordering::Acquire) {
            sessions.remove(&key);
        }
    }

    Ok(key)
}

/// `node [--require <shim>] <cli>` — the invariant prefix of every client we
/// spawn. On Windows the `prime-agent` PATH entry is a `.cmd` shim that
/// `CreateProcess` cannot execute, so it is always `node <cli.js>`.
fn node_prefix(cli: &PrimeCli) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    // The shim is a local patch some installs have and a fresh clone will not, so
    // it is passed only when it is actually on disk. See PrimeCli::shim.
    if let Some(shim) = &cli.shim {
        args.push("--require".into());
        args.push(shim.to_string_lossy().into_owned());
    }
    args.push(cli.cli.to_string_lossy().into_owned());
    args
}

// ---------------------------------------------------------------- session commands

#[tauri::command]
fn start_session(
    app: AppHandle,
    state: State<AppState>,
    provider: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    account_id: Option<String>,
) -> Result<String, String> {
    require_tauri_authority(&state, TauriCommand::StartSession)?;
    let _session_gate = lock(&ACCOUNT_SESSION_GATE)?;
    // Resolve before spawning so a bad id fails loudly instead of silently
    // running on the default profile.
    let agent_dir = match &account_id {
        Some(id) if !id.is_empty() => Some(agent_dir_for(Some(id))?),
        _ => None,
    };
    spawn_client(
        &app,
        &state,
        || {
            let cli = prime_cli()?;
            let mut args = node_prefix(&cli);
            args.extend(["--mode".to_string(), "rpc".to_string()]);
            // Daemon-backed: the session is owned by a resident worker, so closing this
            // client detaches instead of killing the work. Gated on the feature probe —
            // a stock prime rejects the flag outright.
            if daemon_supported(&cli.cli) {
                args.push("-d".into());
                args.extend(socket_args());
            }
            for (flag, val) in [
                ("--provider", &provider),
                ("--model", &model),
                ("--cwd", &cwd),
            ] {
                if let Some(v) = val {
                    args.push(flag.into());
                    args.push(v.clone());
                }
            }
            Ok(args)
        },
        cwd.as_deref(),
        agent_dir.as_deref(),
        account_id.as_deref(),
    )
}

/// Reattach an RPC client to an agent that is already running inside the daemon.
/// The transcript comes back over `get_messages` and live state over
/// `get_state` — both the frontend's job, since only it holds the reducer.
#[tauri::command]
fn attach_session(
    app: AppHandle,
    state: State<AppState>,
    agent: String,
    account_id: Option<String>,
) -> Result<String, String> {
    require_tauri_authority(&state, TauriCommand::AttachSession)?;
    let _session_gate = lock(&ACCOUNT_SESSION_GATE)?;
    let agent_dir = match &account_id {
        Some(id) if !id.is_empty() => Some(agent_dir_for(Some(id))?),
        _ => None,
    };
    spawn_client(
        &app,
        &state,
        || {
            let cli = prime_cli()?;
            if !daemon_supported(&cli.cli) {
                return Err(
                    "this prime build has no headless attach: sessions cannot be reattached. \
                            Upgrade prime-agent, or point Prime Studio at a build that supports `-d`."
                        .into(),
                );
            }
            let mut args = node_prefix(&cli);
            args.extend(["attach".into(), agent, "--mode".into(), "rpc".into()]);
            args.extend(socket_args());
            Ok(args)
        },
        None,
        agent_dir.as_deref(),
        account_id.as_deref(),
    )
}

/// Close this client's stdin — prime's graceful client disconnect. On a
/// daemon-backed session the agent stays resident; this is what closing a tab
/// does, and it is deliberately NOT `stop_agent`.
#[tauri::command]
fn detach_session(app: AppHandle, session_key: String) -> Result<(), String> {
    reap(&app, &session_key, false)
        .then_some(())
        .ok_or_else(|| format!("no such Studio-owned session: {session_key}"))
}

/// Kill this client process. On a daemon-backed session the agent survives —
/// that is the point of the daemon. To end the *work*, call `stop_agent`.
#[tauri::command]
fn stop_session(app: AppHandle, session_key: String) -> Result<(), String> {
    reap(&app, &session_key, true)
        .then_some(())
        .ok_or_else(|| format!("no such Studio-owned session: {session_key}"))
}

/// Record which daemon agent a live client is driving. Only the frontend sees
/// the RPC responses that name it, so it hands the pair back here — that is how
/// Fleet knows which of its rows this window is attached to.
#[tauri::command]
fn note_agent(
    state: State<AppState>,
    session_key: String,
    agent: Option<String>,
    session_file: Option<String>,
) -> Result<(), String> {
    let mut sessions = lock(&state.sessions)?;
    if let Some(s) = sessions.get_mut(&session_key) {
        if agent.is_some() {
            s.agent = agent;
        }
        if session_file.is_some() {
            s.session_file = session_file;
        }
    }
    Ok(())
}

#[tauri::command]
fn send_rpc(state: State<AppState>, session_key: String, command: Value) -> Result<(), String> {
    // ponytail: one lock over the whole map across the write. A stalled child pipe
    // would stall every session's send; split to per-session locks if that ever bites.
    let mut sessions = lock(&state.sessions)?;
    let session =
        authorize_known_session_rpc(&state.authority, &mut sessions, &session_key, &command)
            .map_err(|error| error.to_string())?;
    session
        .process
        .send(command)
        .map(|_| ())
        .map_err(|e| format!("write to session {session_key} failed: {e}"))
}

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Result<Vec<String>, String> {
    Ok(lock(&state.sessions)?.keys().cloned().collect())
}

#[tauri::command]
fn get_stderr(state: State<AppState>, session_key: String) -> Result<Vec<String>, String> {
    let sessions = lock(&state.sessions)?;
    let session = sessions
        .get(&session_key)
        .ok_or_else(|| format!("no such session: {session_key}"))?;
    let lines = lock(&session.stderr_ring)?.iter().cloned().collect();
    Ok(lines)
}

// ---------------------------------------------------------------- fleet
//
// `prime-agent list` is the source of truth for what is running: it answers
// from the daemon, so it sees agents this window never started — other windows,
// a terminal TUI, anything on the same socket. Nothing here invents a field the
// listing does not carry.

/// One row of `prime-agent list --json`, plus the two things only Prime Studio
/// can know: which account the transcript belongs to, and whether this window
/// is one of the attached clients.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetAgent {
    id: String,
    name: Option<String>,
    /// prime's own status word (`idle`, `streaming`, …) — printed verbatim
    /// rather than re-mapped into a vocabulary prime does not use.
    activity: String,
    lifecycle: String,
    cwd: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    context_window: Option<u64>,
    messages: u64,
    /// How many clients are attached right now. Two are possible, so this is
    /// read from the listing rather than assumed to be us.
    clients: u64,
    created: Option<String>,
    modified: Option<String>,
    last_activity: Option<String>,
    session_id: Option<String>,
    session_file: Option<String>,
    first_message: Option<String>,
    summary: Option<String>,
    streaming: bool,
    running_tools: bool,
    running_children: bool,
    queued: u64,
    /// `rlmDepth` — anything above 0 is a subagent, whose spend is attributed to
    /// its parent and must not be added to any total.
    depth: u64,
    /// Account the transcript belongs to, matched by session-file path.
    account_id: Option<String>,
    /// Cost and tokens from the agent's own transcript. `None` when the file is
    /// unreadable — an unknown cost is not zero.
    cost: Option<f64>,
    tokens: Option<u64>,
    /// This window has a live client on this agent.
    attached_here: bool,
}

/// What Fleet renders. The failure is a value, not an error: "no daemon
/// running" is a state to explain, and a stock prime has no fleet at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetReport {
    agents: Vec<FleetAgent>,
    /// False on a stock prime: sessions are client-owned and the only agents
    /// that exist are this window's.
    daemon: bool,
    error: Option<String>,
}

/// Run a `prime-agent` sub-command to completion on the effective socket.
fn cli_run(args: &[&str]) -> Result<String, String> {
    let cli = prime_cli()?;
    let mut cmd = Command::new("node");
    cmd.arg(&cli.cli).args(args).args(socket_args());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, PROCESS_COMMAND_TIMEOUT)
        .map_err(|e| format!("`prime-agent {}` failed: {e}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() && stdout.is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(stdout)
}

/// Cost + tokens for one agent, read from its own transcript. Fleet needs the
/// totals but not the messages, so this skips the clone `read_session_file` does.
///
/// A parent's file already carries its children's `child_usage_attributed`
/// lines, which is exactly prime's accounting rule: child spend lands in the
/// parent. Child rows therefore report their own figure for information only
/// and contribute nothing to any subtotal.
fn usage_of(path: &Path) -> Option<Usage> {
    let (_, records) = read_jsonl_bounded(
        path,
        JsonlLimits::new(
            MAX_JOURNAL_BYTES,
            MAX_JSONL_LINE_BYTES,
            MAX_JOURNAL_RECORDS,
            MAX_JOURNAL_RECORDS,
        ),
    )
    .ok()?;
    let mut total = Usage::default();
    for v in records {
        match v["type"].as_str() {
            Some("message") => add_usage(&mut total, &v["message"]["usage"]),
            Some("child_usage_attributed") => add_usage(&mut total, &v["childUsage"]),
            _ => {}
        }
    }
    Some(total)
}

/// Which account a transcript belongs to: the account whose agent dir contains
/// it. Longest match wins, since a nested dir would otherwise match its parent.
fn account_of(session_file: Option<&str>, accounts: &[Account]) -> Option<String> {
    let file = session_file?;
    accounts
        .iter()
        .filter(|a| file.starts_with(&a.agent_dir))
        .max_by_key(|a| a.agent_dir.len())
        .map(|a| a.id.clone())
}

#[tauri::command]
fn fleet_list(state: State<AppState>) -> Result<FleetReport, String> {
    require_tauri_authority(&state, TauriCommand::FleetList)?;
    let daemon = prime_cli()
        .map(|c| daemon_supported(&c.cli))
        .unwrap_or(false);
    if !daemon {
        // Stock prime: no daemon to ask, and asking would be a lie about what
        // the listing means. The UI says so instead.
        return Ok(FleetReport {
            agents: Vec::new(),
            daemon,
            error: None,
        });
    }
    let text = match cli_run(&["list", "--json"]) {
        Ok(t) => t,
        Err(e) => {
            return Ok(FleetReport {
                agents: Vec::new(),
                daemon,
                error: Some(e),
            })
        }
    };
    let doc: Value = serde_json::from_str(&text)
        .map_err(|e| format!("`prime-agent list --json` did not return JSON: {e}"))?;
    let accounts = account_registry().list().unwrap_or_default();
    // Sessions this window is driving, by agent id and by transcript path —
    // whichever the frontend managed to learn.
    let (mine_ids, mine_files): (HashSet<String>, HashSet<String>) = {
        let sessions = lock(&state.sessions)?;
        (
            sessions.values().filter_map(|s| s.agent.clone()).collect(),
            sessions
                .values()
                .filter_map(|s| s.session_file.clone())
                .collect(),
        )
    };

    let mut agents = Vec::new();
    for row in doc["sessions"].as_array().into_iter().flatten() {
        let session_file = row["sessionFile"].as_str().map(str::to_string);
        let usage = session_file.as_deref().and_then(|p| usage_of(Path::new(p)));
        let id = row["id"].as_str().unwrap_or_default().to_string();
        agents.push(FleetAgent {
            attached_here: mine_ids.contains(&id)
                || session_file
                    .as_ref()
                    .is_some_and(|f| mine_files.contains(f)),
            account_id: account_of(session_file.as_deref(), &accounts),
            cost: usage.as_ref().map(|u| u.cost),
            tokens: usage.as_ref().map(|u| u.total_tokens),
            id,
            name: row["sessionName"].as_str().map(str::to_string),
            activity: row["activity"].as_str().unwrap_or("unknown").to_string(),
            lifecycle: row["lifecycle"].as_str().unwrap_or("unknown").to_string(),
            cwd: row["cwd"].as_str().map(str::to_string),
            provider: row["model"]["provider"].as_str().map(str::to_string),
            model: row["model"]["id"].as_str().map(str::to_string),
            thinking: row["thinkingLevel"].as_str().map(str::to_string),
            context_window: row["model"]["contextWindow"].as_u64(),
            messages: row["messageCount"].as_u64().unwrap_or(0),
            clients: row["attachedClients"].as_u64().unwrap_or(0),
            created: row["created"].as_str().map(str::to_string),
            modified: row["modified"].as_str().map(str::to_string),
            last_activity: row["lastActivityAt"].as_str().map(str::to_string),
            session_id: row["sessionId"].as_str().map(str::to_string),
            first_message: row["firstMessage"].as_str().map(str::to_string),
            summary: row["summary"].as_str().map(str::to_string),
            streaming: row["isStreaming"].as_bool().unwrap_or(false),
            running_tools: row["isRunningTools"].as_bool().unwrap_or(false),
            running_children: row["hasRunningRlmChildren"].as_bool().unwrap_or(false),
            queued: row["sessionActions"]["queuedCount"].as_u64().unwrap_or(0),
            depth: row["rlmDepth"].as_u64().unwrap_or(0),
            session_file,
        });
    }
    Ok(FleetReport {
        agents,
        daemon,
        error: None,
    })
}

/// End an agent's work for good. This is the deliberate, confirmed action —
/// closing a tab detaches instead (see `detach_session`).
#[tauri::command]
fn stop_agent(state: State<AppState>, agent: String) -> Result<String, String> {
    require_tauri_authority(&state, TauriCommand::StopAgent)?;
    cli_run(&["stop", &agent])
}

#[tauri::command]
fn rename_agent(state: State<AppState>, agent: String, name: String) -> Result<String, String> {
    require_tauri_authority(&state, TauriCommand::RenameAgent)?;
    cli_run(&["rename", &agent, &name])
}

// ---------------------------------------------------------------- sessions on disk

#[derive(Serialize)]
struct SessionSummary {
    id: String,
    cwd: Option<String>,
    timestamp: Option<String>,
    size: u64,
    mtime: u64,
    title: String,
}

/// First text block of a message's content array, whitespace-collapsed, <= 80 chars.
fn first_text(content: &Value) -> String {
    let text = content
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|c| c["type"] == "text")
                .and_then(|c| c["text"].as_str())
        })
        .unwrap_or_default();
    // chars(), not bytes — slicing mid-UTF-8 would panic.
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

fn read_session_summary(path: &Path) -> Result<SessionSummary, String> {
    let (meta, records) = read_jsonl_prefix_bounded(
        path,
        JsonlLimits::new(
            MAX_SUMMARY_SCAN_BYTES,
            MAX_JSONL_LINE_BYTES,
            SUMMARY_SCAN_RECORDS,
            SUMMARY_SCAN_RECORDS,
        ),
    )?;
    let mtime = mtime_ms(&meta);

    let (mut cwd, mut timestamp, mut title) = (None, None, String::new());
    for value in records {
        match value["type"].as_str() {
            Some("session") => {
                cwd = value["cwd"].as_str().map(str::to_string);
                timestamp = value["timestamp"].as_str().map(str::to_string);
            }
            Some("message") if title.is_empty() && value["message"]["role"] == "user" => {
                title = first_text(&value["message"]["content"]);
            }
            _ => {}
        }
        if cwd.is_some() && !title.is_empty() {
            break;
        }
    }

    Ok(SessionSummary {
        id: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        cwd,
        timestamp,
        size: meta.len(),
        mtime,
        title,
    })
}

#[tauri::command]
fn list_disk_sessions(account_id: Option<String>) -> Result<Vec<SessionSummary>, String> {
    let dir = sessions_dir(account_id.as_deref())?;
    // A profile that has never run has no sessions dir — empty history, not an error.
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = read_dir_bounded(&dir, MAX_DIRECTORY_ENTRIES)?;
    let mut out = Vec::new();

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if out.len() >= MAX_SESSION_FILES {
            return Err(format!(
                "{} exceeds {MAX_SESSION_FILES} session files",
                dir.display()
            ));
        }
        out.push(read_session_summary(&path)?);
    }

    out.sort_by_key(|session| std::cmp::Reverse(session.mtime));
    Ok(out)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: u64,
    cost: f64,
}

fn add_usage(total: &mut Usage, u: &Value) {
    if !u.is_object() {
        return;
    }
    total.input += u["input"].as_u64().unwrap_or(0);
    total.output += u["output"].as_u64().unwrap_or(0);
    total.cache_read += u["cacheRead"].as_u64().unwrap_or(0);
    total.cache_write += u["cacheWrite"].as_u64().unwrap_or(0);
    total.total_tokens += u["totalTokens"].as_u64().unwrap_or(0);
    total.cost += u["cost"]["total"].as_f64().unwrap_or(0.0);
}

#[tauri::command]
fn read_disk_session(id: String, account_id: Option<String>) -> Result<Value, String> {
    // id is a bare filename stem; reject anything that could climb out of the dir.
    if id.is_empty() || id.contains("..") || id.contains(['/', '\\', ':']) {
        return Err(format!("invalid session id: {id}"));
    }
    let path = sessions_dir(account_id.as_deref())?.join(format!("{id}.jsonl"));
    read_session_file(&path)
}

/// Parse one prime session `.jsonl` into the shape the transcript reducer loads.
fn read_session_file(path: &Path) -> Result<Value, String> {
    let (_, records) = read_jsonl_bounded(
        path,
        JsonlLimits::new(
            MAX_JOURNAL_BYTES,
            MAX_JSONL_LINE_BYTES,
            MAX_JOURNAL_RECORDS,
            MAX_JOURNAL_RECORDS,
        ),
    )?;

    let mut messages = Vec::new();
    let mut usage_total = Usage::default();
    for v in records {
        match v["type"].as_str() {
            Some("message") => {
                if messages.len() >= MAX_TRANSCRIPT_MESSAGES {
                    return Err(format!(
                        "{} exceeds {MAX_TRANSCRIPT_MESSAGES} messages",
                        path.display()
                    ));
                }
                add_usage(&mut usage_total, &v["message"]["usage"]);
                messages.push(v["message"].clone());
            }
            // Fan-out cost: childUsage is per-child, aggregateUsage is cumulative
            // and would double-count. Sum only childUsage.
            Some("child_usage_attributed") => add_usage(&mut usage_total, &v["childUsage"]),
            _ => {}
        }
    }
    Ok(json!({ "messages": messages, "usage_total": usage_total }))
}

/// A subagent's own transcript, from the `sessionDir` its `rlm_child_update`
/// event reported. Prime keeps child sessions under `session-artifacts/`, not in
/// the account's `sessions/` folder, so they cannot be opened by id — which is
/// why this takes a path.
///
/// The path comes from an event, not from the user, so it is confined to
/// `~/.prime` before anything is read: a directory that is not prime's own is
/// refused rather than dumped into the UI.
#[tauri::command]
fn read_child_session(dir: String) -> Result<Value, String> {
    let root = home().join(".prime");
    let dir = std::fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    if !dir.starts_with(&root) {
        return Err(format!("{} is outside prime's agent home", dir.display()));
    }
    let entries = read_dir_bounded(&dir, MAX_DIRECTORY_ENTRIES)?;
    let mut jsonl = None;
    for entry in entries {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            entry_metadata_no_follow(&entry)?;
            if jsonl.replace(path).is_some() {
                return Err(format!("multiple transcripts in {}", dir.display()));
            }
        }
    }
    let jsonl = jsonl.ok_or_else(|| format!("no transcript in {}", dir.display()))?;
    read_session_file(&jsonl)
}

// ---------------------------------------------------------------- models

#[derive(Serialize)]
struct ModelInfo {
    provider: String,
    model: String,
    context: String,
    max_out: String,
    thinking: bool,
    images: bool,
}

fn list_models_impl() -> Result<Vec<ModelInfo>, String> {
    // Spawn the CLI through node directly: the `prime-agent` shim on Windows is a
    // .cmd wrapper that CreateProcess cannot resolve.
    let mut cmd = Command::new("node");
    cmd.arg(prime_cli()?.cli)
        .args(["model", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let out = command_output_bounded(&mut cmd, MAX_PROCESS_OUTPUT_BYTES, PROCESS_COMMAND_TIMEOUT)
        .map_err(|e| format!("`prime-agent model list` failed: {e}"))?;
    // prime writes the model table to STDERR, not stdout (verified: 0 lines on stdout,
    // 130 on stderr). Parse both so this keeps working if that ever changes.
    let mut models = parse_model_table(&String::from_utf8_lossy(&out.stdout));
    if models.is_empty() {
        models = parse_model_table(&String::from_utf8_lossy(&out.stderr));
    }
    if models.is_empty() && !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(models)
}

#[tauri::command]
fn list_models(state: State<AppState>) -> Result<Vec<ModelInfo>, String> {
    require_tauri_authority(&state, TauriCommand::ListModels)?;
    list_models_impl()
}

/// Fixed-column table; skip the header, keep rows with all six fields.
fn parse_model_table(text: &str) -> Vec<ModelInfo> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            (f.len() == 6).then(|| ModelInfo {
                provider: f[0].to_string(),
                model: f[1].to_string(),
                context: f[2].to_string(),
                max_out: f[3].to_string(),
                thinking: f[4] == "yes",
                images: f[5] == "yes",
            })
        })
        .collect()
}

// ---------------------------------------------------------------- workspace / shell

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    require_tauri_authority(&app.state::<AppState>(), TauriCommand::PickDirectory)?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx
        .recv()
        .map_err(|e| format!("directory picker failed: {e}"))?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    lock(&app.state::<AppState>().roots)?.insert(canonical);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Canonicalize both sides before comparing: on Windows canonicalize yields
/// `\\?\`-prefixed paths that only match each other.
fn resolve_in_roots(app: &AppHandle, p: &str) -> Result<(PathBuf, PathBuf), String> {
    let path = Path::new(p)
        .canonicalize()
        .map_err(|e| format!("{p}: {e}"))?;
    let state = app.state::<AppState>();
    let roots = lock(&state.roots)?;
    roots
        .iter()
        .filter(|root| path.starts_with(root.as_path()))
        .max_by_key(|root| root.components().count())
        .cloned()
        .map(|root| (root, path))
        .ok_or_else(|| format!("path is outside the workspace: {p}"))
}

#[tauri::command]
fn read_workspace_file(app: AppHandle, path: String) -> Result<String, String> {
    require_tauri_authority(&app.state::<AppState>(), TauriCommand::ReadWorkspaceFile)?;
    let (root, file) = resolve_in_roots(&app, &path)?;
    let bounded = read_bounded_under(&root, &file, MAX_PREVIEW_BYTES as usize)?;
    Ok(String::from_utf8_lossy(&bounded.bytes).into_owned())
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn list_workspace_files(app: AppHandle, dir: String) -> Result<Vec<FileEntry>, String> {
    require_tauri_authority(&app.state::<AppState>(), TauriCommand::ListWorkspaceFiles)?;
    let (_, root) = resolve_in_roots(&app, &dir)?;
    let mut out = Vec::new();
    for entry in read_dir_bounded(&root, MAX_DIRECTORY_ENTRIES)? {
        let metadata = entry_metadata_no_follow(&entry)?;
        out.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    require_tauri_authority(&app.state::<AppState>(), TauriCommand::OpenExternal)?;
    // Only web URLs — the opener would happily hand anything else to the shell.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("refusing to open non-http url: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- app

fn navigation_allowed(url: &tauri::Url, is_dev: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if is_dev {
        return url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port_or_known_default() == Some(1420);
    }
    #[cfg(windows)]
    {
        url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port_or_known_default() == Some(80)
    }
    #[cfg(not(windows))]
    {
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none()
    }
}

#[cfg(debug_assertions)]
fn install_explicit_debug_harness_fixture(app: &AppHandle) -> std::io::Result<()> {
    use harness::broker::{HarnessBroker, SessionOwnership};
    use harness::sidecar::{SidecarSupervisor, VerifiedSidecarSpec};
    use sha2::{Digest, Sha256};

    const RUNTIME_DIGEST: &str =
        "sha256:0bf756952f21542fa814acf301e0e868745b095eaf190b3457c729b41239a900";
    const PROFILE: &str = "prime-agent-daemon-v7-schema13-816309b1cd50";
    const RESOURCE_NAMES: [&str; 13] = [
        "compatibility.js",
        "fakeDaemonScenario.js",
        "framing.js",
        "index.js",
        "redaction.js",
        "runtimeDiscovery.js",
        "runtimeClosure.js",
        "reviewedPrimeAdapter.js",
        "primeDaemonBridge.js",
        "studioHarnessOperations.js",
        "profiles/daemon-v7-schema13.js",
        "vendor/package.json",
        "vendor/prime-daemon-adapter-v0.7.1.mjs",
    ];

    let configured = [
        std::env::var_os("PRIME_STUDIO_DEBUG_HARNESS_NODE"),
        std::env::var_os("PRIME_STUDIO_DEBUG_HARNESS_ENTRY"),
        std::env::var_os("PRIME_STUDIO_DEBUG_HARNESS_SCENARIO"),
    ];
    if configured.iter().all(Option::is_none) {
        return Ok(());
    }
    if configured.iter().any(Option::is_none) {
        return Err(std::io::Error::other(
            "all explicit debug Harness fixture paths are required",
        ));
    }
    let node = PathBuf::from(configured[0].as_ref().expect("checked"));
    let entry = PathBuf::from(configured[1].as_ref().expect("checked"));
    let scenario = PathBuf::from(configured[2].as_ref().expect("checked"));
    if !node.is_absolute() || !entry.is_absolute() || !scenario.is_absolute() {
        return Err(std::io::Error::other(
            "debug Harness fixture paths must be absolute",
        ));
    }
    let digest = |path: &Path| -> std::io::Result<String> {
        Ok(format!("sha256:{:x}", Sha256::digest(std::fs::read(path)?)))
    };
    let root = entry
        .parent()
        .ok_or_else(|| std::io::Error::other("debug Harness entry has no parent"))?;
    let mut resources = RESOURCE_NAMES
        .into_iter()
        .map(|relative| root.join(relative))
        .collect::<Vec<_>>();
    resources.push(scenario.clone());
    let resources = resources
        .into_iter()
        .map(|path| digest(&path).map(|hash| (path, hash)))
        .collect::<std::io::Result<Vec<_>>>()?;
    let spec = VerifiedSidecarSpec::verify(
        node.clone(),
        digest(&node)?,
        vec![
            entry.display().to_string(),
            "--fixture-scenario".to_owned(),
            scenario.display().to_string(),
        ],
        resources,
    )
    .map_err(|error| {
        std::io::Error::other(format!("Harness fixture verification failed: {error}"))
    })?;
    let sidecar = SidecarSupervisor::start(spec).map_err(|error| {
        std::io::Error::other(format!("Harness fixture failed to start: {error}"))
    })?;
    let mut broker = HarnessBroker::new(
        sidecar,
        RUNTIME_DIGEST.to_owned(),
        PROFILE.to_owned(),
        vec![(
            "session-e2e".to_owned(),
            SessionOwnership {
                account_id: Some("account-e2e".to_owned()),
                project_id: "project:personal".to_owned(),
                chat_id: "chat-e2e".to_owned(),
            },
        )],
        None,
    )
    .map_err(|error| std::io::Error::other(format!("Harness fixture broker failed: {error}")))?;
    tauri::async_runtime::block_on(broker.bootstrap()).map_err(|error| {
        std::io::Error::other(format!("Harness fixture bootstrap failed: {error}"))
    })?;
    app.state::<AppState>()
        .harness
        .install(broker)
        .map_err(std::io::Error::other)
}

fn production_resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "Harness resource directory is unavailable".to_owned())?;
    let candidates = [
        root.join("harness-sidecar").join("dist").join("src"),
        root.join("_up_")
            .join("harness-sidecar")
            .join("dist")
            .join("src"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("index.js").is_file())
        .ok_or_else(|| "Harness resources are not installed".to_owned())
}

fn production_node() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let node = program_files.join("nodejs").join("node.exe");
        if node.is_file() {
            return Ok(node);
        }
    }
    #[cfg(not(windows))]
    {
        for node in [
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ] {
            if node.is_file() {
                return Ok(node);
            }
        }
    }
    Err("Pinned Node runtime is unavailable".to_owned())
}

fn start_production_harness_activation(app: &AppHandle) {
    use harness::activation::{activate_production, ActivationError, ProductionActivationInput};

    let harness = app.state::<AppState>().harness.clone();
    let input: Result<ProductionActivationInput, ActivationError> = (|| {
        let daemon_cli = prime_cli().map_err(|_| ActivationError::NotInstalled)?.cli;
        let node = production_node().map_err(|_| ActivationError::EnvironmentUnavailable)?;
        let resource_root = production_resource_root(app)
            .map_err(|_| ActivationError::ResourceVerificationFailed)?;
        let catalog = app
            .state::<AppState>()
            .project_catalog
            .load()
            .map_err(|_| ActivationError::CatalogBindingInvalid)?;
        Ok(ProductionActivationInput {
            daemon_cli,
            node,
            resource_root,
            catalog,
        })
    })();
    match input {
        Err(error) => {
            let _ = harness.mark_unavailable(error.unavailable_reason());
        }
        Ok(input) => {
            tauri::async_runtime::spawn(async move {
                match activate_production(input).await {
                    Ok(broker) => {
                        let _ = harness.install(broker);
                    }
                    Err(error) => {
                        let _ = harness.mark_unavailable(error.unavailable_reason());
                    }
                }
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::fs::create_dir_all(config_dir()).unwrap_or_else(|error| {
        panic!("Prime Studio configuration directory must be available: {error}")
    });
    account_deletion()
        .recover_pending_transactions()
        .unwrap_or_else(|error| {
            panic!("account-removal recovery must complete before startup: {error}")
        });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            if tauri::is_dev() {
                install_explicit_debug_harness_fixture(app.handle())?;
            }
            if app.state::<AppState>().harness.broker().is_none() {
                start_production_harness_activation(app.handle());
            }
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or_else(|| "missing main window configuration".to_string())?;
            let is_dev = tauri::is_dev();
            // In the pinned Tauri 2.11.5 manager, this per-window callback is
            // evaluated before plugin navigation hooks. Keep the dependency pin
            // and the executable origin tests together with this ordering claim.
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .on_navigation(move |url| navigation_allowed(url, is_dev))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(authority_invoke_handler(tauri::generate_handler![
            start_session,
            attach_session,
            detach_session,
            stop_session,
            note_agent,
            fleet_list,
            stop_agent,
            rename_agent,
            send_rpc,
            list_sessions,
            get_stderr,
            browser_security_status,
            browser_check_intent_admission,
            list_disk_sessions,
            read_disk_session,
            read_child_session,
            list_models,
            get_provider_product_snapshot,
            list_accounts,
            add_account,
            prepare_remove_account,
            commit_remove_account,
            rename_account,
            account_statuses,
            begin_account_login,
            account_usage,
            account_usage_series,
            codex_subscription_usage,
            resolve_prime_cli,
            set_prime_cli,
            check_prime_cli,
            get_app_settings,
            project_catalog_load,
            project_catalog_apply,
            scheduler_projection,
            harness_bootstrap,
            harness_projection,
            harness_attach_session,
            harness_session_command,
            harness_inspector,
            harness_refresh_session,
            harness_studio_operation,
            harness_create_resident_chat,
            get_layout_preferences,
            set_layout_preferences,
            set_app_setting,
            export_account_usage_csv,
            editor_artifact_open,
            editor_artifact_save,
            kernel_status,
            files_touched,
            pick_directory,
            read_workspace_file,
            list_workspace_files,
            open_external,
            computer_use_readiness,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Otherwise every quit orphans a node + IPython kernel pair.
            if let tauri::RunEvent::Exit = event {
                let drained = app
                    .state::<AppState>()
                    .sessions
                    .lock()
                    .ok()
                    .map(|mut sessions| sessions.drain().map(|(_, session)| session).collect())
                    .unwrap_or_else(Vec::<Session>::new);
                for session in drained {
                    let _ = session.process.cancel();
                }
            }
        });
}

// ---------------------------------------------------------------- checks

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead as _, BufReader};

    #[test]
    fn app_state_uses_the_catalog_services_exact_confined_leaf_name() {
        assert_eq!(
            project_catalog_path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some("projects-v2.json")
        );
    }

    #[test]
    fn app_state_projects_unavailable_and_verified_admission_only_through_the_same_path() {
        let unavailable = computer_use_readiness_for_state(&AppState::default());
        assert_eq!(
            unavailable.status,
            computer_use::ComputerUseReadinessStatus::Unavailable
        );
        assert!(!unavailable.authority_bound);
        assert!(!unavailable.can_dispatch);

        let verified = computer_use::VerifiedComputerUseAuthority::for_test();
        let admitted =
            computer_use_readiness_for_state(&AppState::from_verified_computer_use(Some(verified)));
        assert_eq!(
            admitted.status,
            computer_use::ComputerUseReadinessStatus::AdmissionOnly
        );
        assert!(admitted.authority_bound);
        assert!(admitted.broker_instance_id.is_some());
        assert!(admitted.authority_digest.is_some());
        assert!(!admitted.can_dispatch);
    }

    #[test]
    fn oversized_process_output_fixture() {
        if std::env::var_os("PRIME_STUDIO_OUTPUT_FIXTURE").is_none() {
            return;
        }
        use std::io::Write as _;
        let bytes = vec![b'x'; 64 * 1024];
        std::io::stdout()
            .write_all(&bytes)
            .expect("write fixture output");
        std::io::stdout().flush().expect("flush fixture output");
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn oversized_process_output_is_bounded_and_child_is_reaped() {
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args([
                "--exact",
                "tests::oversized_process_output_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_OUTPUT_FIXTURE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = std::time::Instant::now();
        let error = command_output_bounded(&mut command, 1024, std::time::Duration::from_secs(5))
            .expect_err("oversized process output must fail closed");
        assert!(error.contains("exceeded 1024 bytes"));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn silent_process_fixture() {
        if std::env::var_os("PRIME_STUDIO_SILENT_FIXTURE").is_none() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn silent_process_is_terminated_at_the_wall_clock_deadline() {
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args(["--exact", "tests::silent_process_fixture", "--nocapture"])
            .env("PRIME_STUDIO_SILENT_FIXTURE", "1");
        let started = std::time::Instant::now();
        let error =
            command_output_bounded(&mut command, 1024, std::time::Duration::from_millis(250))
                .expect_err("silent child must fail closed at its deadline");
        assert!(error.contains("timed out after 250 ms"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn descendant_retains_pipe_child_fixture() {
        if std::env::var_os("PRIME_STUDIO_PIPE_DESCENDANT_FIXTURE").is_none() {
            return;
        }
        #[cfg(unix)]
        if std::env::var_os("PRIME_STUDIO_ESCAPE_PROCESS_GROUP").is_some() {
            unsafe extern "C" {
                fn setsid() -> i32;
            }
            assert_ne!(
                unsafe { setsid() },
                -1,
                "fixture escapes its inherited process group"
            );
            let ready = std::env::var_os("PRIME_STUDIO_ESCAPE_READY")
                .map(PathBuf::from)
                .expect("escaped fixture has a readiness path");
            std::fs::write(ready, b"ready").expect("announce escaped process group");
            std::thread::sleep(std::time::Duration::from_secs(3));
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    #[allow(clippy::zombie_processes)] // The fixture must exit without waiting on its live descendant.
    fn descendant_retains_pipe_parent_fixture() {
        if std::env::var_os("PRIME_STUDIO_PIPE_PARENT_FIXTURE").is_none() {
            return;
        }
        Command::new(std::env::current_exe().expect("current test binary"))
            .args([
                "--exact",
                "tests::descendant_retains_pipe_child_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_PIPE_DESCENDANT_FIXTURE", "1")
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn descendant that inherits output pipes");
    }

    #[test]
    fn descendant_that_retains_output_pipes_is_contained_and_reaped() {
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args([
                "--exact",
                "tests::descendant_retains_pipe_parent_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_PIPE_PARENT_FIXTURE", "1");
        let started = std::time::Instant::now();
        let output =
            command_output_bounded(&mut command, 1024 * 1024, std::time::Duration::from_secs(5))
                .expect("the completed command must not be held open by its descendant");
        assert!(output.status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    #[allow(clippy::zombie_processes)] // The fixture must exit without waiting on its escaped descendant.
    fn escaped_descendant_retains_pipe_parent_fixture() {
        if std::env::var_os("PRIME_STUDIO_ESCAPED_PIPE_PARENT_FIXTURE").is_none() {
            return;
        }
        let ready = std::env::var_os("PRIME_STUDIO_ESCAPE_READY")
            .map(PathBuf::from)
            .expect("parent fixture has a readiness path");
        Command::new(std::env::current_exe().expect("current test binary"))
            .args([
                "--exact",
                "tests::descendant_retains_pipe_child_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_PIPE_DESCENDANT_FIXTURE", "1")
            .env("PRIME_STUDIO_ESCAPE_PROCESS_GROUP", "1")
            .env("PRIME_STUDIO_ESCAPE_READY", &ready)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn escaped descendant that inherits output pipes");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !ready.is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(ready.is_file(), "escaped descendant did not become ready");
    }

    #[cfg(unix)]
    #[test]
    fn escaped_descendant_cannot_hold_output_collection_past_the_deadline() {
        let ready = std::env::temp_dir().join(format!(
            "prime-studio-escaped-pipe-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args([
                "--exact",
                "tests::escaped_descendant_retains_pipe_parent_fixture",
                "--nocapture",
            ])
            .env("PRIME_STUDIO_ESCAPED_PIPE_PARENT_FIXTURE", "1")
            .env("PRIME_STUDIO_ESCAPE_READY", &ready);
        let started = std::time::Instant::now();
        let output = command_output_bounded(
            &mut command,
            1024 * 1024,
            std::time::Duration::from_millis(250),
        )
        .expect("escaped descendant output handles must not extend API wall time");
        assert!(output.status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        std::fs::remove_file(ready).expect("remove escaped readiness fixture");
    }

    #[cfg(unix)]
    #[test]
    fn silent_ipykernel_candidates_share_one_absolute_resolution_deadline() {
        use std::os::unix::fs::PermissionsExt as _;

        let fixture = std::env::temp_dir().join(format!(
            "prime-studio-silent-python-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(&fixture, b"#!/bin/sh\nsleep 30\n").expect("write silent Python fixture");
        let mut permissions = std::fs::metadata(&fixture)
            .expect("stat silent Python fixture")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&fixture, permissions).expect("make silent fixture executable");

        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(250);
        assert!(!has_ipykernel(&fixture, deadline));
        assert!(!has_ipykernel(&fixture, deadline));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));

        std::fs::remove_file(fixture).expect("remove silent Python fixture");
    }

    #[test]
    fn pre_dispatch_is_exhaustive_and_unknown_registered_bodies_never_run() {
        let gate = AuthorityGate::phase_zero();
        for command in authority::ALL_TAURI_COMMANDS {
            let payload = if command == TauriCommand::SendRpc {
                json!({ "sessionKey": "owned", "command": { "type": "abort" } })
            } else {
                json!({})
            };
            let calls = std::cell::Cell::new(0);
            let result = run_authorized_invoke(&gate, command.name(), &payload, || {
                calls.set(calls.get() + 1)
            });
            if authorize_tauri_invoke(&gate, command.name(), &payload).is_ok() {
                assert!(result.is_ok(), "{} must reach dispatch", command.name());
                assert_eq!(
                    calls.get(),
                    1,
                    "{} dispatched more than once",
                    command.name()
                );
            } else {
                assert!(result.is_err(), "{} must be rejected", command.name());
                assert_eq!(calls.get(), 0, "{} entered its body", command.name());
            }
        }

        let calls = std::cell::Cell::new(0);
        let unknown = run_authorized_invoke(&gate, "deliberately_unclassified", &json!({}), || {
            calls.set(calls.get() + 1)
        });
        assert!(unknown
            .expect_err("an unclassified registered handler must fail closed")
            .contains("unknown Tauri command"));
        assert_eq!(calls.get(), 0);

        let raw_calls = std::cell::Cell::new(0);
        let denied = run_authorized_invoke(
            &gate,
            "send_rpc",
            &json!({ "sessionKey": "owned", "command": { "type": "prompt" } }),
            || raw_calls.set(raw_calls.get() + 1),
        );
        assert!(denied.is_err());
        assert_eq!(raw_calls.get(), 0);
    }

    #[test]
    fn same_window_navigation_allows_only_exact_app_or_dev_origin() {
        let packaged_allowed = if cfg!(windows) {
            [
                "http://tauri.localhost/",
                "http://tauri.localhost/index.html#/settings",
            ]
        } else {
            [
                "tauri://localhost/",
                "tauri://localhost/index.html#/settings",
            ]
        };
        for value in packaged_allowed {
            assert!(navigation_allowed(
                &value.parse().expect("valid packaged URL"),
                false
            ));
        }

        for value in [
            "https://example.com/",
            "http://tauri.localhost.evil.test/",
            "http://tauri.localhost@evil.test/",
            "http://user:pass@tauri.localhost/",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,hostile",
            "http://localhost:1421/",
            "https://localhost:1420/",
        ] {
            let url: tauri::Url = value.parse().expect("valid hostile URL");
            assert!(
                !navigation_allowed(&url, false),
                "location.assign/redirect must deny {value}"
            );
        }

        assert!(navigation_allowed(
            &"http://localhost:1420/deep/link"
                .parse()
                .expect("valid dev URL"),
            true
        ));
        assert!(!navigation_allowed(
            &"http://localhost:1421/".parse().expect("valid wrong port"),
            true
        ));
    }

    #[test]
    fn prime_session_spawn_fails_closed_without_a_verified_process_spec() {
        let result =
            verified_prime_process_spec(|| Ok(Vec::new()), None, None, "fixture-session", 1);
        let error = match result {
            Ok(_) => panic!("production launch must remain disabled without verified inputs"),
            Err(error) => error,
        };
        assert!(error.contains("verified runtime"));
        assert!(error.contains("environment policy"));
    }

    #[test]
    fn verified_spec_rejects_before_building_an_unverified_cli_invocation() {
        let invoked = AtomicBool::new(false);
        let result = verified_prime_process_spec(
            || {
                invoked.store(true, Ordering::Release);
                Ok(Vec::new())
            },
            None,
            None,
            "fixture-session",
            1,
        );

        assert!(result.is_err());
        assert!(
            !invoked.load(Ordering::Acquire),
            "CLI discovery or argument building ran before launch policy verification"
        );
    }

    #[test]
    fn title_truncates_by_char_not_byte() {
        let content = json!([{ "type": "text", "text": "  héllo\nwörld  " }]);
        assert_eq!(first_text(&content), "héllo wörld");
        let long = json!([{ "type": "text", "text": "é".repeat(200) }]);
        assert_eq!(first_text(&long).chars().count(), 80);
        assert_eq!(
            first_text(&json!([{ "type": "thinking", "thinking": "x" }])),
            ""
        );
    }

    #[test]
    fn session_summary_stops_before_a_hostile_many_record_tail() {
        use std::io::Write as _;

        let dir = std::env::temp_dir().join(format!(
            "prime-studio-summary-prefix-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&dir).expect("create session summary fixture");
        let path = dir.join("bounded-session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create session fixture");
        writeln!(
            file,
            r#"{{"type":"session","cwd":"C:\\workspace","timestamp":"2026-08-10T00:00:00Z"}}"#
        )
        .expect("write session record");
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"user","content":[{{"type":"text","text":"Bounded title"}}]}}}}"#
        )
        .expect("write title record");
        for _ in 2..SUMMARY_SCAN_RECORDS {
            writeln!(file, "{{}}").expect("write bounded prefix record");
        }
        for _ in 0..=MAX_JOURNAL_RECORDS {
            writeln!(file, "{{}}").expect("write hostile tail record");
        }
        file.flush().expect("flush session fixture");

        let summary = read_session_summary(&path)
            .expect("records beyond the summary prefix must remain unread");

        assert_eq!(summary.id, "bounded-session");
        assert_eq!(summary.cwd.as_deref(), Some("C:\\workspace"));
        assert_eq!(summary.timestamp.as_deref(), Some("2026-08-10T00:00:00Z"));
        assert_eq!(summary.title, "Bounded title");
        assert!(summary.size > MAX_SUMMARY_SCAN_BYTES as u64);
        std::fs::remove_dir_all(dir).expect("remove session summary fixture");
    }

    #[test]
    fn usage_sums_message_and_child_only() {
        let mut t = Usage::default();
        // assistant message usage
        add_usage(
            &mut t,
            &json!({"input":2,"output":118,"cacheRead":0,"cacheWrite":6848,
                                  "totalTokens":6968,"cost":{"total":0.04576}}),
        );
        // user messages have no usage object at all
        add_usage(&mut t, &json!(null));
        // fan-out: childUsage counts, aggregateUsage must NOT (it is cumulative)
        add_usage(
            &mut t,
            &json!({"input":2,"output":66,"cacheRead":0,"cacheWrite":5890,
                                  "totalTokens":5958,"cost":{"total":0.015389}}),
        );
        assert_eq!(
            (t.input, t.output, t.cache_write, t.total_tokens),
            (4, 184, 12738, 12926)
        );
        assert!((t.cost - 0.061149).abs() < 1e-9);
    }

    /// The two real `--help` outputs, trimmed to the lines that matter. Stock
    /// prime-agent 0.7.1 (left) has `attach` but no `--background`; the
    /// daemon-capable build (right) has both.
    #[test]
    fn daemon_capability_comes_from_help_not_a_version_guess() {
        let stock = "Run options:\n  --mode <text|json|rpc|acp>  Select the output mode\n  \
                     --daemon-socket <path>      Use a specific daemon socket\n\
                     Commands:\n  list      List agents\n  attach    Attach the interactive UI to an agent\n";
        let patched = "Run options:\n  --mode <text|json|rpc|acp|daemon>  Select the output mode\n  \
                       --daemon-socket <path>             Use a specific daemon socket\n  \
                       -d, --background                   Keep the agent running after the client exits\n\
                       Commands:\n  list      List agents\n  \
                       attach    Attach a client to an agent (add --mode rpc/acp for a headless client)\n";
        assert!(
            !help_has_daemon(stock),
            "a daemon socket alone is not daemon-backed sessions"
        );
        assert!(help_has_daemon(patched));
        // Neither half on its own is enough, and an empty probe never claims support.
        assert!(!help_has_daemon(
            "  -d, --background   Keep the agent running\n"
        ));
        assert!(!help_has_daemon(""));
    }

    #[test]
    fn daemon_capability_does_not_execute_a_cli_without_verified_launch_inputs() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-hostile-daemon-probe-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let sentinel = root.join("ambient-node-executed");
        let script = root.join("hostile-probe.js");
        let sentinel_json = serde_json::to_string(&sentinel.to_string_lossy()).unwrap();
        std::fs::write(
            &script,
            format!(
                "require('node:fs').writeFileSync({sentinel_json}, 'executed');\n\
                 console.log('--background attach');\n"
            ),
        )
        .unwrap();

        assert!(!daemon_supported(&script));
        assert!(
            !sentinel.exists(),
            "an unverified CLI was executed through ambient node"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// Fleet groups by account, and the only link between a daemon row and an
    /// account is where its transcript lives.
    #[test]
    fn agents_are_attributed_by_transcript_path() {
        let accounts = vec![
            Account {
                id: "default".into(),
                label: "Default".into(),
                provider: "anthropic".into(),
                agent_dir: "C:\\Users\\a\\.prime\\agent".into(),
                created_at: 0,
            },
            Account {
                id: "work".into(),
                label: "Work".into(),
                provider: "anthropic".into(),
                agent_dir: "C:\\Users\\a\\.prime\\profiles\\work".into(),
                created_at: 0,
            },
        ];
        assert_eq!(
            account_of(
                Some("C:\\Users\\a\\.prime\\profiles\\work\\sessions\\x.jsonl"),
                &accounts
            ),
            Some("work".into())
        );
        assert_eq!(
            account_of(
                Some("C:\\Users\\a\\.prime\\agent\\sessions\\x.jsonl"),
                &accounts
            ),
            Some("default".into())
        );
        // An agent started outside every known profile belongs to no account —
        // Fleet says so rather than filing it under the first one.
        assert_eq!(
            account_of(Some("D:\\elsewhere\\sessions\\x.jsonl"), &accounts),
            None
        );
        assert_eq!(account_of(None, &accounts), None);
    }

    #[test]
    fn model_table_parses_and_skips_junk() {
        let table = "provider         model                context  max-out  thinking  images\n\
                     anthropic        claude-opus-5        1M       128K     yes       yes   \n\
                     openai-codex     gpt-5.3-codex-spark  128K     128K     yes       no    \n\
                     (some banner line)\n";
        let m = parse_model_table(table);
        assert_eq!(m.len(), 2);
        assert_eq!(
            (
                m[0].provider.as_str(),
                m[0].model.as_str(),
                m[0].context.as_str()
            ),
            ("anthropic", "claude-opus-5", "1M")
        );
        assert!(m[0].images && !m[1].images);
    }

    #[test]
    fn slugs_are_safe_dir_names_and_unique() {
        assert_eq!(accounts::slug("Claude Personal"), "claude-personal");
        assert_eq!(accounts::slug("  ChatGPT (work) !! "), "chatgpt-work");
        // Nothing that could climb out of profiles\ survives.
        assert_eq!(accounts::slug("../../etc"), "etc");
        assert_eq!(accounts::slug("日本語"), "account");
        let taken = vec![Account {
            id: "claude".into(),
            label: "Claude".into(),
            provider: "anthropic".into(),
            agent_dir: "x".into(),
            created_at: 0,
        }];
        assert_eq!(accounts::unique_id("claude", &taken), "claude-2");
        assert_eq!(accounts::unique_id("other", &taken), "other");
    }

    #[test]
    fn buckets_accumulate_cost_and_session_count() {
        let mut b = Bucket::default();
        let one = Usage {
            input: 2,
            output: 10,
            cost: 0.5,
            ..Usage::default()
        };
        add_bucket(&mut b, &one);
        add_bucket(&mut b, &one);
        assert_eq!((b.sessions, b.tokens.input, b.tokens.output), (2, 4, 20));
        assert!((b.cost - 1.0).abs() < 1e-9 && (b.cost - b.tokens.cost).abs() < 1e-9);
    }

    #[test]
    fn status_reports_presence_and_expiry_only() {
        // Shape of a real auth.json entry — only these two facts may come out.
        let auth = json!({"anthropic": {"type":"oauth","access":"SECRET","refresh":"SECRET",
                                        "expires": 1786198589013u64}});
        let cred = &auth["anthropic"];
        assert!(cred.is_object());
        assert_eq!(cred["expires"].as_u64(), Some(1786198589013));
        assert!(
            auth["openai-codex"].is_null(),
            "absent provider is not authed"
        );
    }

    /// Fixture timestamps, not wall clock: the whole point is that the boundary
    /// is decided in one place.
    #[test]
    fn auth_health_splits_signed_in_from_expiring_from_expired() {
        const DAY: u64 = 24 * 60 * 60 * 1000;
        let now = 1_786_000_000_000;
        assert_eq!(auth_health(false, None, now), "signedOut");
        // A signed-out account is signed out no matter how fresh the timestamp.
        assert_eq!(auth_health(false, Some(now + 30 * DAY), now), "signedOut");
        assert_eq!(auth_health(true, Some(now + 30 * DAY), now), "signedIn");
        // No expiry on the credential = nothing to warn about.
        assert_eq!(auth_health(true, None, now), "signedIn");
        assert_eq!(auth_health(true, Some(now + 2 * DAY), now), "expiringSoon");
        assert_eq!(auth_health(true, Some(now + 1), now), "expiringSoon");
        assert_eq!(auth_health(true, Some(now), now), "expired");
        assert_eq!(auth_health(true, Some(now - 1), now), "expired");
        // The boundary itself warns rather than reassures.
        assert_eq!(
            auth_health(true, Some(now + EXPIRY_WARN_MS), now),
            "expiringSoon"
        );
        assert_eq!(
            auth_health(true, Some(now + EXPIRY_WARN_MS + 1), now),
            "signedIn"
        );
    }

    fn assert_account_status_auth_unavailable(auth: &str, case: &str) {
        let root = std::env::temp_dir().join(format!(
            "prime-account-status-duplicate-auth-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        std::fs::create_dir_all(&root).expect("create duplicate auth fixture");
        let account = Account {
            id: "claude-work".into(),
            label: "Claude work".into(),
            provider: "anthropic".into(),
            agent_dir: root.to_string_lossy().into_owned(),
            created_at: 1,
        };

        std::fs::write(root.join("auth.json"), auth).expect("write hostile auth fixture");
        let document = read_account_auth_document(&root);
        assert!(
            matches!(document, AccountAuthDocument::Unavailable),
            "{case} must make the auth truth unavailable",
        );
        assert!(
            status_from_auth_document(&account, &document, 1_000).is_none(),
            "{case} must never become signed-in status",
        );

        std::fs::remove_dir_all(root).expect("remove duplicate auth fixture");
    }

    fn account_auth_document_fixture(value: Value) -> AccountAuthDocument {
        let bytes = serde_json::to_vec(&value).expect("serialize auth fixture");
        AccountAuthDocument::Present(
            parse_account_auth_document(&bytes).expect("parse valid auth fixture"),
        )
    }

    #[test]
    fn account_status_auth_parser_rejects_a_duplicate_provider_key() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"first"},"anthropic":{"access":"second"}}"#,
            "duplicate provider",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_a_duplicate_expiry_key() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"secret","expires":"2000","expires":"3000"}}"#,
            "duplicate expiry",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_a_duplicate_credential_key() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"first","access":"second"}}"#,
            "duplicate credential key",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_a_nested_duplicate_key() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"secret","metadata":{"scope":"first","scope":"second"}}}"#,
            "nested duplicate credential metadata",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_a_noncanonical_provider_key() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"secret"},"../other":{"access":"secret"}}"#,
            "noncanonical provider",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_a_noncanonical_expiry() {
        assert_account_status_auth_unavailable(
            r#"{"anthropic":{"access":"secret","expires":"02000"}}"#,
            "noncanonical expiry",
        );
    }

    #[test]
    fn account_status_auth_parser_rejects_more_than_the_provider_limit() {
        let mut providers = serde_json::Map::new();
        providers.insert("anthropic".to_owned(), json!({"access": "secret"}));
        for index in 0..accounts::MAX_PROVIDER_PRODUCT_PROVIDERS {
            providers.insert(format!("provider-{index}"), json!({"access": "secret"}));
        }
        let auth =
            serde_json::to_string(&Value::Object(providers)).expect("serialize auth fixture");
        assert_account_status_auth_unavailable(&auth, "provider limit plus one");
    }

    #[test]
    fn account_status_batch_reads_each_shared_auth_directory_once() {
        let shared = PathBuf::from("shared-agent-home");
        let accounts = vec![
            Account {
                id: "default-anthropic".into(),
                label: "Claude".into(),
                provider: "anthropic".into(),
                agent_dir: shared.to_string_lossy().into_owned(),
                created_at: 1,
            },
            Account {
                id: "default-openai-codex".into(),
                label: "ChatGPT".into(),
                provider: "openai-codex".into(),
                agent_dir: shared.to_string_lossy().into_owned(),
                created_at: 2,
            },
        ];
        let ids = vec![
            "default-anthropic".to_owned(),
            "default-openai-codex".to_owned(),
        ];
        let mut reads = HashMap::<PathBuf, usize>::new();

        let rows = account_statuses_from_accounts(&accounts, &ids, 1_000, |agent_dir| {
            *reads.entry(agent_dir.to_path_buf()).or_default() += 1;
            account_auth_document_fixture(json!({
                "anthropic": {"access": "must-not-cross-bridge", "expires": "2000"},
                "openai-codex": {"refresh": "must-not-cross-bridge"}
            }))
        })
        .expect("valid bounded batch");

        assert_eq!(reads.get(&shared), Some(&1));
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.available && row.status.is_some()));
        assert_eq!(rows[0].account_id, "default-anthropic");
        assert_eq!(rows[0].status.as_ref().unwrap().health, "expiringSoon");
        assert_eq!(rows[1].account_id, "default-openai-codex");
        assert_eq!(rows[1].status.as_ref().unwrap().health, "signedIn");
        let public = serde_json::to_string(&rows).expect("serialize credential-free snapshot");
        assert!(!public.contains("must-not-cross-bridge"));
    }

    #[test]
    fn account_status_batch_canonicalizes_aliases_before_deduplicating_reads() {
        let root = std::env::temp_dir().join(format!(
            "prime-account-status-alias-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        std::fs::create_dir_all(root.join("child")).expect("create alias fixture");
        let accounts = vec![
            Account {
                id: "default-anthropic".into(),
                label: "Claude".into(),
                provider: "anthropic".into(),
                agent_dir: root.to_string_lossy().into_owned(),
                created_at: 1,
            },
            Account {
                id: "default-openai-codex".into(),
                label: "ChatGPT".into(),
                provider: "openai-codex".into(),
                agent_dir: root.join("child").join("..").to_string_lossy().into_owned(),
                created_at: 2,
            },
        ];
        let ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<Vec<_>>();
        let mut reads = 0;

        let rows = account_statuses_from_accounts(&accounts, &ids, 1_000, |_| {
            reads += 1;
            account_auth_document_fixture(json!({
                "anthropic": {"access": "secret"},
                "openai-codex": {"access": "secret"}
            }))
        })
        .expect("canonical aliases are one auth source");

        assert!(rows.iter().all(|row| row.available));
        assert_eq!(reads, 1, "the same canonical directory is read only once");
        std::fs::remove_dir_all(root).expect("remove alias fixture");
    }

    #[test]
    fn account_status_batch_distinguishes_missing_auth_from_unavailable_auth() {
        let account = Account {
            id: "claude-work".into(),
            label: "Claude work".into(),
            provider: "anthropic".into(),
            agent_dir: "claude-work-home".into(),
            created_at: 1,
        };
        let ids = vec![account.id.clone()];

        let missing =
            account_statuses_from_accounts(std::slice::from_ref(&account), &ids, 1_000, |_| {
                AccountAuthDocument::Missing
            })
            .expect("missing auth file is a known signed-out state");
        assert!(missing[0].available);
        assert_eq!(missing[0].status.as_ref().unwrap().health, "signedOut");

        let unavailable =
            account_statuses_from_accounts(std::slice::from_ref(&account), &ids, 1_000, |_| {
                AccountAuthDocument::Unavailable
            })
            .expect("an unavailable auth read is represented in-band");
        assert!(!unavailable[0].available);
        assert!(unavailable[0].status.is_none());
    }

    #[test]
    fn account_status_batch_rejects_unbounded_or_noncanonical_requests_before_io() {
        let account = Account {
            id: "claude-work".into(),
            label: "Claude work".into(),
            provider: "anthropic".into(),
            agent_dir: "claude-work-home".into(),
            created_at: 1,
        };
        let mut reads = 0;
        let mut read = |_: &Path| {
            reads += 1;
            AccountAuthDocument::Missing
        };

        for ids in [
            vec!["claude-work".to_owned(), "claude-work".to_owned()],
            vec!["../claude-work".to_owned()],
            vec!["missing-account".to_owned()],
        ] {
            assert!(account_statuses_from_accounts(
                std::slice::from_ref(&account),
                &ids,
                1_000,
                &mut read,
            )
            .is_err());
        }

        let oversized = (0..=accounts::MAX_PROVIDER_PRODUCT_ACCOUNTS)
            .map(|index| format!("account-{index}"))
            .collect::<Vec<_>>();
        assert!(account_statuses_from_accounts(
            std::slice::from_ref(&account),
            &oversized,
            1_000,
            &mut read,
        )
        .is_err());
        assert_eq!(reads, 0, "invalid input must be rejected before auth IO");
    }

    #[test]
    fn account_status_command_ids_are_bounded_during_deserialization() {
        let valid: AccountStatusIds =
            serde_json::from_value(json!(["claude-work", "chatgpt-work"]))
                .expect("bounded canonical IDs deserialize");
        assert_eq!(valid.0, ["claude-work", "chatgpt-work"]);

        for hostile in [
            json!(["claude-work", "claude-work"]),
            json!(["../claude-work"]),
            json!(["x".repeat(65)]),
            Value::Array(
                (0..=accounts::MAX_PROVIDER_PRODUCT_ACCOUNTS)
                    .map(|index| json!(format!("account-{index}")))
                    .collect(),
            ),
        ] {
            assert!(serde_json::from_value::<AccountStatusIds>(hostile).is_err());
        }
    }

    /// End-to-end over a throwaway USERPROFILE: migration, add/rename/remove,
    /// status, usage, and the settings file. The only test that touches the
    /// environment, so it does the whole lifecycle in one go rather than
    /// fighting other tests over process-global vars.
    #[test]
    fn account_lifecycle_in_a_temp_home() {
        let tmp = std::env::temp_dir().join(format!("prime-acct-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let agent = tmp.join(".prime").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        // Same shape as a real auth.json. Values here are obviously fake and, more
        // to the point, nothing below can return them.
        std::fs::write(
            agent.join("auth.json"),
            json!({
                "anthropic": {"type":"oauth","access":"fake","refresh":"fake","expires": 4_000_000_000_000u64},
                "openai-codex": {"type":"oauth","access":"fake","refresh":"fake","expires": 1u64}
            })
            .to_string(),
        )
        .unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        // config_dir() is derived per-OS; point all three layers at the same
        // throwaway so this never writes to the real settings file.
        std::env::set_var("APPDATA", tmp.join("AppData").join("Roaming"));
        std::env::set_var("XDG_CONFIG_HOME", tmp.join(".config"));

        // ---- settings: one file, keys independent, unknown keys refused ----
        assert!(
            get_app_settings().theme.is_none(),
            "a fresh install has no settings file"
        );
        set_app_setting_impl("theme".into(), Some("light".into())).unwrap();
        set_app_setting_impl("defaultThinking".into(), Some("medium".into())).unwrap();
        set_app_setting_impl("sendShortcut".into(), Some("ctrl-enter".into())).unwrap();
        set_app_setting_impl("promptSuggestions".into(), Some("disabled".into())).unwrap();
        // set_prime_cli must not clobber the rest of the file.
        set_prime_cli_impl(Some("  C:\\nope\\dist  ".into())).unwrap();
        let s = get_app_settings();
        assert_eq!(s.theme.as_deref(), Some("light"));
        assert_eq!(s.default_thinking.as_deref(), Some("medium"));
        assert_eq!(s.send_shortcut.as_deref(), Some("ctrl-enter"));
        assert_eq!(s.prompt_suggestions.as_deref(), Some("disabled"));
        assert_eq!(
            s.cli_path.as_deref(),
            Some("C:\\nope\\dist"),
            "trimmed and kept"
        );
        // ...and clearing the CLI path must not clobber the settings either.
        set_prime_cli_impl(None).unwrap();
        assert!(get_app_settings().cli_path.is_none());
        assert_eq!(get_app_settings().theme.as_deref(), Some("light"));
        // Empty value clears one key and leaves the others alone.
        set_app_setting_impl("theme".into(), Some("  ".into())).unwrap();
        assert!(get_app_settings().theme.is_none());
        assert_eq!(
            get_app_settings().default_thinking.as_deref(),
            Some("medium")
        );
        // cliPath is owned by set_prime_cli, which re-resolves — not settable here.
        assert!(set_app_setting_impl("cliPath".into(), Some("x".into())).is_err());
        assert!(set_app_setting_impl("nonsense".into(), None).is_err());
        assert_eq!(
            get_app_settings().default_thinking.as_deref(),
            Some("medium")
        );

        // Migration: one entry per provider already logged in, same agent dir.
        let migrated = list_accounts().unwrap();
        assert_eq!(migrated.len(), 2);
        assert!(migrated.iter().all(|a| Path::new(&a.agent_dir) == agent));
        assert!(migrated.iter().any(|a| a.id == "default-anthropic"));
        assert!(migrated.iter().any(|a| a.id == "default-openai-codex"));
        assert!(account_registry().registry_path().exists());
        // Second call must not re-migrate or duplicate.
        assert_eq!(list_accounts().unwrap().len(), 2);

        let live = account_statuses(AccountStatusIds(vec!["default-anthropic".into()]))
            .unwrap()
            .remove(0)
            .status
            .unwrap();
        assert!(live.authed && live.expires.as_deref() == Some("4000000000000"));
        assert_eq!(live.health, "signedIn");
        assert!(live.expires_in_ms.unwrap() > 0);
        let stale = account_statuses(AccountStatusIds(vec!["default-openai-codex".into()]))
            .unwrap()
            .remove(0)
            .status
            .unwrap();
        assert!(stale.authed && stale.expires.as_deref() == Some("1"));
        assert_eq!(
            stale.health, "expired",
            "an expired token kills a running session"
        );
        assert!(stale.expires_in_ms.unwrap() < 0);

        // A new profile: own dir, no credentials yet.
        let added = add_account("Claude Work".into(), "anthropic".into()).unwrap();
        assert_eq!(added.id, "claude-work");
        assert!(Path::new(&added.agent_dir).is_dir());
        let fresh = account_statuses(AccountStatusIds(vec!["claude-work".into()]))
            .unwrap()
            .remove(0)
            .status
            .unwrap();
        assert!(!fresh.authed && fresh.expires.is_none());
        assert_eq!(fresh.health, "signedOut");
        assert!(add_account("x".into(), "bogus".into()).is_err());

        // Usage: assistant message + fan-out child usage, from that profile only.
        let sessions = Path::new(&added.agent_dir).join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("s1.jsonl"),
            "{\"type\":\"session\",\"cwd\":\"c:\\\\x\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":2,\"output\":10,\"cost\":{\"total\":0.5}}}}\n\
             {\"type\":\"child_usage_attributed\",\"childUsage\":{\"input\":1,\"output\":1,\"cost\":{\"total\":0.25}},\
              \"aggregateUsage\":{\"input\":999,\"cost\":{\"total\":99.0}}}\n",
        )
        .unwrap();
        let u = account_usage("claude-work".into(), Some(0)).unwrap();
        assert_eq!(
            (u.all.sessions, u.all.tokens.input, u.all.tokens.output),
            (1, 3, 11)
        );
        assert!(
            (u.all.cost - 0.75).abs() < 1e-9,
            "aggregateUsage must not be counted"
        );
        assert!(
            (u.today.cost - 0.75).abs() < 1e-9,
            "since=0 puts everything in today"
        );
        // Same files, per-event: one row per assistant message + one per child.
        // The message carries no timestamp here, so both fall back to file mtime
        // (now) and land inside the window; provider is unknown -> "".
        let rows = account_usage_series("claude-work".into(), 7).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.ts > 0));
        assert!((rows.iter().map(|r| r.cost).sum::<f64>() - 0.75).abs() < 1e-9);
        // A profile that never ran reports zeroes rather than failing.
        assert_eq!(
            account_usage("default-anthropic".into(), None)
                .unwrap()
                .all
                .sessions,
            0
        );
        assert!(account_usage_series("default-anthropic".into(), 30)
            .unwrap()
            .is_empty());
        assert!(list_disk_sessions(Some("default-anthropic".into()))
            .unwrap()
            .is_empty());
        assert_eq!(
            list_disk_sessions(Some("claude-work".into()))
                .unwrap()
                .len(),
            1
        );

        rename_account("claude-work".into(), "Claude Job".into()).unwrap();
        assert!(list_accounts()
            .unwrap()
            .iter()
            .any(|a| a.label == "Claude Job"));

        // Entry-only removal is also prepared and committed; the profile
        // remains because this plan authorizes only the registry mutation.
        let entry_plan = account_deletion()
            .prepare_remove_account_at("claude-work", false, &HashSet::new(), now_ms())
            .unwrap();
        account_deletion()
            .commit_remove_account_at(&entry_plan.plan_id, "", &HashSet::new(), now_ms())
            .unwrap();
        assert!(
            Path::new(&added.agent_dir).exists(),
            "entry-only removal keeps profile data"
        );
        assert_eq!(list_accounts().unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Synthetic line matching the observed Codex JSONL shape: `rate_limits` is
    /// nested under `payload`, not top level. Values are deterministic examples.
    const CODEX_LINE: &str = r#"{"timestamp":"2000-01-01T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"total_tokens":12},"model_context_window":1000},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":25.0,"window_minutes":60,"resets_at":946684800},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"plan_type":"pro","rate_limit_reached_type":null}}}"#;

    #[test]
    fn rate_limits_tail_scan_takes_the_last_one() {
        let older = CODEX_LINE.replace("\"used_percent\":25.0", "\"used_percent\":42.5");
        let log = format!(
            "{older}\nthis line is not json at all\n{{\"type\":\"message\"}}\n{CODEX_LINE}\n"
        );
        let limits = last_rate_limits(&log).expect("nested rate_limits is found");
        let primary = rate_window(&limits["primary"]).unwrap();
        assert_eq!(
            primary.used_percent, 25.0,
            "the LAST snapshot wins, not the first"
        );
        assert_eq!((primary.window_minutes, primary.resets_at), (60, 946684800));
        assert_eq!(limits["plan_type"].as_str(), Some("pro"));
        // Secondary is null in this representative shape; it must stay None.
        assert!(rate_window(&limits["secondary"]).is_none());
    }

    #[test]
    fn rate_limits_absent_is_none_not_an_error() {
        assert!(last_rate_limits("{\"type\":\"message\"}\njunk line\n").is_none());
        assert!(last_rate_limits("").is_none());
        // Mentions the key but has no object under it — still nothing to show.
        assert!(last_rate_limits("{\"note\":\"rate_limits are missing here\"}").is_none());
    }

    /// Manual probe against the real `~\.codex\sessions`, since only a machine
    /// that has run Codex has anything to find:
    /// `cargo test -- --ignored --nocapture codex_probe`
    #[test]
    #[ignore]
    fn codex_probe() {
        let got = codex_subscription_usage().unwrap();
        println!("{}", serde_json::to_string_pretty(&got).unwrap());
        assert!(got.is_some(), "no rate_limits in the newest Codex logs");
    }

    /// What this machine's kernel actually resolves to — only a machine that has
    /// run prime has a venv to find:
    /// `cargo test -- --ignored --nocapture kernel_probe`
    ///
    /// `ipykernel: null` is a legitimate result and the reason the Kernel pane
    /// exists: prime seeds the venv with pip/setuptools first and installs
    /// ipykernel when it next starts a session. Verified here on 2026-08-08.
    #[test]
    #[ignore]
    fn kernel_probe() {
        let got = kernel_status_impl();
        println!("{}", serde_json::to_string_pretty(&got).unwrap());
        assert!(
            !got.python.is_empty() && !got.source.is_empty(),
            "a path is always reported"
        );
    }

    /// A throwaway prime-agent tree: `<root>/dist/bundle/cli.js` plus the shim.
    fn fake_install(name: &str, with_shim: bool) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("prime-cli-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("dist").join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("cli.js"), "// fake").unwrap();
        if with_shim {
            std::fs::write(root.join("dist").join("windowshide-shim.cjs"), "// fake").unwrap();
        }
        root
    }

    /// Layering: an explicit source beats autodetection, and every shape a user
    /// might type resolves to the same cli.js.
    #[test]
    fn explicit_cli_path_wins_over_autodetection() {
        let root = fake_install("wins", true);
        let cli = root.join("dist").join("bundle").join("cli.js");

        for shape in [
            root.clone(),
            root.join("dist"),
            root.join("dist").join("bundle"),
            cli.clone(),
        ] {
            let got = resolve_cli_from(&[(
                "$PRIME_STUDIO_CLI".into(),
                shape.to_string_lossy().into_owned(),
            )])
            .unwrap_or_else(|e| panic!("{} should resolve: {e}", shape.display()));
            // Not whatever this machine has installed — the explicit path.
            assert_eq!(
                got.cli,
                cli,
                "explicit path must win for {}",
                shape.display()
            );
            assert_eq!(got.source, "$PRIME_STUDIO_CLI");
            assert!(got.shim.is_some(), "the shim next to cli.js is picked up");
        }

        // No shim on disk => no --require pair. This is the fresh-clone case.
        let bare = fake_install("bare", false);
        let got =
            resolve_cli_from(&[("setting".into(), bare.to_string_lossy().into_owned())]).unwrap();
        assert!(
            got.shim.is_none(),
            "a missing shim must stay None, not a bogus path"
        );

        // Earlier explicit layers win; an empty one is skipped, not an error.
        let ordered = resolve_cli_from(&[
            ("first".into(), String::new()),
            ("second".into(), root.to_string_lossy().into_owned()),
        ])
        .unwrap();
        assert_eq!(ordered.source, "second");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// An explicit path that is not a prime install is a clear error naming the
    /// source and the path — never a silent fall-through to some other install.
    #[test]
    fn explicit_cli_path_that_is_missing_errors_clearly() {
        let missing = std::env::temp_dir()
            .join("prime-cli-test-does-not-exist")
            .join("dist");
        let err = resolve_cli_from(&[(
            "$PRIME_AGENT_CLI".into(),
            missing.to_string_lossy().into_owned(),
        )])
        .expect_err("a bad explicit path must not fall back");
        assert!(err.contains("$PRIME_AGENT_CLI"), "names the source: {err}");
        assert!(
            err.contains("cli.js"),
            "says what it was looking for: {err}"
        );

        // A directory that exists but holds no cli.js is the same error.
        let empty = std::env::temp_dir().join(format!("prime-cli-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert!(
            resolve_cli_from(&[("setting".into(), empty.to_string_lossy().into_owned())]).is_err()
        );
        let _ = std::fs::remove_dir_all(&empty);
    }

    /// What this machine actually resolves to, since only a machine with
    /// prime-agent installed has anything to find:
    /// `cargo test -- --ignored --nocapture cli_probe`
    #[test]
    #[ignore]
    fn cli_probe() {
        let got = prime_cli().expect("prime-agent should resolve here");
        println!("{}", serde_json::to_string_pretty(&got).unwrap());
        assert!(got.cli.is_file());
        // The whole non-UI spawn path: resolve -> node -> parse prime's output.
        println!("version: {}", check_prime_cli_impl(None).unwrap());
        let models = list_models_impl().unwrap();
        println!(
            "{} models, first = {:?}",
            models.len(),
            models.first().map(|m| &m.model)
        );
        assert!(!models.is_empty(), "model list must come back");
    }

    #[test]
    fn jsonl_splits_on_lf_only() {
        // A payload containing \r and U+2028 must survive as ONE line.
        let raw = "{\"a\":\"x\\u2028y\"}\n{\"b\":\"c\\rd\"}\n";
        let lines: Vec<Vec<u8>> = BufReader::new(raw.as_bytes())
            .split(b'\n')
            .flatten()
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(serde_json::from_slice::<Value>(&lines[0]).is_ok());
    }
}
