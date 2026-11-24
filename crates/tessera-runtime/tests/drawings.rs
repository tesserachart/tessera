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

async fn refused(inv: &Invoker, origin: &Origin, name: &str, input: Value) -> ToolErrorCode {
    let r = inv
        .invoke(InvokeRequest::new(name, input, origin.clone()))
        .await;
    assert!(!r.ok, "{name} should be refused: {r:?}");
    r.error.unwrap().code
}

#[tokio::test]
async fn drawings_are_added_edited_and_removed_by_the_user_and_agents() {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    let user = Origin::User;
    let agent = Origin::Agent {
        session_id: SessionId::new("S7"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    let out = call(
        &inv,
        &user,
        "chart.add_drawing",
        json!({"kind": "trend_line", "points": [
            {"t": "2026-10-02T10:00:00-04:00", "price": 487.5},
            {"t": "2026-10-02T11:30:00-04:00", "price": 489.25}
        ]}),
    )
    .await;
    let line = out["drawing"].clone();
    assert_eq!(line["kind"], "trend_line");
    assert_eq!(line["instrument"], "NQZ6.CME", "the chart's instrument");
    assert_eq!(line["namespace"], "user");
    assert_eq!(line["style"]["color"], "mist");
    assert_eq!(line["style"]["extend"], "none");
    assert!(line["id"].as_str().unwrap().starts_with("dr_"));
    let line_id = line["id"].as_str().unwrap().to_owned();

    let out = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "ray", "points": [
            {"t": "2026-10-02T10:00:00-04:00", "price": 486},
            {"t": "2026-10-02T10:30:00-04:00", "price": 487}
        ], "style": {"width": 2}}),
    )
    .await;
    assert_eq!(out["drawing"]["namespace"], "agent");
    assert_eq!(out["drawing"]["sessionId"], "S7");
    assert_eq!(
        out["drawing"]["style"]["extend"], "right",
        "a ray extends right"
    );
    assert_eq!(out["drawing"]["style"]["width"], 2.0);

    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.add_drawing",
            json!({"kind": "rectangle", "points": [{"t": 1, "price": 1}]}),
        )
        .await,
        ToolErrorCode::InvalidInput
    );
    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.add_drawing",
            json!({"kind": "text", "points": [{"t": 1, "price": 1}]}),
        )
        .await,
        ToolErrorCode::InvalidInput,
        "a note needs text"
    );

    let s = call(&inv, &user, "chart.get_state", json!({})).await;
    let drawings = s["chart"]["drawings"].as_array().unwrap();
    assert_eq!(drawings.len(), 2);

    let out = call(
        &inv,
        &agent,
        "chart.update_drawing",
        json!({"drawingId": line_id, "style": {"color": "brass", "line": "dash"}, "locked": true}),
    )
    .await;
    assert_eq!(out["drawing"]["style"]["color"], "brass");
    assert_eq!(out["drawing"]["style"]["width"], 1.0, "kept");
    assert_eq!(out["drawing"]["locked"], true);
    let moved = json!({"drawingId": line_id, "points": [
        {"t": "2026-10-02T10:05:00-04:00", "price": 488},
        {"t": "2026-10-02T11:35:00-04:00", "price": 490}
    ]});
    assert_eq!(
        refused(&inv, &user, "chart.update_drawing", moved.clone()).await,
        ToolErrorCode::InvalidInput
    );
    let mut unlock = moved;
    unlock["locked"] = json!(false);
    let out = call(&inv, &user, "chart.update_drawing", unlock).await;
    assert_eq!(out["drawing"]["points"][0]["price"], 488.0);
    assert_eq!(out["drawing"]["locked"], false);
    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.update_drawing",
            json!({"drawingId": "dr_nope", "locked": true}),
        )
        .await,
        ToolErrorCode::NotFound
    );

    let out = call(&inv, &agent, "chart.remove_drawing", json!({"all": true})).await;
    assert_eq!(out["removed"], 1);
    let s = call(&inv, &user, "chart.get_state", json!({})).await;
    assert_eq!(s["chart"]["drawings"][0]["id"], line_id.as_str());
    assert_eq!(
        refused(&inv, &user, "chart.remove_drawing", json!({})).await,
        ToolErrorCode::InvalidInput,
        "an id or all"
    );
    let out = call(
        &inv,
        &user,
        "chart.remove_drawing",
        json!({"drawingId": line_id}),
    )
    .await;
    assert_eq!(out["removed"], 1);
    let s = call(&inv, &user, "chart.get_state", json!({})).await;
    assert!(
        s["chart"].get("drawings").is_none(),
        "none left: not written"
    );
}

async fn state(inv: &Invoker, tile: &str) -> Value {
    call(
        inv,
        &Origin::User,
        "chart.get_state",
        json!({"tileId": tile}),
    )
    .await
}

