use std::sync::Arc;

use serde_json::json;
use tessera_core::Timestamp;
use tessera_core::clock::ManualClock;
use tessera_market::MarketRouter;
use tessera_research::Studies;
use tessera_research::experiment::ExperimentState;
use tessera_research::study::Strategy;
use tessera_store::Store;

fn stored(id: &str, state: &str, strategy: serde_json::Value) -> serde_json::Value {
    json!({
        "id": id,
        "name": id,
        "family": format!("{id}/NQ"),
        "hypothesis": "h",
        "data": {"instrument": "NQZ6.CME", "tf": "5m"},
        "strategy": strategy,
        "state": state,
        "generation": 3,
        "manifestHash": if state == "draft" { serde_json::Value::Null } else { json!("ab12") },
        "frozenAt": if state == "draft" { serde_json::Value::Null } else { json!(1) },
        "lastVerdict": if state == "recorded" { json!("lead") } else { serde_json::Value::Null },
    })
}

#[test]
fn a_study_written_for_an_earlier_engine_opens_its_next_generation_on_this_one() {
    let store = Store::open_in_memory().unwrap();
    let now = Timestamp::parse("2026-10-24T08:00:00-04:00").unwrap();
    let docs = store.documents("research.study");
    let python = json!({"kind": "python", "code": "def targets(bars, inputs):\n    return bars['close'] * 0  # */\n", "freeParameters": 2});
    docs.put(
        "recorded",
        None,
        &stored("recorded", "recorded", python.clone()),
        now,
    )
    .unwrap();
    docs.put("draft", None, &stored("draft", "draft", python), now)
        .unwrap();
    let rules = stored(
        "rules",
        "frozen",
        json!({"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 21, "sides": "both"}}),
    );
    docs.put("rules", None, &rules, now).unwrap();

    let studies = Studies::new(
        store.clone(),
        MarketRouter::new(),
        Arc::new(ManualClock::new(now)),
    );

    let recorded = studies.get("recorded").unwrap();
    assert_eq!(recorded.generation, 4, "a frozen study is never edited");
    assert_eq!(recorded.state, ExperimentState::Draft);
    assert_eq!(recorded.manifest_hash, None);
    assert_eq!(recorded.last_verdict, None);
    let Strategy::Script {
        code,
        free_parameters,
        ..
    } = &recorded.strategy
    else {
        panic!("{:?}", recorded.strategy);
    };
    assert_eq!(*free_parameters, 2);
    assert!(code.contains("return bars['close'] * 0  # * /"), "{code}");
    assert!(tessera_script::describe_strategy(code).is_ok());

    let draft = studies.get("draft").unwrap();
    assert_eq!((draft.generation, draft.state), (3, ExperimentState::Draft));

    let kept = studies.get("rules").unwrap();
    assert_eq!(kept.state, ExperimentState::Frozen);
    assert_eq!(kept.manifest_hash.as_deref(), Some("ab12"));
    assert_eq!(
        serde_json::to_value(&kept).unwrap()["strategy"],
        rules["strategy"]
    );
}
