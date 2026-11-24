use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_decimal::Decimal;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::health::ProviderHealth;
use tessera_core::ids::SessionId;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Aggressor, Quote, Trade};
use tessera_core::origin::Origin;
use tessera_core::settle::settle;
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::aggregate::aggregate;
use tessera_market::hub::{MarketHub, PumpKey};
use tessera_market::io::{
    BigTradeMode, BigTradeTier, DeltaBasis, GetBigTradesInput, GetDeltaInput,
    GetVolumeProfileInput, ProfileMode, ProfileOutput, ProfilePeriod, SessionFilter,
};
use tessera_market::orderflow::big_trades::{Grouping, OrderAggregator};
use tessera_market::orderflow::delta::DeltaReset;
use tessera_market::orderflow::profile::ProfileBuilder;
use tessera_market::orderflow::tools::{GetBigTrades, GetDelta, GetVolumeProfile};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket, TradesRequest,
};
use tessera_protocol::tools::ToolErrorCode;
use tessera_protocol::topics::names;
use tessera_tools::{Tool, ToolCtx};

fn now() -> Timestamp {
    Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap()
}

fn id(s: &str) -> InstrumentId {
    InstrumentId::new(s).unwrap()
}

struct Desk {
    market: MockMarket,
    clock: Arc<ManualClock>,
    hub: Arc<MarketHub>,
}

fn hub_over(provider: Arc<dyn MarketDataProvider>) -> Arc<MarketHub> {
    let router = MarketRouter::new();
    router.add(provider).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [
        names::MARKET_TRADES,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
    ] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let hub = MarketHub::new(router, bus);
    hub.set_linger(Duration::ZERO);
    hub
}

fn desk(seed: u64) -> Desk {
    desk_of(seed, 3)
}

fn desk_of(seed: u64, intraday_sessions: usize) -> Desk {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.seed = seed;
    cfg.intraday_sessions = intraday_sessions;
    cfg.daily_sessions = 20;
    let market = MockMarket::new(cfg);
    let hub = hub_over(Arc::new(market.clone()));
    Desk { market, clock, hub }
}

fn agent(at: Timestamp) -> ToolCtx {
    ToolCtx::new(
        Origin::Agent {
            session_id: SessionId::new("S1"),
            provider: "test".into(),
        },
        at,
    )
}

async fn minute_bars(
    m: &dyn MarketDataProvider,
    id: &InstrumentId,
    from: Timestamp,
    to: Timestamp,
) -> Vec<tessera_core::market::Bar> {
    m.get_bars(BarsRequest {
        instrument: id.clone(),
        tf: Timeframe::M1,
        from: Some(from),
        to: Some(Timestamp(to.0 - 1)),
        limit: None,
        rth_only: false,
    })
    .await
    .unwrap()
    .bars
}

fn sum(v: impl Iterator<Item = Qty>) -> Qty {
    v.fold(Qty::ZERO, |a, b| a + b)
}

#[tokio::test]
async fn a_session_profile_adds_up_to_its_bars() {
    let d = desk(71);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let out = tool
        .call(
            &agent(now()),
            GetVolumeProfileInput {
                instrument: "NQ".into(),
                mode: None,
                period: None,
                count: None,
                sessions: None,
                from: None,
                to: None,
                session: Some(SessionFilter::Rth),
                tpo_minutes: None,
                row_ticks: None,
                max_rows: None,
                value_area_percent: None,
                days_to_load: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(out.mode, ProfileMode::Session);
    assert_eq!(out.provider, "mock");
    assert_eq!(out.profiles.len(), 1);
    let p = &out.profiles[0];
    assert_eq!(
        p.from,
        Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap()
    );
    assert_eq!(p.to, now());
    let bars = minute_bars(&d.market, &id("NQZ6.CME"), p.from, p.to).await;
    let whole: Vec<_> = bars
        .iter()
        .filter(|b| b.t.0 + NANOS_PER_MINUTE <= now().0)
        .collect();
    let whole_v = sum(whole.iter().map(|b| b.v));
    assert!(p.volume >= whole_v, "{} < {}", p.volume, whole_v);
    assert!(p.volume <= sum(bars.iter().map(|b| b.v)));
    assert_eq!(
        p.buy_volume + p.sell_volume,
        p.volume,
        "every mock print has a side"
    );
    assert_eq!(p.delta, p.buy_volume - p.sell_volume);
    assert!(p.rows.len() <= 60 && !p.rows.is_empty());
    assert!(p.rows.windows(2).all(|w| w[0].0 < w[1].0));
    assert_eq!(sum(p.rows.iter().map(|r| r.1)), p.volume);
    let (poc, val, vah) = (p.poc.unwrap(), p.val.unwrap(), p.vah.unwrap());
    assert!(p.low.unwrap() <= val && val <= poc && poc <= vah && vah <= p.high.unwrap());
    let traded = |b: &&tessera_core::market::Bar| b.t.0 + NANOS_PER_MINUTE <= now().0;
    let bar_high = bars.iter().filter(traded).map(|b| b.h).max().unwrap();
    let bar_low = bars.iter().filter(traded).map(|b| b.l).min().unwrap();
    assert!(p.high.unwrap() >= bar_high, "{:?} < {bar_high}", p.high);
    assert!(p.low.unwrap() <= bar_low, "{:?} > {bar_low}", p.low);
    assert!(p.row > Price(Decimal::new(25, 2)), "rows of several ticks");
    let va = p.value_area_volume.0 / p.volume.0;
    assert!(va >= Decimal::new(70, 2), "value area holds {va}");
    let poc_row = p.rows.iter().find(|r| r.0 == poc).unwrap();
    assert!(p.rows.iter().all(|r| r.1 <= poc_row.1));
    let ticks = p.row.0 / Decimal::new(25, 2);
    assert_eq!(ticks.fract(), Decimal::ZERO);
    assert!(p.rows.iter().all(|r| (r.0.0 / p.row.0).fract().is_zero()));
}

#[tokio::test]
async fn composite_profiles_merge_sessions_and_ranges_follow_their_bars() {
    let d = desk(72);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let input = |mode, sessions| GetVolumeProfileInput {
        instrument: "QQQ".into(),
        mode: Some(mode),
        period: None,
        count: None,
        sessions,
        from: None,
        to: None,
        session: Some(SessionFilter::Rth),
        tpo_minutes: None,
        row_ticks: Some(10),
        max_rows: Some(500),
        value_area_percent: Some(80.0),
        days_to_load: None,
    };
    let each = tool
        .call(&agent(now()), input(ProfileMode::Session, Some(2)))
        .await
        .unwrap();
    assert_eq!(each.profiles.len(), 2);
    assert_eq!(
        each.profiles[0].trade_date,
        chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
    );
    assert_eq!(each.profiles[0].row, Price(Decimal::new(10, 2)));
    let yesterday = &each.profiles[0];
    let bars = minute_bars(&d.market, &id("QQQ"), yesterday.from, yesterday.to).await;
    assert_eq!(yesterday.volume, sum(bars.iter().map(|b| b.v)));
    assert_eq!(yesterday.buy_volume, sum(bars.iter().filter_map(|b| b.bv)));
    assert!(yesterday.value_area_volume.0 >= yesterday.volume.0 * Decimal::new(80, 2));

    let comp = tool
        .call(&agent(now()), input(ProfileMode::Composite, Some(2)))
        .await
        .unwrap();
    assert_eq!(comp.profiles.len(), 1);
    let c = &comp.profiles[0];
    assert_eq!(c.volume, each.profiles[0].volume + each.profiles[1].volume);
    assert_eq!((c.from, c.to), (each.profiles[0].from, each.profiles[1].to));
    let again = tool
        .call(&agent(now()), input(ProfileMode::Session, Some(2)))
        .await
        .unwrap();
    assert_eq!(again.profiles[0], each.profiles[0]);

    let from = Timestamp::parse("2026-10-02T10:00:00-04:00").unwrap();
    let to = Timestamp::parse("2026-10-02T10:30:00-04:00").unwrap();
    let range = tool
        .call(
            &agent(now()),
            GetVolumeProfileInput {
                from: Some(from),
                to: Some(to),
                ..input(ProfileMode::Range, None)
            },
        )
        .await
        .unwrap();
    let bars = minute_bars(&d.market, &id("QQQ"), from, to).await;
    assert_eq!(bars.len(), 30);
    assert_eq!(range.profiles[0].volume, sum(bars.iter().map(|b| b.v)));
    let hi = bars.iter().map(|b| b.h).max().unwrap();
    let lo = bars.iter().map(|b| b.l).min().unwrap();
    assert!(
        range.profiles[0].high.unwrap() <= hi
            && range.profiles[0].low.unwrap() >= Price(lo.0 - Decimal::new(10, 2))
    );

    let e = tool
        .call(&agent(now()), input(ProfileMode::Range, None))
        .await
        .unwrap_err();
    assert!(e.message.contains("from"), "{}", e.message);
    let e = tool
        .call(
            &agent(now()),
            GetVolumeProfileInput {
                value_area_percent: Some(100.0),
                ..input(ProfileMode::Session, None)
            },
        )
        .await
        .unwrap_err();
    assert!(e.message.contains("valueAreaPercent"));
    let e = tool
        .call(
            &agent(now()),
            GetVolumeProfileInput {
                instrument: "NDX".into(),
                ..input(ProfileMode::Session, None)
            },
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::Unsupported);
}

fn vp(mode: ProfileMode) -> GetVolumeProfileInput {
    GetVolumeProfileInput {
        instrument: "NQ".into(),
        mode: Some(mode),
        row_ticks: Some(1),
        max_rows: Some(500),
        ..GetVolumeProfileInput::default()
    }
}

fn et(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn date(m: u32, d: u32) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::from_ymd_opt(2026, m, d)
}

fn within<'a>(parts: &'a [ProfileOutput], whole: &ProfileOutput) -> Vec<&'a ProfileOutput> {
    parts
        .iter()
        .filter(|p| p.from >= whole.from && p.to <= whole.to)
        .collect()
}

