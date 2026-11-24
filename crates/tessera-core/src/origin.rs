use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::SessionId;

/// The origin of a tool call or action.
///
/// - `user`: the human, through the UI (`tools.invoke`).
/// - `agent`: an agent session run by Tessera (Codex, Claude Code, local).
/// - `external`: an external MCP client (Claude Desktop, Cursor…).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Origin {
    /// The human user, through the UI.
    User,
    /// An agent session.
    #[serde(rename_all = "camelCase")]
    Agent {
        /// The agent session.
        session_id: SessionId,
        /// Provider id (`codex`, `claude-code`, `local`).
        provider: String,
    },
    /// An external MCP client.
    #[serde(rename_all = "camelCase")]
    External {
        /// The client id assigned when its MCP token was issued.
        client_id: String,
    },
}

impl Origin {
    pub fn is_user(&self) -> bool {
        matches!(self, Origin::User)
    }

    pub fn session_id(&self) -> Option<&SessionId> {
        match self {
            Origin::Agent { session_id, .. } => Some(session_id),
            _ => None,
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Origin::User => "user",
            Origin::Agent { .. } => "agent",
            Origin::External { .. } => "external",
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Origin::User => f.write_str("user"),
            Origin::Agent {
                session_id,
                provider,
            } => write!(f, "agent:{provider}:{session_id}"),
            Origin::External { client_id } => write!(f, "external:{client_id}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shape() {
        let o = Origin::Agent {
            session_id: SessionId::new("S15"),
            provider: "codex".into(),
        };
        let v = serde_json::to_value(&o).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind":"agent","sessionId":"S15","provider":"codex"})
        );
        assert_eq!(
            serde_json::to_value(Origin::User).unwrap(),
            serde_json::json!({"kind":"user"})
        );
        assert_eq!(o.to_string(), "agent:codex:S15");
    }
}
