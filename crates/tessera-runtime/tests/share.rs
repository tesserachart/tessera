use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_broker::paper::{AccountSeed, default_seeds};
use tessera_cloud::{CloudError, NewShare, ShareBody, SharedLink, SharedSetup};
use tessera_core::accounts::Environment;
use tessera_core::ids::{CallId, SessionId};
use tessera_core::{Origin, Timestamp};
use tessera_protocol::agent::{
    AgentEvent, AgentEventEnvelope, AgentSessionStatus, AgentSessionSummary, TurnEnd,
};
use tessera_protocol::tools::{RiskTier, SessionMode, ToolOutcome};
use tessera_runtime::modules::share::ShareCloud;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{Invoker, SessionPolicy};

mod common;

use common::{call, call_user, try_call};

const BASE: &str = "https://account.example.test";

const CODE: &str = r#"export const indicator = {
  title: "Stretch",
  placement: "pane",
  inputs: { length: { type: "int", default: 20, min: 2, max: 500 } },
  plots: [{ name: "pct", kind: "histogram", colorBy: "sign" }],
};

export function compute(bars, inputs) {
  const ma = ta.sma(bars.close, inputs.length);
  return { pct: bars.close.map((c, i) => (100 * (c - ma[i])) / ma[i]) };
}
"#;

#[derive(Default)]
struct Cloud {
    down: AtomicBool,
    made: Mutex<Vec<(String, NewShare)>>,
}

impl Cloud {
    fn sent(&self) -> String {
        let made = self.made.lock().unwrap();
        made.iter()
            .map(|(_, s)| serde_json::to_string(s).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn last(&self) -> NewShare {
        self.made.lock().unwrap().last().unwrap().1.clone()
    }

    fn read(&self, id: &str) -> Result<SharedSetup, CloudError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(CloudError::Unreachable("connection refused".into()));
        }
        let gone = CloudError::Server {
            status: 404,
            code: Some("not_found".into()),
        };
        let made = self.made.lock().unwrap();
        let (_, share) = made.iter().find(|(i, _)| i == id).ok_or(gone.clone())?;
        match &share.body {
            ShareBody::Indicator(b) | ShareBody::Template(b) | ShareBody::Layout(b) => {
                Ok(SharedSetup {
                    id: id.into(),
                    kind: share.kind().into(),
                    title: share.title.clone(),
                    display: b.display.clone(),
                    setup: b.setup.clone(),
                })
            }
            _ => Err(gone),
        }
    }
}

#[async_trait]
impl ShareCloud for Cloud {
    fn available(&self) -> bool {
        true
    }

    async fn create(&self, share: &NewShare) -> Result<SharedLink, CloudError> {
        let mut made = self.made.lock().unwrap();
        let id = format!("Sh4re{:07}", made.len());
        made.push((id.clone(), share.clone()));
        Ok(SharedLink {
            url: format!("{BASE}/s/{id}"),
            id,
            kind: share.kind().into(),
            title: share.title.clone(),
            created_at: "2026-11-26T10:00:00.000Z".into(),
        })
    }

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError> {
        Ok(Vec::new())
    }

    async fn delete(&self, id: &str) -> Result<(), CloudError> {
        self.made.lock().unwrap().retain(|(i, _)| i != id);
        Ok(())
    }

    fn base(&self) -> Option<String> {
        Some(BASE.into())
    }

    async fn setup(&self, id: &str) -> Result<SharedSetup, CloudError> {
        self.read(id)
    }
}

struct SignedOut(Arc<Cloud>);

#[async_trait]
impl ShareCloud for SignedOut {
    fn available(&self) -> bool {
        false
    }

    async fn create(&self, _share: &NewShare) -> Result<SharedLink, CloudError> {
        Err(CloudError::SignedOut)
    }

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError> {
        Err(CloudError::SignedOut)
    }

    async fn delete(&self, _id: &str) -> Result<(), CloudError> {
        Err(CloudError::SignedOut)
    }

    fn base(&self) -> Option<String> {
        Some(BASE.into())
    }

    async fn setup(&self, id: &str) -> Result<SharedSetup, CloudError> {
        self.0.read(id)
    }
}

fn seeds() -> Vec<AccountSeed> {
    let mut s = default_seeds();
    s.push(AccountSeed {
        id: "eval-4821",
        name: "Funded Bob",
        environment: Environment::Eval,
        balance: Decimal::from(50_000),
        formerly: None,
    });
    s
}

