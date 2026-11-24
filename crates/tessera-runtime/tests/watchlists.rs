use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::ids::SessionId;
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::settings::SettingsService;
use tessera_runtime::state::SharedState;
use tessera_runtime::watchlists::migrate_preferences_watchlist;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_store::Store;
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

mod common;

const KEY: &str = "markets.watchlists";

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-watchlists"),
        provider: "codex".into(),
    }
}

async fn runtime() -> (Runtime, SharedState, Arc<Invoker>) {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    inv.set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));
    (rt, state, inv)
}

async fn call(inv: &Invoker, name: &str, input: Value) -> Value {
    common::call(inv, &agent(), name, input).await
}

async fn refused(inv: &Invoker, name: &str, input: Value) -> (ToolErrorCode, String) {
    let r = inv
        .invoke(InvokeRequest::new(name, input.clone(), agent()))
        .await;
    assert!(!r.ok, "{name} {input} should be refused: {r:?}");
    let e = r.error.unwrap();
    (e.code, e.message)
}

fn lists(v: &Value) -> Vec<(String, String, Vec<String>)> {
    v["lists"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["id"].as_str().unwrap().to_owned(),
                l["name"].as_str().unwrap().to_owned(),
                l["symbols"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_owned())
                    .collect(),
            )
        })
        .collect()
}

fn ids(v: &Value) -> Vec<String> {
    lists(v).into_iter().map(|(id, _, _)| id).collect()
}

