use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::instrument::ContractSpec;
use tessera_core::orders::{Order, OrderRole, Side, StopRules};
use tessera_core::{InstrumentId, Price};
use tessera_store::Store;
use tokio::time::Instant;

use super::manager::{ProtectionManager, price_words};
use crate::{BrokerError, OrderChanges};

pub const RULE_GAP: Duration = Duration::from_millis(250);
pub const RULE_BACK_OFF: Duration = Duration::from_secs(5);
pub const RULES_KEY: &str = "orders.stop_rules";
const RULES: tessera_store::Kept<Vec<KeptRule>> = tessera_store::Kept::new(RULES_KEY);

type Kept = (AccountId, String);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptRule {
    pub account_id: AccountId,
    pub broker_order_id: String,
    pub rules: StopRules,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mover {
    Unknown,
    Tessera,
    Broker,
}

#[derive(Clone, Debug)]
struct RuleStop {
    kept: Option<Kept>,
    account: AccountId,
    instrument: InstrumentId,
    long: bool,
    stop: Price,
    rules: StopRules,
    mover: Mover,
    sending: bool,
    quiet_until: Option<Instant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleMove {
    pub order: OrderId,
    pub account: AccountId,
    pub instrument: InstrumentId,
    pub from: Price,
    pub to: Price,
    pub breakeven: bool,
}

#[derive(Debug, Default)]
pub struct RuleBook {
    stops: HashMap<OrderId, RuleStop>,
    kept: HashMap<Kept, StopRules>,
    dirty: bool,
}

impl RuleBook {
    pub fn restore(&mut self, kept: Vec<KeptRule>) {
        for k in kept {
            self.kept
                .entry((k.account_id, k.broker_order_id))
                .or_insert(k.rules);
        }
    }

    pub fn take_kept(&mut self) -> Option<Vec<KeptRule>> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        let mut out: Vec<KeptRule> = self
            .kept
            .iter()
            .map(|((account_id, broker_order_id), rules)| KeptRule {
                account_id: account_id.clone(),
                broker_order_id: broker_order_id.clone(),
                rules: *rules,
            })
            .collect();
        out.sort_by(|a, b| a.broker_order_id.cmp(&b.broker_order_id));
        Some(out)
    }

    pub fn unsaved(&mut self) {
        self.dirty = true;
    }

    fn keep(&mut self, id: &OrderId) {
        let Some(s) = self.stops.get(id) else { return };
        let Some(key) = s.kept.clone() else { return };
        let rules = StopRules {
            best_price: None,
            ..s.rules
        };
        if self.kept.get(&key) != Some(&rules) {
            self.kept.insert(key, rules);
            self.dirty = true;
        }
    }

    pub fn track(&mut self, o: &Order) {
        let key = o
            .broker_order_id
            .clone()
            .filter(|b| !b.is_empty())
            .map(|b| (o.request.account_id.clone(), b));
        if !o.status.is_open()
            && let Some(k) = &key
            && self.kept.remove(k).is_some()
        {
            self.dirty = true;
        }
        let working = o.status.is_working() && o.triggered_at.is_none();
        let rules = o
            .stop_rules
            .or_else(|| key.as_ref().and_then(|k| self.kept.get(k).copied()))
            .filter(|r| r.entry_price.is_some());
        let (Some(rules), Some(stop), true) = (rules, o.request.stop_price, working) else {
            self.stops.remove(&o.id);
            return;
        };
        let s = self.stops.entry(o.id.clone()).or_insert_with(|| RuleStop {
            kept: None,
            account: o.request.account_id.clone(),
            instrument: o.request.instrument.clone(),
            long: o.request.side == Side::Sell,
            stop,
            rules,
            mover: Mover::Unknown,
            sending: false,
            quiet_until: None,
        });
        s.stop = stop;
        s.kept = key;
        s.rules = StopRules {
            best_price: s.rules.best_price,
            breakeven_done: s.rules.breakeven_done || rules.breakeven_done,
            ..rules
        };
        self.keep(&o.id);
    }

    pub fn instruments(&self) -> Vec<InstrumentId> {
        let mut out: Vec<InstrumentId> = self
            .stops
            .values()
            .filter(|s| s.mover != Mover::Broker)
            .map(|s| s.instrument.clone())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    pub fn on_trade(
        &mut self,
        instrument: &InstrumentId,
        spec: &ContractSpec,
        price: Price,
        now: Instant,
    ) -> Vec<RuleMove> {
        let mut out = Vec::new();
        for (id, s) in &mut self.stops {
            if &s.instrument != instrument || s.mover == Mover::Broker {
                continue;
            }
            if s.sending || s.quiet_until.is_some_and(|t| now < t) {
                let better = s
                    .rules
                    .best_price
                    .is_none_or(|b| if s.long { price > b } else { price < b });
                if better {
                    s.rules.best_price = Some(price);
                }
                continue;
            }
            let was_done = s.rules.breakeven_done;
            if let Some(to) = s.rules.next_stop(spec, s.long, price, s.stop) {
                s.sending = true;
                out.push(RuleMove {
                    order: id.clone(),
                    account: s.account.clone(),
                    instrument: s.instrument.clone(),
                    from: s.stop,
                    to,
                    breakeven: s.rules.breakeven_done && !was_done,
                });
            }
        }
        out
    }

    fn moved_by_broker(&mut self, order: &OrderId) {
        if let Some(s) = self.stops.get_mut(order) {
            s.mover = Mover::Broker;
            s.sending = false;
            if let Some(k) = s.kept.take()
                && self.kept.remove(&k).is_some()
            {
                self.dirty = true;
            }
        }
    }

    fn moved(&mut self, m: &RuleMove, now: Instant) {
        if let Some(s) = self.stops.get_mut(&m.order) {
            s.mover = Mover::Tessera;
            s.sending = false;
            s.stop = m.to;
            s.quiet_until = Some(now + RULE_GAP);
        }
        self.keep(&m.order);
    }

    fn refused(&mut self, m: &RuleMove, now: Instant) {
        if let Some(s) = self.stops.get_mut(&m.order) {
            s.sending = false;
            if m.breakeven {
                s.rules.breakeven_done = false;
            }
            s.quiet_until = Some(now + RULE_BACK_OFF);
        }
    }
}

impl ProtectionManager {
    pub fn rule_instruments(&self) -> Vec<InstrumentId> {
        self.rule_book().lock().instruments()
    }

    pub async fn keep_rules_in(&self, store: Store) {
        let s = store.clone();
        match tokio::task::spawn_blocking(move || s.settings().load(&RULES)).await {
            Ok(Ok(Some(kept))) => self.rule_book().lock().restore(kept),
            Ok(Ok(None)) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "cannot read the stop rules"),
            Err(e) => tracing::warn!(error = %e, "cannot read the stop rules"),
        }
        let _ = self.rule_store().set(store);
    }

    pub(super) async fn save_rules(&self) {
        let Some(store) = self.rule_store().get().cloned() else {
            return;
        };
        let Some(kept) = self.rule_book().lock().take_kept() else {
            return;
        };
        let now = self.clock().now();
        let failed =
            match tokio::task::spawn_blocking(move || store.settings().keep(&RULES, &kept, now))
                .await
            {
                Ok(Ok(())) => return,
                Ok(Err(e)) => e.to_string(),
                Err(e) => e.to_string(),
            };
        tracing::warn!(error = %failed, "cannot keep the stop rules; trying again");
        self.rule_book().lock().unsaved();
    }

    pub fn on_trade(
        self: &Arc<Self>,
        instrument: &InstrumentId,
        spec: &ContractSpec,
        price: Price,
    ) {
        let moves = self
            .rule_book()
            .lock()
            .on_trade(instrument, spec, price, Instant::now());
        for m in moves {
            let me = Arc::clone(self);
            tokio::spawn(async move { me.apply_rule(m).await });
        }
    }

    pub async fn apply_rule(&self, m: RuleMove) {
        let b = self.broker();
        let caps = b
            .provider()
            .connection_of(&m.account)
            .await
            .map(|c| c.capabilities);
        if let Ok(c) = &caps
            && c.stop_rules
        {
            self.rule_book().lock().moved_by_broker(&m.order);
            return;
        }
        if caps.as_ref().is_ok_and(|c| c.read_only) {
            self.rule_book().lock().refused(&m, Instant::now());
            return;
        }
        let started = self.clock().now();
        let timer = Instant::now();
        let changes = OrderChanges {
            stop_price: Some(m.to),
            ..OrderChanges::default()
        };
        let r = match caps {
            Err(e) => Err(e),
            Ok(_) => b.modify(&m.account, &m.order, changes).await,
        };
        let key = (m.account.clone(), m.instrument.clone());
        let rule = if m.breakeven { "breakeven" } else { "trailing" };
        let input = json!({
            "accountId": m.account,
            "instrument": m.instrument,
            "mode": "rules",
            "merge": false,
            "orders": [m.order.to_string()],
            "entries": [],
            "steps": [{
                "action": "move", "orderId": m.order, "role": OrderRole::StopLoss,
                "from": m.from, "to": m.to, "rule": rule,
            }],
        });
        match r {
            Ok(_) => {
                self.rule_book().lock().moved(&m, Instant::now());
                let text = if m.breakeven {
                    format!("Moved the stop to breakeven, {}", price_words(m.to))
                } else {
                    format!("Trailed the stop to {}", price_words(m.to))
                };
                self.record(&key, input, &text, None, started, timer);
            }
            Err(e) => {
                self.rule_book().lock().refused(&m, Instant::now());
                let text = refused_words(&m, &e);
                let call = self.record(&key, input, &text, Some(&e), started, timer);
                self.note(&key, &text, false, &call);
            }
        }
    }
}

fn refused_words(m: &RuleMove, e: &BrokerError) -> String {
    let why = match e {
        BrokerError::Rejected(w) | BrokerError::Unavailable(w) | BrokerError::Unsupported(w) => {
            w.trim_end_matches('.').to_owned()
        }
        other => other.to_string(),
    };
    let what = if m.breakeven {
        "move the stop to breakeven"
    } else {
        "trail the stop"
    };
    format!(
        "Could not {what} ({}): {why}. It stays at {}",
        price_words(m.to),
        price_words(m.from)
    )
}

#[cfg(test)]
mod tests;
