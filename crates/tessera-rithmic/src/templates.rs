use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

pub const PAPER_SYSTEMS: [&str; 2] = ["Rithmic Paper Trading", "Rithmic Test"];

pub const ACCOUNT_READ: [i32; 22] = [
    300, 302, 304, 306, 308, 310, 318, 320, 322, 324, 326, 336, 338, 340, 342, 3502, 3506, 3508,
    3510, 3512, 400, 402,
];

pub const ORDER_ENTRY: [i32; 11] = [312, 314, 316, 328, 330, 332, 334, 344, 346, 3500, 3504];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Template {
    Login,
    Logout,
    ReferenceData,
    SystemInfo,
    Heartbeat,
    MarketDataUpdate,
    SearchSymbols,
    FrontMonthContract,
    DepthByOrderSnapshot,
    DepthByOrderUpdates,
    TimeBarUpdate,
    TimeBarReplay,
    TickBarReplay,
    AccountRead(i32),
    OrderEntry(i32),
}

impl Template {
    pub fn id(self) -> i32 {
        match self {
            Template::Login => 10,
            Template::Logout => 12,
            Template::ReferenceData => 14,
            Template::SystemInfo => 16,
            Template::Heartbeat => 18,
            Template::MarketDataUpdate => 100,
            Template::SearchSymbols => 109,
            Template::FrontMonthContract => 113,
            Template::DepthByOrderSnapshot => 115,
            Template::DepthByOrderUpdates => 117,
            Template::TimeBarUpdate => 200,
            Template::TimeBarReplay => 202,
            Template::TickBarReplay => 206,
            Template::AccountRead(id) | Template::OrderEntry(id) => id,
        }
    }

    pub fn is_order_entry(self) -> bool {
        ORDER_ENTRY.contains(&self.id())
    }

