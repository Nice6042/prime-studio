use serde::Serialize;

use super::generated::{
    ChildAgentSummary, ContextSource, CurrentChatUsage, HarnessCompatibility, HarnessCursor,
    ParentMessage, QueueItem, RootSessionSnapshot, RootSessionState, RuntimeIdentity,
    ToolDefinition, WorkerRecoveryProjection,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionFreshness {
    Live,
    Stale,
    Disconnected,
    UnknownOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSessionProjection {
    pub session_id: String,
    pub account_id: Option<String>,
    pub provider: Option<String>,
    pub project_id: String,
    pub chat_id: String,
    pub cursor: HarnessCursor,
    pub state: RootSessionState,
    pub freshness: ProjectionFreshness,
    pub parent_messages: Vec<ParentMessage>,
    pub children: Vec<ChildAgentSummary>,
    pub queue: Vec<QueueItem>,
    pub tools: Vec<ToolDefinition>,
    pub resources: Vec<ContextSource>,
    pub usage: CurrentChatUsage,
    pub worker_recovery: WorkerRecoveryProjection,
}

impl RootSessionProjection {
    pub(crate) fn from_snapshot(
        snapshot: &RootSessionSnapshot,
        freshness: ProjectionFreshness,
    ) -> Self {
        Self {
            session_id: snapshot.session_id.clone(),
            account_id: snapshot.account_id.clone(),
            provider: snapshot.provider.clone(),
            project_id: snapshot.project_id.clone(),
            chat_id: snapshot.chat_id.clone(),
            cursor: snapshot.cursor.clone(),
            state: snapshot.state.clone(),
            freshness,
            parent_messages: snapshot.parent_messages.clone(),
            children: snapshot.children.clone(),
            queue: snapshot.queue.clone(),
            tools: snapshot.tools.clone(),
            resources: snapshot.resources.clone(),
            usage: snapshot.usage.clone(),
            worker_recovery: snapshot.worker_recovery.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootProjection {
    pub compatibility: HarnessCompatibility,
    pub runtime: Option<RuntimeIdentity>,
    pub sessions: Vec<RootSessionProjection>,
}