#[tokio::test]
async fn a_chart_shows_drawings_only_from_the_charts_it_picks() {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state_ = Arc::clone(rt.state());
    let inv = Arc::clone(&state_.invoker);
    let user = Origin::User;
    let layout = call(&inv, &user, "layout.get", json!({})).await;
    let mut charts = layout["charts"].clone();
    for (tile, tf) in [("chart-2", "1m"), ("chart-3", "1m")] {
        let mut c = charts["chart-1"].clone();
        c["tileId"] = json!(tile);
        c["timeframe"] = json!(tf);
        charts[tile] = c;
    }
    call(
        &inv,
        &user,
        "layout.save",
        json!({"layoutId": layout["id"], "charts": charts}),
    )
    .await;

    let out = call(
        &inv,
        &user,
        "chart.add_drawing",
        json!({"tileId": "chart-1", "kind": "horizontal_line", "points": [{"t": null, "price": 20000}]}),
    )
    .await;
    let id = out["drawing"]["id"].as_str().unwrap().to_owned();
    for tile in ["chart-2", "chart-3"] {
        let s = state(&inv, tile).await;
        assert!(s["chart"].get("drawings").is_none(), "{tile} holds none");
        assert_eq!(
            s["pulled"],
            json!([]),
            "{tile} picked nothing, so shows nothing"
        );
    }

    let out = call(
        &inv,
        &user,
        "chart.set_drawing_sources",
        json!({"tileId": "chart-2", "from": ["chart-1", "chart-1"]}),
    )
    .await;
    assert_eq!(out["chart"]["drawingsFrom"], json!(["chart-1"]));
    let s = state(&inv, "chart-2").await;
    assert_eq!(s["pulled"][0]["tileId"], "chart-1");
    assert_eq!(s["pulled"][0]["drawing"]["id"], id.as_str());
    assert_eq!(
        state(&inv, "chart-3").await["pulled"],
        json!([]),
        "the other 1m picked nothing"
    );

    let out = call(
        &inv,
        &user,
        "chart.update_drawing",
        json!({"tileId": "chart-2", "drawingId": id, "points": [{"t": null, "price": 20010}]}),
    )
    .await;
    assert_eq!(out["tileId"], "chart-1", "changed where it was made");
    assert_eq!(
        state(&inv, "chart-1").await["chart"]["drawings"][0]["points"][0]["price"],
        20010.0
    );
    assert!(
        state(&inv, "chart-2").await["chart"]
            .get("drawings")
            .is_none()
    );
    let out = call(
        &inv,
        &user,
        "chart.remove_drawing",
        json!({"tileId": "chart-2", "all": true}),
    )
    .await;
    assert_eq!(out["removed"], 0, "all is the chart's own drawings");
    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.remove_drawing",
            json!({"tileId": "chart-3", "drawingId": id}),
        )
        .await,
        ToolErrorCode::NotFound,
        "not on a chart that did not pick it"
    );
    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.set_drawing_sources",
            json!({"tileId": "chart-2", "from": ["chart-2"]}),
        )
        .await,
        ToolErrorCode::InvalidInput
    );
    assert_eq!(
        refused(
            &inv,
            &user,
            "chart.set_drawing_sources",
            json!({"tileId": "chart-2", "from": ["chart-9"]}),
        )
        .await,
        ToolErrorCode::NotFound
    );

    let stored = call(&inv, &user, "layout.get", json!({})).await;
    let mut kept = stored["charts"].clone();
    kept.as_object_mut().unwrap().remove("chart-1");
    call(
        &inv,
        &user,
        "layout.save",
        json!({"layoutId": layout["id"], "charts": kept}),
    )
    .await;
    let s = state(&inv, "chart-2").await;
    assert!(
        s["chart"].get("drawingsFrom").is_none(),
        "a closed chart leaves the pick list, so a new chart with its id pulls nothing in"
    );
}

#[tokio::test]
async fn old_horizontal_line_annotations_come_back_as_drawings() {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    let user = Origin::User;
    let layout = call(&inv, &user, "layout.get", json!({})).await;
    let mut charts = layout["charts"].clone();
    charts["chart-1"]["annotations"] = json!([{
        "id": "u_hline_k1", "kind": "hline", "namespace": "user", "sessionId": null,
        "instrument": "QQQ", "label": null, "note": null,
        "points": [{"t": null, "price": 488.5}], "style": null, "createdAt": 1
    }]);
    call(
        &inv,
        &user,
        "layout.save",
        json!({"layoutId": layout["id"], "charts": charts}),
    )
    .await;
    let s = call(&inv, &user, "chart.get_state", json!({"tileId": "chart-1"})).await;
    assert_eq!(s["chart"]["annotations"], json!([]));
    let d = &s["chart"]["drawings"][0];
    assert_eq!(d["kind"], "horizontal_line");
    assert_eq!(d["id"], "dr_k1");
    assert_eq!(d["points"][0]["price"], 488.5);
}

