mod support;

use std::sync::Arc;

use serde_json::{Map, Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::{InstrumentId, Origin, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicKey, TopicSizing};
use tessera_indicators::io::{ComputeInput, Replaces, SeriesUpdate};
use tessera_indicators::{CATALOG_TOPIC, IndicatorsModule, IndicatorsService, SERIES_TOPIC};
use tessera_market::{MarketDataProvider, MarketRouter, MockConfig, MockMarket};
use tessera_protocol::indicators::{CustomIndicators, IndicatorPlacement, PlotKind};
use tessera_protocol::tools::ToolErrorCode;
use tessera_protocol::topics::names;
use tessera_store::Store;

const EMA_CROSS: &str = include_str!("../js/ema_cross.js");
const ZSCORE: &str = include_str!("../js/zscore_band.js");
const DELTA_DIV: &str = include_str!("../js/delta_divergence.js");

fn now() -> Timestamp {
    "2026-10-02T14:42:30-04:00".parse().unwrap()
}

struct World {
    svc: Arc<IndicatorsService>,
    bus: Arc<EventBus>,
    market: Arc<MarketRouter>,
}

fn world() -> World {
    world_over(Store::open_in_memory().unwrap())
}

fn world_over(store: Store) -> World {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
    cfg.intraday_sessions = 3;
    cfg.daily_sessions = 10;
    let market = MarketRouter::new();
    market.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let bus = Arc::new(EventBus::new());
    bus.register(names::MARKET_BARS, TopicSizing::MARKET)
        .unwrap();
    bus.register(SERIES_TOPIC, TopicSizing::LOW_RATE).unwrap();
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let svc =
        IndicatorsService::load(store, Arc::clone(&market), None, Arc::clone(&bus), clock).unwrap();
    World { svc, bus, market }
}

fn ask(
    indicator: &str,
    inputs: Map<String, Value>,
    instrument: &str,
    tf: Timeframe,
    limit: u32,
    tail: Option<u32>,
) -> ComputeInput {
    ComputeInput {
        indicator: indicator.to_owned(),
        version: None,
        inputs: Some(inputs),
        instrument: instrument.to_owned(),
        tf,
        from: None,
        to: None,
        limit: Some(limit),
        tail,
        session: None,
    }
}

fn ema(x: &[f64], n: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; x.len()];
    if x.len() < n {
        return out;
    }
    let mut prev = x[..n].iter().sum::<f64>() / n as f64;
    out[n - 1] = Some(prev);
    let a = 2.0 / (n as f64 + 1.0);
    for i in n..x.len() {
        prev += a * (x[i] - prev);
        out[i] = Some(prev);
    }
    out
}

