use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use rust_decimal::Decimal;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Aggressor, AggressorSource, Quote, Trade};
use tessera_core::origin::Origin;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_MILLI, NANOS_PER_MINUTE, NANOS_PER_SEC, local_to_timestamp};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::hub::MarketHub;
use tessera_market::io::{
    BigTradeCuts, BigTradeMode, BigTradeOutcome, BigTradeOutcomeKind, BigTradeTier,
    BigTradesOutput, GetBigTradesInput,
};
use tessera_market::orderflow::tools::{GetBigTrades, big_trade_threshold};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket, TradesRequest,
};
use tessera_protocol::tools::ToolErrorCode;
use tessera_protocol::topics::names;
use tessera_tools::{Tool, ToolCtx, ToolError};

use Aggressor::{Buy, Sell, Unknown};
use BigTradeTier::{High, Low, Medium};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;
const TRAILING: [(u32, u32); 5] = [(9, 28), (9, 29), (9, 30), (10, 1), (10, 2)];
const SESSION_EVENTS: [(i64, usize); 5] = [(80, 3), (64, 6), (48, 15), (9, 2), (1, 250)];
const ASIA_TODAY: [(i64, Aggressor); 3] = [(47, Buy), (64, Sell), (9, Buy)];
const US_TODAY: [(i64, Aggressor); 5] =
    [(47, Buy), (48, Buy), (64, Sell), (80, Buy), (500, Unknown)];
const ES_TODAY: [(i64, Aggressor); 7] = [
    (5, Buy),
    (19, Sell),
    (29, Buy),
    (30, Buy),
    (31, Sell),
    (400, Buy),
    (500, Unknown),
];
const MNQ_TODAY: [(i64, Aggressor); 3] = [(1, Buy), (2, Buy), (3, Sell)];

fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

fn at(m: u32, d: u32, h: u32, min: u32) -> Timestamp {
    local_to_timestamp(CAL.tz(), date(m, d), h, min)
}

fn id(s: &str) -> InstrumentId {
    InstrumentId::new(s).unwrap()
}

fn now() -> Timestamp {
    at(10, 5, 12, 0)
}

fn asia_today() -> Timestamp {
    at(10, 4, 22, 0)
}

fn us_today() -> Timestamp {
    at(10, 5, 10, 30)
}

fn minute(from: Timestamp, n: usize) -> Timestamp {
    Timestamp(from.0 + n as i64 * NANOS_PER_MINUTE)
}

fn print(id: &InstrumentId, t: i64, size: i64, side: Aggressor) -> Trade {
    Trade {
        instrument: id.clone(),
        ts: Timestamp(t),
        price: Price(Decimal::from(24_000)),
        size: Qty::from(size),
        aggressor: side,
        aggressor_source: AggressorSource::Exchange,
        order_key: None,
        source: None,
    }
}

fn one_a_minute(id: &InstrumentId, from: Timestamp, events: &[(i64, Aggressor)]) -> Vec<Trade> {
    events
        .iter()
        .enumerate()
        .map(|(n, (size, side))| print(id, minute(from, n).0, *size, *side))
        .collect()
}

fn sides(sizes: impl IntoIterator<Item = i64>) -> Vec<(i64, Aggressor)> {
    sizes
        .into_iter()
        .enumerate()
        .map(|(n, size)| (size, if n % 2 == 0 { Buy } else { Sell }))
        .collect()
}

fn a_trailing_session(id: &InstrumentId, from: Timestamp) -> Vec<Trade> {
    let sizes = SESSION_EVENTS
        .iter()
        .flat_map(|(size, n)| std::iter::repeat_n(*size, *n));
    one_a_minute(id, from, &sides(sizes))
}

fn small_session(id: &InstrumentId, from: Timestamp) -> Vec<Trade> {
    one_a_minute(id, from, &sides((0..125).map(|n| 2 + n % 9)))
}

fn sweep_and_one_order(id: &InstrumentId) -> Vec<Trade> {
    let from = at(10, 5, 11, 0).0;
    let mut out: Vec<Trade> = (0..4)
        .map(|k| Trade {
            price: Price(Decimal::from(24_000) + Decimal::new(75, 2) * Decimal::from(k)),
            ..print(id, from + k * NANOS_PER_MILLI, 10, Buy)
        })
        .collect();
    let later = minute(at(10, 5, 11, 0), 1).0;
    out.extend([0, 50].map(|ms| Trade {
        order_key: Some(7),
        ..print(id, later + ms * NANOS_PER_MILLI, 6, Sell)
    }));
    out
}

