//! `codex app-server` speaks JSON-RPC over stdio: one JSON object per line, no `"jsonrpc"` field.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_core::health::HealthStatus;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{AgentModel, AgentState, TurnEnd};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::AgentError;
use crate::models::{codex_fallback_models, codex_models_from};
use crate::provider::{
    AgentProvider, EventSink, OpenThread, ProviderEvent, ProviderState, ProviderThread, SignIn,
    SteerOutcome, TurnAttachment, TurnContent, TurnInput,
};
use crate::report::TurnUsage;
pub use crate::service::CODEX;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct CodexConfig {
    pub bin: String,
    pub home: Option<PathBuf>,
    pub cwd: PathBuf,
    pub args: Vec<String>,
}

impl CodexConfig {
    pub fn config_home(&self) -> PathBuf {
        self.home
            .clone()
            .unwrap_or_else(|| crate::expand_home("~/.codex"))
    }
}

pub fn codex_version(initialized: &Value) -> Option<String> {
    if let Some(v) = initialized
        .pointer("/serverInfo/version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Some(v.to_owned());
    }
    let agent = initialized.get("userAgent").and_then(Value::as_str)?;
    let after = agent.split_once('/')?.1;
    let version: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect();
    version
        .starts_with(|c: char| c.is_ascii_digit())
        .then_some(version)
}

const EXITED: &str = "tessera/exited";

type Pending = std::sync::Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>;

pub struct CodexClient {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Pending>,
    next: AtomicI64,
    _child: Mutex<Child>,
}

impl std::fmt::Debug for CodexClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexClient").finish_non_exhaustive()
    }
}

impl CodexClient {
    pub async fn spawn(
        cfg: &CodexConfig,
        notes: mpsc::UnboundedSender<(String, Value)>,
    ) -> Result<Arc<Self>, String> {
        crate::child_env::create_private_dir(&cfg.cwd)
            .map_err(|e| format!("working directory: {e}"))?;
        let mut cmd = Command::new(&cfg.bin);
        cmd.arg("app-server")
            .args(&cfg.args)
            .env_clear()
            .current_dir(&cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        cmd.envs(crate::child_env::from_process(&config_env_keys(cfg)));
        if let Some(home) = &cfg.home {
            cmd.env("CODEX_HOME", home);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("codex not started ({}): {e}", cfg.bin))?;
        let stdin = child.stdin.take().ok_or("codex: no stdin")?;
        let stdout = child.stdout.take().ok_or("codex: no stdout")?;
        let client = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            next: AtomicI64::new(1),
            _child: Mutex::new(child),
        });
        let reader = Arc::clone(&client);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                reader.dispatch(msg, &notes).await;
            }
            for (_, tx) in reader
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .drain()
            {
                let _ = tx.send(Err("codex app-server exited".into()));
            }
            let _ = notes.send((EXITED.into(), Value::Null));
        });
        Ok(client)
    }

    pub async fn kill(&self) {
        let _ = self._child.lock().await.start_kill();
    }

    async fn dispatch(&self, msg: Value, notes: &mpsc::UnboundedSender<(String, Value)>) {
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        match (msg.get("id"), method) {
            (Some(id), None) => {
                let Some(id) = id.as_i64() else { return };
                let tx = self
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                if let Some(tx) = tx {
                    let out = match msg.get("error") {
                        Some(e) => Err(e
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("error")
                            .to_owned()),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(out);
                }
            }
            (Some(id), Some(method)) => {
                let result = match method.as_str() {
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        json!({"decision": "decline"})
                    }
                    "execCommandApproval" | "applyPatchApproval" => json!({"decision": "denied"}),
                    "mcpServer/elicitation/request" => json!({"action": "decline"}),
                    _ => {
                        let _ = self
                            .write(json!({"id": id, "error": {"code": -32601, "message": "not supported by Tessera"}}))
                            .await;
                        return;
                    }
                };
                let _ = self.write(json!({"id": id, "result": result})).await;
            }
            (None, Some(method)) => {
                let _ = notes.send((method, msg.get("params").cloned().unwrap_or(Value::Null)));
            }
            (None, None) => {}
        }
    }

    async fn write(&self, msg: Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        self.write(json!({"id": id, "method": method, "params": params}))
            .await?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(out)) => out,
            Ok(Err(_)) => Err(format!("{method}: no answer")),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(format!("{method}: timed out"))
            }
        }
    }

    pub async fn notify(&self, method: &str) -> Result<(), String> {
        self.write(json!({"method": method})).await
    }

    pub async fn initialize(&self, version: &str) -> Result<Value, String> {
        let out = self
            .request(
                "initialize",
                json!({"clientInfo": {"name": "tessera", "title": "Tessera", "version": version},
                       "capabilities": {"experimentalApi": false}}),
            )
            .await?;
        self.notify("initialized").await?;
        Ok(out)
    }
}

