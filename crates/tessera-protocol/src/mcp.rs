use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use ts_rs::TS;

pub const CLIENT_NAME_MAX: usize = 60;

/// Which agent a client is: decides the setup Tessera writes for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum McpClientKind {
    /// Claude Desktop (`claude_desktop_config.json`).
    ClaudeDesktop,
    /// Claude Code (`claude mcp add`).
    ClaudeCode,
    /// The Codex CLI (`~/.codex/config.toml`).
    Codex,
    /// Cursor (`~/.cursor/mcp.json`).
    Cursor,
    /// Any other MCP client (the usual `mcpServers` JSON).
    Other,
}

impl McpClientKind {
    pub const ALL: [McpClientKind; 5] = [
        McpClientKind::ClaudeDesktop,
        McpClientKind::ClaudeCode,
        McpClientKind::Codex,
        McpClientKind::Cursor,
        McpClientKind::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            McpClientKind::ClaudeDesktop => "claude-desktop",
            McpClientKind::ClaudeCode => "claude-code",
            McpClientKind::Codex => "codex",
            McpClientKind::Cursor => "cursor",
            McpClientKind::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            McpClientKind::ClaudeDesktop => "Claude Desktop",
            McpClientKind::ClaudeCode => "Claude Code",
            McpClientKind::Codex => "Codex",
            McpClientKind::Cursor => "Cursor",
            McpClientKind::Other => "MCP client",
        }
    }
}

/// What a client may do. Neither lets it approve anything: orders it places are drafts the user approves in
/// Tessera, and Tessera's user-only tools are never shown to it.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum McpClientPolicy {
    /// It reads only: changes and orders are not even listed to it.
    ReadOnly,
    /// It reads; a change asks the user first, and an order is a draft the user approves.
    #[default]
    Supervised,
}

impl McpClientPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            McpClientPolicy::ReadOnly => "read_only",
            McpClientPolicy::Supervised => "supervised",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read_only" => Some(McpClientPolicy::ReadOnly),
            "supervised" => Some(McpClientPolicy::Supervised),
            _ => None,
        }
    }
}

/// A connected client (never its token).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    /// Its id (`claude-desktop`, `cursor-2`): what its calls, drafts and records name it by.
    pub id: String,
    /// Its name (`Claude Desktop`, or the user's own).
    pub name: String,
    /// Which agent it is.
    pub kind: McpClientKind,
    /// What it may do.
    pub policy: McpClientPolicy,
    /// When the user connected it.
    pub created_at: Timestamp,
    /// When it last called Tessera (to the minute); none before its first call.
    pub last_used_at: Option<Timestamp>,
}

/// The format of a setup snippet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpSnippetFormat {
    /// A JSON config file's content.
    Json,
    /// A command to run in a terminal.
    Shell,
    /// A TOML config file's block.
    Toml,
}

/// One ready-to-use piece of setup for a client: its token included, shown once.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSnippet {
    /// Where it goes, in plain words (`Add to claude_desktop_config.json`, `Run in a terminal`).
    pub label: String,
    /// The file it goes in, spelled out for this machine (`~/.codex/config.toml`); none for a command.
    pub file: Option<String>,
    /// Its format.
    pub format: McpSnippetFormat,
    /// The text to copy.
    pub text: String,
}

impl std::fmt::Debug for McpSnippet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpSnippet")
            .field("label", &self.label)
            .field("file", &self.file)
            .field("format", &self.format)
            .field("text", &"[redacted]")
            .finish()
    }
}

/// `mcp.list_clients` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpListClientsInput {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpListClientsOutput {
    /// Connected clients, oldest first (revoked ones are gone).
    pub clients: Vec<McpClientInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct McpAddClientInput {
    /// Which agent it is.
    pub kind: McpClientKind,
    /// Its name (default: the agent's own, `Claude Desktop`; 1–60 characters).
    #[serde(default)]
    pub name: Option<String>,
    /// What it may do (default: Supervised).
    #[serde(default)]
    pub policy: Option<McpClientPolicy>,
}

/// `mcp.add_client` output: the token, shown this once, and the setup that carries it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAddClientOutput {
    /// The client.
    pub client: McpClientInfo,
    /// Its bearer token (`tsk_…`): shown once, never kept by Tessera.
    pub token: String,
    /// Ready-to-use setup for its kind, the token in it.
    pub snippets: Vec<McpSnippet>,
}

impl std::fmt::Debug for McpAddClientOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpAddClientOutput")
            .field("client", &self.client)
            .field("token", &"[redacted]")
            .field("snippets", &self.snippets)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRevokeClientInput {
    /// The client's id (`mcp.list_clients`).
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpRevokeClientOutput {
    /// It was connected and is not any more (false: it was already gone).
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpSetClientPolicyInput {
    /// The client's id (`mcp.list_clients`).
    pub id: String,
    /// What it may do from its next call.
    pub policy: McpClientPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSetClientPolicyOutput {
    /// The client as it is now.
    pub client: McpClientInfo,
}

/// `mcp.add_to_claude_desktop` input: the client and the token `mcp.add_client` just gave.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAddToClaudeDesktopInput {
    /// The client's id.
    pub id: String,
    /// Its token, as `mcp.add_client` gave it (checked against the client; never kept).
    pub token: String,
}

impl std::fmt::Debug for McpAddToClaudeDesktopInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpAddToClaudeDesktopInput")
            .field("id", &self.id)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAddToClaudeDesktopOutput {
    /// The config file written.
    pub path: String,
    /// The copy of it made first; none when there was no file yet.
    pub backup: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_policies_keep_their_wire_ids() {
        for k in McpClientKind::ALL {
            assert_eq!(
                serde_json::to_value(k).unwrap(),
                serde_json::json!(k.as_str())
            );
            assert_eq!(McpClientKind::parse(k.as_str()), Some(k));
        }
        for p in [McpClientPolicy::ReadOnly, McpClientPolicy::Supervised] {
            assert_eq!(
                serde_json::to_value(p).unwrap(),
                serde_json::json!(p.as_str())
            );
            assert_eq!(McpClientPolicy::parse(p.as_str()), Some(p));
        }
        assert_eq!(McpClientPolicy::default(), McpClientPolicy::Supervised);
    }

    #[test]
    fn debug_output_never_shows_a_token() {
        let out = McpAddClientOutput {
            client: McpClientInfo {
                id: "cursor".into(),
                name: "Cursor".into(),
                kind: McpClientKind::Cursor,
                policy: McpClientPolicy::Supervised,
                created_at: Timestamp(0),
                last_used_at: None,
            },
            token: "tsk_not-a-real-token".into(),
            snippets: vec![McpSnippet {
                label: "x".into(),
                file: None,
                format: McpSnippetFormat::Json,
                text: "tsk_not-a-real-token".into(),
            }],
        };
        assert!(!format!("{out:?}").contains("not-a-real-token"));
        let input = McpAddToClaudeDesktopInput {
            id: "cursor".into(),
            token: "tsk_not-a-real-token".into(),
        };
        assert!(!format!("{input:?}").contains("not-a-real-token"));
    }
}
