use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{SessionMode, ToolErrorCode, ToolOutcome};
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-theme"),
        provider: "codex".into(),
    }
}

async fn runtime(mode: SessionMode) -> (Runtime, Arc<Invoker>) {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    inv.set_policy(&agent(), SessionPolicy::with_mode(mode));
    (rt, inv)
}

async fn call(inv: &Invoker, name: &str, input: Value) -> tessera_protocol::tools::ToolResult {
    inv.invoke(InvokeRequest::new(name, input, agent())).await
}

#[tokio::test]
async fn the_analyst_changes_any_chart_colour_and_reads_them_all() {
    let (_rt, inv) = runtime(SessionMode::AutoModify).await;
    let set = |value: Value| {
        let inv = Arc::clone(&inv);
        async move {
            call(
                &inv,
                "settings.set",
                json!({"key": "appearance.chartTheme", "value": value}),
            )
            .await
        }
    };
    let r = set(json!({"palette": {"background": "#101418"}})).await;
    assert!(r.ok, "{r:?}");
    let r = set(json!({"candles": {"upWick": "#ffffff"}, "canvas": {"gridVertical": "#ffffff10"}}))
        .await;
    assert!(r.ok, "{r:?}");
    let theme = call(&inv, "appearance.get_chart_theme", json!({})).await;
    assert!(theme.ok, "{theme:?}");
    let out = theme.output.unwrap();
    assert_eq!(out["colors"]["palette.background"], "#101418");
    assert_eq!(out["colors"]["candles.upWick"], "#ffffff");
    assert_eq!(out["colors"]["canvas.gridVertical"], "#ffffff10");
    assert_eq!(out["colors"]["candles.upBody"], "#2fd3b4");
    assert_eq!(
        out["overridden"],
        json!([
            "palette.background",
            "canvas.gridVertical",
            "candles.upWick"
        ])
    );
    assert_eq!(out["presets"].as_array().unwrap().len(), 4);

    let r = set(json!({"orders": {"stop": "#101418"}})).await;
    assert!(!r.ok);
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::InvalidInput);
    assert!(
        e.message.contains("orders.stop") && e.message.contains("3:1"),
        "{}",
        e.message
    );

    assert!(set(json!({"preset": "terminal"})).await.ok);
    let out = call(&inv, "appearance.get_chart_theme", json!({}))
        .await
        .output
        .unwrap();
    assert_eq!(out["preset"], "terminal");
    assert_eq!(out["colors"]["palette.background"], "#000000");
    assert_eq!(out["overridden"], json!([]));
    assert!(set(json!({"reset": true})).await.ok);
    let out = call(&inv, "appearance.get_chart_theme", json!({}))
        .await
        .output
        .unwrap();
    assert_eq!(out["preset"], "tessera");
    assert_eq!(out["value"], json!({}));
}

#[tokio::test]
async fn a_supervised_analyst_is_refused_an_unreadable_order_before_the_user_is_asked() {
    let (_rt, inv) = runtime(SessionMode::Supervised).await;
    let r = call(
        &inv,
        "settings.set",
        json!({"key": "appearance.chartTheme", "value": {"palette": {"background": "#ffffff"}}}),
    )
    .await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(r.status, ToolOutcome::Error);
    let e = r.error.unwrap();
    assert!(
        e.message.contains("orders.target") && e.message.contains("orders.position"),
        "{}",
        e.message
    );
    let r = call(
        &inv,
        "settings.set",
        json!({"key": "appearance.chartTheme", "value": {"canvas": {"gridVertical": "#ffffff10"}}}),
    )
    .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
}