async fn truth(d: &Desk, from: Timestamp, to: Timestamp) -> Qty {
    let mut b = ProfileBuilder::new(Price(Decimal::new(25, 2)));
    d.hub
        .each_print(&id("NQZ6.CME"), from, to, |t| b.push_trade(t))
        .await
        .unwrap();
    b.finish(1, 0.7).volume
}

#[tokio::test]
async fn weeks_months_and_days_are_their_sessions_on_the_calendar() {
    let d = desk_of(81, 25);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let ctx = agent(now());
    let call = |input| tool.call(&ctx, input);
    let sessions = call(GetVolumeProfileInput {
        count: Some(10),
        ..vp(ProfileMode::Session)
    })
    .await
    .unwrap();
    assert_eq!(sessions.period, Some(ProfilePeriod::Session));
    let weeks = call(GetVolumeProfileInput {
        count: Some(2),
        ..vp(ProfileMode::Week)
    })
    .await
    .unwrap();
    assert_eq!(weeks.period, Some(ProfilePeriod::Week));
    assert_eq!(weeks.profiles.len(), 2);
    for w in &weeks.profiles {
        let parts = within(&sessions.profiles, w);
        assert_eq!(parts.len(), 5, "{:?}", w.trade_date);
        assert_eq!(w.volume, sum(parts.iter().map(|p| p.volume)));
        assert_eq!(w.buy_volume, sum(parts.iter().map(|p| p.buy_volume)));
        assert!(w.poc.is_some() && w.val <= w.poc && w.poc <= w.vah);
    }
    let this_week = &weeks.profiles[1];
    assert_eq!(this_week.trade_date, date(9, 28));
    assert_eq!(this_week.from, et("2026-09-27T18:00:00-04:00"));
    assert_eq!(this_week.to, now());
    assert_eq!(this_week.session_end, Some(et("2026-10-02T17:00:00-04:00")));
    assert_eq!(weeks.profiles[0].trade_date, date(9, 21));

    let one = call(vp(ProfileMode::Week)).await.unwrap();
    assert_eq!(one.profiles, vec![this_week.clone()]);
    let three = call(GetVolumeProfileInput {
        period: Some(ProfilePeriod::Week),
        count: Some(3),
        ..vp(ProfileMode::Composite)
    })
    .await
    .unwrap();
    assert_eq!(three.period, Some(ProfilePeriod::Week));
    let c = &three.profiles[0];
    assert_eq!(c.from, et("2026-09-13T18:00:00-04:00"));
    assert_eq!(c.to, now());
    assert_eq!(c.volume, truth(&d, c.from, c.to).await);

    let october = call(vp(ProfileMode::Month)).await.unwrap();
    let m = &october.profiles[0];
    assert_eq!(m.trade_date, date(10, 1));
    assert_eq!(m.from, et("2026-09-30T18:00:00-04:00"));
    assert_eq!(m.session_end, Some(et("2026-10-30T17:00:00-04:00")));
    let parts = within(&sessions.profiles, m);
    assert_eq!(parts.len(), 2);
    assert_eq!(m.volume, sum(parts.iter().map(|p| p.volume)));

    let days = call(GetVolumeProfileInput {
        count: Some(2),
        ..vp(ProfileMode::Day)
    })
    .await
    .unwrap();
    let today = &days.profiles[1];
    assert_eq!(today.trade_date, date(10, 2));
    assert_eq!(today.from, et("2026-10-02T00:00:00-04:00"));
    assert_eq!(today.volume, truth(&d, today.from, now()).await);
    assert_eq!(days.profiles[0].from, et("2026-10-01T00:00:00-04:00"));

    let rth = call(GetVolumeProfileInput {
        session: Some(SessionFilter::Rth),
        ..vp(ProfileMode::Week)
    })
    .await
    .unwrap();
    assert_eq!(rth.profiles[0].from, et("2026-09-28T09:30:00-04:00"));
    assert!(rth.profiles[0].volume < this_week.volume);

    let e = call(GetVolumeProfileInput {
        period: Some(ProfilePeriod::Month),
        ..vp(ProfileMode::Week)
    })
    .await
    .unwrap_err();
    assert!(e.message.contains("composite"), "{}", e.message);
    let e = call(GetVolumeProfileInput {
        count: Some(2),
        sessions: Some(3),
        ..vp(ProfileMode::Session)
    })
    .await
    .unwrap_err();
    assert!(e.message.contains("count"), "{}", e.message);
    let quarter = call(GetVolumeProfileInput {
        period: Some(ProfilePeriod::Week),
        count: Some(13),
        ..vp(ProfileMode::Composite)
    })
    .await
    .unwrap();
    let q = &quarter.profiles[0];
    assert!(
        q.from > et("2026-07-05T18:00:00-04:00"),
        "a 13-week composite reaches back only as far as prints are held"
    );
    assert!(q.from <= c.from && q.gaps.is_empty());
    assert_eq!(q.volume, truth(&d, q.from, q.to).await);
    let rth_range = call(GetVolumeProfileInput {
        from: Some(et("2026-09-30T12:00:00-04:00")),
        to: Some(et("2026-10-02T11:00:00-04:00")),
        session: Some(SessionFilter::Rth),
        ..vp(ProfileMode::Range)
    })
    .await
    .unwrap();
    let in_rth = truth(
        &d,
        et("2026-09-30T12:00:00-04:00"),
        et("2026-09-30T16:00:00-04:00"),
    )
    .await
        + truth(
            &d,
            et("2026-10-01T09:30:00-04:00"),
            et("2026-10-01T16:00:00-04:00"),
        )
        .await
        + truth(
            &d,
            et("2026-10-02T09:30:00-04:00"),
            et("2026-10-02T11:00:00-04:00"),
        )
        .await;
    assert_eq!(
        rth_range.profiles[0].volume, in_rth,
        "a range in regular hours"
    );
}

#[tokio::test]
async fn a_market_profile_is_the_profiles_prints_in_thirty_minute_brackets_from_each_open() {
    let d = desk_of(83, 8);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let ctx = agent(now());
    let half_hour = 30 * NANOS_PER_MINUTE;
    let plain = tool.call(&ctx, vp(ProfileMode::Session)).await.unwrap();
    assert!(plain.profiles[0].tpo.is_none(), "only asked for");
    let rth = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                count: Some(2),
                session: Some(SessionFilter::Rth),
                tpo_minutes: Some(30),
                ..vp(ProfileMode::Session)
            },
        )
        .await
        .unwrap();
    for p in &rth.profiles {
        let tpo = p.tpo.as_ref().unwrap();
        assert_eq!(tpo.minutes, 30);
        assert!(!tpo.brackets.is_empty());
        let bars = minute_bars(&d.market, &id("NQZ6.CME"), p.from, p.to).await;
        for b in &tpo.brackets {
            let inside: Vec<_> = bars
                .iter()
                .filter(|x| x.t >= b.0 && x.t.0 < b.0.0 + half_hour)
                .collect();
            assert_eq!(
                b.1 as i64,
                (b.0.0 - p.from.0) / half_hour,
                "A is the open's bracket"
            );
            assert_eq!(b.2, inside.iter().map(|x| x.l).min().unwrap(), "{b:?}");
            assert_eq!(b.3, inside.iter().map(|x| x.h).max().unwrap(), "{b:?}");
        }
        let first_hour: Vec<_> = bars
            .iter()
            .filter(|x| x.t.0 < p.from.0 + 2 * half_hour)
            .collect();
        if p.to.0 >= p.from.0 + 2 * half_hour {
            assert_eq!(tpo.ib_high, first_hour.iter().map(|x| x.h).max());
            assert_eq!(tpo.ib_low, first_hour.iter().map(|x| x.l).min());
        }
        let (poc, val, vah) = (tpo.poc.unwrap(), tpo.val.unwrap(), tpo.vah.unwrap());
        assert!(p.low.unwrap() <= val && val <= poc && poc <= vah && vah <= p.high.unwrap());
    }

    let week = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                tpo_minutes: Some(30),
                ..vp(ProfileMode::Week)
            },
        )
        .await
        .unwrap();
    let w = &week.profiles[0];
    let tpo = w.tpo.as_ref().unwrap();
    let opens = tpo.brackets.iter().filter(|b| b.1 == 0).count();
    let sessions = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                count: Some(8),
                tpo_minutes: Some(30),
                ..vp(ProfileMode::Session)
            },
        )
        .await
        .unwrap();
    let parts = within(&sessions.profiles, w);
    assert_eq!(opens, parts.len(), "letters start again at each session");
    let joined: Vec<_> = parts
        .iter()
        .flat_map(|p| p.tpo.as_ref().unwrap().brackets.clone())
        .collect();
    assert_eq!(tpo.brackets, joined, "a week is its sessions' brackets");

    let e = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                tpo_minutes: Some(0),
                ..vp(ProfileMode::Session)
            },
        )
        .await
        .unwrap_err();
    assert!(e.message.contains("tpoMinutes"), "{}", e.message);
}

