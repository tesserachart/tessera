use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_core::health::HealthStatus;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{AgentModel, AgentState, TurnEnd};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

use crate::AgentError;
use crate::child_env::create_private_dir;
use crate::models::{claude_models, parse_version};
use crate::provider::{
    AgentProvider, EventSink, OpenThread, ProviderEvent, ProviderState, ProviderThread, SignIn,
    SteerOutcome, TurnAttachment, TurnContent, TurnInput,
};
use crate::report::TurnUsage;

pub const CLAUDE: &str = "claude-code";

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

const INTERRUPT_GRACE: Duration = Duration::from_secs(4);

const SIGN_IN_START: Duration = Duration::from_secs(20);

const SIGN_IN_GIVE_UP: Duration = Duration::from_secs(15 * 60);

const IDLE_CLOSE: Duration = Duration::from_secs(10 * 60);
const STDERR_GRACE: Duration = Duration::from_secs(2);

const INSTALL_GIVE_UP: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub struct ClaudeConfig {
    pub bin: String,
    pub config_dir: Option<PathBuf>,
    pub cwd: PathBuf,
    pub state_dir: PathBuf,
    pub args: Vec<String>,
    pub installer: Vec<String>,
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}

impl ClaudeConfig {
    fn program(&self) -> PathBuf {
        let bin = Path::new(&self.bin);
        if bin.components().count() == 1 && !on_path(&self.bin) {
            let native = crate::expand_home("~/.local/bin").join(&self.bin);
            if native.is_file() {
                return native;
            }
        }
        bin.to_path_buf()
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(self.program());
        cmd.env_clear().kill_on_drop(true);
        cmd.envs(crate::child_env::from_process(&[]));
        if let Some(dir) = &self.config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        cmd.env("DISABLE_AUTOUPDATER", "1")
            .env("CLAUDE_CODE_AUTO_CONNECT_IDE", "0")
            .env("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1")
            .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false");
        cmd
    }

    pub fn config_home(&self) -> PathBuf {
        self.config_dir
            .clone()
            .unwrap_or_else(|| crate::expand_home("~/.claude"))
    }
}

async fn probe(cfg: &ClaudeConfig, args: &[&str]) -> Result<(bool, String), ProbeError> {
    let mut cmd = cfg.command();
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ProbeError::Missing
        } else {
            ProbeError::Failed(e.to_string())
        }
    })?;
    match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        )),
        Ok(Err(e)) => Err(ProbeError::Failed(e.to_string())),
        Err(_) => Err(ProbeError::Failed("timed out".into())),
    }
}

enum ProbeError {
    Missing,
    Failed(String),
}

pub fn account_word(status: &Value) -> Option<String> {
    if status.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let s = |k: &str| status.get(k).and_then(Value::as_str).unwrap_or_default();
    let provider = s("apiProvider");
    if !provider.is_empty() && provider != "firstParty" {
        return Some(format!("via {}", capitalize(provider)));
    }
    let method = s("authMethod").to_ascii_lowercase();
    if method.contains("api") && method.contains("key") {
        return Some("API key".into());
    }
    let plan = s("subscriptionType");
    Some(if plan.is_empty() {
        "Claude · signed in".into()
    } else {
        format!("Claude · {}", capitalize(plan))
    })
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

pub struct ClaudeProvider {
    cfg: Arc<ClaudeConfig>,
    state: Mutex<ProviderState>,
    version: Mutex<Option<(u32, u32, u32)>>,
    login: tokio::sync::Mutex<Option<Login>>,
}

struct Login {
    stdin: ChildStdin,
    _stop: oneshot::Sender<()>,
}

fn sign_in_url(line: &str) -> Option<String> {
    let at = line.find("https://")?;
    line[at..].split_whitespace().next().map(str::to_owned)
}

async fn discard_lines<R: AsyncBufRead + Unpin>(lines: &mut Lines<R>) {
    while let Ok(Some(_)) = lines.next_line().await {}
}

impl std::fmt::Debug for ClaudeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeProvider").finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl ClaudeProvider {
    pub fn new(cfg: ClaudeConfig) -> Self {
        Self {
            cfg: Arc::new(cfg),
            state: Mutex::new(ProviderState::unknown()),
            version: Mutex::new(None),
            login: tokio::sync::Mutex::new(None),
        }
    }

    fn set(&self, state: ProviderState) -> ProviderState {
        *lock(&self.state) = state.clone();
        state
    }
}

#[async_trait]
impl AgentProvider for ClaudeProvider {
    fn id(&self) -> &'static str {
        CLAUDE
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn state(&self) -> ProviderState {
        lock(&self.state).clone()
    }

