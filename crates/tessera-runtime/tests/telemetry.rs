use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::routing::post;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_core::settle::settle_async;
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::logging::Redactor;
use tessera_runtime::telemetry::Project;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::{Fakes, crash};
use tessera_tools::{Invoker, SessionPolicy};

mod common;

use common::try_call_code;

type Received = Arc<Mutex<Vec<Value>>>;

async fn fake_posthog() -> (String, Received) {
    let received: Received = Arc::default();
    let keep = Arc::clone(&received);
    let app = Router::new().fallback(post(move |body: Bytes| {
        let keep = Arc::clone(&keep);
        async move {
            if let Ok(v) = serde_json::from_slice::<Value>(&body) {
                keep.lock().push(v);
            }
            r#"{"status": 1}"#
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, received)
}

fn events(received: &Received) -> Vec<Value> {
    received
        .lock()
        .iter()
        .flat_map(|body| match body.get("batch") {
            Some(Value::Array(batch)) => batch.clone(),
            _ => vec![body.clone()],
        })
        .collect()
}

async fn consent(inv: &Invoker, change: Value) {
    try_call_code(
        inv,
        &Origin::User,
        "settings.set",
        json!({"key": "telemetry.consent", "value": change}),
    )
    .await
    .unwrap();
}

fn named(received: &Received, name: &str) -> Vec<Value> {
    events(received)
        .into_iter()
        .filter(|e| e["event"] == name)
        .collect()
}

async fn delivered(rt: &Runtime, received: &Received, names: &[&str]) {
    settle_async(
        &format!("{names:?} reach the fake PostHog"),
        move || async move {
            rt.state().telemetry.flush().await;
            let sent = events(received);
            names
                .iter()
                .filter(|name| sent.iter().any(|e| e["event"] == **name))
                .copied()
                .collect::<Vec<_>>()
        },
        |arrived| arrived.len() == names.len(),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fresh_install_reports_a_crash_at_once_off_stops_it_and_usage_waits_for_yes() {
    let (host, received) = fake_posthog().await;
    let dir = tempfile::tempdir().unwrap();
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(dir.path().to_path_buf()),
            telemetry: Project {
                key: Some("phc_tessera_test".into()),
                host,
            },
            ..RuntimeConfig::default()
        },
        vec![Fakes::still(1).module(), crash::crash_module()],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let token = tessera_core::token::mint(tessera_core::token::SESSION).unwrap();
    Redactor::global().register("rithmic-pw-sent-nowhere-9");
    Redactor::global().register_private("trader-login-77");
    let window_error = json!({"events": [{
        "event": "$exception",
        "properties": {
            "$current_url": format!("http://127.0.0.1:4100/?token={}", token.expose()),
            "$exception_list": [{"type": "Error", "value": "login rithmic-pw-sent-nowhere-9 for trader-login-77 on paper-main"}],
            "token": "phc_window_placeholder",
            "distinct_id": "window-made-this-up"
        }
    }]});
    let window_usage =
        json!({"events": [{"event": "area opened", "properties": {"area": "journal"}}]});

    let status = try_call_code(&inv, &Origin::User, "telemetry.status", json!({}))
        .await
        .unwrap();
    assert_eq!(status, json!({"available": true}));
    assert!(
        !inv.registry()
            .names()
            .any(|n| n == "telemetry.send_feedback"),
        "problem reports go through feedback.send, never PostHog"
    );
    let fresh = try_call_code(
        &inv,
        &Origin::User,
        "settings.get",
        json!({"keys": ["telemetry.consent"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        fresh["settings"]["telemetry.consent"]["value"],
        json!({"crashes": true, "usage": null})
    );
    let agent = Origin::Agent {
        session_id: SessionId::new("S-telemetry"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::FullAccess));
    for origin in [
        agent,
        Origin::External {
            client_id: "mcp-client".into(),
        },
    ] {
        for (tool, input) in [
            ("telemetry.capture", window_error.clone()),
            (
                "settings.set",
                json!({"key": "telemetry.consent", "value": {"usage": true}}),
            ),
        ] {
            assert_eq!(
                try_call_code(&inv, &origin, tool, input).await,
                Err(ToolErrorCode::PermissionDenied),
                "{tool} from {origin}"
            );
        }
    }

    let crashed = try_call_code(&inv, &Origin::User, "sim.crash", json!({}))
        .await
        .unwrap();
    assert_eq!(crashed, json!({"crashed": true}));
    delivered(&rt, &received, &["$exception"]).await;
    let panic = named(&received, "$exception")
        .into_iter()
        .find(|e| e.to_string().contains(crash::CRASH_MESSAGE))
        .expect("the panic's crash report");
    assert_eq!(panic["properties"]["$process_person_profile"], false);
    assert_eq!(
        panic["properties"]["build"],
        tessera_runtime::telemetry::build()
    );
    let out = try_call_code(
        &inv,
        &Origin::User,
        "telemetry.capture",
        window_error.clone(),
    )
    .await
    .unwrap();
    assert_eq!(out["sent"], 1, "the window's error is a crash report too");
    let out = try_call_code(
        &inv,
        &Origin::User,
        "telemetry.capture",
        window_usage.clone(),
    )
    .await
    .unwrap();
    assert_eq!(out["sent"], 0, "usage waits for the first-run answer");
    let telemetry = &rt.state().telemetry;
    let reports = &received;
    settle_async(
        "the window's error arrives",
        move || async move {
            telemetry.flush().await;
            named(reports, "$exception").len()
        },
        |&reports| reports >= 2,
    )
    .await;
    let install = std::fs::read_to_string(dir.path().join("telemetry-id")).unwrap();
    let window_report = named(&received, "$exception")
        .into_iter()
        .find(|e| {
            e["properties"]["$exception_list"].is_array()
                && !e.to_string().contains(crash::CRASH_MESSAGE)
        })
        .expect("the window's crash report");
    assert_eq!(window_report["distinct_id"], install.as_str());
    assert_eq!(
        window_report["properties"]["$process_person_profile"],
        false
    );
    assert_eq!(
        window_report["properties"]["$exception_list"][0]["value"],
        "login [redacted] for [private] on [private]"
    );
    let sent = events(&received);
    let text = serde_json::to_string(&sent).unwrap();
    for leak in [
        &token.expose()[4..],
        "rithmic-pw-sent-nowhere-9",
        "trader-login-77",
        "paper-main",
        "phc_window_placeholder",
        "window-made-this-up",
    ] {
        assert!(!text.contains(leak), "{leak} left the machine: {text}");
    }
    assert!(
        received
            .lock()
            .iter()
            .all(|b| b["api_key"] == "phc_tessera_test")
    );
    assert!(
        sent.iter().all(|e| e["event"] == "$exception"),
        "nothing but crash reports before the first-run answer: {sent:?}"
    );

    consent(&inv, json!({"crashes": false})).await;
    let before = events(&received).len();
    let crashed = try_call_code(&inv, &Origin::User, "sim.crash", json!({}))
        .await
        .unwrap();
    assert_eq!(crashed, json!({"crashed": true}));
    let out = try_call_code(
        &inv,
        &Origin::User,
        "telemetry.capture",
        window_error.clone(),
    )
    .await
    .unwrap();
    assert_eq!(out["sent"], 0, "crash reports turned off");
    rt.state().telemetry.flush().await;
    assert_eq!(events(&received).len(), before, "{:?}", events(&received));

    consent(&inv, json!({"usage": false})).await;
    let out = try_call_code(
        &inv,
        &Origin::User,
        "telemetry.capture",
        window_usage.clone(),
    )
    .await
    .unwrap();
    assert_eq!(out["sent"], 0, "answered No");
    rt.state().telemetry.flush().await;
    assert_eq!(events(&received).len(), before);

    consent(&inv, json!({"usage": true})).await;
    let out = try_call_code(&inv, &Origin::User, "telemetry.capture", window_usage)
        .await
        .unwrap();
    assert_eq!(out["sent"], 1, "usage after the Yes");
    delivered(&rt, &received, &["area opened"]).await;
    let out = try_call_code(&inv, &Origin::User, "telemetry.capture", window_error)
        .await
        .unwrap();
    assert_eq!(out["sent"], 0, "crash reports stay off with usage on");
    rt.state().telemetry.flush().await;
    assert!(
        events(&received)[before..]
            .iter()
            .all(|e| e["event"] != "$exception")
    );
}
