use std::collections::HashMap;
use std::sync::Mutex;

use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_core::token::{self, Secret};

#[derive(Default)]
pub struct McpPrincipals {
    tokens: Mutex<HashMap<String, Origin>>,
}

impl std::fmt::Debug for McpPrincipals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpPrincipals")
            .field("live", &self.lock().len())
            .finish()
    }
}

impl McpPrincipals {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(&self, origin: Origin) -> Secret {
        let token = token::mint(token::AGENT).expect("the OS random source");
        self.lock().insert(token.expose().to_owned(), origin);
        token
    }

    pub fn resolve(&self, token: &str) -> Option<Origin> {
        self.lock().get(token).cloned()
    }

    pub fn revoke_session(&self, session: &SessionId) {
        self.lock().retain(|_, o| o.session_id() != Some(session));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Origin>> {
        self.tokens.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_token_acts_as_its_session_until_revoked() {
        let p = McpPrincipals::new();
        let sid = SessionId::generate();
        let origin = Origin::Agent {
            session_id: sid.clone(),
            provider: "codex".into(),
        };
        let t = p.issue(origin.clone());
        assert!(t.expose().starts_with("tsk_") && t.expose().len() == 68);
        assert_eq!(p.resolve(t.expose()), Some(origin));
        assert_eq!(p.resolve("tsk_nope"), None);
        assert!(!format!("{p:?}").contains(&t.expose()[4..]));
        p.revoke_session(&sid);
        assert_eq!(p.resolve(t.expose()), None);
    }
}