    /// `claude auth login` opens the page in the browser itself and ends once the browser hands the sign-in
    /// back; the page it prints instead ends on a code to paste.
    async fn install(&self) -> Result<(), AgentError> {
        let Some((program, args)) = self.cfg.installer.split_first() else {
            return Err(AgentError::Unavailable(
                "Claude Code has no installer on this computer".into(),
            ));
        };
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env_clear()
            .envs(crate::child_env::from_process(&[]))
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| {
            AgentError::Provider(format!("The Claude Code installer did not start: {e}"))
        })?;
        let out = tokio::time::timeout(INSTALL_GIVE_UP, child.wait_with_output())
            .await
            .map_err(|_| {
                AgentError::Provider(
                    "The Claude Code installer ran 10 minutes and was stopped".into(),
                )
            })?
            .map_err(|e| AgentError::Provider(format!("The Claude Code installer: {e}")))?;
        if out.status.success() {
            return Ok(());
        }
        let said = [&out.stderr, &out.stdout]
            .iter()
            .filter_map(|b| {
                String::from_utf8_lossy(b)
                    .lines()
                    .map(str::trim)
                    .rfind(|l| !l.is_empty())
                    .map(str::to_owned)
            })
            .next()
            .unwrap_or_else(|| format!("it ended with {}", out.status));
        Err(AgentError::Provider(format!(
            "The Claude Code installer failed: {said}"
        )))
    }

    async fn sign_in(&self) -> Result<SignIn, AgentError> {
        let mut slot = self.login.lock().await;
        *slot = None;
        if let Some(dir) = &self.cfg.config_dir {
            create_private_dir(dir)
                .map_err(|e| AgentError::Provider(format!("Claude home: {e}")))?;
        }
        let mut cmd = self.cfg.command();
        cmd.args(["auth", "login"])
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AgentError::Unavailable("Claude Code is not installed".into())
            } else {
                AgentError::Provider(format!("Claude Code did not start its sign-in: {e}"))
            }
        })?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(AgentError::Provider("claude: no stdio".into()));
        };
        let mut lines = BufReader::new(stdout).lines();
        let url = tokio::time::timeout(SIGN_IN_START, async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = sign_in_url(&line) {
                    return Some(url);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| AgentError::Provider("Claude Code did not show its sign-in page".into()))?;
        let (stop, stopped) = oneshot::channel::<()>();
        let (end, ended) = oneshot::channel();
        tokio::spawn(async move {
            tokio::select! {
                _ = async {
                    tokio::join!(discard_lines(&mut lines), child.wait())
                } => {}
                _ = stopped => {}
                _ = tokio::time::sleep(SIGN_IN_GIVE_UP) => {}
            }
            let _ = child.start_kill();
            let _ = end.send(());
        });
        *slot = Some(Login { stdin, _stop: stop });
        Ok(SignIn {
            url,
            opened: true,
            takes_code: true,
            ended: Some(ended),
        })
    }

    async fn sign_in_code(&self, code: &str) -> Result<(), AgentError> {
        let mut slot = self.login.lock().await;
        let gone = || AgentError::Unavailable("That sign-in ended: sign in again".into());
        let login = slot.as_mut().ok_or_else(gone)?;
        let line = format!("{}\n", code.trim());
        login
            .stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|_| gone())?;
        login.stdin.flush().await.map_err(|_| gone())
    }

    fn version(&self) -> Option<String> {
        lock(&self.version).map(|(a, b, c)| format!("{a}.{b}.{c}"))
    }

    fn config_home(&self) -> Option<String> {
        Some(self.cfg.config_home().display().to_string())
    }

    fn reads_pdfs(&self) -> bool {
        true
    }

    async fn connect(&self) -> ProviderState {
        match probe(&self.cfg, &["--version"]).await {
            Ok((true, out)) => *lock(&self.version) = parse_version(&out),
            Ok((false, _)) => {
                return self.set(ProviderState::new(
                    HealthStatus::Down,
                    "Claude Code is installed but did not run",
                ));
            }
            Err(ProbeError::Missing) => {
                return self.set(ProviderState::new(
                    HealthStatus::Down,
                    "Claude Code is not installed",
                ));
            }
            Err(ProbeError::Failed(e)) => {
                return self.set(ProviderState::new(
                    HealthStatus::Down,
                    format!("Claude Code did not run: {e}"),
                ));
            }
        }
        // the CLI would create a home that does not exist yet
        if self.cfg.config_dir.as_ref().is_some_and(|d| !d.is_dir()) {
            return self.set(ProviderState::new(
                HealthStatus::Disconnected,
                "Not signed in",
            ));
        }
        let status = match probe(&self.cfg, &["auth", "status", "--json"]).await {
            Ok((_, out)) => serde_json::from_str::<Value>(out.trim()).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        self.set(match account_word(&status) {
            Some(word) => ProviderState::new(HealthStatus::Ok, word),
            None => ProviderState::new(HealthStatus::Disconnected, "Not signed in"),
        })
    }

    async fn models(&self) -> Vec<AgentModel> {
        claude_models(*lock(&self.version))
    }

    async fn open(&self, req: OpenThread) -> Result<Arc<dyn ProviderThread>, AgentError> {
        Ok(Arc::new(ClaudeThread::new(Arc::clone(&self.cfg), req)?))
    }

    async fn shutdown(&self) {
        *self.login.lock().await = None;
        *lock(&self.version) = None;
        self.set(ProviderState::unknown());
    }
}

#[derive(Debug)]
enum Block {
    Text { id: String, text: String },
    Thinking { text: String, since_ms: f64 },
    Other,
}

/// Claude Code streams each message as `stream_event` partials, then sends it again whole as
/// `assistant`.
#[derive(Debug, Default)]
pub struct ClaudeStream {
    message: Option<String>,
    blocks: HashMap<u64, Block>,
    streamed: HashSet<String>,
    sent_text: bool,
    error_reported: bool,
    interrupting: bool,
    steered: bool,
    usage: Option<TurnUsage>,
}

