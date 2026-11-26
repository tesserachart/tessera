use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use serde_json::json;
use tessera_core::ids::CallId;
use tessera_core::{SystemClock, Timestamp};
use tessera_protocol::tools::ToolErrorInfo;

use super::*;

const ACCOUNT: &str = "rithmic-apex:APEX-1234567-01";
const LOGIN: &str = "jdoe-apex-login";
const PASSWORD: &str = "Zq81-hunter2-rithmic";

fn record(
    id: &str,
    at_secs: i64,
    tool: &str,
    input: Value,
    failed: Option<&str>,
) -> ToolCallRecord {
    ToolCallRecord {
        call_id: CallId::new(id),
        tool: tool.into(),
        risk: RiskTier::Financial,
        origin: Origin::User,
        session_id: None,
        input_hash: String::new(),
        input,
        status: if failed.is_some() {
            ToolCallStatus::Error
        } else {
            ToolCallStatus::Ok
        },
        started_at: Timestamp(1_790_000_000_000_000_000 + at_secs * 1_000_000_000),
        finished_at: None,
        duration_ms: None,
        error: failed.map(|m| ToolErrorInfo {
            code: tessera_protocol::tools::ToolErrorCode::Rejected,
            message: m.into(),
            details: None,
            retryable: false,
        }),
        approval_id: None,
        deduped: false,
        idempotency_key: None,
        summary: None,
        approved_by: None,
    }
}

fn leaky_records() -> Vec<ToolCallRecord> {
    vec![
        record(
            "c4",
            4,
            "orders.modify",
            json!({"accountId": ACCOUNT, "orderId": "ord_es", "stopPrice": 5990}),
            None,
        ),
        record(
            "c3",
            3,
            "orders.protect",
            json!({"accountId": ACCOUNT, "instrument": "NQZ6.CME", "mode": "per_entry", "steps": [{}, {}]}),
            Some(
                "Rithmic refused the modify for APEX-1234567-01 at wss://rprotocol.example-broker.com:443",
            ),
        ),
        record(
            "c2",
            2,
            "orders.cancel",
            json!({"accountId": ACCOUNT, "orderId": "ord_nq"}),
            None,
        ),
        record(
            "c1",
            1,
            "orders.submit",
            json!({"accountId": ACCOUNT, "instrument": "NQZ6.CME", "side": "buy", "qty": "1", "orderType": "limit", "limitPrice": "21450.25"}),
            None,
        ),
    ]
}

fn orders(id: &str) -> Option<String> {
    match id {
        "ord_nq" => Some("NQZ6.CME".into()),
        "ord_es" => Some("ESZ6.CME".into()),
        _ => None,
    }
}

fn scrubber() -> Scrubber {
    crate::logging::Redactor::global().register(PASSWORD);
    crate::logging::Redactor::global().register_private(LOGIN);
    Scrubber::new([ACCOUNT.to_owned(), "APEX-1234567-01".to_owned()])
}

fn assert_clean(what: &str, text: &str) {
    for secret in [
        ACCOUNT,
        "APEX-1234567",
        "1234567",
        LOGIN,
        PASSWORD,
        "hunter2",
        "rprotocol",
        "example-broker",
        "trader@example.test",
        "eyJ",
        "tss_",
        "/home/jdoe",
    ] {
        assert!(!text.contains(secret), "{what}: {secret} leaked in {text}");
    }
}

#[test]
fn the_focused_instruments_events_read_oldest_first_with_order_ids_resolved() {
    let lines = order_events(&leaky_records(), Some("NQZ6.CME-MOCK"), &orders);
    assert_eq!(lines.len(), 3, "{lines:#?}");
    assert!(
        lines[0].contains("orders.submit")
            && lines[0].contains("buy")
            && lines[0].contains("limit=21450.25")
    );
    assert!(lines[1].contains("orders.cancel") && lines[1].contains("NQZ6.CME"));
    assert!(
        lines[2].contains("orders.protect")
            && lines[2].contains("2 steps")
            && lines[2].contains("refused:")
    );
    assert!(lines.iter().all(|l| !l.contains("ESZ6")));
    assert_eq!(order_events(&leaky_records(), None, &orders).len(), 4);
}

