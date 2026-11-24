use std::collections::BTreeSet;
use std::sync::Arc;

use chrono::{TimeZone, Timelike};
use tessera_core::clock::ManualClock;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_market::{BarsRequest, MarketDataProvider, MarketRouter, MockConfig, MockMarket};
use tessera_research::Studies;
use tessera_research::evaluate::Gates;
use tessera_research::experiment::ExperimentState;
use tessera_research::levels::{self, TimeWindow};
use tessera_research::study::{Execution, Strategy, Study, StudyData, frame_of};
use tessera_store::Store;
use tessera_store::level_history::{Observation, SeriesInfo};

const SEC: i64 = 1_000_000_000;

const BELOW_THE_LEVEL: &str = "export function positions(bars) {\n  const level = bars.levels['acme.major_long_gamma'];\n  return bars.close.map((c, i) => (Number.isNaN(level[i]) ? NaN : c < level[i] ? 1 : -1));\n}\n";

fn ny(t: i64) -> chrono::DateTime<chrono_tz::Tz> {
    chrono_tz::America::New_York.timestamp_nanos(t)
}

fn study(levels: Vec<String>) -> Study {
    Study {
        id: String::new(),
        name: "Major long gamma, 09:30–11:30".into(),
        family: String::new(),
        hypothesis: "Below Acme's major long gamma, NQ drifts up toward it in the first two hours of the cash session; above it, down.".into(),
        notes: None,
        data: StudyData {
            instrument: InstrumentId::new("NQ").unwrap(),
            tf: Timeframe::M1,
            from: None,
            to: None,
            rth_only: true,
            development_share: 0.5,
            levels,
            window: Some(TimeWindow {
                start: "09:30".into(),
                end: "11:30".into(),
                time_zone: None,
            }),
        },
        strategy: Strategy::Script {
            code: BELOW_THE_LEVEL.into(),
            inputs: serde_json::Map::new(),
            free_parameters: 0,
        },
        execution: Execution::default(),
        gates: Gates {
            min_trades: 5,
            ..Gates::default()
        },
        placebo_runs: 0,
        state: ExperimentState::Draft,
        generation: 1,
        manifest_hash: None,
        frozen_at: None,
        last_verdict: None,
        author: None,
    }
}