impl ClaudeStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn interrupting(&mut self) {
        self.interrupting = true;
    }

    pub fn steering(&mut self) -> bool {
        if self.interrupting {
            return false;
        }
        self.steered = true;
        true
    }

    fn next_message(&mut self) {
        self.sent_text = false;
        self.error_reported = false;
        self.blocks.clear();
        self.message = None;
    }

    pub fn feed(&mut self, line: &Value, now_ms: f64) -> Vec<ProviderEvent> {
        let mut out = Vec::new();
        let sub = line.get("parent_tool_use_id").is_some_and(|p| !p.is_null());
        match line.get("type").and_then(Value::as_str).unwrap_or_default() {
            "system" if line.get("subtype").and_then(Value::as_str) == Some("init") => {
                if let Some(id) = line.get("session_id").and_then(Value::as_str) {
                    out.push(ProviderEvent::Thread(id.to_owned()));
                }
                if let Some(m) = line.get("model").and_then(Value::as_str) {
                    out.push(ProviderEvent::Model(m.to_owned()));
                }
                let tessera = line
                    .get("mcp_servers")
                    .and_then(Value::as_array)
                    .and_then(|s| {
                        s.iter()
                            .find(|s| s.get("name").and_then(Value::as_str) == Some("tessera"))
                    })
                    .and_then(|s| s.get("status").and_then(Value::as_str));
                if tessera == Some("failed") {
                    out.push(ProviderEvent::Error {
                        message: "Claude Code could not reach Tessera's tools".into(),
                    });
                }
            }
            "stream_event" if !sub => self.stream_event(line.get("event"), now_ms, &mut out),
            "assistant" if !sub => self.snapshot(line, now_ms, &mut out),
            "user" if !sub => {
                if is_tool_result(line) {
                    out.push(ProviderEvent::Status(AgentState::Thinking));
                }
            }
            "result" => self.result(line, &mut out),
            _ => {}
        }
        out
    }

    fn stream_event(&mut self, ev: Option<&Value>, now_ms: f64, out: &mut Vec<ProviderEvent>) {
        let Some(ev) = ev else { return };
        let index = ev.get("index").and_then(Value::as_u64).unwrap_or(0);
        match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
            "message_start" => {
                let id = ev
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                self.streamed.insert(id.clone());
                self.message = Some(id);
                self.blocks.clear();
            }
            "content_block_start" => {
                let kind = ev
                    .pointer("/content_block/type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let block = match kind {
                    "text" => {
                        out.push(ProviderEvent::Status(AgentState::Writing));
                        Block::Text {
                            id: format!("{}:{index}", self.message.as_deref().unwrap_or("m")),
                            text: String::new(),
                        }
                    }
                    "thinking" => {
                        out.push(ProviderEvent::Status(AgentState::Thinking));
                        Block::Thinking {
                            text: String::new(),
                            since_ms: now_ms,
                        }
                    }
                    "tool_use" | "server_tool_use" => {
                        out.push(ProviderEvent::Status(AgentState::RunningTool));
                        Block::Other
                    }
                    _ => Block::Other,
                };
                self.blocks.insert(index, block);
            }
            "content_block_delta" => {
                let delta = ev.get("delta");
                match (
                    self.blocks.get_mut(&index),
                    delta.and_then(|d| d.get("type")).and_then(Value::as_str),
                ) {
                    (Some(Block::Text { id, text }), Some("text_delta")) => {
                        let piece = delta
                            .and_then(|d| d.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !piece.is_empty() {
                            text.push_str(piece);
                            self.sent_text = true;
                            out.push(ProviderEvent::Delta {
                                message_id: id.clone(),
                                text: piece.to_owned(),
                            });
                        }
                    }
                    (Some(Block::Thinking { text, .. }), Some("thinking_delta")) => {
                        text.push_str(
                            delta
                                .and_then(|d| d.get("thinking"))
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        );
                    }
                    _ => {}
                }
            }
            "content_block_stop" => match self.blocks.remove(&index) {
                Some(Block::Text { id, text }) if !text.is_empty() => {
                    out.push(ProviderEvent::Message {
                        message_id: id,
                        text,
                    });
                }
                Some(Block::Thinking { text, since_ms }) if !text.trim().is_empty() => {
                    out.push(ProviderEvent::Reasoning {
                        text: text.trim().to_owned(),
                        duration_ms: Some((now_ms - since_ms).max(0.0)),
                    });
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn snapshot(&mut self, line: &Value, _now_ms: f64, out: &mut Vec<ProviderEvent>) {
        let text = text_of(line.pointer("/message/content"));
        if let Some(err) = line.get("error").and_then(Value::as_str) {
            self.error_reported = true;
            out.push(ProviderEvent::Error {
                message: match err {
                    "authentication_failed" => {
                        "Claude Code is not signed in. Sign in in Settings › Analyst, then ask again."
                            .into()
                    }
                    "rate_limit" => {
                        if text.is_empty() {
                            "Claude's usage limit is reached for now".into()
                        } else {
                            text
                        }
                    }
                    _ if !text.is_empty() => text,
                    other => format!("Claude Code reported {other}"),
                },
            });
            return;
        }
        let id = line
            .pointer("/message/id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if self.streamed.contains(id) {
            return;
        }
        let Some(content) = line.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for (i, block) in content.iter().enumerate() {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let t = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !t.is_empty() {
                        self.sent_text = true;
                        out.push(ProviderEvent::Message {
                            message_id: format!("{id}:s{i}"),
                            text: t.to_owned(),
                        });
                    }
                }
                Some("thinking") => {
                    let t = block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !t.trim().is_empty() {
                        out.push(ProviderEvent::Reasoning {
                            text: t.trim().to_owned(),
                            duration_ms: None,
                        });
                    }
                }
                Some("tool_use") => out.push(ProviderEvent::Status(AgentState::RunningTool)),
                _ => {}
            }
        }
    }

    fn result(&mut self, line: &Value, out: &mut Vec<ProviderEvent>) {
        if let Some(used) = usage_of(line) {
            self.usage = Some(self.usage.unwrap_or_default() + used);
        }
        let s = |k: &str| line.get(k).and_then(Value::as_str).unwrap_or_default();
        let subtype = s("subtype");
        let reason = s("terminal_reason");
        if self.steered
            && !self.interrupting
            && matches!(reason, "aborted_streaming" | "aborted_tools")
        {
            self.next_message();
            return;
        }
        let is_error = line.get("is_error").and_then(Value::as_bool) == Some(true)
            || subtype.starts_with("error");
        let first_error = line
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|e| {
                e.iter()
                    .filter_map(Value::as_str)
                    .find(|e| !e.starts_with("[ede_diagnostic]"))
            })
            .map(str::to_owned);
        let aborted = reason.starts_with("aborted")
            || first_error
                .as_deref()
                .is_some_and(|e| e.to_ascii_lowercase().contains("interrupt"));
        let (end, error) = if self.interrupting || aborted {
            (TurnEnd::Interrupted, None)
        } else if is_error {
            let said =
                first_error.or_else(|| Some(s("result").to_owned()).filter(|t| !t.is_empty()));
            let error = if self.error_reported {
                None
            } else {
                Some(said.unwrap_or_else(|| format!("Claude Code stopped ({subtype})")))
            };
            (TurnEnd::Failed, error)
        } else {
            let answer = s("result");
            if !self.sent_text && !answer.trim().is_empty() {
                out.push(ProviderEvent::Message {
                    message_id: format!("{}:result", s("uuid")),
                    text: answer.to_owned(),
                });
            }
            (TurnEnd::Completed, None)
        };
        out.push(ProviderEvent::TurnEnded {
            end,
            error,
            usage: self.usage.take(),
        });
        self.next_message();
        self.interrupting = false;
        self.steered = false;
    }
}