/// In the Codex home's `config.toml`, a custom model provider's key comes from the environment
/// variable its `env_key` names.
fn config_env_keys(cfg: &CodexConfig) -> Vec<String> {
    let home = cfg
        .home
        .clone()
        .or_else(|| std::env::home_dir().map(|h| h.join(".codex")));
    let Some(text) = home.and_then(|h| std::fs::read_to_string(h.join("config.toml")).ok()) else {
        return Vec::new();
    };
    env_keys_in(&text)
}

fn env_keys_in(toml: &str) -> Vec<String> {
    toml.lines()
        .filter_map(|l| l.trim().strip_prefix("env_key"))
        .filter_map(|rest| rest.trim_start().strip_prefix('='))
        .map(|v| v.trim().trim_matches('"').to_owned())
        .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .collect()
}

pub fn account_word(account_read: &Value, provider_name: Option<&str>) -> Option<String> {
    match account_read.get("account") {
        Some(a) if a.get("type").and_then(Value::as_str) == Some("chatgpt") => Some(format!(
            "ChatGPT · {}",
            a.get("planType")
                .and_then(Value::as_str)
                .unwrap_or("signed in")
        )),
        Some(a) if a.get("type").and_then(Value::as_str) == Some("apiKey") => {
            Some("API key".into())
        }
        _ if account_read
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            == Some(false) =>
        {
            Some(provider_name.map_or_else(|| "custom provider".into(), |n| format!("via {n}")))
        }
        _ => None,
    }
}

pub fn thread_config(mcp_url: &str, token: &str, user_servers: &[String]) -> Value {
    let mut cfg = json!({
        "mcp_servers": {"tessera": {
            "url": mcp_url,
            "http_headers": {"Authorization": format!("Bearer {token}")},
            "default_tools_approval_mode": "approve",
            "tool_timeout_sec": 120,
        }},
        "features.shell_tool": false,
        "features.unified_exec": false,
        "features.view_image": false,
        "features.multi_agent": false,
        "features.apps": false,
        "features.plugins": false,
        "web_search": "disabled",
        "shell_environment_policy.inherit": "core",
    });
    let obj = cfg.as_object_mut().expect("an object");
    for name in user_servers.iter().filter(|n| n.as_str() != "tessera") {
        obj.insert(format!("mcp_servers.{name}.enabled"), Value::Bool(false));
    }
    cfg
}

fn slock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

struct Route {
    session: SessionId,
    events: EventSink,
    turn: Option<String>,
    reasoning: HashMap<String, std::time::Instant>,
    usage: Option<Spent>,
}

struct Spent {
    turn: String,
    before: TurnUsage,
    now: TurnUsage,
}

impl Route {
    fn new(session: SessionId, events: EventSink) -> Self {
        Self {
            session,
            events,
            turn: None,
            reasoning: HashMap::new(),
            usage: None,
        }
    }

    fn spent_on(&mut self, turn: Option<&str>) -> Option<TurnUsage> {
        self.usage
            .take()
            .filter(|s| Some(s.turn.as_str()) == turn)
            .map(|s| s.now - s.before)
    }

    fn used(&mut self, turn: &str, total: TurnUsage, last: TurnUsage) {
        let before = match self.usage.take() {
            Some(s) if s.turn == turn => s.before,
            _ => total - last,
        };
        self.usage = Some(Spent {
            turn: turn.to_owned(),
            before,
            now: total,
        });
    }
}

struct CodexInner {
    cfg: CodexConfig,
    version: &'static str,
    server_version: std::sync::Mutex<Option<String>>,
    client: Mutex<Option<Arc<CodexClient>>>,
    state: std::sync::Mutex<ProviderState>,
    user_servers: std::sync::Mutex<Vec<String>>,
    routes: std::sync::Mutex<HashMap<String, Route>>,
    models: std::sync::Mutex<Option<Vec<AgentModel>>>,
}