#[test]
fn an_order_waiting_for_approval_is_listed_once_when_it_goes() {
    let input = json!({"instrument": "NQZ6.CME", "side": "buy", "qty": "1", "orderType": "market"});
    let mut waiting = record("c0", 0, "orders.submit", input.clone(), None);
    waiting.status = ToolCallStatus::PendingApproval;
    let went = record("c1", 1, "orders.submit", input, None);
    let lines = order_events(&[went, waiting], Some("NQ"), &orders);
    assert_eq!(lines.len(), 1, "{lines:#?}");
    assert!(lines[0].contains("  ok  "));
}

#[test]
fn a_held_lock_is_its_own_line_with_its_cause_and_end() {
    let until = Timestamp::parse("2026-10-02T22:00:00Z").unwrap();
    let facts = |lock| Facts {
        protect: Some(ProtectionMode::PerEntry),
        lock,
        ..Facts::default()
    };
    let line = |lock| {
        items(&facts(lock), &[], &[])
            .into_iter()
            .find(|i| i.key == "lock")
            .map(|i| i.value)
    };
    assert_eq!(line(None), None, "no line while nothing holds");
    assert_eq!(
        line(Some(LockFact {
            kind: LockKind::Manual,
            until
        }))
        .as_deref(),
        Some(
            "Locked by the trader: entries refused until 2026-10-02 22:00Z; exits, stops and targets work"
        )
    );
    assert_eq!(
        line(Some(LockFact {
            kind: LockKind::DailyLoss,
            until
        }))
        .as_deref(),
        Some("Daily loss limit reached: entries refused until 2026-10-02 22:00Z; exits work")
    );
}

#[test]
fn markets_match_by_root_and_contract_never_across_roots() {
    assert!(same_market("NQ", "NQZ6.CME"));
    assert!(same_market("NQZ6.CME-RITHMIC", "NQZ6.CME"));
    assert!(same_market("nqz26", "NQ"));
    assert!(!same_market("MNQZ6.CME", "NQZ6.CME"));
    assert!(!same_market("NQ", "NQXYZ"));
    assert!(!same_market("ES", "NQ"));
    assert!(!same_market("", "NQ"));
}

#[test]
fn the_context_names_kinds_never_the_account_and_redacts_every_line() {
    let s = scrubber();
    let facts = Facts {
        app: FeedbackApp {
            version: "0.2.0".into(),
            commit: Some("a4a9ad0".into()),
            shell: Some("desktop".into()),
        },
        system: "Linux · x86_64".into(),
        broker: Some(broker_words("rithmic-apex")),
        account: Some(Environment::Eval),
        protect: Some(ProtectionMode::PerEntry),
        lock: None,
        instrument: Some("NQZ6.CME".into()),
        timeframe: Some("5m".into()),
        private: Vec::new(),
    };
    let events = order_events(&leaky_records(), facts.instrument.as_deref(), &orders);
    let errors = vec![format!(
        "2026-10-02 18:42:00.000Z ERROR tessera_rithmic: login {LOGIN} with password={PASSWORD} to wss://rprotocol.example-broker.com failed"
    )];
    let got: Vec<FeedbackItem> = items(&facts, &events, &errors)
        .iter()
        .filter_map(|i| clean_item(i, &s))
        .collect();
    let keys: Vec<&str> = got.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "app", "system", "broker", "account", "protect", "chart", "orders", "errors"
        ]
    );
    let value = |k: &str| got.iter().find(|i| i.key == k).unwrap().value.clone();
    assert_eq!(value("broker"), "Rithmic");
    assert_eq!(value("account"), "Evaluation");
    assert!(value("app").starts_with("Tessera 0.2.0 (a4a9ad0)"));
    assert_eq!(value("chart"), "NQZ6.CME · 5m");
    assert_eq!(value("orders"), "The last 3 on NQZ6.CME");
    let all = serde_json::to_string(&got).unwrap();
    assert_clean("context", &all);
    assert!(all.contains("orders.protect"), "{all}");
}

