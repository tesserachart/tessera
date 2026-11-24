use std::sync::Arc;
use std::time::Instant;

use tessera_core::clock::ManualClock;
use tessera_core::{Timeframe, Timestamp};
use tessera_market::mock::{DEFAULT_SEED, FROZEN_AT, parse_seed};
use tessera_market::{BarsRequest, MarketDataProvider, MockConfig, MockMarket};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let now = args
        .next()
        .and_then(|s| Timestamp::parse(&s).ok())
        .unwrap_or_else(|| Timestamp::parse(FROZEN_AT).expect("valid"));
    let seed = args
        .next()
        .and_then(|s| parse_seed(&s))
        .unwrap_or(DEFAULT_SEED);
    let mut cfg = MockConfig::new(Arc::new(ManualClock::new(now)));
    cfg.seed = seed;
    let started = Instant::now();
    let m = MockMarket::new(cfg);
    println!(
        "now {now}  seed {seed}  generated in {:?}",
        started.elapsed()
    );
    for id in m.instruments() {
        let q = m.quote(id).await.expect("quote");
        let s = q.session.clone().expect("session stats");
        let m1 = m
            .get_bars(BarsRequest::latest(id.clone(), Timeframe::M1, 100_000))
            .await
            .expect("bars");
        let d1 = m
            .get_bars(BarsRequest::latest(id.clone(), Timeframe::D1, 100_000))
            .await
            .expect("bars");
        println!(
            "{:<18} last {:>10}  bid {:>10}  ask {:>10}  open {:>10}  high {:>10}  low {:>10}  prev {:>10}  vol {:>12}  1m bars {:>6}  1D bars {:>4}",
            id.as_str(),
            q.last.map(|p| p.to_string()).unwrap_or_default(),
            q.bid.map(|p| p.to_string()).unwrap_or_default(),
            q.ask.map(|p| p.to_string()).unwrap_or_default(),
            s.open.map(|p| p.to_string()).unwrap_or_default(),
            s.high.map(|p| p.to_string()).unwrap_or_default(),
            s.low.map(|p| p.to_string()).unwrap_or_default(),
            s.prev_close.map(|p| p.to_string()).unwrap_or_default(),
            s.volume.map_or_else(|| "—".to_owned(), |v| v.to_string()),
            m1.bars.len(),
            d1.bars.len(),
        );
    }
}