fn usage_of(line: &Value) -> Option<TurnUsage> {
    let usage = line.get("usage").filter(|u| u.is_object())?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let cache_read = n("cache_read_input_tokens");
    Some(TurnUsage {
        input_tokens: n("input_tokens") + n("cache_creation_input_tokens") + cache_read,
        output_tokens: n("output_tokens"),
        cached_input_tokens: cache_read,
        reasoning_tokens: 0,
    })
}

fn is_tool_result(line: &Value) -> bool {
    line.pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|c| {
            c.iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
}

fn text_of(content: Option<&Value>) -> String {
    content
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub fn user_line(text: &str, attachments: &[TurnAttachment]) -> String {
    user_message(text, attachments).to_string()
}

pub fn steer_line(text: &str, attachments: &[TurnAttachment]) -> String {
    let mut line = user_message(text, attachments);
    line["priority"] = json!("now");
    line.to_string()
}

fn user_message(text: &str, attachments: &[TurnAttachment]) -> Value {
    let mut content: Vec<Value> = attachments
        .iter()
        .filter_map(|a| {
            let kind = match a.content {
                TurnContent::Image => "image",
                TurnContent::Pdf => "document",
                TurnContent::Text => return None,
            };
            Some(json!({"type": kind, "source": {
                "type": "base64",
                "media_type": a.mime_type,
                "data": tessera_core::b64::encode(&a.data),
            }}))
        })
        .collect();
    if !text.is_empty() || content.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": null,
    })
}

pub const SETTINGS: &str = r#"{"disableAllHooks":true,"permissions":{"deny":["Bash","Read","Edit","Write","NotebookEdit","Glob","Grep","WebFetch","WebSearch"]}}"#;

pub fn claude_args(
    mcp_config: &str,
    instructions: &str,
    model: Option<&str>,
    effort: Option<&str>,
    session: &str,
    resume: bool,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--thinking",
        "adaptive",
        "--thinking-display",
        "summarized",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        mcp_config,
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "mcp__tessera__*",
        "--settings",
        SETTINGS,
        "--append-system-prompt",
        instructions,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(m) = model {
        args.extend(["--model".into(), m.to_owned()]);
    }
    if let Some(e) = effort {
        args.extend(["--effort".into(), e.to_owned()]);
    }
    args.extend([
        if resume { "--resume" } else { "--session-id" }.to_owned(),
        session.to_owned(),
    ]);
    args
}

pub fn mcp_config(url: &str, token: &str) -> Value {
    json!({"mcpServers": {"tessera": {
        "type": "http",
        "url": url,
        "headers": {"Authorization": format!("Bearer {token}")},
    }}})
}

struct Proc {
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    child: Child,
    model: Option<String>,
    effort: Option<String>,
    generation: u64,
}

#[derive(Default)]
struct Shared {
    resumable: AtomicBool,
    running: AtomicBool,
    turns: AtomicU64,
    generation: AtomicU64,
    stream: Mutex<Option<ClaudeStream>>,
}

struct ClaudeThread {
    cfg: Arc<ClaudeConfig>,
    session: SessionId,
    uuid: String,
    mcp_file: PathBuf,
    instructions: Arc<str>,
    events: EventSink,
    proc: Arc<tokio::sync::Mutex<Option<Proc>>>,
    shared: Arc<Shared>,
    clock: Instant,
}

