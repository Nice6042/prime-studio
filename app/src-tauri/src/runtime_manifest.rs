//! Strict, non-activating Prime runtime compatibility manifests.
//!
//! This module deliberately has no connection to the Prime launcher. Parsing a
//! manifest is not execution authority, and this foundation rejects every
//! manifest that requests execution until a signed compatibility-set gate is
//! implemented separately.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde::de::{self, Visitor};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const MANIFEST_SCHEMA_V1: &str = "prime-studio.runtime-compatibility/v1";
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 16_384;
const MAX_CAPABILITIES: usize = 4_096;
const MAX_MANIFEST_ID_BYTES: usize = 128;
const MAX_TOKEN_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 1_024;
const SHA256_HEX_BYTES: usize = 64;
const MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_CLOSURE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 64 * 1024;
const ARTIFACT_CLOSURE_DOMAIN: &[u8] = b"prime-studio.artifact-closure/v1\0";
const CAPABILITY_SET_DOMAIN: &[u8] = b"prime-studio.capability-set/v1\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManifestErrorCode {
    TooLarge,
    Malformed,
    UnsupportedSchema,
    InvalidManifest,
    ExecutionUnsupported,
    UnidentifiedRuntime,
    UnsafePath,
    DuplicateArtifact,
    ClosureDigestMismatch,
    CapabilityDigestMismatch,
    SchemaBindingMismatch,
    MissingArtifact,
    UnexpectedArtifact,
    ArtifactSizeMismatch,
    ArtifactHashMismatch,
    AlternateDataStream,
    ReparsePoint,
    HardLinkedArtifact,
    DuplicateFileIdentity,
    FileIdentityChanged,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestError {
    code: ManifestErrorCode,
    message: String,
}