#[derive(Clone)]
pub struct CodexProvider(Arc<CodexInner>);

impl std::fmt::Debug for CodexProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexProvider").finish_non_exhaustive()
    }
}

impl CodexProvider {
    pub fn new(cfg: CodexConfig, version: &'static str) -> Self {
        Self(Arc::new(CodexInner {
            cfg,
            version,
            server_version: std::sync::Mutex::new(None),
            client: Mutex::new(None),
            state: std::sync::Mutex::new(ProviderState::unknown()),
            user_servers: std::sync::Mutex::new(Vec::new()),
            routes: std::sync::Mutex::new(HashMap::new()),
            models: std::sync::Mutex::new(None),
        }))
    }
}

impl CodexInner {
    fn set(&self, state: ProviderState) -> ProviderState {
        *slock(&self.state) = state.clone();
        state
    }

    async fn client(self: &Arc<Self>) -> Result<Arc<CodexClient>, AgentError> {
        let mut slot = self.client.lock().await;
        if let Some(c) = slot.as_ref() {
            return Ok(Arc::clone(c));
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let client = match CodexClient::spawn(&self.cfg, tx).await {
            Ok(c) => c,
            Err(e) => {
                self.set(ProviderState::new(
                    HealthStatus::Down,
                    "Codex is not installed",
                ));
                return Err(AgentError::Unavailable(e));
            }
        };
        let me = Arc::clone(self);
        let from = Arc::downgrade(&client);
        tokio::spawn(async move {
            while let Some((method, params)) = rx.recv().await {
                if method == EXITED {
                    me.exited(&from).await;
                } else {
                    me.on_note(&method, &params).await;
                }
            }
        });
        match client.initialize(self.version).await {
            Ok(answer) => *slock(&self.server_version) = codex_version(&answer),
            Err(e) => {
                self.set(ProviderState::new(
                    HealthStatus::Down,
                    format!("Codex did not start: {e}"),
                ));
                return Err(AgentError::Unavailable(e));
            }
        }
        let config = client
            .request("config/read", json!({}))
            .await
            .unwrap_or(Value::Null);
        let cfg = config.get("config").unwrap_or(&config);
        if let Some(servers) = cfg.get("mcp_servers").and_then(Value::as_object) {
            *slock(&self.user_servers) = servers.keys().cloned().collect();
        }
        let provider_name = cfg
            .get("model_provider")
            .and_then(Value::as_str)
            .and_then(|p| cfg.get("model_providers")?.get(p)?.get("name")?.as_str())
            .map(str::to_owned);
        let account = client
            .request("account/read", json!({}))
            .await
            .unwrap_or(Value::Null);
        self.set(match account_word(&account, provider_name.as_deref()) {
            Some(word) => ProviderState::new(HealthStatus::Ok, word),
            None => ProviderState::new(HealthStatus::Disconnected, "Not signed in"),
        });
        *slot = Some(Arc::clone(&client));
        Ok(client)
    }

    fn route(&self, thread: &str, ev: ProviderEvent) {
        if let Some(r) = slock(&self.routes).get(thread) {
            let _ = r.events.send((r.session.clone(), ev));
        }
    }

    async fn exited(&self, client: &std::sync::Weak<CodexClient>) {
        {
            let mut slot = self.client.lock().await;
            if slot
                .as_ref()
                .is_some_and(|c| !std::ptr::eq(Arc::as_ptr(c), client.as_ptr()))
            {
                return;
            }
            *slot = None;
        }
        self.set(ProviderState::new(
            HealthStatus::Down,
            "Codex stopped; it restarts with the next session",
        ));
        let routes: Vec<Route> = slock(&self.routes).drain().map(|(_, r)| r).collect();
        for r in routes {
            let _ = r.events.send((
                r.session,
                ProviderEvent::Exited {
                    message: "Codex stopped".into(),
                },
            ));
        }
    }

    async fn on_note(&self, method: &str, p: &Value) {
        if method == "account/updated" || method == "account/login/completed" {
            let client = self.client.lock().await.clone();
            if let Some(c) = client {
                let account = c
                    .request("account/read", json!({}))
                    .await
                    .unwrap_or(Value::Null);
                self.set(match account_word(&account, None) {
                    Some(word) => ProviderState::new(HealthStatus::Ok, word),
                    None => ProviderState::new(HealthStatus::Disconnected, "Not signed in"),
                });
            }
            return;
        }
        let Some(thread) = p.get("threadId").and_then(Value::as_str) else {
            return;
        };
        match method {
            "item/agentMessage/delta" => self.route(
                thread,
                ProviderEvent::Delta {
                    message_id: str_at(p, "/itemId"),
                    text: str_at(p, "/delta"),
                },
            ),
            "item/started" | "item/completed" => {
                let item = p.get("item").cloned().unwrap_or(Value::Null);
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let id = str_at(&item, "/id");
                match (method, kind) {
                    ("item/completed", "agentMessage") => self.route(
                        thread,
                        ProviderEvent::Message {
                            message_id: id,
                            text: str_at(&item, "/text"),
                        },
                    ),
                    ("item/started", "reasoning") => {
                        if let Some(r) = slock(&self.routes).get_mut(thread) {
                            r.reasoning.insert(id, std::time::Instant::now());
                        }
                        self.route(thread, ProviderEvent::Status(AgentState::Thinking));
                    }
                    ("item/completed", "reasoning") => {
                        let text = item
                            .get("summary")
                            .and_then(Value::as_array)
                            .map(|s| {
                                s.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        let since = slock(&self.routes)
                            .get_mut(thread)
                            .and_then(|r| r.reasoning.remove(&id));
                        if !text.trim().is_empty() {
                            self.route(
                                thread,
                                ProviderEvent::Reasoning {
                                    text,
                                    duration_ms: since.map(|s| s.elapsed().as_secs_f64() * 1000.0),
                                },
                            );
                        }
                    }
                    ("item/started", "mcpToolCall") => {
                        self.route(thread, ProviderEvent::Status(AgentState::RunningTool));
                    }
                    ("item/started", "agentMessage") => {
                        self.route(thread, ProviderEvent::Status(AgentState::Writing));
                    }
                    _ => {}
                }
            }
            "turn/completed" => {
                let st = p
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let error = p
                    .pointer("/turn/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let end = match st {
                    "interrupted" => TurnEnd::Interrupted,
                    "failed" => TurnEnd::Failed,
                    _ => TurnEnd::Completed,
                };
                let turn = p.pointer("/turn/id").and_then(Value::as_str);
                let usage = slock(&self.routes).get_mut(thread).and_then(|r| {
                    r.turn = None;
                    r.spent_on(turn)
                });
                self.route(thread, ProviderEvent::TurnEnded { end, error, usage });
            }
            "thread/tokenUsage/updated" => {
                let (Some(turn), Some(total), Some(last)) = (
                    p.get("turnId").and_then(Value::as_str),
                    p.pointer("/tokenUsage/total"),
                    p.pointer("/tokenUsage/last"),
                ) else {
                    return;
                };
                if let Some(r) = slock(&self.routes).get_mut(thread) {
                    r.used(turn, usage_of(total), usage_of(last));
                }
            }
            "error" => {
                if p.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                let message = p
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex reported an error")
                    .to_owned();
                self.route(thread, ProviderEvent::Error { message });
            }
            _ => {}
        }
    }
}

fn usage_of(breakdown: &Value) -> TurnUsage {
    let n = |k: &str| breakdown.get(k).and_then(Value::as_u64).unwrap_or(0);
    TurnUsage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cached_input_tokens: n("cachedInputTokens"),
        reasoning_tokens: n("reasoningOutputTokens"),
    }
}

fn str_at(v: &Value, ptr: &str) -> String {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[async_trait]
impl AgentProvider for CodexProvider {
    fn id(&self) -> &'static str {
        CODEX
    }

    fn name(&self) -> &'static str {
        "Codex"
    }

    fn state(&self) -> ProviderState {
        slock(&self.0.state).clone()
    }

    async fn sign_in(&self) -> Result<SignIn, AgentError> {
        let client = self.0.client().await?;
        let out = client
            .request("account/login/start", json!({"type": "chatgpt"}))
            .await
            .map_err(AgentError::Provider)?;
        let url = out
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Provider("Codex gave no sign-in page".into()))?;
        Ok(SignIn {
            url: url.to_owned(),
            opened: false,
            takes_code: false,
            ended: None,
        })
    }

