use std::collections::{BTreeMap, VecDeque};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::{AccountId, FillId};
use tessera_core::instrument::ContractSpec;
use tessera_core::orders::{Fill, Side};
use tessera_core::{InstrumentId, Money, Price, Qty, Timestamp};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundTrip {
    pub account_id: AccountId,
    pub instrument: InstrumentId,
    pub side: Side,
    pub qty: Qty,
    pub entry_avg: Price,
    pub exit_avg: Price,
    pub opened_at: Timestamp,
    pub closed_at: Timestamp,
    pub trade_date: NaiveDate,
    pub gross_pnl: Money,
    pub fees: Money,
    pub net_pnl: Money,
    pub points: Price,
    pub fills: Vec<FillId>,
    pub executions: Vec<Execution>,
    pub max_qty: Qty,
}

/// What a fill did to a trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionKind {
    /// Opened the trip.
    Entry,
    /// Added to it.
    ScaleIn,
    /// Took part of it off.
    ScaleOut,
    /// Closed it.
    Exit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub fill_id: FillId,
    pub kind: ExecutionKind,
    pub side: Side,
    pub qty: Qty,
    pub price: Price,
    pub ts: Timestamp,
    pub fee: Decimal,
    pub realized: Option<Decimal>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenTrip {
    pub account_id: AccountId,
    pub instrument: InstrumentId,
    pub side: Side,
    pub entered_qty: Qty,
    pub open_qty: Qty,
    pub entry_avg: Price,
    pub exit_avg: Option<Price>,
    pub opened_at: Timestamp,
    pub realized: Decimal,
    pub fees: Decimal,
    pub fills: Vec<FillId>,
    pub executions: Vec<Execution>,
    pub max_qty: Qty,
}

#[derive(Clone, Debug)]
struct Lot {
    qty: Decimal,
    price: Decimal,
}

#[derive(Clone, Debug)]
struct Open {
    side: Side,
    lots: VecDeque<Lot>,
    entered_qty: Decimal,
    entered_value: Decimal,
    exited_qty: Decimal,
    exited_value: Decimal,
    gross: Decimal,
    fees: Decimal,
    opened_at: Timestamp,
    fills: Vec<FillId>,
    executions: Vec<Execution>,
    max_qty: Decimal,
}

impl Open {
    fn held(&self) -> Decimal {
        self.lots.iter().map(|l| l.qty).sum()
    }
}

#[derive(Debug, Default)]
pub struct TradeBuilder {
    open: BTreeMap<(AccountId, InstrumentId), Open>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TradeError {
    #[error("no spec for {0}")]
    MissingSpec(InstrumentId),
    #[error("fee currency mismatch on fill {0}")]
    FeeCurrency(FillId),
}

impl TradeBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn position(&self, account: &AccountId, instrument: &InstrumentId) -> Qty {
        self.open
            .get(&(account.clone(), instrument.clone()))
            .map_or(Qty::ZERO, |o| {
                let q: Decimal = o.lots.iter().map(|l| l.qty).sum();
                Qty(if o.side == Side::Buy { q } else { -q })
            })
    }

    pub fn open_trips(&self) -> Vec<OpenTrip> {
        self.open
            .iter()
            .filter(|(_, o)| !o.lots.is_empty())
            .map(|((account, instrument), o)| OpenTrip {
                account_id: account.clone(),
                instrument: instrument.clone(),
                side: o.side,
                entered_qty: Qty(o.entered_qty),
                open_qty: Qty(o.held()),
                entry_avg: Price(o.entered_value / o.entered_qty),
                exit_avg: (o.exited_qty > Decimal::ZERO)
                    .then(|| Price(o.exited_value / o.exited_qty)),
                opened_at: o.opened_at,
                realized: o.gross,
                fees: o.fees,
                fills: o.fills.clone(),
                executions: o.executions.clone(),
                max_qty: Qty(o.max_qty),
            })
            .collect()
    }

