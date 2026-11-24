use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use tessera_core::hash::sha256_hex;
use tessera_core::token::{self, constant_time_eq};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientToken {
    pub client_id: String,
    pub label: String,
    pub token_hash: String,
    pub created_at: Timestamp,
    pub revoked: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct IssuedToken {
    pub client: ClientToken,
    pub token: String,
}

impl std::fmt::Debug for IssuedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedToken")
            .field("client", &self.client)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("random source unavailable: {0}")]
    Random(String),
    #[error("client {0} already exists")]
    Duplicate(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TokenBook {
    clients: Vec<ClientToken>,
}

pub fn mint() -> Result<String, TokenError> {
    token::mint(token::AGENT)
        .map(|t| t.expose().to_owned())
        .map_err(|e| TokenError::Random(e.to_string()))
}

pub fn hash(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

impl TokenBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(
        &mut self,
        client_id: &str,
        label: &str,
        now: Timestamp,
    ) -> Result<IssuedToken, TokenError> {
        if self.clients.iter().any(|c| c.client_id == client_id) {
            return Err(TokenError::Duplicate(client_id.to_owned()));
        }
        let token = mint()?;
        let client = ClientToken {
            client_id: client_id.to_owned(),
            label: label.to_owned(),
            token_hash: hash(&token),
            created_at: now,
            revoked: false,
        };
        self.clients.push(client.clone());
        Ok(IssuedToken { client, token })
    }

    pub fn verify(&self, token: &str) -> Option<&str> {
        let h = hash(token);
        self.clients
            .iter()
            .find(|c| !c.revoked && constant_time_eq(c.token_hash.as_bytes(), h.as_bytes()))
            .map(|c| c.client_id.as_str())
    }

    pub fn revoke(&mut self, client_id: &str) -> bool {
        let mut hit = false;
        for c in self.clients.iter_mut().filter(|c| c.client_id == client_id) {
            hit |= !c.revoked;
            c.revoked = true;
        }
        hit
    }

    pub fn clients(&self) -> &[ClientToken] {
        &self.clients
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_verify_revoke() {
        let mut b = TokenBook::new();
        let t = b
            .issue("claude-desktop", "Claude Desktop", Timestamp(0))
            .unwrap();
        assert!(t.token.starts_with("tsk_") && t.token.len() == 68);
        assert!(
            !format!("{t:?}").contains(&t.token[4..]),
            "debug output never shows the token"
        );
        assert!(!serde_json::to_string(&b).unwrap().contains(&t.token[4..]));
        assert_eq!(b.verify(&t.token), Some("claude-desktop"));
        assert_eq!(b.verify("tsk_wrong"), None);
        assert!(matches!(
            b.issue("claude-desktop", "x", Timestamp(1)),
            Err(TokenError::Duplicate(_))
        ));
        let other = b.issue("cursor", "Cursor", Timestamp(1)).unwrap();
        assert_ne!(other.token, t.token);
        assert!(b.revoke("claude-desktop"));
        assert_eq!(b.verify(&t.token), None);
        assert_eq!(b.verify(&other.token), Some("cursor"));
    }
}
