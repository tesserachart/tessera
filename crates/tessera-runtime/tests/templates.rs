use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::SessionPolicy;

mod common;

use common::call;

#[tokio::test]
async fn a_template_an_agent_applies_stays_the_users() {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let user = Origin::User;
    let agent = Origin::Agent {
        session_id: SessionId::new("S9"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    for (length, color) in [(9, "brass"), (21, "teal")] {
        call(
            &inv,
            &user,
            "chart.add_layer",
            json!({"tileId": "chart-2", "kind": "ema", "params":
                {"inputs": {"length": length}, "style": {"plots": {"ma": {"color": color}}}}}),
        )
        .await;
    }
    call(
        &inv,
        &user,
        "chart.save_template",
        json!({"tileId": "chart-2", "name": "Trend"}),
    )
    .await;
    let out = call(
        &inv,
        &agent,
        "chart.apply_template",
        json!({"tileId": "chart-1", "template": "Trend"}),
    )
    .await;
    let emas: Vec<&Value> = out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["kind"] == "ema")
        .collect();
    assert_eq!(emas.len(), 2, "{out}");
    for (l, color) in emas.iter().zip(["brass", "teal"]) {
        assert_eq!(l["namespace"], "user", "the user's own setup: {l}");
        assert_eq!(l["sessionId"], "S9", "who applied it is kept");
        assert_eq!(l["params"]["style"]["plots"]["ma"]["color"], color);
    }

    let out = call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "rsi", "params": {}}),
    )
    .await;
    let rsi = out["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["kind"] == "rsi")
        .cloned()
        .unwrap();
    assert_eq!(rsi["namespace"], "agent");
}