    fn version(&self) -> Option<String> {
        slock(&self.0.server_version).clone()
    }

    fn config_home(&self) -> Option<String> {
        Some(self.0.cfg.config_home().display().to_string())
    }

    async fn connect(&self) -> ProviderState {
        let running = self.0.client.lock().await.is_some();
        if let Ok(client) = self.0.client().await
            && running
            && !self.state().ready()
        {
            let account = client
                .request("account/read", json!({}))
                .await
                .unwrap_or(Value::Null);
            if let Some(word) = account_word(&account, None) {
                self.0.set(ProviderState::new(HealthStatus::Ok, word));
            }
        }
        self.state()
    }

    async fn models(&self) -> Vec<AgentModel> {
        if let Some(m) = slock(&self.0.models).clone() {
            return m;
        }
        let Ok(client) = self.0.client().await else {
            return codex_fallback_models();
        };
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let params = cursor
                .as_ref()
                .map_or_else(|| json!({}), |c| json!({"cursor": c}));
            let Ok(page) = client.request("model/list", params).await else {
                break;
            };
            all.extend(codex_models_from(&page));
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        if all.is_empty() {
            return codex_fallback_models();
        }
        *slock(&self.0.models) = Some(all.clone());
        all
    }

    async fn open(&self, req: OpenThread) -> Result<Arc<dyn ProviderThread>, AgentError> {
        let client = self.0.client().await?;
        if !self.state().ready() {
            return Err(AgentError::Unavailable("Codex is not signed in".into()));
        }
        let servers = slock(&self.0.user_servers).clone();
        let params = thread_params(&self.0.cfg.cwd, &req, &servers);
        let resumed = match &req.resume {
            Some(id) => {
                let mut p = params.clone();
                p["threadId"] = json!(id);
                p["excludeTurns"] = json!(true);
                client.request("thread/resume", p).await.ok()
            }
            None => None,
        };
        let started = match resumed {
            Some(r) => r,
            None => client.request("thread/start", params).await.map_err(|e| {
                AgentError::Unavailable(format!("Codex could not open a thread: {e}"))
            })?,
        };
        let thread = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Provider("Codex answered without a thread".into()))?
            .to_owned();
        if let Some(m) = started.get("model").and_then(Value::as_str) {
            let _ = req
                .events
                .send((req.session.clone(), ProviderEvent::Model(m.to_owned())));
        }
        let _ = req
            .events
            .send((req.session.clone(), ProviderEvent::Thread(thread.clone())));
        slock(&self.0.routes).insert(thread.clone(), Route::new(req.session, req.events));
        Ok(Arc::new(CodexThread {
            inner: Arc::clone(&self.0),
            client,
            thread,
        }))
    }

    async fn shutdown(&self) {
        let client = self.0.client.lock().await.take();
        if let Some(c) = client {
            c.kill().await;
        }
        slock(&self.0.routes).clear();
        *slock(&self.0.models) = None;
        *slock(&self.0.server_version) = None;
        self.0.set(ProviderState::unknown());
    }
}

