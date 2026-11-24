use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_alerts::WebhookSender;
use tessera_core::ids::SessionId;
use tessera_core::settle::{settle, settle_async};
use tessera_core::{Origin, Timestamp};
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::logging::Redactor;
use tessera_runtime::secrets::Secrets;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

const HOOK: &str = "https://discord.com/api/webhooks/1234567890/alerts-test-token_9Zq";
const TOKEN: &str = "alerts-test-token_9Zq";

#[derive(Default)]
struct FakeDiscord(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl WebhookSender for FakeDiscord {
    async fn post(&self, url: &str, body: &Value) -> Result<(), String> {
        self.0.lock().push((url.to_owned(), body.clone()));
        Ok(())
    }
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-alerts"),
        provider: "codex".into(),
    }
}

async fn start(dir: &Path, secrets: Secrets, discord: Arc<FakeDiscord>) -> RuntimeHandle {
    let config = RuntimeConfig {
        clock: Arc::new(ShiftedClock::starting_at(
            Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
        )),
        data_dir: Some(dir.to_path_buf()),
        secrets: Some(secrets),
        alert_webhooks: Some(discord),
        ..RuntimeConfig::default()
    };
    let h = Runtime::build(
        config,
        vec![
            Fakes {
                intraday_sessions: 1,
                tick: Some(Duration::from_millis(50)),
                ..Fakes::default()
            }
            .module(),
        ],
    )
    .await
    .unwrap()
    .spawn();
    h.state
        .invoker
        .set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));
    h
}

async fn invoke(
    inv: &Invoker,
    origin: Origin,
    name: &str,
    input: Value,
) -> Result<Value, (ToolErrorCode, String)> {
    let r = inv
        .invoke(InvokeRequest::new(name, input.clone(), origin))
        .await;
    match (r.ok, r.output, r.error) {
        (true, Some(out), _) => Ok(out),
        (_, _, Some(e)) => Err((e.code, e.message)),
        other => panic!("{name} {input}: {other:?}"),
    }
}

async fn user(inv: &Invoker, name: &str, input: Value) -> Value {
    invoke(inv, Origin::User, name, input.clone())
        .await
        .unwrap_or_else(|e| panic!("{name} {input}: {e:?}"))
}

async fn history(inv: &Invoker, alert: &str) -> Vec<Value> {
    let h = user(inv, "alerts.history", json!({"alertId": alert})).await;
    h["fires"].as_array().unwrap().clone()
}

async fn fired(inv: &Invoker, alert: &str, n: usize) -> Vec<Value> {
    settle_async(
        &format!("{alert} fires {n} times"),
        || history(inv, alert),
        |fires| fires.len() >= n,
    )
    .await
}

async fn alert_with_status(inv: &Invoker, id: &str, status: &str) -> Value {
    settle_async(
        &format!("{id} becomes {status}"),
        || alert(inv, id),
        |a| a["status"] == status,
    )
    .await
}

async fn alert(inv: &Invoker, id: &str) -> Value {
    let all = user(inv, "alerts.list", json!({})).await;
    all["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("no {id} in {all}"))
}

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files(&p));
        } else if let Ok(b) = std::fs::read(&p) {
            out.push((p.display().to_string(), b));
        }
    }
    out
}

fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[tokio::test(start_paused = true)]
async fn alerts_fire_on_the_feed_once_or_per_cooldown_and_post_to_discord() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let discord = Arc::new(FakeDiscord::default());
    let h = start(dir.path(), secrets.clone(), Arc::clone(&discord)).await;
    let inv = Arc::clone(&h.state.invoker);

    let (code, _) = invoke(&inv, agent(), "alerts.set_discord", json!({"url": HOOK}))
        .await
        .unwrap_err();
    assert_eq!(code, ToolErrorCode::PermissionDenied);
    let (code, msg) = invoke(
        &inv,
        Origin::User,
        "alerts.set_discord",
        json!({"url": "https://example.com/api/webhooks/1/x"}),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ToolErrorCode::InvalidInput);
    assert!(!msg.contains("example.com"), "{msg}");
    let set = user(&inv, "alerts.set_discord", json!({"url": HOOK})).await;
    assert_eq!(set, json!({"configured": true, "sent": false}));
    assert_eq!(user(&inv, "alerts.list", json!({})).await["discord"], true);
    user(
        &inv,
        "settings.set",
        json!({"key": "display.timeZone", "value": "Asia/Tokyo"}),
    )
    .await;

    let a = invoke(
        &inv,
        agent(),
        "alerts.create",
        json!({
            "instrument": "NQ",
            "steps": [{"op": "above", "target": {"kind": "value", "value": 1}}],
            "message": "first print",
            "deliver": {"sound": true, "desktop": true, "discord": true},
        }),
    )
    .await
    .unwrap();
    let id = a["id"].as_str().unwrap().to_owned();
    assert_eq!(a["title"], "NQ is above 1");
    assert_eq!(a["createdBy"], "agent");
    assert_eq!(a["status"], "active");
    let (code, _) = invoke(
        &inv,
        agent(),
        "alerts.update",
        json!({"id": id, "askAnalyst": true}),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ToolErrorCode::PermissionDenied);

    let fires = fired(&inv, &id, 1).await;
    let f = &fires[0];
    assert_eq!(f["source"], "Mock market", "{f}");
    assert!(f["price"].as_f64().unwrap() > 1.0);
    assert_eq!(f["target"], 1.0);
    assert_eq!(f["message"], "first print");
    let spent = alert_with_status(&inv, &id, "triggered").await;
    assert_eq!(spent["fireCount"], 1);
    let post = settle(
        "Discord gets the firing",
        || discord.0.lock().first().cloned(),
        Option::is_some,
    )
    .await;
    let (url, body) = post.expect("Discord got the firing");
    assert_eq!(url, HOOK);
    let content = body["content"].as_str().unwrap();
    assert!(
        content.starts_with("**NQ is above 1** at ") && content.contains(" JST\nfirst print"),
        "{content}"
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(fired(&inv, &id, 1).await.len(), 1);
    let re = user(&inv, "alerts.pause", json!({"id": id, "paused": false})).await;
    assert_eq!(re["status"], "active");
    assert_eq!(fired(&inv, &id, 2).await.len(), 2);

    let every = user(
        &inv,
        "alerts.create",
        json!({
            "instrument": "NQ",
            "steps": [{"op": "above", "target": {"kind": "value", "value": 1}}],
            "repeat": "every",
            "cooldownSecs": 1,
            "deliver": {"sound": false, "desktop": false, "discord": false},
        }),
    )
    .await;
    let eid = every["id"].as_str().unwrap();
    let first = fired(&inv, eid, 1).await;
    tokio::time::sleep(Duration::from_millis(2_600)).await;
    let later = fired(&inv, eid, 1).await;
    assert!(
        (2..=4).contains(&later.len()),
        "about one firing a second after {first:?}: {later:?}"
    );
    assert_eq!(alert(&inv, eid).await["status"], "active");
    let paused = user(&inv, "alerts.pause", json!({"id": eid})).await;
    assert_eq!(paused["status"], "paused");

    let levels = user(&inv, "intel.get_levels", json!({"instrument": "NQ"})).await;
    let level = levels["levels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["price"].is_number() || l["price"].is_string())
        .unwrap_or_else(|| panic!("a level: {levels}"))
        .clone();
    let target = json!({"kind": "level", "key": level["key"], "provider": levels["provider"], "label": level["label"]});
    let mut ids = Vec::new();
    for op in ["above", "below"] {
        let a = user(
            &inv,
            "alerts.create",
            json!({"instrument": "NQ", "steps": [{"op": op, "target": target}], "deliver": {"sound": true, "desktop": false, "discord": false}}),
        )
        .await;
        ids.push(a["id"].as_str().unwrap().to_owned());
    }
    let (watching, ids) = (&*inv, &ids);
    let level_fire = settle_async(
        "one of the level alerts fires",
        move || async move {
            let mut first = None;
            for id in ids {
                if let Some(f) = history(watching, id).await.into_iter().next() {
                    first = Some(f);
                }
            }
            first
        },
        Option::is_some,
    )
    .await;
    let lf = level_fire.expect("one of the level alerts fired");
    let level_price: f64 = match &level["price"] {
        Value::String(s) => s.parse().unwrap(),
        v => v.as_f64().unwrap(),
    };
    assert!(
        (lf["target"].as_f64().unwrap() - level_price).abs() < 1e-6,
        "{lf} {level}"
    );
    let watched = alert(&inv, &ids[0]).await;
    assert_eq!(
        watched["steps"][0]["target"]["key"], level["key"],
        "the vendor's own key"
    );

    let audited = settle(
        "four firings are audited",
        || {
            h.state
                .store
                .tool_calls()
                .recent(500, None)
                .unwrap()
                .iter()
                .filter(|r| r.tool == "alerts.fire")
                .count()
        },
        |&audited| audited >= 4,
    )
    .await;
    assert!(audited >= 4, "{audited} firings audited");

    let settings = serde_json::to_string(&h.state.settings.get(None).unwrap()).unwrap();
    assert!(!settings.contains(TOKEN));
    let audit =
        serde_json::to_string(&h.state.store.tool_calls().recent(500, None).unwrap()).unwrap();
    assert!(!audit.contains(TOKEN), "the audit log holds the webhook");
    assert!(
        audit.contains("alerts.set_discord"),
        "the agent's refused try is audited"
    );
    let reference = h
        .state
        .store
        .documents("alert_settings")
        .get("discord-webhook")
        .unwrap()
        .expect("the webhook's reference is kept");
    assert!(
        !reference.body.to_string().contains(TOKEN),
        "{:?}",
        reference.body
    );
    let line = format!("POST {HOOK} failed; token {TOKEN}");
    let logged = Redactor::global().redact(&line);
    assert!(!logged.contains(TOKEN), "{logged}");

    let off = user(&inv, "alerts.set_discord", json!({})).await;
    assert_eq!(off["configured"], false);
    let (code, msg) = invoke(&inv, Origin::User, "alerts.test_discord", json!({}))
        .await
        .unwrap_err();
    assert_eq!(code, ToolErrorCode::Unavailable, "{msg}");

    h.shutdown().await.unwrap();
    for (path, bytes) in files(dir.path()) {
        assert!(!contains(&bytes, TOKEN), "the webhook is in {path}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_sequence_fires_on_bar_closes_and_alerts_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let discord = Arc::new(FakeDiscord::default());
    let h = start(dir.path(), Secrets::in_memory(), Arc::clone(&discord)).await;
    let inv = Arc::clone(&h.state.invoker);

    let seq = user(
        &inv,
        "alerts.create",
        json!({
            "instrument": "NQ",
            "interval": "1s",
            "steps": [
                {"op": "above", "target": {"kind": "value", "value": 1}},
                {"op": "above", "target": {"kind": "value", "value": 1}, "on": "bar_close"},
            ],
            "withinBars": 3,
            "deliver": {"sound": true, "desktop": false, "discord": false},
        }),
    )
    .await;
    let sid = seq["id"].as_str().unwrap().to_owned();
    assert_eq!(
        seq["title"],
        "NQ is above 1, then a 1s bar closes above it within 3 bars"
    );
    let fires = fired(&inv, &sid, 1).await;
    assert!(
        fires[0]["barTime"].is_number() || fires[0]["barTime"].is_string(),
        "{}",
        fires[0]
    );
    alert_with_status(&inv, &sid, "triggered").await;

    let wait = user(
        &inv,
        "alerts.create",
        json!({
            "instrument": "NQ",
            "steps": [{"op": "crosses_below", "target": {"kind": "value", "value": 1}}],
            "expiresAt": "2099-01-01T00:00:00Z",
            "message": "kept",
        }),
    )
    .await;
    let wid = wait["id"].as_str().unwrap().to_owned();
    let paused = user(&inv, "alerts.pause", json!({"id": wid})).await;
    assert_eq!(paused["status"], "paused");
    for bad in [
        json!({"instrument": "NQ", "steps": []}),
        json!({"instrument": "NQ", "steps": [{"op": "above", "target": {"kind": "price"}}]}),
        json!({"instrument": "NQ", "steps": [{"subject": {"kind": "plot", "indicator": "ema", "plot": "ema"}, "op": "above", "target": {"kind": "value", "value": 1}}]}),
        json!({"instrument": "NQ", "steps": [{"op": "above", "target": {"kind": "value", "value": 1}}], "expiresAt": "2001-01-01T00:00:00Z"}),
    ] {
        let (code, _) = invoke(&inv, Origin::User, "alerts.create", bad.clone())
            .await
            .unwrap_err();
        assert_eq!(code, ToolErrorCode::InvalidInput, "{bad}");
    }
    h.shutdown().await.unwrap();

    let h = start(dir.path(), Secrets::in_memory(), discord).await;
    let inv = Arc::clone(&h.state.invoker);
    let s = alert(&inv, &sid).await;
    assert_eq!(s["status"], "triggered");
    assert_eq!(s["fireCount"], 1);
    let w = alert(&inv, &wid).await;
    assert_eq!(w["status"], "paused");
    assert_eq!(w["message"], "kept");
    assert_eq!(w["expiresAt"], wait["expiresAt"]);
    assert_eq!(fired(&inv, &sid, 1).await.len(), 1);
    let d = user(&inv, "alerts.delete", json!({"id": sid})).await;
    assert_eq!(d["deleted"], true);
    let h2 = user(&inv, "alerts.history", json!({"alertId": sid})).await;
    assert_eq!(h2["fires"], json!([]));
    let d = user(&inv, "alerts.delete", json!({"id": sid})).await;
    assert_eq!(d["deleted"], false);
    h.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn price_back_in_a_stacked_imbalance_fires_its_alert() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        dir.path(),
        Secrets::in_memory(),
        Arc::new(FakeDiscord::default()),
    )
    .await;
    let inv = Arc::clone(&h.state.invoker);
    let subject = json!({"kind": "stacked_imbalance", "side": "either", "ratio": 1.5, "minVolume": 1, "includeZero": true});
    let a = user(
        &inv,
        "alerts.create",
        json!({
            "instrument": "NQ",
            "interval": "1s",
            "steps": [{"subject": subject, "op": "at_least", "target": {"kind": "value", "value": 1}}],
            "repeat": "every",
            "cooldownSecs": 0,
            "deliver": {"sound": false, "desktop": false, "discord": false},
        }),
    )
    .await;
    let id = a["id"].as_str().unwrap().to_owned();
    assert_eq!(
        a["title"],
        "NQ returns to a stacked imbalance of at least 1 row"
    );
    let fires = fired(&inv, &id, 2).await;
    for f in &fires {
        assert!(f["side"] == "ask" || f["side"] == "bid", "{f}");
        assert!(
            f.get("size").is_none(),
            "a stack is not a size in contracts: {f}"
        );
        assert!(f["price"].as_f64().unwrap() > 1.0, "{f}");
    }
    assert_eq!(alert(&inv, &id).await["live"]["price"], Value::Null);

    let buy = json!({"kind": "stacked_imbalance", "side": "ask"});
    for bad in [
        json!([{"subject": buy, "op": "crosses", "target": {"kind": "value", "value": 3}}]),
        json!([{"subject": buy, "op": "at_least", "target": {"kind": "value", "value": 2.5}}]),
        json!([{"subject": buy, "op": "at_least", "target": {"kind": "value", "value": 0}}]),
        json!([{"subject": {"kind": "stacked_imbalance", "side": "ask", "ratio": 1}, "op": "at_least", "target": {"kind": "value", "value": 3}}]),
        json!([{"op": "crosses", "target": buy}]),
    ] {
        let (code, _) = invoke(
            &inv,
            Origin::User,
            "alerts.create",
            json!({"instrument": "NQ", "steps": bad}),
        )
        .await
        .unwrap_err();
        assert_eq!(code, ToolErrorCode::InvalidInput, "{bad}");
    }
    h.shutdown().await.unwrap();
}
