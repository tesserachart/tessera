use rust_decimal::Decimal;
use tessera_core::ids::OrderId;
use tessera_core::instrument::ContractSpec;
use tessera_core::money::Rounding;
use tessera_core::orders::{Order, OrderRole, OrderStatus, OrderType, Position, Side};
use tessera_core::{Price, Qty};

use super::manager::price_words;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Touch {
    pub bid: Option<Price>,
    pub ask: Option<Price>,
    pub last: Option<Price>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BreakevenAsk {
    pub spec: ContractSpec,
    pub offset_ticks: Option<u32>,
    pub touch: Touch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub order: OrderId,
    pub from: Price,
    pub to: Price,
    pub limit: Option<Price>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BreakevenPlan {
    pub side: Side,
    pub entry: Price,
    pub offset_ticks: u32,
    pub price: Price,
    pub moves: Vec<Move>,
    pub kept: usize,
    pub new_stop: Option<Qty>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    NoPosition,
    OnItsWay,
    AlreadyThere {
        price: Price,
        stops: usize,
    },
    NoPrice {
        stays: Vec<Price>,
    },
    NotPassed {
        price: Price,
        offset_ticks: u32,
        stays: Vec<Price>,
    },
}

impl Refused {
    pub fn words(&self, symbol: &str) -> String {
        let stay = |stays: &[Price]| match stays {
            [] => "no stop sent".to_owned(),
            [one] => format!("the stop stays at {}", price_words(*one)),
            many => format!("the stops stay at {}", list(many)),
        };
        match self {
            Refused::NoPosition => format!("No {symbol} position to move to breakeven."),
            Refused::OnItsWay => "The position's stop is on its way to the broker; try \
                                  breakeven again in a moment."
                .into(),
            Refused::AlreadyThere { price, stops } => format!(
                "{} already at or past breakeven ({}).",
                if *stops == 1 {
                    "The stop is"
                } else {
                    "The stops are"
                },
                price_words(*price)
            ),
            Refused::NoPrice { stays } => {
                format!("No price for {symbol} yet; {}.", stay(stays))
            }
            Refused::NotPassed {
                price,
                offset_ticks: 0,
                stays,
            } => format!(
                "Price hasn't passed your entry ({}) yet; {}.",
                price_words(*price),
                stay(stays)
            ),
            Refused::NotPassed {
                price,
                offset_ticks,
                stays,
            } => format!(
                "Price hasn't passed breakeven ({}, the entry + {}) yet; {}.",
                price_words(*price),
                ticks_words(*offset_ticks),
                stay(stays)
            ),
        }
    }
}

pub fn ticks_words(n: u32) -> String {
    if n == 1 {
        "1 tick".into()
    } else {
        format!("{n} ticks")
    }
}

fn list(prices: &[Price]) -> String {
    let mut ps: Vec<Price> = prices.to_vec();
    ps.sort();
    ps.dedup();
    let words: Vec<String> = ps.into_iter().map(price_words).collect();
    match words.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        Some((last, _)) => last.clone(),
        None => String::new(),
    }
}

impl BreakevenPlan {
    pub fn summary(&self) -> String {
        let at = match self.offset_ticks {
            0 => format!("{} (the entry)", price_words(self.price)),
            n => format!(
                "{} (the entry + {})",
                price_words(self.price),
                ticks_words(n)
            ),
        };
        let mut s = match (self.new_stop, self.moves.len()) {
            (Some(_), _) => format!("Placed a stop at breakeven, {at}"),
            (None, 1) => format!("Moved the stop to breakeven, {at}"),
            (None, n) => format!(
                "Moved {n} stops to breakeven, {at}: every entry's stop to the position's average \
                 entry"
            ),
        };
        match self.kept {
            0 => {}
            1 => s.push_str("; 1 already past it stays"),
            n => s.push_str(&format!("; {n} already past it stay")),
        }
        s
    }
}

fn stop_of(o: &Order, closing: Side) -> Option<bool> {
    let stop = o.role == OrderRole::StopLoss
        || (o.request.reduce_only
            && matches!(o.request.order_type, OrderType::Stop | OrderType::StopLimit));
    if !stop
        || o.request.side != closing
        || !o.status.is_open()
        || o.status == OrderStatus::Held
        || o.triggered_at.is_some()
        || o.request.stop_price.is_none()
    {
        return None;
    }
    Some(o.status.is_working())
}

pub fn breakeven_price(position: &Position, spec: &ContractSpec, offset_ticks: u32) -> Price {
    let long = position.side() == Some(Side::Buy);
    let dir = if long {
        Decimal::ONE
    } else {
        Decimal::NEGATIVE_ONE
    };
    let raw = position.avg_price.0 + dir * Decimal::from(offset_ticks) * spec.tick_size.0;
    spec.quantize(raw, if long { Rounding::Up } else { Rounding::Down })
}

pub fn plan(
    position: Option<&Position>,
    orders: &[Order],
    ask: &BreakevenAsk,
) -> Result<BreakevenPlan, Refused> {
    let Some((position, side)) = position.and_then(|p| Some((p, p.side()?))) else {
        return Err(Refused::NoPosition);
    };
    let long = side == Side::Buy;
    let closing = side.opposite();
    let mut stops: Vec<&Order> = Vec::new();
    let mut busy = false;
    for o in orders
        .iter()
        .filter(|o| o.request.instrument == position.instrument)
    {
        match stop_of(o, closing) {
            Some(true) => stops.push(o),
            Some(false) => busy = true,
            None => {}
        }
    }
    if busy {
        return Err(Refused::OnItsWay);
    }
    let offset_ticks = ask.offset_ticks.unwrap_or_else(|| {
        stops
            .iter()
            .filter_map(|o| o.stop_rules.and_then(|r| r.breakeven))
            .map(|b| b.offset_ticks)
            .min()
            .unwrap_or(0)
    });
    let price = breakeven_price(position, &ask.spec, offset_ticks);
    let stop_price = |o: &Order| o.request.stop_price.expect("a stop has its price");
    let behind: Vec<&Order> = stops
        .iter()
        .copied()
        .filter(|o| {
            let s = stop_price(o);
            if long { s < price } else { s > price }
        })
        .collect();
    if !stops.is_empty() && behind.is_empty() {
        return Err(Refused::AlreadyThere {
            price,
            stops: stops.len(),
        });
    }
    let stays: Vec<Price> = behind.iter().map(|o| stop_price(o)).collect();
    let touch = if long {
        [ask.touch.bid, ask.touch.last]
    } else {
        [ask.touch.ask, ask.touch.last]
    };
    let seen: Vec<Price> = touch.into_iter().flatten().collect();
    if seen.is_empty() {
        return Err(Refused::NoPrice { stays });
    }
    let passed = seen
        .iter()
        .all(|m| if long { *m > price } else { *m < price });
    if !passed {
        return Err(Refused::NotPassed {
            price,
            offset_ticks,
            stays,
        });
    }
    let moves = behind
        .iter()
        .map(|o| {
            let from = stop_price(o);
            let limit = match o.request.order_type {
                OrderType::StopLimit => {
                    o.request.limit_price.map(|l| Price(l.0 + price.0 - from.0))
                }
                _ => None,
            };
            Move {
                order: o.id.clone(),
                from,
                to: price,
                limit,
            }
        })
        .collect();
    Ok(BreakevenPlan {
        side,
        entry: position.avg_price,
        offset_ticks,
        price,
        moves,
        kept: stops.len() - behind.len(),
        new_stop: stops.is_empty().then(|| position.qty.abs()),
    })
}

#[cfg(test)]
mod tests;
