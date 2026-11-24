use std::sync::Arc;

use tessera_concepts::volume_profile::{VolumeProfileLevels, value_levels};
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::ids::SessionId;
use tessera_core::origin::Origin;
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Price, Timestamp};
use tessera_host::EventBus;
use tessera_market::hub::MarketHub;
use tessera_market::io::{GetVolumeProfileInput, ProfileMode, VolumeProfileOutput};
use tessera_market::orderflow::profile::ProfileBuilder;
use tessera_market::orderflow::tools::GetVolumeProfile;
use tessera_market::{MarketRouter, MockConfig, MockMarket};
use tessera_tools::{Tool, ToolCtx};

fn now() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

fn mock(
    clock: &Arc<ManualClock>,
    seed: u64,
    intraday_sessions: usize,
    daily_sessions: usize,
) -> (MockMarket, Arc<MarketHub>) {
    let mut cfg = MockConfig::new(clock.clone());
    cfg.seed = seed;
    cfg.intraday_sessions = intraday_sessions;
    cfg.daily_sessions = daily_sessions;
    let market = MockMarket::new(cfg);
    let router = MarketRouter::new();
    router.add(Arc::new(market.clone())).unwrap();
    (market, MarketHub::new(router, Arc::new(EventBus::new())))
}

async fn profile(
    hub: &Arc<MarketHub>,
    at: Timestamp,
    mode: ProfileMode,
    sessions: u32,
) -> VolumeProfileOutput {
    GetVolumeProfile::new(Arc::clone(hub))
        .call(
            &ToolCtx::new(
                Origin::Agent {
                    session_id: SessionId::new("S1"),
                    provider: "test".into(),
                },
                at,
            ),
            GetVolumeProfileInput {
                instrument: "ES".into(),
                mode: Some(mode),
                period: None,
                count: None,
                sessions: Some(sessions),
                from: None,
                to: Some(at),
                session: None,
                tpo_minutes: None,
                row_ticks: Some(1),
                max_rows: Some(500),
                value_area_percent: Some(70.0),
                days_to_load: None,
            },
        )
        .await
        .unwrap()
}

fn running_tasks() -> usize {
    tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks()
}

fn price(levels: &[tessera_core::levels::Level], field: &str) -> Price {
    levels
        .iter()
        .find(|l| l.source.field == field)
        .unwrap_or_else(|| panic!("{field}"))
        .price
        .unwrap()
}