fn leaky_send() -> FeedbackSendInput {
    FeedbackSendInput {
        kind: FeedbackKind::Bug,
        title: Some(format!("Stop did not move on {ACCOUNT}")),
        text: format!(
            "My stop on APEX-1234567-01 stayed put. Login {LOGIN}, password {PASSWORD}, mail trader@example.test.\nLogs in /home/jdoe/.local/share/tessera/logs"
        ),
        steps: vec![
            format!("Open {ACCOUNT}"),
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln".into(),
        ],
        expected: Some(
            "token=tss_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        ),
        actual: Some("It stayed at 21440".into()),
        written_up: true,
        context: vec![
            FeedbackItem {
                key: "orders".into(),
                label: "Order and protect events".into(),
                value: format!("on {ACCOUNT}"),
                detail: Some(format!(
                    "refused at wss://rprotocol.example-broker.com:443 for {ACCOUNT}"
                )),
            },
            FeedbackItem {
                key: "Bad Key!".into(),
                label: "dropped".into(),
                value: "dropped".into(),
                detail: None,
            },
        ],
        screenshot: Some(FeedbackScreenshotInput {
            mime_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        }),
        app: FeedbackApp {
            version: "0.2.0".into(),
            commit: None,
            shell: None,
        },
    }
}

#[test]
fn nothing_the_window_sends_leaves_with_a_credential_account_number_host_or_token() {
    let report = build_report(
        &leaky_send(),
        report_id(),
        "2026-10-02T18:42:00Z".into(),
        &scrubber(),
    )
    .unwrap();
    let mut wire = serde_json::to_value(&report).unwrap();
    wire["screenshot"] = Value::Null;
    assert_clean("report", &wire.to_string());
    assert_eq!(report.context.len(), 1, "a malformed key is dropped");
    assert_eq!(report.steps.len(), 2);
    assert!(report.written_up);
    assert!(report.text.contains("stayed put"));
    assert!(
        report.id.starts_with("fb-") && report.id.len() == 15,
        "{}",
        report.id
    );
}

#[test]
fn a_report_needs_words_and_a_real_picture() {
    let s = scrubber();
    let mut empty = leaky_send();
    empty.title = None;
    empty.text = "  \n ".into();
    assert!(build_report(&empty, report_id(), String::new(), &s).is_err());
    let mut not_png = leaky_send();
    not_png.screenshot = Some(FeedbackScreenshotInput {
        mime_type: "image/svg+xml".into(),
        data: "PHN2Zz4=".into(),
    });
    assert!(build_report(&not_png, report_id(), String::new(), &s).is_err());
    let mut untitled = leaky_send();
    untitled.title = None;
    let r = build_report(&untitled, report_id(), String::new(), &s).unwrap();
    assert!(
        r.title.starts_with("My stop on [account] stayed put."),
        "{}",
        r.title
    );
}

#[derive(Default)]
struct FakeCloud {
    up: AtomicBool,
    signed_in: AtomicBool,
    refuse: AtomicBool,
    filed: Mutex<Vec<FeedbackReport>>,
    tries: AtomicUsize,
}

#[async_trait]
impl FeedbackSink for FakeCloud {
    fn delivery(&self) -> FeedbackDelivery {
        if self.signed_in.load(Ordering::SeqCst) {
            FeedbackDelivery::Cloud
        } else {
            FeedbackDelivery::SignedOut
        }
    }

    async fn file(&self, report: &FeedbackReport) -> Result<FiledIssue, CloudError> {
        self.tries.fetch_add(1, Ordering::SeqCst);
        if self.refuse.load(Ordering::SeqCst) {
            return Err(CloudError::Server {
                status: 400,
                code: Some("bad_request".into()),
            });
        }
        if !self.up.load(Ordering::SeqCst) {
            return Err(CloudError::Unreachable("connection refused".into()));
        }
        let mut filed = self.filed.lock();
        filed.push(report.clone());
        Ok(FiledIssue {
            number: 100 + filed.len() as u64,
            url: "https://example.test/issues".into(),
        })
    }
}

fn service(
    cloud: &Arc<FakeCloud>,
    dir: &std::path::Path,
    agent: Option<Arc<dyn WriteUpAgent>>,
) -> Arc<FeedbackService> {
    FeedbackService::new(
        Some(dir.to_path_buf()),
        Arc::clone(cloud) as Arc<dyn FeedbackSink>,
        agent,
        None,
        Store::open_in_memory().unwrap(),
        Arc::new(SystemClock),
    )
}

fn plain_send(text: &str) -> FeedbackSendInput {
    FeedbackSendInput {
        kind: FeedbackKind::Bug,
        title: None,
        text: text.into(),
        steps: Vec::new(),
        expected: None,
        actual: None,
        written_up: false,
        context: Vec::new(),
        screenshot: None,
        app: FeedbackApp::default(),
    }
}

#[tokio::test]
async fn offline_a_report_is_queued_with_its_id_and_goes_once_cloud_is_back() {
    let dir = tempfile::tempdir().unwrap();
    let cloud = Arc::new(FakeCloud::default());
    cloud.signed_in.store(true, Ordering::SeqCst);
    let fb = service(&cloud, dir.path(), None);

    let out = fb
        .send(&plain_send("The DOM froze after a fill"))
        .await
        .unwrap();
    assert_eq!(out.status, FeedbackStatus::Queued);
    assert_eq!(out.delivery, FeedbackDelivery::Cloud);
    assert!(out.reason.unwrap().contains("can’t be reached"));
    assert!(out.id.starts_with("fb-"));
    assert_eq!(fb.queued().len(), 1);
    assert_eq!(fb.queued()[0].attempts, 1);

    assert_eq!(fb.deliver_due().await, 0, "it waits out its back-off");

    let restarted = service(&cloud, dir.path(), None);
    assert_eq!(restarted.queued().len(), 1, "the queue outlives a restart");
    cloud.up.store(true, Ordering::SeqCst);
    assert_eq!(restarted.deliver_due().await, 1);
    assert!(restarted.queued().is_empty());
    let filed = cloud.filed.lock().clone();
    assert_eq!(filed.len(), 1);
    assert_eq!(filed[0].id, out.id, "the same report, by its id");
    assert_eq!(restarted.deliver_due().await, 0, "sent once");
}

#[tokio::test]
async fn signed_out_nothing_is_tried_until_a_sign_in_and_a_refusal_is_set_aside() {
    let dir = tempfile::tempdir().unwrap();
    let cloud = Arc::new(FakeCloud::default());
    cloud.up.store(true, Ordering::SeqCst);
    let fb = service(&cloud, dir.path(), None);
    let out = fb.send(&plain_send("Idea: a wider DOM")).await.unwrap();
    assert_eq!(out.status, FeedbackStatus::Queued);
    assert_eq!(out.delivery, FeedbackDelivery::SignedOut);
    assert_eq!(fb.deliver_due().await, 0);
    assert_eq!(
        cloud.tries.load(Ordering::SeqCst),
        0,
        "no try while signed out"
    );

    cloud.signed_in.store(true, Ordering::SeqCst);
    assert_eq!(fb.deliver_due().await, 1);

    let sent = fb.send(&plain_send("Sent at once")).await.unwrap();
    assert_eq!(sent.status, FeedbackStatus::Sent);
    assert_eq!(sent.issue.unwrap().number, 102);

    cloud.refuse.store(true, Ordering::SeqCst);
    let refused = fb.send(&plain_send("Refused")).await.unwrap_err();
    assert!(refused.message.contains("refused"), "{}", refused.message);
    assert!(fb.queued().is_empty(), "a refused report is not retried");
    assert_eq!(
        std::fs::read_dir(dir.path().join("refused"))
            .unwrap()
            .count(),
        1
    );
}

struct FakeAgent {
    picks: Vec<WriteUpPick>,
    answer: String,
    refused: Option<&'static str>,
    asked: Mutex<Vec<(String, String)>>,
}

fn pick(provider: &str, name: &str, model: Option<&str>) -> WriteUpPick {
    WriteUpPick {
        writer: FeedbackWriter {
            provider: provider.into(),
            name: name.into(),
        },
        model: model.map(Into::into),
        effort: None,
    }
}

impl FakeAgent {
    fn claude(answer: &str) -> Self {
        Self {
            picks: vec![pick("claude-code", "Claude Code", Some("claude-opus-5-5"))],
            answer: answer.into(),
            refused: None,
            asked: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl WriteUpAgent for FakeAgent {
    fn picks(&self) -> Vec<WriteUpPick> {
        self.picks.clone()
    }

    async fn answer(
        &self,
        pick: &WriteUpPick,
        instructions: &str,
        text: String,
    ) -> Result<String, ToolError> {
        assert!(instructions.contains("Do not call any tool"));
        self.asked.lock().push((pick.writer.provider.clone(), text));
        if pick.model.as_deref() == self.refused {
            return Err(ToolError::unavailable(format!(
                "The '{}' model is not supported",
                self.refused.unwrap_or_default()
            )));
        }
        Ok(self.answer.clone())
    }
}

const WRITTEN: &str = "Here it is:\n```json\n{\"title\": \"Trailing stop stays put on APEX-1234567-01\", \"steps\": [\"Buy 1 NQ\", \"Price moves 10 points\"], \"expected\": \"The stop trails\", \"actual\": \"It stays\"}\n```";

fn write_up_input() -> FeedbackWriteUpInput {
    FeedbackWriteUpInput {
        kind: FeedbackKind::Bug,
        text: format!("stop didnt trail on {ACCOUNT}"),
        context: vec![FeedbackItem {
            key: "orders".into(),
            label: "Order and protect events".into(),
            value: "The last 2".into(),
            detail: Some("orders.protect error".into()),
        }],
    }
}

#[tokio::test]
async fn the_users_agent_writes_it_up_from_the_note_and_the_kept_facts() {
    let dir = tempfile::tempdir().unwrap();
    let cloud = Arc::new(FakeCloud::default());
    let agent = Arc::new(FakeAgent::claude(WRITTEN));
    let fb = service(
        &cloud,
        dir.path(),
        Some(Arc::clone(&agent) as Arc<dyn WriteUpAgent>),
    );
    let w = fb.write_up(&write_up_input()).await.unwrap();
    assert_eq!(w.title, "Trailing stop stays put on [account]");
    assert_eq!(w.steps, ["Buy 1 NQ", "Price moves 10 points"]);
    assert_eq!(w.expected, "The stop trails");
    assert_eq!(w.writer.name, "Claude Code");
    let (by, asked) = agent.asked.lock()[0].clone();
    assert_eq!(by, "claude-code");
    assert!(asked.contains("orders.protect error"));
    assert!(!asked.contains("1234567"), "{asked}");
    assert!(cloud.filed.lock().is_empty(), "writing up sends nothing");
}

#[tokio::test]
async fn without_a_connected_agent_or_a_readable_answer_there_is_no_write_up() {
    let dir = tempfile::tempdir().unwrap();
    let cloud = Arc::new(FakeCloud::default());
    let none = service(&cloud, dir.path(), None);
    assert!(none.write_up(&write_up_input()).await.is_err());
    assert_eq!(
        none.context(&FeedbackContextInput::default()).await.writer,
        None
    );

    let off = FakeAgent {
        picks: Vec::new(),
        ..FakeAgent::claude("")
    };
    let off = service(&cloud, dir.path(), Some(Arc::new(off)));
    assert!(off.write_up(&write_up_input()).await.is_err());
    assert_eq!(
        off.context(&FeedbackContextInput::default()).await.writer,
        None
    );

    let rambling = FakeAgent::claude("I could not find anything.");
    let rambling = service(&cloud, dir.path(), Some(Arc::new(rambling)));
    let e = rambling.write_up(&write_up_input()).await.unwrap_err();
    assert!(e.message.contains("not a write-up"), "{}", e.message);
}

#[tokio::test]
async fn a_model_the_account_cannot_run_falls_back_to_the_next_working_one() {
    let dir = tempfile::tempdir().unwrap();
    let cloud = Arc::new(FakeCloud::default());
    let agent = Arc::new(FakeAgent {
        picks: vec![
            pick("codex", "Codex", Some("gpt-6-astra")),
            pick("claude-code", "Claude Code", Some("claude-opus-5-5")),
        ],
        refused: Some("gpt-6-astra"),
        ..FakeAgent::claude(WRITTEN)
    });
    let fb = service(
        &cloud,
        dir.path(),
        Some(Arc::clone(&agent) as Arc<dyn WriteUpAgent>),
    );
    assert_eq!(
        fb.context(&FeedbackContextInput::default())
            .await
            .writer
            .map(|w| w.provider),
        Some("codex".into())
    );
    let w = fb.write_up(&write_up_input()).await.unwrap();
    assert_eq!(w.writer.name, "Claude Code");
    assert_eq!(w.expected, "The stop trails");
    let by: Vec<String> = agent.asked.lock().iter().map(|(p, _)| p.clone()).collect();
    assert_eq!(by, ["codex", "claude-code"]);

    let only = Arc::new(FakeAgent {
        picks: vec![pick("codex", "Codex", Some("gpt-6-astra"))],
        refused: Some("gpt-6-astra"),
        ..FakeAgent::claude(WRITTEN)
    });
    let fb = service(&cloud, dir.path(), Some(only as Arc<dyn WriteUpAgent>));
    let e = fb.write_up(&write_up_input()).await.unwrap_err();
    assert!(e.message.contains("not supported"), "{}", e.message);
}
