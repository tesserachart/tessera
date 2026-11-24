mod common;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tessera_core::{Origin, Timestamp};
use tessera_protocol::tools::ToolErrorCode;
use tessera_runtime::secrets::Secrets;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::rithmic::{self, GOOD_PASSWORD, ReplayLog, SYSTEM, Serves};
use tessera_testkit::{Fakes, frozen_clock};
use tessera_tools::Invoker;

use common::{call_user, try_call_code};

const THROTTLED: Duration = Duration::from_millis(400);
const FIRST_BARS_WITHIN: Duration = Duration::from_secs(5);
const SETTLED_WITHIN: Duration = Duration::from_secs(120);
const ASK_AGAIN: Duration = Duration::from_millis(250);
const TODAY_OPENED: &str = "2026-10-01T18:00:00-04:00";
const UNSETTLED_FROM: &str = "2026-10-02T14:40:00-04:00";

async fn start(data: &std::path::Path, secrets: &Secrets, replays: &ReplayLog) -> RuntimeHandle {
    start_with(data, secrets, replays, false).await
}

async fn start_with(
    data: &std::path::Path,
    secrets: &Secrets,
    replays: &ReplayLog,
    refuses_replays: bool,
) -> RuntimeHandle {
    let clock = frozen_clock();
    let serves = Serves {
        replay_pause: THROTTLED,
        replays: replays.clone(),
        refuses_replays,
        ..Serves::default()
    };
    let h = Runtime::build(
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
    .spawn();
    call_user(
        &h.state.invoker,
        "settings.set",
        json!({"key": "market.recordWatchlists", "value": false}),
    )
    .await;
    h
}

async fn connect(inv: &Invoker) {
    call_user(
        inv,
        "connections.add_rithmic",
        json!({"system": SYSTEM, "gateway": "Chicago Area", "user": "alice", "password": GOOD_PASSWORD}),
    )
    .await;
}

async fn settled_footprint(inv: &Invoker) -> Value {
    let began = Instant::now();
    loop {
        match footprint_if_connected(inv).await {
            Some(fp) if fp["filling"] == false => return fp,
            Some(_) | None => {}
        }
        assert!(
            began.elapsed() < SETTLED_WITHIN,
            "not connected or still filling after {SETTLED_WITHIN:?}"
        );
        tokio::time::sleep(ASK_AGAIN).await;
    }
}

async fn footprint_if_connected(inv: &Invoker) -> Option<Value> {
    match try_call_code(inv, &Origin::User, "market.get_footprint", footprint_ask()).await {
        Ok(fp) => Some(fp),
        Err(ToolErrorCode::Unavailable) => None,
        Err(code) => panic!("market.get_footprint: {code:?}"),
    }
}

fn footprint_ask() -> Value {
    json!({"instrument": "NQ", "tf": "1m", "limit": 200})
}

async fn footprint(inv: &Invoker) -> Value {
    call_user(inv, "market.get_footprint", footprint_ask()).await
}

fn bars(fp: &Value) -> usize {
    fp["bars"].as_array().unwrap().len()
}

fn loading(fp: &Value) -> bool {
    let loaded = &fp["loaded"];
    fp["filling"] == true && loaded["held"].as_u64() < loaded["sessions"].as_u64()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_nq_footprint_shows_its_first_bars_within_seconds_and_a_second_open_asks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let secrets = Secrets::in_memory();
    let replays = ReplayLog::default();
    let h = start(&data, &secrets, &replays).await;
    let inv = h.state.invoker.clone();
    call_user(
        &inv,
        "connections.add_rithmic",
        json!({"system": SYSTEM, "gateway": "Chicago Area", "user": "alice", "password": GOOD_PASSWORD}),
    )
    .await;

    let began = Instant::now();
    let mut first_bars = None;
    let mut answers = Vec::new();
    let settled = loop {
        let fp = footprint(&inv).await;
        if first_bars.is_none() && bars(&fp) > 0 {
            first_bars = Some(began.elapsed());
        }
        if fp["filling"] == false {
            break fp;
        }
        answers.push(fp);
        assert!(
            began.elapsed() < SETTLED_WITHIN,
            "still filling after {SETTLED_WITHIN:?}"
        );
        tokio::time::sleep(ASK_AGAIN).await;
    };
    let first_bars = first_bars.expect("the footprint drew bars");
    eprintln!(
        "first bars after {first_bars:?}, settled after {:?}, {} answers while loading, {} history requests",
        began.elapsed(),
        answers.len(),
        replays.requests()
    );
    assert!(
        first_bars < FIRST_BARS_WITHIN,
        "first bars after {first_bars:?}"
    );
    assert!(
        answers.iter().all(loading),
        "every answer before it settled says it is loading: {:?}",
        answers
            .iter()
            .map(|a| (&a["filling"], &a["loaded"]))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        settled["loaded"],
        json!({"sessions": 1, "held": 1, "refused": false}),
        "200 one-minute bars lie in today's session"
    );
    assert_eq!(bars(&settled), 200);
    let session_open = Timestamp::parse(TODAY_OPENED).unwrap().0;
    assert!(
        replays
            .asked()
            .iter()
            .all(|(_, from, _)| *from >= session_open),
        "nothing older than today's session was replayed: {:?}",
        replays.asked()
    );

    h.state.market.hub().saved_trades().unwrap().settle();
    let asked = replays.requests();
    let again = footprint(&inv).await;
    assert_eq!(again["filling"], false);
    assert_eq!(bars(&again), 200);
    assert_eq!(
        replays.requests(),
        asked,
        "a second open asks nothing: ticks {:?} bars {:?}",
        replays.asked(),
        replays.asked_bars()
    );

    let pulled = call_user(&inv, "market.saved_trades", json!({})).await["pulled"].clone();
    assert_eq!(pulled[0]["source"], rithmic::CONNECTION_ID);
    assert_eq!(pulled[0]["today"]["requests"], asked);
    assert!(pulled[0]["today"]["bytes"].as_u64().unwrap() > 0);

    let (ticks_asked, bars_before_restart) = (replays.asked().len(), replays.asked_bars().len());
    h.shutdown().await.unwrap();
    let h = start(&data, &secrets, &replays).await;
    let inv = h.state.invoker.clone();
    let reopened = loop {
        let fp = footprint(&inv).await;
        if fp["filling"] == false && bars(&fp) == 200 {
            break fp;
        }
        assert!(began.elapsed() < 2 * SETTLED_WITHIN);
        tokio::time::sleep(ASK_AGAIN).await;
    };
    assert_eq!(reopened["loaded"], settled["loaded"]);
    assert_eq!(
        replays.asked().len(),
        ticks_asked,
        "after a restart the saved prints are not replayed again"
    );
    let unsettled = Timestamp::parse(UNSETTLED_FROM).unwrap().0;
    let bars_asked = replays.asked_bars();
    assert!(
        bars_asked[bars_before_restart..]
            .iter()
            .all(|(_, _, from, _)| *from >= unsettled),
        "after a restart only the minutes still forming are asked: {:?}",
        &bars_asked[bars_before_restart..]
    );
    let pulled = call_user(&inv, "market.saved_trades", json!({})).await["pulled"].clone();
    assert_eq!(
        pulled[0]["total"]["requests"],
        replays.requests(),
        "the count outlives the restart"
    );
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refused_history_says_so_and_is_not_asked_again_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let secrets = Secrets::in_memory();
    let replays = ReplayLog::default();
    let h = start_with(&data, &secrets, &replays, true).await;
    let inv = h.state.invoker.clone();
    connect(&inv).await;
    let fp = settled_footprint(&inv).await;
    assert_eq!(
        fp["loaded"],
        json!({"sessions": 1, "held": 0, "refused": true}),
        "{}",
        fp["loaded"]
    );
    assert_eq!(bars(&fp), 0);
    let refused = replays.asked().len();
    assert!(refused > 0);
    h.shutdown().await.unwrap();

    let h = start_with(&data, &secrets, &replays, true).await;
    let inv = h.state.invoker.clone();
    let fp = settled_footprint(&inv).await;
    assert_eq!(fp["loaded"]["refused"], true);
    assert_eq!(
        replays.asked().len(),
        refused,
        "a span refused this session is not asked again after a restart: {:?}",
        &replays.asked()[refused..]
    );
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_seconds_chart_is_built_from_stored_one_second_bars() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let secrets = Secrets::in_memory();
    let replays = ReplayLog::default();
    let h = start(&data, &secrets, &replays).await;
    let inv = h.state.invoker.clone();
    connect(&inv).await;
    let ask = json!({"instrument": "NQ", "tf": "15s", "limit": 300});
    let first = call_user(&inv, "market.get_candles", ask.clone()).await;
    let n = first["bars"].as_array().unwrap().len();
    assert!(n > 250, "{n} bars");
    let asked = replays.asked_bars();
    assert!(
        asked
            .iter()
            .all(|(_, tf, _, _)| *tf == tessera_core::Timeframe::S1),
        "seconds charts ask for one-second bars: {asked:?}"
    );
    let again = call_user(&inv, "market.get_candles", ask).await;
    assert_eq!(again["bars"], first["bars"]);
    let unsettled = Timestamp::parse(UNSETTLED_FROM).unwrap().0;
    let later = &replays.asked_bars()[asked.len()..];
    assert!(
        later
            .iter()
            .all(|(_, tf, from, _)| *tf == tessera_core::Timeframe::S1 && *from >= unsettled),
        "the second read is served from the stored one-second bars and asks only the forming minutes: {later:?}"
    );
    h.shutdown().await.unwrap();
}