impl ManifestError {
    fn new(code: ManifestErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> ManifestErrorCode {
        self.code
    }
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManifestError {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeOwnership {
    Managed,
    External,
    Unidentified,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeIdentity {
    ownership: RuntimeOwnership,
    product: String,
    package_version: Option<String>,
    source_revision: Option<String>,
    build_revision: Option<String>,
    source_attested: bool,
    dirty: bool,
}

impl RuntimeIdentity {
    pub fn ownership(&self) -> RuntimeOwnership {
        self.ownership
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactRole {
    PrimeCliEntry,
    NodeRuntime,
    ProtocolSchema,
    ProtocolValidator,
    SecurityExtension,
    NativeWorker,
    RuntimeDependency,
    RuntimeAsset,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactBinding {
    path: String,
    role: ArtifactRole,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactClosure {
    complete: bool,
    sha256: String,
    artifacts: Vec<ArtifactBinding>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolBinding {
    profile: String,
    schema: String,
    schema_artifact: String,
    schema_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityState {
    Present,
    Absent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityBinding {
    id: String,
    state: CapabilityState,
    value: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilitySet {
    complete: bool,
    sha256: String,
    capabilities: Vec<CapabilityBinding>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompatibilityManifest {
    schema_version: String,
    manifest_id: String,
    runtime: RuntimeIdentity,
    artifact_closure: ArtifactClosure,
    protocol: Option<ProtocolBinding>,
    capability_set: CapabilitySet,
    execution_allowed: bool,
}

impl CompatibilityManifest {
    pub fn runtime(&self) -> &RuntimeIdentity {
        &self.runtime
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RequiredNullable<T> {
    Value(T),
    Null,
}

impl<T> RequiredNullable<T> {
    fn into_option(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Null => None,
        }
    }
}

#[derive(Debug)]
struct OptionalNonNull<T>(Option<T>);

impl<T> Default for OptionalNonNull<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T> OptionalNonNull<T> {
    fn into_option(self) -> Option<T> {
        self.0
    }
}

impl<'de, T> Deserialize<'de> for OptionalNonNull<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        T::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRuntimeIdentity {
    ownership: RuntimeOwnership,
    product: String,
    package_version: RequiredNullable<String>,
    source_revision: RequiredNullable<String>,
    build_revision: RequiredNullable<String>,
    source_attested: bool,
    dirty: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireArtifactBinding {
    path: String,
    role: ArtifactRole,
    size: WireArtifactSize,
    sha256: String,
}

#[derive(Debug)]
struct WireArtifactSize(u64);

impl<'de> Deserialize<'de> for WireArtifactSize {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        struct IntegerVisitor;

        impl Visitor<'_> for IntegerVisitor {
            type Value = WireArtifactSize;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-negative JSON integer")
            }

            fn visit_u64<Error>(self, value: u64) -> Result<Self::Value, Error>
            where
                Error: de::Error,
            {
                Ok(WireArtifactSize(value))
            }

            fn visit_i64<Error>(self, value: i64) -> Result<Self::Value, Error>
            where
                Error: de::Error,
            {
                u64::try_from(value)
                    .map(WireArtifactSize)
                    .map_err(|_| Error::custom("artifact size cannot be negative"))
            }

            fn visit_f64<Error>(self, value: f64) -> Result<Self::Value, Error>
            where
                Error: de::Error,
            {
                if value.is_finite()
                    && value >= 0.0
                    && value.fract() == 0.0
                    && value <= MAX_ARTIFACT_BYTES as f64
                {
                    Ok(WireArtifactSize(value as u64))
                } else {
                    Err(Error::custom(
                        "artifact size must be a bounded non-negative integer",
                    ))
                }
            }
        }

        deserializer.deserialize_any(IntegerVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireArtifactClosure {
    complete: bool,
    sha256: String,
    artifacts: Vec<WireArtifactBinding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireProtocolBinding {
    profile: String,
    schema: String,
    schema_artifact: String,
    schema_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCapabilityBinding {
    id: String,
    state: CapabilityState,
    #[serde(default)]
    value: OptionalNonNull<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCapabilitySet {
    complete: bool,
    sha256: String,
    capabilities: Vec<WireCapabilityBinding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCompatibilityManifest {
    schema_version: String,
    manifest_id: String,
    runtime: WireRuntimeIdentity,
    artifact_closure: WireArtifactClosure,
    protocol: RequiredNullable<WireProtocolBinding>,
    capability_set: WireCapabilitySet,
    #[serde(default)]
    execution_allowed: bool,
}

impl From<WireCompatibilityManifest> for CompatibilityManifest {
    fn from(wire: WireCompatibilityManifest) -> Self {
        Self {
            schema_version: wire.schema_version,
            manifest_id: wire.manifest_id,
            runtime: RuntimeIdentity {
                ownership: wire.runtime.ownership,
                product: wire.runtime.product,
                package_version: wire.runtime.package_version.into_option(),
                source_revision: wire.runtime.source_revision.into_option(),
                build_revision: wire.runtime.build_revision.into_option(),
                source_attested: wire.runtime.source_attested,
                dirty: wire.runtime.dirty,
            },
            artifact_closure: ArtifactClosure {
                complete: wire.artifact_closure.complete,
                sha256: wire.artifact_closure.sha256,
                artifacts: wire
                    .artifact_closure
                    .artifacts
                    .into_iter()
                    .map(|artifact| ArtifactBinding {
                        path: artifact.path,
                        role: artifact.role,
                        size: artifact.size.0,
                        sha256: artifact.sha256,
                    })
                    .collect(),
            },
            protocol: wire.protocol.into_option().map(|protocol| ProtocolBinding {
                profile: protocol.profile,
                schema: protocol.schema,
                schema_artifact: protocol.schema_artifact,
                schema_sha256: protocol.schema_sha256,
            }),
            capability_set: CapabilitySet {
                complete: wire.capability_set.complete,
                sha256: wire.capability_set.sha256,
                capabilities: wire
                    .capability_set
                    .capabilities
                    .into_iter()
                    .map(|capability| CapabilityBinding {
                        id: capability.id,
                        state: capability.state,
                        value: capability.value.into_option(),
                    })
                    .collect(),
            },
            execution_allowed: wire.execution_allowed,
        }
    }
}

pub struct VerifiedManifest {
    manifest: CompatibilityManifest,
    _closure_lease: VerifiedClosureLease,
}

impl fmt::Debug for VerifiedManifest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedManifest")
            .field("runtime_ownership", &self.manifest.runtime.ownership)
            .field(
                "artifact_count",
                &self.manifest.artifact_closure.artifacts.len(),
            )
            .field("execution_allowed", &false)
            .finish()
    }
}

impl VerifiedManifest {
    pub fn runtime_ownership(&self) -> RuntimeOwnership {
        self.manifest.runtime.ownership
    }

    pub fn artifact_count(&self) -> usize {
        self.manifest.artifact_closure.artifacts.len()
    }

    /// This Phase 0 foundation never grants execution. A later signed
    /// compatibility-set verifier must be a separate, explicit gate.
    pub fn execution_allowed(&self) -> bool {
        false
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<CompatibilityManifest, ManifestError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestError::new(
            ManifestErrorCode::TooLarge,
            format!("runtime compatibility manifest exceeds the {MAX_MANIFEST_BYTES}-byte limit"),
        ));
    }

    let wire: WireCompatibilityManifest = serde_json::from_slice(bytes).map_err(|error| {
        ManifestError::new(
            ManifestErrorCode::Malformed,
            format!("runtime compatibility manifest is malformed: {error}"),
        )
    })?;
    let manifest = CompatibilityManifest::from(wire);
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Verify every byte in a complete, identified runtime closure.
///
/// `runtime_root` is selected by the caller; artifact paths in the manifest are
/// canonical and bundle-relative. This function does not launch, probe, update,
/// or otherwise activate the runtime.
pub fn verify_manifest(
    manifest: CompatibilityManifest,
    runtime_root: &Path,
) -> Result<VerifiedManifest, ManifestError> {
    validate_manifest(&manifest)?;
    verify_record_digests(&manifest)?;
    if manifest.runtime.ownership == RuntimeOwnership::Unidentified {
        return Err(invalid(
            ManifestErrorCode::UnidentifiedRuntime,
            "an unidentified runtime is never a supported execution closure",
        ));
    }

    verify_schema_binding(&manifest)?;
    let closure_lease = verify_artifact_files(&manifest.artifact_closure, runtime_root)?;

    Ok(VerifiedManifest {
        manifest,
        _closure_lease: closure_lease,
    })
}

fn validate_manifest(manifest: &CompatibilityManifest) -> Result<(), ManifestError> {
    if manifest.schema_version != MANIFEST_SCHEMA_V1 {
        return Err(invalid(
            ManifestErrorCode::UnsupportedSchema,
            "runtime compatibility manifest uses an unsupported schema",
        ));
    }
    if manifest.execution_allowed {
        return Err(invalid(
            ManifestErrorCode::ExecutionUnsupported,
            "this compatibility-manifest foundation cannot authorize execution",
        ));
    }
    require_identifier(
        "manifestId",
        &manifest.manifest_id,
        MAX_MANIFEST_ID_BYTES,
        is_identifier_byte,
    )?;
    validate_runtime(&manifest.runtime)?;
    validate_artifact_closure(&manifest.artifact_closure)?;
    validate_capability_set(&manifest.capability_set)?;
    if manifest.artifact_closure.complete {
        require_supported_runtime_roles(&manifest.artifact_closure)?;
    }

    if let Some(protocol) = &manifest.protocol {
        require_token("protocol.profile", &protocol.profile)?;
        require_token("protocol.schema", &protocol.schema)?;
        require_manifest_path("protocol.schemaArtifact", &protocol.schema_artifact)?;
        require_sha256("protocol.schemaSha256", &protocol.schema_sha256)?;
    }

    if matches!(
        manifest.runtime.ownership,
        RuntimeOwnership::Managed | RuntimeOwnership::External
    ) {
        if !manifest.artifact_closure.complete {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "managed and external runtimes require a complete artifact closure",
            ));
        }
        if !manifest.capability_set.complete {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "managed and external runtimes require a complete capability set",
            ));
        }
        if manifest.protocol.is_none() {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "managed and external runtimes require a protocol binding",
            ));
        }
        if manifest.runtime.dirty
            || manifest.runtime.package_version.is_none()
            || manifest.runtime.source_revision.is_none()
            || manifest.runtime.build_revision.is_none()
            || !manifest.runtime.source_attested
        {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "managed and external runtimes require clean, source-attested package and build provenance",
            ));
        }
    }
    Ok(())
}

fn require_supported_runtime_roles(closure: &ArtifactClosure) -> Result<(), ManifestError> {
    for (role, expected) in [
        (ArtifactRole::PrimeCliEntry, "one Prime CLI entry"),
        (ArtifactRole::NodeRuntime, "one Node runtime"),
    ] {
        if closure
            .artifacts
            .iter()
            .filter(|artifact| artifact.role == role)
            .count()
            != 1
        {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                format!("a supported Prime closure requires exactly {expected}"),
            ));
        }
    }
    for (role, expected) in [
        (ArtifactRole::ProtocolSchema, "a protocol schema"),
        (ArtifactRole::ProtocolValidator, "a protocol validator"),
    ] {
        if !closure
            .artifacts
            .iter()
            .any(|artifact| artifact.role == role)
        {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                format!("a supported Prime closure requires {expected}"),
            ));
        }
    }
    Ok(())
}

fn validate_runtime(runtime: &RuntimeIdentity) -> Result<(), ManifestError> {
    require_identifier(
        "runtime.product",
        &runtime.product,
        MAX_TOKEN_BYTES,
        |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-'),
    )?;
    if runtime.product != "prime-agent" {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            "runtime.product must be prime-agent for this schema",
        ));
    }
    if let Some(package_version) = &runtime.package_version {
        require_printable("runtime.packageVersion", package_version, MAX_TOKEN_BYTES)?;
    }
    for (name, revision) in [
        ("runtime.sourceRevision", runtime.source_revision.as_deref()),
        ("runtime.buildRevision", runtime.build_revision.as_deref()),
    ] {
        if let Some(revision) = revision {
            if !matches!(revision.len(), 40 | 64)
                || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
                || revision.bytes().any(|byte| byte.is_ascii_uppercase())
            {
                return Err(invalid(
                    ManifestErrorCode::InvalidManifest,
                    format!("{name} must be a canonical lowercase 40- or 64-digit hex revision"),
                ));
            }
        }
    }
    if runtime.source_attested && runtime.source_revision.is_none() {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            "sourceAttested requires sourceRevision",
        ));
    }
    if runtime.source_attested && runtime.dirty {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            "a dirty runtime cannot claim source attestation",
        ));
    }
    Ok(())
}