    fn is_known(self) -> bool {
        match self {
            Template::AccountRead(id) => ACCOUNT_READ.contains(&id),
            Template::OrderEntry(id) => ORDER_ENTRY.contains(&id),
            _ => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GateRefused {
    #[error("template {0} (order entry) is refused: paper routing is not enabled")]
    RoutingDisabled(i32),
    #[error("template {0} (order entry) is refused: order entry is off for this account")]
    OrderEntryOff(i32),
    #[error("template {0} is not on the allowlist")]
    NotAllowed(i32),
    #[error("Rithmic ended the session (ForcedLogout); reconnect to continue")]
    Closed,
}

#[derive(Debug)]
pub struct TemplateGate {
    system: String,
    paper_routing: AtomicBool,
    order_entry: Mutex<BTreeSet<String>>,
    closed: AtomicBool,
    counts: Mutex<BTreeMap<i32, u64>>,
}

impl TemplateGate {
    pub fn new(system: impl Into<String>) -> Self {
        Self {
            system: system.into(),
            paper_routing: AtomicBool::new(false),
            order_entry: Mutex::new(BTreeSet::new()),
            closed: AtomicBool::new(false),
            counts: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn system(&self) -> &str {
        &self.system
    }

    pub fn is_paper_system(&self) -> bool {
        PAPER_SYSTEMS.contains(&self.system.as_str())
    }

    pub fn is_per_account(&self) -> bool {
        !self.is_paper_system()
    }

    pub fn set_account_order_entry(&self, account: &str, enabled: bool) -> Result<(), GateRefused> {
        if !enabled {
            self.order_entry.lock().remove(account);
            return Ok(());
        }
        if !self.is_per_account() {
            return Err(GateRefused::RoutingDisabled(312));
        }
        self.order_entry.lock().insert(account.to_owned());
        Ok(())
    }

    pub fn account_order_entry(&self, account: &str) -> bool {
        self.order_entry.lock().contains(account)
    }

    pub fn order_entry_accounts(&self) -> Vec<String> {
        self.order_entry.lock().iter().cloned().collect()
    }

    pub fn set_paper_routing(&self, enabled: bool) {
        self.paper_routing.store(enabled, Ordering::SeqCst);
    }

    pub fn paper_routing(&self) -> bool {
        self.paper_routing.load(Ordering::SeqCst)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    pub fn reopen(&self) {
        self.closed.store(false, Ordering::SeqCst);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn check(&self, template: Template) -> Result<(), GateRefused> {
        self.check_for(template, None)
    }

    pub fn check_for(&self, template: Template, account: Option<&str>) -> Result<(), GateRefused> {
        if self.is_closed() && template != Template::Login {
            return Err(GateRefused::Closed);
        }
        if template.is_order_entry() {
            if self.is_paper_system() {
                if !self.paper_routing.load(Ordering::SeqCst) {
                    return Err(GateRefused::RoutingDisabled(template.id()));
                }
            } else if !account.is_some_and(|a| self.account_order_entry(a)) {
                return Err(GateRefused::OrderEntryOff(template.id()));
            }
        } else if !template.is_known() {
            return Err(GateRefused::NotAllowed(template.id()));
        }
        Ok(())
    }

    pub fn allow(&self, template: Template) -> Result<(), GateRefused> {
        self.allow_for(template, None)
    }

    pub fn allow_for(&self, template: Template, account: Option<&str>) -> Result<(), GateRefused> {
        self.check_for(template, account)?;
        *self.counts.lock().entry(template.id()).or_default() += 1;
        Ok(())
    }

    pub fn counts(&self) -> BTreeMap<i32, u64> {
        self.counts.lock().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prop_system_sends_only_for_an_account_turned_on() {
        let g = TemplateGate::new("Apex");
        g.set_paper_routing(true);
        assert!(g.allow(Template::MarketDataUpdate).is_ok());
        assert!(g.allow(Template::AccountRead(302)).is_ok());
        assert_eq!(
            g.allow_for(Template::OrderEntry(312), Some("rithmic-apex-a")),
            Err(GateRefused::OrderEntryOff(312))
        );
        g.set_account_order_entry("rithmic-apex-a", true).unwrap();
        assert_eq!(
            g.allow(Template::OrderEntry(312)),
            Err(GateRefused::OrderEntryOff(312))
        );
        assert_eq!(
            g.allow_for(Template::OrderEntry(312), Some("rithmic-apex-b")),
            Err(GateRefused::OrderEntryOff(312))
        );
        assert_eq!(g.counts().get(&312), None);
        assert!(
            g.allow_for(Template::OrderEntry(312), Some("rithmic-apex-a"))
                .is_ok()
        );
        assert_eq!(g.counts()[&312], 1);
        assert_eq!(g.order_entry_accounts(), ["rithmic-apex-a"]);
        g.set_account_order_entry("rithmic-apex-a", false).unwrap();
        assert_eq!(
            g.allow_for(Template::OrderEntry(316), Some("rithmic-apex-a")),
            Err(GateRefused::OrderEntryOff(316))
        );
        assert_eq!(g.counts()[&100], 1);
    }

    #[test]
    fn every_other_system_sends_for_an_account_turned_on_and_no_other() {
        for system in [
            "Rithmic 01",
            "Rithmic 04 Colo",
            "Tradeify-Test",
            "tradesea",
            "Apex",
            "SomeNewFirm",
        ] {
            let g = TemplateGate::new(system);
            assert!(g.is_per_account(), "{system}");
            g.set_paper_routing(true);
            for id in ORDER_ENTRY {
                assert_eq!(
                    g.allow_for(Template::OrderEntry(id), Some("acct")),
                    Err(GateRefused::OrderEntryOff(id)),
                    "{system}"
                );
            }
            g.set_account_order_entry("acct", true).unwrap();
            for id in ORDER_ENTRY {
                assert!(
                    g.allow_for(Template::OrderEntry(id), Some("acct")).is_ok(),
                    "{system} {id}"
                );
                assert_eq!(
                    g.allow_for(Template::OrderEntry(id), Some("other")),
                    Err(GateRefused::OrderEntryOff(id)),
                    "{system}"
                );
            }
        }
    }

    #[test]
    fn a_paper_system_has_no_per_account_switch() {
        let g = TemplateGate::new("Rithmic Test");
        assert!(g.set_account_order_entry("acct", true).is_err());
        assert!(!g.account_order_entry("acct"));
    }

    #[test]
    fn paper_systems_need_the_users_switch() {
        let g = TemplateGate::new("Rithmic Paper Trading");
        assert_eq!(
            g.allow(Template::OrderEntry(312)),
            Err(GateRefused::RoutingDisabled(312))
        );
        g.set_paper_routing(true);
        assert!(g.allow(Template::OrderEntry(312)).is_ok());
        assert!(!TemplateGate::new("rithmic test").is_paper_system());
    }

    #[test]
    fn the_gate_reads_the_id_not_the_label() {
        let g = TemplateGate::new("Rithmic 01");
        for id in ORDER_ENTRY {
            assert_eq!(
                g.allow(Template::AccountRead(id)),
                Err(GateRefused::OrderEntryOff(id))
            );
        }
        let prop = TemplateGate::new("Apex");
        prop.set_account_order_entry("acct", true).unwrap();
        for id in ORDER_ENTRY {
            assert_eq!(
                prop.allow(Template::AccountRead(id)),
                Err(GateRefused::OrderEntryOff(id))
            );
        }
        for id in [504, 508, 999] {
            assert_eq!(
                g.allow(Template::AccountRead(id)),
                Err(GateRefused::NotAllowed(id))
            );
        }
        assert_eq!(
            g.allow(Template::OrderEntry(302)),
            Err(GateRefused::NotAllowed(302))
        );
        for id in ACCOUNT_READ {
            assert!(g.allow(Template::AccountRead(id)).is_ok(), "{id}");
            assert!(!Template::AccountRead(id).is_order_entry());
        }
        assert!(g.counts().keys().all(|id| !ORDER_ENTRY.contains(id)));
        let both: Vec<_> = ACCOUNT_READ
            .iter()
            .filter(|id| ORDER_ENTRY.contains(id))
            .collect();
        assert!(both.is_empty());
    }

    #[test]
    fn a_closed_gate_refuses_everything_but_a_new_login() {
        let g = TemplateGate::new("Apex");
        g.close();
        assert_eq!(g.allow(Template::TimeBarReplay), Err(GateRefused::Closed));
        assert!(g.allow(Template::Login).is_ok());
        g.reopen();
        assert!(g.allow(Template::TimeBarReplay).is_ok());
    }
}
