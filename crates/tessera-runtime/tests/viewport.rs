use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::Invoker;

mod common;
use common::call_user;

async fn runtime() -> (Runtime, Arc<Invoker>) {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    (rt, inv)
}

fn report(answers: Option<&str>, bars: u32, short: Option<&str>) -> Value {
    let mut viewport = json!({
        "from": "2026-09-28T09:30:00-04:00", "to": "2026-10-02T14:00:00-04:00",
        "priceMin": 20000, "priceMax": 21000, "bars": bars, "follows": true,
        "reportedAt": "2026-10-02T14:42:00-04:00",
    });
    if let Some(a) = answers {
        viewport["answers"] = json!(a);
    }
    if let Some(s) = short {
        viewport["short"] = json!(s);
    }
    json!({"tileId": "chart-1", "viewport": viewport})
}

#[tokio::test]
async fn a_chart_no_desk_has_drawn_answers_at_once_without_a_view() {
    let (_rt, inv) = runtime().await;
    let started = Instant::now();
    let out = call_user(&inv, "chart.set_viewport", json!({"lastBars": 900})).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(out["request"]["settings"], json!({"lastBars": 900}));
    assert!(out.get("shown").is_none());
}

#[tokio::test]
async fn the_view_the_chart_answers_with_comes_back_with_why_it_shows_less() {
    let (_rt, inv) = runtime().await;
    call_user(&inv, "chart.report_viewport", report(None, 150, None)).await;
    let asking = {
        let inv = Arc::clone(&inv);
        tokio::spawn(async move {
            call_user(&inv, "chart.set_viewport", json!({"lastBars": 900})).await
        })
    };
    let op = loop {
        let layout = call_user(&inv, "layout.get", json!({})).await;
        let ops = layout["dock"]["tessera"]["ops"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(op) = ops.iter().rev().find(|o| o["op"] == "viewport") {
            break op["id"].as_str().unwrap().to_owned();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    call_user(
        &inv,
        "chart.report_viewport",
        report(Some("op-0"), 150, None),
    )
    .await;
    let why = "351 of 900 bars: these bars reach back 5 sessions";
    call_user(
        &inv,
        "chart.report_viewport",
        report(Some(&op), 351, Some(why)),
    )
    .await;
    let out = asking.await.unwrap();
    assert_eq!(out["request"]["id"], op);
    assert_eq!(out["shown"]["bars"], 351);
    assert_eq!(out["shown"]["short"], why);
    assert_eq!(out["shown"]["follows"], true);
    let state = call_user(&inv, "chart.get_state", json!({})).await;
    assert_eq!(state["chart"]["viewport"]["short"], why);
}

#[tokio::test]
async fn hiding_the_price_is_one_chart_s_own_type() {
    let (_rt, inv) = runtime().await;
    let user = Origin::User;
    common::call(&inv, &user, "workspace.open_tile", json!({"kind": "chart"})).await;
    let layout = call_user(&inv, "layout.get", json!({})).await;
    let charts = layout["charts"].as_object().unwrap();
    let other = charts
        .keys()
        .find(|k| *k != "chart-1")
        .expect("a second chart")
        .to_owned();
    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"tileId": "chart-1", "chartType": "none"}),
    )
    .await;
    let hidden = call_user(&inv, "chart.get_state", json!({"tileId": "chart-1"})).await;
    assert_eq!(hidden["chart"]["chartType"], "none");
    let shown = call_user(&inv, "chart.get_state", json!({"tileId": other})).await;
    assert!(shown["chart"]["chartType"].is_null());
    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"tileId": "chart-1", "chartType": "line"}),
    )
    .await;
    let back = call_user(&inv, "chart.get_state", json!({"tileId": "chart-1"})).await;
    assert_eq!(back["chart"]["chartType"], "line");
}