#[tokio::test]
async fn custom_indicators_are_saved_versioned_and_computed() {
    let w = world();
    let user = Origin::User;
    let created = w
        .svc
        .create(EMA_CROSS, Some("first".into()), &user, now())
        .await
        .unwrap();
    let c = created.custom.clone().unwrap();
    assert!(c.id.starts_with("ci_"));
    assert_eq!((c.version, c.latest), (1, 1));
    assert_eq!(c.spec.title, "EMA cross");
    assert_eq!(c.spec.placement, IndicatorPlacement::Overlay);
    assert_eq!(
        c.spec
            .inputs
            .iter()
            .map(|i| i.key.as_str())
            .collect::<Vec<_>>(),
        ["fast", "slow", "source"]
    );
    assert_eq!(c.spec.fills.len(), 1);
    assert!(
        c.description
            .as_deref()
            .unwrap()
            .starts_with("Two exponential moving averages")
    );
    assert_eq!(created.code.as_deref(), Some(EMA_CROSS));
    assert_eq!(w.svc.custom().len(), 1);

    let s = w
        .svc
        .compute(ask(&c.id, Map::new(), "QQQ", Timeframe::M5, 200, None))
        .await
        .unwrap();
    assert_eq!(s.time.len(), 200);
    assert_eq!(s.inputs["fast"], 9);
    let from = s.computed_from.expect("computed from a bar");
    assert!(
        from <= s.time[0],
        "seeded at or before the first bar returned"
    );
    let bars = w
        .market
        .get_bars(tessera_market::BarsRequest {
            instrument: InstrumentId::new("QQQ").unwrap(),
            tf: Timeframe::M5,
            from: Some(from),
            to: None,
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap()
        .bars;
    assert_eq!(
        s.bars as usize,
        bars.len(),
        "computed over every bar from computedFrom"
    );
    let closes: Vec<f64> = bars.iter().map(|b| b.c.to_f64()).collect();
    let skip = bars.len() - 200;
    for (plot, n) in [("fast", 9), ("slow", 21)] {
        let want = ema(&closes, n);
        let got = &s.plots.iter().find(|p| p.key == plot).unwrap().values;
        for (i, (g, w)) in got.iter().zip(&want[skip..]).enumerate() {
            match (g, w) {
                (Some(g), Some(w)) => assert!((g - w).abs() < 1e-9, "{plot}[{i}]: {g} vs {w}"),
                (None, None) => {}
                _ => panic!("{plot}[{i}]: {g:?} vs {w:?}"),
            }
        }
    }
    let mut inputs = Map::new();
    inputs.insert("fast".into(), json!(3));
    let s = w
        .svc
        .compute(ask(&c.id, inputs, "QQQ", Timeframe::M5, 50, Some(5)))
        .await
        .unwrap();
    assert_eq!(s.time.len(), 5);
    assert_eq!(s.inputs["fast"], 3);
    let bad = w
        .svc
        .compute(ask(
            &c.id,
            Map::from_iter([("fast".into(), json!(0))]),
            "QQQ",
            Timeframe::M5,
            50,
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(bad.code, ToolErrorCode::InvalidInput);
    assert!(
        bad.message.contains("fast is 0; it must be at least 1"),
        "{}",
        bad.message
    );

    let v2 = EMA_CROSS.replace("default: 9,", "default: 5,");
    let updated = w
        .svc
        .update(&c.id, &v2, Some("faster".into()), Some(1), &user, now())
        .await
        .unwrap();
    assert_eq!(updated.custom.as_ref().unwrap().version, 2);
    assert_eq!(updated.versions.len(), 2);
    assert_eq!(updated.versions[0].note.as_deref(), Some("faster"));
    let stale = w
        .svc
        .update(&c.id, &v2, None, Some(1), &user, now())
        .await
        .unwrap_err();
    assert_eq!(stale.code, ToolErrorCode::Conflict);
    let old = w.svc.get(&c.id, Some(1)).await.unwrap();
    assert_eq!(old.code.as_deref(), Some(EMA_CROSS));
    assert_eq!(
        w.svc.custom_spec(&c.id, Some(1)).unwrap().inputs[0].default,
        json!(9)
    );
    assert_eq!(
        w.svc.custom_spec(&c.id, None).unwrap().inputs[0].default,
        json!(5)
    );

    let spec = w.svc.custom_spec(&c.id, None).unwrap();
    let p = tessera_protocol::indicators::normalize_custom_params(
        Some(&spec),
        &json!({"indicator": c.id, "inputs": {"slow": 50}}),
    )
    .unwrap();
    assert_eq!(
        p["inputs"],
        json!({"fast": 5, "slow": 50, "source": "close"})
    );
    assert!(
        tessera_protocol::indicators::normalize_custom_params(
            Some(&spec),
            &json!({"indicator": c.id, "inputs": {"slow": 9999}})
        )
        .is_err()
    );

    assert!(w.svc.delete(&c.id).await.unwrap());
    assert!(w.svc.custom().is_empty());
    assert!(w.svc.custom_spec(&c.id, None).is_err());
    assert_eq!(
        w.svc.get(&c.id, None).await.unwrap_err().code,
        ToolErrorCode::NotFound
    );
}

#[tokio::test]
async fn the_documented_examples_run() {
    let w = world();
    let z = w
        .svc
        .preview(support::preview(ZSCORE, "NQ", Timeframe::M1, 400, None))
        .await
        .unwrap();
    assert_eq!(z.spec.placement, IndicatorPlacement::Pane);
    assert_eq!(z.plots.len(), 3, "hlines are drawn, not computed");
    assert!(z.spec.plots.iter().any(|p| p.kind == PlotKind::Hline));
    let zs = &z.plots[0].values;
    assert!(zs[..49].iter().all(Option::is_none));
    assert!(zs[49..].iter().all(|v| v.is_some_and(f64::is_finite)));
    assert_eq!(z.plots[1].values[100], Some(2.0));
    assert_eq!(z.plots[2].values[100], Some(-2.0));

    let d = w
        .svc
        .preview(support::preview(DELTA_DIV, "NQ", Timeframe::M1, 400, None))
        .await
        .unwrap();
    let osc = &d.plots[0].values;
    assert!(
        osc.iter()
            .rev()
            .take(300)
            .all(|v| v.is_some_and(|x| (-2.0..=2.0).contains(&x)))
    );
    assert!(d.compute_ms < 1000.0);

    let e = w
        .svc
        .preview(support::preview(
            &DELTA_DIV.replace("!bars.delta", "true"),
            "NQ",
            Timeframe::M1,
            50,
            None,
        ))
        .await
        .unwrap_err();
    assert!(e.message.contains("no aggressor side"), "{}", e.message);
    let line = e.details.as_ref().unwrap()["line"].as_u64().unwrap();
    assert_eq!(
        DELTA_DIV.lines().nth(line as usize - 1).unwrap().trim(),
        "if (!bars.delta) throw new Error('this market reports no aggressor side, so there is no delta to compare');"
    );

    let guide = include_str!("../../../docs/indicators.md");
    for code in [EMA_CROSS, ZSCORE, DELTA_DIV] {
        assert!(
            guide.contains(code.trim_end()),
            "docs/indicators.md shows a different example"
        );
    }
}

#[tokio::test]
async fn bad_declarations_are_refused_with_their_line() {
    let w = world();
    let code = "export const indicator = {\n  inputs: { n: { type: 'int', default: 0, min: 1 } },\n  plots: ['v'],\n};\nexport function compute(bars) {\n  return { v: bars.close };\n}\n";
    let e = w
        .svc
        .create(code, None, &Origin::User, now())
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::InvalidInput);
    assert_eq!(e.message, "line 2: inputs.n: default 0 is below min 1");
    assert_eq!(e.details.as_ref().unwrap()["line"], 2);
    let e = w
        .svc
        .create(
            "export const indicator = { plots: ['v'] };\n",
            None,
            &Origin::User,
            now(),
        )
        .await
        .unwrap_err();
    assert!(
        e.message.contains("export function compute(bars, inputs)"),
        "{}",
        e.message
    );
    let e = w
        .svc
        .create(
            "export function compute(bars, inputs) {\n  return 1 +;\n}\n",
            None,
            &Origin::User,
            now(),
        )
        .await
        .unwrap_err();
    assert_eq!(e.details.as_ref().unwrap()["kind"], "SyntaxError");
    assert_eq!(e.details.as_ref().unwrap()["line"], 2);
    assert!(w.svc.custom().is_empty(), "nothing is saved");
}

#[tokio::test]
async fn series_follow_closing_bars_and_saves() {
    let w = world();
    let c = w
        .svc
        .create(EMA_CROSS, None, &Origin::User, now())
        .await
        .unwrap()
        .custom
        .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&w.svc));
    let topics = module.topic_handlers();
    let series = topics.iter().find(|t| t.name() == SERIES_TOPIC).unwrap();
    let (mut rx, _) = w.bus.subscribe(SERIES_TOPIC).unwrap();
    let sub = series
        .subscribe(json!({"indicator": c.id, "instrument": "QQQ", "tf": "5m"}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert_eq!(snap.replaces, Replaces::All);
    let held = w
        .market
        .get_bars(tessera_market::BarsRequest::latest(
            InstrumentId::new("QQQ").unwrap(),
            Timeframe::M5,
            1500,
        ))
        .await
        .unwrap()
        .bars;
    assert_eq!(
        support::times_ms(&snap),
        held.iter().map(|b| b.t.0 / 1_000_000).collect::<Vec<_>>(),
        "the newest bars, up to 1,500"
    );
    assert_eq!(snap.version, Some(1));
    let KeyFilter::Id(key) = sub.filter.clone() else {
        panic!("an id filter")
    };

    let last = Timestamp(*support::times_ms(&snap).last().unwrap() * 1_000_000);
    let bar = json!({
        "instrument": "QQQ", "tf": "5m",
        "bar": [last.0 + 300_000_000_000, 500.0, 501.0, 499.0, 500.5, 1000.0, 600.0],
        "closed": true, "source": {"provider": "mock-market"}
    });
    w.bus.publish(
        names::MARKET_BARS,
        TopicKey::Bars(InstrumentId::new("QQQ").unwrap(), Timeframe::M5),
        &bar,
    );
    let u = next(&mut rx, &key).await;
    assert_ne!(u.replaces, Replaces::All);
    assert_eq!(
        *support::times_ms(&u).last().unwrap(),
        (last.0 + 300_000_000_000) / 1_000_000,
        "the new bar is sent"
    );
    assert!(
        support::times_ms(&u).len() < 10,
        "only what changed is sent"
    );

    let v2 = EMA_CROSS.replace("default: 9,", "default: 4,");
    w.svc
        .update(&c.id, &v2, None, None, &Origin::User, now())
        .await
        .unwrap();
    let u = next(&mut rx, &key).await;
    assert_eq!(u.replaces, Replaces::All);
    assert_eq!(u.version, Some(2));
    w.svc.delete(&c.id).await.unwrap();
    let u = next(&mut rx, &key).await;
    assert!(
        u.error
            .as_ref()
            .unwrap()
            .message
            .contains("no custom indicator")
    );
    drop(sub);
}

#[tokio::test]
async fn a_series_asked_before_a_market_connection_is_added_is_refused_as_unavailable_then_served()
{
    let w = world();
    let c = w
        .svc
        .create(EMA_CROSS, None, &Origin::User, now())
        .await
        .unwrap()
        .custom
        .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&w.svc));
    let series = support::series(&module);
    let connection = w
        .market
        .remove(tessera_market::mock::MOCK_PROVIDER_ID)
        .unwrap();
    let asked = json!({"indicator": c.id, "instrument": "QQQ", "tf": "5m"});

    let Err(refused) = series.subscribe(asked.clone()).await else {
        panic!("a series was served with no market connection");
    };
    assert_eq!(refused.code, codes::UNAVAILABLE, "{}", refused.message);
    assert!(
        refused
            .message
            .contains("no market-data connection is configured")
    );

    w.market.add(connection).unwrap();
    let sub = series.subscribe(asked).await.unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert_eq!(snap.error, None);
    assert!(
        support::column(&snap, "fast").iter().any(|v| v.is_finite()),
        "the indicator has values"
    );
}

use support::next;
use tessera_host::KeyFilter;
use tessera_protocol::rpc::codes;

const OLD: &str =
    "TITLE = 'Old'\nPLOTS = ['v']\n\ndef compute(bars, inputs):\n    return bars.close\n";

#[tokio::test]
async fn stored_code_the_engine_cannot_read_is_left_out() {
    let store = Store::open_in_memory().unwrap();
    let manifest = json!({
        "title": "Old", "short": "Old", "description": null, "placement": "pane", "format": "number",
        "range": null, "inputs": [], "plots": [], "fills": []
    });
    store
        .custom_indicators()
        .create("ci_old", "Old", OLD, &manifest, None, "user", now())
        .unwrap();
    let w = world_over(store);
    assert!(w.svc.custom().is_empty());
    assert_eq!(
        w.svc.get("ci_old", None).await.unwrap_err().code,
        ToolErrorCode::NotFound
    );
    assert!(
        w.svc.custom_spec("ci_old", None).is_err(),
        "a chart says it is gone"
    );
    w.svc
        .create(EMA_CROSS, None, &Origin::User, now())
        .await
        .unwrap();
    assert_eq!(w.svc.custom().len(), 1);
}
