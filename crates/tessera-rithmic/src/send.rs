use async_trait::async_trait;
use rithmic_rs::{
    RithmicBracketLevelAdjustment, RithmicBracketOrder, RithmicCancelAllOrders, RithmicCancelOrder,
    RithmicError, RithmicExitPosition, RithmicLinkOrders, RithmicModifyOrder,
    RithmicModifyOrderReferenceData, RithmicOcoOrder, RithmicOrder, RithmicOrderPlantHandle,
    RithmicResponse,
};

use crate::templates::{GateRefused, Template, TemplateGate};

#[derive(Debug, Clone, PartialEq)]
pub enum OrderEntry {
    New(Box<RithmicOrder>),
    Modify(Box<RithmicModifyOrder>),
    Cancel(RithmicCancelOrder),
    Oco(Box<RithmicOcoOrder>),
    Bracket(Box<RithmicBracketOrder>),
    BracketTarget(RithmicBracketLevelAdjustment),
    BracketStop(RithmicBracketLevelAdjustment),
    Link(RithmicLinkOrders),
    CancelAll(RithmicCancelAllOrders),
    ReferenceData(RithmicModifyOrderReferenceData),
    Exit(RithmicExitPosition),
}

impl OrderEntry {
    pub fn template(&self) -> Template {
        Template::OrderEntry(match self {
            OrderEntry::New(_) => 312,
            OrderEntry::Modify(_) => 314,
            OrderEntry::Cancel(_) => 316,
            OrderEntry::Oco(_) => 328,
            OrderEntry::Bracket(_) => 330,
            OrderEntry::BracketTarget(_) => 332,
            OrderEntry::BracketStop(_) => 334,
            OrderEntry::Link(_) => 344,
            OrderEntry::CancelAll(_) => 346,
            OrderEntry::ReferenceData(_) => 3500,
            OrderEntry::Exit(_) => 3504,
        })
    }
}

#[derive(Debug)]
pub struct Passed {
    _gate: (),
}

#[async_trait]
pub trait OrderWire: Send + Sync {
    fn account(&self) -> &str;

    async fn write(
        &self,
        passed: Passed,
        entry: OrderEntry,
    ) -> Result<Vec<RithmicResponse>, RithmicError>;
}

#[derive(Debug, Clone)]
pub struct AccountOrders {
    account: String,
    handle: RithmicOrderPlantHandle,
}

impl AccountOrders {
    pub fn new(account: &tessera_core::ids::AccountId, handle: RithmicOrderPlantHandle) -> Self {
        Self {
            account: account.as_str().to_owned(),
            handle,
        }
    }

    pub fn reads(&self) -> &RithmicOrderPlantHandle {
        &self.handle
    }
}

#[async_trait]
impl OrderWire for AccountOrders {
    fn account(&self) -> &str {
        &self.account
    }

