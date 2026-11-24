use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::market::{FootprintBar, FootprintCell};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_host::{ByteLru, Weigh};

pub const FOOTPRINT_CACHE_BYTES: usize = 32 << 20;
pub const BASE_ROWS: i64 = 2000;
pub const CLOSE_GRACE: i64 = 10 * NANOS_PER_SEC;

type Key = (String, InstrumentId, Timeframe, Timestamp);

struct Entry {
    bars: Vec<(u32, Arc<FootprintBar>)>,
}

impl Weigh for Entry {
    fn weight(&self) -> usize {
        self.bars.iter().map(|(_, b)| bytes_of(b)).sum()
    }
}

fn bytes_of(bar: &FootprintBar) -> usize {
    std::mem::size_of::<FootprintBar>() + bar.cells.len() * std::mem::size_of::<FootprintCell>()
}

pub fn base_row_ticks(row_ticks: u32, widest_ticks: i64) -> u32 {
    let row_ticks = row_ticks.max(1);
    (1..=row_ticks)
        .filter(|d| row_ticks.is_multiple_of(*d))
        .find(|d| widest_ticks / i64::from(*d) < BASE_ROWS)
        .unwrap_or(row_ticks)
}

pub struct FootprintCache {
    inner: Mutex<ByteLru<Key, Entry>>,
}

impl Default for FootprintCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ByteLru::new(FOOTPRINT_CACHE_BYTES)),
        }
    }
}

impl std::fmt::Debug for FootprintCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock();
        f.debug_struct("FootprintCache")
            .field("bars", &inner.len())
            .field("bytes", &inner.bytes())
            .finish()
    }
}

impl FootprintCache {
    pub fn get(
        &self,
        provider: &str,
        id: &InstrumentId,
        tf: Timeframe,
        open: Timestamp,
        row_ticks: Option<u32>,
    ) -> Option<(u32, Arc<FootprintBar>)> {
        let mut inner = self.inner.lock();
        let key = (provider.to_owned(), id.clone(), tf, open);
        let e = inner.get(&key)?;
        let hit = e
            .bars
            .iter()
            .filter(|(b, _)| row_ticks.is_none_or(|r| r.is_multiple_of(*b)))
            .max_by_key(|(b, _)| *b)?;
        Some((hit.0, Arc::clone(&hit.1)))
    }

    pub fn put(
        &self,
        provider: &str,
        id: &InstrumentId,
        tf: Timeframe,
        base_ticks: u32,
        bar: Arc<FootprintBar>,
    ) {
        if bytes_of(&bar) > FOOTPRINT_CACHE_BYTES / 4 {
            return;
        }
        let key = (provider.to_owned(), id.clone(), tf, bar.t);
        let evicted = {
            let mut inner = self.inner.lock();
            match inner.get_mut(&key) {
                Some(e) if e.bars.iter().any(|(b, _)| *b == base_ticks) => return,
                Some(e) => {
                    e.bars.push((base_ticks, bar));
                    inner.resize(&key)
                }
                None => inner.insert(
                    key,
                    Entry {
                        bars: vec![(base_ticks, bar)],
                    },
                ),
            }
        };
        drop(evicted);
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().bytes()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().values().map(|e| e.bars.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use tessera_core::market::AggressorSource;
    use tessera_core::{Price, Qty};

    fn bar(t: i64, rows: usize) -> Arc<FootprintBar> {
        Arc::new(FootprintBar {
            t: Timestamp(t),
            bucket: Price(Decimal::new(25, 2)),
            cells: (0..rows)
                .map(|i| FootprintCell {
                    price: Price(Decimal::new(25 * i as i64, 2)),
                    bid_volume: Qty::from(1),
                    ask_volume: Qty::from(2),
                    trades: 3,
                })
                .collect(),
            poc: None,
            delta_high: None,
            delta_low: None,
            aggressor_source: AggressorSource::Exchange,
        })
    }

    #[test]
    fn the_base_row_is_the_finest_divisor_that_fits() {
        assert_eq!(base_row_ticks(8, 40), 1, "a narrow bar keeps one-tick rows");
        assert_eq!(
            base_row_ticks(1, 10_000),
            1,
            "one-tick rows asked are one-tick rows"
        );
        assert_eq!(base_row_ticks(5000, 300_000), 200);
        assert_eq!(
            base_row_ticks(7, 300_000),
            7,
            "a prime row height is its own base"
        );
    }

    #[test]
    fn a_row_height_reads_the_coarsest_bar_it_is_a_multiple_of() {
        let c = FootprintCache::default();
        let id = InstrumentId::new("NQZ6.CME").unwrap();
        c.put("mock", &id, Timeframe::M5, 1, bar(0, 40));
        c.put("mock", &id, Timeframe::M5, 4, bar(0, 10));
        c.put("mock", &id, Timeframe::M5, 4, bar(0, 10));
        assert_eq!(c.len(), 2, "a row height is kept once");
        let at = |r| {
            c.get("mock", &id, Timeframe::M5, Timestamp(0), r)
                .map(|h| h.0)
        };
        assert_eq!(at(Some(8)), Some(4));
        assert_eq!(at(Some(6)), Some(1));
        assert_eq!(at(Some(1)), Some(1));
        assert_eq!(at(None), Some(4), "sides come from any");
        assert_eq!(
            c.get("other", &id, Timeframe::M5, Timestamp(0), Some(1)),
            None
        );
        assert_eq!(
            c.get("mock", &id, Timeframe::M1, Timestamp(0), Some(1)),
            None
        );
    }

    #[test]
    fn the_least_recently_used_bars_go_beyond_the_budget() {
        let c = FootprintCache::default();
        let id = InstrumentId::new("ESZ6.CME").unwrap();
        let rows = 1000;
        let each = bytes_of(&bar(0, rows));
        let fit = FOOTPRINT_CACHE_BYTES / each;
        for t in 0..fit as i64 {
            c.put("mock", &id, Timeframe::M1, 1, bar(t, rows));
        }
        assert_eq!(c.len(), fit);
        assert!(
            c.get("mock", &id, Timeframe::M1, Timestamp(0), Some(1))
                .is_some()
        );
        c.put("mock", &id, Timeframe::M1, 1, bar(fit as i64, rows));
        assert!(c.bytes() <= FOOTPRINT_CACHE_BYTES);
        assert!(
            c.get("mock", &id, Timeframe::M1, Timestamp(0), Some(1))
                .is_some()
        );
        assert!(
            c.get("mock", &id, Timeframe::M1, Timestamp(1), Some(1))
                .is_none()
        );
    }
}
