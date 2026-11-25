use std::collections::BTreeSet;
use std::sync::Arc;

use chrono::TimeZone;
use tessera_core::clock::ManualClock;
use tessera_core::market::{Aggressor, AggressorSource};
use tessera_core::money::Qty;
use tessera_core::{Timeframe, Timestamp};
use tessera_market::mock::MOCK_PROVIDER_ID;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{BarsRequest, MarketDataProvider, MarketRouter, MockConfig, MockMarket};
use tessera_research::Studies;
use tessera_research::evaluate::Gates;
use tessera_research::experiment::ExperimentState;
use tessera_research::study::{Execution, Strategy, Study, StudyData};
use tessera_store::Store;
use tessera_store::ticks::{Span, TickRow, TickStore};

const FIRST_BAR_LONG: &str = "export function positions(bars) {\n  return bars.session.map((s, i) => (i === 0 || s !== bars.session[i - 1] ? 1 : NaN));\n}\n";

fn ny_date(t: i64) -> String {
    chrono_tz::America::New_York
        .timestamp_nanos(t)
        .format("%Y-%m-%d")
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stops_and_targets_resolve_on_saved_prints_and_bars_alone_are_approximate() {
    let now = Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap();
    let clock = Arc::new(ManualClock::new(now));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.intraday_sessions = 10;
    let market = MarketRouter::new();
    market.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let saved = SavedTrades::new(Arc::new(TickStore::open_in_dir(dir.path()).unwrap()));

    let nq = market.resolve("NQ").await.unwrap();
    let provider = market.route_async(&nq).await.unwrap();
    let (_, spec) = provider.spec(&nq).await.unwrap();
    let bars = provider
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M5,
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
        .map(|b| ny_date(b.t.0))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let printed: BTreeSet<&String> = dates.iter().skip(2).step_by(2).collect();
    let contract = Contract::new(MOCK_PROVIDER_ID, &nq);
    let width = Timeframe::M5.nanos();
    for b in bars.iter().filter(|b| printed.contains(&ny_date(b.t.0))) {
        let row = |k: i64, price| TickRow {
            t: b.t.0 + k * width / 5,
            price,
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
        };
        let rows = [row(0, b.o), row(1, b.h), row(2, b.l), row(3, b.c)];
        saved
            .save_now(
                &contract,
                spec.sessions,
                &rows,
                Span::new(b.t.0, b.t.0 + width),
            )
            .unwrap();
    }

    let study = Study {
        id: String::new(),
        name: "Long the first bar".into(),
        family: String::new(),
        hypothesis: "h".into(),
        notes: None,
        data: StudyData {
            instrument: nq.clone(),
            tf: Timeframe::M5,
            from: None,
            to: None,
            rth_only: true,
            development_share: 0.5,
            levels: Vec::new(),
            window: None,
        },
        strategy: Strategy::Script {
            code: FIRST_BAR_LONG.into(),
            inputs: serde_json::Map::new(),
            free_parameters: 0,
        },
        execution: Execution {
            stop_ticks: Some(8.0),
            target_ticks: Some(8.0),
            ..Execution::default()
        },
        gates: Gates {
            min_trades: 1,
            ..Gates::default()
        },
        placebo_runs: 0,
        state: ExperimentState::Draft,
        generation: 1,
        manifest_hash: None,
        frozen_at: None,
        last_verdict: None,
        origin: None,
    };
    let studies = Studies::new(Store::open_in_memory().unwrap(), Arc::clone(&market), clock)
        .with_prints(saved);
    let saved_study = studies.save(study).await.unwrap();
    let run = studies
        .run(&saved_study.id, tessera_core::Origin::User)
        .await
        .unwrap();

    let base = &run.evaluation.cases[0];
    let bracketed: Vec<_> = base
        .trades
        .iter()
        .filter(|t| {
            matches!(
                t.exit,
                tessera_research::backtest::ExitReason::Stop
                    | tessera_research::backtest::ExitReason::Target
            )
        })
        .collect();
    assert!(!bracketed.is_empty());
    for t in &bracketed {
        let on_prints = printed.contains(&ny_date(t.exit_time));
        assert_eq!(
            t.approximate,
            !on_prints,
            "{} {:?}",
            ny_date(t.exit_time),
            t.exit
        );
    }
    assert!(bracketed.iter().any(|t| t.approximate));
    assert!(bracketed.iter().any(|t| !t.approximate));
    let counted = base.development.metrics.approximate_exits + base.later.metrics.approximate_exits;
    assert_eq!(
        counted as usize,
        bracketed.iter().filter(|t| t.approximate).count()
    );
}
