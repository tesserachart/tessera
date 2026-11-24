use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tessera_core::{Clock, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::hub::{MarketHub, PumpKey};
use tessera_market::{MarketDataProvider, MarketRouter, MockConfig, MockMarket};
use tessera_protocol::topics::names;

#[derive(Debug)]
struct Shifted(i64);

impl Clock for Shifted {
    fn now(&self) -> Timestamp {
        Timestamp(Timestamp::now().0 + self.0)
    }
}

fn cpu_seconds() -> f64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    // Fields after the parenthesised command name; utime and stime are the 12th and 13th.
    let rest = stat.rsplit_once(')').map_or("", |(_, r)| r);
    let f: Vec<&str> = rest.split_whitespace().collect();
    let ticks = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    (ticks(11) + ticks(12)) / 100.0
}

fn rss_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|kb| kb.parse::<f64>().ok())
        .map_or(0.0, |kb| kb / 1024.0)
}

async fn window(seconds: u64) -> (f64, f64) {
    let (c0, t0) = (cpu_seconds(), Instant::now());
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let wall = t0.elapsed().as_secs_f64();
    ((cpu_seconds() - c0) / wall * 100.0, wall)
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(60);
    let start = args
        .next()
        .and_then(|s| Timestamp::parse(&s).ok())
        .unwrap_or_else(|| Timestamp::parse("2026-10-02T11:42:00-04:00").expect("valid"));
    let mut cfg = MockConfig::new(Arc::new(Shifted(start.0 - Timestamp::now().0)));
    cfg.intraday_sessions = 5;
    let market = MockMarket::new(cfg);
    let sim = market.start();
    let router = MarketRouter::new();
    router.add(Arc::new(market.clone())).expect("router");
    let bus = Arc::new(EventBus::new());
    let topics = [
        names::MARKET_QUOTES,
        names::MARKET_BARS,
        names::MARKET_TRADES,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
    ];
    for t in topics {
        bus.register(t, TopicSizing::MARKET).expect("topic");
    }
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&bus));
    println!("start {start}  window {seconds}s  rss {:.0} MB", rss_mb());

    let (idle, _) = window(10).await;
    println!("simulator alone: {idle:.1}% CPU  rss {:.0} MB", rss_mb());

    let mut guards = Vec::new();
    let mut flow = 0;
    for id in market.instruments() {
        guards.push(hub.acquire(PumpKey::Quotes(id.clone())).expect("quotes"));
        guards.push(
            hub.acquire(PumpKey::Bars(id.clone(), Timeframe::M1))
                .expect("bars"),
        );
        if market.book(id, 1).ok().flatten().is_none() {
            continue;
        }
        flow += 1;
        guards.push(hub.acquire(PumpKey::Trades(id.clone())).expect("trades"));
        guards.push(hub.acquire(PumpKey::Book(id.clone())).expect("book"));
        guards.push(hub.acquire(PumpKey::Depth(id.clone(), 40)).expect("depth"));
        guards.push(
            hub.acquire(PumpKey::Footprint(id.clone(), Timeframe::M1, 1))
                .expect("footprint"),
        );
    }
    let counts: Arc<parking_lot::Mutex<HashMap<&'static str, (u64, u64)>>> = Arc::default();
    for t in topics {
        let (mut rx, _) = bus.subscribe(t).expect("subscribe");
        let counts = Arc::clone(&counts);
        tokio::spawn(async move {
            while let Ok(e) = rx.recv().await {
                let mut c = counts.lock();
                let e2 = c.entry(e.topic).or_default();
                e2.0 += 1;
                e2.1 += e.data.get().len() as u64;
            }
        });
    }
    println!(
        "{} instruments, {flow} with order flow, {} pumps",
        market.instruments().len(),
        hub.pump_count()
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    counts.lock().clear();
    let (busy, wall) = window(seconds).await;
    println!(
        "all streams: {busy:.1}% CPU (+{:.1}% over the simulator)  rss {:.0} MB",
        busy - idle,
        rss_mb()
    );
    let mut rows: Vec<_> = counts.lock().clone().into_iter().collect();
    rows.sort();
    for (topic, (n, bytes)) in rows {
        println!(
            "  {topic:<17} {:>7.1} events/s {:>8.1} KB/s",
            n as f64 / wall,
            bytes as f64 / wall / 1024.0
        );
    }
    let s = hub.recording_stats();
    println!(
        "recorded: {} instruments, {} prints ({:.1} MB), {} book columns ({:.2} MB)",
        s.instruments,
        s.prints,
        s.tape_bytes as f64 / 1e6,
        s.columns,
        s.book_bytes as f64 / 1e6
    );
    for (symbol, tf) in [
        ("NVDA", Timeframe::M5),
        ("NQ", Timeframe::M5),
        ("NQ", Timeframe::M1),
    ] {
        let Ok(id) = market.resolve(symbol).await else {
            continue;
        };
        let Ok((_, spec)) = market.spec(&id).await else {
            continue;
        };
        let t0 = Instant::now();
        let bars = market
            .get_bars(tessera_market::BarsRequest::latest(
                id.clone(),
                tf,
                tessera_market::module::DEFAULT_FOOTPRINTS as usize,
            ))
            .await
            .expect("bars")
            .bars;
        let (Some(first), Some(last)) = (bars.first(), bars.last()) else {
            continue;
        };
        let mut b =
            tessera_market::aggregate::FootprintBuilder::new(tf, spec.sessions, spec.tick_size);
        let mut n = 0;
        let read = hub
            .each_print(&id, first.t, last.t.add_nanos(tf.nanos()), |t| {
                n += usize::from(b.push(t).is_some());
            })
            .await
            .expect("history");
        println!(
            "footprint history {symbol} {tf} x{}: {} prints in {:?}",
            n + usize::from(b.current_t().is_some()),
            read.prints,
            t0.elapsed()
        );
    }
    drop(guards);
    sim.abort();
    let _ = market.health();
}
