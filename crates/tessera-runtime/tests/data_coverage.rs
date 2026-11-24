use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::settle::settle_async;
use tessera_core::{SharedClock, Timestamp};
use tessera_market::{MockConfig, MockMarket};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_tools::Invoker;

mod common;

use common::call_user;

async fn pulled(inv: &Invoker) {
    settle_async(
        "the pull finishes",
        move || async move { call_user(inv, "market.list_pulls", json!({})).await["pulls"][0].clone() },
        |pull| pull["state"] == "done",
    )
    .await;
}

async fn followed(inv: &Invoker, card: &Value) -> Value {
    settle_async(
        "the card follows its download to the end",
        || call_user(inv, "cards.get", json!({"cardId": card["id"]})),
        |followed| followed["body"]["download"]["state"] == "done",
    )
    .await
}

async fn runtime(dir: &std::path::Path) -> (Runtime, Arc<Invoker>) {
    let clock: SharedClock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap(),
    ));
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(dir.join("data")),
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
    (rt, inv)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_days_download_on_their_own_and_the_card_shows_only_their_progress() {
    let dir = tempfile::tempdir().unwrap();
    let (_rt, inv) = runtime(dir.path()).await;
    let out = call_user(
        &inv,
        "market.data_coverage",
        json!({"instrument": "NQ", "from": "2026-09-22", "to": "2026-09-25"}),
    )
    .await;
    assert_eq!(out["printsSaved"], 0);
    assert_eq!(out["downloading"], true, "{out}");
    let card = &out["card"];
    let download = &card["body"]["download"];
    assert_eq!(download["state"], "running");
    assert_eq!(download["auto"], true);
    assert_eq!(download["fetching"], 4);
    let labels: Vec<&str> = card["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["label"].as_str().unwrap())
        .collect();
    assert!(
        labels.iter().all(|l| !l.starts_with("Download")),
        "no Download button: {labels:?}"
    );

    let done = followed(&inv, card).await;
    let d = &done["body"]["download"];
    assert_eq!(d["state"], "done", "{done}");
    assert_eq!(d["fetched"], 4);
    assert!(
        done["body"]["days"]
            .as_array()
            .unwrap()
            .iter()
            .all(|day| day["prints"] == "saved" && day["note"].is_null()),
        "{done}"
    );
    let again = call_user(
        &inv,
        "market.data_coverage",
        json!({"instrument": "NQ", "from": "2026-09-22", "to": "2026-09-25"}),
    )
    .await;
    assert_eq!(again["printsSaved"], 4, "the store agrees with the card");
    assert_eq!(again["printsMissing"], json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_day_older_than_the_connection_keeps_says_so_and_offers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (_rt, inv) = runtime(dir.path()).await;
    let out = call_user(
        &inv,
        "market.data_coverage",
        json!({"instrument": "NQZ6", "from": "2026-08-03", "to": "2026-08-04"}),
    )
    .await;
    assert_eq!(out["downloading"], false, "{out}");
    let card = &out["card"];
    for day in card["body"]["days"].as_array().unwrap() {
        assert_eq!(day["outOfReach"], true, "{day}");
        assert!(
            day["note"].as_str().unwrap().starts_with("older than "),
            "{day}"
        );
    }
    assert_eq!(
        card["actions"].as_array().unwrap().len(),
        1,
        "only Check again: {card}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_market_s_saved_and_missing_days_come_back_as_a_card_kept_by_the_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let (_rt, inv) = runtime(dir.path()).await;
    call_user(
        &inv,
        "settings.set",
        json!({"key": "market.autoDownload", "value": false}),
    )
    .await;
    call_user(
        &inv,
        "market.pull_trades",
        json!({"instrument": "NQ", "from": "2026-09-24", "to": "2026-09-25", "scope": "rth"}),
    )
    .await;
    pulled(&inv).await;

    let out = call_user(
        &inv,
        "market.data_coverage",
        json!({"instrument": "NQ", "from": "2026-09-22", "to": "2026-09-25"}),
    )
    .await;
    assert_eq!(out["days"], 4);
    assert_eq!(out["printsSaved"], 2);
    assert_eq!(out["printsMissing"], json!(["2026-09-22", "2026-09-23"]));
    let card = &out["card"];
    assert_eq!(card["body"]["kind"], "data_coverage");
    assert_eq!(card["body"]["symbol"], "NQ");
    assert_eq!(card["body"]["scope"], "rth");
    let days = card["body"]["days"].as_array().unwrap();
    assert_eq!(days.len(), 4);
    assert_eq!(days[2]["date"], "2026-09-24");
    assert_eq!(days[2]["prints"], "saved");
    assert_eq!(days[0]["prints"], "missing");
    assert!(days[0]["contract"].as_str().unwrap().starts_with("NQ"));
    let download = &card["actions"][0];
    assert_eq!(download["label"], "Download 2 days");
    assert_eq!(download["tool"], "market.pull_trades");
    assert_eq!(download["primary"], true);
    assert_eq!(card["actions"][1]["tool"], "market.data_coverage");

    let kept = call_user(&inv, "cards.get", json!({"cardId": card["id"]})).await;
    assert_eq!(&kept, card);

    call_user(
        &inv,
        download["tool"].as_str().unwrap(),
        download["input"].clone(),
    )
    .await;
    let followed = followed(&inv, card).await;
    let d = &followed["body"]["download"];
    assert_eq!(d["state"], "done", "{followed}");
    assert_eq!(d["days"], 4);
    assert_eq!(d["done"], 4);
    assert_eq!(d["fetching"], 2);
    assert_eq!(d["fetched"], 2);
    assert_eq!(d["auto"], false);
    assert!(
        followed["body"]["days"]
            .as_array()
            .unwrap()
            .iter()
            .all(|day| day["prints"] == "saved"),
        "{followed}"
    );
    assert_eq!(
        followed["actions"].as_array().unwrap().len(),
        1,
        "nothing left to download"
    );
}