async fn delta_study_over(d: &Desk, tf: Timeframe, from: Timestamp, to: Timestamp) -> f64 {
    let nq = id("NQZ6.CME");
    let spec = d.market.spec(&nq).await.unwrap().1;
    let ones = minute_bars(&d.market, &nq, from, to).await;
    let opens: Vec<Timestamp> = aggregate(&ones, tf, spec.sessions)
        .iter()
        .map(|b| b.t)
        .collect();
    let read = d
        .hub
        .bar_flows(&nq, tf, &opens, false, u64::MAX, now())
        .await
        .unwrap();
    assert_eq!(read.unread, 0);
    read.bars
        .iter()
        .map(|b| b.expect("every bar's flow is known").sides.delta)
        .sum()
}

#[tokio::test]
async fn every_profiles_delta_is_the_delta_studys_over_its_bars() {
    let d = desk_of(85, 8);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let ctx = agent(now());
    let call = |input| tool.call(&ctx, input);
    let asks = [
        (
            "session",
            GetVolumeProfileInput {
                count: Some(3),
                ..vp(ProfileMode::Session)
            },
        ),
        (
            "rth session",
            GetVolumeProfileInput {
                count: Some(2),
                session: Some(SessionFilter::Rth),
                ..vp(ProfileMode::Session)
            },
        ),
        (
            "day",
            GetVolumeProfileInput {
                count: Some(2),
                ..vp(ProfileMode::Day)
            },
        ),
        ("week", vp(ProfileMode::Week)),
        (
            "composite",
            GetVolumeProfileInput {
                period: Some(ProfilePeriod::Session),
                count: Some(3),
                ..vp(ProfileMode::Composite)
            },
        ),
    ];
    for (name, ask) in asks {
        let out = call(ask).await.unwrap();
        assert!(!out.profiles.is_empty(), "{name}");
        for p in &out.profiles {
            assert!(p.gaps.is_empty(), "{name} {:?}", p.trade_date);
            let by_row = sum(p.rows.iter().map(|r| r.2)) - sum(p.rows.iter().map(|r| r.3));
            assert_eq!(by_row, p.delta, "{name}: its rows add up to its delta");
            assert_ne!(p.delta, Qty::ZERO, "{name}");
            for tf in [Timeframe::M1, Timeframe::M5] {
                assert_eq!(
                    delta_study_over(&d, tf, p.from, p.to).await,
                    p.delta.to_f64(),
                    "{name} {:?} on {tf}",
                    p.trade_date
                );
            }
        }
    }
}

#[tokio::test]
async fn a_thirteen_week_rolling_composite_is_one_call_over_a_quarter_of_prints() {
    let d = desk_of(83, 70);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let ctx = agent(now());
    let quarter = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                period: Some(ProfilePeriod::Week),
                count: Some(13),
                ..vp(ProfileMode::Composite)
            },
        )
        .await
        .unwrap();
    let q = &quarter.profiles[0];
    assert_eq!(q.to, now());
    assert!(q.gaps.is_empty(), "{:?}", q.gaps);
    assert_eq!(q.volume, truth(&d, q.from, q.to).await);
    let weeks = tool
        .call(
            &ctx,
            GetVolumeProfileInput {
                count: Some(13),
                ..vp(ProfileMode::Week)
            },
        )
        .await
        .unwrap();
    assert_eq!(weeks.profiles.len(), 13);
    assert_eq!(weeks.profiles[0].trade_date, date(7, 6));
    assert_eq!(
        q.from, weeks.profiles[0].from,
        "a quarter back, from the week of 6 July"
    );
    assert_eq!(
        q.volume,
        weeks
            .profiles
            .iter()
            .map(|w| w.volume)
            .fold(Qty::ZERO, |a, b| a + b),
        "the composite is its weeks added up"
    );
}

#[tokio::test]
async fn a_range_over_three_weeks_draws_once_and_then_from_what_it_kept() {
    let d = desk_of(82, 25);
    let tool = GetVolumeProfile::new(Arc::clone(&d.hub));
    let from = et("2026-09-09T11:00:00-04:00");
    let to = et("2026-10-02T13:00:00-04:00");
    let range = GetVolumeProfileInput {
        from: Some(from),
        to: Some(to),
        ..vp(ProfileMode::Range)
    };
    let first = tool.call(&agent(now()), range.clone()).await.unwrap();
    assert_eq!(first.period, None);
    let p = &first.profiles[0];
    assert_eq!((p.from, p.to), (from, to));
    assert_eq!(p.volume, truth(&d, from, to).await);
    assert!(p.rows.len() > 100 && p.poc.is_some());
    let before = d.market.prints_served();
    let again = tool.call(&agent(now()), range).await.unwrap();
    assert_eq!(again.profiles, first.profiles);
    assert_eq!(
        d.market.prints_served(),
        before,
        "a past range is kept whole"
    );

    let open = GetVolumeProfileInput {
        from: Some(from),
        ..vp(ProfileMode::Range)
    };
    let live = tool.call(&agent(now()), open.clone()).await.unwrap();
    assert_eq!(live.profiles[0].volume, truth(&d, from, now()).await);
    let reread = tool.call(&agent(now()), open.clone()).await.unwrap();
    assert_eq!(reread.profiles, live.profiles);
    for _ in 0..4 * 90 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
    }
    let later = tool.call(&agent(d.clock.now()), open).await.unwrap();
    assert_eq!(later.profiles[0].to, d.clock.now());
    assert_eq!(
        later.profiles[0].volume,
        truth(&d, from, d.clock.now()).await,
        "the open session carries on from where it was read"
    );
    assert!(later.profiles[0].volume > live.profiles[0].volume);
}

