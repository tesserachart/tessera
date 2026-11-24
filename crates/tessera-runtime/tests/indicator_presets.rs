use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{Invoker, SessionPolicy};

mod common;

use common::try_call;

fn layer<'a>(out: &'a Value, id: &str) -> &'a Value {
    out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == id)
        .unwrap_or_else(|| panic!("no layer {id}: {out}"))
}

async fn runtime() -> (Runtime, Arc<Invoker>, Origin) {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("S7"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    (rt, inv, agent)
}

#[tokio::test]
async fn an_indicators_lines_carry_labels_the_user_or_the_analyst_switches() {
    let (_rt, inv, agent) = runtime().await;
    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "ema", "id": "e"}),
    )
    .await
    .unwrap();
    assert_eq!(
        layer(&out, "e")["params"]["style"]["labels"],
        json!({"priceScale": false, "name": false, "value": false})
    );
    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "rsi", "id": "r"}),
    )
    .await
    .unwrap();
    assert_eq!(
        layer(&out, "r")["params"]["style"]["labels"]["priceScale"],
        true
    );
    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "sma", "id": "s", "params": {"style": {"labels": {"name": true}}}}),
    )
    .await
    .unwrap();
    assert_eq!(
        layer(&out, "s")["params"]["style"]["labels"],
        json!({"priceScale": false, "name": true, "value": false})
    );
    let out = try_call(
        &inv,
        &agent,
        "chart.update_layer",
        json!({"layerId": "s", "params": {"style": {"labels": {"value": true, "priceScale": true}}}}),
    )
    .await
    .unwrap();
    assert_eq!(
        layer(&out, "s")["params"]["style"]["labels"],
        json!({"priceScale": true, "name": true, "value": true})
    );
    let kinds = try_call(
        &inv,
        &agent,
        "chart.list_layer_kinds",
        json!({"kind": "ema"}),
    )
    .await
    .unwrap();
    let ema = kinds["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["kind"] == "ema")
        .unwrap();
    assert!(
        ema["paramsSchema"]["properties"]["style"]["properties"]["labels"].is_object()
            || ema.to_string().contains("priceScale"),
        "the schema the analyst reads names the labels: {ema}"
    );
}

