use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{Invoker, SessionPolicy};

mod common;

use common::call;

const ORB: &str = include_str!("../../../fixtures/research/orb-baseline.js");
const PINNED: &str = "../../fixtures/research/orb-baseline.run.json";

fn study(name: &str, strategy: Value) -> Value {
    json!({
        "name": name,
        "hypothesis": "A 5-minute close outside NQ's 15-minute opening range runs on to twice the range's width before it closes back through its midpoint.",
        "data": {
            "instrument": "NQ",
            "tf": "5m",
            "rthOnly": true,
            "window": {"start": "09:30", "end": "12:00"}
        },
        "strategy": strategy,
        "gates": {"minTrades": 5},
        "placeboRuns": 20
    })
}

fn measured(evaluation: &Value) -> Value {
    let cases: Vec<Value> = evaluation["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            json!({
                "case": c["case"],
                "trades": c["trades"],
                "development": {"metrics": c["development"]["metrics"], "halves": c["development"]["halves"]},
                "later": {"metrics": c["later"]["metrics"], "halves": c["later"]["halves"]},
                "gates": c["gates"],
            })
        })
        .collect();
    json!({
        "bars": evaluation["bars"],
        "sessions": evaluation["sessions"],
        "laterFromSession": evaluation["laterFromSession"],
        "cases": cases,
        "placebo": evaluation["placebo"],
        "verdict": evaluation["verdict"],
        "reason": evaluation["reason"],
    })
}

async fn run(inv: &Invoker, agent: &Origin, input: Value) -> Value {
    let saved = call(inv, agent, "research.save_study", input).await;
    let digest = call(inv, agent, "research.run_study", json!({"id": saved["id"]})).await;
    let run = call(
        inv,
        agent,
        "research.get_run",
        json!({"runId": digest["runId"]}),
    )
    .await;
    measured(&run["evaluation"])
}

#[tokio::test]
async fn the_orb_baseline_measures_what_it_measured_before() {
    let config = RuntimeConfig {
        clock: tessera_testkit::frozen_clock(),
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(40).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("ORB"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    let engine = run(
        &inv,
        &agent,
        study("ORB baseline", json!({"kind": "script", "code": ORB})),
    )
    .await;
    let trades = engine["cases"][0]["trades"].as_array().unwrap();
    assert!(trades.len() >= 10, "{engine}");
    assert!(trades.iter().any(|t| t["exit"] == "target"));
    assert!(trades.iter().any(|t| t["exit"] == "signal"));

    for t in trades {
        assert_eq!(
            t["approximate"],
            t["exit"] == "target",
            "the fixture has no saved prints, so its target exits are found on bars"
        );
    }

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(PINNED);
    let pinned: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(without_fill_basis(engine), pinned);
}

fn without_fill_basis(mut v: Value) -> Value {
    match &mut v {
        Value::Object(o) => {
            o.remove("approximate");
            o.remove("approximateExits");
            for x in o.values_mut() {
                *x = without_fill_basis(std::mem::take(x));
            }
        }
        Value::Array(a) => {
            for x in a.iter_mut() {
                *x = without_fill_basis(std::mem::take(x));
            }
        }
        _ => {}
    }
    v
}
