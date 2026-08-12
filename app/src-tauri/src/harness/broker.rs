use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::compatibility::decide_compatibility;
use super::generated::{
    CommandOutcome, HarnessCapability, HarnessCompatibility, HarnessCursor, HarnessEvent,
    HarnessStudioAction, RootSessionSnapshot, SessionCommandKind, StudioOperationStatus,
    StudioRequest, StudioResponse,
};
pub use super::projections::{BootProjection, ProjectionFreshness, RootSessionProjection};
use super::recovery::{RecoveredSession, RecoveryRecord};
use super::sidecar::{validate_root_snapshot, HarnessError, SidecarHandle};

#[cfg(feature = "test-support-bin")]
const TEST_RUNTIME_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
#[cfg(feature = "test-support-bin")]
const TEST_PROFILE: &str = "daemon-v7-schema13";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_INSPECTOR_ARTIFACT_CANDIDATES: usize = 2_048;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokerState {
    Disconnected,
    Handshaking,
    Snapshotting,
    Live,
    Reconnecting,
    Failed,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionOwnership {
    pub account_id: Option<String>,
    pub project_id: String,
    pub chat_id: String,
}

pub struct SnapshotAdmission {
    broker_id: Uuid,
    snapshot: RootSessionSnapshot,
}

pub struct EventAdmission {
    broker_id: Uuid,
    event: HarnessEvent,
}

pub struct AttachRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResidentCreateRequest {
    pub creation_id: String,
    pub name: String,
    pub cwd: String,
    pub expected_account_id: Option<String>,
    pub expected_project_id: String,
}

pub struct ResidentCreateResult {
    pub creation_id: String,
    pub session: RootSessionProjection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResidentCreation {
    name: String,
    cwd: String,
    expected_account_id: Option<String>,
    expected_project_id: String,
    session_id: String,
}

pub struct SessionCommandRequest {
    pub session_id: String,
    pub command_id: String,
    pub expected_cursor: HarnessCursor,
    pub kind: SessionCommandKind,
    pub text: String,
}

pub struct SessionCommandResult {
    pub outcome: CommandOutcome,
    pub session: RootSessionProjection,
}

pub struct InspectorRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactCandidateResolution {
    pub broker_id: String,
    pub root_session_id: String,
    pub artifact_id: String,
    pub project_id: String,
    pub path: PathBuf,
    pub writable: bool,
}

#[derive(Clone, Debug)]
struct ArtifactCandidate {
    session_id: String,
    project_id: String,
    cursor: HarnessCursor,
    path: PathBuf,
    writable: bool,
}

pub struct RefreshSessionRequest {
    pub session_id: String,
    pub known_cursor: HarnessCursor,
}

pub struct StudioOperationRequest {
    pub session_id: String,
    pub operation_id: String,
    pub action: HarnessStudioAction,
    pub payload_json: String,
    pub expected_cursor: Option<HarnessCursor>,
    pub idempotency_key: Option<String>,
}

pub struct StudioOperationResult {
    pub operation_id: String,
    pub status: StudioOperationStatus,
    pub command_id: Option<String>,
    pub position: Option<u64>,
    pub revision: Option<String>,
    pub reason: Option<String>,
    pub retryable: Option<bool>,
    pub session: Option<RootSessionProjection>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct UnknownOperation {
    operation_id: String,
    idempotency_key: Option<String>,
}

pub struct HarnessBroker {
    id: Uuid,
    sidecar: Option<SidecarHandle>,
    state: BrokerState,
    ownership: BTreeMap<String, SessionOwnership>,
    committed: BTreeMap<String, RootSessionSnapshot>,
    staged: BTreeMap<String, RootSessionSnapshot>,
    retired_generations: BTreeMap<String, BTreeSet<String>>,
    expected_snapshots: Option<usize>,
    recovery: Option<RecoveryRecord>,
    compatibility: Option<HarnessCompatibility>,
    unknown_outcomes: BTreeMap<String, BTreeSet<UnknownOperation>>,
    resident_creations: BTreeMap<String, ResidentCreation>,
    artifact_candidates: BTreeMap<String, ArtifactCandidate>,
    runtime_digest: String,
    profile: String,
}

impl HarnessBroker {
    pub fn new(
        sidecar: SidecarHandle,
        runtime_digest: String,
        profile: String,
        ownership: Vec<(String, SessionOwnership)>,
        recovery: Option<RecoveryRecord>,
    ) -> Result<Self, HarnessError> {
        Self::build(Some(sidecar), runtime_digest, profile, ownership, recovery)
    }

    #[cfg(feature = "test-support-bin")]
    pub fn for_tests(
        ownership: Vec<(String, SessionOwnership)>,
        recovery: Option<RecoveryRecord>,
    ) -> Result<Self, HarnessError> {
        Self::build(
            None,
            TEST_RUNTIME_DIGEST.to_owned(),
            TEST_PROFILE.to_owned(),
            ownership,
            recovery,
        )
    }

    fn build(
        sidecar: Option<SidecarHandle>,
        runtime_digest: String,
        profile: String,
        ownership: Vec<(String, SessionOwnership)>,
        recovery: Option<RecoveryRecord>,
    ) -> Result<Self, HarnessError> {
        if ownership.len() > 256 || !valid_digest(&runtime_digest) || !valid_id(&profile) {
            return Err(HarnessError::OwnershipViolation);
        }
        if let Some(record) = &recovery {
            record.validate()?;
            if record.runtime_digest != runtime_digest || record.profile != profile {
                return Err(HarnessError::RecoveryFailed);
            }
        }
        let mut ownership_map = BTreeMap::new();
        for (session_id, binding) in ownership {
            if !valid_id(&session_id)
                || !valid_id(&binding.project_id)
                || !valid_id(&binding.chat_id)
                || binding.account_id.as_ref().is_some_and(|id| !valid_id(id))
                || ownership_map.insert(session_id, binding).is_some()
            {
                return Err(HarnessError::OwnershipViolation);
            }
        }
        Ok(Self {
            id: Uuid::new_v4(),
            sidecar,
            state: BrokerState::Disconnected,
            ownership: ownership_map,
            committed: BTreeMap::new(),
            staged: BTreeMap::new(),
            retired_generations: BTreeMap::new(),
            expected_snapshots: None,
            recovery,
            compatibility: None,
            unknown_outcomes: BTreeMap::new(),
            resident_creations: BTreeMap::new(),
            artifact_candidates: BTreeMap::new(),
            runtime_digest,
            profile,
        })
    }

    pub fn state(&self) -> BrokerState {
        self.state
    }

    pub async fn bootstrap(&mut self) -> Result<BootProjection, HarnessError> {
        if self.state != BrokerState::Disconnected {
            return Err(HarnessError::StateViolation);
        }
        self.state = BrokerState::Handshaking;
        let result = self.bootstrap_inner().await;
        if result.is_err() {
            self.staged.clear();
            self.expected_snapshots = None;
            self.state = BrokerState::Failed;
        }
        result
    }

    /// Production startup reconciles only sessions already named by immutable
    /// Studio catalog bindings. It deliberately does not ask the daemon for its
    /// global session list: unrelated or client-owned daemon sessions are not
    /// authority for this Studio instance.
    pub async fn bootstrap_owned(&mut self) -> Result<BootProjection, HarnessError> {
        if self.state != BrokerState::Disconnected {
            return Err(HarnessError::StateViolation);
        }
        self.state = BrokerState::Handshaking;
        let result = self.bootstrap_owned_inner().await;
        if result.is_err() {
            self.staged.clear();
            self.expected_snapshots = None;
            self.state = BrokerState::Failed;
        }
        result
    }

    async fn bootstrap_owned_inner(&mut self) -> Result<BootProjection, HarnessError> {
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let discovery = sidecar
            .request(
                StudioRequest::DiscoverRuntime,
                Instant::now() + Duration::from_secs(5),
            )
            .await?;
        let StudioResponse::DiscoverRuntimeResult {
            runtime,
            compatibility: reported_compatibility,
        } = discovery
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        let Some(runtime) = runtime else {
            if !matches!(
                reported_compatibility,
                HarnessCompatibility::Unavailable { .. }
            ) {
                return Err(HarnessError::ProtocolViolation);
            }
            self.compatibility = Some(reported_compatibility.clone());
            self.begin_snapshot(0)?;
            self.finish_snapshot()?;
            return Ok(BootProjection {
                compatibility: reported_compatibility,
                sessions: Vec::new(),
            });
        };
        let compatibility = decide_compatibility(&runtime);
        if compatibility != reported_compatibility || runtime.package_digest != self.runtime_digest
        {
            return Err(HarnessError::ProtocolViolation);
        }
        if matches!(
            compatibility,
            HarnessCompatibility::ReadOnly { .. } | HarnessCompatibility::Unavailable { .. }
        ) {
            self.compatibility = Some(compatibility.clone());
            self.begin_snapshot(0)?;
            self.finish_snapshot()?;
            return Ok(BootProjection {
                compatibility,
                sessions: Vec::new(),
            });
        }
        if !compatibility_uses_profile(&compatibility, &self.profile) {
            return Err(HarnessError::ProtocolViolation);
        }
        let session_ids = self.ownership.keys().cloned().collect::<Vec<_>>();
        self.compatibility = Some(compatibility.clone());
        self.begin_snapshot(session_ids.len())?;
        for session_id in session_ids {
            let response = sidecar
                .request(
                    StudioRequest::AttachSession {
                        session_id: session_id.clone(),
                    },
                    Instant::now() + Duration::from_secs(5),
                )
                .await?;
            let StudioResponse::SnapshotResult { snapshot } = response else {
                return Err(HarnessError::ProtocolViolation);
            };
            if snapshot.session_id != session_id {
                return Err(HarnessError::OwnershipViolation);
            }
            let admission = self.admit_snapshot(*snapshot)?;
            self.apply_snapshot(admission)?;
        }
        self.finish_snapshot()?;
        Ok(BootProjection {
            compatibility,
            sessions: self.projects(),
        })
    }

    async fn bootstrap_inner(&mut self) -> Result<BootProjection, HarnessError> {
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let discovery = sidecar
            .request(
                StudioRequest::DiscoverRuntime,
                Instant::now() + Duration::from_secs(5),
            )
            .await?;
        let StudioResponse::DiscoverRuntimeResult {
            runtime,
            compatibility: reported_compatibility,
        } = discovery
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        let Some(runtime) = runtime else {
            if !matches!(
                reported_compatibility,
                HarnessCompatibility::Unavailable { .. }
            ) {
                return Err(HarnessError::ProtocolViolation);
            }
            self.compatibility = Some(reported_compatibility.clone());
            self.begin_snapshot(0)?;
            self.finish_snapshot()?;
            return Ok(BootProjection {
                compatibility: reported_compatibility,
                sessions: Vec::new(),
            });
        };
        let compatibility = decide_compatibility(&runtime);
        if compatibility != reported_compatibility {
            return Err(HarnessError::ProtocolViolation);
        }
        if runtime.package_digest != self.runtime_digest {
            return Err(HarnessError::ProtocolViolation);
        }
        if matches!(
            compatibility,
            HarnessCompatibility::ReadOnly { .. } | HarnessCompatibility::Unavailable { .. }
        ) {
            self.compatibility = Some(compatibility.clone());
            self.begin_snapshot(0)?;
            self.finish_snapshot()?;
            return Ok(BootProjection {
                compatibility,
                sessions: Vec::new(),
            });
        }
        let response = sidecar
            .request(
                StudioRequest::Bootstrap,
                Instant::now() + Duration::from_secs(5),
            )
            .await?;
        let StudioResponse::BootstrapResult {
            compatibility,
            sessions,
        } = response
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        if compatibility != reported_compatibility
            || !compatibility_uses_profile(&compatibility, &self.profile)
        {
            return Err(HarnessError::ProtocolViolation);
        }
        self.compatibility = Some(compatibility.clone());
        self.begin_snapshot(sessions.len())?;
        for snapshot in sessions {
            let admission = self.admit_snapshot(snapshot)?;
            self.apply_snapshot(admission)?;
        }
        self.finish_snapshot()?;
        Ok(BootProjection {
            compatibility,
            sessions: self.projects(),
        })
    }

    pub async fn attach(
        &mut self,
        request: AttachRequest,
    ) -> Result<RootSessionProjection, HarnessError> {
        if self.state != BrokerState::Live
            || !valid_id(&request.session_id)
            || !self.ownership.contains_key(&request.session_id)
        {
            return Err(HarnessError::OwnershipViolation);
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::AttachSession {
                    session_id: request.session_id.clone(),
                },
                Instant::now() + Duration::from_secs(5),
            )
            .await?;
        let StudioResponse::SnapshotResult { snapshot } = response else {
            return Err(HarnessError::ProtocolViolation);
        };
        let admission = self.admit_event(HarnessEvent::Snapshot { snapshot })?;
        self.apply_event(admission)?;
        // Attach is the explicit reconciliation boundary: only after an owned, exact-next
        // snapshot is admitted may this session accept new mutations. The sidecar retains its
        // per-operation/idempotency tombstone, so the uncertain operation itself cannot execute
        // again even though unrelated new work for this session is unblocked.
        self.unknown_outcomes.remove(&request.session_id);
        self.project(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)
    }

    pub async fn create_resident(
        &mut self,
        request: ResidentCreateRequest,
    ) -> Result<ResidentCreateResult, HarnessError> {
        if self.state != BrokerState::Live
            || !valid_id(&request.creation_id)
            || !valid_label(&request.name)
            || !valid_path(&request.cwd)
            || !valid_id(&request.expected_project_id)
            || request
                .expected_account_id
                .as_ref()
                .is_some_and(|value| !valid_id(value))
        {
            return Err(HarnessError::ProtocolViolation);
        }
        let resident_capability = match self.compatibility.as_ref() {
            Some(HarnessCompatibility::Ready { capabilities, .. })
            | Some(HarnessCompatibility::Degraded { capabilities, .. }) => {
                capabilities.contains(&HarnessCapability::ResidentSessions)
            }
            Some(HarnessCompatibility::ReadOnly { .. })
            | Some(HarnessCompatibility::Unavailable { .. })
            | None => false,
        };
        if !resident_capability {
            return Err(HarnessError::StateViolation);
        }
        if let Some(prior) = self.resident_creations.get(&request.creation_id) {
            if prior.name != request.name
                || prior.cwd != request.cwd
                || prior.expected_account_id != request.expected_account_id
                || prior.expected_project_id != request.expected_project_id
            {
                return Err(HarnessError::OwnershipViolation);
            }
            let session = self
                .project(&prior.session_id)
                .ok_or(HarnessError::OwnershipViolation)?;
            return Ok(ResidentCreateResult {
                creation_id: request.creation_id,
                session,
            });
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::CreateResident {
                    creation_id: request.creation_id.clone(),
                    name: request.name.clone(),
                    cwd: request.cwd.clone(),
                },
                Instant::now() + Duration::from_secs(75),
            )
            .await?;
        let StudioResponse::ResidentCreated {
            creation_id,
            snapshot,
        } = response
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        if creation_id != request.creation_id || !validate_root_snapshot(&snapshot) {
            return Err(HarnessError::ProtocolViolation);
        }
        if snapshot.account_id != request.expected_account_id
            || snapshot.project_id != request.expected_project_id
        {
            return Err(HarnessError::OwnershipViolation);
        }
        let session_id = snapshot.session_id.clone();
        if self.committed.contains_key(&session_id) || self.ownership.contains_key(&session_id) {
            return Err(HarnessError::OwnershipViolation);
        }
        if self
            .ownership
            .values()
            .any(|owner| owner.chat_id == snapshot.chat_id)
            || self
                .committed
                .values()
                .any(|current| current.chat_id == snapshot.chat_id)
            || self.committed.len() >= 256
            || self
                .retired_generations
                .get(&session_id)
                .is_some_and(|set| set.contains(&snapshot.cursor.runtime_generation))
        {
            return Err(HarnessError::OwnershipViolation);
        }
        self.validate_child_ownership(&snapshot)?;
        let ownership = SessionOwnership {
            account_id: snapshot.account_id.clone(),
            project_id: snapshot.project_id.clone(),
            chat_id: snapshot.chat_id.clone(),
        };
        self.ownership.insert(session_id.clone(), ownership);
        self.committed.insert(session_id.clone(), *snapshot);
        self.resident_creations.insert(
            request.creation_id.clone(),
            ResidentCreation {
                name: request.name,
                cwd: request.cwd,
                expected_account_id: request.expected_account_id,
                expected_project_id: request.expected_project_id,
                session_id: session_id.clone(),
            },
        );
        let session = self
            .project(&session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        Ok(ResidentCreateResult {
            creation_id: request.creation_id,
            session,
        })
    }

    pub async fn submit(
        &mut self,
        request: SessionCommandRequest,
    ) -> Result<SessionCommandResult, HarnessError> {
        if self.state != BrokerState::Live
            || !valid_id(&request.session_id)
            || !valid_id(&request.command_id)
            || request.expected_cursor.sequence > MAX_SAFE_INTEGER
            || !valid_command_text(&request.kind, &request.text)
        {
            return Err(HarnessError::ProtocolViolation);
        }
        if self.unknown_outcomes.contains_key(&request.session_id) {
            return Err(HarnessError::OwnershipViolation);
        }
        let current = self
            .committed
            .get(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        if current.cursor != request.expected_cursor {
            return Err(HarnessError::ChronologyViolation);
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::SessionCommand {
                    session_id: request.session_id.clone(),
                    command_id: request.command_id.clone(),
                    expected_cursor: request.expected_cursor,
                    kind: request.kind,
                    text: request.text,
                },
                Instant::now() + Duration::from_secs(10),
            )
            .await;
        let response = match response {
            Ok(response) => response,
            Err(HarnessError::DeadlineExceeded { uncertain: true }) => {
                self.mark_unknown_outcome(&request.session_id, &request.command_id, None)?;
                return Err(HarnessError::DeadlineExceeded { uncertain: true });
            }
            Err(error) => return Err(error),
        };
        let StudioResponse::CommandResult {
            command_id,
            outcome,
            snapshot,
        } = response
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        if command_id != request.command_id || outcome == CommandOutcome::Reconciled {
            return Err(HarnessError::ProtocolViolation);
        }
        let admission = self.admit_event(HarnessEvent::Snapshot { snapshot })?;
        self.apply_event(admission)?;
        let session = self
            .project(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        Ok(SessionCommandResult { outcome, session })
    }

    pub async fn inspector(&mut self, request: InspectorRequest) -> Result<String, HarnessError> {
        if self.state != BrokerState::Live
            || !valid_id(&request.session_id)
            || !self.ownership.contains_key(&request.session_id)
        {
            return Err(HarnessError::OwnershipViolation);
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::Inspector {
                    session_id: request.session_id.clone(),
                },
                Instant::now() + Duration::from_secs(10),
            )
            .await?;
        let StudioResponse::InspectorResult { details_json } = response else {
            return Err(HarnessError::ProtocolViolation);
        };
        if details_json.chars().count() > 131_072 {
            return Err(HarnessError::ProtocolViolation);
        }
        let current = self
            .committed
            .get(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        let ownership = self
            .ownership
            .get(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        self.artifact_candidates
            .retain(|_, candidate| candidate.session_id != request.session_id);
        let (details_json, candidates) = sanitize_inspector_artifacts(
            &details_json,
            &request.session_id,
            &ownership.project_id,
            &current.cursor,
        )?;
        self.artifact_candidates.extend(candidates);
        Ok(details_json)
    }

    pub fn resolve_artifact_candidate(
        &self,
        session_id: &str,
        candidate_id: &str,
    ) -> Result<ArtifactCandidateResolution, HarnessError> {
        if self.state != BrokerState::Live || !valid_id(session_id) || !valid_id(candidate_id) {
            return Err(HarnessError::OwnershipViolation);
        }
        let candidate = self
            .artifact_candidates
            .get(candidate_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        let current = self
            .committed
            .get(session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        if candidate.session_id != session_id || candidate.cursor != current.cursor {
            return Err(HarnessError::ChronologyViolation);
        }
        Ok(ArtifactCandidateResolution {
            broker_id: self.id.to_string(),
            root_session_id: session_id.to_owned(),
            artifact_id: candidate_id.to_owned(),
            project_id: candidate.project_id.clone(),
            path: candidate.path.clone(),
            writable: candidate.writable,
        })
    }

    pub async fn refresh_session(
        &mut self,
        request: RefreshSessionRequest,
    ) -> Result<RootSessionProjection, HarnessError> {
        if self.state != BrokerState::Live || !valid_id(&request.session_id) {
            return Err(HarnessError::ProtocolViolation);
        }
        let current = self
            .committed
            .get(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        if current.cursor != request.known_cursor {
            return Err(HarnessError::ChronologyViolation);
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::RefreshSession {
                    session_id: request.session_id.clone(),
                    known_cursor: request.known_cursor,
                },
                Instant::now() + Duration::from_secs(10),
            )
            .await?;
        if let StudioResponse::Error { code, .. } = &response {
            if code != "generation_changed" {
                return Err(HarnessError::ProtocolViolation);
            }
            self.begin_reconnect()?;
            let reboot = self.bootstrap_inner().await;
            if reboot.is_err() {
                self.staged.clear();
                self.expected_snapshots = None;
                self.state = BrokerState::Failed;
            }
            return reboot?
                .sessions
                .into_iter()
                .find(|session| session.session_id == request.session_id)
                .ok_or(HarnessError::OwnershipViolation);
        }
        let StudioResponse::SnapshotResult { snapshot } = response else {
            return Err(HarnessError::ProtocolViolation);
        };
        let admission = self.admit_event(HarnessEvent::Snapshot { snapshot })?;
        self.apply_event(admission)?;
        self.project(&request.session_id)
            .ok_or(HarnessError::OwnershipViolation)
    }

    pub async fn execute_operation(
        &mut self,
        request: StudioOperationRequest,
    ) -> Result<StudioOperationResult, HarnessError> {
        if self.state != BrokerState::Live
            || self.unknown_outcomes.contains_key(&request.session_id)
            || !valid_id(&request.session_id)
            || !valid_id(&request.operation_id)
            || request.payload_json.chars().count() > 131_072
            || request
                .idempotency_key
                .as_ref()
                .is_some_and(|value| !valid_id(value))
            || !self.ownership.contains_key(&request.session_id)
        {
            return Err(HarnessError::OwnershipViolation);
        }
        if let Some(expected) = &request.expected_cursor {
            if expected.sequence > MAX_SAFE_INTEGER
                || self
                    .committed
                    .get(&request.session_id)
                    .is_none_or(|snapshot| snapshot.cursor != *expected)
            {
                return Err(HarnessError::ChronologyViolation);
            }
        }
        let sidecar = self.sidecar.clone().ok_or(HarnessError::StateViolation)?;
        let response = sidecar
            .request(
                StudioRequest::StudioOperation {
                    session_id: request.session_id.clone(),
                    operation_id: request.operation_id.clone(),
                    action: request.action,
                    payload_json: request.payload_json,
                    expected_cursor: request.expected_cursor,
                    idempotency_key: request.idempotency_key.clone(),
                },
                Instant::now() + Duration::from_secs(30),
            )
            .await;
        let response = match response {
            Ok(response) => response,
            Err(HarnessError::DeadlineExceeded { uncertain: true }) => {
                self.mark_unknown_outcome(
                    &request.session_id,
                    &request.operation_id,
                    request.idempotency_key.as_deref(),
                )?;
                return Err(HarnessError::DeadlineExceeded { uncertain: true });
            }
            Err(error) => return Err(error),
        };
        let StudioResponse::StudioOperationResult {
            operation_id,
            status,
            command_id,
            position,
            revision,
            reason,
            retryable,
            snapshot,
        } = response
        else {
            return Err(HarnessError::ProtocolViolation);
        };
        if operation_id != request.operation_id {
            return Err(HarnessError::ProtocolViolation);
        }
        let successful = matches!(
            &status,
            StudioOperationStatus::Accepted
                | StudioOperationStatus::Queued
                | StudioOperationStatus::Updated
                | StudioOperationStatus::Cancelled
        );
        if successful != snapshot.is_some() {
            return Err(HarnessError::ProtocolViolation);
        }
        if matches!(&status, StudioOperationStatus::UnknownOutcome) {
            self.mark_unknown_outcome(
                &request.session_id,
                &request.operation_id,
                request.idempotency_key.as_deref(),
            )?;
        }
        let session = if let Some(snapshot) = snapshot {
            let admission = self.admit_event(HarnessEvent::Snapshot { snapshot })?;
            self.apply_event(admission)?;
            Some(
                self.project(&request.session_id)
                    .ok_or(HarnessError::OwnershipViolation)?,
            )
        } else {
            None
        };
        Ok(StudioOperationResult {
            operation_id,
            status,
            command_id,
            position,
            revision,
            reason,
            retryable,
            session,
        })
    }

    pub fn begin_snapshot(&mut self, expected: usize) -> Result<(), HarnessError> {
        if expected > 256
            || !matches!(
                self.state,
                BrokerState::Disconnected | BrokerState::Handshaking | BrokerState::Reconnecting
            )
        {
            return Err(HarnessError::StateViolation);
        }
        self.state = BrokerState::Snapshotting;
        self.expected_snapshots = Some(expected);
        self.staged.clear();
        Ok(())
    }

    pub fn admit_snapshot(
        &self,
        snapshot: RootSessionSnapshot,
    ) -> Result<SnapshotAdmission, HarnessError> {
        if self.state != BrokerState::Snapshotting {
            return Err(HarnessError::StateViolation);
        }
        self.validate_snapshot(&snapshot)?;
        Ok(SnapshotAdmission {
            broker_id: self.id,
            snapshot,
        })
    }

    pub fn apply_snapshot(&mut self, admission: SnapshotAdmission) -> Result<(), HarnessError> {
        if self.state != BrokerState::Snapshotting || admission.broker_id != self.id {
            return Err(HarnessError::OwnershipViolation);
        }
        self.validate_snapshot(&admission.snapshot)?;
        if self
            .staged
            .insert(admission.snapshot.session_id.clone(), admission.snapshot)
            .is_some()
        {
            self.state = BrokerState::Failed;
            return Err(HarnessError::ChronologyViolation);
        }
        Ok(())
    }

    pub fn finish_snapshot(&mut self) -> Result<(), HarnessError> {
        let expected = self
            .expected_snapshots
            .take()
            .ok_or(HarnessError::StateViolation)?;
        if self.state != BrokerState::Snapshotting || self.staged.len() != expected {
            self.staged.clear();
            self.state = BrokerState::Failed;
            return Err(HarnessError::ProtocolViolation);
        }
        let mut child_owners = BTreeMap::<String, String>::new();
        for (session_id, snapshot) in &self.staged {
            for child in &snapshot.children {
                if self.ownership.contains_key(&child.id)
                    || child_owners
                        .insert(child.id.clone(), session_id.clone())
                        .is_some()
                {
                    self.staged.clear();
                    self.state = BrokerState::Failed;
                    return Err(HarnessError::OwnershipViolation);
                }
            }
        }
        for (session_id, old) in &self.committed {
            if let Some(new) = self.staged.get(session_id) {
                if old.cursor.runtime_generation != new.cursor.runtime_generation {
                    self.retired_generations
                        .entry(session_id.clone())
                        .or_default()
                        .insert(old.cursor.runtime_generation.clone());
                }
            }
        }
        if let Some(recovery) = &self.recovery {
            for prior in &recovery.sessions {
                if let Some(new) = self.staged.get(&prior.session_id) {
                    if prior.cursor.runtime_generation != new.cursor.runtime_generation {
                        self.retired_generations
                            .entry(prior.session_id.clone())
                            .or_default()
                            .insert(prior.cursor.runtime_generation.clone());
                    }
                }
            }
        }
        self.committed = std::mem::take(&mut self.staged);
        self.state = BrokerState::Live;
        Ok(())
    }

    pub fn admit_event(&self, event: HarnessEvent) -> Result<EventAdmission, HarnessError> {
        if self.state != BrokerState::Live {
            return Err(HarnessError::StateViolation);
        }
        self.validate_event(&event)?;
        Ok(EventAdmission {
            broker_id: self.id,
            event,
        })
    }

    pub fn apply_event(&mut self, admission: EventAdmission) -> Result<(), HarnessError> {
        if self.state != BrokerState::Live || admission.broker_id != self.id {
            return Err(HarnessError::OwnershipViolation);
        }
        self.validate_event(&admission.event)?;
        match admission.event {
            HarnessEvent::SessionState {
                session_id,
                cursor,
                state,
            } => {
                let session = self
                    .committed
                    .get_mut(&session_id)
                    .ok_or(HarnessError::OwnershipViolation)?;
                session.cursor = cursor;
                session.state = state;
            }
            HarnessEvent::Snapshot { snapshot } => {
                self.committed
                    .insert(snapshot.session_id.clone(), *snapshot);
            }
        }
        Ok(())
    }

    pub fn project(&self, session_id: &str) -> Option<RootSessionProjection> {
        let freshness = if self.unknown_outcomes.contains_key(session_id) {
            ProjectionFreshness::UnknownOutcome
        } else {
            match self.state {
                BrokerState::Live => ProjectionFreshness::Live,
                BrokerState::Reconnecting | BrokerState::Snapshotting => ProjectionFreshness::Stale,
                _ => ProjectionFreshness::Disconnected,
            }
        };
        self.committed
            .get(session_id)
            .map(|snapshot| RootSessionProjection::from_snapshot(snapshot, freshness))
    }

    pub fn projects(&self) -> Vec<RootSessionProjection> {
        self.committed
            .keys()
            .filter_map(|id| self.project(id))
            .collect()
    }

    pub fn boot_projection(&self) -> Option<BootProjection> {
        Some(BootProjection {
            compatibility: self.compatibility.clone()?,
            sessions: self.projects(),
        })
    }

    pub fn recovery_record(&self, revision: u64) -> Result<RecoveryRecord, HarnessError> {
        if self.state != BrokerState::Live {
            return Err(HarnessError::StateViolation);
        }
        let record = RecoveryRecord {
            schema_version: 1,
            projection_schema_version: 1,
            revision,
            runtime_digest: self.runtime_digest.clone(),
            profile: self.profile.clone(),
            sessions: self
                .committed
                .values()
                .map(|snapshot| RecoveredSession {
                    session_id: snapshot.session_id.clone(),
                    account_id: snapshot.account_id.clone(),
                    project_id: snapshot.project_id.clone(),
                    chat_id: snapshot.chat_id.clone(),
                    cursor: snapshot.cursor.clone(),
                })
                .collect(),
        };
        record.validate()?;
        Ok(record)
    }

    pub fn begin_reconnect(&mut self) -> Result<(), HarnessError> {
        if self.state != BrokerState::Live {
            return Err(HarnessError::StateViolation);
        }
        self.state = BrokerState::Reconnecting;
        Ok(())
    }

    pub fn mark_unknown_outcome(
        &mut self,
        session_id: &str,
        operation_id: &str,
        idempotency_key: Option<&str>,
    ) -> Result<(), HarnessError> {
        if !valid_id(session_id)
            || !valid_id(operation_id)
            || idempotency_key.is_some_and(|value| !valid_id(value))
            || !self.ownership.contains_key(session_id)
        {
            return Err(HarnessError::OwnershipViolation);
        }
        self.unknown_outcomes
            .entry(session_id.to_owned())
            .or_default()
            .insert(UnknownOperation {
                operation_id: operation_id.to_owned(),
                idempotency_key: idempotency_key.map(str::to_owned),
            });
        Ok(())
    }

    pub fn close(&mut self) {
        self.unknown_outcomes.clear();
        self.state = BrokerState::Closed;
    }

    fn validate_snapshot(&self, snapshot: &RootSessionSnapshot) -> Result<(), HarnessError> {
        if !validate_root_snapshot(snapshot) {
            return Err(HarnessError::ProtocolViolation);
        }
        let ownership = self
            .ownership
            .get(&snapshot.session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        if snapshot.account_id != ownership.account_id
            || snapshot.project_id != ownership.project_id
            || snapshot.chat_id != ownership.chat_id
        {
            return Err(HarnessError::OwnershipViolation);
        }
        if self
            .retired_generations
            .get(&snapshot.session_id)
            .is_some_and(|set| set.contains(&snapshot.cursor.runtime_generation))
        {
            return Err(HarnessError::ChronologyViolation);
        }
        self.validate_child_ownership(snapshot)?;
        let prior = self
            .committed
            .get(&snapshot.session_id)
            .map(|value| &value.cursor)
            .or_else(|| {
                self.recovery.as_ref()?.sessions.iter().find_map(|value| {
                    (value.session_id == snapshot.session_id).then_some(&value.cursor)
                })
            });
        if let Some(prior) = prior {
            if prior.runtime_generation == snapshot.cursor.runtime_generation
                && snapshot.cursor.sequence <= prior.sequence
            {
                return Err(HarnessError::ChronologyViolation);
            }
        }
        Ok(())
    }

    fn validate_event(&self, event: &HarnessEvent) -> Result<(), HarnessError> {
        let (session_id, cursor) = match event {
            HarnessEvent::SessionState {
                session_id, cursor, ..
            } => (session_id, cursor),
            HarnessEvent::Snapshot { snapshot } => (&snapshot.session_id, &snapshot.cursor),
        };
        let current = self
            .committed
            .get(session_id)
            .ok_or(HarnessError::OwnershipViolation)?;
        if cursor.sequence > MAX_SAFE_INTEGER
            || self
                .retired_generations
                .get(session_id)
                .is_some_and(|set| set.contains(&cursor.runtime_generation))
            || cursor.runtime_generation != current.cursor.runtime_generation
            || cursor.sequence
                != current
                    .cursor
                    .sequence
                    .checked_add(1)
                    .ok_or(HarnessError::ChronologyViolation)?
        {
            return Err(HarnessError::ChronologyViolation);
        }
        if let HarnessEvent::Snapshot { snapshot } = event {
            self.validate_snapshot(snapshot)?;
            self.validate_child_ownership(snapshot)?;
        }
        Ok(())
    }

    fn validate_child_ownership(&self, snapshot: &RootSessionSnapshot) -> Result<(), HarnessError> {
        let mut local = BTreeSet::new();
        for child in &snapshot.children {
            if child.id == snapshot.session_id
                || self.ownership.contains_key(&child.id)
                || !local.insert(&child.id)
                || self.committed.iter().any(|(session_id, other)| {
                    session_id != &snapshot.session_id
                        && other
                            .children
                            .iter()
                            .any(|existing| existing.id == child.id)
                })
            {
                return Err(HarnessError::OwnershipViolation);
            }
        }
        Ok(())
    }
}

fn artifact_label(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Artifact")
        .chars()
        .take(200)
        .collect()
}

fn admit_inspector_candidate(
    object: &mut serde_json::Map<String, serde_json::Value>,
    raw_keys: &[&str],
    session_id: &str,
    project_id: &str,
    cursor: &HarnessCursor,
    writable: bool,
    candidates: &mut BTreeMap<String, ArtifactCandidate>,
) -> Result<(), HarnessError> {
    let mut raw_path = None;
    for key in raw_keys {
        if let Some(value) = object.remove(*key) {
            if raw_path.is_some() || !value.is_string() {
                return Err(HarnessError::ProtocolViolation);
            }
            raw_path = value.as_str().map(str::to_owned);
        }
    }
    let Some(path) = raw_path else {
        return Ok(());
    };
    if !valid_path(&path) {
        return Err(HarnessError::ProtocolViolation);
    }
    if candidates.len() >= MAX_INSPECTOR_ARTIFACT_CANDIDATES {
        return Err(HarnessError::ProtocolViolation);
    }
    let candidate_id = format!("artifact-candidate-{}", Uuid::new_v4().simple());
    candidates.insert(
        candidate_id.clone(),
        ArtifactCandidate {
            session_id: session_id.to_owned(),
            project_id: project_id.to_owned(),
            cursor: cursor.clone(),
            path: PathBuf::from(&path),
            writable,
        },
    );
    object.insert(
        "candidateId".to_owned(),
        serde_json::Value::String(candidate_id),
    );
    object
        .entry("label".to_owned())
        .or_insert_with(|| serde_json::Value::String(artifact_label(&path)));
    Ok(())
}

fn contains_renderer_path_authority(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(values) => values.iter().any(contains_renderer_path_authority),
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.as_str(), "path" | "filePath" | "candidatePath")
                || contains_renderer_path_authority(value)
        }),
        _ => false,
    }
}

fn sanitize_inspector_artifacts(
    details_json: &str,
    session_id: &str,
    project_id: &str,
    cursor: &HarnessCursor,
) -> Result<(String, BTreeMap<String, ArtifactCandidate>), HarnessError> {
    let mut details: serde_json::Value =
        serde_json::from_str(details_json).map_err(|_| HarnessError::ProtocolViolation)?;
    let root = details
        .as_object_mut()
        .ok_or(HarnessError::ProtocolViolation)?;
    let mut candidates = BTreeMap::new();

    for output in root
        .get_mut("outputs")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or(HarnessError::ProtocolViolation)?
    {
        admit_inspector_candidate(
            output
                .as_object_mut()
                .ok_or(HarnessError::ProtocolViolation)?,
            &["candidatePath", "path"],
            session_id,
            project_id,
            cursor,
            true,
            &mut candidates,
        )?;
    }
    for source in root
        .get_mut("sources")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or(HarnessError::ProtocolViolation)?
    {
        admit_inspector_candidate(
            source
                .as_object_mut()
                .ok_or(HarnessError::ProtocolViolation)?,
            &["candidatePath"],
            session_id,
            project_id,
            cursor,
            false,
            &mut candidates,
        )?;
    }
    for activity in root
        .get_mut("activity")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or(HarnessError::ProtocolViolation)?
    {
        let activity = activity
            .as_object_mut()
            .ok_or(HarnessError::ProtocolViolation)?;
        admit_inspector_candidate(
            activity,
            &["candidatePath", "filePath"],
            session_id,
            project_id,
            cursor,
            true,
            &mut candidates,
        )?;
        if let Some(files) = activity
            .get_mut("tool")
            .and_then(serde_json::Value::as_object_mut)
            .and_then(|tool| tool.get_mut("files"))
            .and_then(serde_json::Value::as_array_mut)
        {
            for file in files {
                let path = file
                    .as_str()
                    .filter(|path| valid_path(path))
                    .ok_or(HarnessError::ProtocolViolation)?
                    .to_owned();
                let mut object = serde_json::Map::new();
                object.insert("candidatePath".to_owned(), serde_json::Value::String(path));
                admit_inspector_candidate(
                    &mut object,
                    &["candidatePath"],
                    session_id,
                    project_id,
                    cursor,
                    true,
                    &mut candidates,
                )?;
                *file = serde_json::Value::Object(object);
            }
        }
    }
    let children = root
        .get_mut("children")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or(HarnessError::ProtocolViolation)?;
    for child in children.values_mut() {
        let files = child
            .as_object_mut()
            .and_then(|child| child.get_mut("files"))
            .and_then(serde_json::Value::as_array_mut)
            .ok_or(HarnessError::ProtocolViolation)?;
        for file in files {
            admit_inspector_candidate(
                file.as_object_mut()
                    .ok_or(HarnessError::ProtocolViolation)?,
                &["candidatePath", "path"],
                session_id,
                project_id,
                cursor,
                true,
                &mut candidates,
            )?;
        }
    }
    if contains_renderer_path_authority(&details) {
        return Err(HarnessError::ProtocolViolation);
    }
    let sanitized = serde_json::to_string(&details).map_err(|_| HarnessError::ProtocolViolation)?;
    if sanitized.chars().count() > 131_072 {
        return Err(HarnessError::ProtocolViolation);
    }
    Ok((sanitized, candidates))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().take(201).count() <= 200
}

fn valid_path(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().take(4097).count() <= 4096
}

fn valid_digest(value: &str) -> bool {
    matches!(value.strip_prefix("sha256:"), Some(digest) if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn valid_command_text(kind: &SessionCommandKind, text: &str) -> bool {
    let length = text.chars().take(131_073).count();
    match kind {
        SessionCommandKind::Abort => text.is_empty(),
        SessionCommandKind::Prompt | SessionCommandKind::Steer | SessionCommandKind::FollowUp => {
            length > 0 && length <= 131_072 && !text.trim().is_empty()
        }
    }
}

fn compatibility_uses_profile(compatibility: &HarnessCompatibility, expected: &str) -> bool {
    match compatibility {
        HarnessCompatibility::Ready { profile, .. }
        | HarnessCompatibility::Degraded { profile, .. } => profile == expected,
        HarnessCompatibility::ReadOnly { .. } | HarnessCompatibility::Unavailable { .. } => true,
    }
}

#[cfg(test)]
mod artifact_candidate_tests {
    use super::*;
    use crate::harness::generated::{CurrentChatUsage, RootSessionState};

    fn snapshot(session_id: &str, project_id: &str, sequence: u64) -> RootSessionSnapshot {
        RootSessionSnapshot {
            session_id: session_id.to_owned(),
            account_id: None,
            project_id: project_id.to_owned(),
            chat_id: format!("chat-{session_id}"),
            cursor: HarnessCursor {
                runtime_generation: "generation-a".to_owned(),
                sequence,
            },
            state: RootSessionState::Idle,
            parent_messages: vec![],
            children: vec![],
            queue: vec![],
            tools: vec![],
            resources: vec![],
            usage: CurrentChatUsage {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 0,
                cost: None,
            },
        }
    }

    fn broker() -> HarnessBroker {
        let mut broker = HarnessBroker::for_tests(
            vec![
                (
                    "session-a".to_owned(),
                    SessionOwnership {
                        account_id: None,
                        project_id: "project-a".to_owned(),
                        chat_id: "chat-session-a".to_owned(),
                    },
                ),
                (
                    "session-b".to_owned(),
                    SessionOwnership {
                        account_id: None,
                        project_id: "project-b".to_owned(),
                        chat_id: "chat-session-b".to_owned(),
                    },
                ),
            ],
            None,
        )
        .unwrap();
        broker.state = BrokerState::Live;
        broker.committed.insert(
            "session-a".to_owned(),
            snapshot("session-a", "project-a", 1),
        );
        broker.committed.insert(
            "session-b".to_owned(),
            snapshot("session-b", "project-b", 1),
        );
        broker
    }

    #[test]
    fn inspector_paths_become_opaque_candidates_before_renderer_projection() {
        let source = r#"{"observedAtMs":1,"startedAtMs":null,"context":null,"contributions":[],"notices":[],"activity":[{"id":"a","occurredAtMs":1,"group":"Tools","kind":"tool","title":"read","detail":"done","tool":{"command":"read","status":"succeeded","durationMs":1,"files":["src/main.ts"]}}],"outputs":[{"id":"o","label":"Report","path":"reports/out.md","kind":"file"}],"sources":[{"id":"s","label":"Rules","detail":"context","kind":"file","candidatePath":"AGENTS.md"}],"children":{}}"#;
        let cursor = HarnessCursor {
            runtime_generation: "generation-a".to_owned(),
            sequence: 1,
        };
        let (sanitized, candidates) =
            sanitize_inspector_artifacts(source, "session-a", "project-a", &cursor).unwrap();
        let value: serde_json::Value = serde_json::from_str(&sanitized).unwrap();
        assert!(!contains_renderer_path_authority(&value));
        assert_eq!(candidates.len(), 3);
        assert!(sanitized.contains("candidateId"));
        assert!(!sanitized.contains("reports/out.md"));
    }

    #[test]
    fn forged_cross_session_and_stale_candidates_are_rejected() {
        let mut broker = broker();
        broker.artifact_candidates.insert(
            "candidate-a".to_owned(),
            ArtifactCandidate {
                session_id: "session-a".to_owned(),
                project_id: "project-a".to_owned(),
                cursor: HarnessCursor {
                    runtime_generation: "generation-a".to_owned(),
                    sequence: 1,
                },
                path: PathBuf::from("src/main.ts"),
                writable: true,
            },
        );
        assert!(broker
            .resolve_artifact_candidate("session-a", "forged")
            .is_err());
        assert!(matches!(
            broker.resolve_artifact_candidate("session-b", "candidate-a"),
            Err(HarnessError::ChronologyViolation)
        ));
        broker
            .committed
            .get_mut("session-a")
            .unwrap()
            .cursor
            .sequence = 2;
        assert!(matches!(
            broker.resolve_artifact_candidate("session-a", "candidate-a"),
            Err(HarnessError::ChronologyViolation)
        ));
    }
}