#[tokio::test]
async fn presets_are_saved_applied_renamed_and_deleted() {
    let (_rt, inv, agent) = runtime().await;
    let user = Origin::User;
    try_call(
        &inv,
        &user,
        "chart.add_layer",
        json!({"kind": "ema", "id": "e1", "params": {"inputs": {"length": 50},
            "style": {"plots": {"ma": {"color": "teal", "width": 2}}, "labels": {"name": true}}}}),
    )
    .await
    .unwrap();
    let saved = try_call(
        &inv,
        &user,
        "chart.save_indicator_preset",
        json!({"layerId": "e1", "name": "Slow teal"}),
    )
    .await
    .unwrap();
    assert_eq!(saved["replaced"], false);
    let p = &saved["preset"];
    assert_eq!(
        (p["id"].as_str(), p["indicator"].as_str()),
        (Some("slow-teal"), Some("ema"))
    );
    assert_eq!(p["params"]["inputs"]["length"], 50);
    assert_eq!(p["params"]["style"]["labels"]["name"], true);
    assert!(p["params"].get("height").is_none());

    try_call(
        &inv,
        &agent,
        "chart.save_indicator_preset",
        json!({"indicator": "ema", "name": "Fast", "params": {"inputs": {"length": 9}}}),
    )
    .await
    .unwrap();
    try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "ema", "id": "e2"}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.apply_indicator_preset",
        json!({"layerId": "e2", "preset": "slow teal"}),
    )
    .await
    .unwrap();
    let e2 = layer(&out, "e2");
    assert_eq!(e2["params"]["inputs"]["length"], 50);
    assert_eq!(e2["params"]["style"]["plots"]["ma"]["color"], "teal");
    assert_eq!(
        e2["namespace"], "agent",
        "applying settings does not change whose it is"
    );
    try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "sma", "id": "s1"}),
    )
    .await
    .unwrap();
    let e = try_call(
        &inv,
        &agent,
        "chart.apply_indicator_preset",
        json!({"layerId": "s1", "preset": "Fast"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e["code"], "not_found", "{e}");

    let e = try_call(
        &inv,
        &user,
        "chart.edit_indicator_preset",
        json!({"preset": "slow-teal", "name": "fast"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e["code"], "conflict");
    let all = try_call(
        &inv,
        &user,
        "chart.edit_indicator_preset",
        json!({"preset": "slow-teal", "name": "Trend"}),
    )
    .await
    .unwrap();
    assert!(
        all["presets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "Trend")
    );
    let all = try_call(
        &inv,
        &user,
        "chart.delete_indicator_preset",
        json!({"preset": "Trend"}),
    )
    .await
    .unwrap();
    assert_eq!(all["presets"].as_array().unwrap().len(), 1);
    let listed = try_call(
        &inv,
        &agent,
        "chart.list_indicator_presets",
        json!({"indicator": "sma"}),
    )
    .await
    .unwrap();
    assert!(listed["presets"].as_array().unwrap().is_empty());
    let e = try_call(
        &inv,
        &user,
        "settings.set",
        json!({"key": "chart.indicatorPresets", "value": {"presets": [{"id": "x"}]}}),
    )
    .await
    .unwrap_err();
    assert_eq!(e["code"], "invalid_input", "{e}");
}

#[tokio::test]
async fn a_default_is_where_new_indicators_start_and_reset_returns_to() {
    let (_rt, inv, agent) = runtime().await;
    let user = Origin::User;
    try_call(
        &inv,
        &user,
        "chart.add_layer",
        json!({"kind": "rsi", "id": "r1", "params": {"inputs": {"length": 7, "upper": 80},
            "style": {"plots": {"rsi": {"color": "brass"}}}, "height": 0.3}}),
    )
    .await
    .unwrap();
    let all = try_call(
        &inv,
        &user,
        "chart.set_indicator_default",
        json!({"layerId": "r1"}),
    )
    .await
    .unwrap();
    assert_eq!(all["defaults"]["rsi"]["inputs"]["length"], 7);
    assert!(all["defaults"]["rsi"].get("height").is_none());

    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "rsi", "id": "r2", "params": {"inputs": {"lower": 25}}}),
    )
    .await
    .unwrap();
    let r2 = &layer(&out, "r2")["params"];
    assert_eq!(r2["inputs"]["length"], 7);
    assert_eq!(r2["inputs"]["upper"], 80.0);
    assert_eq!(r2["inputs"]["lower"], 25.0);
    assert_eq!(r2["style"]["plots"]["rsi"]["color"], "brass");
    assert_eq!(r2["height"], 0.16, "the pane height is the indicator's own");

    try_call(
        &inv,
        &agent,
        "chart.update_layer",
        json!({"layerId": "r2", "params": {"inputs": {"length": 30}, "height": 0.4}}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.apply_indicator_preset",
        json!({"layerId": "r2", "preset": "default"}),
    )
    .await
    .unwrap();
    let r2 = &layer(&out, "r2")["params"];
    assert_eq!(r2["inputs"]["length"], 7);
    assert_eq!(
        r2["inputs"]["lower"], 30.0,
        "the default's, not what was given on add"
    );
    assert_eq!(r2["height"], 0.4, "the pane height stays");
    let out = try_call(
        &inv,
        &agent,
        "chart.apply_indicator_preset",
        json!({"layerId": "r2", "preset": "factory"}),
    )
    .await
    .unwrap();
    assert_eq!(layer(&out, "r2")["params"]["inputs"]["length"], 14);

    try_call(
        &inv,
        &user,
        "chart.save_indicator_preset",
        json!({"indicator": "rsi", "name": "Short", "params": {"inputs": {"length": 2}}}),
    )
    .await
    .unwrap();
    let all = try_call(
        &inv,
        &user,
        "chart.set_indicator_default",
        json!({"indicator": "rsi", "preset": "Short"}),
    )
    .await
    .unwrap();
    assert_eq!(all["defaults"]["rsi"]["inputs"]["length"], 2);
    try_call(
        &inv,
        &agent,
        "chart.set_indicator_default",
        json!({"indicator": "rsi", "clear": true}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "rsi", "id": "r3"}),
    )
    .await
    .unwrap();
    assert_eq!(layer(&out, "r3")["params"]["inputs"]["length"], 14);
    let e = try_call(
        &inv,
        &agent,
        "chart.set_indicator_default",
        json!({"indicator": "rsi", "clear": true, "params": {}}),
    )
    .await
    .unwrap_err();
    assert_eq!(e["code"], "invalid_input");
    try_call(
        &inv,
        &user,
        "chart.save_template",
        json!({"name": "With RSI"}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &user,
        "chart.apply_template",
        json!({"template": "With RSI"}),
    )
    .await
    .unwrap();
    assert!(
        out["chart"]["layers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["kind"] == "rsi")
    );
}

#[tokio::test]
async fn a_custom_indicators_presets_follow_it_as_it_changes() {
    let (_rt, inv, agent) = runtime().await;
    let v1 = "export const indicator = {\n  title: 'Mine',\n  placement: 'overlay',\n  inputs: { n: 5, k: { type: 'number', default: 2 } },\n  plots: ['v'],\n};\nexport function compute(bars, inputs) {\n  return { v: bars.close.map(() => inputs.n) };\n}\n";
    let created = try_call(
        &inv,
        &agent,
        "indicators.create_custom",
        json!({"code": v1}),
    )
    .await
    .unwrap();
    let id = created["custom"]["id"].as_str().unwrap().to_owned();
    try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "custom", "id": "c1", "params": {"indicator": id, "inputs": {"n": 8, "k": 3.0}}}),
    )
    .await
    .unwrap();
    let saved = try_call(
        &inv,
        &agent,
        "chart.save_indicator_preset",
        json!({"layerId": "c1", "name": "Eight"}),
    )
    .await
    .unwrap();
    assert_eq!(
        saved["preset"]["indicator"],
        id.as_str(),
        "keyed by the indicator's id"
    );
    assert!(saved["preset"]["params"].get("indicator").is_none());
    let v2 = v1.replace(
        "inputs: { n: 5, k: { type: 'number', default: 2 } }",
        "inputs: { n: { type: 'int', default: 5, max: 20 }, m: 1 }",
    );
    try_call(
        &inv,
        &agent,
        "indicators.update_custom",
        json!({"id": id, "code": v2}),
    )
    .await
    .unwrap();
    try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "custom", "id": "c2", "params": {"indicator": id}}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.apply_indicator_preset",
        json!({"layerId": "c2", "preset": "Eight"}),
    )
    .await
    .unwrap();
    let c2 = &layer(&out, "c2")["params"];
    assert_eq!(c2["inputs"], json!({"n": 8, "m": 1}), "{c2}");
    assert_eq!(c2["indicator"], id.as_str(), "it still names its indicator");
    try_call(
        &inv,
        &agent,
        "chart.set_indicator_default",
        json!({"indicator": id, "preset": "Eight"}),
    )
    .await
    .unwrap();
    let out = try_call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "custom", "id": "c3", "params": {"indicator": id}}),
    )
    .await
    .unwrap();
    assert_eq!(layer(&out, "c3")["params"]["inputs"]["n"], 8);
}
