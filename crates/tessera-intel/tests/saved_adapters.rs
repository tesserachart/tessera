use std::sync::Arc;

use serde_json::json;
use tessera_core::Timestamp;
use tessera_core::clock::ManualClock;
use tessera_intel::IntelRouter;
use tessera_intel::history::LevelHistory;
use tessera_intel::history::file::Roots;
use tessera_intel::history::io::{ImportAdapter, ImportLevelHistoryInput};
use tessera_store::Store;

#[tokio::test]
async fn an_adapter_saved_for_an_earlier_engine_says_it_needs_rewriting() {
    let store = Store::open_in_memory().unwrap();
    let now = Timestamp::parse("2026-10-24T08:00:00-04:00").unwrap();
    store
        .documents("intel.level_adapter")
        .put(
            "zeta-gamma",
            None,
            &json!({"kind": "python", "vendor": "Zeta Gamma", "code": "def records(data, params):\n    return {}\n"}),
            now,
        )
        .unwrap();
    let history = LevelHistory::new(
        store,
        Arc::new(ManualClock::new(now)),
        Roots::new(None),
        IntelRouter::new(),
    );

    let listed = history.adapters().unwrap();
    let saved = listed.iter().find(|a| a.name == "zeta-gamma").unwrap();
    assert_eq!(
        (saved.kind.as_str(), saved.vendor.as_str()),
        ("script", "Zeta Gamma")
    );

    let input: ImportLevelHistoryInput = serde_json::from_value(json!({
        "text": "{}",
        "adapter": {"kind": "saved", "vendor": "Zeta Gamma"}
    }))
    .unwrap();
    assert!(matches!(input.adapter, ImportAdapter::Saved { .. }));
    let e = history.import(&input, "user").await.unwrap_err();
    assert!(
        e.contains("rewrite it in JavaScript as records(text, file)"),
        "{e}"
    );
}
