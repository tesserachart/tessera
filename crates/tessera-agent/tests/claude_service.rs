#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tessera_agent::{
    AgentProvider, AgentService, AttachmentStore, BuildProvider, ClaudeConfig, ClaudeProvider,
    ProviderSettings, TurnReport, TurnUsage,
};
use tessera_core::SystemClock;
use tessera_core::health::HealthStatus;
use tessera_core::ids::SessionId;
use tessera_core::settle::{settle, settle_async};
use tessera_host::EventBus;
use tessera_mcp::McpPrincipals;
use tessera_protocol::agent::{
    AgentEvent, AgentEventEnvelope, AgentStartSessionInput, Delivered, Delivery, TurnEnd,
};
use tessera_protocol::tools::SessionMode;
use tessera_store::Store;

struct Rig {
    dir: tempfile::TempDir,
    bin: PathBuf,
    log: PathBuf,
    home: PathBuf,
    store: Store,
    service: Arc<AgentService>,
}

async fn rig(mode: &str) -> Rig {
    let r = rig_off(mode);
    r.service.configure(on()).await;
    r
}

fn on() -> HashMap<String, ProviderSettings> {
    HashMap::from([(
        "claude-code".to_owned(),
        ProviderSettings {
            enabled: true,
            ..ProviderSettings::default()
        },
    )])
}

fn rig_off(mode: &str) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-claude.sh");
    let log = dir.path().join("claude.log");
    let bin = dir.path().join("claude");
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\nexec {} {} {} \"$@\"\n",
            fixture.display(),
            log.display(),
            mode
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let home = dir.path().join("claude-home");
    std::fs::create_dir_all(&home).unwrap();
    let store = Store::open_in_memory().unwrap();
    let service = service_off(&bin, &home, dir.path(), &store);
    Rig {
        dir,
        bin,
        log,
        home,
        store,
        service,
    }
}

async fn service(bin: &Path, home: &Path, dir: &Path, store: &Store) -> Arc<AgentService> {
    let service = service_off(bin, home, dir, store);
    service.configure(on()).await;
    service
}

