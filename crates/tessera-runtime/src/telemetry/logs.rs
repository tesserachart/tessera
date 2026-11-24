use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

#[derive(Clone, Debug, PartialEq)]
pub struct LogRecord {
    pub at_ns: u128,
    pub level: Level,
    pub target: String,
    pub body: String,
    pub fields: Vec<(String, String)>,
}

const NEVER: &[&str] = &[
    "tessera_runtime::telemetry",
    "posthog_rs",
    "reqwest",
    "hyper",
    "h2",
    "rustls",
    "tungstenite",
    "tokio_tungstenite",
];

const MOST_A_MINUTE: u64 = 600;

const QUEUE: usize = 2_000;

pub const BATCH: usize = 200;

pub const EVERY: Duration = Duration::from_secs(5);

pub fn shipped(target: &str, level: Level) -> bool {
    if NEVER.iter().any(|t| target.starts_with(t)) {
        return false;
    }
    if target.starts_with("tessera") {
        level <= Level::INFO
    } else {
        level <= Level::WARN
    }
}

static OUTLET: RwLock<Option<mpsc::Sender<LogRecord>>> = RwLock::new(None);

static ON: AtomicBool = AtomicBool::new(false);

static BUDGET: Mutex<(u64, u64)> = Mutex::new((0, 0));

static DROPPED: AtomicU64 = AtomicU64::new(0);

pub fn listen() -> mpsc::Receiver<LogRecord> {
    let (tx, rx) = mpsc::channel(QUEUE);
    *OUTLET.write() = Some(tx);
    rx
}

pub fn set_on(on: bool) {
    ON.store(on, Ordering::Relaxed);
}

pub fn dropped() -> u64 {
    DROPPED.swap(0, Ordering::Relaxed)
}

fn within_budget(now_s: u64) -> bool {
    let mut b = BUDGET.lock();
    if b.0 != now_s / 60 {
        *b = (now_s / 60, 0);
    }
    b.1 += 1;
    b.1 <= MOST_A_MINUTE
}

pub struct ShipLayer;

impl<S: Subscriber> Layer<S> for ShipLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if !ON.load(Ordering::Relaxed) {
            return;
        }
        let meta = event.metadata();
        if !shipped(meta.target(), *meta.level()) {
            return;
        }
        let Some(tx) = OUTLET.read().clone() else {
            return;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        if !within_budget(now.as_secs()) {
            DROPPED.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let mut v = Fields::default();
        event.record(&mut v);
        let record = LogRecord {
            at_ns: now.as_nanos(),
            level: *meta.level(),
            target: meta.target().to_owned(),
            body: v.message,
            fields: v.fields,
        };
        if tx.try_send(record).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[derive(Default)]
struct Fields {
    message: String,
    fields: Vec<(String, String)>,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_owned();
        } else {
            self.fields
                .push((field.name().to_owned(), value.to_owned()));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let mut text = String::new();
        let _ = write!(text, "{value:?}");
        if field.name() == "message" {
            self.message = text;
        } else {
            self.fields.push((field.name().to_owned(), text));
        }
    }
}

pub struct Who<'a> {
    pub distinct_id: &'a str,
    pub session_id: Option<&'a str>,
    pub build: &'a str,
}

fn text(v: &str) -> Value {
    json!({ "stringValue": v })
}

fn attr(key: &str, v: &str) -> Value {
    json!({ "key": key, "value": text(v) })
}

fn severity(level: Level) -> (u8, &'static str) {
    match level {
        Level::ERROR => (17, "ERROR"),
        Level::WARN => (13, "WARN"),
        Level::INFO => (9, "INFO"),
        Level::DEBUG => (5, "DEBUG"),
        Level::TRACE => (1, "TRACE"),
    }
}

pub fn otlp(records: &[LogRecord], who: &Who<'_>, clean: impl Fn(&str) -> String) -> Value {
    let resource = [
        attr("service.name", "tessera-runtime"),
        attr("service.version", crate::VERSION),
        attr("os.type", std::env::consts::OS),
        attr("deployment.environment", who.build),
    ];
    let logs: Vec<Value> = records
        .iter()
        .map(|r| {
            let (number, name) = severity(r.level);
            let mut attributes = vec![
                attr("posthogDistinctId", who.distinct_id),
                attr("target", &r.target),
            ];
            if let Some(sid) = who.session_id {
                attributes.push(attr("sessionId", sid));
            }
            attributes.extend(r.fields.iter().map(|(k, v)| attr(k, &clean(v))));
            json!({
                "timeUnixNano": r.at_ns.to_string(),
                "severityNumber": number,
                "severityText": name,
                "body": text(&clean(&r.body)),
                "attributes": attributes,
            })
        })
        .collect();
    json!({
        "resourceLogs": [{
            "resource": { "attributes": resource },
            "scopeLogs": [{ "scope": { "name": "tessera" }, "logRecords": logs }],
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn tessera_ships_from_info_others_from_warn_and_transport_never() {
        assert!(shipped("tessera_rithmic::session", Level::INFO));
        assert!(!shipped("tessera_rithmic::session", Level::DEBUG));
        assert!(shipped("tower_http", Level::WARN));
        assert!(!shipped("tower_http", Level::INFO));
        assert!(!shipped("reqwest::connect", Level::ERROR));
        assert!(!shipped("tessera_runtime::telemetry::logs", Level::ERROR));
    }

    #[test]
    fn a_record_becomes_otlp_with_who_sent_it_and_nothing_private() {
        let mut rx = listen();
        set_on(true);
        let subscriber = tracing_subscriber::registry().with(ShipLayer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "tessera_rithmic::session", plant = "ticker", account = "APEX-4410",
                "rithmic forced logout; stopping until the user reconnects");
            tracing::debug!(target: "tessera_rithmic::session", "too chatty");
        });
        set_on(false);
        *OUTLET.write() = None;
        let record = rx.try_recv().unwrap();
        assert!(rx.try_recv().is_err(), "debug never ships");
        assert_eq!(
            record.body,
            "rithmic forced logout; stopping until the user reconnects"
        );
        let who = Who {
            distinct_id: "usr_1",
            session_id: Some("0192-ab"),
            build: "dev",
        };
        let body = otlp(&[record], &who, |s| s.replace("APEX-4410", "[private]"));
        let text = body.to_string();
        assert!(!text.contains("APEX-4410"), "{text}");
        let rec = &body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];
        assert_eq!(rec["severityText"], "INFO");
        let attrs = rec["attributes"].as_array().unwrap();
        let get = |k: &str| {
            attrs
                .iter()
                .find(|a| a["key"] == k)
                .map(|a| a["value"]["stringValue"].clone())
        };
        assert_eq!(get("posthogDistinctId"), Some(json!("usr_1")));
        assert_eq!(get("sessionId"), Some(json!("0192-ab")));
        assert_eq!(get("plant"), Some(json!("ticker")));
        assert_eq!(get("account"), Some(json!("[private]")));
    }
}
