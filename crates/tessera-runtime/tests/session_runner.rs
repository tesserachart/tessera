use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_agent::provider::{
    OpenThread, ProviderEvent, ProviderState, ProviderThread, TurnInput,
};
use tessera_agent::{AgentError, AgentProvider};
use tessera_broker::paper::{AccountSeed, test_seeds};
use tessera_core::health::HealthStatus;
use tessera_core::settle::settle_async;
use tessera_core::{Origin, Timestamp};
use tessera_protocol::agent::{AgentEvent, AgentModel, TurnEnd};
use tessera_protocol::cards::CardBody;
use tessera_runtime::session_runner::issues::IssueFiler;
use tessera_runtime::state::SharedState;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::{Fakes, ShiftedClock};
use tessera_tools::InvokeRequest;

const INSTRUCTIONS: &str = "MNQ and MES; risk per trade 20% of the drawdown left; good plays only.";

#[derive(Default)]
struct Filed(Mutex<Vec<(String, String, String)>>);

#[async_trait]
impl IssueFiler for Filed {
    async fn file(&self, repo: &str, title: &str, body: &str) -> Result<String, String> {
        let mut f = self.0.lock().unwrap();
        f.push((repo.into(), title.into(), body.into()));
        Ok(format!("https://github.com/{repo}/issues/{}", f.len()))
    }
}

type Heard = Arc<Mutex<Vec<String>>>;

struct Analyst {
    state: Arc<OnceLock<SharedState>>,
    heard: Heard,
}

#[async_trait]
impl AgentProvider for Analyst {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn name(&self) -> &'static str {
        "Codex"
    }

    fn state(&self) -> ProviderState {
        ProviderState::new(HealthStatus::Ok, "ready")
    }

    async fn connect(&self) -> ProviderState {
        self.state()
    }

    async fn models(&self) -> Vec<AgentModel> {
        Vec::new()
    }

    async fn open(&self, req: OpenThread) -> Result<Arc<dyn ProviderThread>, AgentError> {
        Ok(Arc::new(Thread {
            state: Arc::clone(&self.state),
            heard: Arc::clone(&self.heard),
            req,
        }))
    }
}

struct Thread {
    state: Arc<OnceLock<SharedState>>,
    heard: Heard,
    req: OpenThread,
}

async fn mcp(state: &SharedState, origin: &Origin, tool: &str, args: Value) -> (bool, Value) {
    let answer = state
        .mcp
        .handle(
            origin,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": tool, "arguments": args}}),
        )
        .await
        .unwrap();
    let r = &answer["result"];
    (r["isError"] != true, r["structuredContent"].clone())
}

impl Thread {
    async fn turn(&self, text: String) -> String {
        let n = {
            let mut heard = self.heard.lock().unwrap();
            heard.push(text.clone());
            heard.len()
        };
        let state = self.state.get().unwrap();
        let origin = state.principals.resolve(self.req.token.expose()).unwrap();
        if n == 1 {
            let (_, accounts) = mcp(state, &origin, "portfolio_get_accounts", json!({})).await;
            assert!(accounts["accounts"].is_array());
            let (ok, _) = mcp(state, &origin, "orders_submit", entry(3)).await;
            assert!(!ok, "3 contracts are over the account's max position");
            let (ok, out) = mcp(state, &origin, "orders_submit", entry(1)).await;
            assert!(ok, "the analyst's own order goes in full access: {out}");
            assert_eq!(out["order"]["status"], "filled", "{out}");
            let (ok, _) = mcp(
                state,
                &origin,
                "orders_cancel",
                json!({"accountId": "eval-50k", "orderId": "no-such-order"}),
            )
            .await;
            assert!(!ok);
            let (ok, alert) = mcp(
                state,
                &origin,
                "alerts_create",
                json!({"instrument": "NQ", "steps": [{"op": "above", "target": {"kind": "value", "value": 1}}],
                       "repeat": "every", "cooldownSecs": 600, "message": "any print",
                       "deliver": {"sound": false, "desktop": false, "discord": false}}),
            )
            .await;
            assert!(ok, "{alert}");
            assert_eq!(
                alert["askAnalyst"], true,
                "a trading session's alerts wake it"
            );
            let (ok, _) = mcp(
                state,
                &origin,
                "agent_wake_at",
                json!({"at": "2099-01-01T00:00:00Z", "note": "after the close-out"}),
            )
            .await;
            assert!(!ok, "a wake goes before the close-out");
            let (ok, wake) = mcp(
                state,
                &origin,
                "agent_wake_at",
                json!({"at": "2026-10-01T09:30:00-04:00", "note": "the New York open"}),
            )
            .await;
            assert!(ok, "{wake}");
            return "Long 1 NQ from the open drive, stop 40 ticks, target 80. Waiting on my alert."
                .into();
        }
        if text.contains("the session is over") {
            return "Bought 1 NQ at the open drive with a 10-point stop; held it to the wrap.\n\n## Friction\n- Quotes slow to arrive: the first quote took 2 s.\n".into();
        }
        if text.contains("the wake you set") {
            return "Woke on the clock: holding the long.".into();
        }
        "Alert seen: holding the long.".into()
    }
}