fn validate_artifact_closure(closure: &ArtifactClosure) -> Result<(), ManifestError> {
    require_sha256("artifactClosure.sha256", &closure.sha256)?;
    if closure.artifacts.len() > MAX_ARTIFACTS {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            format!("artifact closure exceeds {MAX_ARTIFACTS} entries"),
        ));
    }
    if closure.complete && closure.artifacts.is_empty() {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            "a complete artifact closure cannot be empty",
        ));
    }

    let mut paths = HashSet::with_capacity(closure.artifacts.len());
    let mut closure_bytes = 0u64;
    let mut previous_path: Option<&str> = None;
    for artifact in &closure.artifacts {
        require_manifest_path("artifact.path", &artifact.path)?;
        require_sha256("artifact.sha256", &artifact.sha256)?;
        if artifact.size > MAX_ARTIFACT_BYTES {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                format!("artifact size exceeds the {MAX_ARTIFACT_BYTES}-byte verification limit"),
            ));
        }
        closure_bytes = closure_bytes.checked_add(artifact.size).ok_or_else(|| {
            invalid(
                ManifestErrorCode::InvalidManifest,
                "artifact closure byte length overflows",
            )
        })?;
        if closure_bytes > MAX_CLOSURE_BYTES {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                format!("artifact closure exceeds the {MAX_CLOSURE_BYTES}-byte verification limit"),
            ));
        }
        if !paths.insert(artifact.path.to_ascii_lowercase()) {
            return Err(invalid(
                ManifestErrorCode::DuplicateArtifact,
                "artifact closure contains a duplicate Windows path",
            ));
        }
        if previous_path.is_some_and(|previous| previous >= artifact.path.as_str()) {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "artifact closure entries must be sorted by canonical path",
            ));
        }
        previous_path = Some(&artifact.path);
    }
    Ok(())
}

fn validate_capability_set(set: &CapabilitySet) -> Result<(), ManifestError> {
    require_sha256("capabilitySet.sha256", &set.sha256)?;
    if set.capabilities.len() > MAX_CAPABILITIES {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            format!("capability set exceeds {MAX_CAPABILITIES} entries"),
        ));
    }
    if set.complete && set.capabilities.is_empty() {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            "a complete capability set cannot be empty",
        ));
    }

    let mut identifiers = HashSet::with_capacity(set.capabilities.len());
    let mut previous_identifier: Option<&str> = None;
    for capability in &set.capabilities {
        require_identifier("capability.id", &capability.id, MAX_TOKEN_BYTES, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })?;
        if !identifiers.insert(capability.id.to_ascii_lowercase()) {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "capability set contains a duplicate identifier",
            ));
        }
        if previous_identifier.is_some_and(|previous| previous >= capability.id.as_str()) {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "capability entries must be sorted by canonical identifier",
            ));
        }
        previous_identifier = Some(&capability.id);
        if let Some(value) = &capability.value {
            require_printable("capability.value", value, MAX_TOKEN_BYTES)?;
        }
        if capability.state == CapabilityState::Absent && capability.value.is_some() {
            return Err(invalid(
                ManifestErrorCode::InvalidManifest,
                "an absent capability cannot carry a value",
            ));
        }
    }
    Ok(())
}

fn require_sha256(name: &str, value: &str) -> Result<(), ManifestError> {
    if value.len() != SHA256_HEX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            format!("{name} must be 64 lowercase hexadecimal digits"),
        ));
    }
    Ok(())
}

fn require_token(name: &str, value: &str) -> Result<(), ManifestError> {
    require_identifier(name, value, MAX_TOKEN_BYTES, |byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'.' | b'-' | b'/' | b'_')
    })
}

fn require_identifier(
    name: &str,
    value: &str,
    maximum: usize,
    allowed: impl Fn(u8) -> bool,
) -> Result<(), ManifestError> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > maximum
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes.iter().copied().all(allowed)
    {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            format!("{name} is not a canonical identifier"),
        ));
    }
    Ok(())
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
}

fn require_printable(name: &str, value: &str, maximum: usize) -> Result<(), ManifestError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().all(|byte| matches!(byte, b' '..=b'~'))
    {
        return Err(invalid(
            ManifestErrorCode::InvalidManifest,
            format!("{name} is empty, too long, or contains unsafe control text"),
        ));
    }
    Ok(())
}

fn require_manifest_path(name: &str, value: &str) -> Result<(), ManifestError> {
    require_printable(name, value, MAX_PATH_BYTES)?;
    if !value.is_ascii()
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value
            .bytes()
            .any(|byte| matches!(byte, b'<' | b'>' | b'"' | b'|' | b'?' | b'*'))
        || value.split('/').any(unsafe_windows_segment)
    {
        return Err(invalid(
            ManifestErrorCode::UnsafePath,
            format!("{name} must be a canonical bundle-relative path"),
        ));
    }
    Ok(())
}

fn unsafe_windows_segment(segment: &str) -> bool {
    if segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.ends_with([' ', '.'])
        || segment.len() > 255
    {
        return true;
    }
    let base = segment.split('.').next().unwrap_or(segment);
    let upper = base.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) || (upper.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && upper.as_bytes()[3].is_ascii_digit())
}

fn verify_record_digests(manifest: &CompatibilityManifest) -> Result<(), ManifestError> {
    let closure_digest = artifact_closure_digest(&manifest.artifact_closure.artifacts)?;
    if closure_digest != manifest.artifact_closure.sha256 {
        return Err(invalid(
            ManifestErrorCode::ClosureDigestMismatch,
            "artifact closure record digest does not match its entries",
        ));
    }

    let capability_digest = capability_set_digest(&manifest.capability_set.capabilities)?;
    if capability_digest != manifest.capability_set.sha256 {
        return Err(invalid(
            ManifestErrorCode::CapabilityDigestMismatch,
            "capability set digest does not match its entries",
        ));
    }
    Ok(())
}

