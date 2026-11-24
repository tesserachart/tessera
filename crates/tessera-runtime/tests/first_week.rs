mod common;

use std::time::Duration;

use chrono::NaiveDate;
use serde_json::{Value, json};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle_async;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_market::pull::{Scope, day_spans};
use tessera_market::{BarsRequest, MarketDataProvider, MockConfig, MockMarket};
use tessera_runtime::secrets::Secrets;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_store::ticks::{Span, TickStore};
use tessera_testkit::rithmic::{self, GOOD_PASSWORD, ReplayLog, SYSTEM, Serves};
use tessera_testkit::{Fakes, frozen_clock};
use tessera_tools::Invoker;

use common::call_user;

const REPLAY_PAUSE: Duration = Duration::from_millis(5);
const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;
const ESTIMATE_FACTOR: f64 = 3.0;

async fn start(data: &std::path::Path, secrets: &Secrets, replays: &ReplayLog) -> RuntimeHandle {
    let clock = frozen_clock();
    let serves = Serves {
        replay_pause: REPLAY_PAUSE,
        replays: replays.clone(),
        ..Serves::default()
    };
    Runtime::build(
        RuntimeConfig {
            data_dir: Some(data.to_path_buf()),
            clock: clock.clone(),
            secrets: Some(secrets.clone()),
            rithmic: rithmic::factory_serving_mock(clock, serves),
            ..RuntimeConfig::default()
        },
        vec![
            Fakes {
                mock_connected: false,
                gamma: false,
                ..Fakes::still(20)
            }
            .module(),
        ],
    )
    .await
    .unwrap()
    .spawn()
}

async fn pulls(inv: &Invoker) -> Vec<Value> {
    call_user(
        inv,
        "market.list_pulls",
        json!({"days": "all", "limit": 100}),
    )
    .await["pulls"]
        .as_array()
        .unwrap()
        .clone()
}

fn count(pull: &Value, key: &str) -> u64 {
    pull["progress"][key].as_u64().unwrap()
}

fn answered(pull: &Value) -> u64 {
    count(pull, "saved") + count(pull, "alreadySaved") + count(pull, "noTrades")
}

