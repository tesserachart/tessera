use std::sync::Arc;

use serde_json::{Value, json};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;

mod common;

use common::call_user;

fn chart(tile: &str) -> Value {
    json!({
        "tileId": tile, "title": "Chart 1", "instrument": "ESZ6.CME", "timeframe": "1m",
        "layers": [], "annotations": [], "viewport": null, "linkGroup": null,
    })
}

fn dock(width: u32) -> Value {
    json!({
        "grid": {"root": {"type": "branch", "size": width, "data": [{"type": "leaf", "size": width, "data": {"views": ["chart-1"], "activeView": "chart-1", "id": "1"}}]}, "width": width, "height": 900, "orientation": "HORIZONTAL"},
        "panels": {"chart-1": {"id": "chart-1", "contentComponent": "chart", "params": {"layoutId": "ws", "tileId": "chart-1"}}},
        "tessera": {"v": 5},
    })
}

async fn boot(dir: &std::path::Path) -> Runtime {
    let config = RuntimeConfig {
        data_dir: Some(dir.to_path_buf()),
        ..RuntimeConfig::default()
    };
    Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap()
}

fn summary(list: &Value, id: &str) -> Value {
    list["layouts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == id)
        .cloned()
        .unwrap()
}

#[tokio::test]
async fn a_workspace_saves_like_a_document() {
    let dir = tempfile::tempdir().unwrap();
    let rt = boot(dir.path()).await;
    let inv = Arc::clone(&rt.state().invoker);
    let get = || call_user(&inv, "layout.get", json!({"layoutId": "ws"}));

    call_user(
        &inv,
        "layout.save",
        json!({"layoutId": "ws", "name": "Trade", "dock": dock(1200), "charts": {"chart-1": chart("chart-1")}}),
    )
    .await;
    assert!(
        get().await.get("unsaved").is_none(),
        "a new workspace is saved"
    );

    call_user(
        &inv,
        "layout.save",
        json!({"layoutId": "ws", "dock": dock(900)}),
    )
    .await;
    assert!(
        get().await.get("unsaved").is_none(),
        "resizing is not a change"
    );

    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"layoutId": "ws", "tileId": "chart-1", "chartType": "bars"}),
    )
    .await;
    call_user(
        &inv,
        "layout.save",
        json!({"layoutId": "ws", "name": "Scalp"}),
    )
    .await;
    let shown = get().await;
    assert_eq!(shown["unsaved"], true);
    assert_eq!(shown["charts"]["chart-1"]["chartType"], "bars");
    let list = call_user(&inv, "layout.list", json!({})).await;
    assert_eq!(summary(&list, "ws")["unsaved"], true);
    assert_eq!(summary(&list, "ws")["recovered"], false);

    call_user(&inv, "workspace.revert", json!({"layoutId": "ws"})).await;
    let back = get().await;
    assert!(back.get("unsaved").is_none());
    assert!(back["charts"]["chart-1"].get("chartType").is_none());
    assert_eq!(back["name"], "Scalp", "a new name is kept at once");
    assert_eq!(
        back["dock"]["grid"]["width"], 900,
        "a clean workspace keeps its sizes"
    );

    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"layoutId": "ws", "tileId": "chart-1", "chartType": "line"}),
    )
    .await;
    call_user(&inv, "workspace.save", json!({"layoutId": "ws"})).await;
    assert!(get().await.get("unsaved").is_none());
    call_user(&inv, "workspace.revert", json!({"layoutId": "ws"})).await;
    assert_eq!(get().await["charts"]["chart-1"]["chartType"], "line");

    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"layoutId": "ws", "tileId": "chart-1", "chartType": "candles"}),
    )
    .await;
    call_user(
        &inv,
        "chart.set_chart_type",
        json!({"layoutId": "ws", "tileId": "chart-1", "chartType": "line"}),
    )
    .await;
    assert!(
        get().await.get("unsaved").is_none(),
        "changing it back leaves nothing unsaved"
    );
}

#[tokio::test]
async fn unsaved_changes_that_outlive_tessera_come_back_marked_recovered() {
    let dir = tempfile::tempdir().unwrap();
    {
        let rt = boot(dir.path()).await;
        let inv = Arc::clone(&rt.state().invoker);
        call_user(
            &inv,
            "layout.save",
            json!({"layoutId": "ws", "name": "Trade", "dock": dock(1200), "charts": {"chart-1": chart("chart-1")}}),
        )
        .await;
        call_user(
            &inv,
            "chart.set_chart_type",
            json!({"layoutId": "ws", "tileId": "chart-1", "chartType": "bars"}),
        )
        .await;
        drop(rt);
    }

    let rt = boot(dir.path()).await;
    let inv = Arc::clone(&rt.state().invoker);
    let shown = call_user(&inv, "layout.get", json!({"layoutId": "ws"})).await;
    assert_eq!(shown["unsaved"], true);
    assert_eq!(shown["charts"]["chart-1"]["chartType"], "bars");
    let list = call_user(&inv, "layout.list", json!({})).await;
    assert_eq!(summary(&list, "ws")["recovered"], true);
    assert_eq!(summary(&list, "default")["recovered"], false);

    call_user(&inv, "workspace.revert", json!({"layoutId": "ws"})).await;
    let back = call_user(&inv, "layout.get", json!({"layoutId": "ws"})).await;
    assert!(back["charts"]["chart-1"].get("chartType").is_none());
    let list = call_user(&inv, "layout.list", json!({})).await;
    assert_eq!(summary(&list, "ws")["recovered"], false);
    assert_eq!(summary(&list, "ws")["unsaved"], false);
}