pub fn thread_params(cwd: &std::path::Path, req: &OpenThread, user_servers: &[String]) -> Value {
    let mut params = json!({
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "developerInstructions": &*req.instructions,
        "config": thread_config(&req.mcp_url, req.token.expose(), user_servers),
    });
    if let Some(m) = &req.model {
        params["model"] = json!(m);
    }
    params
}

/// Codex has no document input.
pub fn turn_input(text: &str, attachments: &[TurnAttachment]) -> Value {
    let mut input = Vec::new();
    if !text.is_empty() {
        input.push(json!({"type": "text", "text": text, "text_elements": []}));
    }
    for a in attachments
        .iter()
        .filter(|a| a.content == TurnContent::Image)
    {
        input.push(json!({"type": "image", "url": format!(
            "data:{};base64,{}",
            a.mime_type,
            tessera_core::b64::encode(&a.data)
        )}));
    }
    Value::Array(input)
}

pub fn steer_params(thread: &str, turn: &str, input: &TurnInput) -> Value {
    json!({"threadId": thread,
        "input": turn_input(&input.text, &input.attachments),
        "expectedTurnId": turn})
}

struct CodexThread {
    inner: Arc<CodexInner>,
    client: Arc<CodexClient>,
    thread: String,
}

#[async_trait]
impl ProviderThread for CodexThread {
    fn thread_id(&self) -> Option<String> {
        Some(self.thread.clone())
    }