impl ClaudeThread {
    fn new(cfg: Arc<ClaudeConfig>, req: OpenThread) -> Result<Self, AgentError> {
        create_private_dir(&cfg.cwd)
            .map_err(|e| AgentError::Provider(format!("working directory: {e}")))?;
        create_private_dir(&cfg.state_dir)
            .map_err(|e| AgentError::Provider(format!("state directory: {e}")))?;
        let mcp_file = cfg.state_dir.join(format!("{}.mcp.json", req.session));
        write_private(
            &mcp_file,
            &mcp_config(&req.mcp_url, req.token.expose()).to_string(),
        )
        .map_err(|e| AgentError::Provider(format!("MCP config: {e}")))?;
        let shared = Shared {
            resumable: AtomicBool::new(req.resume.is_some()),
            ..Shared::default()
        };
        Ok(Self {
            uuid: req
                .resume
                .unwrap_or_else(|| uuid::Uuid::now_v7().hyphenated().to_string()),
            cfg,
            session: req.session,
            mcp_file,
            instructions: req.instructions,
            events: req.events,
            proc: Arc::new(tokio::sync::Mutex::new(None)),
            shared: Arc::new(shared),
            clock: Instant::now(),
        })
    }

    fn emit(&self, ev: ProviderEvent) {
        let _ = self.events.send((self.session.clone(), ev));
    }

    fn spawn(&self, model: Option<String>, effort: Option<String>) -> Result<Proc, AgentError> {
        let resume = self.shared.resumable.load(Ordering::SeqCst);
        let mut cmd = self.cfg.command();
        cmd.args(&self.cfg.args)
            .args(claude_args(
                &self.mcp_file.to_string_lossy(),
                &self.instructions,
                model.as_deref(),
                effort.as_deref(),
                &self.uuid,
                resume,
            ))
            .current_dir(&self.cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            AgentError::Unavailable(if e.kind() == std::io::ErrorKind::NotFound {
                "Claude Code is not installed".into()
            } else {
                format!("Claude Code did not start: {e}")
            })
        })?;
        let stdin =
            Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or_else(
                || AgentError::Provider("claude: no stdin".into()),
            )?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Provider("claude: no stdout".into()))?;
        let stderr = child.stderr.take();
        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.shared.stream) = Some(ClaudeStream::new());

        let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let mut said = None;
        if let Some(err) = stderr {
            let tail = Arc::clone(&tail);
            said = Some(tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut t = lock(&tail);
                    if t.len() == 8 {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            }));
        }
        let shared = Arc::clone(&self.shared);
        let events = self.events.clone();
        let sid = self.session.clone();
        let writer = Arc::clone(&stdin);
        let clock = self.clock;
        let slot = Arc::clone(&self.proc);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if msg.get("type").and_then(Value::as_str) == Some("control_request") {
                    answer_control(&writer, &msg).await;
                    continue;
                }
                if msg.get("subtype").and_then(Value::as_str) == Some("init") {
                    let mcp = msg
                        .get("mcp_servers")
                        .and_then(Value::as_array)
                        .and_then(|s| {
                            s.iter()
                                .find(|s| s.get("name").and_then(Value::as_str) == Some("tessera"))
                        })
                        .and_then(|s| s.get("status").and_then(Value::as_str))
                        .unwrap_or("absent")
                        .to_owned();
                    let tools = msg
                        .get("tools")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    tracing::info!(session = %sid, mcp = %mcp, tools, "claude code started");
                }
                let now = clock.elapsed().as_secs_f64() * 1000.0;
                let out = lock(&shared.stream)
                    .as_mut()
                    .map(|s| s.feed(&msg, now))
                    .unwrap_or_default();
                for ev in out {
                    if let ProviderEvent::TurnEnded { end, .. } = &ev {
                        shared.running.store(false, Ordering::SeqCst);
                        // Claude Code saves the conversation once a turn completes or is interrupted
                        if matches!(end, TurnEnd::Completed | TurnEnd::Interrupted) {
                            shared.resumable.store(true, Ordering::SeqCst);
                        }
                        close_when_idle(&shared, &slot, generation);
                    }
                    let _ = events.send((sid.clone(), ev));
                }
            }
            if let Some(said) = said {
                let _ = tokio::time::timeout(STDERR_GRACE, said).await;
            }
            // Claude Code does not have a conversation that never got past its first turn
            if lock(&tail)
                .iter()
                .any(|l| l.contains("No conversation found"))
            {
                shared.resumable.store(false, Ordering::SeqCst);
                let _ = events.send((sid.clone(), ProviderEvent::ThreadLost));
            }
            if shared.generation.load(Ordering::SeqCst) == generation
                && shared.running.swap(false, Ordering::SeqCst)
            {
                let said = lock(&tail)
                    .iter()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .cloned();
                let _ = events.send((
                    sid,
                    ProviderEvent::Exited {
                        message: said.map_or_else(
                            || "Claude Code stopped".into(),
                            |l| format!("Claude Code stopped: {l}"),
                        ),
                    },
                ));
            }
        });
        Ok(Proc {
            stdin,
            child,
            model,
            effort,
            generation,
        })
    }
}

