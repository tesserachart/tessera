use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUg==";

#[derive(Default)]
struct FakeCloud {
    signed_out: AtomicBool,
    sent: Mutex<Vec<NewShare>>,
    links: Mutex<Vec<SharedLink>>,
    down: AtomicBool,
}

#[async_trait]
impl ShareCloud for FakeCloud {
    fn available(&self) -> bool {
        !self.signed_out.load(Ordering::SeqCst)
    }

    async fn create(&self, share: &NewShare) -> Result<SharedLink, CloudError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(CloudError::Unreachable("connection refused".into()));
        }
        self.sent.lock().unwrap().push(share.clone());
        let mut links = self.links.lock().unwrap();
        let id = format!("Ab3dE6gH9jK{}", links.len());
        let link = SharedLink {
            url: format!("https://account.example.test/s/{id}"),
            id,
            kind: share.kind().to_owned(),
            title: share.title.clone(),
            created_at: "2026-11-23T10:00:00.000Z".into(),
        };
        links.insert(0, link.clone());
        Ok(link)
    }

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError> {
        Ok(self.links.lock().unwrap().clone())
    }

    async fn delete(&self, id: &str) -> Result<(), CloudError> {
        let mut links = self.links.lock().unwrap();
        let before = links.len();
        links.retain(|l| l.id != id);
        if links.len() == before {
            return Err(CloudError::Server {
                status: 404,
                code: Some("not_found".into()),
            });
        }
        Ok(())
    }

    fn base(&self) -> Option<String> {
        Some("https://account.example.test".into())
    }

    async fn setup(&self, _id: &str) -> Result<SharedSetup, CloudError> {
        Err(CloudError::Server {
            status: 404,
            code: Some("not_found".into()),
        })
    }
}

fn service() -> (Arc<ShareService>, Arc<FakeCloud>) {
    let cloud = Arc::new(FakeCloud::default());
    (
        ShareService::new(Arc::clone(&cloud) as Arc<dyn ShareCloud>),
        cloud,
    )
}

fn chart(data: &str, mime_type: &str) -> ShareChartInput {
    ShareChartInput {
        image: ShareImageInput {
            mime_type: mime_type.into(),
            data: data.into(),
            width: 1600,
            height: 900,
        },
        instrument: Some("NQZ6.CME".into()),
        timeframe: Some("5m".into()),
    }
}

#[tokio::test]
async fn a_chart_is_shared_listed_and_deleted() {
    let (s, cloud) = service();
    let link = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap();
    assert_eq!(link.title, "NQZ6.CME · 5m");
    assert_eq!(
        link.url,
        format!("https://account.example.test/s/{}", link.id)
    );
    let sent = cloud.sent.lock().unwrap()[0].clone();
    let ShareBody::Chart { width, height, .. } = sent.body else {
        panic!("{sent:?}");
    };
    assert_eq!((sent.kind(), width, height), ("chart", 1600, 900));

    let listed = s.list().await.unwrap();
    assert!(listed.available);
    assert_eq!(listed.shares, vec![link.clone()]);

    s.delete(&ShareDeleteInput {
        id: link.id.clone(),
    })
    .await
    .unwrap();
    assert!(s.list().await.unwrap().shares.is_empty());
    let again = s
        .delete(&ShareDeleteInput { id: link.id })
        .await
        .unwrap_err();
    assert_eq!(again.message, "That link is already gone.");
}

#[tokio::test]
async fn signed_out_nothing_is_sent_and_the_list_says_sharing_is_off() {
    let (s, cloud) = service();
    cloud.signed_out.store(true, Ordering::SeqCst);
    let e = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap_err();
    assert_eq!(e.message, "Sign in to Tessera to share.");
    assert!(cloud.sent.lock().unwrap().is_empty());
    let listed = s.list().await.unwrap();
    assert!(!listed.available && listed.shares.is_empty());
}

