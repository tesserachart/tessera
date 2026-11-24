use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::OnceLock;

use parking_lot::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

const KEPT: usize = 100;

const MAX_LINE: usize = 400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentError {
    pub at: chrono::DateTime<chrono::Utc>,
    pub level: &'static str,
    pub target: String,
    pub message: String,
}

impl RecentError {
    pub fn line(&self) -> String {
        format!(
            "{} {} {}: {}",
            self.at.format("%Y-%m-%d %H:%M:%S%.3fZ"),
            self.level,
            self.target,
            self.message
        )
    }
}

fn buffer() -> &'static Mutex<VecDeque<RecentError>> {
    static B: OnceLock<Mutex<VecDeque<RecentError>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(VecDeque::with_capacity(KEPT)))
}

pub fn recent(limit: usize) -> Vec<RecentError> {
    let b = buffer().lock();
    b.iter().rev().take(limit).rev().cloned().collect()
}

pub fn note(error: RecentError) {
    let mut b = buffer().lock();
    if b.len() == KEPT {
        b.pop_front();
    }
    b.push_back(error);
}

pub struct RecentErrors;

fn kept(level: Level, target: &str) -> bool {
    level == Level::ERROR || (level == Level::WARN && target.starts_with("tessera"))
}

#[derive(Default)]
struct Words {
    message: String,
    fields: String,
}

impl Visit for Words {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.fields, " {}={value}", field.name());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for RecentErrors {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if !kept(*meta.level(), meta.target()) {
            return;
        }
        let mut words = Words::default();
        event.record(&mut words);
        let mut message = words.message;
        message.push_str(&words.fields);
        let message: String = message.chars().take(MAX_LINE).collect();
        note(RecentError {
            at: chrono::Utc::now(),
            level: if *meta.level() == Level::ERROR {
                "ERROR"
            } else {
                "WARN"
            },
            target: meta.target().to_owned(),
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    #[test]
    fn warnings_from_tessera_and_every_error_are_kept_newest_last() {
        let subscriber = tracing_subscriber::registry().with(RecentErrors);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "tessera_runtime", "fine");
            tracing::warn!(target: "hyper", "noise");
            tracing::warn!(target: "tessera_broker", order = 7, "refused by the broker");
            tracing::error!(target: "h2", "connection reset");
        });
        let got: Vec<String> = recent(10)
            .into_iter()
            .filter(|e| e.target == "tessera_broker" || e.target == "h2")
            .map(|e| format!("{} {}", e.level, e.message))
            .collect();
        assert_eq!(
            got,
            [
                "WARN refused by the broker order=7",
                "ERROR connection reset"
            ]
        );
    }
}