async fn saved_contracts(inv: &Invoker, instrument: &str) -> Vec<(String, u64)> {
    let saved = call_user(inv, "market.saved_trades", json!({})).await;
    saved["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["instrument"].as_str().unwrap().starts_with(instrument))
        .map(|c| {
            (
                c["instrument"].as_str().unwrap().to_owned(),
                c["bytes"].as_u64().unwrap(),
            )
        })
        .collect()
}

async fn saved_bytes(inv: &Invoker, instrument: &str) -> u64 {
    saved_contracts(inv, instrument)
        .await
        .iter()
        .map(|(_, bytes)| bytes)
        .sum()
}

#[derive(Debug, PartialEq)]
struct Recorded {
    bytes: u64,
    filling: Vec<String>,
}

async fn settled_bytes(h: &RuntimeHandle, instrument: &str) -> u64 {
    let hub = h.state.market.hub();
    let recorded = settle_async(
        &format!("the recording of {instrument} stops filling"),
        move || async move {
            let contracts = saved_contracts(&h.state.invoker, instrument).await;
            Recorded {
                bytes: contracts.iter().map(|(_, bytes)| bytes).sum(),
                filling: contracts
                    .into_iter()
                    .map(|(id, _)| id)
                    .filter(|id| hub.pulling(&InstrumentId::new(id).unwrap()))
                    .collect(),
            }
        },
        |r| r.bytes > 0 && r.filling.is_empty(),
    )
    .await;
    recorded.bytes
}

async fn estimate_until(inv: &Invoker, root: &str, ready: impl Fn(&Value) -> bool) -> Value {
    settle_async(
        &format!("the estimate of {root} becomes known"),
        || call_user(inv, "market.estimate_pull", json!({"instrument": root})),
        ready,
    )
    .await
}

async fn progress(inv: &Invoker) -> Vec<(Value, u64)> {
    pulls(inv)
        .await
        .iter()
        .map(|p| (p["state"].clone(), answered(p)))
        .collect()
}

fn at(ns: i64) -> Value {
    serde_json::to_value(Timestamp(ns)).unwrap()
}

fn date(v: &Value) -> NaiveDate {
    v.as_str().unwrap().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_first_week_downloads_across_a_restart_and_fills_the_charts_and_replay() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let secrets = Secrets::in_memory();
    let replays = ReplayLog::default();

    let h = start(&data, &secrets, &replays).await;
    let inv = h.state.invoker.clone();
    call_user(
        &inv,
        "settings.set",
        json!({"key": "market.recordWatchlists", "value": false}),
    )
    .await;
    call_user(
        &inv,
        "connections.add_rithmic",
        json!({"system": SYSTEM, "gateway": "Chicago Area", "user": "alice", "password": GOOD_PASSWORD}),
    )
    .await;

    let before = call_user(&inv, "market.estimate_pull", json!({"instrument": "NQ"})).await;
    assert_eq!(
        before["size"],
        Value::Null,
        "nothing is saved to measure from"
    );
    assert_eq!(before["seconds"], Value::Null);
    assert_eq!(before["saved"], 0);
    let days = before["days"].as_u64().unwrap();
    assert!(days >= 4, "a week of sessions: {before}");

    call_user(
        &inv,
        "settings.set",
        json!({"key": "market.recordWatchlists", "value": true}),
    )
    .await;
    let measured = estimate_until(&inv, "NQ", |e| {
        !e["size"].is_null() && !e["seconds"].is_null()
    })
    .await;
    let request = measured["request"].clone();
    assert_eq!(request["scope"], "session");
    assert_eq!(measured["days"], before["days"]);
    assert_eq!(measured["id"], before["id"]);
    let estimated_bytes = measured["size"]["bytes"].as_u64().unwrap();
    let estimated_prints = measured["size"]["prints"].as_u64().unwrap();
    assert!(estimated_bytes > 0 && estimated_prints > 0);

    let es = call_user(&inv, "market.estimate_pull", json!({"instrument": "ES"})).await;
    let recorded = settled_bytes(&h, "NQ").await;

    let nq_pull = call_user(&inv, "market.pull_trades", request.clone()).await;
    let es_pull = call_user(&inv, "market.pull_trades", es["request"].clone()).await;
    let ids = [nq_pull["id"].clone(), es_pull["id"].clone()];
    let in_reach = |p: &Value| count(p, "days") - count(p, "outOfReach");
    let total: u64 = [&nq_pull, &es_pull].iter().map(|p| in_reach(p)).sum();

    settle_async(
        "a day is saved",
        || progress(&inv),
        |pulls| pulls.iter().map(|(_, answered)| answered).sum::<u64>() >= 1,
    )
    .await;
    h.shutdown().await.unwrap();

    let store = TickStore::open_in_dir(&data).unwrap();
    let mut kept: Vec<(String, Span)> = Vec::new();
    for c in store.contracts().unwrap() {
        let key = tessera_store::ticks::TickKey {
            source: &c.source,
            instrument: &c.instrument,
        };
        for d in store.days(key).unwrap() {
            kept.extend(d.covered.iter().map(|s| (c.instrument.clone(), *s)));
        }
    }
    drop(store);
    let first_run = replays.asked().len();
    assert!(
        !kept.is_empty(),
        "some prints were saved before the restart"
    );

    let h = start(&data, &secrets, &replays).await;
    let inv = h.state.invoker.clone();
    settle_async(
        "the resumed pulls end by themselves",
        || progress(&inv),
        |pulls| pulls.len() == 2 && pulls.iter().all(|(state, _)| state == "done"),
    )
    .await;
    let all = pulls(&inv).await;
    let done: u64 = all.iter().map(answered).sum();
    for p in &all {
        assert_eq!(count(p, "failed"), 0, "{p}");
        assert_eq!(
            answered(p) + count(p, "outOfReach"),
            count(p, "days"),
            "{p}"
        );
        assert!(ids.contains(&p["id"]));
    }
    assert_eq!(done, total);

    assert!(
        replays.asked().len() > first_run,
        "the resumed pulls asked for the days still missing"
    );
    let again: Vec<(i64, i64)> = replays.asked()[first_run..]
        .iter()
        .filter(|(i, from, to)| {
            kept.iter()
                .any(|(c, s)| c == i.as_str() && s.start <= *from && *to <= s.end)
        })
        .map(|(_, from, to)| (*from, *to))
        .collect();
    assert!(
        again.is_empty(),
        "nothing saved before the restart is asked again: {again:?}"
    );

    let mock = MockMarket::new({
        let mut c = MockConfig::new(frozen_clock());
        c.keeps_trade_history = false;
        c
    });
    for pull in &all {
        let request = &pull["request"];
        let root = request["instrument"].as_str().unwrap();
        let coverage = call_user(
            &inv,
            "market.data_coverage",
            json!({"instrument": root, "from": request["from"], "to": request["to"], "scope": "session"}),
        )
        .await;
        let reachable: Vec<&Value> = pull["days"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["status"]["kind"] != "out_of_reach")
            .collect();
        assert_eq!(
            coverage["printsSaved"], coverage["days"],
            "{root}: {coverage}"
        );
        assert_eq!(coverage["barsMissing"], json!([]), "{root}: {coverage}");
        for day in reachable {
            let spans = day_spans(CAL, date(&day["date"]), Scope::Session);
            let (from, to) = (spans[0].start, spans.last().unwrap().end);
            let candles = call_user(
                &inv,
                "market.get_candles",
                json!({
                    "instrument": day["contract"],
                    "tf": "1m",
                    "from": at(from),
                    "to": at(to - 1),
                    "limit": 5000,
                    "cachedOnly": true,
                }),
            )
            .await;
            let served = mock
                .get_bars(BarsRequest {
                    instrument: InstrumentId::new(day["contract"].as_str().unwrap()).unwrap(),
                    tf: Timeframe::M1,
                    from: Some(Timestamp(from)),
                    to: Some(Timestamp(to - 1)),
                    limit: None,
                    rth_only: false,
                })
                .await
                .unwrap();
            let want = served
                .bars
                .iter()
                .filter(|b| spans.iter().any(|s| s.contains(b.t.0)))
                .count();
            let got = candles["bars"].as_array().unwrap().len();
            assert!(want > 0);
            assert_eq!(
                got, want,
                "{root} {}: every minute of the session",
                day["date"]
            );
        }
    }

    let nq = all
        .iter()
        .find(|p| p["request"]["instrument"] == "NQ")
        .unwrap();
    let middle = nq["days"].as_array().unwrap()[2].clone();
    let replay = call_user(
        &inv,
        "market.open_replay",
        json!({
            "instrument": middle["contract"],
            "tradeDate": middle["date"],
            "playing": false,
            "at": at(day_spans(CAL, date(&middle["date"]), Scope::Session)[0].end - 1),
        }),
    )
    .await;
    assert_eq!(replay["earlier"]["kind"], "whole", "{replay}");
    let tape = call_user(
        &inv,
        "market.get_trades",
        json!({"instrument": replay["instrument"], "from": replay["from"], "limit": 10000}),
    )
    .await;
    assert!(
        !tape["trades"].as_array().unwrap().is_empty(),
        "the replay reads the day's prints from disk: {tape}"
    );

    for root in ["NQ", "ES"] {
        let after = call_user(&inv, "market.estimate_pull", json!({"instrument": root})).await;
        assert_eq!(
            after["saved"].as_u64().unwrap(),
            after["days"].as_u64().unwrap() - after["outOfReach"].as_u64().unwrap(),
            "{after}"
        );
        assert_eq!(after["size"]["bytes"], 0, "{after}");
        assert_eq!(after["seconds"], 0, "{after}");
    }

    let pulled = saved_bytes(&inv, "NQ").await - recorded;
    let ratio = estimated_bytes as f64 / pulled as f64;
    println!(
        "estimate before the download: {estimated_bytes} bytes, {estimated_prints} prints; \
         saved by the download: {pulled} bytes; estimate over actual {ratio:.2}"
    );
    assert!(
        (1.0 / ESTIMATE_FACTOR..=ESTIMATE_FACTOR).contains(&ratio),
        "the estimate is within a factor of {ESTIMATE_FACTOR} of what the pull saved"
    );
    h.shutdown().await.unwrap();
}
