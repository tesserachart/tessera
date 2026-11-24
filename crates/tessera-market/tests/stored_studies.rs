use std::cell::RefCell;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::market::{Aggressor, AggressorSource, Trade};
use tessera_core::origin::Origin;
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle_async;
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC, local_to_timestamp};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tessera_host::{EventBus, RuntimeModule, TopicSizing};
use tessera_market::hub::PumpKey;
use tessera_market::io::{CompactFootprint, ProfileOutput};
use tessera_market::mock::MOCK_PROVIDER_ID;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{MarketModule, MarketRouter, MockConfig, MockMarket};
use tessera_protocol::topics::names;
use tessera_store::ticks::{Span, TickRow, TickStore};
use tessera_tools::{ToolCtx, ToolRegistry};

const EVERY: i64 = 15 * NANOS_PER_SEC;
const BAR: i64 = 30 * NANOS_PER_MINUTE;
const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

fn at(m: u32, d: u32, h: u32, min: u32) -> i64 {
    local_to_timestamp(CAL.tz(), date(m, d), h, min).0
}

fn session(m: u32, d: u32) -> Span {
    let s = CAL.session(date(m, d)).unwrap();
    Span::new(s.open.0, s.close.0)
}

fn saturday() -> i64 {
    at(10, 3, 12, 0)
}

fn print(t: i64) -> Trade {
    let k = t / EVERY;
    Trade {
        instrument: InstrumentId::new("NQZ6.CME").unwrap(),
        ts: Timestamp(t),
        price: Price(
            Decimal::from(24_000) + Decimal::from_str("0.25").unwrap() * Decimal::from(k % 40),
        ),
        size: Qty::from(1 + k % 5),
        aggressor: if k % 2 == 0 {
            Aggressor::Buy
        } else {
            Aggressor::Sell
        },
        aggressor_source: AggressorSource::Exchange,
        order_key: None,
        source: None,
    }
}

fn truth(span: Span) -> Vec<Trade> {
    let first = span.start + (EVERY - span.start.rem_euclid(EVERY)) % EVERY;
    (first..span.end)
        .step_by(EVERY as usize)
        .filter(|t| CAL.is_open(Timestamp(*t)))
        .map(print)
        .collect()
}

fn hole() -> Span {
    Span::new(at(9, 30, 10, 10), at(9, 30, 11, 20))
}

fn stored() -> Vec<Span> {
    let wed = session(9, 30);
    vec![
        session(9, 29),
        Span::new(wed.start, hole().start),
        Span::new(hole().end, wed.end),
        session(10, 2),
    ]
}

fn stored_prints(within: Span) -> Vec<Trade> {
    stored()
        .into_iter()
        .flat_map(|s| truth(Span::new(s.start.max(within.start), s.end.min(within.end))))
        .collect()
}

struct Closed {
    tools: ToolRegistry,
    _module: MarketModule,
    _chart: tessera_market::hub::MarketPumpGuard,
}

async fn closed_market_with_stored_days() -> Closed {
    let clock = Arc::new(ManualClock::new(Timestamp(saturday())));
    let mut cfg = MockConfig::new(clock);
    cfg.intraday_sessions = 6;
    cfg.daily_sessions = 5;
    cfg.keeps_trade_history = false;
    cfg.refuses_replays = true;
    let router = MarketRouter::new();
    router.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [names::MARKET_TRADES, names::MARKET_FOOTPRINT] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
    let nq = InstrumentId::new("NQZ6.CME").unwrap();
    let contract = Contract::new(MOCK_PROVIDER_ID, &nq);
    for s in stored() {
        let rows: Vec<TickRow> = truth(s).iter().map(TickRow::of).collect();
        saved.save_now(&contract, CAL, &rows, s).unwrap();
    }
    let module = MarketModule::new(router, bus);
    let hub = module.hub();
    hub.set_linger(Duration::ZERO);
    hub.set_saved_trades(saved);
    let chart = hub.acquire(PumpKey::Trades(nq)).unwrap();
    let mut tools = ToolRegistry::new();
    module.register_tools(&mut tools).unwrap();
    Closed {
        tools,
        _module: module,
        _chart: chart,
    }
}

async fn call(c: &Closed, tool: &str, input: Value) -> Value {
    let user = ToolCtx::new(Origin::User, Timestamp(saturday()));
    c.tools
        .get(tool)
        .unwrap()
        .call_json(&user, input)
        .await
        .unwrap()
        .value
}

async fn settled(c: &Closed, tool: &str, input: Value) -> Value {
    let last = RefCell::new(Value::Null);
    let kept = &last;
    let input = &input;
    settle_async(
        tool,
        || async move {
            let out = call(c, tool, input.clone()).await;
            let seen = [&out["filling"], &out["loading"], &out["gaps"]].map(Value::clone);
            *kept.borrow_mut() = out;
            seen
        },
        |[filling, loading, _]| *filling != json!(true) && *loading != json!(true),
    )
    .await;
    last.into_inner()
}

