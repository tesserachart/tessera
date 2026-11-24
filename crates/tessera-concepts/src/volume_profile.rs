use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::NaiveDate;
use tessera_core::clock::Clock;
use tessera_core::levels::{Level, VendorRef};
use tessera_core::session::TradingSession;
use tessera_core::{InstrumentId, Price, Timestamp};
use tessera_market::MarketError;
use tessera_market::hub::MarketHub;
use tessera_market::io::ProfilePeriod;
use tessera_market::orderflow::periods::recent_periods;
use tessera_market::orderflow::profile::{DEFAULT_VALUE_AREA, ProfileBuilder};

use crate::prior_day::{CONCEPTS_PACKAGE, TESSERA_VENDOR};

pub const VOLUME_PROFILE_GROUP: &str = "vp";
pub const COMPOSITE_SESSIONS: usize = 5;
pub const PRINT_ARRIVAL_LAG: Duration = Duration::from_secs(2);
const MAX_DEVELOPING: usize = 32;
const MAX_CLOSED: usize = 256;

#[derive(Clone, Debug)]
struct Measured {
    builder: ProfileBuilder,
    partial: bool,
}

#[derive(Clone, Debug)]
struct Developing {
    date: NaiveDate,
    read_to: Timestamp,
    measured: Measured,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValueLevels {
    pub poc: Price,
    pub vah: Price,
    pub val: Price,
}

pub fn value_levels(builder: &ProfileBuilder) -> Option<ValueLevels> {
    let p = builder.finish(1, DEFAULT_VALUE_AREA);
    let va = p.value_area?;
    Some(ValueLevels {
        poc: p.poc?,
        vah: va.high,
        val: va.low,
    })
}

#[derive(Debug)]
pub struct VolumeProfileLevels {
    hub: Arc<MarketHub>,
    clock: Arc<dyn Clock>,
    closed: Mutex<HashMap<(String, InstrumentId, NaiveDate), Arc<Measured>>>,
    developing: tokio::sync::Mutex<HashMap<(String, InstrumentId), Developing>>,
}

impl VolumeProfileLevels {
    pub fn new(hub: Arc<MarketHub>, clock: Arc<dyn Clock>) -> Self {
        Self {
            hub,
            clock,
            closed: Mutex::new(HashMap::new()),
            developing: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn measure(
        &self,
        id: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
        into: &mut Measured,
    ) -> Result<(), MarketError> {
        if to <= from {
            return Ok(());
        }
        let b = &mut into.builder;
        let read = self
            .hub
            .each_print(id, from, to, |t| b.push_trade(t))
            .await?;
        into.partial |= !read.gaps.is_empty();
        Ok(())
    }

    async fn whole(
        &self,
        provider: &str,
        id: &InstrumentId,
        tick: Price,
        s: &TradingSession,
    ) -> Result<Arc<Measured>, MarketError> {
        let key = (provider.to_owned(), id.clone(), s.trade_date);
        if let Some(m) = self.closed.lock().expect("profiles").get(&key) {
            return Ok(Arc::clone(m));
        }
        let mut m = Measured {
            builder: ProfileBuilder::new(tick),
            partial: false,
        };
        self.measure(id, s.open, s.close, &mut m).await?;
        let m = Arc::new(m);
        let mut closed = self.closed.lock().expect("profiles");
        if closed.len() >= MAX_CLOSED {
            closed.clear();
        }
        closed.insert(key, Arc::clone(&m));
        Ok(m)
    }

    async fn developing(
        &self,
        provider: &str,
        id: &InstrumentId,
        tick: Price,
        s: &TradingSession,
        now: Timestamp,
    ) -> Result<Measured, MarketError> {
        let key = (provider.to_owned(), id.clone());
        let mut all = self.developing.lock().await;
        let fresh = || Developing {
            date: s.trade_date,
            read_to: s.open,
            measured: Measured {
                builder: ProfileBuilder::new(tick),
                partial: false,
            },
        };
        let mut d = match all.remove(&key) {
            Some(d) if d.date == s.trade_date => d,
            _ => fresh(),
        };
        let cut = Timestamp(now.0 - PRINT_ARRIVAL_LAG.as_nanos() as i64).min(s.close);
        if cut > d.read_to {
            let mut m = d.measured.clone();
            self.measure(id, d.read_to, cut, &mut m).await?;
            d.measured = m;
            d.read_to = cut;
        }
        let out = d.measured.clone();
        if all.len() >= MAX_DEVELOPING {
            all.clear();
        }
        all.insert(key, d);
        Ok(out)
    }

    pub async fn levels(&self, id: &InstrumentId) -> Result<(Timestamp, Vec<Level>), MarketError> {
        let router = self.hub.router();
        let provider = router.route_async(id).await?;
        let (_, spec) = provider.spec(id).await?;
        let now = self.clock.now();
        let sessions = spec.sessions.last_sessions(now, COMPOSITE_SESSIONS);
        let Some((current, older)) = sessions.split_last() else {
            return Ok((now, Vec::new()));
        };
        let current_whole = current.close <= now;
        let today = if current_whole {
            Arc::unwrap_or_clone(
                self.whole(provider.id(), id, spec.tick_size, current)
                    .await?,
            )
        } else {
            self.developing(provider.id(), id, spec.tick_size, current, now)
                .await?
        };
        let mut olders = Vec::with_capacity(older.len());
        for s in older {
            olders.push(self.whole(provider.id(), id, spec.tick_size, s).await?);
        }
        let as_of = if current_whole {
            current.close
        } else {
            Timestamp(now.0 - PRINT_ARRIVAL_LAG.as_nanos() as i64).max(current.open)
        };
        let mut out = Vec::new();
        let mut put = |m: &Measured, which: Which, at: Timestamp| {
            if let Some(v) = value_levels(&m.builder) {
                out.extend(which.levels(id, v, at, m.partial));
            }
        };
        put(&today, Which::Session, as_of);
        if let (Some(prior), Some(s)) = (olders.last(), older.last()) {
            put(prior, Which::Prior, s.close);
        }
        let mut composite = today.clone();
        for m in &olders {
            composite.builder.merge(&m.builder);
            composite.partial |= m.partial;
        }
        if !olders.is_empty() {
            put(&composite, Which::Composite, as_of);
        }
        Ok((as_of, out))
    }

    pub async fn period_levels(
        &self,
        id: &InstrumentId,
    ) -> Result<(Timestamp, Vec<Level>), MarketError> {
        let router = self.hub.router();
        let provider = router.route_async(id).await?;
        let (_, spec) = provider.spec(id).await?;
        let now = self.clock.now();
        let calendar = spec.sessions;
        let as_of = Timestamp(now.0 - PRINT_ARRIVAL_LAG.as_nanos() as i64);
        let mut out = Vec::new();
        for period in [ProfilePeriod::Week, ProfilePeriod::Month] {
            let spans = recent_periods(calendar, period, now, 2, false);
            let newest = spans.len().saturating_sub(1);
            for (k, span) in spans.iter().enumerate() {
                let mut m = Measured {
                    builder: ProfileBuilder::new(spec.tick_size),
                    partial: false,
                };
                for piece in &span.pieces {
                    let Some(s) = calendar.session(calendar.trade_date(piece.from)) else {
                        continue;
                    };
                    let part = if s.close <= now {
                        Arc::unwrap_or_clone(
                            self.whole(provider.id(), id, spec.tick_size, &s).await?,
                        )
                    } else {
                        self.developing(provider.id(), id, spec.tick_size, &s, now)
                            .await?
                    };
                    m.builder.merge(&part.builder);
                    m.partial |= part.partial;
                }
                let at = if span.whole {
                    span.end
                } else {
                    as_of.max(span.from)
                };
                if let Some(v) = value_levels(&m.builder) {
                    out.extend(Which::of(period, k < newest).levels(id, v, at, m.partial));
                }
            }
        }
        Ok((as_of, out))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Session,
    Prior,
    Composite,
    Week,
    PriorWeek,
    Month,
    PriorMonth,
}

impl Which {
    fn names(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Which::Session => ("", "", ""),
            Which::Prior => ("p", "Prior ", "p"),
            Which::Composite => ("c", "Composite ", "c"),
            Which::Week => ("w", "Week ", "w"),
            Which::PriorWeek => ("pw", "Prior week ", "pw"),
            Which::Month => ("m", "Month ", "m"),
            Which::PriorMonth => ("pm", "Prior month ", "pm"),
        }
    }

    fn of(period: ProfilePeriod, prior: bool) -> Self {
        match (period, prior) {
            (ProfilePeriod::Month, false) => Which::Month,
            (ProfilePeriod::Month, true) => Which::PriorMonth,
            (_, false) => Which::Week,
            (_, true) => Which::PriorWeek,
        }
    }

    fn levels(
        self,
        id: &InstrumentId,
        v: ValueLevels,
        as_of: Timestamp,
        partial: bool,
    ) -> Vec<Level> {
        let (field, label, short) = self.names();
        let mut note = if self == Which::Composite {
            format!(" ({COMPOSITE_SESSIONS} sessions)")
        } else {
            String::new()
        };
        if partial {
            note.push_str(" (recorded part)");
        }
        [
            ("poc", "POC", v.poc),
            ("vah", "VAH", v.vah),
            ("val", "VAL", v.val),
        ]
        .into_iter()
        .map(|(f, name, price)| {
            let field = format!("{field}{f}");
            Level {
                key: format!("tessera.concepts.{field}"),
                instrument: id.clone(),
                label: format!("{label}{name}{note}"),
                short: Some(format!("{short}{name}")),
                group: VOLUME_PROFILE_GROUP.to_owned(),
                price: Some(price),
                unavailable_reason: None,
                native_price: None,
                source: VendorRef {
                    vendor: TESSERA_VENDOR.to_owned(),
                    package: CONCEPTS_PACKAGE.to_owned(),
                    field,
                    basis: id.symbol().to_owned(),
                    endpoint: None,
                    as_of,
                    conversion: None,
                },
                concept: None,
            }
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;
    use std::str::FromStr;
    use tessera_market::orderflow::profile::{point_of_control, value_area_band};

    #[test]
    fn the_shared_value_area_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/orderflow/value_area.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let volumes: Vec<Decimal> = case["volumes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| Decimal::from_str(&v.to_string()).unwrap())
                .collect();
            let share = case["share"].as_f64().unwrap();
            let poc = point_of_control(&volumes);
            assert_eq!(poc as u64, case["poc"].as_u64().unwrap(), "{name}");
            let (a, b, held) = value_area_band(&volumes, poc, share);
            assert_eq!(
                [a as u64, b as u64],
                [case["val"].as_u64().unwrap(), case["vah"].as_u64().unwrap()],
                "{name}"
            );
            assert_eq!(
                held,
                Decimal::from_str(&case["held"].to_string()).unwrap(),
                "{name}"
            );
        }
    }
}
