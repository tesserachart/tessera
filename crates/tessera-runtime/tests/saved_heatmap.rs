use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Timestamp;
use tessera_protocol::layout::Layout;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_store::Store;
use tessera_testkit::Fakes;

mod common;

use common::call_user;

fn kinds(layers: &Value) -> Vec<&str> {
    layers
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["kind"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn a_desk_saved_with_the_heatmap_and_layers_since_removed_still_loads() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = Store::open_in_dir(dir.path()).unwrap();
        let layer = |id: &str, kind: &str| json!({"id": id, "kind": kind, "params": {}, "visible": true, "namespace": "user", "sessionId": null});
        let layout: Layout = serde_json::from_value(json!({
            "id": "default", "name": "Day", "revision": 3, "updatedAt": 0, "activeChartId": "chart-1",
            "dock": null, "trade": null,
            "charts": {"chart-1": {
                "tileId": "chart-1", "title": "Chart 1", "instrument": "ESZ6.CME", "timeframe": "1m",
                "layers": [layer("heat-1", "heatmap"), layer("fp-1", "footprint"), layer("dom-1", "dom_heat")],
                "annotations": [], "viewport": null, "linkGroup": null,
            }},
        }))
        .unwrap();
        store.layouts().put(&layout, None).unwrap();
        let settings = store.settings();
        settings
            .set(
                "appearance.theme",
                &json!({"heatmap": {"low": "#112233", "high": "#ffeeaa"}, "candles": {"upBody": "#26a69a"}}),
                Timestamp(0),
            )
            .unwrap();
        settings
            .set(
                "chart.templates",
                &json!({"templates": [{"id": "flow", "name": "Flow", "layers": [
                    {"kind": "heatmap", "params": {}, "visible": true},
                    {"kind": "footprint", "params": {}, "visible": true},
                ]}]}),
                Timestamp(0),
            )
            .unwrap();
    }

    let config = RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);

    let chart = call_user(&inv, "chart.get_state", json!({"tileId": "chart-1"})).await;
    assert_eq!(kinds(&chart["chart"]["layers"]), ["footprint"]);
    let stored = rt.state().store.layouts().get("default").unwrap().unwrap();
    assert!(
        stored.charts["chart-1"]
            .layers
            .iter()
            .all(|l| l.kind == "footprint"),
        "the layout is written back with only the layers this build draws"
    );

    let templates = call_user(&inv, "chart.list_templates", json!({})).await;
    let flow = &templates["templates"][0];
    assert_eq!(flow["name"], "Flow");
    assert_eq!(kinds(&flow["layers"]), ["footprint"]);

    let theme = call_user(&inv, "appearance.get_chart_theme", json!({})).await;
    assert_eq!(theme["overridden"], json!(["candles.upBody"]));
    assert_eq!(theme["colors"]["candles.upBody"], "#26a69a");
}
