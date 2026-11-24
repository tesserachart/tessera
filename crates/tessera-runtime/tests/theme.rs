use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-app-theme"),
        provider: "codex".into(),
    }
}

async fn runtime() -> (Runtime, Arc<Invoker>) {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    inv.set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));
    (rt, inv)
}

async fn call(inv: &Invoker, name: &str, input: Value) -> Value {
    let r = inv.invoke(InvokeRequest::new(name, input, agent())).await;
    assert!(r.ok, "{name}: {r:?}");
    r.output.unwrap()
}

async fn set(inv: &Invoker, value: Value) -> tessera_protocol::tools::ToolResult {
    inv.invoke(InvokeRequest::new(
        "settings.set",
        json!({"key": "appearance.theme", "value": value}),
        agent(),
    ))
    .await
}

#[tokio::test]
async fn the_analyst_reads_sets_and_saves_the_whole_apps_theme_in_one_call_each() {
    let (_rt, inv) = runtime().await;

    let start = call(&inv, "appearance.get_theme", json!({})).await;
    assert_eq!(start["preset"], "tessera");
    assert_eq!(start["mode"], "dark");
    assert_eq!(start["colors"]["surfaces.ground"], "#05080b");
    assert_eq!(start["colors"]["palette.background"], "#05080b");
    let ids: Vec<&str> = start["builtIns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "tessera",
            "tessera-light",
            "solarized-dark",
            "solarized-light",
            "night-owl",
            "nord",
            "gruvbox-dark",
            "gruvbox-light"
        ]
    );

    assert!(set(&inv, json!({"preset": "solarized-light"})).await.ok);
    let light = call(&inv, "appearance.get_theme", json!({})).await;
    assert_eq!(light["mode"], "light");
    assert_eq!(light["colors"]["surfaces.ground"], "#fdf6e3");
    assert_eq!(light["colors"]["ink.t1"], "#073642");
    assert_eq!(light["colors"]["palette.background"], "#fdf6e3");
    assert_eq!(light["colors"]["candles.upBody"], "#1f877f");
    let chart = call(&inv, "appearance.get_chart_theme", json!({})).await;
    assert_eq!(chart["colors"]["palette.background"], "#fdf6e3");

    let saved = call(&inv, "appearance.save_theme", json!({"name": "Night Desk"})).await;
    assert_eq!(saved["name"], "Night Desk");
    assert_eq!(saved["replaced"], false);
    assert_eq!(saved["theme"]["saved"]["name"], "Night Desk");
    assert_eq!(saved["theme"]["savedThemes"].as_array().unwrap().len(), 1);

    assert!(
        set(&inv, json!({"surfaces": {"ground": "#fffaf0"}}))
            .await
            .ok
    );
    let kept = call(&inv, "appearance.get_theme", json!({})).await;
    assert_eq!(kept["saved"]["name"], "Night Desk");
    assert_eq!(kept["colors"]["surfaces.ground"], "#fffaf0");
    assert_eq!(kept["overridden"], json!(["surfaces.ground"]));

    let r = set(&inv, json!({"ink": {"t3": "#eee8d5"}})).await;
    assert!(!r.ok);
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::InvalidInput);
    assert!(
        e.message
            .contains("ink.t3 #eee8d5 on surfaces.ground #fffaf0"),
        "{}",
        e.message
    );

    assert!(set(&inv, json!({"preset": "night-owl"})).await.ok);
    let owl = call(&inv, "appearance.get_theme", json!({})).await;
    assert_eq!(owl["saved"], Value::Null);
    assert_eq!(owl["colors"]["surfaces.ground"], "#011627");
    assert!(set(&inv, json!({"saved": "night desk"})).await.ok);
    let back = call(&inv, "appearance.get_theme", json!({})).await;
    assert_eq!(back["colors"]["surfaces.ground"], "#fffaf0");

    let renamed = call(
        &inv,
        "appearance.rename_theme",
        json!({"id": "Night Desk", "name": "Day Desk"}),
    )
    .await;
    assert_eq!(renamed["theme"]["saved"]["name"], "Day Desk");
    let gone = call(&inv, "appearance.delete_theme", json!({"id": "Day Desk"})).await;
    assert_eq!(gone["theme"]["saved"], Value::Null);
    assert_eq!(gone["theme"]["colors"]["surfaces.ground"], "#fffaf0");
    assert_eq!(gone["theme"]["savedThemes"], json!([]));
}

#[tokio::test]
async fn an_exported_theme_imports_and_a_built_in_cannot_be_renamed() {
    let (_rt, inv) = runtime().await;
    let out = call(
        &inv,
        "appearance.save_theme",
        json!({"name": "Shared", "theme": {"format": "tessera-theme", "name": "Owl", "theme": {"preset": "night-owl", "semantics": {"up": "#7fdbca"}}}}),
    )
    .await;
    assert_eq!(out["theme"]["preset"], "night-owl");
    assert_eq!(
        out["theme"]["value"],
        json!({"preset": "night-owl", "semantics": {"up": "#7fdbca"}})
    );
    let r = inv
        .invoke(InvokeRequest::new(
            "appearance.rename_theme",
            json!({"id": "nord", "name": "Mine"}),
            agent(),
        ))
        .await;
    assert!(!r.ok);
    let r = inv
        .invoke(InvokeRequest::new(
            "appearance.save_theme",
            json!({"name": "Bad", "theme": {"surfaces": {"ground": "#ffffff"}}}),
            agent(),
        ))
        .await;
    assert!(!r.ok);
    assert!(
        r.error
            .unwrap()
            .message
            .contains("on surfaces.ground #ffffff")
    );
}