    async fn write(
        &self,
        _passed: Passed,
        entry: OrderEntry,
    ) -> Result<Vec<RithmicResponse>, RithmicError> {
        let h = &self.handle;
        match entry {
            OrderEntry::New(o) => h.place_order(*o).await,
            OrderEntry::Modify(o) => h.modify_order(*o).await,
            OrderEntry::Cancel(o) => h.cancel_order(o).await,
            OrderEntry::Oco(o) => h.place_oco_order(*o).await,
            OrderEntry::Bracket(o) => h.place_bracket_order(*o).await,
            OrderEntry::BracketTarget(a) => h.adjust_target(a).await.map(|r| vec![r]),
            OrderEntry::BracketStop(a) => h.adjust_stop(a).await.map(|r| vec![r]),
            OrderEntry::Link(l) => h.link_orders(l).await.map(|r| vec![r]),
            OrderEntry::CancelAll(c) => h.cancel_all_orders(c).await.map(|r| vec![r]),
            OrderEntry::ReferenceData(d) => h.modify_order_reference_data(d).await.map(|r| vec![r]),
            OrderEntry::Exit(e) => h.exit_position(e).await,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error(transparent)]
    Refused(#[from] GateRefused),
    #[error(transparent)]
    Wire(#[from] RithmicError),
}

pub async fn send_order(
    gate: &TemplateGate,
    wire: &dyn OrderWire,
    entry: OrderEntry,
) -> Result<Vec<RithmicResponse>, SendError> {
    gate.allow_for(entry.template(), Some(wire.account()))?;
    Ok(wire.write(Passed { _gate: () }, entry).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    use crate::templates::ORDER_ENTRY;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Template>>);

    const ACCT: &str = "rithmic-apex-0123456789ab";

    #[async_trait]
    impl OrderWire for Recorder {
        fn account(&self) -> &str {
            ACCT
        }

        async fn write(
            &self,
            _: Passed,
            entry: OrderEntry,
        ) -> Result<Vec<RithmicResponse>, RithmicError> {
            self.0.lock().push(entry.template());
            Ok(vec![])
        }
    }

    fn every_entry() -> Vec<OrderEntry> {
        vec![
            OrderEntry::New(Box::default()),
            OrderEntry::Modify(Box::default()),
            OrderEntry::Cancel(RithmicCancelOrder::default()),
            OrderEntry::Oco(Box::default()),
            OrderEntry::Bracket(Box::default()),
            OrderEntry::BracketTarget(RithmicBracketLevelAdjustment::default()),
            OrderEntry::BracketStop(RithmicBracketLevelAdjustment::default()),
            OrderEntry::Link(RithmicLinkOrders::default()),
            OrderEntry::CancelAll(RithmicCancelAllOrders::default()),
            OrderEntry::ReferenceData(RithmicModifyOrderReferenceData::default()),
            OrderEntry::Exit(RithmicExitPosition::default()),
        ]
    }

    const WRITES: [&str; 13] = [
        ".place_order(",
        ".modify_order(",
        ".cancel_order(",
        ".place_oco_order(",
        ".place_bracket_order(",
        ".adjust_target(",
        ".adjust_stop(",
        ".link_orders(",
        ".cancel_all_orders(",
        ".modify_order_reference_data(",
        ".exit_position(",
        ".accept_agreement(",
        ".set_rithmic_mrkt_data_self_cert_status(",
    ];

    #[test]
    fn no_other_code_calls_an_order_entry_method() {
        fn scan(dir: &std::path::Path, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    scan(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && !path.ends_with("src/send.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    for w in WRITES {
                        if text.contains(w) {
                            hits.push(format!("{} calls {w}", path.display()));
                        }
                    }
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut hits = Vec::new();
        for dir in ["src", "examples", "tests"] {
            if root.join(dir).is_dir() {
                scan(&root.join(dir), &mut hits);
            }
        }
        assert!(
            hits.is_empty(),
            "order entry outside the send point: {hits:?}"
        );
    }

    #[test]
    fn every_order_template_has_an_entry() {
        let mut ids: Vec<i32> = every_entry().iter().map(|e| e.template().id()).collect();
        ids.sort_unstable();
        let mut all = ORDER_ENTRY.to_vec();
        all.sort_unstable();
        assert_eq!(ids, all);
    }

    #[tokio::test]
    async fn nothing_is_written_for_a_prop_account_left_off() {
        let gate = TemplateGate::new("Apex");
        gate.set_paper_routing(true);
        gate.set_account_order_entry("rithmic-apex-other", true)
            .unwrap();
        let wire = Recorder::default();
        for entry in every_entry() {
            let id = entry.template().id();
            let refused = send_order(&gate, &wire, entry).await;
            assert!(
                matches!(
                    refused,
                    Err(SendError::Refused(GateRefused::OrderEntryOff(template))) if template == id
                ),
                "{id}: {refused:?}"
            );
        }
        assert!(wire.0.lock().is_empty(), "nothing reaches the wire");
        assert!(gate.counts().is_empty(), "nothing is counted as sent");
    }

    #[tokio::test]
    async fn a_prop_account_turned_on_is_written_and_off_again_is_not() {
        let gate = TemplateGate::new("Apex");
        let wire = Recorder::default();
        gate.set_account_order_entry(ACCT, true).unwrap();
        for entry in every_entry() {
            assert!(send_order(&gate, &wire, entry).await.is_ok());
        }
        assert_eq!(wire.0.lock().len(), ORDER_ENTRY.len());
        gate.set_account_order_entry(ACCT, false).unwrap();
        for entry in every_entry() {
            assert!(send_order(&gate, &wire, entry).await.is_err());
        }
        assert_eq!(wire.0.lock().len(), ORDER_ENTRY.len());
        gate.set_account_order_entry(ACCT, true).unwrap();
        gate.close();
        assert!(matches!(
            send_order(
                &gate,
                &wire,
                OrderEntry::Cancel(RithmicCancelOrder::default())
            )
            .await,
            Err(SendError::Refused(GateRefused::Closed))
        ));
        assert_eq!(wire.0.lock().len(), ORDER_ENTRY.len());
    }

    #[tokio::test]
    async fn a_live_system_writes_only_for_an_account_turned_on() {
        for system in ["Rithmic 01", "Rithmic 04 Colo", "SomeNewSystem"] {
            let gate = TemplateGate::new(system);
            let wire = Recorder::default();
            gate.set_paper_routing(true);
            for entry in every_entry() {
                assert!(
                    matches!(
                        send_order(&gate, &wire, entry).await,
                        Err(SendError::Refused(GateRefused::OrderEntryOff(_)))
                    ),
                    "{system}"
                );
            }
            assert!(wire.0.lock().is_empty(), "{system}");
            gate.set_account_order_entry(ACCT, true).unwrap();
            for entry in every_entry() {
                assert!(send_order(&gate, &wire, entry).await.is_ok(), "{system}");
            }
            assert_eq!(wire.0.lock().len(), ORDER_ENTRY.len(), "{system}");
        }
    }

    #[tokio::test]
    async fn paper_systems_send_only_with_routing_on() {
        for system in ["Rithmic Paper Trading", "Rithmic Test"] {
            let gate = TemplateGate::new(system);
            let wire = Recorder::default();
            for entry in every_entry() {
                assert!(matches!(
                    send_order(&gate, &wire, entry).await,
                    Err(SendError::Refused(GateRefused::RoutingDisabled(_)))
                ));
            }
            assert!(wire.0.lock().is_empty());

            gate.set_paper_routing(true);
            for entry in every_entry() {
                assert!(send_order(&gate, &wire, entry).await.is_ok());
            }
            assert_eq!(wire.0.lock().len(), ORDER_ENTRY.len());

            gate.close();
            let before = wire.0.lock().len();
            for entry in every_entry() {
                assert!(matches!(
                    send_order(&gate, &wire, entry).await,
                    Err(SendError::Refused(GateRefused::Closed))
                ));
            }
            assert_eq!(wire.0.lock().len(), before);
        }
    }
}