fn footprint_ask() -> Value {
    json!({
        "instrument": "NQZ6.CME",
        "tf": "30m",
        "from": session(9, 29).start,
        "to": at(10, 2, 16, 30),
        "limit": 200,
        "rowTicks": 1,
    })
}

fn whole_bars_of(prints: &[Trade]) -> BTreeMap<i64, (Qty, Qty)> {
    let inside = |b: i64| stored().iter().any(|s| s.start <= b && b + BAR <= s.end);
    let mut bars: BTreeMap<i64, (Qty, Qty)> = BTreeMap::new();
    for t in prints {
        let open = t.ts.0 - t.ts.0.rem_euclid(BAR);
        if !inside(open) {
            continue;
        }
        let (volume, delta) = bars.entry(open).or_insert((Qty::ZERO, Qty::ZERO));
        *volume = *volume + t.size;
        *delta = match t.aggressor {
            Aggressor::Buy => *delta + t.size,
            _ => *delta - t.size,
        };
    }
    bars
}

#[tokio::test(start_paused = true)]
async fn stored_days_with_gaps_build_footprints_profiles_and_big_trades_with_the_market_closed() {
    let c = closed_market_with_stored_days().await;
    let range = Span::new(session(9, 29).start, session(10, 2).end);

    let fp = settled(&c, "market.get_footprint", footprint_ask()).await;
    let bars: Vec<CompactFootprint> = serde_json::from_value(fp["bars"].clone()).unwrap();
    let got: BTreeMap<i64, (Qty, Qty)> =
        bars.iter().map(|b| (b.t.0, (b.volume, b.delta))).collect();
    let want = whole_bars_of(&stored_prints(range));
    assert_eq!(
        got.keys().collect::<Vec<_>>(),
        want.keys().collect::<Vec<_>>(),
        "every bar wholly inside a stored span, none in the hole or the day not stored"
    );
    assert_eq!(got, want, "each bar holds every stored print of it");

    let vp = settled(
        &c,
        "market.get_volume_profile",
        json!({"instrument": "NQZ6.CME", "mode": "session", "sessions": 4}),
    )
    .await;
    let profiles: Vec<ProfileOutput> = serde_json::from_value(vp["profiles"].clone()).unwrap();
    let by_day: Vec<(Option<NaiveDate>, u64)> =
        profiles.iter().map(|p| (p.trade_date, p.prints)).collect();
    let count = |s: Span| stored_prints(s).len() as u64;
    assert_eq!(
        by_day,
        vec![
            (Some(date(9, 29)), count(session(9, 29))),
            (Some(date(9, 30)), count(session(9, 30))),
            (Some(date(10, 1)), 0),
            (Some(date(10, 2)), count(session(10, 2))),
        ],
        "each session profile counts every print stored for it"
    );
    let volume = |s: Span| stored_prints(s).iter().fold(Qty::ZERO, |v, t| v + t.size);
    assert_eq!(profiles[0].volume, volume(session(9, 29)));
    assert_eq!(profiles[1].volume, volume(session(9, 30)));

    let span = Span::new(at(9, 30, 9, 0), at(9, 30, 13, 0));
    let big = settled(
        &c,
        "market.get_big_trades",
        json!({
            "instrument": "NQZ6.CME",
            "from": span.start,
            "to": span.end,
            "minSize": 1,
            "limit": 5000,
        }),
    )
    .await;
    let times: Vec<i64> = big["trades"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["t"].as_i64().unwrap())
        .collect();
    let want: Vec<i64> = stored_prints(span).iter().map(|t| t.ts.0).collect();
    assert_eq!(
        times, want,
        "every stored print of Wednesday's morning is an event, before and after the hole"
    );
}

fn spans_of(gaps: &Value) -> Vec<Span> {
    gaps.as_array()
        .unwrap_or_else(|| panic!("gaps is a list: {gaps}"))
        .iter()
        .map(|g| Span::new(g["from"].as_i64().unwrap(), g["to"].as_i64().unwrap()))
        .collect()
}

