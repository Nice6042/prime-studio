import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const schemaPath = resolve(appRoot, "contracts", "harness-v1.schema.json");
const typescriptPath = resolve(appRoot, "src", "shared", "ipc", "harness.generated.ts");
const rustPath = resolve(appRoot, "src-tauri", "src", "harness", "generated.rs");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function visit(value, callback, path = "$") {
  if (!value || typeof value !== "object") return;
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, callback, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(child, callback, `${path}.${key}`);
  }
}

export async function loadHarnessSchema(source = pathToFileURL(schemaPath)) {
  const text = await readFile(source, "utf8");
  return JSON.parse(text);
}

export function validateHarnessSchema(schema) {
  if (schema?.properties?.studioProtocol?.const !== 1) {
    throw new Error("Studio Harness Protocol must have version 1");
  }
  if (schema?.$defs?.RequestId?.pattern !== "^[A-Za-z0-9_-]{16,96}$") {
    throw new Error("request IDs must use the closed bounded grammar");
  }

  visit(schema, (node, path) => {
    if (node.type === "object") {
      if (node.additionalProperties !== false || !Array.isArray(node.required)) {
        throw new Error(`closed object required at ${path}`);
      }
      const keys = Object.keys(node.properties ?? {});
      if (keys.some((key) => !node.required.includes(key))) {
        throw new Error(`every object field must be required at ${path}`);
      }
    }
    if (node.type === "array") {
      if (!Number.isSafeInteger(node.maxItems) || node.maxItems < 1 || node.maxItems > 4096) {
        throw new Error(`bounded array required at ${path}`);
      }
    }
    if (node.type === "string" && !node.enum && node.const === undefined) {
      if (node.maxLength === undefined && node.pattern === undefined) {
        throw new Error(`bounded string required at ${path}`);
      }
    }
  });
}