#[tokio::test]
async fn a_profile_from_bar_to_bar_is_one_call_and_the_chart_reports_it_drew() {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("S8"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    let chart = call(&inv, &Origin::User, "chart.get_state", json!({})).await;
    let tile = chart["chart"]["tileId"].as_str().unwrap().to_owned();

    let out = call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "volume_profile", "params": {"inputs": {
            "period": "range",
            "from": "2026-09-08T09:30:00-04:00",
            "to": "2026-10-02T14:00:00-04:00"
        }}}),
    )
    .await;
    let range = out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["kind"] == "volume_profile")
        .unwrap()
        .clone();
    assert_eq!(
        range["params"]["inputs"]["from"], "2026-09-08T13:30:00+00:00",
        "a range's times are kept in UTC"
    );
    assert_eq!(range["params"]["inputs"]["to"], "2026-10-02T18:00:00+00:00");
    let out = call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"kind": "volume_profile", "params": {"inputs": {
            "period": "composite", "compositePeriod": "week", "length": 13
        }}}),
    )
    .await;
    assert!(
        out["chart"]["layers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["params"]["inputs"]["length"] == 13),
        "a 13-week composite has no cap in its way"
    );
    for kind in ["profile_range", "profile_anchored"] {
        let e = refused(
            &inv,
            &agent,
            "chart.add_drawing",
            json!({"kind": kind, "points": [{"t": "2026-10-01T09:30:00-04:00"}]}),
        )
        .await;
        assert_eq!(e, ToolErrorCode::InvalidInput, "{kind} is a study now");
    }

    let state = call(&inv, &agent, "chart.get_state", json!({})).await;
    assert!(
        state["chart"]["viewport"]["profiles"].is_null(),
        "nothing drawn yet"
    );
    let r = call(
        &inv,
        &Origin::User,
        "chart.report_viewport",
        json!({"tileId": tile, "viewport": {
            "from": "2026-09-08T09:30:00-04:00", "to": "2026-10-02T14:00:00-04:00",
            "priceMin": 20000, "priceMax": 21000, "bars": 400,
            "reportedAt": "2026-10-02T14:42:00-04:00",
            "profiles": [{"source": "layer", "id": range["id"], "label": "Range",
                "from": "2026-09-08T09:30:00-04:00", "to": "2026-10-02T15:00:00-04:00",
                "poc": 20512.25, "vah": 20600, "val": 20400, "volume": 1250000, "delta": -4200, "partial": false}]
        }}),
    )
    .await;
    assert_eq!(r["stored"], true);
    let state = call(&inv, &agent, "chart.get_state", json!({})).await;
    let drew = &state["chart"]["viewport"]["profiles"][0];
    assert_eq!(drew["id"], range["id"]);
    assert_eq!(drew["source"], "layer");
    assert_eq!(drew["poc"], 20512.25);
    assert_eq!(drew["delta"], -4200.0);
}

#[tokio::test]
async fn an_agent_draws_a_cross_line_a_trend_angle_and_fibonacci_extensions_and_fans() {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("S9"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    let at = |t: &str, p: f64| json!({"t": format!("2026-10-02T{t}:00-04:00"), "price": p});

    let cross = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "cross_line", "points": [at("10:00", 487.5)],
               "label": {"text": "Open", "showPrice": true}}),
    )
    .await;
    assert_eq!(cross["drawing"]["label"]["showPrice"], true);

    let angle = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "trend_angle", "points": [at("10:00", 486.0), at("10:30", 488.0)],
               "style": {"extend": "right"}}),
    )
    .await;
    assert_eq!(angle["drawing"]["style"]["extend"], "right");

    let ext = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "fib_extension",
               "points": [at("10:00", 480.0), at("10:30", 490.0), at("10:45", 485.0)]}),
    )
    .await;
    assert_eq!(
        ext["drawing"]["levels"],
        json!([0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.618, 2.0])
    );
    assert_eq!(ext["drawing"]["points"].as_array().unwrap().len(), 3);
    let ext_id = ext["drawing"]["id"].as_str().unwrap().to_owned();
    let two = refused(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "fib_extension", "points": [at("10:00", 480.0), at("10:30", 490.0)]}),
    )
    .await;
    assert_eq!(two, ToolErrorCode::InvalidInput);

    let fan = call(
        &inv,
        &agent,
        "chart.add_drawing",
        json!({"kind": "fib_fan", "points": [at("10:00", 480.0), at("10:30", 490.0)],
               "levels": [0.618, 0.382], "label": {"showLevels": false}}),
    )
    .await;
    assert_eq!(fan["drawing"]["levels"], json!([0.382, 0.618]));
    assert_eq!(fan["drawing"]["style"]["extend"], "right");

    let saved = call(
        &inv,
        &agent,
        "chart.save_drawing_template",
        json!({"name": "Targets", "kind": "fib_extension", "levels": [1.0, 1.272, 1.618],
               "style": {"color": "teal"}}),
    )
    .await;
    assert_eq!(saved["template"]["levels"], json!([1.0, 1.272, 1.618]));
    let applied = call(
        &inv,
        &agent,
        "chart.apply_drawing_template",
        json!({"drawingId": ext_id, "template": "Targets"}),
    )
    .await;
    assert_eq!(applied["drawing"]["levels"], json!([1.0, 1.272, 1.618]));
    assert_eq!(applied["drawing"]["style"]["color"], "teal");

    let listed = call(&inv, &agent, "chart.get_state", json!({})).await;
    let kinds: Vec<&str> = listed["chart"]["drawings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["cross_line", "trend_angle", "fib_extension", "fib_fan"]
    );
}
