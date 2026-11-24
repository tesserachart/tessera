use std::sync::Arc;

use serde_json::json;
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, SessionPolicy};

mod common;

use common::call;

#[tokio::test]
async fn a_study_is_registered_frozen_and_run_by_the_analyst() {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(30).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("R1"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    let study = call(
        &inv,
        &agent,
        "research.save_study",
        json!({
            "name": "NQ 5m EMA 9/21",
            "hypothesis": "Following the 9 EMA against the 21 EMA on NQ 5m bars makes money after costs.",
            "data": {"instrument": "NQ", "tf": "5m"},
            "strategy": {"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 21}},
            "gates": {"minTrades": 5},
            "placeboRuns": 20
        }),
    )
    .await;
    let id = study["id"].as_str().unwrap().to_owned();
    assert_eq!(study["state"], "draft");
    assert!(
        study["family"]
            .as_str()
            .unwrap()
            .starts_with("ema-cross/NQ")
    );

    let draft_run = call(&inv, &agent, "research.run_study", json!({"id": id})).await;
    assert_eq!(draft_run["exploratory"], true);
    assert_eq!(draft_run["cases"].as_array().unwrap().len(), 2);
    assert!(draft_run["sessions"].as_u64().unwrap() >= 4);
    assert_eq!(draft_run["budget"]["trials"], 1);

    let frozen = call(&inv, &agent, "research.freeze_study", json!({"id": id})).await;
    assert_eq!(frozen["state"], "frozen");
    assert!(frozen["manifestHash"].is_string());

    let run = call(&inv, &Origin::User, "research.run_study", json!({"id": id})).await;
    assert_eq!(run["exploratory"], false);
    assert_eq!(run["budget"]["trials"], 2, "every run counts");
    assert!(["qualified", "lead", "rejected"].contains(&run["verdict"].as_str().unwrap()));
    let full = call(
        &inv,
        &agent,
        "research.get_run",
        json!({"runId": run["runId"]}),
    )
    .await;
    assert_eq!(full["evaluation"]["cases"][0]["case"]["name"], "base");
    assert!(
        full["evaluation"]["cases"][0]["equity"]
            .as_array()
            .unwrap()
            .len()
            > 50
    );

    let changed = call(
        &inv,
        &agent,
        "research.save_study",
        json!({
            "id": id,
            "name": "NQ 5m EMA 9/21",
            "hypothesis": "Following the 9 EMA against the 21 EMA on NQ 5m bars makes money after costs.",
            "data": {"instrument": "NQ", "tf": "5m"},
            "strategy": {"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 30}},
            "gates": {"minTrades": 5}
        }),
    )
    .await;
    assert_eq!(changed["generation"], 2);
    assert_eq!(changed["state"], "draft");

    let detail = call(&inv, &agent, "research.get_study", json!({"id": id})).await;
    assert_eq!(detail["runs"].as_array().unwrap().len(), 2);
    let list = call(&inv, &Origin::User, "research.list_studies", json!({})).await;
    assert_eq!(list["studies"].as_array().unwrap().len(), 1);
    assert_eq!(list["budgets"][0]["trials"], 2);

    let script = call(
        &inv,
        &agent,
        "research.save_study",
        json!({
            "name": "Long above the session's first close",
            "hypothesis": "h",
            "data": {"instrument": "NQ", "tf": "5m"},
            "strategy": {"kind": "script", "code": ABOVE_THE_FIRST_CLOSE},
            "gates": {"minTrades": 5},
            "placeboRuns": 0
        }),
    )
    .await;
    assert!(script["family"].as_str().unwrap().starts_with("script/NQ"));
    let out = call(
        &inv,
        &Origin::User,
        "research.run_study",
        json!({"id": script["id"]}),
    )
    .await;
    assert!(
        out["cases"][0]["later"]["trades"].as_u64().unwrap() > 0,
        "{out}"
    );

    let broken = call(
        &inv,
        &agent,
        "research.save_study",
        json!({
            "name": "Broken",
            "hypothesis": "h",
            "data": {"instrument": "NQ", "tf": "5m"},
            "strategy": {"kind": "script", "code": "export function positions(bars) {\n  return bars.nope.map(() => 1);\n}\n"},
            "placeboRuns": 0
        }),
    )
    .await;
    let r = inv
        .invoke(InvokeRequest::new(
            "research.run_study",
            json!({"id": broken["id"]}),
            Origin::User,
        ))
        .await;
    let msg = r.error.unwrap().message;
    assert!(msg.contains("line 2"), "{msg}");
}

const ABOVE_THE_FIRST_CLOSE: &str = r#"export function positions(bars) {
  const out = new Float64Array(bars.length);
  let first = bars.close[0];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0 || bars.session[i] !== bars.session[i - 1]) first = bars.close[i];
    out[i] = bars.close[i] > first ? 1 : 0;
  }
  return out;
}
"#;
