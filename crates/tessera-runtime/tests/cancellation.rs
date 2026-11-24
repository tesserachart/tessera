use std::sync::Arc;
use std::task::Poll;

use serde_json::json;
use tessera_core::settle::settle;
use tessera_core::{Origin, Timeframe};
use tessera_protocol::topics::names;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;

async fn runtime() -> Runtime {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap()
}

#[tokio::test]
async fn a_chart_change_stopped_during_its_write_is_still_stored_and_published() {
    let rt = runtime().await;
    let state = Arc::clone(rt.state());
    let layouts = Arc::clone(&state.layouts);
    let before = layouts.get(None).unwrap();
    let seq = state.bus.last_seq(names::LAYOUT);

    let mut change =
        Box::pin(layouts.set_timeframe(None, Some("chart-1"), Timeframe::M30, None, &Origin::User));
    loop {
        if let Poll::Ready(r) = futures::poll!(&mut change) {
            panic!("finished within one poll, without waiting for its write: {r:?}");
        }
        if layouts.get(None).unwrap().revision > before.revision {
            break;
        }
        tokio::task::yield_now().await;
    }
    drop(change);

    settle(
        "the layout event of a change stopped during its write goes out",
        || state.bus.last_seq(names::LAYOUT),
        |&published| published > seq,
    )
    .await;
    let after = layouts.get(None).unwrap();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.charts["chart-1"].timeframe, Timeframe::M30);
    let stored = state.store.layouts().get(&after.id).unwrap().unwrap();
    assert_eq!(stored.revision, after.revision);
    assert_eq!(stored.charts["chart-1"].timeframe, Timeframe::M30);
}

#[tokio::test]
async fn a_setting_change_stopped_during_its_write_is_applied_whole() {
    let rt = runtime().await;
    let state = Arc::clone(rt.state());
    let settings = Arc::clone(&state.settings);
    assert_eq!(settings.int("appearance.density"), 24);

    let mut change = Box::pin(settings.set("appearance.density", json!(28), &Origin::User));
    assert!(futures::poll!(&mut change).is_pending());
    drop(change);

    let store = state.store.clone();
    settle(
        "the stopped write reaches the database",
        || store.settings().get("appearance.density").unwrap(),
        |stored| *stored == Some(json!(28)),
    )
    .await;
    settle(
        "the stored value is the one the runtime uses",
        || settings.int("appearance.density"),
        |&applied| applied == 28,
    )
    .await;
}