#[tokio::test]
async fn only_a_real_picture_goes() {
    let (s, cloud) = service();
    for (data, mime_type) in [
        (PNG_BASE64, "image/svg+xml"),
        ("PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+", "image/png"),
        (PNG_BASE64, "image/jpeg"),
        ("not base64!", "image/png"),
    ] {
        assert!(
            s.chart(&chart(data, mime_type)).await.is_err(),
            "{mime_type} {data}"
        );
    }
    assert!(cloud.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreachable_cloud_says_so_in_plain_words() {
    let (s, cloud) = service();
    cloud.down.store(true, Ordering::SeqCst);
    let e = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap_err();
    assert_eq!(
        e.message,
        "Tessera Cloud can’t be reached. Try again in a moment."
    );
}

#[test]
fn the_title_names_the_chart_and_nothing_private() {
    assert_eq!(chart_title(Some("ESZ6.CME"), Some("1m")), "ESZ6.CME · 1m");
    assert_eq!(chart_title(None, None), "Chart");
    assert_eq!(chart_title(Some("  "), Some("5m")), "5m");
    assert_eq!(
        chart_title(Some("APEX-1234567-01"), None),
        "[account]",
        "an account id never reaches a public title"
    );
}

#[tokio::test]
async fn a_delete_takes_only_a_share_id() {
    let (s, _cloud) = service();
    for id in ["", "../admin", "a/b", "id with space"] {
        assert!(
            s.delete(&ShareDeleteInput { id: id.into() }).await.is_err(),
            "{id:?}"
        );
    }
}

mod links {
    use super::super::import::{retargeted, share_id, share_url};
    use serde_json::json;

    const BASE: &str = "https://account.example.test";

    #[test]
    fn only_this_tesseras_own_share_links_open() {
        for pasted in [
            "https://account.example.test/s/Ab3dE6gH9jK0",
            "  https://account.example.test/s/Ab3dE6gH9jK0/ ",
            "https://Account.Example.Test/s/Ab3dE6gH9jK0?utm=x",
            "HTTPS://account.example.test/s/Ab3dE6gH9jK0#top",
        ] {
            assert_eq!(
                share_id(pasted, BASE).as_deref(),
                Some("Ab3dE6gH9jK0"),
                "{pasted}"
            );
        }
        for pasted in [
            "http://account.example.test/s/Ab3dE6gH9jK0",
            "https://evil.example.test/s/Ab3dE6gH9jK0",
            "https://account.example.test.evil.test/s/Ab3dE6gH9jK0",
            "https://user@account.example.test/s/Ab3dE6gH9jK0",
            "https://account.example.test:8443/s/Ab3dE6gH9jK0",
            "https://account.example.test/s/Ab3dE6gH9jK0/setup",
            "https://account.example.test/s/Ab3dE6gH9jK",
            "https://account.example.test/s/Ab3dE6gH9jK0x",
            "https://account.example.test/x/Ab3dE6gH9jK0",
            "https://account.example.test/s/../v1/shar",
            "https://account.example.test/s/Ab3dE6gH9j-0",
            "account.example.test/s/Ab3dE6gH9jK0",
            "Ab3dE6gH9jK0",
            "",
        ] {
            assert_eq!(share_id(pasted, BASE), None, "{pasted}");
        }
        assert_eq!(
            share_id(
                "https://example.test/cloud/s/Ab3dE6gH9jK0",
                "https://example.test/cloud/"
            )
            .as_deref(),
            Some("Ab3dE6gH9jK0")
        );
        assert_eq!(
            share_url("https://account.example.test/", "Ab3dE6gH9jK0"),
            "https://account.example.test/s/Ab3dE6gH9jK0"
        );
    }

    #[test]
    fn an_imported_dock_points_at_its_new_workspace() {
        let dock = json!({"panels": {
            "chart-1": {"id": "chart-1", "params": {"layoutId": "default", "tileId": "chart-1"}},
            "dom": {"id": "dom", "params": {"link": "1"}},
        }});
        let moved = retargeted(&dock, "ws-1");
        assert_eq!(moved["panels"]["chart-1"]["params"]["layoutId"], "ws-1");
        assert!(moved["panels"]["dom"]["params"].get("layoutId").is_none());
    }
}

mod conversations {
    use serde_json::json;
    use tessera_core::Timestamp;
    use tessera_core::ids::{CallId, SessionId};
    use tessera_protocol::agent::{
        AgentEvent, AgentEventEnvelope, Attachment, AttachmentKind, ContentBlock, Epistemic,
        TurnEnd,
    };
    use tessera_protocol::tools::{RiskTier, ToolOutcome};

    use super::super::contract::{SharedConversation, SharedTurn};
    use super::super::conversation::{self, UNTITLED, fold, title_of};
    use super::super::words::ShareWords;

    fn env(seq: u64, event: AgentEvent) -> AgentEventEnvelope {
        AgentEventEnvelope {
            session_id: SessionId::new("S15"),
            seq,
            ts: Timestamp(i64::try_from(seq).unwrap()),
            turn_id: Some("t1".into()),
            event,
        }
    }

    fn started(seq: u64, call: &str, tool: &str, title: Option<&str>) -> AgentEventEnvelope {
        env(
            seq,
            AgentEvent::ToolCallStarted {
                call_id: CallId::new(call),
                tool: tool.into(),
                risk: RiskTier::Read,
                args: json!({"accountId": "APEX-1234567-01", "qty": 2}),
                title: title.map(str::to_owned),
            },
        )
    }

    fn finished(
        seq: u64,
        call: &str,
        tool: &str,
        outcome: ToolOutcome,
        ms: f64,
    ) -> AgentEventEnvelope {
        env(
            seq,
            AgentEvent::ToolCallFinished {
                call_id: CallId::new(call),
                tool: tool.into(),
                risk: RiskTier::Read,
                outcome,
                result_summary: Some("2 contracts, +$1,240.50".into()),
                artifact_refs: Vec::new(),
                duration_ms: ms,
                error: None,
                result: Some(r#"{"account":"APEX-1234567-01","qty":2,"pnl":1240.5}"#.into()),
            },
        )
    }

    fn block(kind: Epistemic, call: &str, text: &str) -> ContentBlock {
        ContentBlock {
            kind,
            title: Some("From a tool".into()),
            text: text.into(),
            source_call_id: Some(CallId::new(call)),
            rows: vec![("Value".into(), "21,450.25".into())],
        }
    }

    fn session() -> Vec<AgentEventEnvelope> {
        vec![
            env(
                1,
                AgentEvent::UserMessage {
                    text: "How is APEX-1234567-01 doing? I am long 2 NQ.".into(),
                    attachments: vec![Attachment {
                        kind: AttachmentKind::Image,
                        label: "statement-APEX-1234567-01.png".into(),
                        reference: None,
                        id: Some("att_1".into()),
                        mime_type: Some("image/png".into()),
                        size_bytes: Some(10),
                    }],
                },
            ),
            env(2, AgentEvent::TurnStarted { turn_id: "t1".into() }),
            started(3, "c1", "portfolio.get_positions", Some("Positions on APEX-1234567-01")),
            finished(4, "c1", "portfolio.get_positions", ToolOutcome::Ok, 420.0),
            started(5, "c2", "chart.get_state", Some("Read chart context")),
            finished(6, "c2", "chart.get_state", ToolOutcome::Error, 1_234.0),
            env(
                7,
                AgentEvent::AssistantDelta {
                    message_id: "m1".into(),
                    text: "Looking".into(),
                },
            ),
            env(
                8,
                AgentEvent::AssistantMessage {
                    message_id: "m1".into(),
                    text: "You are long 2 NQ on APEX-1234567-01, P&L +1,240 so far. NQ holds 21,450.25."
                        .into(),
                    blocks: vec![
                        block(Epistemic::Measured, "c1", "qty 2, P&L $1,240.50"),
                        block(Epistemic::Observed, "c2", "Above VWAP 21,432.50"),
                    ],
                },
            ),
            env(
                9,
                AgentEvent::ReasoningSummary {
                    text: "the hidden reasoning".into(),
                    duration_ms: Some(10.0),
                },
            ),
            env(
                10,
                AgentEvent::TurnFinished {
                    turn_id: "t1".into(),
                    end: TurnEnd::Completed,
                    duration_ms: 12_000.0,
                    tool_calls: 2,
                },
            ),
        ]
    }

    fn shared(amounts: bool) -> SharedConversation {
        let words = ShareWords::new(["APEX-1234567-01".to_owned()], amounts);
        let titles = |t: &str| match t {
            "portfolio.get_positions" => "Positions".to_owned(),
            other => conversation::spoken_title(other),
        };
        fold(
            &session(),
            title_of("Morning read", &words),
            &words,
            &titles,
        )
    }

    #[test]
    fn a_conversation_reads_as_the_desk_folds_it_without_what_tools_saw() {
        let c = shared(false);
        assert_eq!(
            (c.v, c.title.as_str(), c.amounts),
            (1, "Morning read", false)
        );
        assert_eq!(c.turns.len(), 2);
        let SharedTurn::User { text, files } = &c.turns[0] else {
            panic!("{:?}", c.turns[0]);
        };
        assert_eq!(*files, 1);
        assert_eq!(text, "How is [account] doing? I am long [size] NQ.");
        let SharedTurn::Analyst {
            work,
            worked_ms,
            answer,
            blocks,
        } = &c.turns[1]
        else {
            panic!("{:?}", c.turns[1]);
        };
        assert_eq!(*worked_ms, Some(12_000));
        assert_eq!(work.len(), 2);
        assert_eq!(
            (
                work[0].ns.as_str(),
                work[0].label.as_str(),
                work[0].meta.as_deref(),
                work[0].failed
            ),
            ("portfolio", "Positions", Some("420 ms"), false),
            "an account tool keeps its own title, never the agent's words"
        );
        assert_eq!(
            (
                work[1].label.as_str(),
                work[1].meta.as_deref(),
                work[1].failed
            ),
            ("Read chart context", Some("1.2 s"), true)
        );
        assert_eq!(
            answer,
            "You are long [size] NQ on [account], P&L [amount] so far. NQ holds 21,450.25."
        );
        assert_eq!(
            blocks.len(),
            1,
            "the block from an account tool is left out"
        );
        assert_eq!(blocks[0].text, "Above VWAP 21,432.50");
        assert_eq!(
            blocks[0].rows,
            vec![("Value".to_owned(), "21,450.25".to_owned())]
        );
        let page = serde_json::to_string(&c).unwrap();
        for secret in [
            "1234567",
            "1,240",
            "1240",
            "statement",
            "accountId",
            "qty",
            "hidden reasoning",
            "att_1",
        ] {
            assert!(!page.contains(secret), "{secret} in {page}");
        }
    }

    #[test]
    fn amounts_show_when_asked_and_sizes_and_accounts_still_do_not() {
        let page = serde_json::to_string(&shared(true)).unwrap();
        assert!(page.contains("P&L +1,240 so far"), "{page}");
        for secret in ["1234567", "long 2", "qty 2"] {
            assert!(!page.contains(secret), "{secret} in {page}");
        }
    }

    #[test]
    fn an_untitled_conversation_gets_a_plain_title_and_a_long_one_is_cut_to_fit() {
        let words = ShareWords::new(Vec::new(), false);
        assert_eq!(title_of("  ", &words), UNTITLED);
        let mut events = Vec::new();
        for n in 0..450u64 {
            events.push(env(
                n * 2 + 1,
                AgentEvent::UserMessage {
                    text: "x".repeat(30_000),
                    attachments: Vec::new(),
                },
            ));
            events.push(env(
                n * 2 + 2,
                AgentEvent::AssistantMessage {
                    message_id: format!("m{n}"),
                    text: "y".repeat(70_000),
                    blocks: Vec::new(),
                },
            ));
        }
        let c = fold(&events, "Long".into(), &words, &conversation::spoken_title);
        assert!(c.turns.len() <= 400);
        assert!(serde_json::to_vec(&c).unwrap().len() < conversation::MAX_BODY);
        let Some(SharedTurn::Analyst { answer, .. }) = c.turns.last() else {
            panic!("the newest turns are kept");
        };
        assert!(answer.chars().count() <= 60_000);
        let Some(SharedTurn::User { text, .. }) = c.turns.iter().rev().nth(1) else {
            panic!();
        };
        assert!(text.chars().count() <= 20_000);
    }
}

mod setups {
    use std::collections::{BTreeMap, HashMap};

    use serde_json::{Value, json};
    use tessera_core::ids::SessionId;
    use tessera_core::{InstrumentId, Timeframe, Timestamp};
    use tessera_protocol::layers::LayerKind;
    use tessera_protocol::layout::{
        Annotation, AnnotationKind, ChartLayer, ChartState, Layout, OverlayNamespace,
    };

    use super::super::setup::{
        self, CustomSource, Customs, PortableSetup, SWATCHES, colour_hex, read,
    };
    use crate::modules::feedback::Scrubber;

    const CODE: &str = "export const indicator = { title: \"Stretch\" };";

    fn layer(id: &str, kind: &str, params: Value) -> ChartLayer {
        ChartLayer {
            id: id.into(),
            kind: kind.into(),
            params,
            visible: true,
            namespace: OverlayNamespace::User,
            session_id: None,
        }
    }

    fn chart(tile: &str, layers: Vec<ChartLayer>) -> ChartState {
        ChartState {
            tile_id: tile.into(),
            title: "Chart 1".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            timeframe: Timeframe::M5,
            print_bars: None,
            layers,
            annotations: Vec::new(),
            viewport: None,
            link_group: Some("1".into()),
            chart_type: None,
            hours: None,
            drawings: Vec::new(),
            drawings_from: Vec::new(),
        }
    }

    fn customs() -> Customs {
        let mut spec = LayerKind::Rsi.indicator().unwrap();
        spec.kind = LayerKind::Custom;
        spec.title = "Stretch".into();
        spec.short = "Stretch".into();
        HashMap::from([(
            ("ci_x".to_owned(), None),
            CustomSource {
                name: "Stretch".into(),
                code: CODE.into(),
                spec,
            },
        )])
    }

    fn scrubber() -> Scrubber {
        Scrubber::new(["APEX-1234567-01".to_owned(), "Funded Bob".to_owned()])
    }

    fn desk() -> Layout {
        let mut agent = layer("ema-1", "ema", json!({"inputs": {"length": 9}}));
        agent.namespace = OverlayNamespace::Agent;
        let mut applied = layer("vwap-1", "vwap", json!({}));
        applied.session_id = Some(SessionId::new("S9"));
        let mut c1 = chart(
            "chart-1",
            vec![
                layer("rsi-1", "rsi", json!({"inputs": {"length": 21}})),
                agent,
                applied,
                layer(
                    "custom-1",
                    "custom",
                    json!({"indicator": "ci_x", "inputs": {"length": 21}}),
                ),
                layer("lv", "levels", json!({"group": "pd"})),
            ],
        );
        c1.annotations.push(Annotation {
            id: "a1".into(),
            kind: AnnotationKind::Hline,
            namespace: OverlayNamespace::Agent,
            session_id: None,
            instrument: None,
            label: Some("Stop for Funded Bob".into()),
            note: Some("risking 2 contracts".into()),
            points: Vec::new(),
            style: None,
            created_at: Timestamp(1),
        });
        Layout {
            id: "default".into(),
            name: "Day on APEX-1234567-01".into(),
            revision: 3,
            updated_at: Timestamp(1),
            active_chart_id: Some("chart-1".into()),
            dock: json!({
                "grid": {"root": {"type": "branch", "size": 900, "data": [
                    {"type": "leaf", "size": 600, "data": {"id": "1", "views": ["chart-1"], "activeView": "chart-1", "stray": "x"}},
                    {"type": "leaf", "size": 300, "data": {"id": "2", "views": ["positions"], "activeView": "positions"}}
                ]}, "width": 900, "height": 600, "orientation": "HORIZONTAL"},
                "panels": {
                    "chart-1": {"id": "chart-1", "contentComponent": "chart", "title": "Chart 1",
                        "params": {"layoutId": "default", "tileId": "chart-1", "ticket": {"account": "APEX-1234567-01", "qty": 3}}},
                    "positions": {"id": "positions", "contentComponent": "positions", "title": "Positions · Funded Bob",
                        "params": {"layoutId": "default", "accountId": "APEX-1234567-01", "link": "1"}}
                },
                "activeGroup": "1",
                "popoutGroups": [{"data": {"id": "9", "views": ["dom"]}, "position": {"left": 3000, "top": 0, "width": 400, "height": 800}, "url": "/popout"}],
                "tessera": {"v": 5, "preset": "2h", "syncInterval": true,
                    "popouts": [{"panelId": "chart-3", "kind": "chart", "bounds": {"x": 2560, "y": 0, "width": 800, "height": 600}, "monitor": "DELL U2720Q"}],
                    "closed": [{"panelId": "journal", "kind": "journal", "place": {"direction": "left"}}],
                    "maximised": {"panelId": "chart-1"}, "open": [{"id": "open-1"}]}
            }),
            charts: BTreeMap::from([
                ("chart-1".to_owned(), c1),
                (
                    "chart-3".to_owned(),
                    chart("chart-3", vec![layer("rsi-1", "rsi", json!({}))]),
                ),
            ]),
            trade: json!({"account": "APEX-1234567-01", "qty": 3}),
            unsaved: false,
        }
    }

    #[test]
    fn a_workspace_goes_as_its_charts_and_arrangement_only() {
        let built = setup::layout(&desk(), &customs(), &scrubber());
        let display = setup::display(&built);
        let payload = format!(
            "{}{}",
            serde_json::to_string(&built.setup).unwrap(),
            serde_json::to_string(&display).unwrap()
        );
        for secret in [
            "1234567",
            "Funded Bob",
            "accountId",
            "ticket",
            "trade",
            "popout",
            "monitor",
            "DELL",
            "bounds",
            "closed",
            "journal",
            "maximised",
            "open-1",
            "stray",
            "chart-3",
            "S9",
            "Stop for",
            "contracts",
            "3000",
            "\"ema\"",
            "\"levels\"",
            "annotations",
            "drawings",
            "viewport",
        ] {
            assert!(!payload.contains(secret), "{secret} in {payload}");
        }
        let PortableSetup::Layout {
            name,
            active_chart_id,
            charts,
            dock,
            custom,
            ..
        } = &built.setup
        else {
            panic!("{:?}", built.setup);
        };
        assert_eq!(name, "Day on [account]");
        assert_eq!(active_chart_id.as_deref(), Some("chart-1"));
        assert_eq!(
            charts.len(),
            1,
            "a chart with no place on the desk stays home"
        );
        let kinds: Vec<LayerKind> = charts[0].layers.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            [LayerKind::Rsi, LayerKind::Custom],
            "the user's own indicators only"
        );
        assert_eq!(charts[0].layers[1].params["indicator"], "custom:0");
        assert!(charts[0].layers[1].params.get("version").is_none());
        assert_eq!(
            custom,
            &vec![setup::PortableCustom {
                name: "Stretch".into(),
                code: CODE.into()
            }]
        );
        let dock = dock.as_ref().unwrap();
        assert_eq!(
            dock["panels"]["positions"]["params"],
            json!({"layoutId": "default", "link": "1"})
        );
        assert_eq!(
            dock["panels"]["positions"]["title"],
            "Positions · [account]"
        );
        assert_eq!(
            dock["tessera"],
            json!({"v": 5, "preset": "2h", "syncInterval": true})
        );
        assert_eq!(
            dock["grid"]["root"]["data"][0]["data"]["views"],
            json!(["chart-1"])
        );
        assert_eq!(display.about, "Workspace · 1 chart");
        assert_eq!(display.parts[0].name, "NQZ6 · 5m");
        assert_eq!(display.parts[0].lines[0].value, "RSI 21, Stretch 21");
        assert_eq!(display.code[0].code, CODE, "the code is on the page");
    }

    #[test]
    fn an_indicator_reads_as_its_settings_with_colours_in_hex() {
        let built = setup::indicator(
            LayerKind::Rsi,
            &json!({"inputs": {"length": 14}, "style": {"plots": {"rsi": {"color": "brass"}}}}),
            &customs(),
            &scrubber(),
        )
        .unwrap();
        let d = setup::display(&built);
        assert_eq!((d.name.as_str(), d.about.as_str()), ("RSI", "Indicator"));
        let line = |label: &str| {
            d.lines
                .iter()
                .find(|l| l.label == label)
                .map(|l| l.value.clone())
        };
        assert_eq!(line("Length").as_deref(), Some("14"));
        assert_eq!(line("RSI").as_deref(), Some("#d8b26a"));
        assert!(d.lines.iter().all(|l| !l.value.contains("brass")));
        assert!(d.code.is_empty());
        let custom = setup::indicator(
            LayerKind::Custom,
            &json!({"indicator": "ci_x", "version": 1}),
            &HashMap::from([(
                ("ci_x".to_owned(), Some(1)),
                customs().remove(&("ci_x".to_owned(), None)).unwrap(),
            )]),
            &scrubber(),
        )
        .unwrap();
        let d = setup::display(&custom);
        assert_eq!(
            (d.name.as_str(), d.about.as_str()),
            ("Stretch", "Custom indicator")
        );
        assert_eq!(d.code[0].code, CODE);
        assert!(
            setup::indicator(
                LayerKind::Levels,
                &json!({"group": "pd"}),
                &customs(),
                &scrubber()
            )
            .is_none()
        );
    }

    #[test]
    fn colours_read_as_hex_from_the_desks_own_swatches() {
        assert_eq!(colour_hex("brass"), "#d8b26a");
        assert_eq!(colour_hex("#ABC"), "#aabbcc");
        assert_eq!(colour_hex("#11223344"), "#112233");
        for (swatch, _) in SWATCHES {
            let hex = colour_hex(swatch);
            assert!(hex.len() == 7 && hex.starts_with('#'), "{swatch}: {hex}");
        }
        let desk = include_str!("../../../../../apps/desktop/src/chart/chartTheme.ts");
        for (swatch, path) in SWATCHES {
            let shown = if swatch == "t4" {
                format!("css('{path}')")
            } else {
                format!("{swatch}: css('{path}')")
            };
            assert!(desk.contains(&shown), "the desk draws {swatch} as {path}");
        }
    }

    #[test]
    fn a_shared_setup_is_read_strictly() {
        let built = setup::layout(&desk(), &customs(), &scrubber());
        let value = serde_json::to_value(&built.setup).unwrap();
        let back = read("layout", value.clone()).unwrap();
        assert_eq!(back, built.setup, "reading what was built changes nothing");
        assert!(
            read("template", value.clone()).is_err(),
            "a link of another kind"
        );
        let mut bad = value.clone();
        bad["charts"][0]["layers"][0]["extra"] = json!(1);
        assert!(read("layout", bad).is_err(), "an unknown field");
        let mut bad = value.clone();
        bad["charts"][0]["layers"][0]["params"]["inputs"]["length"] = json!(0);
        assert!(read("layout", bad).is_err(), "settings out of range");
        let mut bad = value.clone();
        bad["charts"][0]["layers"][1]["params"]["indicator"] = json!("custom:1");
        assert!(read("layout", bad).is_err(), "code the link does not bring");
        let mut bad = value.clone();
        bad["charts"][0]["layers"][1]["params"]["indicator"] = json!("ci_someone_elses");
        assert!(
            read("layout", bad).is_err(),
            "an indicator id of another Tessera"
        );
        let mut bad = value.clone();
        bad["charts"][0]["tileId"] = json!("../x");
        assert!(read("layout", bad).is_err(), "a tile id");
        let mut bad = value.clone();
        bad["v"] = json!(2);
        assert!(read("layout", bad).is_err(), "a newer format");
        let mut bad = value;
        bad["charts"][0]["layers"][0]["kind"] = json!("levels");
        assert!(read("layout", bad).is_err(), "not an indicator");
    }

    #[test]
    fn a_template_keeps_its_indicators_and_chart_type() {
        let t = tessera_protocol::templates::ChartTemplate {
            id: "scalp".into(),
            name: "Scalp on APEX-1234567-01".into(),
            chart_type: Some(tessera_protocol::layout::ChartType::Bars),
            layers: vec![
                tessera_protocol::templates::TemplateLayer {
                    kind: "vwap".into(),
                    params: Value::Null,
                    visible: false,
                },
                tessera_protocol::templates::TemplateLayer {
                    kind: "custom".into(),
                    params: json!({"indicator": "ci_x"}),
                    visible: true,
                },
            ],
        };
        let built = setup::template(&t, &customs(), &scrubber());
        let d = setup::display(&built);
        assert_eq!(d.name, "Scalp on [account]");
        assert_eq!(d.about, "Chart template · 2 indicators");
        assert_eq!(d.lines[0].value, "Bars");
        assert_eq!(d.parts.len(), 2);
        let back = read("template", serde_json::to_value(&built.setup).unwrap()).unwrap();
        let PortableSetup::Template { layers, .. } = back else {
            panic!()
        };
        assert!(!layers[0].visible);
    }
}