fn tapes() -> HashMap<InstrumentId, Vec<Trade>> {
    let nq = id("NQZ6.CME");
    let mut tape = Vec::new();
    for (m, d) in TRAILING {
        tape.extend(a_trailing_session(&nq, at(m, d, 8, 0)));
    }
    tape.extend(one_a_minute(&nq, at(10, 4, 19, 0), &sides([200; 125])));
    tape.extend(one_a_minute(&nq, asia_today(), &ASIA_TODAY));
    tape.extend(one_a_minute(&nq, us_today(), &US_TODAY));
    let es = id("ESZ6.CME");
    let mut es_tape: Vec<Trade> = TRAILING
        .iter()
        .flat_map(|(m, d)| small_session(&es, at(*m, *d, 10, 0)))
        .collect();
    es_tape.extend(one_a_minute(&es, at(10, 5, 11, 0), &ES_TODAY));
    let mnq = id("MNQZ6.CME");
    let mes = id("MESZ6.CME");
    HashMap::from([
        (nq, tape),
        (es, es_tape),
        (mes.clone(), sweep_and_one_order(&mes)),
        (
            mnq.clone(),
            one_a_minute(&mnq, at(10, 5, 11, 0), &MNQ_TODAY),
        ),
    ])
}

struct Tape {
    mock: MockMarket,
    prints: HashMap<InstrumentId, Vec<Trade>>,
}

#[async_trait]
impl MarketDataProvider for Tape {
    fn id(&self) -> &str {
        "tape"
    }
    fn display_name(&self) -> &str {
        "Tape"
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.mock.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.mock.health()
    }
    async fn search(
        &self,
        q: &str,
        a: Option<AssetClass>,
        n: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.mock.search(q, a, n).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.mock.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.mock.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.mock.get_bars(req).await
    }
    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let from = req.from.unwrap_or(Timestamp(i64::MIN));
        let to = req.to.unwrap_or(Timestamp(i64::MAX)).min(now());
        let mut out: Vec<Trade> = self
            .prints
            .get(&req.instrument)
            .into_iter()
            .flatten()
            .filter(|t| t.ts >= from && t.ts < to)
            .cloned()
            .collect();
        if let Some(l) = req.limit
            && out.len() > l
        {
            out.drain(..out.len() - l);
        }
        Ok(out)
    }
    fn keeps_trade_history(&self) -> bool {
        true
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.mock.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.mock.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.mock.subscribe_bars(i, tf)
    }
}

fn hub() -> Arc<MarketHub> {
    let mut cfg = MockConfig::new(Arc::new(ManualClock::new(now())));
    cfg.intraday_sessions = 1;
    cfg.daily_sessions = 1;
    let tape = Arc::new(Tape {
        mock: MockMarket::new(cfg),
        prints: tapes(),
    });
    let router = MarketRouter::new();
    router.add(tape).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [names::MARKET_TRADES, names::MARKET_FOOTPRINT] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let hub = MarketHub::new(router, bus);
    hub.set_linger(Duration::ZERO);
    hub
}

fn ask(instrument: &str) -> GetBigTradesInput {
    GetBigTradesInput {
        instrument: instrument.into(),
        from: Some(at(10, 4, 21, 30)),
        to: Some(now()),
        tiers: None,
        min_size: None,
        max_size: None,
        join_orders: None,
        reach_limit: None,
        limit: Some(5000),
        days_to_load: None,
    }
}

async fn call(
    hub: &Arc<MarketHub>,
    input: GetBigTradesInput,
) -> Result<BigTradesOutput, ToolError> {
    GetBigTrades(Arc::clone(hub))
        .call(&ToolCtx::new(Origin::User, now()), input)
        .await
}

fn found(out: &BigTradesOutput) -> Vec<(Timestamp, Qty, Option<BigTradeTier>)> {
    out.trades.iter().map(|t| (t.t, t.size, t.tier)).collect()
}

fn big(
    t: Timestamp,
    size: i64,
    tier: Option<BigTradeTier>,
) -> (Timestamp, Qty, Option<BigTradeTier>) {
    (t, Qty::from(size), tier)
}

fn cuts([low, medium, high]: [i64; 3]) -> Option<BigTradeCuts> {
    Some(BigTradeCuts {
        low: Qty::from(low),
        medium: Qty::from(medium),
        high: Qty::from(high),
    })
}