#[tokio::test]
async fn big_trades_are_the_large_aggressor_orders_of_the_tape() {
    let d = desk(73);
    for _ in 0..4 * 60 * 10 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
    }
    let now = || d.clock.now();
    let tool = GetBigTrades(Arc::clone(&d.hub));
    let from = Timestamp(now().0 - 30 * NANOS_PER_MINUTE);
    let input = |min: Option<i64>| GetBigTradesInput {
        instrument: "ES".into(),
        from: Some(from),
        to: Some(now()),
        tiers: None,
        min_size: min.map(Qty::from),
        max_size: None,
        join_orders: None,
        reach_limit: None,
        limit: Some(500),
        days_to_load: None,
    };
    let prints = d
        .market
        .get_trades(TradesRequest {
            instrument: id("ESZ6.CME"),
            from: Some(from),
            to: Some(now()),
            limit: Some(1_000_000),
        })
        .await
        .unwrap();
    let mut agg = OrderAggregator::new(Price::from_f64(0.25).unwrap(), Grouping::default());
    let mut orders: Vec<_> = prints.iter().filter_map(|t| agg.push(t)).collect();
    orders.extend(agg.finish());
    let min = 25;
    let expected: Vec<_> = orders.iter().filter(|o| o.size >= Qty::from(min)).collect();
    let by_size = tool.call(&agent(now()), input(Some(min))).await.unwrap();
    let out = &by_size;
    assert_eq!(out.orders, orders.len() as u64);
    assert_eq!(out.count as usize, expected.len());
    assert!(!out.trades.is_empty(), "the mock prints large orders");
    assert!(out.trades.iter().all(|t| t.size >= Qty::from(min)));
    assert!(out.trades.windows(2).all(|w| w[0].t <= w[1].t));
    assert_eq!(
        out.buy_volume,
        sum(expected
            .iter()
            .filter(|o| o.aggressor == Aggressor::Buy)
            .map(|o| o.size))
    );
    assert_eq!(out.rule.mode, BigTradeMode::Manual);
    assert_eq!(
        (
            out.rule.min_size,
            out.rule.max_size,
            out.rule.tiers.as_ref()
        ),
        (Some(Qty::from(min)), None, None)
    );
    let sweep = out.trades.iter().find(|t| t.levels > 1).expect("a sweep");
    match sweep.side {
        Aggressor::Buy => assert!(sweep.last_price > sweep.first_price),
        _ => assert!(sweep.last_price < sweep.first_price),
    }
    assert!(sweep.price >= sweep.first_price.min(sweep.last_price));
    assert_eq!(sweep.range_ticks, sweep.levels - 1);
    let us = out
        .rule
        .cuts
        .clone()
        .expect("the mock's sessions are enough to cut");
    assert!(us.low <= us.medium && us.medium <= us.high, "{us:?}");
    let tier_by_cuts = |size: Qty| {
        [
            (us.high, BigTradeTier::High),
            (us.medium, BigTradeTier::Medium),
            (us.low, BigTradeTier::Low),
        ]
        .into_iter()
        .find(|(cut, _)| size >= *cut)
        .map(|(_, tier)| tier)
    };
    assert!(
        out.trades.iter().all(|t| t.tier == tier_by_cuts(t.size)),
        "Manual events carry their Auto tier by the day's cuts"
    );
    let wire = serde_json::to_value(out).unwrap();
    assert!(wire.get("classes").is_none() && wire.get("bookSeconds").is_none());
    assert!(
        wire["trades"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t.get("class").is_none() && t.get("settled").is_none())
    );

    let out = tool.call(&agent(now()), input(None)).await.unwrap();
    assert_eq!(out.rule.mode, BigTradeMode::Auto);
    assert_eq!(
        out.rule.tiers,
        Some(vec![
            BigTradeTier::High,
            BigTradeTier::Medium,
            BigTradeTier::Low
        ])
    );
    assert_eq!(out.rule.floor, Qty::from(20));
    assert!(out.rule.cuts.is_some());
    assert!(
        out.rule.model_sessions >= 2 && out.rule.model_orders >= 1000,
        "{:?}",
        out.rule
    );
    let smallest = us.low.max(Qty::from(20));
    assert_eq!(out.rule.size_now, smallest);
    let share = f64::from(out.count) / out.orders as f64;
    let per_minute = f64::from(out.count) / 30.0;
    assert!(
        (0.2..=6.0).contains(&per_minute),
        "a few a minute, as the cuts' density targets aim for: {} of {}",
        out.count,
        out.orders
    );
    assert!(
        out.trades
            .iter()
            .all(|t| t.tier.is_some() && t.tier == tier_by_cuts(t.size) && t.size >= smallest)
    );
    let c = &out.tiers;
    assert_eq!(c.high + c.medium + c.low, out.count);
    let tiers = |tiers: Vec<BigTradeTier>| GetBigTradesInput {
        tiers: Some(tiers),
        ..input(None)
    };
    let high = tool
        .call(&agent(now()), tiers(vec![BigTradeTier::High]))
        .await
        .unwrap();
    assert_eq!(high.count, c.high);
    assert!(
        high.trades
            .iter()
            .all(|t| t.tier == Some(BigTradeTier::High))
    );
    assert_eq!(high.rule.size_now, us.high.max(Qty::from(20)));
    for bad in [
        GetBigTradesInput {
            tiers: Some(vec![BigTradeTier::Low]),
            ..input(Some(min))
        },
        tiers(vec![]),
        GetBigTradesInput {
            max_size: Some(Qty::from(min - 1)),
            ..input(Some(min))
        },
    ] {
        let e = tool.call(&agent(now()), bad).await.unwrap_err();
        assert_eq!(e.code, ToolErrorCode::InvalidInput, "{e:?}");
    }
    eprintln!(
        "mock ES, 30 min live: {} events, {} big ({:.2}%; tiers {:?}); US cuts {:?}",
        out.orders,
        out.count,
        100.0 * share,
        out.tiers,
        us
    );

    let few = tool
        .call(
            &agent(now()),
            GetBigTradesInput {
                limit: Some(3),
                ..input(Some(min))
            },
        )
        .await
        .unwrap();
    assert_eq!(few.trades.len(), 3);
    assert_eq!(few.count as usize, expected.len());
    assert_eq!(
        few.trades.last(),
        by_size.trades.last(),
        "the newest are kept"
    );
}

#[tokio::test]
async fn delta_follows_the_bars_and_restarts_each_session() {
    let d = desk(74);
    let tool = GetDelta(Arc::clone(&d.hub));
    let out = tool
        .call(
            &agent(now()),
            GetDeltaInput {
                instrument: "NQ".into(),
                tf: Timeframe::M5,
                from: None,
                to: None,
                limit: Some(12),
                reset: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(out.basis, Some(DeltaBasis::Bars));
    assert_eq!(out.missing, 0);
    assert_eq!(out.bars.len(), 12);
    assert_eq!(out.reset, DeltaReset::Session);
    let nq = id("NQZ6.CME");
    let spec = d.market.spec(&nq).await.unwrap().1;
    let session = spec
        .sessions
        .session(spec.sessions.trade_date(now()))
        .unwrap();
    let ones = minute_bars(
        &d.market,
        &nq,
        session.open,
        Timestamp(now().0 + NANOS_PER_MINUTE),
    )
    .await;
    let fives = aggregate(&ones, Timeframe::M5, spec.sessions);
    let mut cum = Qty::ZERO;
    let by_hand: Vec<(Timestamp, Qty, Qty)> = fives
        .iter()
        .map(|b| {
            let delta = b.bv.unwrap() - (b.v - b.bv.unwrap());
            cum = cum + delta;
            (b.t, delta, cum)
        })
        .collect();
    let tail = &by_hand[by_hand.len() - 12..];
    for (row, (t, delta, cum)) in out.bars.iter().zip(tail) {
        assert_eq!((row.0, row.4, row.5), (*t, *delta, *cum));
        assert_eq!(row.2 + row.3, row.1);
    }
    let run = tool
        .call(
            &agent(now()),
            GetDeltaInput {
                instrument: "NQ".into(),
                tf: Timeframe::M5,
                from: None,
                to: None,
                limit: Some(12),
                reset: Some(DeltaReset::None),
            },
        )
        .await
        .unwrap();
    assert_eq!(run.bars[0].5, run.bars[0].4);
    assert_eq!(run.bars[11].5, sum(run.bars.iter().map(|r| r.4)));
}

struct Limited {
    m: MockMarket,
    buy_volume: bool,
    trade_history: bool,
    trade_history_reads: std::sync::atomic::AtomicU64,
}

#[allow(non_snake_case)]
fn NoBuyVolume(m: MockMarket) -> Limited {
    Limited {
        m,
        buy_volume: false,
        trade_history: true,
        trade_history_reads: Default::default(),
    }
}

#[async_trait]
impl MarketDataProvider for Limited {
    fn id(&self) -> &str {
        if self.trade_history {
            "no-bv"
        } else {
            "no-history"
        }
    }
    fn display_name(&self) -> &str {
        "No buy volume"
    }
    fn keeps_trade_history(&self) -> bool {
        self.trade_history
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.m.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.m.health()
    }
    async fn search(
        &self,
        q: &str,
        a: Option<AssetClass>,
        n: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.m.search(q, a, n).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.m.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.m.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        let mut s = self.m.get_bars(req).await?;
        for b in &mut s.bars {
            if !self.buy_volume {
                b.bv = None;
            }
        }
        Ok(s)
    }
    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        if !self.trade_history {
            return Err(MarketError::Unsupported("no trade history".into()));
        }
        self.trade_history_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.m.get_trades(req).await
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.m.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.m.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.m.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.m.subscribe_bars(i, tf)
    }
}

#[tokio::test]
async fn delta_falls_back_to_prints_when_bars_lack_buy_volume() {
    let d = desk(75);
    let with_bv = GetDelta(Arc::clone(&d.hub));
    let without = GetDelta(hub_over(Arc::new(NoBuyVolume(d.market.clone()))));
    let input = GetDeltaInput {
        instrument: "TSLA".into(),
        tf: Timeframe::M15,
        from: None,
        to: Some(Timestamp(now().0 - 20 * NANOS_PER_MINUTE)),
        limit: Some(4),
        reset: None,
    };
    let a = with_bv.call(&agent(now()), input.clone()).await.unwrap();
    let b = without.call(&agent(now()), input).await.unwrap();
    assert_eq!(b.basis, Some(DeltaBasis::Prints));
    assert_eq!(b.provider, "no-bv");
    assert_eq!(a.bars, b.bars);
}

#[tokio::test]
async fn agents_get_every_order_flow_tool_with_bounded_answers() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::{Audience, ToolRegistry};

    let d = desk(77);
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let agent_tools: Vec<String> = r
        .descriptors(Audience::Agent, Some("market"), false)
        .into_iter()
        .map(|t| t.name)
        .collect();
    for name in [
        "market.get_trades",
        "market.get_depth",
        "market.get_footprint",
        "market.get_depth_history",
        "market.get_volume_profile",
        "market.get_big_trades",
        "market.get_delta",
    ] {
        assert!(agent_tools.iter().any(|t| t == name), "{name} for agents");
        let d = r.get(name).unwrap().descriptor().clone();
        assert_eq!(d.risk, tessera_protocol::tools::RiskTier::Read, "{name}");
        assert!(d.description.len() > 120, "{name} explains itself");
    }
    let trades = r.get("market.get_trades").unwrap();
    let input = serde_json::json!({"instrument": "NQ", "limit": 5000});
    let e = trades
        .call_json(&agent(now()), input.clone())
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::InvalidInput);
    assert!(e.message.contains("market.get_big_trades"), "{}", e.message);
    let user = ToolCtx::new(Origin::User, now());
    let ok = trades.call_json(&user, input).await.unwrap();
    assert_eq!(ok.value["trades"].as_array().unwrap().len(), 5000);
}