function typescriptSource(hash) {
  return `// Generated from harness-v1.schema.json; SHA-256: ${hash}
// Do not edit by hand. Run npm run generate:harness-contract.

export const STUDIO_HARNESS_PROTOCOL = 1 as const;
export const HARNESS_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const HARNESS_TRANSCRIPT_PAGE_MAX_ROWS = 300;

export type HarnessCapability =
  | "attach_snapshot"
  | "event_sequence"
  | "resident_sessions"
  | "session_input_admission"
  | "model_catalog"
  | "extension_ui"
  | "chunked_snapshot"
  | "prompt_admission_cancellation"
  | "queue_management"
  | "resource_snapshot"
  | "delete_child"
  | "heartbeat_catalog"
  | "heartbeat_management"
  | "side_question_transcript"
  | "transient_bash";

export type HarnessUnavailableReason =
  | "not_installed"
  | "runtime_identity_mismatch"
  | "unsupported_protocol"
  | "unsupported_schema"
  | "missing_mandatory_capability"
  | "transport_unavailable"
  | "security_verification_failed";

export interface RuntimeIdentity {
  packageName: "prime-agent";
  packageVersion: string;
  packageDigest: string;
  entrypointDigest: string;
  protocolName: string;
  protocolVersion: number;
  schemaRevision: number;
  schemaId: string;
  capabilities: readonly HarnessCapability[];
}

export interface UnavailableFeature {
  capability: HarnessCapability;
  reason: HarnessUnavailableReason;
}

export type HarnessCompatibility =
  | { status: "ready"; profile: string; capabilities: readonly HarnessCapability[] }
  | { status: "degraded"; profile: string; capabilities: readonly HarnessCapability[]; unavailable: readonly UnavailableFeature[] }
  | { status: "read_only"; reason: HarnessUnavailableReason; runtime: RuntimeIdentity | null }
  | { status: "unavailable"; reason: HarnessUnavailableReason };

export interface HarnessCursor {
  runtimeGeneration: string;
  sequence: number;
}

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; redacted: boolean }
  | { kind: "tool_call"; toolCallId: string; toolId: string; status: "pending" | "running" | "blocked" | "succeeded" | "failed" };

export type ParentMessage =
  | { channel: "parent"; kind: "user"; id: string; text: string; emittedAtMs: number }
  | { channel: "parent"; kind: "assistant"; id: string; blocks: readonly MessageBlock[]; streaming: boolean; emittedAtMs: number }
  | { channel: "parent"; kind: "notice"; id: string; text: string; emittedAtMs: number };

export interface ChildAgentSummary {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "unknown";
  task: string;
  provider: string | null;
  model: string | null;
  progress: number | null;
}

export interface QueueItem { id: string; label: string; state: "queued" | "admitted" | "running" | "cancelled" }
export interface ToolDefinition { id: string; label: string; enabled: boolean; configurable: boolean }
export interface ContextSource { id: string; label: string; kind: string; availability: "available" | "unavailable" }

export interface CurrentChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
}

export interface RootSessionSnapshot {
  sessionId: string;
  accountId: string | null;
  projectId: string;
  chatId: string;
  cursor: HarnessCursor;
  state: "idle" | "working" | "blocked" | "failed" | "disconnected" | "stopped";
  parentMessages: readonly ParentMessage[];
  children: readonly ChildAgentSummary[];
  queue: readonly QueueItem[];
  tools: readonly ToolDefinition[];
  resources: readonly ContextSource[];
  usage: CurrentChatUsage;
}

export type StudioRequest =
  | { type: "discover_runtime" }
  | { type: "bootstrap" };

export type StudioResponse =
  | { type: "discover_runtime_result"; runtime: RuntimeIdentity | null; compatibility: HarnessCompatibility }
  | { type: "bootstrap_result"; compatibility: HarnessCompatibility; sessions: readonly RootSessionSnapshot[] }
  | { type: "error"; code: string; message: string };

export type HarnessEvent =
  | { type: "snapshot"; snapshot: RootSessionSnapshot }
  | { type: "session_state"; sessionId: string; cursor: HarnessCursor; state: RootSessionSnapshot["state"] };

export type StudioPayload = StudioRequest | StudioResponse | HarnessEvent;

export interface StudioEnvelope<TPayload extends StudioPayload = StudioPayload> {
  studioProtocol: typeof STUDIO_HARNESS_PROTOCOL;
  requestId: string;
  payload: TPayload;
}
`;
}