fn artifact_closure_digest(artifacts: &[ArtifactBinding]) -> Result<String, ManifestError> {
    let mut hasher = Sha256::new();
    hasher.update(ARTIFACT_CLOSURE_DOMAIN);
    hash_count(&mut hasher, artifacts.len())?;
    for artifact in artifacts {
        hash_frame(&mut hasher, artifact.path.as_bytes())?;
        hash_frame(&mut hasher, artifact.role.as_str().as_bytes())?;
        hasher.update(artifact.size.to_be_bytes());
        hash_frame(&mut hasher, artifact.sha256.as_bytes())?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn capability_set_digest(capabilities: &[CapabilityBinding]) -> Result<String, ManifestError> {
    let mut hasher = Sha256::new();
    hasher.update(CAPABILITY_SET_DOMAIN);
    hash_count(&mut hasher, capabilities.len())?;
    for capability in capabilities {
        hash_frame(&mut hasher, capability.id.as_bytes())?;
        hash_frame(&mut hasher, capability.state.as_str().as_bytes())?;
        match capability.value.as_deref() {
            Some(value) => {
                hasher.update([1]);
                hash_frame(&mut hasher, value.as_bytes())?;
            }
            None => hasher.update([0]),
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_count(hasher: &mut Sha256, count: usize) -> Result<(), ManifestError> {
    let count = u32::try_from(count).map_err(|_| {
        invalid(
            ManifestErrorCode::InvalidManifest,
            "manifest record count exceeds canonical digest framing",
        )
    })?;
    hasher.update(count.to_be_bytes());
    Ok(())
}

fn hash_frame(hasher: &mut Sha256, bytes: &[u8]) -> Result<(), ManifestError> {
    let length = u32::try_from(bytes.len()).map_err(|_| {
        invalid(
            ManifestErrorCode::InvalidManifest,
            "manifest field exceeds canonical digest framing",
        )
    })?;
    hasher.update(length.to_be_bytes());
    hasher.update(bytes);
    Ok(())
}

impl ArtifactRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::PrimeCliEntry => "prime-cli-entry",
            Self::NodeRuntime => "node-runtime",
            Self::ProtocolSchema => "protocol-schema",
            Self::ProtocolValidator => "protocol-validator",
            Self::SecurityExtension => "security-extension",
            Self::NativeWorker => "native-worker",
            Self::RuntimeDependency => "runtime-dependency",
            Self::RuntimeAsset => "runtime-asset",
        }
    }
}

impl CapabilityState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Absent => "absent",
        }
    }
}