#[tokio::test]
async fn footprints_name_their_stacked_imbalances() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::ToolRegistry;

    let d = desk(78);
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let fp = r.get("market.get_footprint").unwrap();
    let out = fp
        .call_json(
            &agent(now()),
            serde_json::json!({"instrument": "NQ", "tf": "5m", "limit": 30, "imbalanceRatio": 2.5, "rowTicks": 1}),
        )
        .await
        .unwrap()
        .value;
    assert_eq!(out["imbalanceRatio"], 2.5);
    assert_eq!(out["imbalanceMinVolume"], 5.0);
    assert_eq!(out["imbalanceMinDifference"], 0.0);
    assert_eq!(out["imbalanceIncludeZero"], false);
    let stacks = out["stackedImbalances"].as_array().unwrap();
    assert!(!stacks.is_empty(), "thirty mock bars have a stack");
    let f = |v: &serde_json::Value| v.as_f64().unwrap();
    for s in stacks {
        let bar = out["bars"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["t"] == s["t"])
            .unwrap();
        let cells = bar["cells"].as_array().unwrap();
        let at = |price: f64| {
            cells
                .iter()
                .find(|c| (f(&c[0]) - price).abs() < 1e-9)
                .map_or((0.0, 0.0), |c| (f(&c[1]), f(&c[2])))
        };
        let (low, high) = (f(&s["low"]), f(&s["high"]));
        let lowest = cells.iter().map(|c| f(&c[0])).fold(f64::INFINITY, f64::min);
        let highest = cells
            .iter()
            .map(|c| f(&c[0]))
            .fold(f64::NEG_INFINITY, f64::max);
        let rows = ((high - low) / 0.25).round() as u64 + 1;
        assert_eq!(s["rows"].as_u64(), Some(rows));
        assert!(rows >= 3);
        let mut p = low;
        while p <= high + 1e-9 {
            let (bid, ask) = at(p);
            if s["side"] == "buy" {
                let below = at(p - 0.25).0;
                assert!(
                    p - 0.25 >= lowest - 1e-9,
                    "{p}: the bar's low compares with nothing"
                );
                assert!(
                    ask >= 5.0 && below > 0.0 && ask >= 2.5 * below,
                    "{p}: {ask} vs {below}"
                );
            } else {
                let above = at(p + 0.25).1;
                assert!(
                    p + 0.25 <= highest + 1e-9,
                    "{p}: the bar's high compares with nothing"
                );
                assert!(
                    bid >= 5.0 && above > 0.0 && bid >= 2.5 * above,
                    "{p}: {bid} vs {above}"
                );
            }
            p += 0.25;
        }
    }
}