fn entry(qty: u32) -> Value {
    json!({
        "accountId": "eval-50k",
        "instrument": "NQ",
        "side": "buy",
        "qty": qty,
        "orderType": "market",
        "bracket": {"stopTicks": 40, "targetTicks": 80},
    })
}

#[async_trait]
impl ProviderThread for Thread {
    fn thread_id(&self) -> Option<String> {
        Some(format!("fake-{}", self.req.session))
    }

    async fn send(&self, turn: TurnInput) -> Result<(), AgentError> {
        let me = Thread {
            state: Arc::clone(&self.state),
            heard: Arc::clone(&self.heard),
            req: self.req.clone(),
        };
        tokio::spawn(async move {
            let answer = me.turn(turn.text).await;
            let sid = me.req.session.clone();
            let id = format!("m{}", me.heard.lock().unwrap().len());
            let _ = me.req.events.send((
                sid.clone(),
                ProviderEvent::Message {
                    message_id: id,
                    text: answer,
                },
            ));
            let _ = me.req.events.send((
                sid,
                ProviderEvent::TurnEnded {
                    end: TurnEnd::Completed,
                    error: None,
                    usage: None,
                },
            ));
        });
        Ok(())
    }

    async fn interrupt(&self) -> Result<bool, AgentError> {
        Ok(false)
    }

    async fn close(&self) {}
}

async fn user(state: &SharedState, tool: &str, input: Value) -> Value {
    let r = state
        .invoker
        .invoke(InvokeRequest::new(tool, input.clone(), Origin::User))
        .await;
    assert!(r.ok, "{tool} {input}: {r:?}");
    r.output.unwrap_or(Value::Null)
}

async fn until(state: &SharedState, what: &str, f: impl Fn(&Value) -> bool) -> Value {
    settle_async(what, || user(state, "agent.trading_session", json!({})), f).await
}

async fn start(at: &str, filed: Arc<Filed>, heard: Heard) -> (RuntimeHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let h = start_in(dir.path(), at, filed, heard).await;
    (h, dir)
}

async fn start_in(
    dir: &std::path::Path,
    at: &str,
    filed: Arc<Filed>,
    heard: Heard,
) -> RuntimeHandle {
    let cell: Arc<OnceLock<SharedState>> = Arc::new(OnceLock::new());
    let analyst = Arc::new(Analyst {
        state: Arc::clone(&cell),
        heard,
    });
    let build: tessera_agent::BuildProvider =
        Arc::new(move |_| Arc::clone(&analyst) as Arc<dyn AgentProvider>);
    let config = RuntimeConfig {
        agents: true,
        data_dir: Some(dir.join("data")),
        clock: Arc::new(ShiftedClock::starting_at(Timestamp::parse(at).unwrap())),
        paper_accounts: test_seeds()
            .into_iter()
            .map(|s| AccountSeed {
                balance: Decimal::from(50_000),
                ..s
            })
            .collect(),
        agent_providers: Some(vec![build]),
        issue_filer: Some(filed as Arc<dyn IssueFiler>),
        ..RuntimeConfig::default()
    };
    let fakes = Fakes {
        intraday_sessions: 2,
        tick: Some(Duration::from_millis(50)),
        ..Fakes::default()
    };
    let h = Runtime::build(config, vec![fakes.module()])
        .await
        .unwrap()
        .spawn();
    let _ = cell.set(Arc::clone(&h.state));
    h
}

fn eval_limits() -> Value {
    json!({"accounts": {"eval-50k": {
        "dailyLossLimit": 1000, "maxRiskPerTrade": 300, "maxPositionQty": 2,
        "maxOrderQty": 2, "maxTradesPerDay": 3,
    }}, "useFirmLimits": true})
}

