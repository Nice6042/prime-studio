use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::compatibility::decide_compatibility;
use super::generated::{
    HarnessCompatibility, HarnessEvent, RootSessionSnapshot, StudioRequest, StudioResponse,
};
pub use super::projections::{BootProjection, ProjectionFreshness, RootSessionProjection};
use super::recovery::{RecoveredSession, RecoveryRecord};
use super::sidecar::{validate_root_snapshot, HarnessError, SidecarHandle};

const TEST_RUNTIME_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_PROFILE: &str = "daemon-v7-schema13";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
    unknown_outcome: bool,
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
            unknown_outcome: false,
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
        _request: AttachRequest,
    ) -> Result<RootSessionProjection, HarnessError> {
        Err(HarnessError::StateViolation)
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
        self.unknown_outcome = false;
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
        let freshness = if self.unknown_outcome {
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

    pub fn mark_unknown_outcome(&mut self) {
        self.unknown_outcome = true;
    }

    pub fn close(&mut self) {
        self.unknown_outcome = false;
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
            if self.ownership.contains_key(&child.id)
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

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_digest(value: &str) -> bool {
    matches!(value.strip_prefix("sha256:"), Some(digest) if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn compatibility_uses_profile(compatibility: &HarnessCompatibility, expected: &str) -> bool {
    match compatibility {
        HarnessCompatibility::Ready { profile, .. }
        | HarnessCompatibility::Degraded { profile, .. } => profile == expected,
        HarnessCompatibility::ReadOnly { .. } | HarnessCompatibility::Unavailable { .. } => true,
    }
}