#[tokio::test]
async fn long_footprints_hold_every_print_of_each_bar() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::ToolRegistry;

    let d = desk(79);
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let fp = r.get("market.get_footprint").unwrap();
    let user = ToolCtx::new(Origin::User, now());
    for (symbol, tf, limit) in [
        ("AAPL", Timeframe::H1, 10),
        ("AAPL", Timeframe::D1, 2),
        ("NQZ6.CME", Timeframe::D1, 2),
    ] {
        let out = fp
            .call_json(
                &user,
                serde_json::json!({"instrument": symbol, "tf": tf, "limit": limit}),
            )
            .await
            .unwrap()
            .value;
        assert_eq!(out["truncated"], false);
        let bars = out["bars"].as_array().unwrap();
        assert_eq!(bars.len(), limit, "{tf}: every bar has prints");
        let candles = d
            .market
            .get_bars(BarsRequest::latest(id(symbol), tf, limit))
            .await
            .unwrap()
            .bars;
        for (b, c) in bars.iter().zip(&candles) {
            assert_eq!(b["t"].as_i64(), Some(c.t.0), "{tf}");
            let volume: Qty = serde_json::from_value(b["volume"].clone()).unwrap();
            let delta: Qty = serde_json::from_value(b["delta"].clone()).unwrap();
            let bv = c.bv.unwrap();
            assert_eq!(volume, c.v, "{symbol} {tf} {}", c.t);
            assert_eq!(delta, bv + bv - c.v, "{tf} {}", c.t);
        }
    }
    let e = fp
        .call_json(
            &agent(now()),
            serde_json::json!({"instrument": "NQ", "tf": "1h", "limit": 50, "rowTicks": 1}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::InvalidInput);
    assert!(e.message.contains("rowTicks"), "{}", e.message);
    let out = fp
        .call_json(
            &agent(now()),
            serde_json::json!({"instrument": "NQ", "tf": "1h", "limit": 20}),
        )
        .await
        .unwrap()
        .value;
    let widest = out["bars"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["cells"].as_array().unwrap().len())
        .max()
        .unwrap();
    assert!((10..=41).contains(&widest), "{widest} rows");
    let e = fp
        .call_json(
            &agent(now()),
            serde_json::json!({"instrument": "NDX", "tf": "5m"}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::Unsupported);
}

#[tokio::test]
async fn a_daily_footprint_on_one_tick_rows_coarsens_its_rows_to_fit_instead_of_refusing() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::module::{AGENT_MAX_FOOTPRINT_CELLS, USER_MAX_FOOTPRINT_CELLS};
    use tessera_tools::ToolRegistry;

    let clock = Arc::new(ManualClock::new(now()));
    let market = MockMarket::new(MockConfig::new(clock));
    let router = MarketRouter::new();
    router.add(Arc::new(market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let fp = r.get("market.get_footprint").unwrap();
    let ask = serde_json::json!({"instrument": "NQ", "tf": "1D", "rowTicks": 1, "limit": 200});

    let candles = market
        .get_bars(BarsRequest::latest(id("NQZ6.CME"), Timeframe::D1, 200))
        .await
        .unwrap()
        .bars;
    let tick = Decimal::new(25, 2);
    let one_tick_rows: u64 = candles
        .iter()
        .map(|c| ((c.h.0 - c.l.0) / tick).round().try_into().unwrap_or(0u64) + 1)
        .sum();
    assert!(
        one_tick_rows > USER_MAX_FOOTPRINT_CELLS,
        "200 daily bars of NQ at one tick hold {one_tick_rows} rows, past the app's budget"
    );

    let out = fp
        .call_json(&ToolCtx::new(Origin::User, now()), ask)
        .await
        .unwrap()
        .value;
    let row: Decimal = serde_json::from_value(out["row"].clone()).unwrap();
    assert!(row > tick, "rows coarsened past one tick: {row}");
    assert_eq!(
        (row / tick).fract(),
        Decimal::ZERO,
        "a row is a whole number of ticks"
    );
    let bars = out["bars"].as_array().unwrap();
    assert!(!bars.is_empty(), "the daily footprint draws");
    let cells: usize = bars
        .iter()
        .map(|b| b["cells"].as_array().unwrap().len())
        .sum();
    assert!(cells as u64 <= USER_MAX_FOOTPRINT_CELLS, "{cells} cells");
    for b in bars {
        let c = candles
            .iter()
            .find(|c| Some(c.t.0) == b["t"].as_i64())
            .unwrap();
        let volume: Qty = serde_json::from_value(b["volume"].clone()).unwrap();
        assert_eq!(volume, c.v, "coarser rows keep every print of {}", c.t);
    }

    let agent_ask = serde_json::json!({"instrument": "NQ", "tf": "1D", "rowTicks": 1, "limit": 50});
    let e = fp.call_json(&agent(now()), agent_ask).await.unwrap_err();
    assert_eq!(
        e.code,
        ToolErrorCode::InvalidInput,
        "an agent's answer still names its limit"
    );
    assert!(
        e.message.contains(&AGENT_MAX_FOOTPRINT_CELLS.to_string()),
        "{}",
        e.message
    );
}

#[tokio::test(start_paused = true)]
async fn footprints_without_trade_history_never_return_a_partial_bar() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::ToolRegistry;

    let d = desk(80);
    let router = MarketRouter::new();
    router
        .add(Arc::new(Limited {
            m: d.market.clone(),
            buy_volume: true,
            trade_history: false,
            trade_history_reads: Default::default(),
        }))
        .unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    module.hub().set_linger(Duration::ZERO);
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let fp = r.get("market.get_footprint").unwrap();
    let input = serde_json::json!({"instrument": "NQZ6.CME", "tf": "1m", "limit": 3});
    let out = fp
        .call_json(&agent(now()), input.clone())
        .await
        .unwrap()
        .value;
    assert_eq!(out["truncated"], false, "{out}");
    assert!(out["bars"].as_array().unwrap().is_empty(), "{out}");
    assert!(
        !out["gaps"].as_array().unwrap().is_empty(),
        "nothing is known yet: {out}"
    );
    let feed = module
        .hub()
        .acquire(PumpKey::Trades(id("NQZ6.CME")))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    for _ in 0..4 * 100 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let out = fp
        .call_json(&agent(d.clock.now()), input)
        .await
        .unwrap()
        .value;
    assert_eq!(out["truncated"], false, "{out}");
    let t1443 = Timestamp::parse("2026-10-02T14:43:00-04:00").unwrap();
    let gap_end = out["gaps"].as_array().unwrap().last().unwrap()["to"]
        .as_i64()
        .unwrap();
    assert!(
        (t1443.0 - 60 * NANOS_PER_SEC + 1..=t1443.0).contains(&gap_end),
        "the gap before the recording ends inside 14:42: {out}"
    );
    let bars = out["bars"].as_array().unwrap();
    assert_eq!(
        bars.iter()
            .map(|b| b["t"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [t1443.0, t1443.0 + 60 * NANOS_PER_SEC],
        "14:42 is left out, not sent partial"
    );
    let bar = minute_bars(
        &d.market,
        &id("NQZ6.CME"),
        t1443,
        t1443.add_nanos(NANOS_PER_MINUTE),
    )
    .await[0];
    let volume: Qty = serde_json::from_value(bars[0]["volume"].clone()).unwrap();
    assert_eq!(volume, bar.v);
    drop(feed);
}

#[tokio::test(start_paused = true)]
async fn answers_from_part_of_the_prints_name_the_gaps_before_them() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::ToolRegistry;

    let d = desk(81);
    let router = MarketRouter::new();
    router
        .add(Arc::new(Limited {
            m: d.market.clone(),
            buy_volume: true,
            trade_history: false,
            trade_history_reads: Default::default(),
        }))
        .unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    module.hub().set_linger(Duration::ZERO);
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let call = async |name: &str, at: Timestamp, input: serde_json::Value| {
        r.get(name)
            .unwrap()
            .call_json(&agent(at), input)
            .await
            .unwrap()
            .value
    };
    let ts = |v: &serde_json::Value| v.as_i64().map(Timestamp);
    let gap_end = |v: &serde_json::Value| {
        let gaps = v["gaps"].as_array().unwrap_or_else(|| panic!("gaps: {v}"));
        gaps.last().and_then(|g| ts(&g["to"]))
    };

    let profile = call(
        "market.get_volume_profile",
        now(),
        serde_json::json!({"instrument": "NQZ6.CME"}),
    )
    .await;
    let p = &profile["profiles"][0];
    assert_eq!(gap_end(p), ts(&p["to"]), "{p}");
    assert_eq!(p["prints"], 0);
    let hour_ago = Timestamp(now().0 - 60 * NANOS_PER_MINUTE);
    let big = call(
        "market.get_big_trades",
        now(),
        serde_json::json!({"instrument": "NQZ6.CME", "minSize": 1}),
    )
    .await;
    assert_eq!(gap_end(&big), Some(now()));
    let span = serde_json::json!({"instrument": "NQZ6.CME", "from": hour_ago.0, "to": now().0});
    let tape = call("market.get_trades", now(), span.clone()).await;
    assert_eq!(gap_end(&tape), Some(now()));
    assert_eq!(tape["truncated"], false);

    let yesterday = serde_json::json!({
        "instrument": "NQZ6.CME",
        "to": Timestamp::parse("2026-10-01T17:30:00-04:00").unwrap().0,
    });
    for _ in 0..2 {
        let out = call("market.get_volume_profile", now(), yesterday.clone()).await;
        let p = &out["profiles"][0];
        assert_eq!(p["tradeDate"], "2026-10-01");
        assert_eq!(gap_end(p), ts(&p["to"]), "{p}");
    }

    let feed = module
        .hub()
        .acquire(PumpKey::Trades(id("NQZ6.CME")))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    for _ in 0..4 * 90 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let at = d.clock.now();
    let out = call(
        "market.get_volume_profile",
        at,
        serde_json::json!({"instrument": "NQZ6.CME"}),
    )
    .await;
    let p = &out["profiles"][0];
    let whole = gap_end(p).expect("part of the session");
    assert!(
        whole >= now() && whole < Timestamp(now().0 + NANOS_PER_SEC),
        "{whole}"
    );
    assert!(p["prints"].as_u64().unwrap() > 0);
    let big = call(
        "market.get_big_trades",
        at,
        serde_json::json!({"instrument": "NQZ6.CME", "minSize": 1}),
    )
    .await;
    assert_eq!(gap_end(&big), Some(whole));
    let inside = call(
        "market.get_trades",
        at,
        serde_json::json!({"instrument": "NQZ6.CME", "from": now().0 + 10 * NANOS_PER_SEC, "to": at.0}),
    )
    .await;
    assert_eq!(inside["gaps"], serde_json::json!([]), "{inside}");
    assert!(!inside["trades"].as_array().unwrap().is_empty());
    drop(feed);

    let mocked = MarketModule::new(
        {
            let router = MarketRouter::new();
            router.add(Arc::new(d.market.clone())).unwrap();
            router
        },
        Arc::new(EventBus::new()),
    );
    let mut r = ToolRegistry::new();
    mocked.register_tools(&mut r).unwrap();
    let mut cut = span.clone();
    cut["limit"] = 10.into();
    let out = r
        .get("market.get_trades")
        .unwrap()
        .call_json(&agent(now()), cut)
        .await
        .unwrap()
        .value;
    assert_eq!(out["gaps"], serde_json::json!([]));
    assert_eq!(out["truncated"], true);
    assert_eq!(out["trades"].as_array().unwrap().len(), 10);
}

#[tokio::test(start_paused = true)]
async fn a_fresh_recording_knows_its_footprints_from_its_start_and_streams_every_print() {
    use std::collections::BTreeMap;
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::io::FootprintUpdate;
    use tessera_tools::ToolRegistry;

    let d = desk(83);
    let router = MarketRouter::new();
    router
        .add(Arc::new(Limited {
            m: d.market.clone(),
            buy_volume: true,
            trade_history: false,
            trade_history_reads: Default::default(),
        }))
        .unwrap();
    let bus = Arc::new(EventBus::new());
    bus.register(names::MARKET_FOOTPRINT, TopicSizing::MARKET)
        .unwrap();
    let (mut rx, _) = bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let module = MarketModule::new(router, Arc::clone(&bus));
    module.hub().set_linger(Duration::ZERO);
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let nq = id("NQZ6.CME");
    let footprints = async |at: Timestamp| {
        r.get("market.get_footprint")
            .unwrap()
            .call_json(
                &ToolCtx::new(Origin::User, at),
                serde_json::json!({"instrument": "NQZ6.CME", "tf": "5m", "rowTicks": 1, "limit": 200}),
            )
            .await
            .unwrap()
            .value
    };
    let ts = |v: &serde_json::Value| v.as_i64().map(Timestamp);
    let at = |s: &str| Timestamp::parse(s).unwrap();

    let chart = module
        .hub()
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M5))
        .unwrap();
    let stream = module
        .hub()
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M5, 1))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let out = footprints(now()).await;
    let gaps = out["gaps"].as_array().unwrap();
    assert!(
        gaps.last().and_then(|g| ts(&g["to"])) >= Some(now()),
        "{out}"
    );
    assert_eq!(out["bars"], serde_json::json!([]));

    for _ in 0..4 * 180 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let updates: Vec<FootprintUpdate> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|e| serde_json::from_str(e.data.get()).unwrap())
        .collect();
    let out = footprints(d.clock.now()).await;
    let since = out["gaps"]
        .as_array()
        .and_then(|g| g.last())
        .and_then(|g| ts(&g["to"]))
        .expect("known from the first print recorded");
    assert!(
        since >= now() && since < Timestamp(now().0 + NANOS_PER_SEC),
        "{since}"
    );
    let bars = out["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 1, "{out}");
    assert_eq!(ts(&bars[0]["t"]), Some(at("2026-10-02T14:45:00-04:00")));
    assert_eq!(out["lastBarOpen"], true);
    let first = updates
        .iter()
        .find(|u| u.closed && u.bar.t == at("2026-10-02T14:40:00-04:00"))
        .expect("14:40 closed on the stream");
    assert!(first.bar.volume > Qty::ZERO);
    let mut merged: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for u in updates
        .iter()
        .filter(|u| u.bar.t == at("2026-10-02T14:45:00-04:00"))
    {
        for c in &u.bar.cells {
            let e = merged.entry(format!("{:.2}", c.0)).or_default();
            *e = (e.0.max(c.1), e.1.max(c.2));
        }
    }
    let read: BTreeMap<String, (f64, f64)> = bars[0]["cells"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let f = |k: usize| c[k].as_f64().unwrap();
            (format!("{:.2}", f(0)), (f(1), f(2)))
        })
        .collect();
    assert!(!read.is_empty());
    assert_eq!(merged, read);
    drop((stream, chart));
}

