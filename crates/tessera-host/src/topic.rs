use std::any::Any;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::value::RawValue;
use tessera_core::{InstrumentId, Timeframe};
use tessera_protocol::rpc::{RpcError, codes};

use crate::bus::{TopicKey, TopicSizing};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyFilter {
    All,
    Instruments(HashSet<InstrumentId>),
    Bars(InstrumentId, Timeframe),
    Depth(InstrumentId, u32),
    Calls {
        origin: Option<String>,
        session: Option<String>,
    },
    Layout(String),
    Account(Option<String>),
    Id(String),
}

impl KeyFilter {
    pub fn matches(&self, key: &TopicKey) -> bool {
        match (self, key) {
            (KeyFilter::All, _) => true,
            (KeyFilter::Instruments(set), TopicKey::Instrument(i)) => set.contains(i),
            (KeyFilter::Bars(i, tf), TopicKey::Bars(ki, ktf)) => i == ki && tf == ktf,
            (KeyFilter::Depth(i, n), TopicKey::Depth(ki, kn)) => i == ki && n == kn,
            (
                KeyFilter::Calls { origin, session },
                TopicKey::Call {
                    origin: o,
                    session: s,
                },
            ) => {
                origin.as_deref().is_none_or(|x| x == *o)
                    && session.as_deref().is_none_or(|x| s.as_deref() == Some(x))
            }
            (KeyFilter::Layout(id), TopicKey::Layout(k)) => id == k,
            (KeyFilter::Account(None), TopicKey::Account(_)) => true,
            (KeyFilter::Account(Some(a)), TopicKey::Account(k)) => a == k,
            (KeyFilter::Id(id), TopicKey::Id(k)) => id == k,
            _ => false,
        }
    }
}

pub type Keepalive = Box<dyn Any + Send + Sync>;

pub type Resync = Arc<dyn Fn() -> Option<Box<RawValue>> + Send + Sync>;

pub struct Subscribed {
    pub filter: KeyFilter,
    pub snapshot: Vec<Box<RawValue>>,
    pub resync: Option<Resync>,
    pub keepalive: Vec<Keepalive>,
}

impl std::fmt::Debug for Subscribed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscribed")
            .field("filter", &self.filter)
            .field("snapshot", &self.snapshot.len())
            .field("resync", &self.resync.is_some())
            .field("keepalive", &self.keepalive.len())
            .finish()
    }
}

impl Subscribed {
    pub fn new(filter: KeyFilter) -> Self {
        Self {
            filter,
            snapshot: Vec::new(),
            resync: None,
            keepalive: Vec::new(),
        }
    }

    pub fn snapshot<T: Serialize + ?Sized>(mut self, data: &T) -> Self {
        match serde_json::value::to_raw_value(data) {
            Ok(raw) => self.snapshot.push(raw),
            Err(e) => tracing::error!(error = %e, "snapshot serialization failed"),
        }
        self
    }

    pub fn resync<T: Serialize>(
        mut self,
        now: impl Fn() -> Option<T> + Send + Sync + 'static,
    ) -> Self {
        self.resync = Some(Arc::new(move || {
            let data = now()?;
            serde_json::value::to_raw_value(&data)
                .map_err(|e| tracing::error!(error = %e, "resync serialization failed"))
                .ok()
        }));
        self
    }

    pub fn keep(mut self, guard: impl Any + Send + Sync) -> Self {
        self.keepalive.push(Box::new(guard));
        self
    }
}

#[async_trait]
pub trait TopicHandler: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    fn sizing(&self) -> TopicSizing {
        TopicSizing::default()
    }

    fn offered(&self) -> bool {
        true
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError>;
}

pub fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let v = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params
    };
    serde_json::from_value(v)
        .map_err(|e| RpcError::new(codes::INVALID_PARAMS, format!("invalid params: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters() {
        let qqq = InstrumentId::new("QQQ").unwrap();
        let f = KeyFilter::Instruments([qqq.clone()].into_iter().collect());
        assert!(f.matches(&TopicKey::Instrument(qqq.clone())));
        assert!(!f.matches(&TopicKey::Instrument(InstrumentId::new("SPY").unwrap())));
        let b = KeyFilter::Bars(qqq.clone(), Timeframe::M5);
        assert!(b.matches(&TopicKey::Bars(qqq.clone(), Timeframe::M5)));
        assert!(!b.matches(&TopicKey::Bars(qqq.clone(), Timeframe::M1)));
        let d = KeyFilter::Depth(qqq.clone(), 10);
        assert!(d.matches(&TopicKey::Depth(qqq.clone(), 10)));
        assert!(!d.matches(&TopicKey::Depth(qqq, 20)));
        let c = KeyFilter::Calls {
            origin: Some("agent".into()),
            session: None,
        };
        assert!(c.matches(&TopicKey::Call {
            origin: "agent",
            session: Some("S1".into())
        }));
        assert!(!c.matches(&TopicKey::Call {
            origin: "user",
            session: None
        }));
        assert!(KeyFilter::Account(None).matches(&TopicKey::Account("x".into())));
        assert!(!KeyFilter::Account(Some("y".into())).matches(&TopicKey::Account("x".into())));
        assert!(KeyFilter::Id("r1".into()).matches(&TopicKey::Id("r1".into())));
    }

    #[test]
    fn params() {
        #[derive(serde::Deserialize, Debug)]
        struct P {
            #[serde(default)]
            n: u32,
        }
        assert_eq!(parse_params::<P>(Value::Null).unwrap().n, 0);
        let e = parse_params::<P>(serde_json::json!({"n": "x"})).unwrap_err();
        assert_eq!(e.code, codes::INVALID_PARAMS);
        let s = Subscribed::new(KeyFilter::All)
            .snapshot(&serde_json::json!({"a": 1}))
            .keep(42_u8);
        assert_eq!(s.snapshot.len(), 1);
        assert_eq!(s.keepalive.len(), 1);
    }
}
