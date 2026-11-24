use rust_decimal::Decimal;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use tessera_core::market::{Aggressor, AggressorSource, Trade};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tessera_market::orderflow::big_trades::{AggressorOrder, Grouping, OrderAggregator};
use tessera_protocol::compact::CompactTrade;

use crate::eval::Observation;

pub struct FlowEvents {
    instrument: InstrumentId,
    orders: OrderAggregator,
    decimals: u32,
}

impl FlowEvents {
    pub fn new(instrument: InstrumentId, tick: Price) -> Self {
        Self {
            instrument,
            orders: OrderAggregator::new(tick, Grouping::default()),
            decimals: tick.0.normalize().scale(),
        }
    }

    pub fn print(&mut self, t: &CompactTrade) -> (Observation, Option<Observation>) {
        let print = Observation::print(Timestamp(t.0), t.1, t.2, t.3);
        let trade = Trade {
            instrument: self.instrument.clone(),
            ts: Timestamp(t.0),
            price: Price(Decimal::from_f64(t.1).unwrap_or_default()),
            size: Qty(Decimal::from_f64(t.2).unwrap_or_default()),
            aggressor: Aggressor::from_sign(t.3),
            aggressor_source: AggressorSource::Exchange,
            order_key: t.4,
            source: None,
        };
        (print, self.orders.push(&trade).map(|o| self.order_of(&o)))
    }

    pub fn idle(&mut self) -> Option<Observation> {
        self.orders.finish().map(|o| self.order_of(&o))
    }