#[tokio::test(start_paused = true)]
async fn auto_sizes_the_day_from_the_120th_45th_and_15th_largest_event_a_session_of_the_five_trailing()
 {
    let hub = hub();
    let out = call(&hub, ask("NQ")).await.unwrap();
    assert_eq!(
        out.rule.cuts,
        cuts([48, 64, 80]),
        "1380 minutes of events over five sessions: ranks 120, 45 and 15; today's large stretch moves none of them"
    );
    assert_eq!(
        (
            out.rule.model_sessions,
            out.rule.model_minutes,
            out.rule.model_orders
        ),
        (5, 5 * 276, 5 * 276)
    );
    assert_eq!(
        found(&out),
        vec![
            big(minute(asia_today(), 1), 64, Some(Medium)),
            big(minute(us_today(), 1), 48, Some(Low)),
            big(minute(us_today(), 2), 64, Some(Medium)),
            big(minute(us_today(), 3), 80, Some(High)),
        ],
        "one cut for the whole trade date, overnight and day; a 47 lot over the floor and the unknown side are not big"
    );
    assert_eq!(
        (out.tiers.high, out.tiers.medium, out.tiers.low, out.count),
        (1, 2, 1, 4)
    );
    assert_eq!(
        out.rule.reach_ticks,
        vec![2; 46],
        "every minute of the five sessions traded at one price, so the reach is the least"
    );
    assert!(
        out.trades.iter().all(|t| t.outcome
            == Some(BigTradeOutcome {
                kind: BigTradeOutcomeKind::Neither,
                decided: Timestamp(t.t.0 + t.duration_ns + 60 * NANOS_PER_SEC),
                reach_ticks: 2,
            })),
        "today's prints never move off 24000, so each is neither 60 s after its last print: {:?}",
        out.trades
    );
    assert_eq!(out.rule.mode, BigTradeMode::Auto);
    assert_eq!(out.rule.tiers, Some(vec![High, Medium, Low]));
    assert_eq!((out.rule.min_size, out.rule.max_size), (None, None));
    assert_eq!(
        (out.rule.size_now, out.rule.floor),
        (Qty::from(48), Qty::from(8)),
        "the Low cut"
    );
    assert!(!out.filling && out.gaps.is_empty());

    let high = call(
        &hub,
        GetBigTradesInput {
            tiers: Some(vec![High]),
            ..ask("NQ")
        },
    )
    .await
    .unwrap();
    assert_eq!(
        found(&high),
        vec![big(minute(us_today(), 3), 80, Some(High))]
    );
    assert_eq!(high.rule.size_now, Qty::from(80));

    let threshold = big_trade_threshold(&hub, &id("NQZ6.CME"), now())
        .await
        .unwrap();
    assert_eq!(
        (threshold.size, threshold.floor, threshold.sessions),
        (Qty::from(48), Qty::from(8), 5),
        "minSize auto is the Low cut of the day of the call"
    );
}

