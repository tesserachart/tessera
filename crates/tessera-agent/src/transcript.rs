use tessera_core::Timestamp;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{AgentEvent, AgentEventEnvelope, Attachment, TurnEnd};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TranscriptError {
    #[error("turn {0} is still running")]
    TurnOpen(String),
    #[error("no turn is running")]
    NoTurn,
}

#[derive(Clone, Debug)]
pub struct Transcript {
    session: SessionId,
    events: Vec<AgentEventEnvelope>,
    turn: Option<(String, Timestamp, u32)>,
    turns: u32,
}

impl Transcript {
    pub fn new(session: SessionId) -> Self {
        Self {
            session,
            events: Vec::new(),
            turn: None,
            turns: 0,
        }
    }

    pub fn restore(session: SessionId, events: Vec<AgentEventEnvelope>) -> Option<Self> {
        let gapless = events
            .iter()
            .enumerate()
            .all(|(i, e)| e.seq == i as u64 + 1 && e.session_id == session);
        gapless.then(|| Self {
            turns: events
                .iter()
                .filter(|e| matches!(e.event, AgentEvent::TurnStarted { .. }))
                .count() as u32,
            session,
            events,
            turn: None,
        })
    }

    pub fn session(&self) -> &SessionId {
        &self.session
    }

    pub fn events(&self) -> &[AgentEventEnvelope] {
        &self.events
    }

    pub fn since(&self, seq: u64) -> &[AgentEventEnvelope] {
        let start = (seq as usize).min(self.events.len());
        &self.events[start..]
    }

    pub fn current_turn(&self) -> Option<&str> {
        self.turn.as_ref().map(|t| t.0.as_str())
    }

    pub fn push(&mut self, event: AgentEvent, ts: Timestamp) -> &AgentEventEnvelope {
        if let (AgentEvent::ToolCallStarted { .. }, Some(turn)) = (&event, self.turn.as_mut()) {
            turn.2 += 1;
        }
        let env = AgentEventEnvelope {
            session_id: self.session.clone(),
            seq: self.events.len() as u64 + 1,
            ts,
            turn_id: self.turn.as_ref().map(|t| t.0.clone()),
            event,
        };
        self.events.push(env);
        self.events.last().expect("just pushed")
    }

    pub fn begin_turn(
        &mut self,
        user_text: &str,
        attachments: Vec<Attachment>,
        ts: Timestamp,
    ) -> Result<String, TranscriptError> {
        if let Some((id, ..)) = &self.turn {
            return Err(TranscriptError::TurnOpen(id.clone()));
        }
        self.turns += 1;
        let id = format!("{}-t{}", self.session, self.turns);
        self.turn = Some((id.clone(), ts, 0));
        self.push(
            AgentEvent::TurnStarted {
                turn_id: id.clone(),
            },
            ts,
        );
        self.push(
            AgentEvent::UserMessage {
                text: user_text.to_owned(),
                attachments,
            },
            ts,
        );
        Ok(id)
    }

    pub fn steer(
        &mut self,
        user_text: &str,
        attachments: Vec<Attachment>,
        ts: Timestamp,
    ) -> Result<String, TranscriptError> {
        let (id, ..) = self.turn.clone().ok_or(TranscriptError::NoTurn)?;
        self.push(
            AgentEvent::UserMessage {
                text: user_text.to_owned(),
                attachments,
            },
            ts,
        );
        Ok(id)
    }

