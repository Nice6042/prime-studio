use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const MAX_ATTENTION_BYTES: usize = 512 * 1024;
const MAX_ATTENTION_RECORDS: usize = 4_096;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionEvidence {
    pub runtime_generation: String,
    pub marker: String,
    pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionChannel {
    Chat,
    Activity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionRecord {
    pub chat_id: String,
    pub chat_seen: Option<AttentionEvidence>,
    pub activity_seen: Option<AttentionEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionSnapshot {
    pub revision: u64,
    pub records: Vec<AttentionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionError {
    InvalidState,
    RevisionConflict,
    EvidenceRegression,
    RevisionOverflow,
    WriteFailed,
}

impl fmt::Display for AttentionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidState => "invalidState",
            Self::RevisionConflict => "revisionConflict",
            Self::EvidenceRegression => "evidenceRegression",
            Self::RevisionOverflow => "revisionOverflow",
            Self::WriteFailed => "writeFailed",
        })
    }
}

impl std::error::Error for AttentionError {}

pub struct AttentionLedger {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AttentionLedger {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Result<AttentionSnapshot, AttentionError> {
        let _guard = self.lock.lock().map_err(|_| AttentionError::InvalidState)?;
        self.load_unlocked()
    }

    pub fn mark_seen(
        &self,
        expected_revision: u64,
        chat_id: &str,
        channel: AttentionChannel,
        evidence: AttentionEvidence,
    ) -> Result<AttentionSnapshot, AttentionError> {
        let _guard = self.lock.lock().map_err(|_| AttentionError::InvalidState)?;
        if !valid_id(chat_id) || !valid_evidence(&evidence) {
            return Err(AttentionError::InvalidState);
        }
        let mut snapshot = self.load_unlocked()?;
        if snapshot.revision != expected_revision {
            return Err(AttentionError::RevisionConflict);
        }
        let index = snapshot
            .records
            .iter()
            .position(|record| record.chat_id == chat_id);
        let prior = index.and_then(|index| match channel {
            AttentionChannel::Chat => snapshot.records[index].chat_seen.as_ref(),
            AttentionChannel::Activity => snapshot.records[index].activity_seen.as_ref(),
        });
        if let Some(prior) = prior {
            if prior == &evidence {
                return Ok(snapshot);
            }
            if prior.runtime_generation == evidence.runtime_generation
                && evidence.occurred_at_ms < prior.occurred_at_ms
            {
                return Err(AttentionError::EvidenceRegression);
            }
        }
        if index.is_none() && snapshot.records.len() >= MAX_ATTENTION_RECORDS {
            return Err(AttentionError::InvalidState);
        }
        let record = if let Some(index) = index {
            &mut snapshot.records[index]
        } else {
            snapshot.records.push(AttentionRecord {
                chat_id: chat_id.to_owned(),
                chat_seen: None,
                activity_seen: None,
            });
            snapshot.records.last_mut().expect("record was appended")
        };
        match channel {
            AttentionChannel::Chat => record.chat_seen = Some(evidence),
            AttentionChannel::Activity => record.activity_seen = Some(evidence),
        }
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_SEQUENCE)
            .ok_or(AttentionError::RevisionOverflow)?;
        snapshot
            .records
            .sort_by(|left, right| left.chat_id.cmp(&right.chat_id));
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    fn load_unlocked(&self) -> Result<AttentionSnapshot, AttentionError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AttentionSnapshot {
                    revision: 0,
                    records: Vec::new(),
                })
            }
            Err(_) => return Err(AttentionError::InvalidState),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_ATTENTION_BYTES as u64
        {
            return Err(AttentionError::InvalidState);
        }
        let bytes = fs::read(&self.path).map_err(|_| AttentionError::InvalidState)?;
        if bytes.len() > MAX_ATTENTION_BYTES {
            return Err(AttentionError::InvalidState);
        }
        let snapshot: AttentionSnapshot =
            serde_json::from_slice(&bytes).map_err(|_| AttentionError::InvalidState)?;
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    fn persist(&self, snapshot: &AttentionSnapshot) -> Result<(), AttentionError> {
        validate_snapshot(snapshot)?;
        let bytes = serde_json::to_vec(snapshot).map_err(|_| AttentionError::InvalidState)?;
        if bytes.len() > MAX_ATTENTION_BYTES {
            return Err(AttentionError::InvalidState);
        }
        let parent = self.path.parent().ok_or(AttentionError::WriteFailed)?;
        fs::create_dir_all(parent).map_err(|_| AttentionError::WriteFailed)?;
        crate::accounts::atomic_replace(&self.path, &bytes).map_err(|_| AttentionError::WriteFailed)
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && !value.chars().any(char::is_control)
        && value.trim() == value
}

