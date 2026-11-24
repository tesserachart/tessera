use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::{Map, Value, json};

pub const CONSENT: &str = "telemetry.consent";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Crashes,
    Usage,
}

impl Purpose {
    pub fn of(event: &str) -> Self {
        if event == "$exception" {
            Purpose::Crashes
        } else {
            Purpose::Usage
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Consent {
    pub crashes: bool,
    pub usage: Option<bool>,
}

impl Consent {
    pub const FRESH: Consent = Consent {
        crashes: true,
        usage: None,
    };

    pub fn of(value: Option<&Value>) -> Self {
        let field = |k: &str| value.and_then(|v| v.get(k));
        Consent {
            crashes: field("crashes")
                .and_then(Value::as_bool)
                .unwrap_or(Self::FRESH.crashes),
            usage: field("usage").and_then(Value::as_bool),
        }
    }

    pub fn allows(self, purpose: Purpose) -> bool {
        match purpose {
            Purpose::Crashes => self.crashes,
            Purpose::Usage => self.usage == Some(true),
        }
    }

    pub fn any(self) -> bool {
        self.allows(Purpose::Crashes) || self.allows(Purpose::Usage)
    }

    pub fn value(self) -> Value {
        json!({"crashes": self.crashes, "usage": self.usage})
    }

    pub fn fresh_value() -> Value {
        Self::FRESH.value()
    }

    pub fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "crashes": {"type": "boolean"},
                "usage": {"type": ["boolean", "null"]},
            },
            "required": ["crashes", "usage"],
            "additionalProperties": false,
        })
    }

    pub fn merged(current: Option<Value>, change: Value) -> Value {
        let Value::Object(change) = change else {
            return change;
        };
        let mut now: Map<String, Value> = match current {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        now.extend(change);
        Value::Object(now)
    }
}

const CRASHES: u8 = 1;
const USAGE: u8 = 2;

#[derive(Debug, Default)]
pub struct Gate(AtomicU8);

impl Gate {
    pub fn set(&self, consent: Consent) -> Consent {
        Self::read(self.0.swap(Self::bits(consent), Ordering::SeqCst))
    }

    pub fn get(&self) -> Consent {
        Self::read(self.0.load(Ordering::SeqCst))
    }

    pub fn allows(&self, purpose: Purpose) -> bool {
        self.get().allows(purpose)
    }

    fn bits(c: Consent) -> u8 {
        u8::from(c.crashes) * CRASHES + u8::from(c.allows(Purpose::Usage)) * USAGE
    }

    fn read(bits: u8) -> Consent {
        Consent {
            crashes: bits & CRASHES != 0,
            usage: Some(bits & USAGE != 0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_install_sends_crash_reports_and_asks_before_usage() {
        let fresh = Consent::of(None);
        assert_eq!(fresh, Consent::FRESH);
        assert!(fresh.allows(Purpose::Crashes));
        assert!(!fresh.allows(Purpose::Usage));
        assert_eq!(Consent::of(Some(&Consent::fresh_value())), Consent::FRESH);
    }

    #[test]
    fn only_an_exception_is_a_crash_report() {
        assert_eq!(Purpose::of("$exception"), Purpose::Crashes);
        for usage in [
            "area opened",
            "$ai_trace",
            "$snapshot",
            "$identify",
            "order placed",
        ] {
            assert_eq!(Purpose::of(usage), Purpose::Usage, "{usage}");
        }
    }

    #[test]
    fn a_change_merges_into_what_is_there_and_keeps_an_unanswered_question() {
        let fresh = Some(Consent::fresh_value());
        assert_eq!(
            Consent::merged(fresh.clone(), json!({"usage": true})),
            json!({"crashes": true, "usage": true})
        );
        assert_eq!(
            Consent::merged(fresh, json!({"crashes": false})),
            json!({"crashes": false, "usage": null})
        );
        let schema = Consent::schema();
        assert!(
            crate::settings::validate(&schema, &json!({"crashes": true, "usage": null})).is_ok()
        );
        assert!(
            crate::settings::validate(&schema, &json!({"crashes": null, "usage": true})).is_err()
        );
        assert!(
            crate::settings::validate(
                &schema,
                &json!({"crashes": true, "usage": true, "replay": true})
            )
            .is_err()
        );
    }

    #[test]
    fn the_gate_keeps_each_purpose() {
        let gate = Gate::default();
        assert!(!gate.get().any());
        gate.set(Consent::FRESH);
        assert!(gate.allows(Purpose::Crashes));
        assert!(!gate.allows(Purpose::Usage));
        let before = gate.set(Consent {
            crashes: false,
            usage: Some(true),
        });
        assert!(before.crashes);
        assert!(!gate.allows(Purpose::Crashes));
        assert!(gate.allows(Purpose::Usage));
    }
}
