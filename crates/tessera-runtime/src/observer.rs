use std::sync::Arc;

use tessera_core::SharedClock;
use tessera_protocol::tools::{
    ApprovalEvent, DraftInfo, ToolCallEvent, ToolCallPhase, ToolCallRecord,
};
use tessera_protocol::topics::names;
use tessera_store::Store;
use tessera_tools::ToolObserver;
use tokio::sync::{mpsc, oneshot};

use tessera_host::{EventBus, TopicKey};

enum Persist {
    Call(Box<ToolCallRecord>),
    Approval(Box<tessera_protocol::tools::Approval>),
    Draft(Box<DraftInfo>),
    Flush(oneshot::Sender<()>),
}

pub struct RuntimeObserver {
    bus: Arc<EventBus>,
    tx: mpsc::UnboundedSender<Persist>,
    telemetry: std::sync::OnceLock<crate::telemetry::Telemetry>,
}

impl std::fmt::Debug for RuntimeObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeObserver").finish_non_exhaustive()
    }
}

impl RuntimeObserver {
    pub fn set_telemetry(&self, telemetry: crate::telemetry::Telemetry) {
        let _ = self.telemetry.set(telemetry);
    }

    pub fn spawn(bus: Arc<EventBus>, store: Store, clock: SharedClock) -> Arc<Self> {
        let (tx, mut rx) = mpsc::unbounded_channel::<Persist>();
        tokio::spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = vec![first];
                while batch.len() < 256 {
                    match rx.try_recv() {
                        Ok(m) => batch.push(m),
                        Err(_) => break,
                    }
                }
                let store = store.clone();
                let now = clock.now();
                let mut flushes = Vec::new();
                let writes: Vec<Persist> = batch
                    .into_iter()
                    .filter_map(|m| match m {
                        Persist::Flush(done) => {
                            flushes.push(done);
                            None
                        }
                        other => Some(other),
                    })
                    .collect();
                let res = tokio::task::spawn_blocking(
                    move || -> Result<(), tessera_store::StoreError> {
                        for m in writes {
                            match m {
                                Persist::Call(r) => store.tool_calls().upsert(&r)?,
                                Persist::Approval(a) => store.approvals().upsert(&a, now)?,
                                Persist::Draft(d) => store.drafts().upsert(&d, now)?,
                                Persist::Flush(_) => {}
                            }
                        }
                        Ok(())
                    },
                )
                .await;
                for done in flushes {
                    let _ = done.send(());
                }
                match res {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => tracing::error!(error = %e, "audit persistence failed"),
                    Err(e) => tracing::error!(error = %e, "audit writer task failed"),
                }
            }
        });
        Arc::new(Self {
            bus,
            tx,
            telemetry: std::sync::OnceLock::new(),
        })
    }

    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Persist::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }

    fn call_key(rec: &ToolCallRecord) -> TopicKey {
        TopicKey::Call {
            origin: rec.origin.kind_str(),
            session: rec.session_id.as_ref().map(|s| s.to_string()),
        }
    }
}

impl ToolObserver for RuntimeObserver {
    fn call_started(&self, record: &ToolCallRecord) {
        self.bus.publish(
            names::TOOL_CALLS,
            Self::call_key(record),
            &ToolCallEvent {
                phase: ToolCallPhase::Started,
                call: record.clone(),
            },
        );
    }

    fn call_finished(&self, record: &ToolCallRecord) {
        self.bus.publish(
            names::TOOL_CALLS,
            Self::call_key(record),
            &ToolCallEvent {
                phase: ToolCallPhase::Finished,
                call: record.clone(),
            },
        );
        let _ = self.tx.send(Persist::Call(Box::new(record.clone())));
        if let Some(t) = self.telemetry.get() {
            t.tool_call(record);
        }
    }

    fn call_finished_quietly(&self, record: &ToolCallRecord) {
        if let Some(t) = self.telemetry.get() {
            t.tool_call(record);
        }
    }

    fn approval(&self, event: &ApprovalEvent) {
        self.bus.publish(names::APPROVALS, TopicKey::None, event);
        let approval = match event {
            ApprovalEvent::Requested { approval }
            | ApprovalEvent::Resolved { approval }
            | ApprovalEvent::Stale { approval } => Some(approval),
            ApprovalEvent::Snapshot { .. } => None,
        };
        if let Some(a) = approval {
            let _ = self.tx.send(Persist::Approval(Box::new(a.clone())));
        }
    }

    fn draft(&self, draft: &DraftInfo) {
        self.bus.publish(
            names::DRAFTS,
            TopicKey::Account(draft.account.clone()),
            draft,
        );
        let _ = self.tx.send(Persist::Draft(Box::new(draft.clone())));
    }
}