fn verify_schema_binding(manifest: &CompatibilityManifest) -> Result<(), ManifestError> {
    let protocol = manifest.protocol.as_ref().ok_or_else(|| {
        invalid(
            ManifestErrorCode::SchemaBindingMismatch,
            "verified runtimes require a protocol schema binding",
        )
    })?;
    let artifact = manifest
        .artifact_closure
        .artifacts
        .iter()
        .find(|artifact| artifact.path == protocol.schema_artifact)
        .ok_or_else(|| {
            invalid(
                ManifestErrorCode::SchemaBindingMismatch,
                "protocol schema artifact is absent from the runtime closure",
            )
        })?;
    if artifact.role != ArtifactRole::ProtocolSchema || artifact.sha256 != protocol.schema_sha256 {
        return Err(invalid(
            ManifestErrorCode::SchemaBindingMismatch,
            "protocol schema path, role, and hash must bind one closure artifact",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FileIdentity {
    volume: u64,
    file: [u8; 16],
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileSnapshot {
    identity: FileIdentity,
    reparse_point: bool,
    directory: bool,
    hard_links: u32,
    size: u64,
    last_write_time: i64,
    change_time: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VerificationPhase {
    RootInspected,
    TreeEnumerated,
    DirectoriesLocked,
    ArtifactsLocked,
    HashingComplete,
    FinalTreeChecked,
}

#[derive(Debug, Eq, PartialEq)]
struct RuntimeTree {
    directories: Vec<RuntimeTreeEntry>,
    files: Vec<RuntimeTreeEntry>,
}

#[derive(Debug, Eq, PartialEq)]
struct RuntimeTreeEntry {
    path: String,
    snapshot: FileSnapshot,
}

struct LockedDirectory {
    relative: String,
    target: PathBuf,
    snapshot: FileSnapshot,
    file: File,
}

struct LockedArtifact<'manifest> {
    binding: &'manifest ArtifactBinding,
    target: PathBuf,
    snapshot: FileSnapshot,
    file: File,
}

struct VerifiedClosureLease {
    _root: File,
    _directories: Vec<File>,
    _artifacts: Vec<File>,
}

impl fmt::Debug for VerifiedClosureLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedClosureLease")
            .field("directory_count", &self._directories.len())
            .field("artifact_count", &self._artifacts.len())
            .finish_non_exhaustive()
    }
}

fn verify_artifact_files(
    closure: &ArtifactClosure,
    root: &Path,
) -> Result<VerifiedClosureLease, ManifestError> {
    verify_artifact_files_with_hook(closure, root, |_| {})
}

fn verify_artifact_files_with_hook(
    closure: &ArtifactClosure,
    root: &Path,
    mut hook: impl FnMut(VerificationPhase),
) -> Result<VerifiedClosureLease, ManifestError> {
    if !root.is_absolute() {
        return Err(invalid(
            ManifestErrorCode::UnsafePath,
            "runtime root must be an absolute path selected by the caller",
        ));
    }
    ensure_no_reparse_components(root)?;
    let root_snapshot = path_snapshot_no_follow(root)
        .map_err(io_error)?
        .ok_or_else(|| {
            invalid(
                ManifestErrorCode::MissingArtifact,
                "runtime root does not exist",
            )
        })?;
    if root_snapshot.reparse_point {
        return Err(invalid(
            ManifestErrorCode::ReparsePoint,
            "runtime root is a reparse point",
        ));
    }
    if !root_snapshot.directory {
        return Err(invalid(
            ManifestErrorCode::UnsafePath,
            "runtime root is not a directory",
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(io_error)?;
    hook(VerificationPhase::RootInspected);

    let locked_root = open_locked_path(root, true).map_err(io_error)?;
    let opened_root = opened_file_snapshot(&locked_root).map_err(io_error)?;
    if opened_root != root_snapshot {
        return Err(invalid(
            ManifestErrorCode::FileIdentityChanged,
            "runtime root changed identity while its verification lock was acquired",
        ));
    }
    verify_opened_final_path(&locked_root, &canonical_root, "")?;
    ensure_only_default_data_stream(root)?;

    let initial_tree = enumerate_runtime_tree(root)?;
    validate_observed_tree(closure, &initial_tree)?;
    hook(VerificationPhase::TreeEnumerated);

    let mut locked_directories = Vec::with_capacity(initial_tree.directories.len());
    for observed in &initial_tree.directories {
        let relative = &observed.path;
        let target = join_manifest_path(root, relative)?;
        let before = path_snapshot_no_follow(&target)
            .map_err(io_error)?
            .ok_or_else(|| {
                invalid(
                    ManifestErrorCode::FileIdentityChanged,
                    format!("runtime directory `{relative}` disappeared while locking the tree"),
                )
            })?;
        if before != observed.snapshot || before.reparse_point || !before.directory {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!("runtime directory `{relative}` changed after tree enumeration"),
            ));
        }
        let file = open_locked_path(&target, true).map_err(io_error)?;
        let opened = opened_file_snapshot(&file).map_err(io_error)?;
        if opened != before {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!("runtime directory `{relative}` changed while locking the tree"),
            ));
        }
        verify_opened_final_path(&file, &canonical_root, relative)?;
        ensure_only_default_data_stream(&target)?;
        locked_directories.push(LockedDirectory {
            relative: relative.clone(),
            target,
            snapshot: before,
            file,
        });
    }
    hook(VerificationPhase::DirectoriesLocked);
    ensure_runtime_tree_unchanged(root, &initial_tree)?;

    let mut identities = HashSet::with_capacity(closure.artifacts.len());
    let mut locked_artifacts = Vec::with_capacity(closure.artifacts.len());
    for artifact in &closure.artifacts {
        let target = join_manifest_path(root, &artifact.path)?;
        let before = path_snapshot_no_follow(&target)
            .map_err(io_error)?
            .ok_or_else(|| {
                invalid(
                    ManifestErrorCode::MissingArtifact,
                    format!("runtime artifact `{}` is missing", artifact.path),
                )
            })?;
        let enumerated = initial_tree
            .files
            .iter()
            .find(|observed| observed.path == artifact.path)
            .ok_or_else(|| {
                invalid(
                    ManifestErrorCode::MissingArtifact,
                    format!("runtime artifact `{}` was not enumerated", artifact.path),
                )
            })?;
        if before != enumerated.snapshot {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!(
                    "runtime artifact `{}` changed after tree enumeration",
                    artifact.path
                ),
            ));
        }
        if before.reparse_point {
            return Err(invalid(
                ManifestErrorCode::ReparsePoint,
                format!("runtime artifact `{}` is a reparse point", artifact.path),
            ));
        }
        if before.directory {
            return Err(invalid(
                ManifestErrorCode::UnexpectedArtifact,
                format!("runtime artifact `{}` is not a regular file", artifact.path),
            ));
        }
        if before.hard_links != 1 {
            return Err(invalid(
                ManifestErrorCode::HardLinkedArtifact,
                format!("runtime artifact `{}` has a hardlink alias", artifact.path),
            ));
        }
        if !identities.insert(before.identity) {
            return Err(invalid(
                ManifestErrorCode::DuplicateFileIdentity,
                "multiple artifact paths resolve to one file identity",
            ));
        }

        ensure_only_default_data_stream(&target)?;
        let file =
            open_locked_path(&target, false).map_err(|error| file_open_error(error, artifact))?;
        let opened = opened_file_snapshot(&file).map_err(io_error)?;
        if opened.reparse_point {
            return Err(invalid(
                ManifestErrorCode::ReparsePoint,
                format!(
                    "runtime artifact `{}` opened through a reparse point",
                    artifact.path
                ),
            ));
        }
        if opened.identity != before.identity {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!(
                    "runtime artifact `{}` changed identity while opening",
                    artifact.path
                ),
            ));
        }
        if opened.hard_links != 1 {
            return Err(invalid(
                ManifestErrorCode::HardLinkedArtifact,
                format!("runtime artifact `{}` has a hardlink alias", artifact.path),
            ));
        }
        verify_opened_final_path(&file, &canonical_root, &artifact.path)?;

        if opened_size(&file).map_err(io_error)? != artifact.size {
            return Err(invalid(
                ManifestErrorCode::ArtifactSizeMismatch,
                format!(
                    "runtime artifact `{}` has the wrong byte length",
                    artifact.path
                ),
            ));
        }
        locked_artifacts.push(LockedArtifact {
            binding: artifact,
            target,
            snapshot: before,
            file,
        });
    }
    hook(VerificationPhase::ArtifactsLocked);
    ensure_runtime_tree_unchanged(root, &initial_tree)?;

    for artifact in &mut locked_artifacts {
        let (size, digest) = hash_opened_file(&mut artifact.file).map_err(io_error)?;
        if size != artifact.binding.size {
            return Err(invalid(
                ManifestErrorCode::ArtifactSizeMismatch,
                format!(
                    "runtime artifact `{}` changed length while hashing",
                    artifact.binding.path
                ),
            ));
        }
        if digest != artifact.binding.sha256 {
            return Err(invalid(
                ManifestErrorCode::ArtifactHashMismatch,
                format!(
                    "runtime artifact `{}` has the wrong SHA-256",
                    artifact.binding.path
                ),
            ));
        }

        let after = path_snapshot_no_follow(&artifact.target)
            .map_err(io_error)?
            .ok_or_else(|| {
                invalid(
                    ManifestErrorCode::FileIdentityChanged,
                    format!(
                        "runtime artifact `{}` disappeared while hashing",
                        artifact.binding.path
                    ),
                )
            })?;
        let opened_after = opened_file_snapshot(&artifact.file).map_err(io_error)?;
        if after != artifact.snapshot || opened_after != artifact.snapshot {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!(
                    "runtime artifact `{}` changed identity while hashing",
                    artifact.binding.path
                ),
            ));
        }
        verify_opened_final_path(&artifact.file, &canonical_root, &artifact.binding.path)?;
        ensure_only_default_data_stream(&artifact.target)?;
    }

    hook(VerificationPhase::HashingComplete);
    ensure_runtime_tree_unchanged(root, &initial_tree)?;
    hook(VerificationPhase::FinalTreeChecked);
    verify_locked_directory(&locked_root, root, &root_snapshot, &canonical_root, "")?;
    for directory in &locked_directories {
        verify_locked_directory(
            &directory.file,
            &directory.target,
            &directory.snapshot,
            &canonical_root,
            &directory.relative,
        )?;
    }
    for artifact in &locked_artifacts {
        ensure_only_default_data_stream(&artifact.target)?;
        let named = path_snapshot_no_follow(&artifact.target)
            .map_err(io_error)?
            .ok_or_else(|| {
                invalid(
                    ManifestErrorCode::FileIdentityChanged,
                    format!(
                        "runtime artifact `{}` disappeared after final enumeration",
                        artifact.binding.path
                    ),
                )
            })?;
        let opened = opened_file_snapshot(&artifact.file).map_err(io_error)?;
        if named != artifact.snapshot || opened != artifact.snapshot {
            return Err(invalid(
                ManifestErrorCode::FileIdentityChanged,
                format!(
                    "runtime artifact `{}` changed after final enumeration",
                    artifact.binding.path
                ),
            ));
        }
        verify_opened_final_path(&artifact.file, &canonical_root, &artifact.binding.path)?;
    }
    Ok(VerifiedClosureLease {
        _root: locked_root,
        _directories: locked_directories
            .into_iter()
            .map(|directory| directory.file)
            .collect(),
        _artifacts: locked_artifacts
            .into_iter()
            .map(|artifact| artifact.file)
            .collect(),
    })
}

