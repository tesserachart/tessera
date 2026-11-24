use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

mod common;

use common::call;

async fn refused(
    inv: &Invoker,
    origin: &Origin,
    name: &str,
    input: Value,
) -> (ToolErrorCode, String) {
    let r = inv
        .invoke(InvokeRequest::new(name, input.clone(), origin.clone()))
        .await;
    assert!(!r.ok, "{name} {input} should be refused: {r:?}");
    let e = r.error.unwrap();
    (e.code, e.message)
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
        session_id: SessionId::new("S-labels"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    (rt, inv, agent)
}

fn level(price: f64) -> Value {
    json!([{"t": null, "price": price}])
}

#[tokio::test]
async fn an_agent_labels_a_level_and_edits_its_label() {
    let (_rt, inv, agent) = runtime().await;
    let out = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "horizontal_line", "points": level(487.5),
            "label": {"text": "Asia high", "showPrice": true, "position": "below"}}),
    )
    .await;
    let d = &out["drawing"];
    assert_eq!(d["label"]["text"], "Asia high");
    assert_eq!(
        d["label"]["align"], "right",
        "a level's words sit at the right"
    );
    assert_eq!(d["label"]["position"], "below");
    assert_eq!(d["label"]["showPrice"], true);
    assert!(
        d["label"].get("color").is_none(),
        "the line's colour: the analyst's while the line is"
    );
    let id = d["id"].as_str().unwrap().to_owned();

    let (code, why) = refused(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "horizontal_line", "points": level(480.0), "text": "PDL"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
    assert!(why.contains("label.text"), "{why}");

    call(
        &inv,
        &agent,
        "chart.update_drawing",
        json!({"drawingId": id, "label": {"text": "Asia high\nSweep watch", "bold": true, "color": "brass"}}),
    )
    .await;
    let state = call(&inv, &agent, "chart.get_state", json!({})).await;
    let d = state["chart"]["drawings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(d["label"]["text"], "Asia high\nSweep watch");
    assert_eq!(d["label"]["bold"], true);
    assert_eq!(d["label"]["color"], "brass");
    assert_eq!(
        d["label"]["position"], "below",
        "untouched fields keep theirs"
    );

    let fib = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "fib_retracement", "points": [
            {"t": "2026-10-02T10:00:00-04:00", "price": 480},
            {"t": "2026-10-02T11:00:00-04:00", "price": 490}
        ], "label": {"showPrice": false, "align": "right"}}),
    )
    .await;
    assert_eq!(fib["drawing"]["label"]["showLevels"], true);
    assert_eq!(fib["drawing"]["label"]["showPrice"], false);
    let fib_id = fib["drawing"]["id"].as_str().unwrap();
    refused(
        &inv,
        &agent,
        "chart.update_drawing",
        json!({"drawingId": fib_id, "label": {"text": "swing"}}),
    )
    .await;
}