#[tokio::test]
async fn profile_levels_match_the_measured_profiles() {
    let clock = Arc::new(ManualClock::new(now()));
    let (market, hub) = mock(&clock, 91, 7, 20);
    let (oracle_market, oracle) = mock(&clock, 91, 7, 20);
    let levels = VolumeProfileLevels::new(Arc::clone(&hub), clock.clone());
    let es = InstrumentId::new("ESZ6.CME").unwrap();

    let idle = running_tasks();
    let (as_of, got) = levels.levels(&es).await.unwrap();
    assert_eq!(
        running_tasks(),
        idle,
        "reading the levels leaves no background work on its market"
    );
    let first_read = market.prints_served();
    assert_eq!(got.len(), 9, "{got:#?}");
    assert!(
        got.iter()
            .all(|l| l.group == "vp" && l.source.vendor == "Tessera")
    );
    assert_eq!(as_of, Timestamp(now().0 - 2 * NANOS_PER_SEC));

    let today = profile(&oracle, as_of, ProfileMode::Session, 2).await;
    let (prior, current) = (&today.profiles[0], &today.profiles[1]);
    assert_eq!(price(&got, "poc"), current.poc.unwrap());
    assert_eq!(price(&got, "vah"), current.vah.unwrap());
    assert_eq!(price(&got, "val"), current.val.unwrap());
    assert_eq!(price(&got, "ppoc"), prior.poc.unwrap());
    assert_eq!(price(&got, "pvah"), prior.vah.unwrap());
    assert_eq!(price(&got, "pval"), prior.val.unwrap());
    let composite = profile(&oracle, as_of, ProfileMode::Composite, 5).await;
    let mut all = ProfileBuilder::new(Price::from_f64(0.25).unwrap());
    oracle
        .each_print(&es, composite.profiles[0].from, as_of, |t| {
            all.push_trade(t)
        })
        .await
        .unwrap();
    let c = value_levels(&all).unwrap();
    assert_eq!(price(&got, "cpoc"), c.poc);
    assert_eq!(price(&got, "cvah"), c.vah);
    assert_eq!(price(&got, "cval"), c.val);
    assert!(price(&got, "val") <= price(&got, "poc") && price(&got, "poc") <= price(&got, "vah"));

    for _ in 0..4 * 90 {
        clock.advance(NANOS_PER_SEC / 4);
        market.advance(clock.now());
        oracle_market.advance(clock.now());
    }
    let before = market.prints_served();
    let (as_of, later) = levels.levels(&es).await.unwrap();
    let next_read = market.prints_served() - before;
    let mut since_first = 0;
    oracle
        .each_print(&es, Timestamp(as_of.0 - 90 * NANOS_PER_SEC), as_of, |_| {
            since_first += 1;
        })
        .await
        .unwrap();
    assert!(since_first > 0);
    assert_eq!(
        next_read, since_first,
        "the next read walks only the prints since the first ({first_read} prints)"
    );
    let today = profile(&oracle, as_of, ProfileMode::Session, 1).await;
    assert_eq!(price(&later, "poc"), today.profiles[0].poc.unwrap());
    assert_eq!(price(&later, "vah"), today.profiles[0].vah.unwrap());
    assert_eq!(price(&later, "val"), today.profiles[0].val.unwrap());
    assert_eq!(price(&later, "ppoc"), price(&got, "ppoc"));

    assert_eq!(value_levels(&ProfileBuilder::new(Price::from(1))), None);
}

#[tokio::test]
async fn weekly_and_monthly_levels_are_the_week_and_month_profiles() {
    let clock = Arc::new(ManualClock::new(now()));
    let (_, hub) = mock(&clock, 92, 25, 40);
    let levels = VolumeProfileLevels::new(Arc::clone(&hub), clock.clone());
    let es = InstrumentId::new("ESZ6.CME").unwrap();

    let (as_of, got) = levels.period_levels(&es).await.unwrap();
    assert_eq!(got.len(), 12, "{got:#?}");
    assert!(got.iter().all(|l| l.group == "vp"));
    let weeks = profile_of(&hub, as_of, ProfileMode::Week, 2).await;
    let months = profile_of(&hub, as_of, ProfileMode::Month, 2).await;
    for (prefix, p) in [
        ("pw", &weeks.profiles[0]),
        ("w", &weeks.profiles[1]),
        ("pm", &months.profiles[0]),
        ("m", &months.profiles[1]),
    ] {
        assert_eq!(
            price(&got, &format!("{prefix}poc")),
            p.poc.unwrap(),
            "{prefix}"
        );
        assert_eq!(
            price(&got, &format!("{prefix}vah")),
            p.vah.unwrap(),
            "{prefix}"
        );
        assert_eq!(
            price(&got, &format!("{prefix}val")),
            p.val.unwrap(),
            "{prefix}"
        );
    }
    let label = |field: &str| {
        got.iter()
            .find(|l| l.source.field == field)
            .map(|l| l.label.clone())
            .unwrap()
    };
    assert_eq!(label("wpoc"), "Week POC");
    assert_eq!(label("pmval"), "Prior month VAL");
}

async fn profile_of(
    hub: &Arc<MarketHub>,
    at: Timestamp,
    mode: ProfileMode,
    count: u32,
) -> VolumeProfileOutput {
    GetVolumeProfile::new(Arc::clone(hub))
        .call(
            &ToolCtx::new(
                Origin::Agent {
                    session_id: SessionId::new("S1"),
                    provider: "test".into(),
                },
                at,
            ),
            GetVolumeProfileInput {
                instrument: "ES".into(),
                mode: Some(mode),
                count: Some(count),
                to: Some(at),
                row_ticks: Some(1),
                max_rows: Some(500),
                ..GetVolumeProfileInput::default()
            },
        )
        .await
        .unwrap()
}