#[tokio::test]
async fn a_level_input_is_aligned_covered_windowed_and_refused_without_history() {
    let now = Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap();
    let clock = Arc::new(ManualClock::new(now));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.intraday_sessions = 12;
    let mock = MockMarket::new(cfg);
    let market = MarketRouter::new();
    market.add(Arc::new(mock)).unwrap();
    let store = Store::open_in_memory().unwrap();
    let studies = Studies::new(store.clone(), Arc::clone(&market), clock.clone());

    let nq = market.resolve("NQ").await.unwrap();
    let provider = market.route_async(&nq).await.unwrap();
    let bars = provider
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: None,
            to: None,
            limit: None,
            rth_only: true,
        })
        .await
        .unwrap()
        .bars;
    let dates: Vec<String> = bars
        .iter()
        .map(|b| ny(b.t.0).format("%Y-%m-%d").to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    assert!(dates.len() >= 10, "{dates:?}");
    let with_history: Vec<&String> = dates[3..10].iter().collect();

    let h = store.level_history();
    let series = h
        .series(
            &SeriesInfo {
                vendor: "Acme".into(),
                package: "State".into(),
                level: "major_long_gamma".into(),
                instrument: nq.to_string(),
                label: Some("Major Long Gamma".into()),
                endpoint: Some("state/gamma_zero".into()),
                basis: Some("NDX".into()),
                meta: None,
            },
            now,
        )
        .unwrap();
    let mut rows = Vec::new();
    for b in &bars {
        let day = ny(b.t.0).format("%Y-%m-%d").to_string();
        if !with_history.contains(&&day) || !ny(b.t.0).minute().is_multiple_of(2) {
            continue;
        }
        let close: f64 = b.c.0.to_string().parse().unwrap();
        rows.push(Observation {
            as_of: b.t,
            known_at: Timestamp(b.t.0 + 5 * SEC),
            value: Some((close / 50.0).round() * 50.0 + 25.0),
            native_value: None,
            reason: None,
            conversion: None,
            origin: "import".into(),
            batch: "fixture".into(),
        });
    }
    h.insert(series, &rows).unwrap();

    let saved = studies
        .save(study(vec!["acme.major_long_gamma".into()]))
        .await
        .unwrap();
    let run = studies.run(&saved.id).await.unwrap();

    let cov = run.levels.as_ref().expect("coverage reported");
    assert_eq!(cov.sessions_used, 7);
    assert_eq!(cov.sessions_read as usize, dates.len());
    assert_eq!(cov.used_from.as_deref(), Some(with_history[0].as_str()));
    assert_eq!(cov.used_to.as_deref(), Some(with_history[6].as_str()));
    assert!(cov.excluded_dates.contains(&dates[0]));
    let input = &cov.inputs[0];
    assert_eq!(input.series, "acme.state.major_long_gamma");
    assert_eq!(input.vendor, "Acme");
    assert_eq!(input.sessions, 7);
    assert_eq!(run.evaluation.sessions, 7);

    let (_, spec) = provider.spec(&nq).await.unwrap();
    let names = vec!["acme.major_long_gamma".to_owned()];
    let (frame, _) = levels::prepare(
        &store,
        &names,
        &[nq.to_string()],
        frame_of(&bars, spec.sessions),
        Timeframe::M1,
    )
    .unwrap();
    assert_eq!(frame.levels[0].name, "acme.major_long_gamma");
    let mut seen_mid_bar_change = false;
    for (i, t) in frame.bars.time.iter().enumerate() {
        let expected = rows
            .iter()
            .filter(|o| o.known_at.0 <= *t)
            .max_by_key(|o| o.as_of)
            .and_then(|o| o.value);
        let got = frame.levels[0].values[i];
        match expected {
            Some(v) => assert_eq!(got, v, "bar {i}"),
            None => assert!(got.is_nan(), "bar {i}"),
        }
        if let Some(o) = rows.iter().find(|o| o.as_of.0 == *t)
            && let Some(prev) = rows
                .iter()
                .filter(|p| p.as_of.0 < *t)
                .max_by_key(|p| p.as_of)
            && prev.value != o.value
        {
            assert_eq!(
                Some(got),
                prev.value,
                "a mid-bar change is not seen by that bar"
            );
            assert_eq!(
                frame.levels[0].values[i + 1],
                o.value.unwrap(),
                "the next bar sees it"
            );
            seen_mid_bar_change = true;
        }
    }
    assert!(
        seen_mid_bar_change,
        "the fixture changes the level mid-bar somewhere"
    );
    assert!(frame.levels[0].as_of.iter().any(|a| a.is_finite()));

    let trades = &run.evaluation.cases[0].trades;
    assert!(!trades.is_empty());
    for t in trades {
        let (a, b) = (ny(t.entry_time), ny(t.exit_time));
        let (am, bm) = (a.hour() * 60 + a.minute(), b.hour() * 60 + b.minute());
        assert!((570..690).contains(&am), "entry at {a}");
        assert!(
            bm <= 690 && b.date_naive() == a.date_naive(),
            "exit at {b} for entry {a}"
        );
    }

    let frozen = studies.freeze(&saved.id).unwrap();
    let other = studies
        .save(study(vec!["acme.state.major_long_gamma".into()]))
        .await
        .unwrap();
    let other = studies.freeze(&other.id).unwrap();
    assert_ne!(frozen.manifest_hash, other.manifest_hash);

    let none = studies
        .save(study(vec!["acme.major_short_gamma".into()]))
        .await
        .unwrap();
    let e = studies.run(&none.id).await.unwrap_err();
    assert!(
        e.contains("no level history of acme.major_short_gamma"),
        "{e}"
    );
    assert!(e.contains("Nothing has been recorded yet"), "{e}");
    assert!(
        studies
            .save(study(vec!["major_long_gamma".into()]))
            .await
            .is_err()
    );
    assert_eq!(
        studies.runs(&none.id).unwrap().len(),
        0,
        "a refused run is not stored"
    );
}
