use std::collections::HashMap;

use tessera_core::market::{BookSnapshot, DepthLevel};
use tessera_core::{Price, Qty};
use tessera_protocol::compact::CompactLevel;

pub fn diff(old: &[DepthLevel], new: &[DepthLevel]) -> Vec<CompactLevel> {
    let before: HashMap<Price, (Qty, Option<u32>)> =
        old.iter().map(|l| (l.price, (l.size, l.orders))).collect();
    let mut out: Vec<CompactLevel> = new
        .iter()
        .filter(|l| before.get(&l.price) != Some(&(l.size, l.orders)))
        .map(CompactLevel::from)
        .collect();
    let after: HashMap<Price, ()> = new.iter().map(|l| (l.price, ())).collect();
    out.extend(
        old.iter()
            .filter(|l| !after.contains_key(&l.price))
            .map(|l| removal(l.price)),
    );
    out
}

fn removal(price: Price) -> CompactLevel {
    CompactLevel(price.to_f64(), 0.0, None)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct View {
    pub bids: Vec<DepthLevel>,
    pub asks: Vec<DepthLevel>,
}

impl View {
    pub fn of(book: &BookSnapshot, levels: usize) -> Self {
        Self {
            bids: book.bids.iter().take(levels).copied().collect(),
            asks: book.asks.iter().take(levels).copied().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn l(price: &str, size: i64) -> DepthLevel {
        DepthLevel {
            price: Price::from_str(price).unwrap(),
            size: Qty::from(size),
            orders: Some(1),
        }
    }

    fn apply(
        old: &[DepthLevel],
        delta: &[CompactLevel],
        bids: bool,
        keep: usize,
    ) -> Vec<(f64, f64)> {
        let mut m: Vec<(f64, f64)> = old
            .iter()
            .map(|l| (l.price.to_f64(), l.size.to_f64()))
            .collect();
        for d in delta {
            m.retain(|(p, _)| *p != d.0);
            if d.1 > 0.0 {
                m.push((d.0, d.1));
            }
        }
        m.sort_by(|a, b| {
            if bids {
                b.0.total_cmp(&a.0)
            } else {
                a.0.total_cmp(&b.0)
            }
        });
        m.truncate(keep);
        m
    }

    #[test]
    fn deltas_rebuild_the_new_view() {
        let old = [l("100.00", 5), l("99.99", 7), l("99.98", 2)];
        let new = [l("99.99", 9), l("99.98", 2), l("99.97", 4)];
        let d = diff(&old, &new);
        assert_eq!(
            d,
            [
                CompactLevel(99.99, 9.0, Some(1)),
                CompactLevel(99.97, 4.0, Some(1)),
                CompactLevel(100.0, 0.0, None)
            ]
        );
        assert_eq!(
            apply(&old, &d, true, 3),
            new.iter()
                .map(|l| (l.price.to_f64(), l.size.to_f64()))
                .collect::<Vec<_>>()
        );
        assert!(diff(&new, &new).is_empty());
    }
}