async fn tessera(cloud: Arc<dyn ShareCloud>) -> (Runtime, Arc<Invoker>) {
    let rt = Runtime::build(
        RuntimeConfig {
            share_cloud: Some(cloud),
            paper_accounts: seeds(),
            ..RuntimeConfig::default()
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    (rt, inv)
}

async fn refused(inv: &Invoker, name: &str, input: Value) -> String {
    let e = try_call(inv, &Origin::User, name, input).await.unwrap_err();
    e["message"].as_str().unwrap().to_owned()
}

fn desk_dock() -> Value {
    json!({
        "grid": {"root": {"type": "branch", "size": 900, "data": [
            {"type": "leaf", "size": 450, "data": {"id": "1", "views": ["chart-1"], "activeView": "chart-1"}},
            {"type": "leaf", "size": 450, "data": {"id": "2", "views": ["chart-2"], "activeView": "chart-2"}},
            {"type": "leaf", "size": 300, "data": {"id": "3", "views": ["positions"], "activeView": "positions"}}
        ]}, "width": 1200, "height": 800, "orientation": "HORIZONTAL"},
        "panels": {
            "chart-1": {"id": "chart-1", "contentComponent": "chart", "title": "Chart 1",
                "params": {"layoutId": "default", "tileId": "chart-1", "ticket": {"account": "eval-4821", "qty": 3}}},
            "chart-2": {"id": "chart-2", "contentComponent": "chart", "title": "Chart 2",
                "params": {"layoutId": "default", "tileId": "chart-2"}},
            "positions": {"id": "positions", "contentComponent": "positions", "title": "Positions",
                "params": {"layoutId": "default", "accountId": "eval-4821", "link": "1"}}
        },
        "activeGroup": "1",
        "tessera": {"v": 5, "syncInterval": true,
            "popouts": [{"panelId": "dom", "kind": "dom", "bounds": {"x": 2560, "y": 0, "width": 800, "height": 600},
                "monitor": "DELL U2720Q", "params": {"accountId": "eval-4821"}}],
            "maximised": {"panelId": "chart-1"}}
    })
}

fn layers_of(chart: &Value) -> Vec<Value> {
    chart["layers"].as_array().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_indicator_template_and_workspace_travel_by_their_settings_into_another_tessera() {
    let cloud = Arc::new(Cloud::default());
    let (_a, inv) = tessera(Arc::clone(&cloud) as Arc<dyn ShareCloud>).await;
    let made = call_user(&inv, "indicators.create_custom", json!({ "code": CODE })).await;
    let ci = made["custom"]["id"].as_str().unwrap().to_owned();
    call_user(
        &inv,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "rsi", "id": "rsi-1", "params": {"inputs": {"length": 21}, "style": {"plots": {"rsi": {"color": "brass"}}}}}),
    )
    .await;
    call_user(
        &inv,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "custom", "id": "stretch-1", "params": {"indicator": ci, "inputs": {"length": 30}}}),
    )
    .await;
    call_user(
        &inv,
        "chart.save_template",
        json!({"tileId": "chart-1", "name": "Scalp"}),
    )
    .await;
    let agent = Origin::Agent {
        session_id: SessionId::new("S9"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    call(
        &inv,
        &agent,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "ema", "params": {"inputs": {"length": 9}}}),
    )
    .await;
    call_user(
        &inv,
        "chart.add_drawing",
        json!({"tileId": "chart-1", "kind": "horizontal_line", "points": [{"price": 21457.25}], "label": {"text": "Funded Bob stop"}}),
    )
    .await;
    call_user(
        &inv,
        "chart.annotate",
        json!({"tileId": "chart-1", "kind": "hline", "points": [{"price": 21433.5}], "label": "eval-4821 risk", "note": "2 contracts"}),
    )
    .await;
    call_user(
        &inv,
        "layout.save",
        json!({"layoutId": "default", "dock": desk_dock(), "trade": {"account": "eval-4821", "qty": 3}}),
    )
    .await;

    let rsi = call_user(
        &inv,
        "share.setup",
        json!({"kind": "indicator", "layoutId": "default", "tileId": "chart-1", "layerId": "rsi-1"}),
    )
    .await;
    assert_eq!(
        (rsi["kind"].as_str(), rsi["title"].as_str()),
        (Some("indicator"), Some("RSI"))
    );
    let custom = call_user(
        &inv,
        "share.setup",
        json!({"kind": "custom_indicator", "id": ci}),
    )
    .await;
    assert_eq!(custom["title"], "Stretch");
    let NewShare {
        body: ShareBody::Indicator(b),
        ..
    } = cloud.last()
    else {
        panic!("{:?}", cloud.last());
    };
    assert_eq!(
        b.setup["custom"][0]["code"], CODE,
        "a custom indicator's code travels"
    );
    assert_eq!(b.display["code"][0]["code"], CODE, "and is on its page");
    let template = call_user(
        &inv,
        "share.setup",
        json!({"kind": "template", "id": "scalp"}),
    )
    .await;
    assert_eq!(
        (template["kind"].as_str(), template["title"].as_str()),
        (Some("template"), Some("Scalp"))
    );
    let workspace = call_user(
        &inv,
        "share.setup",
        json!({"kind": "layout", "layoutId": "default"}),
    )
    .await;
    assert_eq!(workspace["kind"], "layout");

    let sent = cloud.sent();
    for secret in [
        "eval-4821",
        "4821",
        "Funded Bob",
        "accountId",
        "ticket",
        "popouts",
        "monitor",
        "DELL",
        "maximised",
        "21457.25",
        "21433.5",
        "contracts",
        "S9",
        "\"ema\"",
        "\"trade\"",
    ] {
        assert!(
            !sent.contains(secret),
            "{secret} left for the cloud: {sent}"
        );
    }

    let (_b, other) = tessera(Arc::new(SignedOut(Arc::clone(&cloud)))).await;
    assert_eq!(
        refused(
            &other,
            "share.setup",
            json!({"kind": "layout", "layoutId": "default"})
        )
        .await,
        "Sign in to Tessera to share."
    );

    let opened = call_user(
        &other,
        "share.open",
        json!({"url": format!(" {}/ ", rsi["url"].as_str().unwrap())}),
    )
    .await;
    assert_eq!(opened["kind"], "indicator");
    assert_eq!(opened["url"], rsi["url"]);
    assert_eq!(opened["display"]["name"], "RSI");
    let lines = opened["display"]["lines"].as_array().unwrap();
    assert!(
        lines.contains(&json!({"label": "Length", "value": "21"})),
        "{lines:?}"
    );
    assert!(
        lines.contains(&json!({"label": "RSI", "value": "#d8b26a"})),
        "{lines:?}"
    );
    let added = call_user(
        &other,
        "share.add",
        json!({"url": rsi["url"], "layoutId": "default", "tileId": "chart-1"}),
    )
    .await;
    assert_eq!(added["kind"], "indicator");
    let mine = layers_of(&added["chart"]["chart"]);
    let rsi_layer = mine.iter().find(|l| l["kind"] == "rsi").unwrap();
    assert_eq!(rsi_layer["params"]["inputs"]["length"], 21);
    assert_eq!(rsi_layer["namespace"], "user");
    assert!(rsi_layer.get("sessionId").is_none_or(Value::is_null));

    let opened = call_user(&other, "share.open", json!({"url": custom["url"]})).await;
    assert_eq!(opened["display"]["code"][0]["code"], CODE);
    assert_eq!(opened["display"]["about"], "Custom indicator");
    for _ in 0..2 {
        call_user(
            &other,
            "share.add",
            json!({"url": custom["url"], "tileId": "chart-2"}),
        )
        .await;
    }
    let list = call_user(&other, "indicators.list", json!({})).await;
    let customs = list["custom"].as_array().unwrap();
    assert_eq!(
        customs.len(),
        1,
        "a second import uses the indicator the first one made"
    );
    let theirs = customs[0]["id"].as_str().unwrap();
    assert_ne!(theirs, ci);
    let chart2 = call_user(&other, "chart.get_state", json!({"tileId": "chart-2"})).await;
    let stretch: Vec<Value> = layers_of(&chart2["chart"])
        .into_iter()
        .filter(|l| l["kind"] == "custom")
        .collect();
    assert_eq!(stretch.len(), 2);
    assert!(stretch.iter().all(|l| l["params"]["indicator"] == theirs));

    let added = call_user(
        &other,
        "share.add",
        json!({"url": template["url"], "tileId": "chart-2"}),
    )
    .await;
    assert_eq!(added["kind"], "template");
    let saved = added["templates"]["templates"].as_array().unwrap();
    let scalp = saved
        .iter()
        .find(|t| t["id"] == added["templateId"])
        .unwrap();
    assert_eq!(scalp["name"], "Scalp");
    let kinds: Vec<&str> = scalp["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["rsi", "custom"]);
    assert_eq!(added["applied"]["chart"]["tileId"], "chart-2");
    let again = call_user(&other, "share.add", json!({"url": template["url"]})).await;
    assert!(again["applied"].is_null(), "no chart named: only saved");
    let names: Vec<&str> = again["templates"]["templates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Scalp (2)"), "{names:?}");
    assert_eq!(
        call_user(&other, "indicators.list", json!({})).await["custom"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let before = call_user(&other, "layout.list", json!({})).await;
    let added = call_user(&other, "share.add", json!({"url": workspace["url"]})).await;
    assert_eq!(added["kind"], "layout");
    let layout = &added["layout"];
    let id = layout["id"].as_str().unwrap();
    assert!(id.starts_with("ws-"), "{id}");
    assert!(
        before["layouts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["id"] != id)
    );
    assert!(layout["trade"].is_null());
    let chart1 = &layout["charts"]["chart-1"];
    let kinds: Vec<String> = layers_of(chart1)
        .iter()
        .map(|l| l["kind"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds, ["rsi", "custom"]);
    assert!(
        chart1
            .get("drawings")
            .is_none_or(|d| d.as_array().is_some_and(Vec::is_empty))
    );
    assert!(chart1["annotations"].as_array().unwrap().is_empty());
    let panels = &layout["dock"]["panels"];
    assert_eq!(
        panels["positions"]["params"],
        json!({"layoutId": id, "link": "1"})
    );
    assert_eq!(
        panels["chart-1"]["params"],
        json!({"layoutId": id, "tileId": "chart-1"})
    );
    assert_eq!(
        layout["dock"]["tessera"],
        json!({"v": 5, "syncInterval": true})
    );
    let names: Vec<String> = call_user(&other, "layout.list", json!({})).await["layouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap().to_owned())
        .collect();
    let unique: std::collections::HashSet<&String> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "{names:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_from_anywhere_else_is_refused_in_plain_words() {
    let cloud = Arc::new(Cloud::default());
    let (_a, inv) = tessera(Arc::clone(&cloud) as Arc<dyn ShareCloud>).await;
    call_user(
        &inv,
        "chart.add_layer",
        json!({"tileId": "chart-1", "kind": "vwap", "id": "vwap-1"}),
    )
    .await;
    let link = call_user(
        &inv,
        "share.setup",
        json!({"kind": "indicator", "layoutId": "default", "tileId": "chart-1", "layerId": "vwap-1"}),
    )
    .await;
    let id = link["id"].as_str().unwrap();
    for url in [
        format!("http://account.example.test/s/{id}"),
        format!("https://evil.example.test/s/{id}"),
        format!("https://account.example.test/v1/shares/{id}"),
        format!("https://account.example.test/s/{id}/setup"),
        "https://account.example.test/s/short".to_owned(),
        "not a link".to_owned(),
    ] {
        for tool in ["share.open", "share.add"] {
            assert_eq!(
                refused(&inv, tool, json!({ "url": url })).await,
                "That link isn’t a Tessera share.",
                "{tool} {url}"
            );
        }
    }
    assert_eq!(
        refused(
            &inv,
            "share.open",
            json!({"url": format!("{BASE}/s/Sh4re9999999")})
        )
        .await,
        "That link doesn’t work any more."
    );
    cloud.down.store(true, Ordering::SeqCst);
    assert_eq!(
        refused(&inv, "share.add", json!({"url": link["url"]})).await,
        "Tessera Cloud can’t be reached. Try again in a moment."
    );
    cloud.down.store(false, Ordering::SeqCst);
    call_user(&inv, "share.delete", json!({ "id": id })).await;
    assert_eq!(
        refused(&inv, "share.open", json!({"url": link["url"]})).await,
        "That link doesn’t work any more."
    );
}

fn env(seq: u64, event: AgentEvent) -> AgentEventEnvelope {
    AgentEventEnvelope {
        session_id: SessionId::new("S15"),
        seq,
        ts: Timestamp(i64::try_from(seq).unwrap()),
        turn_id: Some("t1".into()),
        event,
    }
}

fn stored_session() -> (AgentSessionSummary, Vec<AgentEventEnvelope>) {
    let summary = AgentSessionSummary {
        id: SessionId::new("S15"),
        title: "Funded Bob morning".into(),
        preset: "Trader".into(),
        provider: "codex".into(),
        model: None,
        effort: None,
        thread: None,
        mode: SessionMode::Supervised,
        status: AgentSessionStatus::Idle,
        origin: Origin::Agent {
            session_id: SessionId::new("S15"),
            provider: "codex".into(),
        },
        source_label: None,
        created_at: Timestamp(1),
        updated_at: Timestamp(2),
        queue: Vec::new(),
        queue_held: false,
    };
    let call = CallId::new("call_1");
    let events = vec![
        env(1, AgentEvent::UserMessage { text: "How am I doing today?".into(), attachments: Vec::new() }),
        env(2, AgentEvent::TurnStarted { turn_id: "t1".into() }),
        env(
            3,
            AgentEvent::ToolCallStarted {
                call_id: call.clone(),
                tool: "portfolio.get_positions".into(),
                risk: RiskTier::Read,
                args: json!({"accountId": "eval-4821"}),
                title: Some("Positions on eval-4821".into()),
            },
        ),
        env(
            4,
            AgentEvent::ToolCallFinished {
                call_id: call,
                tool: "portfolio.get_positions".into(),
                risk: RiskTier::Read,
                outcome: ToolOutcome::Ok,
                result_summary: Some("3 contracts open".into()),
                artifact_refs: Vec::new(),
                duration_ms: 310.0,
                error: None,
                result: Some(r#"{"account":"eval-4821","qty":3,"openPnl":-85.5,"realizedPnl":1240.5}"#.into()),
            },
        ),
        env(
            5,
            AgentEvent::AssistantMessage {
                message_id: "m1".into(),
                text: "On Funded Bob you hold 3 contracts of NQ, P&L +$1,240.50 today, open -$85.50. NQ trades at 21,450.25, up 0.8%.".into(),
                blocks: Vec::new(),
            },
        ),
        env(
            6,
            AgentEvent::TurnFinished {
                turn_id: "t1".into(),
                end: TurnEnd::Completed,
                duration_ms: 4_000.0,
                tool_calls: 1,
            },
        ),
    ];
    (summary, events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shared_conversation_carries_no_account_size_or_amount() {
    let cloud = Arc::new(Cloud::default());
    let (rt, inv) = tessera(Arc::clone(&cloud) as Arc<dyn ShareCloud>).await;
    let (summary, events) = stored_session();
    let store = &rt.state().store;
    store.sessions().upsert(&summary).unwrap();
    for e in &events {
        store.agent_events().append(e).unwrap();
    }

    let page = call_user(
        &inv,
        "share.preview_conversation",
        json!({"sessionId": "S15"}),
    )
    .await;
    let text = page.to_string();
    for secret in [
        "eval-4821",
        "4821",
        "Funded Bob",
        "3 contracts",
        "1,240",
        "1240",
        "85.5",
        "qty",
        "openPnl",
    ] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    assert_eq!(page["title"], "[account] morning");
    assert_eq!(page["amounts"], false);
    assert_eq!(
        page["turns"][1]["work"][0],
        json!({"ns": "portfolio", "label": "Positions", "meta": "310 ms", "failed": false})
    );
    let answer = page["turns"][1]["answer"].as_str().unwrap();
    assert!(
        answer.contains("21,450.25") && answer.contains("0.8%"),
        "{answer}"
    );

    let shown = call_user(
        &inv,
        "share.preview_conversation",
        json!({"sessionId": "S15", "showPnl": true}),
    )
    .await;
    let text = shown.to_string();
    assert!(
        text.contains("$1,240.50") && text.contains("-$85.50"),
        "{text}"
    );
    for secret in ["eval-4821", "Funded Bob", "3 contracts", "qty"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }

    let link = call_user(&inv, "share.conversation", json!({"sessionId": "S15"})).await;
    assert_eq!(
        (link["kind"].as_str(), link["title"].as_str()),
        (Some("conversation"), Some("[account] morning"))
    );
    let NewShare {
        body: ShareBody::Conversation { conversation },
        ..
    } = cloud.last()
    else {
        panic!("{:?}", cloud.last());
    };
    assert_eq!(conversation, page, "the page is what the preview showed");
    assert_eq!(
        refused(
            &inv,
            "share.preview_conversation",
            json!({"sessionId": "S404"})
        )
        .await,
        "That conversation is gone."
    );
}