    pub fn end_turn(
        &mut self,
        end: TurnEnd,
        ts: Timestamp,
    ) -> Result<&AgentEventEnvelope, TranscriptError> {
        let (turn_id, started, calls) = self.turn.clone().ok_or(TranscriptError::NoTurn)?;
        let ev = AgentEvent::TurnFinished {
            turn_id,
            end,
            duration_ms: (ts.0 - started.0) as f64 / 1e6,
            tool_calls: calls,
        };
        self.push(ev, ts);
        self.turn = None;
        Ok(self.events.last().expect("just pushed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ids::CallId;
    use tessera_protocol::tools::RiskTier;

    #[test]
    fn turns_and_sequence_numbers() {
        let mut t = Transcript::new(SessionId::new("S15"));
        let turn = t
            .begin_turn(
                "Test whether QQQ tends to revert after touching Max +Gamma.",
                Vec::new(),
                Timestamp(0),
            )
            .unwrap();
        assert!(t.begin_turn("again", Vec::new(), Timestamp(1)).is_err());
        t.push(
            AgentEvent::ToolCallStarted {
                call_id: CallId::new("call_1"),
                tool: "chart.get_state".into(),
                risk: RiskTier::Read,
                args: serde_json::json!({}),
                title: Some("Read chart context".into()),
            },
            Timestamp(1_000_000),
        );
        let end = t
            .end_turn(TurnEnd::Completed, Timestamp(16_400_000_000))
            .unwrap();
        match &end.event {
            AgentEvent::TurnFinished {
                turn_id,
                duration_ms,
                tool_calls,
                ..
            } => {
                assert_eq!(turn_id, &turn);
                assert_eq!(*tool_calls, 1);
                assert!((duration_ms - 16_400.0).abs() < 1e-6);
            }
            other => panic!("{other:?}"),
        }
        assert!(t.end_turn(TurnEnd::Completed, Timestamp(0)).is_err());
        let seqs: Vec<u64> = t.events().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4]);
        assert_eq!(t.since(2).len(), 2);
        assert!(
            t.events()[..3]
                .iter()
                .all(|e| e.turn_id.as_deref() == Some(turn.as_str()))
        );
        let restored = Transcript::restore(SessionId::new("S15"), t.events().to_vec()).unwrap();
        assert_eq!(restored.events().len(), 4);
        let mut gappy = t.events().to_vec();
        gappy.remove(1);
        assert!(Transcript::restore(SessionId::new("S15"), gappy).is_none());
    }

    #[test]
    fn a_steer_joins_the_running_turn_and_needs_one() {
        let mut t = Transcript::new(SessionId::new("S2"));
        assert_eq!(
            t.steer("and ES?", Vec::new(), Timestamp(0)),
            Err(TranscriptError::NoTurn)
        );
        assert!(t.events().is_empty());
        let turn = t
            .begin_turn("How is NQ?", Vec::new(), Timestamp(0))
            .unwrap();
        assert_eq!(t.steer("and ES?", Vec::new(), Timestamp(1)).unwrap(), turn);
        let last = t.events().last().unwrap();
        assert_eq!(last.turn_id.as_deref(), Some(turn.as_str()));
        assert!(matches!(&last.event, AgentEvent::UserMessage { text, .. } if text == "and ES?"));
        t.end_turn(TurnEnd::Completed, Timestamp(2)).unwrap();
        assert_eq!(
            t.steer("too late", Vec::new(), Timestamp(3)),
            Err(TranscriptError::NoTurn)
        );
        assert_eq!(t.events().len(), 4);
    }

    #[test]
    fn a_users_attachments_are_kept_with_the_message() {
        use tessera_protocol::agent::AttachmentKind;
        let image = Attachment {
            kind: AttachmentKind::Image,
            label: "chart.png".into(),
            reference: None,
            id: Some(format!("att_{}", "a".repeat(32))),
            mime_type: Some("image/png".into()),
            size_bytes: Some(2048),
        };
        let mut t = Transcript::new(SessionId::new("S1"));
        t.begin_turn("What is this?", vec![image.clone()], Timestamp(0))
            .unwrap();
        let user = &t.events()[1];
        let AgentEvent::UserMessage { attachments, .. } = &user.event else {
            panic!("{user:?}")
        };
        assert_eq!(attachments, &vec![image.clone()]);
        let wire = serde_json::to_value(user).unwrap();
        assert_eq!(
            wire["event"]["attachments"][0],
            serde_json::json!({"kind": "image", "label": "chart.png", "id": image.id,
                "mimeType": "image/png", "sizeBytes": 2048})
        );
        let back: AgentEventEnvelope = serde_json::from_value(wire).unwrap();
        assert_eq!(&back, user);
        let store = tessera_store::Store::open_in_memory().unwrap();
        store
            .sessions()
            .upsert(&tessera_protocol::agent::AgentSessionSummary {
                id: SessionId::new("S1"),
                title: "t".into(),
                preset: "Trader".into(),
                provider: "claude-code".into(),
                model: None,
                effort: None,
                thread: None,
                mode: tessera_protocol::tools::SessionMode::AutoModify,
                status: tessera_protocol::agent::AgentSessionStatus::Idle,
                origin: tessera_core::Origin::User,
                source_label: None,
                created_at: Timestamp(0),
                updated_at: Timestamp(0),
                queue: Vec::new(),
                queue_held: false,
            })
            .unwrap();
        store
            .agent_events()
            .append_missing("S1", t.events())
            .unwrap();
        let stored = store.agent_events().list("S1", 0, 10).unwrap();
        let restored = Transcript::restore(SessionId::new("S1"), stored).unwrap();
        assert_eq!(restored.events()[1], *user);
        let old: Attachment = serde_json::from_value(
            serde_json::json!({"kind": "chart_snapshot", "label": "NQ 1m", "reference": null}),
        )
        .unwrap();
        assert_eq!(old.kind, AttachmentKind::ChartSnapshot);
        assert_eq!(old.id, None);
    }
}