#[tokio::test(start_paused = true)]
async fn manual_shows_a_size_band_from_the_contracts_default_min_without_the_floors() {
    let hub = hub();
    let manual = |instrument: &str, min: Option<i64>, max: Option<i64>| GetBigTradesInput {
        min_size: min.map(Qty::from),
        max_size: max.map(Qty::from),
        ..ask(instrument)
    };
    let es_at = |n: usize| minute(at(10, 5, 11, 0), n);
    let sizes = |out: &BigTradesOutput| -> Vec<Qty> { out.trades.iter().map(|t| t.size).collect() };
    let lots = |l: &[i64]| -> Vec<Qty> { l.iter().map(|s| Qty::from(*s)).collect() };

    let es = call(&hub, manual("ES", Some(0), None)).await.unwrap();
    assert_eq!(
        sizes(&es),
        lots(&[30, 31, 400]),
        "ES defaults to 30, the unknown side never shows"
    );
    assert_eq!(es.rule.mode, BigTradeMode::Manual);
    assert_eq!(
        (es.rule.min_size, es.rule.max_size, es.rule.tiers.as_ref()),
        (Some(Qty::from(30)), None, None)
    );
    assert_eq!(es.rule.size_now, Qty::from(30));
    assert_eq!(es.trades[0].t, es_at(3));
    let band = call(&hub, manual("ES", None, Some(31))).await.unwrap();
    assert_eq!(sizes(&band), lots(&[30, 31]));
    assert_eq!(band.rule.max_size, Some(Qty::from(31)));
    let literal = call(&hub, manual("ES", Some(5), None)).await.unwrap();
    assert_eq!(
        sizes(&literal),
        lots(&[5, 19, 29, 30, 31, 400]),
        "below ES's floor of 20"
    );
    let both = call(&hub, manual("ES", Some(5), Some(30))).await.unwrap();
    assert_eq!(sizes(&both), lots(&[5, 19, 29, 30]));

    let mnq = call(&hub, manual("MNQ", Some(0), Some(0))).await.unwrap();
    assert_eq!(
        (sizes(&mnq), mnq.rule.min_size, mnq.rule.max_size),
        (lots(&[2, 3]), Some(Qty::from(2)), None),
        "any other contract defaults to 2, under the $500k notional"
    );
    assert!(mnq.trades.iter().all(|t| t.tier.is_none()) && mnq.rule.cuts.is_none());

    let nq = call(&hub, manual("NQ", None, Some(0))).await.unwrap();
    assert_eq!(
        found(&nq),
        vec![
            big(minute(asia_today(), 0), 47, None),
            big(minute(asia_today(), 1), 64, Some(Medium)),
            big(minute(us_today(), 0), 47, None),
            big(minute(us_today(), 1), 48, Some(Low)),
            big(minute(us_today(), 2), 64, Some(Medium)),
            big(minute(us_today(), 3), 80, Some(High)),
        ],
        "NQ defaults to 12, and each event keeps its Auto tier"
    );
    assert_eq!(nq.rule.min_size, Some(Qty::from(12)));

    for bad in [
        GetBigTradesInput {
            tiers: Some(vec![High]),
            ..manual("ES", Some(5), None)
        },
        GetBigTradesInput {
            tiers: Some(vec![]),
            ..ask("ES")
        },
        manual("ES", Some(40), Some(30)),
        manual("ES", None, Some(10)),
        manual("ES", Some(-1), None),
    ] {
        let e = call(&hub, bad.clone()).await.unwrap_err();
        assert_eq!(e.code, ToolErrorCode::InvalidInput, "{bad:?}: {e:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn an_event_under_the_floors_has_no_tier_and_the_cuts_start_at_the_floor() {
    let hub = hub();
    let es = call(
        &hub,
        GetBigTradesInput {
            min_size: Some(Qty::from(5)),
            ..ask("ES")
        },
    )
    .await
    .unwrap();
    assert_eq!(
        es.rule.cuts,
        cuts([20, 21, 22]),
        "no ES event of the five sessions reached its 20 lot floor, so the cuts start there"
    );
    let es_at = |n: usize| minute(at(10, 5, 11, 0), n);
    assert_eq!(
        found(&es),
        vec![
            big(es_at(0), 5, None),
            big(es_at(1), 19, None),
            big(es_at(2), 29, Some(High)),
            big(es_at(3), 30, Some(High)),
            big(es_at(4), 31, Some(High)),
            big(es_at(5), 400, Some(High)),
        ],
        "Manual shows the 5 and 19 lots under the floor with no tier, as the live stream never sends them"
    );
}

#[tokio::test(start_paused = true)]
async fn the_grouping_settings_regroup_the_tools_events_and_its_rule_says_which() {
    let hub = hub();
    let mes = |join_orders: Option<bool>, reach_limit: Option<bool>| GetBigTradesInput {
        min_size: Some(Qty::from(1)),
        join_orders,
        reach_limit,
        ..ask("MES")
    };
    let seen = |out: &BigTradesOutput| -> Vec<(i64, u32)> {
        out.trades
            .iter()
            .map(|t| (t.size.to_f64() as i64, t.prints))
            .collect()
    };
    let default = call(&hub, mes(None, None)).await.unwrap();
    assert_eq!(
        seen(&default),
        [(10, 1), (10, 1), (10, 1), (10, 1), (12, 2)],
        "three ticks apart the sweep is four trades; the order's fills 50 ms apart are one"
    );
    use BigTradeOutcomeKind::{Absorbed, Neither, Pushed};
    assert_eq!(
        default
            .trades
            .iter()
            .map(|t| t.outcome.map(|o| (o.kind, o.decided)))
            .collect::<Vec<_>>(),
        [
            Some((Pushed, Timestamp(at(10, 5, 11, 0).0 + NANOS_PER_MILLI))),
            Some((Pushed, Timestamp(at(10, 5, 11, 0).0 + 2 * NANOS_PER_MILLI))),
            Some((Pushed, Timestamp(at(10, 5, 11, 0).0 + 3 * NANOS_PER_MILLI))),
            Some((Absorbed, minute(at(10, 5, 11, 0), 1))),
            Some((
                Neither,
                Timestamp(
                    minute(at(10, 5, 11, 0), 1).0 + 50 * NANOS_PER_MILLI + 60 * NANOS_PER_SEC
                )
            )),
        ],
        "each step of the sweep pushed through by the next, the last taken back by the sell a minute on, and the sell left alone"
    );
    assert_eq!(
        (default.rule.join_orders, default.rule.reach_limit),
        (true, true)
    );
    assert_eq!(default.rule.multiplier, 5.0, "MES is $5 a point");
    let walk = call(&hub, mes(Some(true), Some(false))).await.unwrap();
    assert_eq!(seen(&walk), [(40, 4), (12, 2)]);
    let apart = call(&hub, mes(Some(false), Some(true))).await.unwrap();
    assert_eq!(
        seen(&apart),
        [(10, 1), (10, 1), (10, 1), (10, 1), (6, 1), (6, 1)]
    );
    let chain_only = call(&hub, mes(Some(false), Some(false))).await.unwrap();
    assert_eq!(seen(&chain_only), [(40, 4), (6, 1), (6, 1)]);
    assert_eq!(
        (chain_only.rule.join_orders, chain_only.rule.reach_limit),
        (false, false)
    );
}
