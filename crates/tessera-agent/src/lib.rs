pub mod attachments;
pub mod child_env;
pub mod claude;
pub mod codex;
pub mod models;
pub mod module;
pub mod provider;
pub mod report;
pub mod service;
pub mod session;
pub mod tools;
pub mod transcript;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tessera_core::ids::SessionId;

pub use attachments::AttachmentStore;
pub use claude::{ClaudeConfig, ClaudeProvider};
pub use codex::{CodexConfig, CodexProvider};
pub use module::{AgentModule, ts_exports};
pub use provider::{AgentProvider, ProviderEvent, ProviderState, ProviderThread};
pub use report::{TurnReport, TurnSink, TurnUsage};
pub use service::{AgentService, OneAnswer};
pub use session::{ContextPolicy, Preset, SessionConfig, WorkspaceContext};
pub use tessera_protocol::agent::{AgentEvent, AgentEventEnvelope};
pub use transcript::Transcript;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentError {
    #[error("{0}")]
    Unavailable(String),
    #[error("unknown session {0}")]
    UnknownSession(SessionId),
    #[error("a turn is already running")]
    Busy,
    #[error("{0}")]
    Provider(String),
}

pub(crate) fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderSettings {
    pub enabled: bool,
    pub binary_path: Option<String>,
    pub config_dir: Option<String>,
    pub args: Vec<String>,
}

impl ProviderSettings {
    pub fn normalized(mut self) -> Self {
        let blank = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        self.binary_path = blank(self.binary_path);
        self.config_dir = blank(self.config_dir);
        self.args.retain(|a| !a.trim().is_empty());
        self
    }

    pub fn same_launch(&self, other: &Self) -> bool {
        self.binary_path == other.binary_path
            && self.config_dir == other.config_dir
            && self.args == other.args
    }
}

pub type BuildProvider = Arc<dyn Fn(&ProviderSettings) -> Arc<dyn AgentProvider> + Send + Sync>;

fn env_var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

fn binary(s: &ProviderSettings, var: &str, name: &str) -> String {
    s.binary_path
        .as_deref()
        .map(|b| expand_home(b).display().to_string())
        .or_else(|| env_var(var))
        .unwrap_or_else(|| name.into())
}

fn claude_installer() -> Vec<String> {
    if let Some(program) = env_var("TESSERA_CLAUDE_INSTALLER") {
        return vec![program];
    }
    let words: &[&str] = if cfg!(windows) {
        &[
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
        ]
    } else {
        &[
            "/bin/bash",
            "-c",
            "curl -fsSL https://claude.ai/install.sh | bash",
        ]
    };
    words.iter().map(|w| (*w).to_owned()).collect()
}

fn home(s: &ProviderSettings, var: &str) -> Option<PathBuf> {
    s.config_dir
        .clone()
        .or_else(|| env_var(var))
        .map(|h| expand_home(&h))
}

pub fn provider_builders(agents_dir: &Path, version: &'static str) -> Vec<BuildProvider> {
    let cwd = agents_dir.join("cwd");
    let state_dir = agents_dir.join("sessions");
    let codex_cwd = cwd.clone();
    let codex: BuildProvider = Arc::new(move |s: &ProviderSettings| {
        Arc::new(CodexProvider::new(
            CodexConfig {
                bin: binary(s, "TESSERA_CODEX_BIN", "codex"),
                home: home(s, "TESSERA_CODEX_HOME"),
                cwd: codex_cwd.clone(),
                args: s.args.clone(),
            },
            version,
        )) as Arc<dyn AgentProvider>
    });
    let claude: BuildProvider = Arc::new(move |s: &ProviderSettings| {
        Arc::new(ClaudeProvider::new(ClaudeConfig {
            bin: binary(s, "TESSERA_CLAUDE_BIN", "claude"),
            config_dir: home(s, "TESSERA_CLAUDE_CONFIG_DIR"),
            cwd: cwd.clone(),
            state_dir: state_dir.clone(),
            args: s.args.clone(),
            installer: claude_installer(),
        })) as Arc<dyn AgentProvider>
    });
    vec![codex, claude]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_providers_choices_read_with_blanks_as_none() {
        let s: ProviderSettings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(s, ProviderSettings::default());
        assert!(!s.enabled, "off unless turned on");
        let s: ProviderSettings = serde_json::from_value(serde_json::json!({
            "enabled": true, "binaryPath": "  ", "configDir": " ~/claude-work ", "args": ["--add-dir", " ", "/x"]
        }))
        .unwrap();
        let s = s.normalized();
        assert!(s.enabled);
        assert_eq!(s.binary_path, None);
        assert_eq!(s.config_dir.as_deref(), Some("~/claude-work"));
        assert_eq!(s.args, ["--add-dir", "/x"]);
        let mut other = s.clone();
        other.enabled = false;
        assert!(s.same_launch(&other), "on or off, it starts the same way");
        other.args.clear();
        assert!(!s.same_launch(&other));
    }

    #[test]
    fn the_providers_take_the_home_the_user_chose() {
        let builds = provider_builders(Path::new("/tmp/tessera-agents"), "0.0.0");
        let ids: Vec<&str> = builds
            .iter()
            .map(|b| b(&ProviderSettings::default()).id())
            .collect();
        assert_eq!(ids, ["codex", "claude-code"]);
        let chosen = ProviderSettings {
            enabled: true,
            config_dir: Some("/srv/claude-work".into()),
            ..ProviderSettings::default()
        };
        let claude = builds[1](&chosen);
        assert_eq!(claude.config_home().as_deref(), Some("/srv/claude-work"));
        assert_eq!(
            builds[0](&chosen).config_home().as_deref(),
            Some("/srv/claude-work")
        );
    }
}