fn symbols(v: &Value) -> Vec<String> {
    v["list"]["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_agent_makes_renames_fills_reorders_and_deletes_watchlists() {
    let (_rt, state, inv) = runtime().await;
    let all = call(&inv, "watchlists.list", json!({})).await;
    assert_eq!(ids(&all), ["main"]);
    assert_eq!(lists(&all)[0].2[..3], ["NQ", "ES", "MNQ"]);

    let made = call(
        &inv,
        "watchlists.create",
        json!({"name": " Futures ", "symbols": ["NQ", " ES ", "", "NQ", "CL"]}),
    )
    .await;
    assert_eq!(made["list"]["id"], "futures");
    assert_eq!(made["list"]["name"], "Futures");
    assert_eq!(symbols(&made), ["NQ", "ES", "CL"]);
    assert_eq!(
        ids(&state.settings.value(KEY).unwrap()),
        ["main", "futures"]
    );
    let (code, msg) = refused(&inv, "watchlists.create", json!({"name": "FUTURES"})).await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
    assert!(msg.contains("already named Futures"), "{msg}");
    let second = call(&inv, "watchlists.create", json!({"name": "Futures!"})).await;
    assert_eq!(second["list"]["id"], "futures-2");
    assert_eq!(second["list"]["symbols"], json!([]));
    let third = call(&inv, "watchlists.create", json!({"name": "§§"})).await;
    assert_eq!(third["list"]["id"], "list");
    for bad in [json!({"name": ""}), json!({"name": "x".repeat(41)})] {
        let (code, _) = refused(&inv, "watchlists.create", bad.clone()).await;
        assert_eq!(code, ToolErrorCode::InvalidInput, "{bad}");
    }

    let renamed = call(
        &inv,
        "watchlists.rename",
        json!({"id": "futures-2", "name": "Energy"}),
    )
    .await;
    assert_eq!(renamed["list"]["id"], "futures-2");
    assert_eq!(renamed["list"]["name"], "Energy");
    call(
        &inv,
        "watchlists.rename",
        json!({"id": "futures-2", "name": "ENERGY"}),
    )
    .await;
    let (code, _) = refused(
        &inv,
        "watchlists.rename",
        json!({"id": "futures-2", "name": "futures"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::InvalidInput);

    let added = call(
        &inv,
        "watchlists.add",
        json!({"id": "futures", "instruments": ["GC", "NQ", "RTY"]}),
    )
    .await;
    assert_eq!(symbols(&added), ["NQ", "ES", "CL", "GC", "RTY"]);
    let added = call(
        &inv,
        "watchlists.add",
        json!({"id": "futures", "instruments": ["NQZ6.CME", "YM"], "at": 1}),
    )
    .await;
    assert_eq!(
        symbols(&added),
        ["NQ", "NQZ6.CME", "YM", "ES", "CL", "GC", "RTY"]
    );
    let added = call(
        &inv,
        "watchlists.add",
        json!({"id": "futures", "instruments": ["ZB"], "at": 99}),
    )
    .await;
    assert_eq!(symbols(&added).last().unwrap(), "ZB");
    let first = call(&inv, "watchlists.add", json!({"instruments": ["MSFT"]})).await;
    assert_eq!(first["list"]["id"], "main");
    assert_eq!(symbols(&first).last().unwrap(), "MSFT");

    let removed = call(
        &inv,
        "watchlists.remove",
        json!({"id": "futures", "instruments": ["YM", "NOPE", "ZB"]}),
    )
    .await;
    assert_eq!(
        symbols(&removed),
        ["NQ", "NQZ6.CME", "ES", "CL", "GC", "RTY"]
    );
    let (code, msg) = refused(
        &inv,
        "watchlists.remove",
        json!({"id": "futures", "instruments": ["YM"]}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::NotFound, "{msg}");

    let moved = call(
        &inv,
        "watchlists.move",
        json!({"id": "futures", "instrument": "GC", "to": 0}),
    )
    .await;
    let futures = lists(&moved)
        .into_iter()
        .find(|l| l.0 == "futures")
        .unwrap();
    assert_eq!(futures.2, ["GC", "NQ", "NQZ6.CME", "ES", "CL", "RTY"]);
    let moved = call(
        &inv,
        "watchlists.move",
        json!({"id": "futures", "instrument": "GC", "to": 50}),
    )
    .await;
    let futures = lists(&moved)
        .into_iter()
        .find(|l| l.0 == "futures")
        .unwrap();
    assert_eq!(futures.2.last().unwrap(), "GC");
    let moved = call(&inv, "watchlists.move", json!({"id": "list", "to": 0})).await;
    assert_eq!(ids(&moved), ["list", "main", "futures", "futures-2"]);
    let moved = call(&inv, "watchlists.move", json!({"id": "list", "to": 9})).await;
    assert_eq!(ids(&moved), ["main", "futures", "futures-2", "list"]);
    let (code, _) = refused(
        &inv,
        "watchlists.move",
        json!({"id": "futures", "instrument": "AAPL", "to": 0}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::NotFound);

    for (tool, input) in [
        ("watchlists.rename", json!({"id": "nope", "name": "X"})),
        ("watchlists.delete", json!({"id": "nope"})),
        (
            "watchlists.add",
            json!({"id": "nope", "instruments": ["NQ"]}),
        ),
        (
            "watchlists.remove",
            json!({"id": "nope", "instruments": ["NQ"]}),
        ),
        ("watchlists.move", json!({"id": "nope", "to": 0})),
    ] {
        let (code, msg) = refused(&inv, tool, input.clone()).await;
        assert_eq!(code, ToolErrorCode::NotFound, "{tool}");
        assert!(msg.contains("main, futures"), "{tool}: {msg}");
    }

    for id in ["list", "futures-2", "futures"] {
        call(&inv, "watchlists.delete", json!({"id": id})).await;
    }
    let left = call(&inv, "watchlists.delete", json!({"id": "main"})).await;
    assert_eq!(left["lists"], json!([]));
    let (code, msg) = refused(&inv, "watchlists.add", json!({"instruments": ["NQ"]})).await;
    assert_eq!(code, ToolErrorCode::NotFound);
    assert!(msg.contains("watchlists.create"), "{msg}");
    assert_eq!(state.settings.value(KEY).unwrap(), json!({"lists": []}));
}

#[tokio::test]
async fn a_raw_value_with_two_lists_of_one_id_is_refused() {
    let (_rt, _state, inv) = runtime().await;
    let (code, msg) = refused(
        &inv,
        "settings.set",
        json!({"key": KEY, "value": {"lists": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]}}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
    assert!(msg.contains("two watchlists"), "{msg}");
}

#[tokio::test]
async fn an_older_builds_watchlist_becomes_the_first_watchlist_once() {
    let store = Store::open_in_memory().unwrap();
    let clock: SharedClock = Arc::new(ManualClock::new(Timestamp(1)));
    let s = SettingsService::load(store.clone(), clock.clone()).unwrap();
    s.set(
        "ui.preferences",
        json!({"watchlist": ["NQZ6.CME", "QQQ", " QQQ", "", "BTCUSD"], "marketList": "futures"}),
        &Origin::User,
    )
    .await
    .unwrap();
    migrate_preferences_watchlist(&s).await.unwrap();
    let moved = json!({"lists": [{"id": "main", "name": "Watchlist", "symbols": ["NQZ6.CME", "QQQ", "BTCUSD"]}]});
    assert_eq!(s.stored(KEY), Some(moved.clone()));
    assert!(s.stored("ui.preferences").unwrap()["watchlist"].is_array());
    let again = SettingsService::load(store, clock).unwrap();
    migrate_preferences_watchlist(&again).await.unwrap();
    assert_eq!(again.stored(KEY), Some(moved));

    let s = SettingsService::load(
        Store::open_in_memory().unwrap(),
        Arc::new(ManualClock::new(Timestamp(1))),
    )
    .unwrap();
    let mine = json!({"lists": [{"id": "x", "name": "X", "symbols": []}]});
    s.set(KEY, mine.clone(), &Origin::User).await.unwrap();
    s.set(
        "ui.preferences",
        json!({"watchlist": ["NQ"]}),
        &Origin::User,
    )
    .await
    .unwrap();
    migrate_preferences_watchlist(&s).await.unwrap();
    assert_eq!(s.stored(KEY), Some(mine));

    let s = SettingsService::load(
        Store::open_in_memory().unwrap(),
        Arc::new(ManualClock::new(Timestamp(1))),
    )
    .unwrap();
    migrate_preferences_watchlist(&s).await.unwrap();
    assert_eq!(s.stored(KEY), None);
    assert_eq!(s.value(KEY).unwrap()["lists"][0]["id"], "main");
}