async fn set_up(state: &SharedState, dir: &std::path::Path, account: &str, limits: Value) {
    let instructions = dir.join("analyst-instructions.md");
    std::fs::write(&instructions, INSTRUCTIONS).unwrap();
    for (key, value) in [
        ("agent.providers", json!({"codex": {"enabled": true}})),
        ("risk.limits", limits),
        (
            "agent.sessionRunner",
            json!({"enabled": true, "accountId": account, "provider": "codex",
                   "instructionsPath": instructions, "issuesRepo": "owner/repo"}),
        ),
    ] {
        user(state, "settings.set", json!({"key": key, "value": value})).await;
    }
}

#[tokio::test(start_paused = true)]
async fn the_analyst_trades_a_session_on_its_own_and_the_runner_reports_it() {
    let filed = Arc::new(Filed::default());
    let heard: Heard = Arc::default();
    let (h, dir) = start(
        "2026-10-01T16:49:20-04:00",
        Arc::clone(&filed),
        Arc::clone(&heard),
    )
    .await;
    let state = Arc::clone(&h.state);
    set_up(&state, dir.path(), "eval-50k", eval_limits()).await;

    let s = until(&state, "the session starts while the market is open", |s| {
        s["day"]["phase"] == "trading"
    })
    .await;
    assert_eq!(s["missing"], json!([]), "{s}");
    assert_eq!(s["day"]["accountId"], "eval-50k");
    assert_eq!(s["day"]["date"], "2026-10-01");
    assert_eq!(
        s["day"]["opensAt"],
        json!(Timestamp::parse("2026-09-30T18:00:00-04:00").unwrap().0)
    );
    assert_eq!(
        s["day"]["closesAt"],
        json!(Timestamp::parse("2026-10-01T17:00:00-04:00").unwrap().0)
    );
    let sid = s["day"]["sessionId"].as_str().unwrap().to_owned();

    let s = until(&state, "the session closes out and is reported", |s| {
        s["day"]["phase"] == "done"
    })
    .await;
    assert_eq!(s["day"]["sessionId"], sid.as_str());

    let heard = heard.lock().unwrap().clone();
    let opening = &heard[0];
    assert!(opening.contains(INSTRUCTIONS), "{opening}");
    assert!(opening.contains("Eval 50K (eval-50k), EVAL"), "{opening}");
    assert!(opening.contains("daily loss limit $1000.00"), "{opening}");
    assert!(opening.contains("at most 2 contracts held"), "{opening}");
    assert!(opening.contains("wake you"), "{opening}");
    assert!(
        opening.contains("up to its next break at Thu 1 Oct 17:00 (times are New York time)"),
        "{opening}"
    );
    assert!(
        opening.contains("At Thu 1 Oct 16:50 Tessera asks you to close out"),
        "{opening}"
    );
    assert!(
        heard
            .iter()
            .any(|t| t.contains("the wake you set") && t.contains("the New York open")),
        "its wake woke it: {heard:?}"
    );
    assert!(
        heard
            .iter()
            .any(|t| t.starts_with("Alert ") && t.contains("act on it")),
        "its alert woke it: {heard:?}"
    );
    assert!(
        heard.last().unwrap().contains("the session is over"),
        "{heard:?}"
    );

    let session = user(&state, "agent.list_sessions", json!({})).await;
    let mine = session["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == sid.as_str())
        .unwrap()
        .clone();
    assert_eq!(mine["mode"], "full_access", "{mine}");

    let positions = user(
        &state,
        "portfolio.get_positions",
        json!({"accountId": "eval-50k"}),
    )
    .await;
    let qty = |p: &Value| {
        p["qty"]
            .as_f64()
            .or_else(|| p["qty"].as_str().and_then(|q| q.parse().ok()))
            .unwrap_or(0.0)
    };
    assert!(
        positions["positions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| qty(p) == 0.0),
        "{positions}"
    );
    let alerts = user(&state, "alerts.list", json!({})).await;
    let a = &alerts["alerts"][0];
    assert_eq!(a["sessionId"], sid.as_str());
    assert_eq!(a["status"], "paused", "{a}");

    let events = state.store.agent_events().list(&sid, 0, u32::MAX).unwrap();
    let report = events
        .iter()
        .find_map(|e| match &e.event {
            AgentEvent::Card { card } => match &card.body {
                CardBody::TradingSession(r) => Some(r.clone()),
                CardBody::DataCoverage(_) => None,
            },
            _ => None,
        })
        .expect("the report card is in the conversation");
    assert_eq!(report.account_id, "eval-50k");
    assert_eq!(report.trades.len(), 1, "{report:?}");
    let t = &report.trades[0];
    assert_eq!(t.symbol, "NQ");
    assert_eq!(t.qty, 1.0);
    assert!(
        t.exit_price.is_some(),
        "closed by the runner at the close: {t:?}"
    );
    assert!(report.log.contains("10-point stop"), "{}", report.log);
    assert!(!report.log.contains("## Friction"));
    let titles: Vec<&str> = report.issues.iter().map(|i| i.title.as_str()).collect();
    assert!(
        titles.iter().any(|t| t.starts_with("orders.cancel")),
        "{titles:?}"
    );
    assert!(titles.contains(&"Quotes slow to arrive"), "{titles:?}");
    assert!(
        !titles.iter().any(|t| t.contains("contracts")),
        "the limits' own refusal is not an issue: {titles:?}"
    );
    assert!(report.issues.iter().all(|i| i.url.is_some()), "{report:?}");

    let filed = filed.0.lock().unwrap().clone();
    assert_eq!(filed.len(), report.issues.len());
    for (repo, title, body) in &filed {
        assert_eq!(repo, "owner/repo");
        assert!(title.starts_with("Analyst session: "), "{title}");
        assert!(
            !body.contains("eval-50k") && !body.contains("Eval 50K"),
            "{body}"
        );
    }

    let day = user(&state, "journal.get_day", json!({"date": "2026-10-01"})).await;
    let content = day["content"].as_str().unwrap();
    assert!(
        content.contains("### Analyst session · Eval 50K"),
        "{content}"
    );
    assert!(content.contains("| NQ | Long | 1 |"), "{content}");
    h.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn no_session_starts_on_an_evaluation_without_its_limits() {
    let filed = Arc::new(Filed::default());
    let (h, dir) = start(
        "2026-10-02T10:15:00-04:00",
        Arc::clone(&filed),
        Heard::default(),
    )
    .await;
    let state = Arc::clone(&h.state);
    let limits = json!({"accounts": {"eval-50k": {"dailyLossLimit": 1000}}});
    set_up(&state, dir.path(), "eval-50k", limits).await;
    let s = until(&state, "the day is skipped", |s| {
        s["day"]["phase"] == "skipped"
    })
    .await;
    let note = s["day"]["note"].as_str().unwrap();
    assert!(
        note.contains("a max position, a max risk per trade"),
        "{note}"
    );
    assert!(note.contains("Use my firm’s limits"), "{note}");
    assert!(s["day"]["sessionId"].is_null());
    let filed = filed.0.lock().unwrap().clone();
    assert_eq!(filed.len(), 1);
    assert_eq!(
        filed[0].1,
        "Analyst session: The trading session did not start"
    );

    let r = state
        .invoker
        .invoke(InvokeRequest::new(
            "agent.start_trading_session",
            json!({}),
            Origin::User,
        ))
        .await;
    assert!(!r.ok);
    assert!(
        r.error
            .unwrap()
            .message
            .contains("Settings › Trading and risk")
    );
    let day = user(&state, "journal.get_day", json!({"date": "2026-10-02"})).await;
    assert!(
        day["content"]
            .as_str()
            .unwrap()
            .contains("The session did not start")
    );
    h.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_session_opens_at_the_sunday_reopen_and_a_restart_after_midnight_carries_on() {
    let filed = Arc::new(Filed::default());
    let dir = tempfile::tempdir().unwrap();
    let h = start_in(
        dir.path(),
        "2026-10-25T17:59:56-04:00",
        Arc::clone(&filed),
        Heard::default(),
    )
    .await;
    let state = Arc::clone(&h.state);
    let s = user(&state, "agent.trading_session", json!({})).await;
    assert!(s["day"].is_null(), "{s}");
    set_up(&state, dir.path(), "eval-50k", eval_limits()).await;
    let s = until(&state, "the session starts at the reopen", |s| {
        s["day"]["phase"] == "trading"
    })
    .await;
    assert_eq!(
        s["day"]["date"], "2026-10-26",
        "Sunday evening trades Monday"
    );
    let started = s["day"]["startedAt"].as_i64().unwrap();
    assert!(started >= Timestamp::parse("2026-10-25T18:00:00-04:00").unwrap().0);
    let sid = s["day"]["sessionId"].clone();
    h.shutdown().await.unwrap();

    let h = start_in(
        dir.path(),
        "2026-10-26T02:00:00-04:00",
        Arc::clone(&filed),
        Heard::default(),
    )
    .await;
    let state = Arc::clone(&h.state);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let s = user(&state, "agent.trading_session", json!({})).await;
    assert_eq!(s["day"]["phase"], "trading", "{s}");
    assert_eq!(
        s["day"]["sessionId"], sid,
        "the same session carries on: {s}"
    );
    assert_eq!(s["day"]["startedAt"], json!(started));
    assert_eq!(
        s["day"]["closesAt"],
        json!(Timestamp::parse("2026-10-26T17:00:00-04:00").unwrap().0)
    );
    let r = state
        .invoker
        .invoke(InvokeRequest::new(
            "agent.start_trading_session",
            json!({}),
            Origin::User,
        ))
        .await;
    assert!(!r.ok);
    assert!(r.error.unwrap().message.contains("already running"));
    assert!(filed.0.lock().unwrap().is_empty());
    h.shutdown().await.unwrap();
}

const ALWAYS_LONG: &str = "export const strategy = { inputs: {} };\nexport function positions(bars) {\n  return new Float64Array(bars.length).fill(1);\n}\n";

#[tokio::test(start_paused = true)]
async fn a_session_trades_a_frozen_study_and_files_its_trades_under_the_studys_setup() {
    let filed = Arc::new(Filed::default());
    let heard: Heard = Arc::default();
    let (h, dir) = start(
        "2026-10-01T16:49:20-04:00",
        Arc::clone(&filed),
        Arc::clone(&heard),
    )
    .await;
    let state = Arc::clone(&h.state);
    let study = user(
        &state,
        "research.save_study",
        json!({"name": "Always long", "hypothesis": "NQ drifts up in the afternoon.",
               "data": {"instrument": "NQ", "tf": "1m"},
               "strategy": {"kind": "script", "code": ALWAYS_LONG}}),
    )
    .await;
    let study_id = study["id"].as_str().unwrap().to_owned();
    for (key, value) in [
        ("agent.providers", json!({"codex": {"enabled": true}})),
        ("risk.limits", eval_limits()),
        (
            "agent.sessionRunner",
            json!({"enabled": true, "accountId": "eval-50k", "provider": "codex",
                   "instructionsPath": dir.path().join("none.md"), "studyId": study_id}),
        ),
    ] {
        user(&state, "settings.set", json!({"key": key, "value": value})).await;
    }

    let s = until(
        &state,
        "a draft study keeps the session from starting",
        |s| s["day"]["phase"] == "skipped",
    )
    .await;
    let note = s["day"]["note"].as_str().unwrap();
    assert!(note.contains("Freeze the study Always long"), "{note}");
    assert!(
        !note.contains("instructions file"),
        "with a study the instructions file is optional: {note}"
    );

    user(&state, "research.freeze_study", json!({"id": study_id})).await;
    let signal = user(&state, "research.study_signal", json!({"id": study_id})).await;
    assert_eq!(signal["position"], 1.0, "{signal}");
    user(&state, "agent.start_trading_session", json!({})).await;
    until(&state, "the session trades the study", |s| {
        s["day"]["phase"] == "trading"
    })
    .await;
    until(&state, "the session closes out and is reported", |s| {
        s["day"]["phase"] == "done"
    })
    .await;

    let opening = heard.lock().unwrap()[0].clone();
    assert!(
        opening.contains("the Research study below decides what you trade."),
        "{opening}"
    );
    assert!(
        opening.contains("The strategy: the Research study \"Always long\""),
        "{opening}"
    );
    assert!(opening.contains("Now: long 1"), "{opening}");
    assert!(
        opening.contains("It has not been run on history yet"),
        "{opening}"
    );
    assert!(
        !opening.contains("standing instructions (from"),
        "{opening}"
    );

    let catalog = user(&state, "journal.get_catalog", json!({})).await;
    let setup = catalog["setups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["studyId"] == study_id.as_str())
        .expect("a setup linked to the study")
        .clone();
    assert_eq!(setup["name"], "Always long");
    let trades = user(
        &state,
        "journal.list_trades",
        json!({"filter": {"setups": [setup["id"]]}}),
    )
    .await;
    assert_eq!(trades["trades"].as_array().unwrap().len(), 1, "{trades}");
    let day = user(&state, "journal.get_day", json!({"date": "2026-10-01"})).await;
    assert!(
        day["content"]
            .as_str()
            .unwrap()
            .contains("Traded the Research study \"Always long\"."),
        "{day}"
    );
    h.shutdown().await.unwrap();
}