fn close_when_idle(
    shared: &Arc<Shared>,
    slot: &Arc<tokio::sync::Mutex<Option<Proc>>>,
    generation: u64,
) {
    let turns = shared.turns.load(Ordering::SeqCst);
    let (shared, slot) = (Arc::clone(shared), Arc::clone(slot));
    tokio::spawn(async move {
        tokio::time::sleep(IDLE_CLOSE).await;
        let mut proc = slot.lock().await;
        let idle = !shared.running.load(Ordering::SeqCst)
            && shared.turns.load(Ordering::SeqCst) == turns
            && proc.as_ref().is_some_and(|p| p.generation == generation);
        if idle && let Some(mut p) = proc.take() {
            let _ = p.child.start_kill();
        }
    });
}

async fn answer_control(stdin: &tokio::sync::Mutex<ChildStdin>, msg: &Value) {
    let id = msg.get("request_id").cloned().unwrap_or(Value::Null);
    let req = msg.get("request").cloned().unwrap_or(Value::Null);
    let response = match req.get("subtype").and_then(Value::as_str) {
        Some("can_use_tool") => {
            let tool = req
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if tool.starts_with("mcp__tessera__") {
                json!({"behavior": "allow", "updatedInput": req.get("input").cloned().unwrap_or(json!({}))})
            } else {
                json!({"behavior": "deny", "message": "Only Tessera's tools are available here."})
            }
        }
        _ => json!({}),
    };
    let line = json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": id, "response": response}})
    .to_string();
    let _ = write_line(stdin, &line).await;
}

async fn write_line(stdin: &tokio::sync::Mutex<ChildStdin>, line: &str) -> std::io::Result<()> {
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}

fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    tessera_core::private::owner_only(&mut options);
    options.open(path)?.write_all(text.as_bytes())
}

#[async_trait]
impl ProviderThread for ClaudeThread {
    fn thread_id(&self) -> Option<String> {
        Some(self.uuid.clone())
    }

    async fn send(&self, turn: TurnInput) -> Result<(), AgentError> {
        let mut slot = self.proc.lock().await;
        let reuse = slot.as_mut().is_some_and(|p| {
            p.model == turn.model
                && p.effort == turn.effort
                && matches!(p.child.try_wait(), Ok(None))
        });
        if !reuse {
            if let Some(mut old) = slot.take() {
                let _ = old.child.start_kill();
            }
            *slot = Some(self.spawn(turn.model.clone(), turn.effort.clone())?);
        }
        let p = slot.as_ref().expect("a process");
        self.shared.running.store(true, Ordering::SeqCst);
        self.shared.turns.fetch_add(1, Ordering::SeqCst);
        self.emit(ProviderEvent::Status(AgentState::Thinking));
        if let Err(e) = write_line(&p.stdin, &user_line(&turn.text, &turn.attachments)).await {
            self.shared.running.store(false, Ordering::SeqCst);
            return Err(AgentError::Provider(format!(
                "Claude Code did not take the message: {e}"
            )));
        }
        Ok(())
    }

    async fn steer(&self, turn: TurnInput) -> Result<SteerOutcome, AgentError> {
        let mut slot = self.proc.lock().await;
        let alive = slot
            .as_mut()
            .is_some_and(|p| matches!(p.child.try_wait(), Ok(None)));
        let p = match slot.as_ref() {
            Some(p) if alive && self.shared.running.load(Ordering::SeqCst) => p,
            _ => return Ok(SteerOutcome::NoTurn),
        };
        let steering = lock(&self.shared.stream)
            .as_mut()
            .is_some_and(ClaudeStream::steering);
        if !steering {
            return Ok(SteerOutcome::NoTurn);
        }
        write_line(&p.stdin, &steer_line(&turn.text, &turn.attachments))
            .await
            .map_err(|e| {
                AgentError::Provider(format!("Claude Code did not take the message: {e}"))
            })?;
        Ok(SteerOutcome::Took)
    }

    async fn interrupt(&self) -> Result<bool, AgentError> {
        if !self.shared.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if let Some(s) = lock(&self.shared.stream).as_mut() {
            s.interrupting();
        }
        let (generation, turn) = {
            let slot = self.proc.lock().await;
            let Some(p) = slot.as_ref() else {
                return Ok(false);
            };
            let req = json!({"type": "control_request",
                "request_id": tessera_core::ids::unique("tessera-"),
                "request": {"subtype": "interrupt"}});
            let _ = write_line(&p.stdin, &req.to_string()).await;
            (p.generation, self.shared.turns.load(Ordering::SeqCst))
        };
        let shared = Arc::clone(&self.shared);
        let events = self.events.clone();
        let sid = self.session.clone();
        let proc = Arc::clone(&self.proc);
        tokio::spawn(async move {
            tokio::time::sleep(INTERRUPT_GRACE).await;
            if shared.generation.load(Ordering::SeqCst) != generation
                || shared.turns.load(Ordering::SeqCst) != turn
                || !shared.running.load(Ordering::SeqCst)
            {
                return;
            }
            shared.generation.fetch_add(1, Ordering::SeqCst);
            shared.running.store(false, Ordering::SeqCst);
            if let Some(mut p) = proc.lock().await.take() {
                let _ = p.child.start_kill();
            }
            let _ = events.send((
                sid,
                ProviderEvent::TurnEnded {
                    end: TurnEnd::Interrupted,
                    error: None,
                    usage: None,
                },
            ));
        });
        Ok(true)
    }

