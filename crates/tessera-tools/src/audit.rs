use parking_lot::Mutex;
use serde_json::Value;
use tessera_protocol::tools::{ApprovalEvent, DraftInfo, ToolCallRecord};

pub const REDACTED: &str = "[redacted]";

const SECRET_KEY_FRAGMENTS: [&str; 9] = [
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "credential",
    "authorization",
    "privatekey",
];

fn is_secret_key(key: &str, extra: &[String]) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    SECRET_KEY_FRAGMENTS.iter().any(|f| k.contains(f)) || extra.iter().any(|e| e == key)
}

pub fn redact(value: &Value, extra: &[String]) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let v = if is_secret_key(k, extra) {
                        Value::String(REDACTED.to_owned())
                    } else {
                        redact(v, extra)
                    };
                    (k.clone(), v)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|v| redact(v, extra)).collect()),
        other => other.clone(),
    }
}

pub trait ToolObserver: Send + Sync {
    fn call_started(&self, _record: &ToolCallRecord) {}
    fn call_finished(&self, _record: &ToolCallRecord) {}
    fn call_finished_quietly(&self, _record: &ToolCallRecord) {}
    fn approval(&self, _event: &ApprovalEvent) {}
    fn draft(&self, _draft: &DraftInfo) {}
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NullObserver;

impl ToolObserver for NullObserver {}

#[derive(Debug, Default)]
pub struct MemoryObserver {
    pub started: Mutex<Vec<ToolCallRecord>>,
    pub finished: Mutex<Vec<ToolCallRecord>>,
    pub quietly: Mutex<Vec<ToolCallRecord>>,
    pub approvals: Mutex<Vec<ApprovalEvent>>,
    pub drafts: Mutex<Vec<DraftInfo>>,
}

impl ToolObserver for MemoryObserver {
    fn call_started(&self, record: &ToolCallRecord) {
        self.started.lock().push(record.clone());
    }

    fn call_finished(&self, record: &ToolCallRecord) {
        self.finished.lock().push(record.clone());
    }

    fn call_finished_quietly(&self, record: &ToolCallRecord) {
        self.quietly.lock().push(record.clone());
    }

    fn approval(&self, event: &ApprovalEvent) {
        self.approvals.lock().push(event.clone());
    }

    fn draft(&self, draft: &DraftInfo) {
        self.drafts.lock().push(draft.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_nested_secrets() {
        let v = json!({
            "user": "nico",
            "password": "hunter2",
            "nested": {"apiKey": "k", "X-Api-Key": "k2", "list": [{"refresh_token": "t"}]},
            "accountNumber": "123456"
        });
        let r = redact(&v, &["accountNumber".to_owned()]);
        assert_eq!(r["user"], "nico");
        assert_eq!(r["password"], REDACTED);
        assert_eq!(r["nested"]["apiKey"], REDACTED);
        assert_eq!(r["nested"]["X-Api-Key"], REDACTED);
        assert_eq!(r["nested"]["list"][0]["refresh_token"], REDACTED);
        assert_eq!(r["accountNumber"], REDACTED);
        assert!(!r.to_string().contains("hunter2"));
    }
}
