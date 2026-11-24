use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::SessionPolicy;

mod common;

use common::try_call;

const CODE: &str = r#"/** Distance of the close from its simple average, in percent. */
export const indicator = {
  title: "Stretch",
  placement: "pane",
  inputs: { length: { type: "int", default: 20, min: 2, max: 500 } },
  plots: [
    { name: "pct", kind: "histogram", colorBy: "sign" },
    { name: "zero", kind: "hline", value: 0 },
  ],
};

export function compute(bars, inputs) {
  const ma = ta.sma(bars.close, inputs.length);
  return { pct: bars.close.map((c, i) => (100 * (c - ma[i])) / ma[i]) };
}
"#;

#[tokio::test]
async fn the_analyst_writes_a_custom_indicator_and_draws_it() {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(2).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    let list = try_call(&inv, &agent, "indicators.list", json!({}))
        .await
        .unwrap();
    assert!(
        list["builtins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["kind"] == "rsi")
    );
    assert_eq!(list["sandbox"]["available"], true, "{}", list["sandbox"]);
    assert!(
        list["sandbox"]["engine"]
            .as_str()
            .unwrap()
            .starts_with("QuickJS")
    );

    let broken = CODE.replace("ta.sma(bars.close", "ta.smaa(bars.close");
    let e = try_call(
        &inv,
        &agent,
        "indicators.preview",
        json!({"code": broken, "instrument": "QQQ", "tf": "5m", "limit": 60}),
    )
    .await
    .unwrap_err();
    assert_eq!(e["code"], "invalid_input", "{e}");
    assert_eq!(e["details"]["line"], 13, "{e}");
    assert_eq!(e["details"]["kind"], "TypeError", "{e}");
    assert_eq!(
        e["details"]["text"],
        "const ma = ta.smaa(bars.close, inputs.length);"
    );

    let tried = try_call(
        &inv,
        &agent,
        "indicators.preview",
        json!({"code": CODE, "instrument": "QQQ", "tf": "5m", "limit": 60, "tail": 3}),
    )
    .await
    .unwrap();
    assert_eq!(tried["plots"][0]["values"].as_array().unwrap().len(), 3);
    let created = try_call(
        &inv,
        &agent,
        "indicators.create_custom",
        json!({"code": CODE}),
    )
    .await
    .unwrap();
    let id = created["custom"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["custom"]["createdBy"], "agent");
    assert_eq!(
        created["custom"]["description"],
        "Distance of the close from its simple average, in percent."
    );

    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "custom", "params": {"indicator": id, "inputs": {"length": 50}}}),
    )
    .await
    .unwrap();
    let layer = out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["kind"] == "custom")
        .cloned()
        .unwrap();
    assert_eq!(layer["params"]["indicator"], id.as_str());
    assert_eq!(layer["params"]["inputs"]["length"], 50);
    assert!(layer["params"]["style"]["plots"]["pct"].is_object());
    assert_eq!(layer["params"]["height"], 0.2);
    let bad = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "custom", "params": {"indicator": id, "inputs": {"length": 1}}}),
    )
    .await
    .unwrap_err();
    assert_eq!(bad["code"], "invalid_input", "{bad}");
    let missing = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "custom", "params": {"indicator": "ci_nope"}}),
    )
    .await
    .unwrap_err();
    assert!(
        missing["message"]
            .as_str()
            .unwrap()
            .contains("no custom indicator ci_nope")
    );
    let layer_id = layer["id"].as_str().unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.update_layer",
        json!({"tileId": "chart-1", "layerId": layer_id, "params": {"inputs": {"length": 30}}}),
    )
    .await
    .unwrap();
    let layer = &out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == layer_id)
        .cloned()
        .unwrap();
    assert_eq!(layer["params"]["inputs"]["length"], 30);
    assert_eq!(
        layer["params"]["indicator"],
        id.as_str(),
        "the indicator stays named"
    );

    try_call(
        &inv,
        &Origin::User,
        "chart.save_template",
        json!({"tileId": "chart-1", "name": "Stretch"}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &Origin::User,
        "chart.apply_template",
        json!({"tileId": "chart-2", "template": "Stretch"}),
    )
    .await
    .unwrap();
    assert!(
        out["chart"]["layers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["kind"] == "custom" && l["params"]["indicator"] == id.as_str()),
        "{out}"
    );

    let s = try_call(
        &inv,
        &agent,
        "indicators.compute",
        json!({"indicator": id, "instrument": "QQQ", "tf": "5m", "limit": 100, "inputs": {"length": 10}, "tail": 5}),
    )
    .await
    .unwrap();
    assert_eq!(s["time"].as_array().unwrap().len(), 5);
    assert!(
        s["plots"][0]["values"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_number)
    );
    let v2 = try_call(
        &inv,
        &agent,
        "indicators.update_custom",
        json!({"id": id, "code": CODE.replace("default: 20", "default: 14"), "baseVersion": 1}),
    )
    .await
    .unwrap();
    assert_eq!(v2["custom"]["version"], 2);
    let rsi = try_call(
        &inv,
        &agent,
        "indicators.compute",
        json!({"indicator": "rsi", "instrument": "QQQ", "tf": "5m", "limit": 100, "tail": 3}),
    )
    .await
    .unwrap();
    assert_eq!(rsi["inputs"]["length"], 14);
    assert!(
        rsi["plots"][0]["values"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.as_f64().is_some_and(|x| (0.0..=100.0).contains(&x)))
    );
    let refused = try_call(
        &inv,
        &agent,
        "indicators.compute",
        json!({"indicator": "footprint", "instrument": "QQQ", "tf": "5m"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused["code"], "unsupported");
    let got = try_call(&inv, &agent, "indicators.get", json!({"id": id}))
        .await
        .unwrap();
    assert_eq!(got["versions"].as_array().unwrap().len(), 2);
}