    async fn close(&self) {
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        self.shared.running.store(false, Ordering::SeqCst);
        if let Some(mut p) = self.proc.lock().await.take() {
            let _ = p.child.start_kill();
        }
        let _ = std::fs::remove_file(&self.mcp_file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<Value> {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn the_arguments_keep_claude_to_tesseras_tools() {
        let args = claude_args(
            "/x/s.mcp.json",
            "brief",
            Some("claude-opus-5-5"),
            Some("high"),
            "u-1",
            false,
        );
        let at = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args[i + 1].as_str())
        };
        assert_eq!(at("--tools"), Some(""));
        assert_eq!(at("--mcp-config"), Some("/x/s.mcp.json"));
        assert_eq!(at("--permission-mode"), Some("dontAsk"));
        assert_eq!(at("--allowedTools"), Some("mcp__tessera__*"));
        assert_eq!(at("--model"), Some("claude-opus-5-5"));
        assert_eq!(at("--effort"), Some("high"));
        assert_eq!(at("--session-id"), Some("u-1"));
        assert!(args.contains(&"--strict-mcp-config".to_owned()));
        assert!(args.contains(&"--disable-slash-commands".to_owned()));
        let settings: Value = serde_json::from_str(at("--settings").unwrap()).unwrap();
        assert_eq!(settings["disableAllHooks"], true);
        let deny: Vec<&str> = settings["permissions"]["deny"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for tool in ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"] {
            assert!(deny.contains(&tool), "{tool}");
        }
        let resumed = claude_args("f", "b", None, None, "u-1", true);
        assert!(
            resumed
                .windows(2)
                .any(|w| w[0] == "--resume" && w[1] == "u-1")
        );
        assert!(!resumed.contains(&"--model".to_owned()));
        let cfg = mcp_config("http://127.0.0.1:1/mcp", "tsk_x");
        assert_eq!(
            cfg["mcpServers"]["tessera"]["headers"]["Authorization"],
            "Bearer tsk_x"
        );
    }

    #[test]
    fn a_user_line_carries_images_and_pdfs_before_its_text() {
        let plain: Value = serde_json::from_str(&user_line("hi", &[])).unwrap();
        assert_eq!(
            plain["message"]["content"],
            json!([{"type": "text", "text": "hi"}])
        );
        let png = TurnAttachment {
            name: "chart.png".into(),
            mime_type: "image/png".into(),
            content: TurnContent::Image,
            data: Arc::from(&b"\x89PNG"[..]),
        };
        let pdf = TurnAttachment {
            name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            content: TurnContent::Pdf,
            data: Arc::from(&b"%PDF-1.4"[..]),
        };
        let line: Value =
            serde_json::from_str(&user_line("What is this?", &[png.clone(), pdf])).unwrap();
        assert_eq!(line["type"], "user");
        assert_eq!(line["parent_tool_use_id"], Value::Null);
        assert_eq!(
            line["message"]["content"],
            json!([
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw=="}},
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQ="}},
                {"type": "text", "text": "What is this?"},
            ])
        );
        let only: Value = serde_json::from_str(&user_line("", std::slice::from_ref(&png))).unwrap();
        assert_eq!(only["message"]["content"].as_array().unwrap().len(), 1);
        assert!(
            line.get("priority").is_none(),
            "a message starts its own turn"
        );
        let steer: Value = serde_json::from_str(&steer_line("And ES?", &[png])).unwrap();
        assert_eq!(
            steer["priority"], "now",
            "a steer goes into the running turn"
        );
        assert_eq!(steer["type"], "user");
        assert_eq!(steer["parent_tool_use_id"], Value::Null);
        assert_eq!(steer["message"]["content"][0]["type"], "image");
        assert_eq!(
            steer["message"]["content"][1],
            json!({"type": "text", "text": "And ES?"})
        );
    }

    #[test]
    fn the_account_reads_as_its_plan() {
        let max = json!({"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"});
        assert_eq!(account_word(&max).as_deref(), Some("Claude · Max"));
        let out = json!({"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"});
        assert_eq!(account_word(&out), None);
        let bedrock = json!({"loggedIn": true, "apiProvider": "bedrock"});
        assert_eq!(account_word(&bedrock).as_deref(), Some("via Bedrock"));
    }

    #[test]
    fn a_turn_streams_its_reasoning_and_its_answer() {
        let mut s = ClaudeStream::new();
        let mut out = Vec::new();
        for (i, l) in lines(include_str!("../tests/fixtures/claude-turn.jsonl"))
            .iter()
            .enumerate()
        {
            out.extend(s.feed(l, i as f64 * 100.0));
        }
        assert!(out.contains(&ProviderEvent::Thread(
            "0199c0de-0000-7000-8000-000000000001".into()
        )));
        assert!(out.contains(&ProviderEvent::Model("claude-opus-5-5".into())));
        let reasoning: Vec<_> = out
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Reasoning { text, duration_ms } => {
                    Some((text.clone(), *duration_ms))
                }
                _ => None,
            })
            .collect();
        assert_eq!(reasoning.len(), 1);
        assert_eq!(
            reasoning[0].0,
            "The user wants NQ's state. Read the chart first."
        );
        assert!(reasoning[0].1.unwrap() > 0.0);
        let deltas: String = out
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let finals: Vec<_> = out
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Message { message_id, text } => {
                    Some((message_id.clone(), text.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            finals.len(),
            1,
            "the snapshot of a streamed message is not repeated"
        );
        assert_eq!(deltas, finals[0].1);
        assert!(finals[0].1.starts_with("NQ is holding"));
        assert!(out.contains(&ProviderEvent::Status(AgentState::RunningTool)));
        assert_eq!(
            out.last(),
            Some(&ProviderEvent::TurnEnded {
                end: TurnEnd::Completed,
                error: None,
                usage: Some(TurnUsage {
                    input_tokens: 5_500,
                    output_tokens: 80,
                    cached_input_tokens: 4_000,
                    reasoning_tokens: 0,
                }),
            }),
            "cache reads and writes count as input"
        );
    }

    #[test]
    fn the_sign_in_page_is_read_from_what_the_login_prints() {
        assert_eq!(sign_in_url("Opening browser to sign in…"), None);
        assert_eq!(
            sign_in_url("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1")
                .as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&x=1")
        );
    }

    #[test]
    fn a_signed_out_cli_says_how_to_sign_in_once() {
        let mut s = ClaudeStream::new();
        let mut out = Vec::new();
        for l in lines(include_str!("../tests/fixtures/claude-signed-out.jsonl")) {
            out.extend(s.feed(&l, 0.0));
        }
        let errors: Vec<_> = out
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Error { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Settings › Analyst"));
        assert_eq!(
            out.last(),
            Some(&ProviderEvent::TurnEnded {
                end: TurnEnd::Failed,
                error: None,
                usage: None,
            }),
            "a result without usage reports none"
        );
    }

    #[test]
    fn a_steered_turn_runs_on_past_the_abort_the_steer_caused() {
        let ended = |end| ProviderEvent::TurnEnded {
            end,
            error: None,
            usage: None,
        };
        let result = |reason: &str, text: &str| {
            json!({"type": "result", "subtype": "success", "is_error": false, "terminal_reason": reason,
                "result": text, "uuid": "r"})
        };
        let mut s = ClaudeStream::new();
        for l in [
            json!({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "m1"}}}),
            json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "text", "text": ""}}}),
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": "NQ is"}}}),
        ] {
            s.feed(&l, 0.0);
        }
        s.steering();
        assert_eq!(
            s.feed(&result("aborted_streaming", "NQ is"), 0.0),
            Vec::new(),
            "the turn goes on with the steer"
        );
        let out = s.feed(&result("completed", "ES leads."), 0.0);
        assert!(
            matches!(&out[0], ProviderEvent::Message { text, .. } if text == "ES leads."),
            "the answer to the steer is its own: {out:?}"
        );
        assert_eq!(out.last(), Some(&ended(TurnEnd::Completed)));

        assert_eq!(
            s.feed(&result("aborted_streaming", ""), 0.0),
            vec![ended(TurnEnd::Interrupted)],
            "a later turn nobody steered ends on its abort"
        );
        s.steering();
        assert_eq!(s.feed(&result("aborted_tools", ""), 0.0), Vec::new());
        s.interrupting();
        assert!(!s.steering(), "a turn being stopped takes no steer");
        assert_eq!(
            s.feed(&result("aborted_tools", ""), 0.0),
            vec![ended(TurnEnd::Interrupted)],
            "Stop wins over a steer"
        );
    }

    #[test]
    fn a_steered_turn_reports_the_tokens_of_both_its_runs() {
        let mut s = ClaudeStream::new();
        s.steering();
        let aborted = json!({"type": "result", "subtype": "success", "is_error": false,
            "terminal_reason": "aborted_streaming", "result": "", "uuid": "r1",
            "usage": {"input_tokens": 900, "output_tokens": 15}});
        assert_eq!(s.feed(&aborted, 0.0), Vec::new());
        let answered = json!({"type": "result", "subtype": "success", "is_error": false,
            "terminal_reason": "completed", "result": "ES leads.", "uuid": "r2",
            "usage": {"input_tokens": 40, "cache_creation_input_tokens": 60,
                "cache_read_input_tokens": 900, "output_tokens": 120}});
        assert_eq!(
            s.feed(&answered, 0.0).last(),
            Some(&ProviderEvent::TurnEnded {
                end: TurnEnd::Completed,
                error: None,
                usage: Some(TurnUsage {
                    input_tokens: 1_900,
                    output_tokens: 135,
                    cached_input_tokens: 900,
                    reasoning_tokens: 0,
                }),
            })
        );
        let next = json!({"type": "result", "subtype": "success", "is_error": false,
            "result": "Done.", "uuid": "r3"});
        assert_eq!(
            s.feed(&next, 0.0).last(),
            Some(&ProviderEvent::TurnEnded {
                end: TurnEnd::Completed,
                error: None,
                usage: None,
            }),
            "the next turn counts from nothing"
        );
    }

    #[test]
    fn an_interrupted_turn_ends_interrupted() {
        let mut s = ClaudeStream::new();
        s.interrupting();
        let out = s.feed(
            &json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "errors": ["Request was aborted"]}),
            0.0,
        );
        assert_eq!(
            out,
            vec![ProviderEvent::TurnEnded {
                end: TurnEnd::Interrupted,
                error: None,
                usage: None,
            }]
        );
        let out = s.feed(
            &json!({"type": "result", "subtype": "success", "is_error": false, "result": "Done.", "uuid": "r"}),
            0.0,
        );
        assert_eq!(
            out.len(),
            2,
            "an answer that did not stream comes from the result"
        );
        assert!(matches!(&out[0], ProviderEvent::Message { text, .. } if text == "Done."));
    }
}
