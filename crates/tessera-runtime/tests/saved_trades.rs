use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::settle::settle_async;
use tessera_core::{SharedClock, Timestamp};
use tessera_market::{MockConfig, MockMarket};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::{BUSY_AT, Fakes, ShiftedClock};

mod common;

use common::call_user;

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read(&p).unwrap(),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_cli_export_writes_the_same_files_as_the_tool() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let clock: SharedClock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap(),
    ));
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(data.clone()),
            clock: Arc::clone(&clock),
            ..RuntimeConfig::default()
        },
        vec![],
    )
    .await
    .unwrap();
    let state = Arc::clone(rt.state());
    state
        .connections
        .add_market(Arc::new(MockMarket::new(MockConfig::new(clock))))
        .unwrap();
    let inv = Arc::clone(&state.invoker);
    let range =
        json!({"instrument": "NQ", "from": "2026-09-23", "to": "2026-09-25", "scope": "rth"});
    let started = call_user(&inv, "market.pull_trades", range.clone()).await;
    assert_eq!(started["progress"]["days"], 3);
    let pulling = &*inv;
    let pull = settle_async(
        "the pull finishes",
        move || async move {
            call_user(pulling, "market.list_pulls", json!({})).await["pulls"][0].clone()
        },
        |pull| pull["state"] == "done",
    )
    .await;
    assert_eq!(pull["progress"]["saved"], 3);
    assert_eq!(
        pull["days"],
        json!([]),
        "a bare list leaves out the days already answered"
    );
    let every = call_user(
        &inv,
        "market.list_pulls",
        json!({"instrument": "nq", "days": "all"}),
    )
    .await;
    assert_eq!(every["pulls"][0]["days"].as_array().unwrap().len(), 3);
    for other in [json!({"instrument": "ES"}), json!({"state": "running"})] {
        assert_eq!(
            call_user(&inv, "market.list_pulls", other.clone()).await["pulls"],
            json!([]),
            "{other}"
        );
    }

    let saved = call_user(&inv, "market.saved_trades", json!({})).await;
    assert_eq!(saved["contracts"][0]["instrument"], "NQZ6.CME");
    assert_eq!(saved["contracts"][0]["days"], 3);
    assert!(saved["diskBytes"].as_u64().unwrap() > 0);
    let info = call_user(&inv, "runtime.data_info", json!({})).await;
    assert!(
        info["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["what"] == "ticks"),
        "the data facts list the tick store"
    );

    let by_tool = dir.path().join("tool");
    let mut ask = range.clone();
    ask["dir"] = json!(by_tool.display().to_string());
    let exported = call_user(&inv, "market.export_trades", ask).await;
    assert_eq!(exported["files"].as_array().unwrap().len(), 3);

    let by_cli = dir.path().join("cli");
    let run = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["ticks", "export", "--data-dir"])
        .arg(&data)
        .args([
            "--instrument",
            "NQ",
            "--from",
            "2026-09-23",
            "--to",
            "2026-09-25",
            "--rth",
            "--out",
        ])
        .arg(&by_cli)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let said: Value = serde_json::from_slice(&run.stdout).unwrap();
    assert_eq!(said["files"].as_array().unwrap().len(), 3);
    let (tool, cli) = (files(&by_tool), files(&by_cli));
    assert_eq!(
        tool.keys().collect::<Vec<_>>(),
        [
            "NQ-2026-09-23.csv",
            "NQ-2026-09-24.csv",
            "NQ-2026-09-25.csv"
        ]
    );
    assert!(
        tool == cli,
        "the CLI writes byte for byte what the tool writes"
    );

    call_user(
        &inv,
        "settings.set",
        json!({"key": "market.savedTradeSessions", "value": 2}),
    )
    .await;
    let kept = call_user(&inv, "market.saved_trades", json!({})).await;
    assert_eq!(
        kept["contracts"][0]["days"], 3,
        "a pull's days outlive the limit"
    );
    let id = started["id"].clone();
    call_user(&inv, "market.release_pull", json!({"id": id})).await;
    let released = call_user(&inv, "market.saved_trades", json!({})).await;
    assert_eq!(
        released["contracts"][0]["days"], 2,
        "released, the oldest day is pruned before the release returns"
    );
    assert!(
        released["diskBytes"].as_u64().unwrap() < kept["diskBytes"].as_u64().unwrap(),
        "and its room is given back"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_watchlists_record_to_disk_while_no_chart_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(dir.path().join("data")),
            clock: Arc::new(ShiftedClock::starting_at(
                Timestamp::parse(BUSY_AT).unwrap(),
            )),
            ..RuntimeConfig::default()
        },
        vec![
            Fakes {
                keeps_trade_history: false,
                gamma: false,
                ..Fakes::busy()
            }
            .module(),
        ],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let lists = call_user(&inv, "watchlists.list", json!({})).await;
    assert!(
        lists["lists"][0]["symbols"]
            .as_array()
            .unwrap()
            .contains(&json!("NQ"))
    );
    let recording = &*inv;
    let nq = settle_async(
        "the watchlist's NQ prints are saved",
        move || async move {
            let saved = call_user(recording, "market.saved_trades", json!({})).await;
            saved["contracts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["instrument"].as_str().unwrap().starts_with("NQ"))
                .cloned()
                .unwrap_or(Value::Null)
        },
        |nq| !nq.is_null(),
    )
    .await;
    assert!(nq["prints"].as_u64().unwrap_or(0) > 0, "{nq}");
}
