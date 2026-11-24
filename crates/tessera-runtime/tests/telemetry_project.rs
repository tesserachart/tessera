use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::settle::settle;
use tessera_runtime::logging::Redactor;
use tessera_runtime::telemetry::Project;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::Invoker;

mod common;

use common::try_call_code;

async fn share(inv: &Invoker, answer: bool) {
    try_call_code(
        inv,
        &Origin::User,
        "settings.set",
        json!({"key": "telemetry.consent", "value": {"usage": answer}}),
    )
    .await
    .unwrap();
}

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

async fn fake_posthog_project() -> (String, Asked) {
    use axum::extract::OriginalUri;
    use axum::http::Method;
    let asked: Asked = Arc::default();
    let keep = Arc::clone(&asked);
    let app = Router::new().fallback(move |method: Method, uri: OriginalUri, body: Bytes| {
        let keep = Arc::clone(&keep);
        async move {
            let path = uri.0.to_string();
            keep.lock().push((
                format!("{method} {path}"),
                serde_json::from_slice(&body).unwrap_or(Value::Null),
            ));
            let answer = if path.starts_with("/flags") {
                json!({"flags": {
                    "survey-targeting-pmf": {"key": "survey-targeting-pmf", "enabled": true},
                    "experiment-x": {"key": "experiment-x", "enabled": true, "variant": "test"}
                }})
            } else if path.starts_with("/array/") {
                json!({"sessionRecording": {"endpoint": "/s/", "sampleRate": "1.00", "minimumDurationMilliseconds": 1000}})
            } else if path.starts_with("/api/surveys") {
                json!({"surveys": [{"id": "pmf", "name": "Alpha: how would you feel", "type": "api",
                    "start_date": "2026-10-31T00:00:00Z", "end_date": null,
                    "internal_targeting_flag_key": "survey-targeting-pmf",
                    "questions": [{"id": "q1", "type": "single_choice", "question": "How would you feel?",
                                   "choices": ["Very disappointed", "Somewhat disappointed", "Not disappointed"]}]}]})
            } else {
                json!({"status": 1})
            };
            answer.to_string()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, asked)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flags_replay_and_surveys_come_only_with_usage_and_recordings_leave_redacted() {
    let (host, asked) = fake_posthog_project().await;
    let dir = tempfile::tempdir().unwrap();
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(dir.path().to_path_buf()),
            agents: true,
            agent_providers: Some(vec![]),
            telemetry: Project {
                key: Some("phc_tessera_test".into()),
                host,
            },
            ..RuntimeConfig::default()
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let registered: Vec<&str> = inv.registry().names().collect();
    for t in tessera_runtime::telemetry::TRACKED {
        assert!(
            registered.contains(&t.tool),
            "{} is tracked but no such tool exists",
            t.tool
        );
    }

    let empty = json!({"asked": false, "flags": {}, "replay": null, "surveys": []});
    let config = try_call_code(&inv, &Origin::User, "telemetry.config", json!({}))
        .await
        .unwrap();
    assert_eq!(config, empty, "unanswered");
    share(&inv, false).await;
    let config = try_call_code(&inv, &Origin::User, "telemetry.config", json!({}))
        .await
        .unwrap();
    assert_eq!(config, empty, "answered No");
    assert!(asked.lock().is_empty(), "{:?}", asked.lock());

    share(&inv, true).await;
    let config = try_call_code(&inv, &Origin::User, "telemetry.config", json!({}))
        .await
        .unwrap();
    assert_eq!(config["asked"], true);
    assert_eq!(config["flags"]["experiment-x"], "test");
    assert_eq!(
        config["replay"],
        json!({"sampleRate": 1.0, "minimumDurationMs": 1000})
    );
    assert_eq!(config["surveys"][0]["id"], "pmf");
    assert_eq!(
        config["surveys"][0]["questions"][0]["kind"],
        "single_choice"
    );
    let install = std::fs::read_to_string(dir.path().join("telemetry-id")).unwrap();
    let flags_body = asked
        .lock()
        .iter()
        .find(|(what, _)| what.starts_with("POST /flags"))
        .map(|(_, body)| body.clone())
        .expect("flags were asked");
    assert_eq!(flags_body["distinct_id"], install.as_str());
    assert_eq!(flags_body["api_key"], "phc_tessera_test");

    Redactor::global().register_private("APEX-990011");
    let snapshot = json!({"events": [{
        "event": "$snapshot",
        "properties": {
            "$session_id": "0192f-session", "$window_id": "0192f-window", "token": "phc_window_placeholder",
            "$snapshot_data": [{"type": 2, "data": {"node": {"type": 3, "textContent": "APEX-990011 *****.**"}}}]
        }
    }]});
    let out = try_call_code(&inv, &Origin::User, "telemetry.capture", snapshot.clone())
        .await
        .unwrap();
    assert_eq!(out["sent"], 1);
    let recording = settle(
        "the recording reaches /s/",
        || {
            asked
                .lock()
                .iter()
                .find(|(what, _)| what.starts_with("POST /s/"))
                .map(|(_, body)| body.clone())
        },
        Option::is_some,
    )
    .await
    .expect("a recording reached /s/");
    let text = recording.to_string();
    assert!(!text.contains("APEX-990011"), "{text}");
    assert!(!text.contains("phc_window_placeholder"), "{text}");
    assert_eq!(recording[0]["properties"]["token"], "phc_tessera_test");
    assert_eq!(recording[0]["properties"]["distinct_id"], install.as_str());
    assert_eq!(recording[0]["properties"]["$session_id"], "0192f-session");

    share(&inv, false).await;
    let config = try_call_code(&inv, &Origin::User, "telemetry.config", json!({}))
        .await
        .unwrap();
    assert_eq!(config, empty, "turned off again");
    let before = asked.lock().len();
    let out = try_call_code(&inv, &Origin::User, "telemetry.capture", snapshot)
        .await
        .unwrap();
    assert_eq!(out["sent"], 0);
    rt.state().telemetry.flush().await;
    assert_eq!(asked.lock().len(), before);
}