fn session_parts(m: u32, d: u32) -> Vec<Span> {
    CAL.session(date(m, d))
        .unwrap()
        .segments
        .iter()
        .map(|w| Span::new(w.start.0, w.end.0))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn answers_over_stored_days_name_their_gaps_and_stop_filling_when_replays_are_refused() {
    let c = closed_market_with_stored_days().await;

    let fp = settled(&c, "market.get_footprint", footprint_ask()).await;
    let mut want = vec![hole()];
    want.extend(session_parts(10, 1));
    assert_eq!(
        spans_of(&fp["gaps"]),
        want,
        "the hole and the day not stored"
    );
    assert_eq!(
        fp["filling"],
        json!(false),
        "the replay refused: nothing is coming"
    );
    assert_eq!(fp["truncated"], json!(false));
    assert_eq!(
        fp["firstOpen"],
        json!(session(9, 29).start),
        "the oldest bar the answer accounts for"
    );

    let older = settled(
        &c,
        "market.get_footprint",
        json!({
            "instrument": "NQZ6.CME",
            "tf": "30m",
            "to": session(9, 29).start - 1,
            "limit": 46,
            "rowTicks": 1,
        }),
    )
    .await;
    assert_eq!(
        older["bars"],
        json!([]),
        "nothing stored the session before"
    );
    assert_eq!(spans_of(&older["gaps"]), session_parts(9, 28));
    assert_eq!(older["firstOpen"], json!(session(9, 28).start));

    let vp = settled(
        &c,
        "market.get_volume_profile",
        json!({"instrument": "NQZ6.CME", "mode": "session", "sessions": 4}),
    )
    .await;
    let gaps: Vec<Vec<Span>> = vp["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| spans_of(&p["gaps"]))
        .collect();
    assert_eq!(
        gaps,
        vec![vec![], vec![hole()], session_parts(10, 1), vec![]],
        "each session profile names the gaps within it"
    );
    assert_eq!(vp["filling"], json!(false));
}

fn times_of(out: &Value) -> Vec<i64> {
    out["trades"]
        .as_array()
        .unwrap_or_else(|| panic!("trades is a list: {out}"))
        .iter()
        .map(|t| t[0].as_i64().unwrap())
        .collect()
}

fn newest_prints(limit: usize) -> Value {
    json!({"instrument": "NQZ6.CME", "to": saturday(), "limit": limit, "aggregate": false})
}

#[tokio::test(start_paused = true)]
async fn the_newest_prints_with_the_market_closed_are_the_last_sessions_close() {
    let c = closed_market_with_stored_days().await;

    let tape = settled(&c, "market.get_trades", newest_prints(50)).await;
    let friday = truth(session(10, 2));
    let want: Vec<i64> = friday[friday.len() - 50..].iter().map(|t| t.ts.0).collect();
    assert_eq!(
        times_of(&tape),
        want,
        "Friday's last 50 prints, up to its close"
    );
}

async fn closed_market_on_a_fresh_install() -> (Closed, MockMarket) {
    let clock = Arc::new(ManualClock::new(Timestamp(saturday())));
    let mut cfg = MockConfig::new(clock);
    cfg.intraday_sessions = 6;
    cfg.daily_sessions = 5;
    cfg.keeps_trade_history = false;
    let mock = MockMarket::new(cfg);
    let router = MarketRouter::new();
    router.add(Arc::new(mock.clone())).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [names::MARKET_TRADES, names::MARKET_FOOTPRINT] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let module = MarketModule::new(router, bus);
    let hub = module.hub();
    hub.set_linger(Duration::ZERO);
    hub.set_saved_trades(SavedTrades::new(Arc::new(
        TickStore::open_in_memory().unwrap(),
    )));
    let chart = hub
        .acquire(PumpKey::Trades(InstrumentId::new("NQZ6.CME").unwrap()))
        .unwrap();
    let mut tools = ToolRegistry::new();
    module.register_tools(&mut tools).unwrap();
    let closed = Closed {
        tools,
        _module: module,
        _chart: chart,
    };
    (closed, mock)
}

#[tokio::test(start_paused = true)]
async fn a_fresh_install_with_the_market_closed_says_filling_until_the_last_session_is_in() {
    use tessera_market::provider::{MarketDataProvider, TradesRequest};
    let (c, mock) = closed_market_on_a_fresh_install().await;

    for aggregate in [false, true] {
        let mut ask = newest_prints(50);
        ask["aggregate"] = json!(aggregate);
        let first = call(&c, "market.get_trades", ask).await;
        assert!(
            first["filling"] == json!(true) || !times_of(&first).is_empty(),
            "an empty first answer says the last session is still coming: {first}"
        );
    }

    let tape = settled(&c, "market.get_trades", newest_prints(50)).await;
    let close = session(10, 2);
    let friday = mock
        .replay_trades(TradesRequest {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            from: Some(Timestamp(close.end - 30 * NANOS_PER_MINUTE)),
            to: Some(Timestamp(close.end)),
            limit: None,
        })
        .await
        .unwrap();
    let want: Vec<i64> = friday[friday.len() - 50..].iter().map(|t| t.ts.0).collect();
    assert_eq!(times_of(&tape), want, "Friday's last 50 prints, replayed");
}