    fn order_of(&self, o: &AggressorOrder) -> Observation {
        Observation::order(
            o.t,
            o.average_price()
                .0
                .round_dp(self.decimals)
                .to_f64()
                .unwrap_or(f64::NAN),
            o.size.0.to_f64().unwrap_or(0.0),
            o.aggressor.sign(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::{Feed, Outcome, Tracker};
    use crate::io::{
        Alert, AlertDelivery, AlertLive, AlertOp, AlertRepeat, AlertStatus, AlertStep, EvaluateOn,
        FlowSide, Operand,
    };
    use tessera_core::Timeframe;

    const MS: i64 = 1_000_000;

    fn alert(subject: Operand, size: f64) -> Alert {
        Alert {
            id: "al_flow".into(),
            symbol: "NQ".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            interval: Timeframe::M1,
            steps: vec![AlertStep {
                subject,
                op: AlertOp::AtLeast,
                target: Operand::Value { value: size },
                on: EvaluateOn::Trade,
            }],
            within_bars: None,
            repeat: AlertRepeat::Every,
            cooldown_secs: 0,
            expires_at: None,
            message: None,
            deliver: AlertDelivery::default(),
            ask_analyst: false,
            status: AlertStatus::Active,
            title: String::new(),
            created_by: "user".into(),
            session_id: None,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
            fired_at: None,
            fire_count: 0,
            live: AlertLive::default(),
        }
    }

    fn tape() -> Vec<CompactTrade> {
        let t0 = Timestamp::parse("2026-10-02T14:42:00Z").unwrap().0;
        vec![
            CompactTrade(t0, 20641.25, 4.0, 1, Some(7)),
            CompactTrade(t0 + MS, 20641.50, 30.0, 1, Some(9)),
            CompactTrade(t0 + MS, 20641.75, 25.0, 1, Some(9)),
            CompactTrade(t0 + 3 * MS, 20642.00, 6.0, 1, Some(11)),
            CompactTrade(t0 + 40 * MS, 20641.00, 22.0, -1, Some(12)),
            CompactTrade(t0 + 41 * MS, 20640.75, 3.0, -1, Some(12)),
            CompactTrade(t0 + 900 * MS, 20640.50, 12.0, -1, Some(13)),
        ]
    }

    #[test]
    fn big_trade_alerts_join_prints_as_the_big_trades_layer_does_by_default() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/orderflow/aggregate.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let tick = Price(case["tick"].to_string().parse().unwrap());
            let mut flow = FlowEvents::new(InstrumentId::new("NQZ6.CME").unwrap(), tick);
            let mut got = Vec::new();
            for p in case["prints"].as_array().unwrap() {
                let print = CompactTrade(
                    p[0].as_i64().unwrap(),
                    p[1].as_f64().unwrap(),
                    p[2].as_f64().unwrap(),
                    p[3].as_i64().unwrap() as i8,
                    p.get(4).map(|o| o.as_u64().unwrap() as u32),
                );
                got.extend(flow.print(&print).1);
            }
            got.extend(flow.idle());
            let got: Vec<(i64, f64, i8)> = got.iter().map(|o| (o.at.0, o.size, o.side)).collect();
            let want: Vec<(i64, f64, i8)> = case["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e[0].as_i64().unwrap(),
                        e[2].as_f64().unwrap(),
                        e[3].as_i64().unwrap() as i8,
                    )
                })
                .collect();
            assert_eq!(got, want, "{}", case["name"]);
        }
    }

    fn fires(a: &Alert) -> Vec<(i64, f64, f64)> {
        let mut flow = FlowEvents::new(a.instrument.clone(), Price(Decimal::new(25, 2)));
        let mut t = Tracker::new(a);
        let none = |_: &Operand, _: &Observation| None;
        let mut out = Vec::new();
        let mut seen = |o: Observation, t: &mut Tracker| {
            if let Outcome::Fired(r) = t.observe(a, &o, &none) {
                out.push((o.at.0, o.price, r.subject));
            }
        };
        for p in tape() {
            let (print, order) = flow.print(&p);
            if let Some(order) = order {
                seen(order, &mut t);
            }
            seen(print, &mut t);
        }
        if let Some(order) = flow.idle() {
            seen(order, &mut t);
        }
        out
    }

    #[test]
    fn a_big_trade_at_the_ask_joins_the_orders_prints_and_its_sweep() {
        let at_ask = fires(&alert(
            Operand::BigTrade {
                side: FlowSide::Ask,
            },
            50.0,
        ));
        assert_eq!(at_ask.len(), 1);
        let (_, price, size) = at_ask[0];
        assert_eq!(
            size, 65.0,
            "orders 7, 9 and 11 within 5 ms, each not lower, join as one sweep"
        );
        let average = (4.0 * 20641.25 + 30.0 * 20641.50 + 25.0 * 20641.75 + 6.0 * 20642.00) / 65.0;
        assert_eq!(
            price, 20641.63,
            "its average {average} to the tick's two places"
        );
        assert!(
            fires(&alert(
                Operand::BigTrade {
                    side: FlowSide::Ask
                },
                70.0
            ))
            .is_empty()
        );
    }

    #[test]
    fn a_big_trade_at_the_bid_fires_only_for_sellers() {
        let at_bid = fires(&alert(
            Operand::BigTrade {
                side: FlowSide::Bid,
            },
            25.0,
        ));
        assert_eq!(at_bid.iter().map(|f| f.2).collect::<Vec<_>>(), vec![25.0]);
        let either = fires(&alert(
            Operand::BigTrade {
                side: FlowSide::Either,
            },
            25.0,
        ));
        assert_eq!(
            either.iter().map(|f| f.2).collect::<Vec<_>>(),
            vec![65.0, 25.0]
        );
    }

    #[test]
    fn a_print_alert_reads_each_print_alone() {
        let bid = fires(&alert(
            Operand::Print {
                side: FlowSide::Bid,
            },
            12.0,
        ));
        assert_eq!(
            bid.iter().map(|f| f.2).collect::<Vec<_>>(),
            vec![22.0, 12.0]
        );
        let ask = fires(&alert(
            Operand::Print {
                side: FlowSide::Ask,
            },
            25.0,
        ));
        assert_eq!(
            ask.iter().map(|f| f.2).collect::<Vec<_>>(),
            vec![30.0, 25.0]
        );
        assert_eq!(
            Observation::order(Timestamp(0), 1.0, 1.0, 1).feed,
            Feed::Order
        );
    }
}