fn valid_marker(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_evidence(evidence: &AttentionEvidence) -> bool {
    valid_id(&evidence.runtime_generation)
        && valid_marker(&evidence.marker)
        && evidence.occurred_at_ms <= MAX_SAFE_SEQUENCE
}

fn validate_snapshot(snapshot: &AttentionSnapshot) -> Result<(), AttentionError> {
    if snapshot.revision > MAX_SAFE_SEQUENCE || snapshot.records.len() > MAX_ATTENTION_RECORDS {
        return Err(AttentionError::InvalidState);
    }
    let mut ids = HashSet::with_capacity(snapshot.records.len());
    for record in &snapshot.records {
        if !valid_id(&record.chat_id)
            || !ids.insert(record.chat_id.as_str())
            || record
                .chat_seen
                .as_ref()
                .is_some_and(|evidence| !valid_evidence(evidence))
            || record
                .activity_seen
                .as_ref()
                .is_some_and(|evidence| !valid_evidence(evidence))
        {
            return Err(AttentionError::InvalidState);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(generation: &str, marker: &str, occurred_at_ms: u64) -> AttentionEvidence {
        AttentionEvidence {
            runtime_generation: generation.to_owned(),
            marker: marker.to_owned(),
            occurred_at_ms,
        }
    }

    #[test]
    fn persists_independent_chat_and_activity_evidence_with_revision_cas() {
        let root =
            std::env::temp_dir().join(format!("prime-studio-attention-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("attention-v2.json");
        let ledger = AttentionLedger::new(path.clone());

        let first = ledger
            .mark_seen(
                0,
                "chat-a",
                AttentionChannel::Chat,
                evidence("g1", "answer-1", 300),
            )
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(
            first.records[0].chat_seen,
            Some(evidence("g1", "answer-1", 300))
        );
        assert_eq!(first.records[0].activity_seen, None);
        let second = ledger
            .mark_seen(
                1,
                "chat-a",
                AttentionChannel::Activity,
                evidence(
                    "g1",
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    400,
                ),
            )
            .unwrap();
        assert_eq!(
            second.records[0].chat_seen,
            Some(evidence("g1", "answer-1", 300))
        );
        assert_eq!(
            second.records[0].activity_seen,
            Some(evidence(
                "g1",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                400
            ))
        );
        assert_eq!(AttentionLedger::new(path).load().unwrap(), second);
        assert_eq!(
            ledger
                .mark_seen(
                    1,
                    "chat-a",
                    AttentionChannel::Chat,
                    evidence("g1", "answer-2", 500)
                )
                .unwrap_err(),
            AttentionError::RevisionConflict
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_regression_duplicate_ids_and_oversized_or_corrupt_state() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-attention-invalid-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("attention-v2.json");
        let ledger = AttentionLedger::new(path.clone());
        ledger
            .mark_seen(
                0,
                "chat-a",
                AttentionChannel::Chat,
                evidence("g1", "answer-7", 700),
            )
            .unwrap();
        assert_eq!(
            ledger
                .mark_seen(
                    1,
                    "chat-a",
                    AttentionChannel::Chat,
                    evidence("g1", "answer-6", 600)
                )
                .unwrap_err(),
            AttentionError::EvidenceRegression
        );
        std::fs::write(&path, br#"{"revision":1,"records":[{"chatId":"chat-a","chatSeen":null,"activitySeen":null},{"chatId":"chat-a","chatSeen":null,"activitySeen":null}]}"#).unwrap();
        assert_eq!(ledger.load().unwrap_err(), AttentionError::InvalidState);
        std::fs::write(&path, vec![b'x'; MAX_ATTENTION_BYTES + 1]).unwrap();
        assert_eq!(ledger.load().unwrap_err(), AttentionError::InvalidState);
        std::fs::remove_dir_all(root).unwrap();
    }
}
