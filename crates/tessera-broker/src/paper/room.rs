use rust_decimal::Decimal;
use tessera_core::orders::{CheckSeverity, PreTradeCheck, Side};

use super::engine::{count_label, usd};

// AMP Futures' default most contracts a retail account may hold (ampfutures.com/trading-info/position-limits).
const MAX_ORDER: [(&str, i64); 4] = [("ES", 100), ("NQ", 100), ("MES", 500), ("MNQ", 500)];

const MAX_ORDER_ELSEWHERE: i64 = 100;

pub fn max_order_qty(root: &str) -> Decimal {
    let root = root.trim();
    let most = MAX_ORDER
        .iter()
        .find(|(r, _)| r.eq_ignore_ascii_case(root))
        .map_or(MAX_ORDER_ELSEWHERE, |(_, n)| *n);
    Decimal::from(most)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stake {
    pub held: Decimal,
    pub buys: Decimal,
    pub sells: Decimal,
}

impl Stake {
    pub fn add(&mut self, side: Side, qty: Decimal) {
        match side {
            Side::Buy => self.buys += qty,
            Side::Sell => self.sells += qty,
        }
    }

    pub fn contracts(&self) -> Decimal {
        (self.held + self.buys)
            .abs()
            .max((self.held - self.sells).abs())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Margining {
    PerContract,
    Unknown,
    NotFuture,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opening {
    pub product: String,
    pub qty: Decimal,
    pub opening: Decimal,
    pub max_order: Option<Decimal>,
    pub margining: Margining,
    pub net_liq: Decimal,
    pub margin_before: Decimal,
    pub margin_after: Decimal,
}

impl Opening {
    pub fn buying_power(&self) -> Decimal {
        self.net_liq - self.margin_before
    }

    pub fn added_margin(&self) -> Decimal {
        self.margin_after - self.margin_before
    }

    pub fn refusals(&self, outcome: &str) -> Vec<PreTradeCheck> {
        let mut out = Vec::new();
        if self.opening <= Decimal::ZERO {
            return out;
        }
        let block = |code: &str, message: String| PreTradeCheck {
            code: code.into(),
            severity: CheckSeverity::Block,
            message,
        };
        let power = self.buying_power();
        let added = self.added_margin();
        match self.margining {
            Margining::PerContract
                if added > Decimal::ZERO && self.margin_after > self.net_liq =>
            {
                let verb = if self.qty == Decimal::ONE {
                    "needs"
                } else {
                    "need"
                };
                out.push(block(
                    "paper_margin",
                    format!(
                        "{} {} {verb} {} of margin; the account has {} of buying power. {outcome}",
                        count_label(self.qty),
                        self.product,
                        usd(added),
                        usd(power.max(Decimal::ZERO)),
                    ),
                ));
            }
            Margining::Unknown => out.push(block(
                "paper_margin_unknown",
                format!(
                    "Paper has no margin for {}, so it does not open positions in it. Exits work. {outcome}",
                    self.product
                ),
            )),
            Margining::NotFuture if power <= Decimal::ZERO => out.push(block(
                "paper_buying_power",
                format!(
                    "The account has no buying power ({}): no new positions. Exits work. {outcome}",
                    usd(power)
                ),
            )),
            Margining::PerContract | Margining::NotFuture => {}
        }
        if let Some(most) = self.max_order.filter(|most| self.opening > *most) {
            out.push(block(
                "paper_order_qty",
                format!(
                    "{} {} in one order: paper takes at most {} {} an order. {outcome}",
                    count_label(self.opening),
                    self.product,
                    count_label(most),
                    self.product,
                ),
            ));
        }
        out
    }
}