#[tokio::test]
async fn closed_footprint_bars_are_built_once() {
    use std::sync::atomic::Ordering;
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_tools::ToolRegistry;

    let d = desk(82);
    let feed = Arc::new(Limited {
        m: d.market.clone(),
        buy_volume: true,
        trade_history: true,
        trade_history_reads: Default::default(),
    });
    let tools = |p: Arc<dyn MarketDataProvider>| {
        let router = MarketRouter::new();
        router.add(p).unwrap();
        let module = MarketModule::new(router, Arc::new(EventBus::new()));
        module.hub().set_linger(Duration::ZERO);
        let mut r = ToolRegistry::new();
        module.register_tools(&mut r).unwrap();
        (module, r)
    };
    let (module, r) = tools(feed.clone());
    let fp_at = async |r: &ToolRegistry, at: Timestamp, input: serde_json::Value| {
        let user = ToolCtx::new(tessera_core::origin::Origin::User, at);
        r.get("market.get_footprint")
            .unwrap()
            .call_json(&user, input)
            .await
            .unwrap()
            .value
    };
    let fp = async |r: &ToolRegistry, input: serde_json::Value| fp_at(r, now(), input).await;
    let ask = |row: u32| {
        serde_json::json!({
            "instrument": "AAPL", "tf": "1h", "limit": 5, "rowTicks": row,
            "to": Timestamp::parse("2026-10-01T15:00:00-04:00").unwrap().0,
        })
    };
    let reads = || feed.trade_history_reads.load(Ordering::Relaxed);
    let first = fp(&r, ask(1)).await;
    let read = reads();
    assert!(read > 0);
    assert_eq!(module.hub().closed_bars().len(), 5);
    assert_eq!(fp(&r, ask(1)).await, first, "a reload reads nothing");
    let four = fp(&r, ask(4)).await;
    assert_eq!(reads(), read, "coarser rows are regrouped, not read");
    let (_, fresh) = tools(Arc::new(d.market.clone()));
    let mut built = fp(&fresh, ask(4)).await;
    built["provider"] = four["provider"].clone();
    assert_eq!(four, built, "the same as built afresh");
    for (a, b) in first["bars"]
        .as_array()
        .unwrap()
        .iter()
        .zip(four["bars"].as_array().unwrap())
    {
        assert_eq!(a["volume"], b["volume"]);
        assert!(b["cells"].as_array().unwrap().len() < a["cells"].as_array().unwrap().len());
    }

    let minutes = serde_json::json!({
        "instrument": "AAPL", "tf": "1m", "limit": 3,
        "to": Timestamp::parse("2026-10-02T14:41:00-04:00").unwrap().0,
    });
    let at = Timestamp::parse("2026-10-02T14:41:55-04:00").unwrap();
    fp_at(&r, at, minutes.clone()).await;
    let (kept, read) = (module.hub().closed_bars().len(), reads());
    assert_eq!(kept, 5 + 2, "14:41 is not kept");
    let again = fp_at(&r, at, minutes).await;
    assert!(reads() > read);
    assert_eq!(module.hub().closed_bars().len(), kept);
    assert_eq!(again["bars"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn time_and_sales_aggregates_filters_and_finds_its_big_trade_threshold() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::io::TradesOutput;
    use tessera_tools::ToolRegistry;

    let d = desk(79);
    for _ in 0..4 * 60 * 5 {
        d.clock.advance(NANOS_PER_SEC / 4);
        d.market.advance(d.clock.now());
    }
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::new(EventBus::new()));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let trades = r.get("market.get_trades").unwrap();
    let user = ToolCtx::new(Origin::User, d.clock.now());
    let call = async |input: serde_json::Value| -> TradesOutput {
        serde_json::from_value(trades.call_json(&user, input).await.unwrap().value).unwrap()
    };
    let from = Timestamp(d.clock.now().0 - 5 * NANOS_PER_MINUTE);
    let raw = call(serde_json::json!({"instrument": "ES", "from": from, "limit": 10000})).await;
    assert!(!raw.aggregated && raw.prints.is_empty() && raw.threshold.is_none());
    assert!(!raw.truncated);
    let joined = call(serde_json::json!({
        "instrument": "ES", "from": from, "limit": 10000, "aggregate": true
    }))
    .await;
    assert!(joined.aggregated);
    assert_eq!(joined.prints.len(), joined.trades.len());
    assert_eq!(joined.columns.last().map(String::as_str), Some("prints"));
    assert_eq!(
        joined.prints.iter().map(|p| *p as usize).sum::<usize>(),
        raw.trades.len()
    );
    let size =
        |rows: &[tessera_protocol::compact::CompactTrade]| rows.iter().map(|t| t.2).sum::<f64>();
    assert!((size(&joined.trades) - size(&raw.trades)).abs() < 1e-6);
    assert!(joined.trades.len() < raw.trades.len(), "sweeps join");
    let prints: Vec<Trade> = raw
        .trades
        .iter()
        .map(|c| Trade {
            instrument: id("ESZ6.CME"),
            ts: Timestamp(c.0),
            price: Price::from_f64(c.1).unwrap(),
            size: Qty::from_f64(c.2).unwrap(),
            aggressor: c.aggressor(),
            aggressor_source: tessera_core::market::AggressorSource::Exchange,
            order_key: c.4,
            source: None,
        })
        .collect();
    let mut agg = OrderAggregator::new(Price::from_f64(0.25).unwrap(), Grouping::default());
    let mut orders: Vec<_> = prints.iter().filter_map(|t| agg.push(t)).collect();
    orders.extend(agg.finish());
    assert_eq!(orders.len(), joined.trades.len());
    assert_eq!(joined.last.len(), joined.trades.len());
    for (o, at) in orders.iter().zip(&joined.last) {
        assert_eq!(*at, o.last.to_f64());
        assert!((at * 4.0).fract().abs() < 1e-9, "{at} is on ES's 0.25 tick");
    }
    assert!(raw.last.is_empty());

    let newest = call(serde_json::json!({
        "instrument": "ES", "limit": 50, "aggregate": true
    }))
    .await;
    assert_eq!(newest.trades.len(), 50);
    assert_eq!(newest.trades[..], joined.trades[joined.trades.len() - 50..]);

    let big = call(serde_json::json!({
        "instrument": "ES", "from": from, "limit": 10000, "aggregate": true, "minSize": 20
    }))
    .await;
    assert!(!big.trades.is_empty());
    assert!(big.trades.iter().all(|t| t.2 >= 20.0));
    assert_eq!(
        big.trades.len(),
        joined.trades.iter().filter(|t| t.2 >= 20.0).count()
    );

    let auto = call(serde_json::json!({
        "instrument": "ES", "from": from, "limit": 10000, "aggregate": true, "minSize": "auto"
    }))
    .await;
    let t = auto.threshold.clone().expect("the threshold applied");
    assert_eq!(t.floor, Qty::from(20));
    assert!(t.size >= t.floor);
    assert!(t.sessions >= 2, "{t:?}");
    assert!(t.orders >= 1000, "{t:?}");
    let rule = r
        .get("market.get_big_trades")
        .unwrap()
        .call_json(&user, serde_json::json!({"instrument": "ES"}))
        .await
        .unwrap()
        .value["rule"]
        .clone();
    assert_eq!(
        serde_json::to_value(t.size).unwrap(),
        rule["sizeNow"],
        "the size big trades show now"
    );
    assert!(auto.trades.iter().all(|r| r.2 >= t.size.to_f64()));
    let again = call(serde_json::json!({"instrument": "ES", "limit": 1, "minSize": "auto"})).await;
    assert_eq!(again.threshold, Some(t));
}

struct Replaying {
    m: MockMarket,
    open: tokio::sync::watch::Sender<bool>,
    asked: parking_lot::Mutex<Vec<(Timestamp, Timestamp)>>,
}

impl Replaying {
    fn new(m: MockMarket) -> Self {
        Self {
            m,
            open: tokio::sync::watch::channel(false).0,
            asked: parking_lot::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl MarketDataProvider for Replaying {
    fn id(&self) -> &str {
        "replaying"
    }
    fn display_name(&self) -> &str {
        "Replaying"
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.m.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.m.health()
    }
    async fn search(
        &self,
        q: &str,
        a: Option<AssetClass>,
        n: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.m.search(q, a, n).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.m.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.m.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.m.get_bars(req).await
    }
    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let mut open = self.open.subscribe();
        let _ = open.wait_for(|o| *o).await;
        self.asked.lock().push((req.from.unwrap(), req.to.unwrap()));
        let mut prints = self.m.get_trades(req).await?;
        for t in &mut prints {
            t.aggressor_source = tessera_core::market::AggressorSource::ReplayMapped;
            t.order_key = None;
        }
        Ok(prints)
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.m.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.m.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.m.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.m.subscribe_bars(i, tf)
    }
}

fn cells(bars: &serde_json::Value) -> Vec<(i64, serde_json::Value)> {
    bars.as_array()
        .unwrap()
        .iter()
        .map(|b| (b["t"].as_i64().unwrap(), b["cells"].clone()))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_chart_opened_mid_session_reads_the_whole_session_from_the_connections_tick_replay() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::io::FootprintUpdate;
    use tessera_tools::ToolRegistry;

    let d = desk(84);
    let replaying = Arc::new(Replaying::new(d.market.clone()));
    let router = MarketRouter::new();
    router.add(replaying.clone()).unwrap();
    let bus = Arc::new(EventBus::new());
    bus.register(names::MARKET_FOOTPRINT, TopicSizing::MARKET)
        .unwrap();
    let (mut rx, _) = bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let module = MarketModule::new(router, Arc::clone(&bus));
    module.hub().set_linger(Duration::ZERO);
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let full = MarketModule::new(
        {
            let router = MarketRouter::new();
            router.add(Arc::new(d.market.clone())).unwrap();
            router
        },
        Arc::new(EventBus::new()),
    );
    let mut whole_tools = ToolRegistry::new();
    full.register_tools(&mut whole_tools).unwrap();
    let call = async |r: &ToolRegistry, name: &str, at: Timestamp, input: serde_json::Value| {
        r.get(name)
            .unwrap()
            .call_json(&ToolCtx::new(Origin::User, at), input)
            .await
            .unwrap()
            .value
    };
    let ts = |v: &serde_json::Value| v.as_i64().map(Timestamp);
    let at = |s: &str| Timestamp::parse(s).unwrap();
    let tick = async |n: usize| {
        for _ in 0..n {
            d.clock.advance(NANOS_PER_SEC / 4);
            d.market.advance(d.clock.now());
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let nq = id("NQZ6.CME");
    let session_open = at("2026-10-01T18:00:00-04:00");
    let footprints =
        serde_json::json!({"instrument": "NQZ6.CME", "tf": "1m", "rowTicks": 1, "limit": 200});

    let chart = module
        .hub()
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M1))
        .unwrap();
    let stream = module
        .hub()
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M1, 1))
        .unwrap();
    tick(4 * 10).await;
    let reading = call(
        &r,
        "market.get_footprint",
        d.clock.now(),
        footprints.clone(),
    )
    .await;
    assert_eq!(reading["filling"], true, "{reading}");
    let recorded_from = reading["gaps"]
        .as_array()
        .and_then(|g| g.last())
        .and_then(|g| ts(&g["to"]))
        .expect("known from the recording");
    assert!(
        recorded_from >= now() && recorded_from < Timestamp(now().0 + NANOS_PER_SEC),
        "{recorded_from}"
    );

    replaying.open.send_replace(true);
    settle(
        "the session read",
        || (module.hub().pulling(&nq), replaying.asked.lock().len()),
        |(pulling, _)| !pulling,
    )
    .await;
    tick(4 * 50).await;
    let t = d.clock.now();
    let whole = call(&r, "market.get_footprint", t, footprints.clone()).await;
    assert_eq!(whole["filling"], false);
    assert_eq!(whole["gaps"], serde_json::json!([]));
    let truth = call(&whole_tools, "market.get_footprint", t, footprints.clone()).await;
    assert_eq!(cells(&whole["bars"]), cells(&truth["bars"]));
    assert!(ts(&whole["bars"][0]["t"]).unwrap() < now());

    let profile = serde_json::json!({"instrument": "NQZ6.CME"});
    let vp = call(&r, "market.get_volume_profile", t, profile.clone()).await;
    let vp_truth = call(&whole_tools, "market.get_volume_profile", t, profile).await;
    assert_eq!(vp["filling"], false);
    assert_eq!(vp["profiles"][0]["gaps"], serde_json::json!([]));
    assert_eq!(
        vp["profiles"][0]["volume"],
        vp_truth["profiles"][0]["volume"]
    );
    assert_eq!(vp["profiles"][0]["poc"], vp_truth["profiles"][0]["poc"]);

    let session = serde_json::json!({"instrument": "NQZ6.CME", "minSize": 1, "from": session_open.0, "to": t.0});
    let big = call(&r, "market.get_big_trades", t, session).await;
    assert_eq!(big["gaps"], serde_json::json!([]), "{}", big["count"]);
    assert_eq!(big["filling"], false);

    let asked = replaying.asked.lock().clone();
    assert_eq!(asked.iter().map(|a| a.0).min(), Some(session_open));
    assert_eq!(asked.iter().map(|a| a.1).max(), Some(recorded_from));

    let joined = at("2026-10-02T14:42:00-04:00");
    let closed = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|e| serde_json::from_str::<FootprintUpdate>(e.data.get()).unwrap())
        .filter(|u| u.closed && u.bar.t == joined)
        .last()
        .expect("the bar the recording began in closed on the stream");
    let minute = minute_bars(&d.market, &nq, joined, joined.add_nanos(NANOS_PER_MINUTE)).await;
    assert_eq!(
        closed.bar.volume, minute[0].v,
        "the stream's bar holds its prints from before the recording"
    );
    drop((stream, chart));
}

