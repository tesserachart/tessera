use std::collections::BTreeMap;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::market::{Aggressor, FootprintBar};
use tessera_core::money::decimal_from_f64;
use tessera_core::{Price, Qty};

pub const DEFAULT_RATIO: f64 = 3.0;
pub const DEFAULT_MIN_VOLUME: f64 = 5.0;
pub const DEFAULT_MIN_DIFFERENCE: f64 = 0.0;
pub const STACK_ROWS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rule {
    pub ratio: f64,
    pub min_volume: f64,
    pub min_difference: f64,
    pub include_zero: bool,
}

impl Default for Rule {
    fn default() -> Self {
        Self {
            ratio: DEFAULT_RATIO,
            min_volume: DEFAULT_MIN_VOLUME,
            min_difference: DEFAULT_MIN_DIFFERENCE,
            include_zero: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Imbalance {
    pub price: Price,
    pub side: Aggressor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stack {
    pub side: Aggressor,
    pub low: Price,
    pub high: Price,
    pub rows: u32,
}

fn row_index(price: Price, row: Price) -> i64 {
    if row.0.is_zero() {
        return 0;
    }
    (price.0 / row.0).round().to_i64().unwrap_or(0)
}

pub fn imbalances(bar: &FootprintBar, rule: &Rule) -> Vec<Imbalance> {
    let k = decimal_from_f64(rule.ratio).unwrap_or(Decimal::from(3));
    let min = decimal_from_f64(rule.min_volume.max(0.0)).unwrap_or(Decimal::from(5));
    let difference = decimal_from_f64(rule.min_difference.max(0.0)).unwrap_or(Decimal::ZERO);
    let beats = |side: Qty, other: Qty| {
        side > Qty::ZERO
            && side.0 >= min
            && side.0 - other.0 >= difference
            && if other.is_zero() {
                rule.include_zero
            } else {
                side.0 >= other.0 * k
            }
    };
    let rows: BTreeMap<i64, (Qty, Qty, Price)> = bar
        .cells
        .iter()
        .map(|c| {
            (
                row_index(c.price, bar.bucket),
                (c.bid_volume, c.ask_volume, c.price),
            )
        })
        .collect();
    let (Some(&lo), Some(&hi)) = (rows.keys().next(), rows.keys().next_back()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (&i, &(bid, ask, price)) in &rows {
        if i > lo && beats(ask, rows.get(&(i - 1)).map_or(Qty::ZERO, |r| r.0)) {
            out.push(Imbalance {
                price,
                side: Aggressor::Buy,
            });
        }
        if i < hi && beats(bid, rows.get(&(i + 1)).map_or(Qty::ZERO, |r| r.1)) {
            out.push(Imbalance {
                price,
                side: Aggressor::Sell,
            });
        }
    }
    out
}

pub fn stacks(bar: &FootprintBar, found: &[Imbalance], min_rows: usize) -> Vec<Stack> {
    let mut out = Vec::new();
    for side in [Aggressor::Buy, Aggressor::Sell] {
        let mut run: Option<(i64, Price, Price, u32)> = None;
        let mut close = |run: Option<(i64, Price, Price, u32)>| {
            if let Some((_, low, high, n)) = run
                && n as usize >= min_rows.max(1)
            {
                out.push(Stack {
                    side,
                    low,
                    high,
                    rows: n,
                });
            }
        };
        for im in found.iter().filter(|im| im.side == side) {
            let i = row_index(im.price, bar.bucket);
            run = match run {
                Some((last, low, _, n)) if i == last + 1 => Some((i, low, im.price, n + 1)),
                other => {
                    close(other);
                    Some((i, im.price, im.price, 1))
                }
            };
        }
        close(run);
    }
    out.sort_by_key(|s| s.low);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::Timestamp;
    use tessera_core::market::{AggressorSource, FootprintCell};

    fn bar(rows: &[(&str, i64, i64)]) -> FootprintBar {
        FootprintBar {
            t: Timestamp(0),
            bucket: Price::from_str("0.25").unwrap(),
            cells: rows
                .iter()
                .map(|(p, bid, ask)| FootprintCell {
                    price: Price::from_str(p).unwrap(),
                    bid_volume: Qty::from(*bid),
                    ask_volume: Qty::from(*ask),
                    trades: 1,
                })
                .collect(),
            poc: None,
            delta_high: None,
            delta_low: None,
            aggressor_source: AggressorSource::Exchange,
        }
    }

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    #[test]
    fn diagonal_buy_stack_by_hand() {
        let b = bar(&[
            ("100.00", 10, 2),
            ("100.25", 4, 30),
            ("100.50", 3, 12),
            ("100.75", 1, 9),
        ]);
        let found = imbalances(&b, &Rule::default());
        assert_eq!(
            found,
            vec![
                Imbalance {
                    price: p("100.25"),
                    side: Aggressor::Buy
                },
                Imbalance {
                    price: p("100.50"),
                    side: Aggressor::Buy
                },
                Imbalance {
                    price: p("100.75"),
                    side: Aggressor::Buy
                },
            ]
        );
        assert_eq!(
            stacks(&b, &found, 3),
            vec![Stack {
                side: Aggressor::Buy,
                low: p("100.25"),
                high: p("100.75"),
                rows: 3
            }]
        );
        let rule = |ratio, min_volume| Rule {
            ratio,
            min_volume,
            ..Rule::default()
        };
        assert!(imbalances(&b, &rule(4.0, DEFAULT_MIN_VOLUME)).is_empty());
        let at_ten: Vec<Price> = imbalances(&b, &rule(3.0, 10.0))
            .iter()
            .map(|i| i.price)
            .collect();
        assert_eq!(at_ten, vec![p("100.25"), p("100.50")]);
    }

    #[test]
    fn a_row_the_bar_skipped_counts_only_with_zero_included() {
        let b = bar(&[
            ("100.00", 40, 0),
            ("100.25", 20, 5),
            ("100.50", 9, 2),
            ("101.00", 6, 1),
        ]);
        let sells = |rule: &Rule| -> Vec<Price> {
            let found = imbalances(&b, rule);
            assert!(found.iter().all(|i| i.side == Aggressor::Sell));
            found.iter().map(|i| i.price).collect()
        };
        assert_eq!(sells(&Rule::default()), vec![p("100.00"), p("100.25")]);
        assert!(stacks(&b, &imbalances(&b, &Rule::default()), 3).is_empty());
        let with_zero = Rule {
            include_zero: true,
            ..Rule::default()
        };
        assert_eq!(
            sells(&with_zero),
            vec![p("100.00"), p("100.25"), p("100.50")]
        );
        let found = imbalances(&b, &with_zero);
        assert_eq!(
            stacks(&b, &found, 3),
            vec![Stack {
                side: Aggressor::Sell,
                low: p("100.00"),
                high: p("100.50"),
                rows: 3
            }]
        );
        assert!(stacks(&b, &found, 4).is_empty());
    }

    #[test]
    fn the_shared_imbalance_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/orderflow/imbalance.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let rows = case["rows"].as_array().unwrap();
            let prices: Vec<String> = (0..rows.len())
                .map(|r| format!("{:.2}", 100.0 + r as f64 * 0.25))
                .collect();
            let cells: Vec<(&str, i64, i64)> = rows
                .iter()
                .zip(&prices)
                .map(|(r, p)| (p.as_str(), r[0].as_i64().unwrap(), r[1].as_i64().unwrap()))
                .collect();
            let b = bar(&cells);
            let found = imbalances(
                &b,
                &Rule {
                    ratio: case["ratio"].as_f64().unwrap(),
                    min_volume: case["minVolume"].as_f64().unwrap(),
                    min_difference: case["minDifference"].as_f64().unwrap(),
                    include_zero: case["includeZero"].as_bool().unwrap(),
                },
            );
            let row_of = |price: Price| prices.iter().position(|p| *p == price.to_string());
            for (side, key) in [(Aggressor::Buy, "buy"), (Aggressor::Sell, "sell")] {
                let got: Vec<usize> = found
                    .iter()
                    .filter(|i| i.side == side)
                    .filter_map(|i| row_of(i.price))
                    .collect();
                let want: Vec<usize> = case[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as usize)
                    .collect();
                assert_eq!(got, want, "{name}: {key}");
            }
            let min_rows = case["stackRows"].as_u64().unwrap() as usize;
            let mut got: Vec<(String, usize, usize)> = stacks(&b, &found, min_rows)
                .iter()
                .map(|s| {
                    let side = if s.side == Aggressor::Buy {
                        "buy"
                    } else {
                        "sell"
                    };
                    (
                        side.to_string(),
                        row_of(s.low).unwrap(),
                        row_of(s.high).unwrap(),
                    )
                })
                .collect();
            got.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
            let want: Vec<(String, usize, usize)> = case["stacks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    (
                        s[0].as_str().unwrap().to_string(),
                        s[1].as_u64().unwrap() as usize,
                        s[2].as_u64().unwrap() as usize,
                    )
                })
                .collect();
            assert_eq!(got, want, "{name}: stacks");
        }
    }
}