    pub fn apply(
        &mut self,
        fill: &Fill,
        spec: &ContractSpec,
    ) -> Result<Vec<RoundTrip>, TradeError> {
        if spec.instrument != fill.instrument {
            return Err(TradeError::MissingSpec(fill.instrument.clone()));
        }
        if fill.fee.currency != spec.currency {
            return Err(TradeError::FeeCurrency(fill.id.clone()));
        }
        let key = (fill.account_id.clone(), fill.instrument.clone());
        let mut remaining = fill.qty.0.abs();
        let mut done = Vec::new();
        let total = remaining;
        while remaining > Decimal::ZERO {
            let state = self.open.entry(key.clone()).or_insert_with(|| Open {
                side: fill.side,
                lots: VecDeque::new(),
                entered_qty: Decimal::ZERO,
                entered_value: Decimal::ZERO,
                exited_qty: Decimal::ZERO,
                exited_value: Decimal::ZERO,
                gross: Decimal::ZERO,
                fees: Decimal::ZERO,
                opened_at: fill.ts,
                fills: Vec::new(),
                executions: Vec::new(),
                max_qty: Decimal::ZERO,
            });
            let portion = |q: Decimal| fill.fee.amount * q / total;
            if !state.fills.contains(&fill.id) {
                state.fills.push(fill.id.clone());
            }
            if state.side == fill.side || state.lots.is_empty() {
                let kind = if state.executions.is_empty() {
                    ExecutionKind::Entry
                } else {
                    ExecutionKind::ScaleIn
                };
                state.side = fill.side;
                state.lots.push_back(Lot {
                    qty: remaining,
                    price: fill.price.0,
                });
                state.entered_qty += remaining;
                state.entered_value += remaining * fill.price.0;
                state.fees += portion(remaining);
                state.max_qty = state.max_qty.max(state.held());
                state.executions.push(Execution {
                    fill_id: fill.id.clone(),
                    kind,
                    side: fill.side,
                    qty: Qty(remaining),
                    price: fill.price,
                    ts: fill.ts,
                    fee: portion(remaining),
                    realized: None,
                });
                remaining = Decimal::ZERO;
                continue;
            }
            let direction = Decimal::from(state.side.sign());
            let mut used = Decimal::ZERO;
            let mut realized = Decimal::ZERO;
            while remaining > Decimal::ZERO {
                let Some(lot) = state.lots.front_mut() else {
                    break;
                };
                let q = lot.qty.min(remaining);
                let pnl = (fill.price.0 - lot.price) * q * spec.multiplier * direction;
                realized += pnl;
                state.gross += pnl;
                state.exited_qty += q;
                state.exited_value += q * fill.price.0;
                lot.qty -= q;
                remaining -= q;
                used += q;
                if lot.qty.is_zero() {
                    state.lots.pop_front();
                }
            }
            state.fees += portion(used);
            state.executions.push(Execution {
                fill_id: fill.id.clone(),
                kind: if state.lots.is_empty() {
                    ExecutionKind::Exit
                } else {
                    ExecutionKind::ScaleOut
                },
                side: fill.side,
                qty: Qty(used),
                price: fill.price,
                ts: fill.ts,
                fee: portion(used),
                realized: Some(realized),
            });
            if state.lots.is_empty() {
                let o = self.open.remove(&key).expect("state exists");
                let entry_avg = o.entered_value / o.entered_qty;
                let exit_avg = o.exited_value / o.exited_qty;
                let quantize = |p: Decimal| {
                    let mut p = p.round_dp(spec.price_decimals + 4).normalize();
                    if p.scale() < spec.price_decimals {
                        p.rescale(spec.price_decimals);
                    }
                    Price(p)
                };
                done.push(RoundTrip {
                    account_id: fill.account_id.clone(),
                    instrument: fill.instrument.clone(),
                    side: o.side,
                    qty: Qty(o.entered_qty),
                    entry_avg: quantize(entry_avg),
                    exit_avg: quantize(exit_avg),
                    opened_at: o.opened_at,
                    closed_at: fill.ts,
                    trade_date: spec.sessions.trade_date(fill.ts),
                    gross_pnl: Money::new(o.gross, spec.currency).round_cents(),
                    fees: Money::new(o.fees, spec.currency).round_cents(),
                    net_pnl: Money::new(o.gross - o.fees, spec.currency).round_cents(),
                    points: quantize((exit_avg - entry_avg) * Decimal::from(o.side.sign())),
                    fills: o.fills,
                    executions: o.executions,
                    max_qty: Qty(o.max_qty),
                });
            }
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::catalog::Catalog;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn fill(n: u32, inst: &str, side: Side, qty: i64, price: &str, t: &str) -> Fill {
        Fill {
            id: FillId::new(format!("f{n}")),
            broker_fill_id: None,
            order_id: None,
            account_id: AccountId::new("paper-main"),
            instrument: InstrumentId::new(inst).unwrap(),
            side,
            qty: Qty::from(qty),
            price: Price(d(price)),
            ts: Timestamp::parse(t).unwrap(),
            fee: Money::usd(Decimal::ZERO),
            realized_pnl: None,
            source: "paper".into(),
        }
    }

    #[test]
    fn content_sheet_day_reconciles() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let mnq = cat.spec(&InstrumentId::new("MNQZ6.CME").unwrap()).unwrap();
        let qqq = cat.spec(&InstrumentId::new("QQQ").unwrap()).unwrap();
        let mut b = TradeBuilder::new();
        let mut trips = Vec::new();
        let fills = [
            (
                fill(
                    1,
                    "MNQZ6.CME",
                    Side::Buy,
                    2,
                    "20546.00",
                    "2026-10-02T09:49:00-04:00",
                ),
                mnq,
            ),
            (
                fill(
                    2,
                    "MNQZ6.CME",
                    Side::Sell,
                    2,
                    "20601.50",
                    "2026-10-02T10:22:00-04:00",
                ),
                mnq,
            ),
            (
                fill(
                    3,
                    "MNQZ6.CME",
                    Side::Buy,
                    2,
                    "20628.25",
                    "2026-10-02T11:12:00-04:00",
                ),
                mnq,
            ),
            (
                fill(
                    4,
                    "MNQZ6.CME",
                    Side::Sell,
                    2,
                    "20684.75",
                    "2026-10-02T11:41:00-04:00",
                ),
                mnq,
            ),
            (
                fill(
                    5,
                    "QQQ",
                    Side::Sell,
                    100,
                    "489.05",
                    "2026-10-02T13:31:00-04:00",
                ),
                qqq,
            ),
            (
                fill(
                    6,
                    "QQQ",
                    Side::Buy,
                    100,
                    "488.66",
                    "2026-10-02T13:44:00-04:00",
                ),
                qqq,
            ),
        ];
        for (f, spec) in &fills {
            trips.extend(b.apply(f, spec).unwrap());
        }
        let nets: Vec<Decimal> = trips.iter().map(|t| t.net_pnl.amount).collect();
        assert_eq!(nets, vec![d("222.00"), d("226.00"), d("39.00")]);
        assert_eq!(trips[0].points, Price(d("55.50")));
        assert_eq!(trips[2].side, Side::Sell);
        assert_eq!(trips[2].points, Price(d("0.39")));
    }

    #[test]
    fn partial_exits_reversals_and_session_dates() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let nq = cat.spec(&InstrumentId::new("NQZ6.CME").unwrap()).unwrap();
        let mut b = TradeBuilder::new();
        let acct = AccountId::new("paper-main");
        let id = InstrumentId::new("NQZ6.CME").unwrap();
        let mut f1 = fill(
            1,
            "NQZ6.CME",
            Side::Buy,
            1,
            "20600.00",
            "2026-10-01T19:00:00-04:00",
        );
        f1.fee = Money::usd(d("2.10"));
        assert!(b.apply(&f1, nq).unwrap().is_empty());
        let f2 = fill(
            2,
            "NQZ6.CME",
            Side::Buy,
            1,
            "20610.00",
            "2026-10-01T19:05:00-04:00",
        );
        assert!(b.apply(&f2, nq).unwrap().is_empty());
        assert_eq!(b.position(&acct, &id), Qty::from(2));
        let f3 = fill(
            3,
            "NQZ6.CME",
            Side::Sell,
            1,
            "20620.00",
            "2026-10-01T20:00:00-04:00",
        );
        assert!(
            b.apply(&f3, nq).unwrap().is_empty(),
            "partial exit keeps the trip open"
        );
        let f4 = fill(
            4,
            "NQZ6.CME",
            Side::Sell,
            3,
            "20630.00",
            "2026-10-01T21:00:00-04:00",
        );
        let done = b.apply(&f4, nq).unwrap();
        assert_eq!(done.len(), 1);
        let t = &done[0];
        assert_eq!(t.gross_pnl.amount, d("800.00"));
        assert_eq!(t.net_pnl.amount, d("797.90"));
        assert_eq!(t.qty, Qty::from(2));
        assert_eq!(t.trade_date, NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        assert_eq!(b.position(&acct, &id), Qty::from(-2));
        let f5 = fill(
            5,
            "NQZ6.CME",
            Side::Buy,
            2,
            "20640.00",
            "2026-10-02T10:00:00-04:00",
        );
        let done = b.apply(&f5, nq).unwrap();
        assert_eq!(done[0].side, Side::Sell);
        assert_eq!(done[0].gross_pnl.amount, d("-400.00"));
        assert_eq!(b.position(&acct, &id), Qty::ZERO);
        let qqq = cat.spec(&InstrumentId::new("QQQ").unwrap()).unwrap();
        assert!(b.apply(&f5, qqq).is_err());
    }
}