#[tokio::test(start_paused = true)]
async fn a_session_asked_while_the_connection_logs_in_is_replayed_once_it_is_in() {
    let d = desk(84);
    let replaying = Arc::new(Replaying::new(d.market.clone()));
    d.market.set_logging_in(true);
    replaying.open.send_replace(true);
    let hub = hub_over(replaying.clone());
    let tick = async |n: usize| {
        for _ in 0..n {
            d.clock.advance(NANOS_PER_SEC / 4);
            d.market.advance(d.clock.now());
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let nq = id("NQZ6.CME");
    let session_open = Timestamp::parse("2026-10-01T18:00:00-04:00").unwrap();

    let (mut footprints, _) = hub.bus().subscribe(names::MARKET_FOOTPRINT).unwrap();
    let chart = hub
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M1))
        .unwrap();
    let stream = hub
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M1, 1))
        .unwrap();
    tick(4 * 15).await;
    assert!(
        replaying.asked.lock().is_empty(),
        "nothing is replayed while the connection logs in"
    );
    assert!(hub.pulling(&nq), "the session is still to be read");

    d.market.set_logging_in(false);
    settle(
        "the session read",
        || (hub.pulling(&nq), replaying.asked.lock().len()),
        |(pulling, _)| !pulling,
    )
    .await;
    assert_eq!(
        replaying.asked.lock().iter().map(|a| a.0).min(),
        Some(session_open),
        "the session is replayed from its open once the connection is in"
    );
    tick(4 * 70).await;
    let built = std::iter::from_fn(|| footprints.try_recv().ok())
        .map(|e| serde_json::from_str::<tessera_market::io::FootprintUpdate>(e.data.get()).unwrap())
        .filter(|u| u.closed)
        .count();
    assert!(
        built > 0,
        "the footprint the CVD reads is built once the connection is in"
    );
    let known = hub
        .history(&nq, Some(session_open), None, None)
        .await
        .unwrap();
    assert_eq!(
        known.gaps.spans(),
        &[],
        "the prints are known from the session's open"
    );
    drop((stream, chart));
}
