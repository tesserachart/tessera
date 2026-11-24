use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "Tessera";

pub const CREDENTIALS_FILE_ENV: &str = "TESSERA_CREDENTIALS_FILE";

#[derive(Clone, PartialEq, Eq)]
pub struct RithmicLogin {
    pub user: String,
    pub password: String,
    pub system_name: String,
    pub gateway_url: String,
}

impl fmt::Debug for RithmicLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RithmicLogin")
            .field("user", &self.user)
            .field("password", &"[redacted]")
            .field("system_name", &self.system_name)
            .field("gateway_url", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialsError {
    #[error("cannot read the credentials file {path}: {reason}")]
    Unreadable { path: String, reason: String },
    #[error("the credentials file has no {0}")]
    Missing(&'static str),
    #[error("RITHMIC_GATEWAY must be a wss:// URL")]
    BadGateway,
}

pub fn gateway_is_safe(url: &str) -> bool {
    url.starts_with("wss://")
        || (url.starts_with("ws://")
            && matches!(gateway_host(url), Some("localhost" | "127.0.0.1" | "::1")))
}

pub fn gateway_host(url: &str) -> Option<&str> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.rsplit_once(':').map_or(authority, |(h, _)| h),
    };
    (!host.is_empty()).then_some(host)
}

pub fn redact_gateway(gateway: &str, text: &str) -> String {
    let mut out = text.to_owned();
    if !gateway.is_empty() {
        out = out.replace(gateway, "[gateway]");
    }
    if let Some(host) = gateway_host(gateway) {
        out = out.replace(host, "[gateway]");
    }
    out
}

impl RithmicLogin {
    pub fn from_pairs(pairs: &HashMap<String, String>) -> Result<Self, CredentialsError> {
        let get = |k: &'static str| {
            pairs
                .get(k)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .ok_or(CredentialsError::Missing(k))
        };
        let login = Self {
            user: get("RITHMIC_USERNAME")?,
            password: get("RITHMIC_PASSWORD")?,
            system_name: get("RITHMIC_SYSTEM")?,
            gateway_url: get("RITHMIC_GATEWAY")?,
        };
        if !gateway_is_safe(&login.gateway_url) {
            return Err(CredentialsError::BadGateway);
        }
        Ok(login)
    }

    pub fn from_file(path: &Path) -> Result<Self, CredentialsError> {
        let text = std::fs::read_to_string(path).map_err(|e| CredentialsError::Unreadable {
            path: path.display().to_string(),
            reason: e.kind().to_string(),
        })?;
        Self::from_pairs(&parse_env_file(&text))
    }

    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        if !self.password.is_empty() {
            out = out.replace(&self.password, "[redacted]");
        }
        redact_gateway(&self.gateway_url, &out)
    }

    pub fn from_default_file() -> Result<Self, CredentialsError> {
        Self::from_file(&default_credentials_path())
    }
}

pub fn default_credentials_path() -> PathBuf {
    if let Some(p) = std::env::var_os(CREDENTIALS_FILE_ENV) {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".config/tessera/credentials.env")
}

pub fn parse_env_file(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let unquoted = [('\'', '\''), ('"', '"')]
            .iter()
            .find_map(|&(open, close)| value.strip_prefix(open).and_then(|v| v.strip_suffix(close)))
            .unwrap_or(value);
        out.insert(key.trim().to_owned(), unquoted.to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# a comment\n\
        RITHMIC_USERNAME='someone'\n\
        export RITHMIC_PASSWORD='p@ss=word'\n\n\
        RITHMIC_SYSTEM=\"Rithmic Test\"\n\
        RITHMIC_GATEWAY='wss://gateway.invalid:443'\n";

    #[test]
    fn parses_quoted_shell_values() {
        let pairs = parse_env_file(SAMPLE);
        assert_eq!(pairs["RITHMIC_PASSWORD"], "p@ss=word");
        let login = RithmicLogin::from_pairs(&pairs).unwrap();
        assert_eq!(login.user, "someone");
        assert_eq!(login.system_name, "Rithmic Test");
    }

    #[test]
    fn debug_redacts_secrets() {
        let login = RithmicLogin::from_pairs(&parse_env_file(SAMPLE)).unwrap();
        let shown = format!("{login:?}");
        assert!(!shown.contains("p@ss"));
        assert!(!shown.contains("gateway.invalid"));
        assert!(shown.contains("someone"));
    }

    #[test]
    fn redacts_gateway_and_password_from_messages() {
        let login = RithmicLogin::from_pairs(&parse_env_file(SAMPLE)).unwrap();
        let msg = "failed wss://gateway.invalid:443 (gateway.invalid) with p@ss=word";
        assert_eq!(
            login.redact(msg),
            "failed [gateway] ([gateway]) with [redacted]"
        );
    }

    #[test]
    fn missing_and_bad_values_are_named() {
        let mut pairs = parse_env_file(SAMPLE);
        pairs.insert("RITHMIC_GATEWAY".into(), "https://x".into());
        assert_eq!(
            RithmicLogin::from_pairs(&pairs),
            Err(CredentialsError::BadGateway)
        );
        for bad in [
            "ws://gateway.invalid:443",
            "ws://127.0.0.1.evil.example",
            "ws://",
        ] {
            pairs.insert("RITHMIC_GATEWAY".into(), bad.into());
            assert_eq!(
                RithmicLogin::from_pairs(&pairs),
                Err(CredentialsError::BadGateway),
                "{bad}"
            );
        }
        for local in [
            "ws://127.0.0.1:9000/x",
            "ws://localhost:9000",
            "ws://[::1]:9000",
        ] {
            assert!(gateway_is_safe(local), "{local}");
        }
        assert_eq!(
            gateway_host("wss://gateway.invalid:443/x"),
            Some("gateway.invalid")
        );
        assert_eq!(gateway_host("ws://[::1]:9000"), Some("::1"));
        assert_eq!(gateway_host("Chicago Area"), None);
        pairs.remove("RITHMIC_SYSTEM");
        assert_eq!(
            RithmicLogin::from_pairs(&pairs),
            Err(CredentialsError::Missing("RITHMIC_SYSTEM"))
        );
    }
}