function rustSource(hash) {
  return `// Generated from harness-v1.schema.json; SHA-256: ${hash}
// Do not edit by hand. Run npm run generate:harness-contract.

use std::collections::HashSet;
use std::fmt;

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

pub const STUDIO_HARNESS_PROTOCOL: u8 = 1;
pub const HARNESS_FRAME_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const HARNESS_TRANSCRIPT_PAGE_MAX_ROWS: usize = 300;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessCapability {
    AttachSnapshot, EventSequence, ResidentSessions, SessionInputAdmission, ModelCatalog,
    ExtensionUi, ChunkedSnapshot, PromptAdmissionCancellation, QueueManagement,
    ResourceSnapshot, DeleteChild, HeartbeatCatalog, HeartbeatManagement,
    SideQuestionTranscript, TransientBash,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessUnavailableReason {
    NotInstalled, RuntimeIdentityMismatch, UnsupportedProtocol, UnsupportedSchema,
    MissingMandatoryCapability, TransportUnavailable, SecurityVerificationFailed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub package_name: String,
    pub package_version: String,
    pub package_digest: String,
    pub entrypoint_digest: String,
    pub protocol_name: String,
    pub protocol_version: u16,
    pub schema_revision: u16,
    pub schema_id: String,
    pub capabilities: Vec<HarnessCapability>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UnavailableFeature {
    pub capability: HarnessCapability,
    pub reason: HarnessUnavailableReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "status")]
pub enum HarnessCompatibility {
    Ready { profile: String, capabilities: Vec<HarnessCapability> },
    Degraded { profile: String, capabilities: Vec<HarnessCapability>, unavailable: Vec<UnavailableFeature> },
    ReadOnly { reason: HarnessUnavailableReason, runtime: Option<RuntimeIdentity> },
    Unavailable { reason: HarnessUnavailableReason },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HarnessCursor { pub runtime_generation: String, pub sequence: u64 }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "kind")]
pub enum MessageBlock {
    Text { text: String },
    Thinking { text: String, redacted: bool },
    ToolCall { #[serde(rename = "toolCallId")] tool_call_id: String, #[serde(rename = "toolId")] tool_id: String, status: ToolCallStatus },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus { Pending, Running, Blocked, Succeeded, Failed }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "kind")]
pub enum ParentMessage {
    User { channel: ParentChannel, id: String, text: String, #[serde(rename = "emittedAtMs")] emitted_at_ms: u64 },
    Assistant { channel: ParentChannel, id: String, blocks: Vec<MessageBlock>, streaming: bool, #[serde(rename = "emittedAtMs")] emitted_at_ms: u64 },
    Notice { channel: ParentChannel, id: String, text: String, #[serde(rename = "emittedAtMs")] emitted_at_ms: u64 },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParentChannel { Parent }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChildAgentSummary {
    pub id: String, pub status: ChildAgentStatus, pub task: String,
    pub provider: Option<String>, pub model: Option<String>, pub progress: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildAgentStatus { Queued, Running, Done, Error, Cancelled, Unknown }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueueItem { pub id: String, pub label: String, pub state: QueueItemState }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueItemState { Queued, Admitted, Running, Cancelled }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ToolDefinition { pub id: String, pub label: String, pub enabled: bool, pub configurable: bool }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContextSource { pub id: String, pub label: String, pub kind: String, pub availability: ContextAvailability }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextAvailability { Available, Unavailable }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CurrentChatUsage {
    pub input: u64, pub output: u64, pub cache_read: u64, pub cache_write: u64,
    pub total_tokens: u64, pub cost: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RootSessionSnapshot {
    pub session_id: String, pub account_id: Option<String>, pub project_id: String, pub chat_id: String,
    pub cursor: HarnessCursor, pub state: RootSessionState, pub parent_messages: Vec<ParentMessage>,
    pub children: Vec<ChildAgentSummary>, pub queue: Vec<QueueItem>, pub tools: Vec<ToolDefinition>,
    pub resources: Vec<ContextSource>, pub usage: CurrentChatUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootSessionState { Idle, Working, Blocked, Failed, Disconnected, Stopped }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "type")]
pub enum StudioRequest { DiscoverRuntime, Bootstrap }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "type")]
pub enum StudioResponse {
    DiscoverRuntimeResult { runtime: Option<RuntimeIdentity>, compatibility: HarnessCompatibility },
    BootstrapResult { compatibility: HarnessCompatibility, sessions: Vec<RootSessionSnapshot> },
    Error { code: String, message: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "type")]
pub enum HarnessEvent {
    Snapshot { snapshot: Box<RootSessionSnapshot> },
    SessionState { #[serde(rename = "sessionId")] session_id: String, cursor: HarnessCursor, state: RootSessionState },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StudioEnvelope<T> {
    pub studio_protocol: u8,
    pub request_id: String,
    pub payload: T,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ProtocolDecodeError { DuplicateKey(String), InvalidJson(String) }

impl fmt::Display for ProtocolDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateKey(key) => write!(formatter, "duplicate JSON key: {key}"),
            Self::InvalidJson(message) => write!(formatter, "invalid JSON: {message}"),
        }
    }
}

struct ClosedJsonSeed;

impl<'de> DeserializeSeed<'de> for ClosedJsonSeed {
    type Value = ();
    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where D: Deserializer<'de> {
        deserializer.deserialize_any(ClosedJsonVisitor)
    }
}

struct ClosedJsonVisitor;

impl<'de> Visitor<'de> for ClosedJsonVisitor {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str("a JSON value without duplicate object keys") }
    fn visit_bool<E>(self, _value: bool) -> Result<(), E> { Ok(()) }
    fn visit_i64<E>(self, _value: i64) -> Result<(), E> { Ok(()) }
    fn visit_u64<E>(self, _value: u64) -> Result<(), E> { Ok(()) }
    fn visit_f64<E>(self, _value: f64) -> Result<(), E> { Ok(()) }
    fn visit_str<E>(self, _value: &str) -> Result<(), E> { Ok(()) }
    fn visit_string<E>(self, _value: String) -> Result<(), E> { Ok(()) }
    fn visit_none<E>(self) -> Result<(), E> { Ok(()) }
    fn visit_unit<E>(self) -> Result<(), E> { Ok(()) }
    fn visit_some<D>(self, deserializer: D) -> Result<(), D::Error> where D: Deserializer<'de> { deserializer.deserialize_any(ClosedJsonVisitor) }
    fn visit_seq<A>(self, mut sequence: A) -> Result<(), A::Error> where A: SeqAccess<'de> {
        while sequence.next_element_seed(ClosedJsonSeed)?.is_some() {}
        Ok(())
    }
    fn visit_map<A>(self, mut map: A) -> Result<(), A::Error> where A: MapAccess<'de> {
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) { return Err(de::Error::custom(format!("duplicate JSON key: {key}"))); }
            map.next_value_seed(ClosedJsonSeed)?;
        }
        Ok(())
    }
}

pub fn reject_duplicate_json_keys(bytes: &[u8]) -> Result<(), ProtocolDecodeError> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    ClosedJsonSeed.deserialize(&mut deserializer).map_err(|error| {
        let message = error.to_string();
        if let Some(key) = message.strip_prefix("duplicate JSON key: ").and_then(|value| value.split(" at line").next()) {
            ProtocolDecodeError::DuplicateKey(key.to_owned())
        } else {
            ProtocolDecodeError::InvalidJson(message)
        }
    })?;
    deserializer.end().map_err(|error| ProtocolDecodeError::InvalidJson(error.to_string()))
}

pub fn decode_studio_response(bytes: &[u8]) -> Result<StudioResponse, ProtocolDecodeError> {
    if bytes.len() > HARNESS_FRAME_MAX_BYTES {
        return Err(ProtocolDecodeError::InvalidJson("frame exceeds protocol limit".to_owned()));
    }
    reject_duplicate_json_keys(bytes)?;
    serde_json::from_slice(bytes).map_err(|error| ProtocolDecodeError::InvalidJson(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_fields_are_rejected_before_serde_decoding() {
        let bytes = br#"{"type":"error","code":"first","code":"second","message":"closed"}"#;
        assert_eq!(reject_duplicate_json_keys(bytes), Err(ProtocolDecodeError::DuplicateKey("code".to_owned())));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let bytes = br#"{"type":"error","code":"closed","message":"closed","extra":true}"#;
        assert!(matches!(decode_studio_response(bytes), Err(ProtocolDecodeError::InvalidJson(_))));
    }

    #[test]
    fn a_closed_error_response_round_trips() {
        let bytes = br#"{"type":"error","code":"transport_unavailable","message":"Harness unavailable"}"#;
        assert!(matches!(decode_studio_response(bytes), Ok(StudioResponse::Error { .. })));
    }
}
`;
}

export function generateHarnessContract(schema) {
  validateHarnessSchema(schema);
  const hash = createHash("sha256").update(canonicalJson(schema)).digest("hex");
  return { typescript: typescriptSource(hash), rust: rustSource(hash) };
}

async function writeOrCheck(mode) {
  const schema = await loadHarnessSchema(pathToFileURL(schemaPath));
  const generated = generateHarnessContract(schema);
  const outputs = [[typescriptPath, generated.typescript], [rustPath, generated.rust]];
  if (mode === "--write") {
    for (const [path, content] of outputs) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    return;
  }
  if (mode === "--check") {
    for (const [path, expected] of outputs) {
      const actual = await readFile(path, "utf8");
      if (actual !== expected) throw new Error(`generated contract is stale: ${path}`);
    }
    return;
  }
  throw new Error("usage: node scripts/generate-harness-contract.mjs <--write|--check>");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeOrCheck(process.argv[2]);
}