#[tokio::test]
async fn drawing_templates_are_saved_applied_made_the_default_renamed_and_deleted() {
    let (rt, inv, agent) = runtime().await;
    let user = Origin::User;
    let settings = Arc::clone(&rt.state().settings);

    let out = call(
        &inv,
        &user,
        "chart.add_drawing",
        json!({"kind": "horizontal_line", "points": level(487.5),
            "style": {"color": "brass", "width": 2, "line": "dash"},
            "label": {"text": "Asia high", "showPrice": true, "align": "left", "size": 14}}),
    )
    .await;
    let source = out["drawing"]["id"].as_str().unwrap().to_owned();
    let saved = call(
        &inv,
        &user,
        "chart.save_drawing_template",
        json!({"name": "Session level", "drawingId": source}),
    )
    .await;
    assert_eq!(saved["replaced"], false);
    let t = &saved["template"];
    assert_eq!(t["kind"], "horizontal_line");
    assert_eq!(t["style"]["color"], "brass");
    assert_eq!(t["label"]["text"], "", "a template keeps no words");
    assert_eq!(t["label"]["size"], 14);
    let template_id = t["id"].as_str().unwrap().to_owned();

    let mine = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "horizontal_line", "points": level(480.0), "label": {"text": "PDL"}}),
    )
    .await;
    let mine_id = mine["drawing"]["id"].as_str().unwrap().to_owned();
    let applied = call(
        &inv,
        &agent,
        "chart.apply_drawing_template",
        json!({"drawingId": mine_id, "template": "session LEVEL"}),
    )
    .await;
    let d = &applied["drawing"];
    assert_eq!(d["style"]["color"], "brass");
    assert_eq!(d["style"]["line"], "dash");
    assert_eq!(d["label"]["text"], "PDL");
    assert_eq!(d["label"]["align"], "left");
    assert_eq!(d["label"]["showPrice"], true);
    let ray = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "ray", "points": [
            {"t": "2026-10-02T10:00:00-04:00", "price": 486},
            {"t": "2026-10-02T10:30:00-04:00", "price": 487}
        ]}),
    )
    .await;
    let ray_id = ray["drawing"]["id"].as_str().unwrap();
    let (code, _) = refused(
        &inv,
        &agent,
        "chart.apply_drawing_template",
        json!({"drawingId": ray_id, "template": "Session level"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::NotFound);
    let back = call(
        &inv,
        &agent,
        "chart.apply_drawing_template",
        json!({"drawingId": mine_id, "template": "built-in"}),
    )
    .await;
    assert_eq!(back["drawing"]["style"]["color"], "mist");
    assert_eq!(back["drawing"]["label"]["text"], "PDL");
    assert_eq!(back["drawing"]["label"]["showPrice"], false);

    call(
        &inv,
        &agent,
        "chart.save_drawing_template",
        json!({"name": "Session level", "kind": "horizontal_ray",
            "style": {"color": "teal"}, "label": {"position": "on"}}),
    )
    .await;
    let list = call(&inv, &agent, "chart.list_drawing_templates", json!({})).await;
    assert_eq!(list["templates"].as_array().unwrap().len(), 2);
    let rays = call(
        &inv,
        &agent,
        "chart.list_drawing_templates",
        json!({"kind": "horizontal_ray"}),
    )
    .await;
    assert_eq!(rays["templates"][0]["label"]["position"], "on");
    let (_, why) = refused(
        &inv,
        &agent,
        "chart.set_default_drawing_template",
        json!({"template": "Session level"}),
    )
    .await;
    assert!(why.contains("give its kind or its id"), "{why}");

    let out = call(
        &inv,
        &agent,
        "chart.set_default_drawing_template",
        json!({"template": "Session level", "kind": "horizontal_line"}),
    )
    .await;
    assert_eq!(out["template"]["id"], template_id.as_str());
    let tools = settings.value("chart.drawingTools").unwrap();
    let entry = &tools["styles"]["horizontal_line"];
    assert_eq!(entry["color"], "brass");
    assert_eq!(entry["width"], 2.0);
    assert_eq!(entry["label"]["showPrice"], true);
    assert_eq!(entry["label"]["text"], "");
    settings
        .set("chart.drawingTools", json!({"magnet": true}), &user)
        .await
        .unwrap();
    call(
        &inv,
        &agent,
        "chart.set_default_drawing_template",
        json!({"kind": "horizontal_line"}),
    )
    .await;
    let tools = settings.value("chart.drawingTools").unwrap();
    assert_eq!(tools["magnet"], true);
    assert!(
        tools["styles"].get("horizontal_line").is_none(),
        "the built-in look again"
    );

    call(
        &inv,
        &user,
        "chart.save_drawing_template",
        json!({"name": "Plain", "kind": "horizontal_line"}),
    )
    .await;
    let (code, _) = refused(
        &inv,
        &agent,
        "chart.rename_drawing_template",
        json!({"template": template_id, "name": "plain"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::Conflict);
    let renamed = call(
        &inv,
        &agent,
        "chart.rename_drawing_template",
        json!({"template": template_id, "name": "Overnight level"}),
    )
    .await;
    assert!(
        renamed["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == template_id.as_str() && t["name"] == "Overnight level")
    );
    let left = call(
        &inv,
        &agent,
        "chart.delete_drawing_template",
        json!({"template": "Overnight level", "kind": "horizontal_line"}),
    )
    .await;
    assert_eq!(left["templates"].as_array().unwrap().len(), 2);
    let state = call(&inv, &agent, "chart.get_state", json!({})).await;
    let first = state["chart"]["drawings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == source.as_str())
        .unwrap()
        .clone();
    assert_eq!(first["style"]["color"], "brass", "drawings keep their look");

    let r = inv
        .invoke(InvokeRequest::new(
            "settings.set",
            json!({"key": "chart.drawingTemplates", "value": {"templates": [{"id": "x", "name": "X", "kind": "spiral", "style": {"color": "mist", "width": 1, "line": "solid"}}]}}),
            user.clone(),
        ))
        .await;
    assert!(!r.ok, "{r:?}");
}
