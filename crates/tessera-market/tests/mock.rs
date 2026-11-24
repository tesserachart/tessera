use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use futures::{FutureExt, StreamExt};
use rust_decimal::Decimal;
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::health::HealthStatus;
use tessera_core::market::{Aggressor, AggressorSource, Bar, BookSnapshot, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle;
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_market::aggregate::aggregate;
use tessera_market::mock::generate::ScenarioBar;
use tessera_market::mock::model::DriverId;
use tessera_market::mock::{MarketEvent, Scenario};
use tessera_market::{
    BarsRequest, MarketDataProvider, MarketError, MarketRouter, MockConfig, MockMarket,
};

fn now() -> Timestamp {
    Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap()
}

fn market_at(t: Timestamp, seed: u64) -> (MockMarket, Arc<ManualClock>) {
    let clock = Arc::new(ManualClock::new(t));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.seed = seed;
    cfg.intraday_sessions = 6;
    cfg.daily_sessions = 60;
    (MockMarket::new(cfg), clock)
}

fn id(s: &str) -> InstrumentId {
    InstrumentId::new(s).unwrap()
}

fn d(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

async fn bars(m: &MockMarket, inst: &str, tf: Timeframe) -> Vec<Bar> {
    m.get_bars(BarsRequest {
        instrument: id(inst),
        tf,
        from: None,
        to: None,
        limit: None,
        rth_only: false,
    })
    .await
    .unwrap()
    .bars
}

#[tokio::test]
async fn latest_prices_match_the_content_sheet() {
    let started = Instant::now();
    let (m, _) = market_at(now(), tessera_market::mock::DEFAULT_SEED);
    eprintln!("generation took {:?}", started.elapsed());
    for (inst, last) in [
        ("QQQ", "487.85"),
        ("NDX", "20598.40"),
        ("SPY", "551.92"),
        ("NVDA", "178.42"),
        ("AAPL", "231.64"),
        ("TSLA", "246.18"),
        ("NQZ6.CME", "20641.25"),
        ("MNQZ6.CME", "20641.25"),
        ("ESZ6.CME", "5583.25"),
        ("MESZ6.CME", "5583.25"),
        ("BTC-USD.COINBASE", "98412.00"),
        ("ETH-USD.COINBASE", "3650.00"),
    ] {
        let q = m.quote(&id(inst)).await.unwrap();
        assert_eq!(q.last, Some(Price(d(last))), "{inst}");
    }
    let h7 = m.quote(&id("NQH7.CME")).await.unwrap().last.unwrap();
    assert!(h7.0 > d("20800") && h7.0 < d("20900"), "{h7}");
    let q = m.quote(&id("QQQ")).await.unwrap();
    assert!(q.bid.unwrap() < q.ask.unwrap());
    assert!(m.quote(&id("NDX")).await.unwrap().bid.is_none());
    let s = q.session.unwrap();
    assert_eq!(s.trade_date.to_string(), "2026-10-02");
    assert!(s.prev_close.is_some() && s.open.is_some());
    assert!(s.volume.unwrap() > Qty::from(1_000_000));
}

#[tokio::test]
async fn history_is_deterministic_per_seed_and_now() {
    let (a, _) = market_at(now(), 7);
    let (b, _) = market_at(now(), 7);
    let (c, _) = market_at(now(), 8);
    for inst in ["QQQ", "NQZ6.CME", "BTC-USD.COINBASE", "TSLA"] {
        let x = bars(&a, inst, Timeframe::M5).await;
        assert_eq!(x, bars(&b, inst, Timeframe::M5).await, "{inst}");
        assert_ne!(x, bars(&c, inst, Timeframe::M5).await, "{inst}");
    }
}

#[tokio::test]
async fn bars_respect_sessions_ticks_and_ohlc() {
    let (m, _) = market_at(now(), 3);
    let qqq = bars(&m, "QQQ", Timeframe::M1).await;
    let tick = d("0.01");
    for b in &qqq {
        assert!(
            SessionCalendar::UsEquities.is_rth(b.t),
            "QQQ bar outside RTH at {}",
            b.t
        );
        assert!(b.is_consistent(), "{b:?}");
        for p in [b.o, b.h, b.l, b.c] {
            assert!((p.0 % tick).is_zero());
        }
    }
    let mut per_day = std::collections::BTreeMap::new();
    for b in &qqq {
        *per_day
            .entry(SessionCalendar::UsEquities.trade_date(b.t))
            .or_insert(0) += 1;
    }
    let counts: Vec<i32> = per_day.values().copied().collect();
    assert_eq!(*counts.last().unwrap(), 312);
    assert!(
        counts[..counts.len() - 1].iter().all(|&c| c == 390),
        "{counts:?}"
    );

    let nq = bars(&m, "NQZ6.CME", Timeframe::M1).await;
    let qtick = d("0.25");
    for b in &nq {
        assert!(
            SessionCalendar::CmeEquityIndex.is_open(b.t),
            "NQ bar while closed at {}",
            b.t
        );
        assert!((b.c.0 % qtick).is_zero());
        assert!(b.is_consistent());
    }
    assert!(nq.len() > qqq.len() * 3, "futures trade overnight");
}

#[tokio::test]
async fn every_timeframe_aggregates_the_same_minutes() {
    let (m, _) = market_at(now(), 11);
    for inst in ["QQQ", "ESZ6.CME", "ETH-USD.COINBASE"] {
        let m1 = bars(&m, inst, Timeframe::M1).await;
        let cal = m.catalog().spec(&id(inst)).unwrap().sessions;
        let total: Decimal = m1.iter().map(|b| b.v.0).sum();
        for tf in [
            Timeframe::M5,
            Timeframe::M15,
            Timeframe::M30,
            Timeframe::H1,
            Timeframe::H4,
        ] {
            let got = bars(&m, inst, tf).await;
            assert_eq!(got, aggregate(&m1, tf, cal), "{inst} {tf}");
            let sum: Decimal = got.iter().map(|b| b.v.0).sum();
            assert_eq!(sum, total, "{inst} {tf} volume");
            assert_eq!(got.first().unwrap().o, m1.first().unwrap().o);
            assert_eq!(got.last().unwrap().c, m1.last().unwrap().c);
        }
        let daily = bars(&m, inst, Timeframe::D1).await;
        assert!(daily.len() >= 60, "{inst} daily {}", daily.len());
        assert!(daily.windows(2).all(|w| w[0].t < w[1].t));
    }
    let h1 = bars(&m, "QQQ", Timeframe::H1).await;
    let t = h1.last().unwrap().t.in_tz(chrono_tz::America::New_York);
    assert_eq!(
        chrono::Timelike::minute(&t),
        30,
        "QQQ hourly bars start at :30"
    );
}

#[tokio::test]
async fn intraday_volume_is_u_shaped() {
    let (m, _) = market_at(now(), 5);
    let qqq = bars(&m, "QQQ", Timeframe::M1).await;
    let mut open = 0.0;
    let mut mid = 0.0;
    let mut close = 0.0;
    for b in &qqq {
        let l = b.t.in_tz(chrono_tz::America::New_York);
        let mins = chrono::Timelike::hour(&l) * 60 + chrono::Timelike::minute(&l);
        let v = b.v.to_f64();
        if (570..600).contains(&mins) {
            open += v;
        } else if (720..750).contains(&mins) {
            mid += v;
        } else if (930..960).contains(&mins) {
            close += v;
        }
    }
    assert!(open > 2.0 * mid, "open {open} mid {mid}");
    assert!(close > 1.3 * mid, "close {close} mid {mid}");
    let daily = bars(&m, "QQQ", Timeframe::D1).await;
    let prev = daily[daily.len() - 2].v.to_f64();
    assert!((25e6..75e6).contains(&prev), "QQQ day volume {prev}");
}

#[tokio::test]
async fn cross_section_is_coherent() {
    let (m, _) = market_at(now(), 9);
    let qqq = bars(&m, "QQQ", Timeframe::M1).await;
    let nq = bars(&m, "NQZ6.CME", Timeframe::M1).await;
    let mnq = bars(&m, "MNQZ6.CME", Timeframe::M1).await;
    let nq_at: std::collections::HashMap<i64, Price> = nq.iter().map(|b| (b.t.0, b.c)).collect();
    let mut checked = 0;
    for b in qqq.iter().step_by(17) {
        let n = nq_at[&b.t.0];
        let ratio = n.to_f64() / b.c.to_f64();
        assert!((ratio - 42.31).abs() < 0.05, "ratio {ratio} at {}", b.t);
        checked += 1;
    }
    assert!(checked > 50);
    assert_eq!(
        nq.iter().map(|b| b.c).collect::<Vec<_>>(),
        mnq.iter().map(|b| b.c).collect::<Vec<_>>(),
        "micro mirrors the full-size contract"
    );
}

#[tokio::test]
async fn search_resolve_and_specs() {
    let (m, _) = market_at(now(), 1);
    assert_eq!(m.resolve("nq").await.unwrap(), id("NQZ6.CME"));
    assert_eq!(m.resolve("BTCUSD").await.unwrap(), id("BTC-USD.COINBASE"));
    assert!(matches!(
        m.resolve("XYZ").await,
        Err(MarketError::UnknownInstrument(_))
    ));
    let hits = m.search("es", None, 5).await.unwrap();
    assert_eq!(hits[0].id, id("ESZ6.CME"));
    let (inst, spec) = m.spec(&id("MNQZ6.CME")).await.unwrap();
    assert_eq!(inst.symbol, "MNQZ6");
    assert_eq!(spec.tick_value.amount, d("0.50"));
    for i in m.instruments() {
        assert!(!bars(&m, i.as_str(), Timeframe::M5).await.is_empty(), "{i}");
    }
    assert_eq!(m.instruments().len(), 16);
    let caps = m.capabilities();
    assert!(caps.quotes && caps.trades);
    assert!(!caps.footprint && tessera_market::router::effective(caps.clone()).footprint);
    assert_eq!(caps.depth_levels, Some(40));
    assert_eq!(caps.aggressor_source, Some(AggressorSource::Exchange));
    assert!(caps.serves_history(Timeframe::S1));
    assert_eq!(
        m.get_bars(BarsRequest::latest(id("QQQ"), Timeframe::S1, 10))
            .await
            .unwrap()
            .bars
            .len(),
        10
    );
    assert!(matches!(
        m.get_bars(BarsRequest::latest(id("NDX"), Timeframe::S1, 10))
            .await,
        Err(MarketError::Unsupported(_))
    ));
    assert!(matches!(
        m.subscribe_depth(&id("NDX"), 10),
        Err(MarketError::Unsupported(_))
    ));
}

#[tokio::test]
async fn bar_requests_filter_and_limit() {
    let (m, _) = market_at(now(), 1);
    let all = bars(&m, "NQZ6.CME", Timeframe::M5).await;
    let last10 = m
        .get_bars(BarsRequest::latest(id("NQZ6.CME"), Timeframe::M5, 10))
        .await
        .unwrap();
    assert_eq!(last10.bars, all[all.len() - 10..].to_vec());
    let from = all[5].t;
    let to = all[20].t;
    let window = m
        .get_bars(BarsRequest {
            instrument: id("NQZ6.CME"),
            tf: Timeframe::M5,
            from: Some(from),
            to: Some(to),
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap();
    assert_eq!(window.bars.len(), 16);
    let rth = m
        .get_bars(BarsRequest {
            instrument: id("NQZ6.CME"),
            tf: Timeframe::M1,
            from: None,
            to: None,
            limit: None,
            rth_only: true,
        })
        .await
        .unwrap();
    assert!(
        rth.bars
            .iter()
            .all(|b| SessionCalendar::CmeEquityIndex.is_rth(b.t))
    );
    assert!(matches!(
        m.get_bars(BarsRequest {
            instrument: id("QQQ"),
            tf: Timeframe::M5,
            from: Some(to),
            to: Some(from),
            limit: None,
            rth_only: false
        })
        .await,
        Err(MarketError::InvalidRequest(_))
    ));
}

#[tokio::test]
async fn live_simulator_prints_quotes_trades_and_bars() {
    let (m, clock) = market_at(now(), 21);
    let mut rx = m.events();
    let mut five = m.subscribe_bars(&id("QQQ"), Timeframe::M5).unwrap();
    let mut quotes = m.subscribe_quotes(&[id("NQZ6.CME")]).unwrap();
    for _ in 0..600 {
        clock.advance(NANOS_PER_SEC / 4);
        m.advance(clock.now());
    }
    let mut trades = 0;
    let mut quotes_seen = 0;
    let mut closed_minutes = 0;
    loop {
        let e = match rx.try_recv() {
            Ok(e) => e,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(_) => break,
        };
        match e {
            MarketEvent::Trade(t) => {
                trades += 1;
                assert!(t.size > Qty::ZERO);
            }
            MarketEvent::Quote(_) => quotes_seen += 1,
            MarketEvent::Bar1m { closed, .. } => closed_minutes += usize::from(closed),
            MarketEvent::Book(_) => {}
        }
    }
    assert!(trades > 100, "trades {trades}");
    assert!(quotes_seen > 300, "quotes {quotes_seen}");
    assert!(closed_minutes >= 14, "closed minute bars {closed_minutes}");
    let q = quotes.next().await.unwrap();
    assert_eq!(q.instrument, id("NQZ6.CME"));
    let t1440 = Timestamp::parse("2026-10-02T14:40:00-04:00").unwrap();
    let t1445 = Timestamp::parse("2026-10-02T14:45:00-04:00").unwrap();
    let saw = Arc::new(parking_lot::Mutex::new((false, false)));
    let reader = {
        let saw = Arc::clone(&saw);
        tokio::spawn(async move {
            // Await (rather than poll once) so tokio's cooperative budget refills between items.
            while let Some(lb) = five.next().await {
                let mut saw = saw.lock();
                saw.0 |= lb.closed && lb.bar.t == t1440;
                saw.1 |= lb.bar.t == t1445;
            }
        })
    };
    settle(
        "the 14:40 bar closed and the 14:45 bar begun",
        || *saw.lock(),
        |(closed, next)| *closed && *next,
    )
    .await;
    reader.abort();
    let req = BarsRequest::latest(id("QQQ"), Timeframe::M1, 3);
    let latest = m.get_bars(req).await.unwrap();
    assert_eq!(
        latest.bars.last().unwrap().t,
        Timestamp::parse("2026-10-02T14:45:00-04:00").unwrap()
    );
    assert!(latest.last_bar_open);
    assert!(latest.bars.iter().all(Bar::is_consistent));
}

#[tokio::test]
async fn only_open_markets_tick() {
    let sat = Timestamp::parse("2026-10-03T12:00:00-04:00").unwrap();
    let (m, clock) = market_at(sat, 2);
    let mut rx = m.events();
    for _ in 0..40 {
        clock.advance(NANOS_PER_SEC / 4);
        m.advance(clock.now());
    }
    let mut instruments = std::collections::HashSet::new();
    while let Ok(e) = rx.try_recv() {
        instruments.insert(e.instrument().to_string());
    }
    assert!(instruments.contains("BTC-USD.COINBASE"));
    assert!(
        instruments.iter().all(|i| i.ends_with(".COINBASE")),
        "{instruments:?}"
    );
    assert_eq!(
        m.quote(&id("QQQ")).await.unwrap().last,
        Some(Price(d("487.85")))
    );
}

#[tokio::test]
async fn a_quiet_market_keeps_its_prices_flowing() {
    let (m, clock) = market_at(now(), 3);
    let router = MarketRouter::new();
    router.add(Arc::new(m.clone())).unwrap();
    let mut rx = m.events();
    clock.advance(10 * NANOS_PER_MINUTE);
    assert!(
        rx.try_recv().is_err(),
        "nothing traded in those ten minutes"
    );
    assert!(m.prices_flowing());
    assert_eq!(m.health().status, HealthStatus::Ok);
    assert!(router.prices_down().is_empty());
    assert!(router.prices_down_for(&id("NQZ6.CME")).is_none());
}

#[tokio::test]
async fn an_outage_stops_the_prices_and_says_it_is_reconnecting_until_it_ends() {
    let (m, clock) = market_at(now(), 3);
    let router = MarketRouter::new();
    router.add(Arc::new(m.clone())).unwrap();
    let mut rx = m.events();
    let run = |quarters: usize| {
        for _ in 0..quarters {
            clock.advance(NANOS_PER_SEC / 4);
            m.advance(clock.now());
        }
    };

    m.set_outage(true);
    run(8);
    assert!(
        rx.try_recv().is_err(),
        "no prices come in during the outage"
    );
    assert!(!m.prices_flowing());
    let health = m.health();
    assert_eq!(health.status, HealthStatus::Degraded);
    assert_eq!(
        health.message.as_deref(),
        Some("Connection lost (simulated outage). Reconnecting.")
    );
    assert_eq!(router.prices_down(), ["mock"]);
    let down = router
        .prices_down_for(&id("NQZ6.CME"))
        .expect("NQ's prices are down");
    assert_eq!(
        (down.display_name.as_str(), down.status),
        ("Mock market", HealthStatus::Degraded)
    );

    m.set_outage(false);
    run(8);
    assert!(rx.try_recv().is_ok(), "prices come in again");
    assert!(m.prices_flowing());
    assert_eq!(m.health().status, HealthStatus::Ok);
    assert!(router.prices_down().is_empty());
    assert!(router.prices_down_for(&id("NQZ6.CME")).is_none());
}

#[tokio::test]
async fn late_start_catches_up_whole_minutes() {
    let (m, clock) = market_at(now(), 4);
    let before = bars(&m, "NQZ6.CME", Timeframe::M1).await.len();
    clock.advance(10 * NANOS_PER_MINUTE);
    m.advance(clock.now());
    let after = bars(&m, "NQZ6.CME", Timeframe::M1).await;
    assert_eq!(after.len(), before + 11);
    assert_eq!(
        after.last().unwrap().t,
        Timestamp::parse("2026-10-02T14:52:00-04:00").unwrap()
    );
    for w in after.windows(2) {
        assert!(w[1].t.0 - w[0].t.0 >= NANOS_PER_MINUTE);
    }
}

struct Lift;

impl Scenario for Lift {
    fn apply(&self, driver: DriverId, bars: &mut [ScenarioBar]) {
        if driver == DriverId::Nq
            && let Some(last) = bars.last_mut()
        {
            last.c = 20700.0;
            last.h = last.h.max(20700.0);
        }
    }
}

#[tokio::test]
async fn scenarios_rewrite_driver_paths() {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(clock);
    cfg.intraday_sessions = 2;
    cfg.daily_sessions = 5;
    cfg.scenario = Some(Arc::new(Lift));
    let m = MockMarket::new(cfg);
    assert_eq!(
        m.quote(&id("NQZ6.CME")).await.unwrap().last,
        Some(Price(d("20700.00")))
    );
    assert_eq!(
        m.quote(&id("MNQZ6.CME")).await.unwrap().last,
        Some(Price(d("20700.00")))
    );
}

#[tokio::test]
async fn latest_n_requests_match_the_full_computation() {
    let (m, _) = market_at(now(), 31);
    for inst in ["QQQ", "NQZ6.CME", "BTC-USD.COINBASE"] {
        for tf in [
            Timeframe::M1,
            Timeframe::M5,
            Timeframe::M15,
            Timeframe::M30,
            Timeframe::H1,
            Timeframe::H4,
            Timeframe::D1,
        ] {
            for rth_only in [false, true] {
                let full = m
                    .get_bars(BarsRequest {
                        instrument: id(inst),
                        tf,
                        from: None,
                        to: None,
                        limit: None,
                        rth_only,
                    })
                    .await
                    .unwrap()
                    .bars;
                for limit in [1, 7, 50, 400] {
                    let got = m
                        .get_bars(BarsRequest {
                            instrument: id(inst),
                            tf,
                            from: None,
                            to: None,
                            limit: Some(limit),
                            rth_only,
                        })
                        .await
                        .unwrap()
                        .bars;
                    let want = &full[full.len().saturating_sub(limit)..];
                    assert_eq!(got, want, "{inst} {tf} rth={rth_only} limit={limit}");
                }
                if full.len() > 3 {
                    let from = full[full.len() - 3].t;
                    let got = m
                        .get_bars(BarsRequest {
                            instrument: id(inst),
                            tf,
                            from: Some(from),
                            to: None,
                            limit: None,
                            rth_only,
                        })
                        .await
                        .unwrap()
                        .bars;
                    assert_eq!(got, full[full.len() - 3..].to_vec(), "{inst} {tf} from");
                }
            }
        }
    }
}

fn tick_and_collect(
    m: &MockMarket,
    clock: &ManualClock,
    inst: &str,
    ticks: usize,
) -> Vec<MarketEvent> {
    let mut rx = m.events();
    let mut out = Vec::new();
    for _ in 0..ticks {
        clock.advance(NANOS_PER_SEC / 4);
        m.advance(clock.now());
        while let Ok(e) = rx.try_recv() {
            if e.instrument().as_str() == inst {
                out.push(e);
            }
        }
    }
    out
}

fn check_book(b: &BookSnapshot, levels: usize) {
    assert_eq!(b.bids.len(), levels);
    assert_eq!(b.asks.len(), levels);
    assert!(b.bids[0].price < b.asks[0].price, "crossed book");
    assert!(b.bids.windows(2).all(|w| w[0].price > w[1].price));
    assert!(b.asks.windows(2).all(|w| w[0].price < w[1].price));
    for l in b.bids.iter().chain(&b.asks) {
        assert!(l.size > Qty::ZERO);
        assert!(l.orders.is_some_and(|o| o >= 1));
    }
}

#[tokio::test]
async fn prints_execute_against_the_quoted_book() {
    for inst in ["NQZ6.CME", "QQQ", "TSLA", "BTC-USD.COINBASE"] {
        let (m, clock) = market_at(now(), 13);
        let events = tick_and_collect(&m, &clock, inst, 4 * 120);
        let mut quote: Option<Quote> = None;
        let mut trades: Vec<Trade> = Vec::new();
        for e in events {
            match e {
                MarketEvent::Quote(q) => {
                    assert!(q.bid.unwrap() < q.ask.unwrap(), "{inst} crossed quote");
                    quote = Some(q);
                }
                MarketEvent::Trade(t) => {
                    assert!(t.size > Qty::ZERO);
                    assert_eq!(t.aggressor_source, AggressorSource::Exchange);
                    assert!(t.source.as_ref().is_some_and(|s| s.provider == "mock"));
                    if let Some(q) = &quote {
                        match t.aggressor {
                            Aggressor::Buy => assert!(t.price >= q.ask.unwrap(), "{inst} {t:?}"),
                            Aggressor::Sell => assert!(t.price <= q.bid.unwrap(), "{inst} {t:?}"),
                            Aggressor::Unknown => panic!("mock prints carry a side"),
                        }
                    }
                    trades.push(t);
                }
                _ => {}
            }
        }
        assert!(trades.len() > 100, "{inst}: {} prints", trades.len());
        assert!(trades.windows(2).all(|w| w[0].ts <= w[1].ts));
        let buys = trades
            .iter()
            .filter(|t| t.aggressor == Aggressor::Buy)
            .count();
        assert!(buys > 0 && buys < trades.len(), "{inst}: both sides trade");
    }
}

#[tokio::test]
async fn live_bars_add_up_to_their_prints() {
    let (m, clock) = market_at(now(), 17);
    let inst = "NQZ6.CME";
    let events = tick_and_collect(&m, &clock, inst, 4 * 200);
    let mut by_minute: std::collections::BTreeMap<i64, Vec<Trade>> = Default::default();
    let mut closed: Vec<Bar> = Vec::new();
    for e in events {
        match e {
            MarketEvent::Trade(t) => by_minute
                .entry(t.ts.0.div_euclid(NANOS_PER_MINUTE) * NANOS_PER_MINUTE)
                .or_default()
                .push(t),
            MarketEvent::Bar1m {
                bar, closed: true, ..
            } => closed.push(bar),
            _ => {}
        }
    }
    let whole: Vec<&Bar> = closed.iter().filter(|b| b.t.0 > now().0).collect();
    assert!(whole.len() >= 2, "{} whole minutes", whole.len());
    for b in whole {
        let prints = &by_minute[&b.t.0];
        let v = prints.iter().fold(Qty::ZERO, |a, t| a + t.size);
        let bv = prints
            .iter()
            .filter(|t| t.aggressor == Aggressor::Buy)
            .fold(Qty::ZERO, |a, t| a + t.size);
        assert_eq!(b.v, v, "volume at {}", b.t);
        assert_eq!(b.bv, Some(bv), "buy volume at {}", b.t);
        assert!(b.is_consistent());
        assert_eq!(b.c, prints.last().unwrap().price);
        assert!(prints.iter().all(|t| t.price >= b.l && t.price <= b.h));
        assert!((150.0..8_000.0).contains(&b.v.to_f64()), "volume {}", b.v);
    }
}

#[tokio::test]
async fn depth_streams_the_book_the_quote_comes_from() {
    let (m, clock) = market_at(now(), 19);
    let inst = id("ESZ6.CME");
    let mut depth = m.subscribe_depth(&inst, 25).unwrap();
    let first = depth.next().await.unwrap();
    check_book(&first, 25);
    let q = m.quote(&inst).await.unwrap();
    assert_eq!(
        (q.bid, q.ask),
        (Some(first.bids[0].price), Some(first.asks[0].price))
    );
    for l in first.bids.iter().chain(&first.asks) {
        assert!((l.price.0 % d("0.25")).is_zero());
    }
    let mut rx = m.events();
    let mut books = 0;
    let mut quotes_match = 0;
    for _ in 0..40 {
        clock.advance(NANOS_PER_SEC / 4);
        m.advance(clock.now());
        let mut last_book = None;
        let mut last_quote = None;
        while let Ok(e) = rx.try_recv() {
            match e {
                MarketEvent::Book(b) if b.instrument == inst => last_book = Some(b),
                MarketEvent::Quote(q) if q.instrument == inst => last_quote = Some(q),
                _ => {}
            }
        }
        let (b, q) = (last_book.unwrap(), last_quote.unwrap());
        check_book(&b, 40);
        books += 1;
        quotes_match +=
            usize::from(q.bid == Some(b.bids[0].price) && q.ask == Some(b.asks[0].price));
    }
    assert_eq!(books, 40);
    assert_eq!(quotes_match, 40);
    let next = settle(
        "the next book",
        || depth.next().now_or_never().flatten(),
        Option::is_some,
    )
    .await
    .expect("the next book");
    check_book(&next, 25);
    drop(depth);
    clock.advance(NANOS_PER_SEC / 4);
    m.advance(clock.now());
    while let Ok(e) = rx.try_recv() {
        assert!(
            !matches!(e, MarketEvent::Book(_)),
            "no subscriber, no books"
        );
    }
}

#[tokio::test]
async fn the_live_tape_is_deterministic() {
    let run = |seed| {
        let (m, clock) = market_at(now(), seed);
        tick_and_collect(&m, &clock, "MNQZ6.CME", 4 * 30)
            .into_iter()
            .filter(|e| matches!(e, MarketEvent::Trade(_)))
            .collect::<Vec<_>>()
    };
    let a = run(23);
    assert!(!a.is_empty());
    assert_eq!(a, run(23));
    assert_ne!(a, run(24));
}

#[tokio::test]
async fn generated_tapes_add_up_to_history() {
    let (m, _) = market_at(now(), 29);
    for inst in ["NQZ6.CME", "QQQ", "ETH-USD.COINBASE"] {
        let bars = bars(&m, inst, Timeframe::M1).await;
        let tapes = m
            .minute_tapes(&id(inst), bars[bars.len() - 30].t, now())
            .unwrap();
        assert_eq!(tapes.len(), 30, "{inst}");
        for (bar, prints) in bars[bars.len() - 30..].iter().zip(&tapes) {
            let v = prints.iter().fold(Qty::ZERO, |a, t| a + t.size);
            let bv = prints
                .iter()
                .filter(|t| t.aggressor == Aggressor::Buy)
                .fold(Qty::ZERO, |a, t| a + t.size);
            assert_eq!(v, bar.v, "{inst} {}", bar.t);
            assert_eq!(Some(bv), bar.bv, "{inst} {}", bar.t);
            assert!(bv <= v);
            assert!(prints.iter().all(|t| t.price >= bar.l && t.price <= bar.h));
            assert_eq!(prints.first().unwrap().price, bar.o);
            assert_eq!(prints.last().unwrap().price, bar.c);
        }
    }
}

#[tokio::test]
async fn trade_history_reads_the_tapes_newest_first() {
    use tessera_market::TradesRequest;
    let (m, clock) = market_at(now(), 61);
    let nq = id("NQZ6.CME");
    for _ in 0..4 * 40 {
        clock.advance(NANOS_PER_SEC / 4);
        m.advance(clock.now());
    }
    let req = |from, to, limit| TradesRequest {
        instrument: nq.clone(),
        from,
        to,
        limit,
    };
    let last = m.get_trades(req(None, None, Some(300))).await.unwrap();
    assert_eq!(last.len(), 300);
    assert!(last.windows(2).all(|w| w[0].ts <= w[1].ts));
    assert!(last.last().unwrap().ts <= clock.now());
    let t0 = Timestamp::parse("2026-10-02T14:30:00-04:00").unwrap();
    let t1 = t0.add_nanos(10 * NANOS_PER_MINUTE);
    let window = m.get_trades(req(Some(t0), Some(t1), None)).await.unwrap();
    assert!(window.iter().all(|t| t.ts >= t0 && t.ts < t1));
    let v = window.iter().fold(Qty::ZERO, |a, t| a + t.size);
    let bars = m
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: Some(t0),
            to: Some(t1.add_nanos(-1)),
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap()
        .bars;
    assert_eq!(bars.len(), 10);
    assert_eq!(v, bars.iter().fold(Qty::ZERO, |a, b| a + b.v));
    let tail = m
        .get_trades(req(Some(t0), Some(t1), Some(25)))
        .await
        .unwrap();
    assert_eq!(tail, window[window.len() - 25..]);
    assert!(matches!(
        m.get_trades(TradesRequest {
            instrument: id("NDX"),
            from: None,
            to: None,
            limit: Some(10),
        })
        .await,
        Err(MarketError::Unsupported(_))
    ));
    assert!(matches!(
        m.get_trades(req(Some(t1), Some(t0), None)).await,
        Err(MarketError::InvalidRequest(_))
    ));
}

#[tokio::test]
async fn a_mock_that_keeps_no_trade_history_replays_the_same_prints_on_request() {
    use tessera_market::TradesRequest;
    let (keeps, _) = market_at(now(), 61);
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(clock);
    cfg.seed = 61;
    cfg.intraday_sessions = 6;
    cfg.daily_sessions = 60;
    cfg.keeps_trade_history = false;
    let replays = MockMarket::new(cfg);
    let t0 = Timestamp::parse("2026-10-02T14:30:00-04:00").unwrap();
    let req = || TradesRequest {
        instrument: id("NQZ6.CME"),
        from: Some(t0),
        to: Some(t0.add_nanos(10 * NANOS_PER_MINUTE)),
        limit: None,
    };
    assert!(keeps.keeps_trade_history());
    assert!(!replays.keeps_trade_history());
    assert!(matches!(
        replays.get_trades(req()).await,
        Err(MarketError::Unsupported(_))
    ));
    let replayed = replays.replay_trades(req()).await.unwrap();
    assert!(!replayed.is_empty());
    assert_eq!(replayed, keeps.get_trades(req()).await.unwrap());
}

#[tokio::test]
async fn any_timeframe_is_built_from_the_bars_or_prints_beneath_it() {
    let (m, _) = market_at(now(), 3);
    let nq = "NQZ6.CME";
    let tf = |s: &str| s.parse::<Timeframe>().unwrap();
    let cal = SessionCalendar::CmeEquityIndex;
    let minutes = bars(&m, nq, Timeframe::M1).await;
    for every in ["7m", "90m", "3h"] {
        let got = bars(&m, nq, tf(every)).await;
        assert_eq!(got, aggregate(&minutes, tf(every), cal), "{every}");
        assert!(got.len() > 10, "{every}");
    }
    let daily = bars(&m, nq, Timeframe::D1).await;
    let two_days = bars(&m, nq, tf("2D")).await;
    assert_eq!(two_days, aggregate(&daily, tf("2D"), cal));
    let volume = |b: &[Bar]| b.iter().fold(Qty::ZERO, |a, b| a + b.v);
    assert_eq!(volume(&two_days), volume(&daily));
    assert!(two_days.len() * 2 >= daily.len() && two_days.len() < daily.len());

    let quarter = m
        .get_bars(BarsRequest::latest(id(nq), tf("15s"), 200))
        .await
        .unwrap();
    assert_eq!(quarter.tf, tf("15s"));
    assert_eq!(quarter.bars.len(), 200);
    let closed = &quarter.bars[..quarter.bars.len() - 1];
    for b in closed {
        assert_eq!(cal.bucket_start(b.t, tf("15s")), b.t);
    }
    let minute = closed[closed.len() - 8].t;
    let minute = cal.bucket_start(minute, Timeframe::M1);
    let inside: Vec<Bar> = closed
        .iter()
        .filter(|b| cal.bucket_start(b.t, Timeframe::M1) == minute)
        .copied()
        .collect();
    let whole = minutes.iter().find(|b| b.t == minute).unwrap();
    assert_eq!(
        volume(&inside),
        whole.v,
        "a minute's 15s bars hold its prints"
    );
    assert_eq!(inside.iter().map(|b| b.h).max(), Some(whole.h));
    assert_eq!(inside.iter().map(|b| b.l).min(), Some(whole.l));
}