    async fn send(&self, turn: TurnInput) -> Result<(), AgentError> {
        let mut params = json!({"threadId": self.thread,
            "input": turn_input(&turn.text, &turn.attachments),
            "summary": "concise"});
        if let Some(m) = &turn.model {
            params["model"] = json!(m);
        }
        if let Some(e) = &turn.effort {
            params["effort"] = json!(e);
        }
        let out = self
            .client
            .request("turn/start", params)
            .await
            .map_err(AgentError::Unavailable)?;
        if let Some(r) = slock(&self.inner.routes).get_mut(&self.thread) {
            r.turn = out
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Ok(())
    }

    async fn steer(&self, input: TurnInput) -> Result<SteerOutcome, AgentError> {
        let turn = slock(&self.inner.routes)
            .get(&self.thread)
            .and_then(|r| r.turn.clone());
        let Some(turn) = turn else {
            return Ok(SteerOutcome::NoTurn);
        };
        self.client
            .request("turn/steer", steer_params(&self.thread, &turn, &input))
            .await
            .map_err(AgentError::Unavailable)?;
        Ok(SteerOutcome::Took)
    }

    async fn interrupt(&self) -> Result<bool, AgentError> {
        let turn = slock(&self.inner.routes)
            .get(&self.thread)
            .and_then(|r| r.turn.clone());
        let Some(turn) = turn else {
            return Ok(false);
        };
        self.client
            .request(
                "turn/interrupt",
                json!({"threadId": self.thread, "turnId": turn}),
            )
            .await
            .map_err(AgentError::Unavailable)?;
        Ok(true)
    }

    async fn close(&self) {
        slock(&self.inner.routes).remove(&self.thread);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_sends_its_images_as_data_urls_after_the_text() {
        assert_eq!(
            turn_input("hi", &[]),
            json!([{"type": "text", "text": "hi", "text_elements": []}])
        );
        let png = TurnAttachment {
            name: "chart.png".into(),
            mime_type: "image/png".into(),
            content: TurnContent::Image,
            data: Arc::from(&b"\x89PNG"[..]),
        };
        let text = TurnAttachment {
            name: "notes.md".into(),
            mime_type: "text/markdown".into(),
            content: TurnContent::Text,
            data: Arc::from(&b"# notes"[..]),
        };
        assert_eq!(
            turn_input("[Attached image \"chart.png\"]", &[png, text]),
            json!([
                {"type": "text", "text": "[Attached image \"chart.png\"]", "text_elements": []},
                {"type": "image", "url": "data:image/png;base64,iVBORw=="},
            ]),
            "a text file is in the text already, never an input of its own"
        );
    }

    #[test]
    fn a_steer_goes_into_the_turn_it_names() {
        let png = TurnAttachment {
            name: "es.png".into(),
            mime_type: "image/png".into(),
            content: TurnContent::Image,
            data: Arc::from(&b"\x89PNG"[..]),
        };
        let input = TurnInput {
            text: "And ES?".into(),
            attachments: vec![png],
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
        };
        assert_eq!(
            steer_params("thr_1", "turn_7", &input),
            json!({
                "threadId": "thr_1",
                "input": [
                    {"type": "text", "text": "And ES?", "text_elements": []},
                    {"type": "image", "url": "data:image/png;base64,iVBORw=="},
                ],
                "expectedTurnId": "turn_7",
            }),
            "the running turn keeps its model and effort"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_codex_exiting_leaves_the_one_that_replaced_it_running() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(
            &bin,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
        )
        .unwrap();
        let cfg = CodexConfig {
            bin: bin.display().to_string(),
            home: None,
            cwd: dir.path().join("cwd"),
            args: Vec::new(),
        };
        let codex = CodexProvider::new(cfg.clone(), "0.0.0");
        let (notes, _) = tokio::sync::mpsc::unbounded_channel();
        let old = CodexClient::spawn(&cfg, notes.clone()).await.unwrap();
        let new = CodexClient::spawn(&cfg, notes).await.unwrap();
        *codex.0.client.lock().await = Some(Arc::clone(&new));
        let (events, mut rx) = tokio::sync::mpsc::unbounded_channel();
        slock(&codex.0.routes).insert("thr_new".into(), Route::new(SessionId::new("S2"), events));

        codex.0.exited(&Arc::downgrade(&old)).await;
        assert!(codex.0.client.lock().await.is_some(), "the new one is kept");
        assert!(slock(&codex.0.routes).contains_key("thr_new"));
        assert!(rx.try_recv().is_err(), "its sessions hear nothing");

        codex.0.exited(&Arc::downgrade(&new)).await;
        assert!(codex.0.client.lock().await.is_none());
        assert!(matches!(
            rx.try_recv(),
            Ok((_, ProviderEvent::Exited { .. }))
        ));
        old.kill().await;
        new.kill().await;
    }

    #[tokio::test]
    async fn a_turn_reports_the_tokens_its_own_model_requests_added_to_the_thread() {
        let codex = CodexProvider::new(
            CodexConfig {
                bin: "codex".into(),
                home: None,
                cwd: "/tmp/tessera-agents/cwd".into(),
                args: Vec::new(),
            },
            "0.0.0",
        );
        let (events, mut rx) = tokio::sync::mpsc::unbounded_channel();
        slock(&codex.0.routes).insert("thr_1".into(), Route::new(SessionId::new("S1"), events));
        let breakdown = |input: u64, cached: u64, output: u64, reasoning: u64| {
            json!({"inputTokens": input, "cachedInputTokens": cached, "outputTokens": output,
                   "reasoningOutputTokens": reasoning, "totalTokens": input + output})
        };
        let used = |turn: &str, last: [u64; 4], total: [u64; 4]| {
            json!({"threadId": "thr_1", "turnId": turn, "tokenUsage": {
                "last": breakdown(last[0], last[1], last[2], last[3]),
                "total": breakdown(total[0], total[1], total[2], total[3]),
                "modelContextWindow": 272_000}})
        };
        let completed = |turn: &str| json!({"threadId": "thr_1", "turn": {"id": turn, "items": [], "status": "completed"}});
        for note in [
            used(
                "turn_0",
                [50_000, 0, 10, 0],
                [900_000, 800_000, 9_000, 4_000],
            ),
            used(
                "turn_1",
                [12_000, 8_000, 300, 120],
                [912_000, 808_000, 9_300, 4_120],
            ),
            used(
                "turn_1",
                [13_000, 12_000, 450, 0],
                [925_000, 820_000, 9_750, 4_120],
            ),
            used(
                "turn_1",
                [13_000, 12_000, 450, 0],
                [925_000, 820_000, 9_750, 4_120],
            ),
        ] {
            codex.0.on_note("thread/tokenUsage/updated", &note).await;
        }
        codex
            .0
            .on_note("turn/completed", &completed("turn_1"))
            .await;
        codex
            .0
            .on_note("turn/completed", &completed("turn_2"))
            .await;
        let mut ended = Vec::new();
        while let Ok((_, ev)) = rx.try_recv() {
            ended.push(ev);
        }
        assert_eq!(
            ended,
            [
                ProviderEvent::TurnEnded {
                    end: TurnEnd::Completed,
                    error: None,
                    usage: Some(TurnUsage {
                        input_tokens: 25_000,
                        output_tokens: 750,
                        cached_input_tokens: 20_000,
                        reasoning_tokens: 120,
                    }),
                },
                ProviderEvent::TurnEnded {
                    end: TurnEnd::Completed,
                    error: None,
                    usage: None,
                },
            ],
            "an earlier turn's requests and a repeated update are not counted, and a turn with none reports none"
        );
    }

    #[test]
    fn a_thread_reaches_tessera_only() {
        let cfg = thread_config(
            "http://127.0.0.1:1/mcp",
            "tsk_x",
            &["doop".into(), "tessera".into()],
        );
        assert_eq!(
            cfg["mcp_servers"]["tessera"]["http_headers"]["Authorization"],
            "Bearer tsk_x"
        );
        assert_eq!(cfg["features.shell_tool"], false);
        assert_eq!(cfg["shell_environment_policy.inherit"], "core");
        assert_eq!(cfg["web_search"], "disabled");
        assert_eq!(cfg["mcp_servers.doop.enabled"], false);
        assert!(cfg.get("mcp_servers.tessera.enabled").is_none());
    }

    #[test]
    fn a_thread_opens_with_the_users_standing_instructions() {
        let (events, _rx) = tokio::sync::mpsc::unbounded_channel();
        let req = OpenThread {
            session: tessera_core::ids::SessionId::new("S1"),
            mcp_url: "http://127.0.0.1:1/mcp".into(),
            token: tessera_core::token::Secret::new("tsk_x"),
            instructions: crate::service::brief("Always quote prices in ticks.").into(),
            model: Some("gpt-5.5".into()),
            effort: None,
            resume: None,
            events,
        };
        let params = thread_params(std::path::Path::new("/tmp/tessera"), &req, &[]);
        let dev = params["developerInstructions"].as_str().unwrap();
        assert!(dev.starts_with("You are the analyst in Tessera"), "{dev}");
        assert!(
            dev.ends_with(
                "The user's standing instructions (follow them unless they conflict with Tessera's rules above):\nAlways quote prices in ticks."
            ),
            "{dev}"
        );
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["sandbox"], "read-only");
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(
            params["config"]["mcp_servers"]["tessera"]["http_headers"]["Authorization"],
            "Bearer tsk_x"
        );
        let plain = OpenThread {
            instructions: crate::service::brief("  \n ").into(),
            model: None,
            ..req
        };
        let params = thread_params(std::path::Path::new("/tmp/tessera"), &plain, &[]);
        assert_eq!(
            params["developerInstructions"],
            crate::service::INSTRUCTIONS
        );
        assert!(params.get("model").is_none());
    }

    #[test]
    fn the_app_servers_version_is_read_from_its_initialize_answer() {
        assert_eq!(
            codex_version(
                &json!({"userAgent": "codex_cli_rs/0.46.0 (Ubuntu 24.4.0; x86_64) xterm"})
            )
            .as_deref(),
            Some("0.46.0")
        );
        assert_eq!(
            codex_version(&json!({"serverInfo": {"version": "0.50.1"}, "userAgent": "x/1.0.0"}))
                .as_deref(),
            Some("0.50.1")
        );
        assert_eq!(codex_version(&json!({"userAgent": "tessera"})), None);
        assert_eq!(codex_version(&json!({"userAgent": "codex/dev"})), None);
        assert_eq!(codex_version(&json!({})), None);
    }

    #[test]
    fn a_clis_home_is_its_configured_one_else_its_default() {
        use crate::AgentProvider;
        let home = std::env::home_dir().unwrap();
        let in_home = |d: &str| Some(home.join(d).display().to_string());
        let codex = |h: Option<&str>| {
            CodexProvider::new(
                CodexConfig {
                    bin: "codex".into(),
                    home: h.map(std::path::PathBuf::from),
                    cwd: "/tmp/tessera-agents/cwd".into(),
                    args: Vec::new(),
                },
                "0.0.0",
            )
        };
        assert_eq!(codex(None).config_home(), in_home(".codex"));
        assert_eq!(
            codex(Some("/srv/codex-home")).config_home().as_deref(),
            Some("/srv/codex-home")
        );
        assert_eq!(codex(None).version(), None, "none until it ran");
        let claude = |d: Option<&str>| {
            crate::ClaudeProvider::new(crate::ClaudeConfig {
                bin: "claude".into(),
                config_dir: d.map(std::path::PathBuf::from),
                cwd: "/tmp/tessera-agents/cwd".into(),
                state_dir: "/tmp/tessera-agents/sessions".into(),
                args: Vec::new(),
                installer: Vec::new(),
            })
        };
        assert_eq!(claude(None).config_home(), in_home(".claude"));
        assert_eq!(
            claude(Some("/srv/claude-home")).config_home().as_deref(),
            Some("/srv/claude-home")
        );
        assert_eq!(crate::expand_home("~/.codex"), home.join(".codex"));
    }

    #[test]
    fn a_custom_providers_key_variable_is_forwarded() {
        let toml = "model = \"x\"\n[model_providers.p]\nenv_key = \"MY_PROXY_KEY\"\nenv_key = \"bad key\"\n";
        assert_eq!(env_keys_in(toml), vec!["MY_PROXY_KEY".to_owned()]);
    }

    #[test]
    fn the_account_reads_as_its_plan_or_its_provider() {
        let chatgpt = json!({"account": {"type": "chatgpt", "email": "x", "planType": "pro"}});
        assert_eq!(
            account_word(&chatgpt, None).as_deref(),
            Some("ChatGPT · pro")
        );
        let proxy = json!({"account": null, "requiresOpenaiAuth": false});
        assert_eq!(
            account_word(&proxy, Some("CLIProxyAPI")).as_deref(),
            Some("via CLIProxyAPI")
        );
        let out = json!({"account": null, "requiresOpenaiAuth": true});
        assert_eq!(account_word(&out, None), None);
    }
}