fn installer(bin: &Path, dir: &Path) -> PathBuf {
    let script = dir.join("install.sh");
    let target = dir.join("installed");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho run >> {log}\nif [ -e {fails} ]; then echo 'Downloading…'; echo 'curl: (6) Could not resolve host: claude.ai' >&2; exit 6; fi\nmkdir -p {target} && cp {bin} {target}/claude\n",
            log = dir.join("install.log").display(),
            fails = dir.join("install-fails").display(),
            target = target.display(),
            bin = bin.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

fn service_off(bin: &Path, home: &Path, dir: &Path, store: &Store) -> Arc<AgentService> {
    let attachments = AttachmentStore::open(dir.join("agents/attachments")).unwrap();
    let install = installer(bin, dir).to_string_lossy().into_owned();
    let (bin, home, dir) = (bin.to_path_buf(), home.to_path_buf(), dir.to_path_buf());
    let build: BuildProvider = Arc::new(move |s: &ProviderSettings| {
        Arc::new(ClaudeProvider::new(ClaudeConfig {
            bin: s
                .binary_path
                .clone()
                .unwrap_or_else(|| bin.to_string_lossy().into_owned()),
            config_dir: Some(
                s.config_dir
                    .clone()
                    .map_or_else(|| home.clone(), PathBuf::from),
            ),
            cwd: dir.join("agents/cwd"),
            state_dir: dir.join("agents/sessions"),
            args: s.args.clone(),
            installer: vec![install.clone()],
        })) as Arc<dyn AgentProvider>
    });
    let service = Arc::new(
        AgentService::with_builders(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            vec![build],
        )
        .with_attachments(attachments),
    );
    service.set_mcp_url("http://127.0.0.1:9/mcp".into());
    service
}

fn invocations(log: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    text.split("-- invocation\n")
        .filter(|inv| !inv.is_empty())
        .map(|inv| {
            inv.lines()
                .take_while(|l| !l.starts_with("CLAUDE_CONFIG_DIR="))
                .map(str::to_owned)
                .collect()
        })
        .collect()
}

fn start(model: Option<&str>, effort: Option<&str>) -> AgentStartSessionInput {
    AgentStartSessionInput {
        preset: "Trader".into(),
        provider: "claude-code".into(),
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
        mode: None,
        title: None,
    }
}

fn events(store: &Store, sid: &SessionId) -> Vec<AgentEventEnvelope> {
    store.agent_events().list(sid.as_str(), 0, 10_000).unwrap()
}

async fn turns_done(store: &Store, sid: &SessionId, n: usize) -> Vec<AgentEventEnvelope> {
    settle(
        &format!("turn {n} ends"),
        || events(store, sid),
        |ev| {
            let done = ev
                .iter()
                .filter(|e| matches!(e.event, AgentEvent::TurnFinished { .. }))
                .count();
            done >= n && matches!(ev.last().map(|e| &e.event), Some(AgentEvent::Status { .. }))
        },
    )
    .await
}

async fn runs_reach(log: &Path, n: usize) -> Vec<Vec<String>> {
    settle(
        &format!("{n} runs of the CLI"),
        || runs(log),
        |all| all.len() >= n,
    )
    .await
}

fn runs(log: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    text.split("-- invocation\n")
        .map(|inv| inv.lines().map(str::to_owned).collect::<Vec<_>>())
        .filter(|lines| lines.first().is_some_and(|l| l == "-p"))
        .collect()
}

fn arg<'a>(run: &'a [String], flag: &str) -> Option<&'a str> {
    run.iter()
        .position(|a| a == flag)
        .and_then(|i| run.get(i + 1))
        .map(String::as_str)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claude_session_streams_its_answer_into_the_transcript() {
    let r = rig("turn").await;
    let s = r
        .service
        .start_session(start(Some("claude-opus-5-5"), Some("high")))
        .await
        .unwrap();
    assert_eq!(s.provider, "claude-code");
    assert_eq!(s.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(s.effort.as_deref(), Some("high"));
    assert_eq!(
        s.thread, None,
        "no conversation until the first turn starts one"
    );

    r.service
        .send(&s.id, "How is NQ doing into the close?", None, None)
        .await
        .unwrap();
    let ev = turns_done(&r.store, &s.id, 1).await;

    for (i, e) in ev.iter().enumerate() {
        assert_eq!(e.seq, i as u64 + 1);
    }
    let kinds: Vec<&str> = ev.iter().map(|e| e.event.type_name()).collect();
    let at = |k: &str| {
        kinds
            .iter()
            .position(|x| *x == k)
            .unwrap_or_else(|| panic!("no {k}: {kinds:?}"))
    };
    assert!(at("turn_started") < at("user_message"));
    assert!(at("user_message") < at("reasoning_summary"));
    assert!(at("reasoning_summary") < at("assistant_delta"));
    assert!(at("assistant_delta") < at("assistant_message"));
    assert!(at("assistant_message") < at("turn_finished"));
    let streamed: String = ev
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::AssistantDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let answer = ev
        .iter()
        .find_map(|e| match &e.event {
            AgentEvent::AssistantMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(streamed, answer);
    assert_eq!(answer, "NQ is holding above **VWAP** at 21,480.");
    assert!(
        kinds.iter().filter(|k| **k == "assistant_delta").count() <= 3,
        "streamed text is gathered: {kinds:?}"
    );
    assert!(ev.iter().any(|e| matches!(
        e.event,
        AgentEvent::TurnFinished {
            end: TurnEnd::Completed,
            ..
        }
    )));
    let stored = r.store.sessions().get(s.id.as_str()).unwrap().unwrap();
    assert_eq!(stored.title, "How is NQ doing into the close?");
    let thread = stored
        .thread
        .clone()
        .expect("the conversation Claude Code started");

    let first = &runs(&r.log)[0];
    assert_eq!(arg(first, "--session-id"), Some(thread.as_str()));
    assert_eq!(arg(first, "--model"), Some("claude-opus-5-5"));
    assert_eq!(arg(first, "--effort"), Some("high"));
    assert_eq!(arg(first, "--tools"), Some(""));
    assert_eq!(arg(first, "--permission-mode"), Some("dontAsk"));
    assert!(first.contains(&"--strict-mcp-config".to_owned()));
    assert!(first.contains(&format!("CLAUDE_CONFIG_DIR={}", r.home.display())));
    let mcp = arg(first, "--mcp-config").unwrap();
    let cfg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(mcp).unwrap()).unwrap();
    assert!(
        cfg["mcpServers"]["tessera"]["headers"]["Authorization"]
            .as_str()
            .unwrap()
            .starts_with("Bearer ")
    );
    let mode = std::fs::metadata(mcp).unwrap().permissions().mode();
    assert_eq!(mode & 0o077, 0, "the token's file is the user's alone");
    let dir = std::path::Path::new(mcp).parent().unwrap();
    let mode = std::fs::metadata(dir).unwrap().permissions().mode();
    assert_eq!(
        mode & 0o077,
        0,
        "and so is the directory of the sessions' configs"
    );
    // the shell adds PWD, SHLVL and _
    let allowed = [
        "HOME",
        "PATH",
        "LANG",
        "LC_ALL",
        "TERM",
        "SSL_CERT_FILE",
        "USER",
        "CLAUDE_CONFIG_DIR",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_AUTO_CONNECT_IDE",
        "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
        "ENABLE_CLAUDEAI_MCP_SERVERS",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
    ];
    let env: Vec<&str> = first
        .iter()
        .filter_map(|l| l.strip_prefix("ENV "))
        .collect();
    assert!(env.contains(&"PATH"), "{env:?}");
    for name in &env {
        assert!(allowed.contains(name), "the child got {name}");
        assert!(!name.starts_with("TESSERA_"), "{name}");
    }

    r.service.send(&s.id, "And ES?", None, None).await.unwrap();
    turns_done(&r.store, &s.id, 2).await;
    assert_eq!(runs(&r.log).len(), 1);

    r.service
        .send(&s.id, "Think harder.", None, Some("max".into()))
        .await
        .unwrap();
    turns_done(&r.store, &s.id, 3).await;
    let all = runs(&r.log);
    assert_eq!(all.len(), 2);
    assert_eq!(arg(&all[1], "--resume"), Some(thread.as_str()));
    assert_eq!(arg(&all[1], "--effort"), Some("max"));
    assert_eq!(
        r.store
            .sessions()
            .get(s.id.as_str())
            .unwrap()
            .unwrap()
            .effort
            .as_deref(),
        Some("max")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finished_turn_is_reported_with_its_tokens_and_the_effort_it_ran_on() {
    let r = rig("turn").await;
    let reports = Arc::new(Mutex::new(Vec::<TurnReport>::new()));
    let seen = Arc::clone(&reports);
    r.service
        .set_turn_sink(Arc::new(move |report| seen.lock().unwrap().push(report)));
    let s = r.service.start_session(start(None, None)).await.unwrap();
    assert_eq!(
        s.effort, None,
        "the session runs on its model's default effort"
    );
    r.service
        .send(&s.id, "How is NQ doing into the close?", None, None)
        .await
        .unwrap();
    turns_done(&r.store, &s.id, 1).await;
    let got = settle(
        "the turn is reported",
        || reports.lock().unwrap().clone(),
        |got| !got.is_empty(),
    )
    .await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(!got[0].latency.is_zero());
    assert_eq!(
        got[0],
        TurnReport {
            session: s.id.clone(),
            provider: "claude-code".into(),
            model: Some("claude-fable-5-1".into()),
            effort: Some("medium".into()),
            latency: got[0].latency,
            end: TurnEnd::Completed,
            error: None,
            usage: Some(TurnUsage {
                input_tokens: 5_500,
                output_tokens: 80,
                cached_input_tokens: 4_000,
                reasoning_tokens: 0,
            }),
        }
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_ends_the_turn_interrupted() {
    let r = rig("hang").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    assert_eq!(
        s.model.as_deref(),
        Some("claude-fable-5-1"),
        "the default model"
    );
    r.service
        .send(&s.id, "Long question", None, None)
        .await
        .unwrap();
    reasoning(&r.store, &s.id, 1).await;
    assert!(r.service.interrupt(&s.id).await.unwrap());
    let ev = turns_done(&r.store, &s.id, 1).await;
    assert!(ev.iter().any(|e| matches!(
        e.event,
        AgentEvent::TurnFinished {
            end: TurnEnd::Interrupted,
            ..
        }
    )));
    assert!(
        !r.service.interrupt(&s.id).await.unwrap(),
        "nothing runs now"
    );
    assert_eq!(arg(&runs(&r.log)[0], "--effort"), Some("medium"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_goes_into_claudes_running_turn() {
    let r = rig("steer").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    let first = r
        .service
        .send(&s.id, "Long question", None, None)
        .await
        .unwrap();
    let turn = first.turn_id.unwrap();
    reasoning(&r.store, &s.id, 1).await;
    let out = r
        .service
        .send_with(
            &s.id,
            "Focus on ES instead",
            &[],
            None,
            None,
            Some(Delivery::Steer),
        )
        .await
        .unwrap();
    assert_eq!(out.delivered, Delivered::Steered, "{out:?}");
    assert_eq!(out.turn_id.as_deref(), Some(turn.as_str()));

    let ev = settle(
        "the steered turn ends after the steer's answer",
        || events(&r.store, &s.id),
        |ev| ended_after_the_answer_to(ev, "Focus on ES instead"),
    )
    .await;
    let ends: Vec<(Option<&str>, TurnEnd)> = ev
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::TurnFinished { end, .. } => Some((e.turn_id.as_deref(), *end)),
            _ => None,
        })
        .collect();
    assert_eq!(
        ends,
        [(Some(turn.as_str()), TurnEnd::Completed)],
        "the abort the steer caused does not end the turn"
    );
    let asked: Vec<(&str, Option<&str>)> = ev
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::UserMessage { text, .. } => Some((text.as_str(), e.turn_id.as_deref())),
            _ => None,
        })
        .collect();
    assert_eq!(
        asked,
        [
            ("Long question", Some(turn.as_str())),
            ("Focus on ES instead", Some(turn.as_str()))
        ]
    );
    let steer_at = ev
        .iter()
        .position(|e| matches!(&e.event, AgentEvent::UserMessage { text, .. } if text == "Focus on ES instead"))
        .unwrap();
    assert!(
        ev[steer_at..].iter().any(|e| matches!(
            &e.event,
            AgentEvent::AssistantMessage { text, .. } if text == "NQ is holding above **VWAP** at 21,480."
        )),
        "the answer to the steer streams into the turn"
    );

    let sent = std::fs::read_to_string(format!("{}.stdin", r.log.display())).unwrap();
    let lines: Vec<serde_json::Value> = sent
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "{sent}");
    assert!(lines[0].get("priority").is_none());
    assert_eq!(lines[1]["priority"], "now");
    assert_eq!(
        lines[1]["message"]["content"][0]["text"],
        "Focus on ES instead"
    );
    assert_eq!(runs(&r.log).len(), 1, "the same process takes the steer");
}

fn ended_after_the_answer_to(ev: &[AgentEventEnvelope], steer: &str) -> bool {
    let Some(steered) = ev
        .iter()
        .position(|e| matches!(&e.event, AgentEvent::UserMessage { text, .. } if text == steer))
    else {
        return false;
    };
    let after = &ev[steered..];
    let answered = after.iter().position(|e| {
        matches!(
            &e.event,
            AgentEvent::AssistantMessage { text, .. } if text == "NQ is holding above **VWAP** at 21,480."
        )
    });
    answered.is_some_and(|a| {
        after[a..]
            .iter()
            .any(|e| matches!(e.event, AgentEvent::TurnFinished { .. }))
    }) && matches!(ev.last().map(|e| &e.event), Some(AgentEvent::Status { .. }))
}

async fn reasoning(store: &Store, sid: &SessionId, n: usize) {
    settle(
        &format!("reasoning {n}"),
        || events(store, sid),
        |ev| {
            ev.iter()
                .filter(|e| matches!(e.event, AgentEvent::ReasoningSummary { .. }))
                .count()
                >= n
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claude_deaf_to_stop_is_stopped_after_a_grace() {
    let r = rig("deaf").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service
        .send(&s.id, "Long question", None, None)
        .await
        .unwrap();
    reasoning(&r.store, &s.id, 1).await;
    assert!(r.service.interrupt(&s.id).await.unwrap());
    let ev = turns_done(&r.store, &s.id, 1).await;
    assert!(ev.iter().any(|e| matches!(
        e.event,
        AgentEvent::TurnFinished {
            end: TurnEnd::Interrupted,
            ..
        }
    )));
    r.service.send(&s.id, "Again", None, None).await.unwrap();
    assert_eq!(
        runs_reach(&r.log, 2).await.len(),
        2,
        "the process that ignored Stop is gone"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_right_after_stop_outlives_the_stops_grace() {
    let r = rig("steer").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service
        .send(&s.id, "Long question", None, None)
        .await
        .unwrap();
    reasoning(&r.store, &s.id, 1).await;
    assert!(r.service.interrupt(&s.id).await.unwrap());
    turns_done(&r.store, &s.id, 1).await;
    assert!(
        std::fs::read_to_string(&r.log)
            .unwrap()
            .contains("-- interrupted"),
        "the CLI answered the Stop itself"
    );
    let next = r
        .service
        .send(&s.id, "Next question", None, None)
        .await
        .unwrap();
    assert_eq!(next.delivered, Delivered::Turn);
    let turn = next.turn_id.unwrap();
    reasoning(&r.store, &s.id, 2).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let ended: Vec<TurnEnd> = events(&r.store, &s.id)
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::TurnFinished { end, .. } => Some(*end),
            _ => None,
        })
        .collect();
    assert_eq!(
        ended,
        [TurnEnd::Interrupted],
        "the Stop before it does not end the next turn"
    );
    assert_eq!(runs(&r.log).len(), 1, "nor kill the process it runs on");

    let out = r
        .service
        .send_with(&s.id, "Go on", &[], None, None, Some(Delivery::Steer))
        .await
        .unwrap();
    assert_eq!(out.delivered, Delivered::Steered);
    let ev = turns_done(&r.store, &s.id, 2).await;
    assert!(
        ev.iter()
            .any(|e| e.turn_id.as_deref() == Some(turn.as_str())
                && matches!(
                    e.event,
                    AgentEvent::TurnFinished {
                        end: TurnEnd::Completed,
                        ..
                    }
                ))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signed_out_claude_says_how_to_sign_in() {
    let r = rig("signed-out").await;
    let p = r.service.providers()[0].clone();
    let state = p.connect().await;
    assert_eq!(state.status, HealthStatus::Disconnected);
    let err = r
        .service
        .start_session(start(None, None))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("Settings › Analyst"),
        "{}",
        err.message
    );
    let info = r.service.providers_info(false).await;
    assert_eq!(info.providers[0].status, HealthStatus::Disconnected);
    assert!(!info.providers[0].models.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_signs_in_from_the_app() {
    let r = rig("signed-out").await;
    let started = r.service.sign_in("claude-code", None).await.unwrap();
    let page = started.page.expect("a page to finish on");
    assert_eq!(
        page.url,
        "https://claude.invalid/oauth/authorize?code=true&state=s"
    );
    assert!(page.opened && page.takes_code);
    let log = std::fs::read_to_string(&r.log).unwrap();
    assert!(
        log.contains(&format!(
            "-- invocation\nauth\nlogin\nCLAUDE_CONFIG_DIR={}\n",
            r.home.display()
        )),
        "{log}"
    );
    let handed = r
        .service
        .sign_in("claude-code", Some(" the-code \n"))
        .await
        .unwrap();
    assert_eq!(handed.page, None);
    settle_async(
        "checked again once it ended",
        || async { r.service.providers_info(false).await.providers[0].status },
        |status| *status == HealthStatus::Ok,
    )
    .await;
    let log = std::fs::read_to_string(&r.log).unwrap();
    assert!(log.contains("-- code the-code\n"), "{log}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_are_renamed_given_models_and_deleted() {
    let r = rig("turn").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    let renamed = r.service.rename(&s.id, "  NQ close  ").unwrap();
    assert_eq!(renamed.title, "NQ close");
    let changed = r
        .service
        .set_model(&s.id, Some("claude-sonnet-5-5".into()), None)
        .await
        .unwrap();
    assert_eq!(changed.model.as_deref(), Some("claude-sonnet-5-5"));
    assert_eq!(
        changed.effort, None,
        "a new model starts on its own default effort"
    );
    let err = r
        .service
        .set_model(&s.id, Some("gpt-6-astra".into()), None)
        .await
        .unwrap_err();
    assert!(err.message.contains("no model gpt-6-astra"));
    let err = r
        .service
        .set_model(&s.id, None, Some("ultra".into()))
        .await
        .unwrap_err();
    assert!(err.message.contains("takes no effort ultra"));
    r.service.send(&s.id, "hi", None, None).await.unwrap();
    turns_done(&r.store, &s.id, 1).await;
    assert!(r.service.delete(&s.id).await.unwrap());
    assert!(r.store.sessions().get(s.id.as_str()).unwrap().is_none());
    assert!(events(&r.store, &s.id).is_empty());
    assert!(!r.service.delete(&s.id).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_carries_on_after_a_restart() {
    let r = rig("turn").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service
        .send(&s.id, "First question", None, None)
        .await
        .unwrap();
    let before = turns_done(&r.store, &s.id, 1).await.len() as u64;
    let thread = r
        .store
        .sessions()
        .get(s.id.as_str())
        .unwrap()
        .unwrap()
        .thread
        .unwrap();
    let again = service(&r.bin, &r.home, r.dir.path(), &r.store).await;
    again.send(&s.id, "And now?", None, None).await.unwrap();
    let ev = turns_done(&r.store, &s.id, 2).await;
    assert!(ev.len() as u64 > before);
    for (i, e) in ev.iter().enumerate() {
        assert_eq!(
            e.seq,
            i as u64 + 1,
            "the transcript carries on without a gap"
        );
    }
    let last = runs(&r.log).pop().unwrap();
    assert_eq!(arg(&last, "--resume"), Some(thread.as_str()));
    assert_eq!(arg(&last, "--session-id"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conversation_claude_lost_is_started_afresh_instead_of_resumed_again() {
    let r = rig("lost").await;
    let s = r.service.start_session(start(None, None)).await.unwrap();
    let mut stored = r.store.sessions().get(s.id.as_str()).unwrap().unwrap();
    let lost = "0199c0de-0000-7000-8000-00000000dead".to_owned();
    stored.thread = Some(lost.clone());
    r.store.sessions().upsert(&stored).unwrap();
    let again = service(&r.bin, &r.home, r.dir.path(), &r.store).await;

    again
        .send(&s.id, "First question", None, None)
        .await
        .unwrap();
    let ended = |ev: &[AgentEventEnvelope]| -> Vec<TurnEnd> {
        ev.iter()
            .filter_map(|e| match &e.event {
                AgentEvent::TurnFinished { end, .. } => Some(*end),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        ended(&turns_done(&r.store, &s.id, 1).await),
        [TurnEnd::Failed]
    );
    assert_eq!(
        arg(&runs(&r.log).pop().unwrap(), "--resume"),
        Some(lost.as_str())
    );

    again.send(&s.id, "Once more", None, None).await.unwrap();
    assert_eq!(
        ended(&turns_done(&r.store, &s.id, 2).await),
        [TurnEnd::Failed, TurnEnd::Completed]
    );
    let last = runs(&r.log).pop().unwrap();
    assert_eq!(arg(&last, "--resume"), None);
    assert!(arg(&last, "--session-id").is_some_and(|id| id != lost));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_opens_with_the_users_standing_instructions_and_the_default_mode() {
    use tessera_agent::service::{INSTRUCTIONS, brief};
    let r = rig("turn").await;
    assert!(
        !INSTRUCTIONS.contains('\n'),
        "the fixture logs one line per argument"
    );
    r.service
        .set_custom_instructions("Always quote prices in ticks.".into());
    r.service.set_default_mode(SessionMode::ReadOnly);
    let s = r.service.start_session(start(None, None)).await.unwrap();
    assert_eq!(s.mode, SessionMode::ReadOnly, "no mode given: the default");
    r.service.send(&s.id, "hi", None, None).await.unwrap();
    turns_done(&r.store, &s.id, 1).await;
    let log = std::fs::read_to_string(&r.log).unwrap();
    let expected = format!(
        "--append-system-prompt\n{}\n--model\n",
        brief("Always quote prices in ticks.")
    );
    assert!(
        expected.contains("\n\nThe user's standing instructions (follow them unless they conflict with Tessera's rules above):\nAlways quote prices in ticks.\n--model"),
        "{expected}"
    );
    assert!(log.contains(&expected), "{log}");

    let mut supervised = start(None, None);
    supervised.mode = Some(SessionMode::Supervised);
    let s2 = r.service.start_session(supervised).await.unwrap();
    assert_eq!(s2.mode, SessionMode::Supervised);

    r.service.set_custom_instructions("  ".into());
    let s3 = r.service.start_session(start(None, None)).await.unwrap();
    r.service.send(&s3.id, "hi", None, None).await.unwrap();
    turns_done(&r.store, &s3.id, 1).await;
    let last = runs(&r.log).pop().unwrap();
    assert_eq!(arg(&last, "--append-system-prompt"), Some(INSTRUCTIONS));
    assert_eq!(arg(&last, "--model"), Some("claude-fable-5-1"));

    let again = service(&r.bin, &r.home, r.dir.path(), &r.store).await;
    again.set_custom_instructions("Answer in French.".into());
    again.set_default_mode(SessionMode::Supervised);
    again.send(&s.id, "And now?", None, None).await.unwrap();
    turns_done(&r.store, &s.id, 2).await;
    let last = runs(&r.log).pop().unwrap();
    assert!(last.contains(&"Answer in French.".to_owned()), "{last:?}");
    assert!(!last.contains(&"Always quote prices in ticks.".to_owned()));
    assert_eq!(
        r.store.sessions().get(s.id.as_str()).unwrap().unwrap().mode,
        SessionMode::Supervised
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_carries_its_attachments_to_claude() {
    use tessera_core::b64;
    use tessera_protocol::agent::{AgentUploadAttachmentInput, AttachmentKind};
    let r = rig("turn").await;
    let store = r.service.attachments().unwrap().clone();
    let up = |name: &str, mime: &str, data: &[u8]| {
        store
            .upload(
                &AgentUploadAttachmentInput {
                    name: name.into(),
                    mime_type: mime.into(),
                    size_bytes: data.len() as u64,
                    data_base64: b64::encode(data),
                    upload_id: None,
                    offset: None,
                },
                tessera_core::Timestamp::now(),
            )
            .unwrap()
            .attachment
            .unwrap()
    };
    let png = up("chart.png", "image/png", b"\x89PNG\r\n\x1a\nrest");
    let pdf = up("report.pdf", "application/pdf", b"%PDF-1.4\nbody");
    let csv = up("fills.csv", "text/csv", b"price,size\n21480,2\n");
    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service
        .send_with(
            &s.id,
            "What do these say?",
            &[png.clone(), pdf.clone(), csv.clone()],
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let ev = turns_done(&r.store, &s.id, 1).await;
    let kept = ev
        .iter()
        .find_map(|e| match &e.event {
            AgentEvent::UserMessage { text, attachments } => {
                Some((text.clone(), attachments.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        kept.0, "What do these say?",
        "the transcript keeps the user's own words"
    );
    assert_eq!(kept.1, vec![png.clone(), pdf.clone(), csv.clone()]);
    assert_eq!(kept.1[0].kind, AttachmentKind::Image);

    let sent = std::fs::read_to_string(format!("{}.stdin", r.log.display())).unwrap();
    let line: serde_json::Value = serde_json::from_str(sent.lines().next().unwrap()).unwrap();
    let content = line["message"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 3, "{content:?}");
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["source"]["media_type"], "image/png");
    assert_eq!(
        b64::decode(content[0]["source"]["data"].as_str().unwrap()).unwrap(),
        b"\x89PNG\r\n\x1a\nrest"
    );
    assert_eq!(content[1]["type"], "document");
    assert_eq!(content[1]["source"]["media_type"], "application/pdf");
    let text = content[2]["text"].as_str().unwrap();
    assert!(
        text.starts_with(
            "What do these say?\n\nAttached file \"fills.csv\":\n```csv\nprice,size\n21480,2\n```"
        ),
        "{text}"
    );
    assert!(
        text.contains("[Attached image \"chart.png\"]")
            && text.contains("[Attached PDF \"report.pdf\"]")
    );

    let other = r.service.start_session(start(None, None)).await.unwrap();
    let err = r
        .service
        .send_with(
            &other.id,
            "and here?",
            std::slice::from_ref(&png),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("another session"), "{}", err.message);
    let png_id = png.id.clone().unwrap();
    assert!(!store.discard(&png_id).unwrap());
    assert_eq!(
        store.sweep(tessera_core::Timestamp(
            tessera_core::Timestamp::now().0 + 2 * 86_400_000_000_000
        )),
        0
    );
    assert!(r.service.delete(&s.id).await.unwrap());
    assert!(store.get(&png_id).is_err(), "they go with the session");
    let err = r
        .service
        .send_with(&other.id, "  ", &[], None, None, None)
        .await
        .unwrap_err();
    assert!(err.message.contains("needs words"), "{}", err.message);
}

fn on_at(bin: &Path) -> HashMap<String, ProviderSettings> {
    HashMap::from([(
        "claude-code".to_owned(),
        ProviderSettings {
            enabled: true,
            binary_path: Some(bin.display().to_string()),
            ..ProviderSettings::default()
        },
    )])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_installs_from_the_app_and_is_checked_again() {
    let r = rig_off("turn");
    r.service
        .configure(on_at(&r.dir.path().join("installed/claude")))
        .await;
    let before = r.service.providers_info(true).await;
    assert_eq!(before.providers[0].status, HealthStatus::Down);
    let done = r.service.install("claude-code").await.unwrap();
    assert_eq!(done.provider, "claude-code");
    let after = r.service.providers_info(false).await;
    assert_eq!(
        after.providers[0].status,
        HealthStatus::Ok,
        "{:?}",
        after.providers[0]
    );
    let runs = std::fs::read_to_string(r.dir.path().join("install.log")).unwrap();
    assert_eq!(runs, "run\n", "the installer ran once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_install_says_the_installers_last_words() {
    let r = rig_off("turn");
    std::fs::write(r.dir.path().join("install-fails"), "").unwrap();
    r.service
        .configure(on_at(&r.dir.path().join("installed/claude")))
        .await;
    let err = r.service.install("claude-code").await.unwrap_err();
    assert_eq!(
        err.message,
        "The Claude Code installer failed: curl: (6) Could not resolve host: claude.ai"
    );
    let info = r.service.providers_info(false).await;
    assert_eq!(info.providers[0].status, HealthStatus::Down);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installing_a_provider_that_is_off_is_refused() {
    let r = rig_off("turn");
    let err = r.service.install("claude-code").await.unwrap_err();
    assert!(!err.message.is_empty());
    assert!(!r.dir.path().join("install.log").exists(), "nothing ran");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signed_in_claude_says_its_version_and_home() {
    let r = rig("turn").await;
    let info = r.service.providers_info(false).await;
    let p = &info.providers[0];
    assert_eq!(p.status, HealthStatus::Ok, "{p:?}");
    assert_eq!(p.version.as_deref(), Some("2.1.289"));
    assert_eq!(
        p.config_home.as_deref(),
        Some(r.home.display().to_string().as_str())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_that_is_off_never_runs() {
    let r = rig_off("turn");
    let holders = Arc::strong_count(&r.service);
    let watch = tokio::spawn(Arc::clone(&r.service).watch());
    settle(
        "the watch has looked at the providers",
        || Arc::strong_count(&r.service),
        |n| *n <= holders,
    )
    .await;
    for recheck in [false, true] {
        let info = r.service.providers_info(recheck).await;
        let p = &info.providers[0];
        assert_eq!(p.id, "claude-code");
        assert!(!p.enabled);
        assert_eq!(p.status, HealthStatus::Disabled);
        assert_eq!(p.message, None);
        assert_eq!(p.version, None, "its version is never read");
        assert_eq!(p.config_home, None, "nor its home said");
        assert_eq!(p.checked_at, None);
        assert!(p.models.is_empty());
    }
    assert!(r.service.health().is_empty(), "nothing to report");
    let err = r
        .service
        .start_session(start(None, None))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("Claude Code is off") && err.message.contains("Settings › Analyst"),
        "{}",
        err.message
    );
    let mut off = on();
    off.get_mut("claude-code").unwrap().enabled = false;
    off.get_mut("claude-code").unwrap().args = vec!["--verbose".into()];
    r.service.configure(off).await;
    assert!(
        invocations(&r.log).is_empty(),
        "the CLI never ran: {:?}",
        invocations(&r.log)
    );
    watch.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_a_provider_on_checks_it_and_off_stops_it() {
    let r = rig_off("hang");
    r.service.configure(on()).await;
    let probes = invocations(&r.log);
    assert!(
        probes.iter().any(|a| a == &["--version"]),
        "checked its version: {probes:?}"
    );
    assert!(
        probes
            .iter()
            .any(|a| a.first().map(String::as_str) == Some("auth")),
        "and its sign-in: {probes:?}"
    );
    let info = r.service.providers_info(false).await;
    let p = &info.providers[0];
    assert!(p.enabled);
    assert_eq!(p.status, HealthStatus::Ok);
    assert_eq!(p.message.as_deref(), Some("Claude · Max"));
    assert!(p.checked_at.is_some());
    assert_eq!(r.service.health().len(), 1);
    assert_eq!(
        invocations(&r.log).len(),
        probes.len(),
        "listing it does not check it again"
    );
    r.service.providers_info(true).await;
    assert!(invocations(&r.log).len() > probes.len());

    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service
        .send(&s.id, "Long question", None, None)
        .await
        .unwrap();
    reasoning(&r.store, &s.id, 1).await;
    r.service.configure(HashMap::new()).await;
    let ev = turns_done(&r.store, &s.id, 1).await;
    assert!(ev.iter().any(|e| matches!(
        e.event,
        AgentEvent::TurnFinished {
            end: TurnEnd::Interrupted,
            ..
        }
    )));
    assert_eq!(
        r.store
            .sessions()
            .get(s.id.as_str())
            .unwrap()
            .unwrap()
            .status,
        tessera_protocol::agent::AgentSessionStatus::Idle
    );
    assert_eq!(
        r.service.providers_info(false).await.providers[0].status,
        HealthStatus::Disabled
    );
    let ran = invocations(&r.log).len();
    let err = r
        .service
        .send(&s.id, "And now?", None, None)
        .await
        .unwrap_err();
    assert!(err.message.contains("is off"), "{}", err.message);
    let err = r
        .service
        .set_model(&s.id, Some("claude-sonnet-5-5".into()), None)
        .await
        .unwrap_err();
    assert!(err.message.contains("is off"), "{}", err.message);
    assert_eq!(
        invocations(&r.log).len(),
        ran,
        "nothing ran while it was off"
    );

    r.service.configure(on()).await;
    assert!(
        invocations(&r.log)[ran..]
            .iter()
            .any(|a| a == &["--version"])
    );
    assert_eq!(runs(&r.log).len(), 1, "no turn ran while it was off");
    r.service.send(&s.id, "And now?", None, None).await.unwrap();
    let all = runs_reach(&r.log, 2).await;
    assert_eq!(all.len(), 2, "a process of its own again");
    assert_eq!(
        arg(&all[1], "--resume"),
        arg(&all[0], "--session-id"),
        "on the same conversation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_how_a_provider_starts_checks_it_again() {
    let r = rig("turn").await;
    let before = invocations(&r.log).len();
    let other = r.dir.path().join("other-home");
    std::fs::create_dir_all(&other).unwrap();
    let mut wanted = on();
    {
        let c = wanted.get_mut("claude-code").unwrap();
        c.config_dir = Some(other.display().to_string());
        c.args = vec!["--add-dir".into(), "/tmp/notes".into()];
    }
    r.service.configure(wanted.clone()).await;
    let after = invocations(&r.log);
    assert!(after.len() > before, "checked again");
    assert!(
        after[before..]
            .iter()
            .all(|a| !a.contains(&"--add-dir".to_owned())),
        "its checks run without the launch arguments"
    );
    let info = r.service.providers_info(false).await;
    assert_eq!(
        info.providers[0].config_home.as_deref(),
        Some(other.display().to_string().as_str())
    );
    r.service.configure(wanted).await;
    assert_eq!(invocations(&r.log).len(), after.len());

    let s = r.service.start_session(start(None, None)).await.unwrap();
    r.service.send(&s.id, "hi", None, None).await.unwrap();
    turns_done(&r.store, &s.id, 1).await;
    let session = invocations(&r.log)
        .into_iter()
        .rev()
        .find(|a| a.contains(&"-p".to_owned()))
        .unwrap();
    assert_eq!(
        &session[..3],
        ["--add-dir", "/tmp/notes", "-p"],
        "{session:?}"
    );
}