fn validate_observed_tree(
    closure: &ArtifactClosure,
    observed_tree: &RuntimeTree,
) -> Result<(), ManifestError> {
    let expected_paths: HashMap<String, &ArtifactBinding> = closure
        .artifacts
        .iter()
        .map(|artifact| (artifact.path.to_ascii_lowercase(), artifact))
        .collect();
    for observed in &observed_tree.files {
        match expected_paths.get(&observed.path.to_ascii_lowercase()) {
            Some(artifact) if artifact.path == observed.path => {}
            Some(_) => {
                return Err(invalid(
                    ManifestErrorCode::UnsafePath,
                    "runtime artifact path casing is not canonical",
                ));
            }
            None => {
                return Err(invalid(
                    ManifestErrorCode::UnexpectedArtifact,
                    format!(
                        "complete runtime closure contains unlisted artifact `{}`",
                        observed.path
                    ),
                ));
            }
        }
    }

    let mut expected_directories = HashMap::new();
    for artifact in &closure.artifacts {
        let segments: Vec<&str> = artifact.path.split('/').collect();
        let mut relative = String::new();
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            if !relative.is_empty() {
                relative.push('/');
            }
            relative.push_str(segment);
            expected_directories.insert(relative.to_ascii_lowercase(), relative.clone());
        }
    }
    for observed in &observed_tree.directories {
        match expected_directories.get(&observed.path.to_ascii_lowercase()) {
            Some(expected) if *expected == observed.path => {}
            Some(_) => {
                return Err(invalid(
                    ManifestErrorCode::UnsafePath,
                    "runtime directory path casing is not canonical",
                ));
            }
            None => {
                return Err(invalid(
                    ManifestErrorCode::UnexpectedArtifact,
                    format!(
                        "complete runtime closure contains unlisted directory `{}`",
                        observed.path
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn ensure_runtime_tree_unchanged(root: &Path, initial: &RuntimeTree) -> Result<(), ManifestError> {
    if enumerate_runtime_tree(root)? != *initial {
        return Err(invalid(
            ManifestErrorCode::FileIdentityChanged,
            "runtime closure tree changed during verification",
        ));
    }
    Ok(())
}

fn verify_locked_directory(
    file: &File,
    target: &Path,
    expected: &FileSnapshot,
    canonical_root: &Path,
    relative: &str,
) -> Result<(), ManifestError> {
    ensure_only_default_data_stream(target)?;
    let opened = opened_file_snapshot(file).map_err(io_error)?;
    let named = path_snapshot_no_follow(target)
        .map_err(io_error)?
        .ok_or_else(|| {
            invalid(
                ManifestErrorCode::FileIdentityChanged,
                "a locked runtime directory disappeared during verification",
            )
        })?;
    if opened != *expected || named != *expected {
        return Err(invalid(
            ManifestErrorCode::FileIdentityChanged,
            "a locked runtime directory changed during verification",
        ));
    }
    verify_opened_final_path(file, canonical_root, relative)
}

fn file_open_error(error: io::Error, artifact: &ArtifactBinding) -> ManifestError {
    let code = if error.kind() == io::ErrorKind::NotFound {
        ManifestErrorCode::MissingArtifact
    } else {
        ManifestErrorCode::Io
    };
    invalid(
        code,
        format!("runtime artifact `{}` could not be opened", artifact.path),
    )
}

fn enumerate_runtime_tree(root: &Path) -> Result<RuntimeTree, ManifestError> {
    let mut directories = vec![root.to_path_buf()];
    let mut relative_directories = Vec::new();
    let mut files = Vec::new();
    let mut entries = 0usize;
    while let Some(directory) = directories.pop() {
        let children = fs::read_dir(&directory).map_err(io_error)?;
        for child in children {
            let child = child.map_err(io_error)?;
            entries = entries.checked_add(1).ok_or_else(|| {
                invalid(
                    ManifestErrorCode::InvalidManifest,
                    "runtime closure entry count overflows",
                )
            })?;
            if entries > MAX_ARTIFACTS.saturating_mul(4) {
                return Err(invalid(
                    ManifestErrorCode::InvalidManifest,
                    "runtime closure tree exceeds the bounded entry count",
                ));
            }
            let path = child.path();
            let snapshot = path_snapshot_no_follow(&path)
                .map_err(io_error)?
                .ok_or_else(|| {
                    invalid(
                        ManifestErrorCode::FileIdentityChanged,
                        "runtime closure entry disappeared during enumeration",
                    )
                })?;
            if snapshot.reparse_point {
                return Err(invalid(
                    ManifestErrorCode::ReparsePoint,
                    "runtime closure contains a reparse point",
                ));
            }
            if snapshot.directory {
                let relative = path.strip_prefix(root).map_err(|_| {
                    invalid(
                        ManifestErrorCode::UnsafePath,
                        "runtime closure directory escaped its selected root",
                    )
                })?;
                relative_directories.push(RuntimeTreeEntry {
                    path: path_to_manifest_string(relative)?,
                    snapshot,
                });
                directories.push(path);
            } else {
                let relative = path.strip_prefix(root).map_err(|_| {
                    invalid(
                        ManifestErrorCode::UnsafePath,
                        "runtime closure entry escaped its selected root",
                    )
                })?;
                files.push(RuntimeTreeEntry {
                    path: path_to_manifest_string(relative)?,
                    snapshot,
                });
            }
        }
    }
    relative_directories.sort_by(|left, right| left.path.cmp(&right.path));
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(RuntimeTree {
        directories: relative_directories,
        files,
    })
}

fn path_to_manifest_string(path: &Path) -> Result<String, ManifestError> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_str().ok_or_else(|| {
                    invalid(
                        ManifestErrorCode::UnsafePath,
                        "runtime closure contains a non-Unicode path",
                    )
                })?;
                segments.push(segment);
            }
            _ => {
                return Err(invalid(
                    ManifestErrorCode::UnsafePath,
                    "runtime closure contains a non-relative path component",
                ));
            }
        }
    }
    let value = segments.join("/");
    require_manifest_path("runtime artifact path", &value)?;
    Ok(value)
}

fn join_manifest_path(root: &Path, relative: &str) -> Result<PathBuf, ManifestError> {
    require_manifest_path("artifact.path", relative)?;
    let mut target = root.to_path_buf();
    for segment in relative.split('/') {
        target.push(segment);
    }
    ensure_no_reparse_components(&target)?;
    Ok(target)
}

fn ensure_no_reparse_components(path: &Path) -> Result<(), ManifestError> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match path_snapshot_no_follow(ancestor) {
            Ok(Some(snapshot)) if snapshot.reparse_point => {
                return Err(invalid(
                    ManifestErrorCode::ReparsePoint,
                    "runtime path crosses a reparse boundary",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn hash_opened_file(file: &mut File) -> io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; HASH_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| io::Error::other("artifact byte count overflow"))?;
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn opened_size(file: &File) -> io::Result<u64> {
    file.metadata().map(|metadata| metadata.len())
}

fn io_error(_error: io::Error) -> ManifestError {
    invalid(
        ManifestErrorCode::Io,
        "runtime closure could not be inspected safely",
    )
}

#[cfg(windows)]
fn open_locked_path(path: &Path, directory: bool) -> io::Result<File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_SEQUENTIAL_SCAN, FILE_GENERIC_READ, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let desired_access = if directory {
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES
    } else {
        FILE_GENERIC_READ
    };
    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if directory {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    } else {
        flags |= FILE_FLAG_SEQUENTIAL_SCAN;
    }
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired_access,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[cfg(unix)]
fn open_locked_path(path: &Path, _directory: bool) -> io::Result<File> {
    File::open(path)
}

#[cfg(windows)]
fn ensure_only_default_data_stream(path: &Path) -> Result<(), ManifestError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{
        ERROR_HANDLE_EOF, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard,
        WIN32_FIND_STREAM_DATA,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut data = WIN32_FIND_STREAM_DATA::default();
    let handle = unsafe {
        FindFirstStreamW(
            wide.as_ptr(),
            FindStreamInfoStandard,
            (&mut data as *mut WIN32_FIND_STREAM_DATA).cast(),
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_HANDLE_EOF) | Some(ERROR_NO_MORE_FILES) => Ok(()),
            _ => Err(io_error(error)),
        };
    }

    let result = loop {
        let length = data
            .cStreamName
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(data.cStreamName.len());
        let stream = String::from_utf16_lossy(&data.cStreamName[..length]);
        if stream != "::$DATA" {
            break Err(invalid(
                ManifestErrorCode::AlternateDataStream,
                "runtime artifact contains an unlisted alternate data stream",
            ));
        }

        if unsafe { FindNextStreamW(handle, (&mut data as *mut WIN32_FIND_STREAM_DATA).cast()) }
            == 0
        {
            let error = io::Error::last_os_error();
            match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_HANDLE_EOF) | Some(ERROR_NO_MORE_FILES) => break Ok(()),
                _ => break Err(io_error(error)),
            }
        }
    };
    unsafe {
        FindClose(handle);
    }
    result
}

#[cfg(unix)]
fn ensure_only_default_data_stream(_path: &Path) -> Result<(), ManifestError> {
    Ok(())
}

#[cfg(windows)]
fn path_snapshot_no_follow(path: &Path) -> io::Result<Option<FileSnapshot>> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let result = windows_snapshot_from_handle(handle);
    unsafe {
        CloseHandle(handle);
    }
    result.map(Some)
}

#[cfg(windows)]
fn windows_snapshot_from_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<FileSnapshot> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_BASIC_INFO, FILE_ID_INFO,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut basic = FILE_BASIC_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            u32::try_from(std::mem::size_of::<FILE_BASIC_INFO>())
                .expect("FILE_BASIC_INFO size fits in u32"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut file_id = FILE_ID_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut file_id as *mut FILE_ID_INFO).cast(),
            u32::try_from(std::mem::size_of::<FILE_ID_INFO>())
                .expect("FILE_ID_INFO size fits in u32"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(FileSnapshot {
        identity: FileIdentity {
            volume: file_id.VolumeSerialNumber,
            file: file_id.FileId.Identifier,
        },
        reparse_point: information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        directory: information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        hard_links: information.nNumberOfLinks,
        size: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        last_write_time: basic.LastWriteTime,
        change_time: basic.ChangeTime,
    })
}

#[cfg(windows)]
fn opened_file_snapshot(file: &File) -> io::Result<FileSnapshot> {
    use std::os::windows::io::AsRawHandle;

    windows_snapshot_from_handle(file.as_raw_handle())
}

#[cfg(windows)]
fn verify_opened_final_path(
    file: &File,
    canonical_root: &Path,
    relative: &str,
) -> Result<(), ManifestError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let handle = file.as_raw_handle();
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    let required = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, flags) };
    if required == 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(io_error(io::Error::last_os_error()));
    }
    let opened = PathBuf::from(OsString::from_wide(&buffer[..written as usize]));
    let expected = join_without_inspection(canonical_root, relative);
    if comparable_windows_path(&opened) != comparable_windows_path(&expected) {
        return Err(invalid(
            ManifestErrorCode::ReparsePoint,
            "opened runtime artifact resolved through an unexpected alias",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn comparable_windows_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{unc}");
    } else if let Some(dos) = value.strip_prefix(r"\\?\") {
        value = dos.to_owned();
    }
    value.trim_end_matches('\\').to_ascii_lowercase()
}

fn join_without_inspection(root: &Path, relative: &str) -> PathBuf {
    let mut target = root.to_path_buf();
    for segment in relative.split('/') {
        target.push(segment);
    }
    target
}

#[cfg(unix)]
fn path_snapshot_no_follow(path: &Path) -> io::Result<Option<FileSnapshot>> {
    use std::os::unix::fs::MetadataExt;

    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(FileSnapshot {
            identity: FileIdentity {
                volume: metadata.dev(),
                file: u128::from(metadata.ino()).to_le_bytes(),
            },
            reparse_point: metadata.file_type().is_symlink(),
            directory: metadata.is_dir(),
            hard_links: metadata.nlink().try_into().unwrap_or(u32::MAX),
            size: metadata.len(),
            last_write_time: metadata.mtime(),
            change_time: metadata.ctime(),
        })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn opened_file_snapshot(file: &File) -> io::Result<FileSnapshot> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(FileSnapshot {
        identity: FileIdentity {
            volume: metadata.dev(),
            file: u128::from(metadata.ino()).to_le_bytes(),
        },
        reparse_point: false,
        directory: metadata.is_dir(),
        hard_links: metadata.nlink().try_into().unwrap_or(u32::MAX),
        size: metadata.len(),
        last_write_time: metadata.mtime(),
        change_time: metadata.ctime(),
    })
}

#[cfg(unix)]
fn verify_opened_final_path(
    file: &File,
    canonical_root: &Path,
    relative: &str,
) -> Result<(), ManifestError> {
    let proc_path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    use std::os::fd::AsRawFd;
    let opened = fs::read_link(proc_path).map_err(io_error)?;
    if opened != join_without_inspection(canonical_root, relative) {
        return Err(invalid(
            ManifestErrorCode::ReparsePoint,
            "opened runtime artifact resolved through an unexpected alias",
        ));
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
compile_error!("runtime manifest filesystem verification requires Windows or Unix file identity");

fn invalid(code: ManifestErrorCode, message: impl Into<String>) -> ManifestError {
    ManifestError::new(code, message)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TestTree {
        parent: PathBuf,
        root: PathBuf,
        artifact: PathBuf,
        closure: ArtifactClosure,
    }

    impl TestTree {
        fn new(label: &str, relative: &str) -> Self {
            let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let parent = std::env::temp_dir().join(format!(
                "prime-studio-runtime-lock-test-{}-{unique}-{label}",
                std::process::id()
            ));
            let root = parent.join("runtime");
            let artifact = join_without_inspection(&root, relative);
            let bytes = b"synthetic locked artifact\n";
            fs::create_dir_all(artifact.parent().expect("artifact parent"))
                .expect("create lock-test tree");
            fs::write(&artifact, bytes).expect("write lock-test artifact");
            let closure = ArtifactClosure {
                complete: true,
                sha256: String::new(),
                artifacts: vec![ArtifactBinding {
                    path: relative.to_owned(),
                    role: ArtifactRole::RuntimeAsset,
                    size: u64::try_from(bytes.len()).expect("test size"),
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                }],
            };
            Self {
                parent,
                root,
                artifact,
                closure,
            }
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.parent);
        }
    }

    #[test]
    fn verifier_rejects_root_swap_between_inspection_and_lock() {
        let tree = TestTree::new("root-swap", "artifact.bin");
        let replacement = tree.parent.join("original-runtime");
        let mut swapped = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::RootInspected && !swapped {
                fs::rename(&tree.root, &replacement).expect("swap inspected root");
                fs::create_dir(&tree.root).expect("create replacement root");
                fs::write(
                    tree.root.join("artifact.bin"),
                    b"synthetic locked artifact\n",
                )
                .expect("write exact replacement bytes");
                swapped = true;
            }
        });
        assert!(swapped);
        assert_eq!(
            result
                .expect_err("a root identity swap must fail closed")
                .code(),
            ManifestErrorCode::FileIdentityChanged
        );
    }

    #[test]
    fn verifier_blocks_or_detects_component_swap_after_enumeration() {
        let tree = TestTree::new("component-swap", "bundle/artifact.bin");
        let bundle = tree.root.join("bundle");
        let displaced = tree.parent.join("displaced-bundle");
        let mut swapped = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::TreeEnumerated && fs::rename(&bundle, &displaced).is_ok()
            {
                fs::create_dir(&bundle).expect("create replacement component");
                fs::write(bundle.join("artifact.bin"), b"synthetic locked artifact\n")
                    .expect("write exact replacement artifact");
                swapped = true;
            }
        });
        if swapped {
            assert_eq!(
                result
                    .expect_err("a completed component swap must be detected")
                    .code(),
                ManifestErrorCode::FileIdentityChanged
            );
        } else {
            result.expect("the held root lock prevented the component swap");
        }
    }

    #[test]
    fn verifier_blocks_or_detects_late_unlisted_file_creation() {
        let tree = TestTree::new("late-extra", "artifact.bin");
        let mut created = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::DirectoriesLocked
                && fs::write(tree.root.join("unlisted.bin"), b"late bytes").is_ok()
            {
                created = true;
            }
        });
        if created {
            assert_eq!(
                result
                    .expect_err("a late unlisted artifact must be detected")
                    .code(),
                ManifestErrorCode::FileIdentityChanged
            );
        } else {
            result.expect("the held directory lock prevented late file creation");
        }
    }

    #[test]
    fn verifier_blocks_or_detects_same_file_writes_after_artifact_lock() {
        let tree = TestTree::new("late-write", "artifact.bin");
        let mut written = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::ArtifactsLocked
                && fs::write(&tree.artifact, b"malicious same-identity bytes\n").is_ok()
            {
                written = true;
            }
        });
        assert!(
            !written,
            "the held artifact handle must deny concurrent writes"
        );
        result.expect("the held artifact handle denied concurrent writes");
    }

    #[test]
    fn verifier_blocks_or_detects_late_alternate_stream_creation() {
        let tree = TestTree::new("late-stream", "artifact.bin");
        let stream = PathBuf::from(format!("{}:late", tree.artifact.display()));
        let mut created = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::ArtifactsLocked
                && fs::write(&stream, b"late alternate bytes").is_ok()
            {
                created = true;
            }
        });
        if created {
            assert!(
                matches!(
                    result
                        .expect_err("a late alternate stream must be detected")
                        .code(),
                    ManifestErrorCode::AlternateDataStream | ManifestErrorCode::FileIdentityChanged
                ),
                "stream enumeration or the filesystem change-time snapshot must reject it"
            );
        } else {
            result.expect("the held artifact lock prevented alternate stream creation");
        }
    }

    #[test]
    fn verifier_detects_a_change_after_final_tree_enumeration() {
        let tree = TestTree::new("post-enumeration-change", "artifact.bin");
        let mut created = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::FinalTreeChecked
                && fs::write(tree.root.join("too-late.bin"), b"late bytes").is_ok()
            {
                created = true;
            }
        });
        assert!(created, "the synchronization hook must exercise the race");
        assert_eq!(
            result
                .expect_err("a post-enumeration directory change must be detected")
                .code(),
            ManifestErrorCode::FileIdentityChanged
        );
    }

    #[test]
    fn verifier_detects_an_alternate_stream_after_final_tree_enumeration() {
        let tree = TestTree::new("post-enumeration-stream", "artifact.bin");
        let stream = PathBuf::from(format!("{}:too-late", tree.artifact.display()));
        let mut created = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::FinalTreeChecked
                && fs::write(&stream, b"late alternate bytes").is_ok()
            {
                created = true;
            }
        });
        assert!(
            created,
            "the synchronization hook must exercise the ADS race"
        );
        assert_eq!(
            result
                .expect_err("a post-enumeration alternate stream must be detected")
                .code(),
            ManifestErrorCode::AlternateDataStream
        );
    }

    #[test]
    fn verifier_detects_a_root_stream_after_final_tree_enumeration() {
        let tree = TestTree::new("post-enumeration-root-stream", "artifact.bin");
        let stream = PathBuf::from(format!("{}:too-late", tree.root.display()));
        let mut created = false;
        let result = verify_artifact_files_with_hook(&tree.closure, &tree.root, |phase| {
            if phase == VerificationPhase::FinalTreeChecked
                && fs::write(&stream, b"late root stream bytes").is_ok()
            {
                created = true;
            }
        });
        assert!(
            created,
            "the synchronization hook must exercise the root ADS race"
        );
        assert_eq!(
            result
                .expect_err("a post-enumeration root stream must be detected")
                .code(),
            ManifestErrorCode::AlternateDataStream
        );
    }
}
