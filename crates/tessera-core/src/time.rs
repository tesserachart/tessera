use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

pub const NANOS_PER_MICRO: i64 = 1_000;
pub const NANOS_PER_MILLI: i64 = 1_000_000;
pub const NANOS_PER_SEC: i64 = 1_000_000_000;
pub const NANOS_PER_MINUTE: i64 = 60 * NANOS_PER_SEC;
pub const NANOS_PER_HOUR: i64 = 60 * NANOS_PER_MINUTE;
pub const NANOS_PER_DAY: i64 = 24 * NANOS_PER_HOUR;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(type = "number")]
pub struct Timestamp(pub i64);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid timestamp {0:?}: expected integer nanoseconds, RFC 3339 or YYYY-MM-DD")]
pub struct TimestampParseError(pub String);

impl Timestamp {
    pub const fn from_nanos(ns: i64) -> Self {
        Self(ns)
    }

    pub const fn from_millis(ms: i64) -> Self {
        Self(ms * NANOS_PER_MILLI)
    }

    pub const fn from_secs(secs: i64) -> Self {
        Self(secs * NANOS_PER_SEC)
    }

    pub const fn nanos(self) -> i64 {
        self.0
    }

    pub const fn millis(self) -> i64 {
        self.0.div_euclid(NANOS_PER_MILLI)
    }

    pub const fn secs(self) -> i64 {
        self.0.div_euclid(NANOS_PER_SEC)
    }

    pub fn now() -> Self {
        Self::from_datetime(Utc::now())
    }

    pub fn from_datetime<T: TimeZone>(dt: DateTime<T>) -> Self {
        let utc = dt.with_timezone(&Utc);
        Self(utc.timestamp() * NANOS_PER_SEC + i64::from(utc.timestamp_subsec_nanos()))
    }

    pub fn to_datetime(self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.secs(), self.0.rem_euclid(NANOS_PER_SEC) as u32)
            .unwrap_or_default()
    }

    pub fn in_tz(self, tz: Tz) -> DateTime<Tz> {
        self.to_datetime().with_timezone(&tz)
    }

    pub const fn add_nanos(self, ns: i64) -> Self {
        Self(self.0 + ns)
    }

    pub fn floor_to(self, step: i64, anchor: Timestamp) -> Timestamp {
        debug_assert!(step > 0);
        let offset = (self.0 - anchor.0).div_euclid(step) * step;
        Timestamp(anchor.0 + offset)
    }

    pub fn parse(s: &str) -> Result<Self, TimestampParseError> {
        let t = s.trim();
        if let Ok(ns) = t.parse::<i64>() {
            return Ok(Self(ns));
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(t) {
            return Ok(Self::from_datetime(dt));
        }
        if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
            return Ok(Self::from_datetime(
                d.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc(),
            ));
        }
        Err(TimestampParseError(s.to_owned()))
    }

    pub fn to_rfc3339(self) -> String {
        self.to_datetime().to_rfc3339()
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_rfc3339())
    }
}

impl FromStr for Timestamp {
    type Err = TimestampParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.0)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = Timestamp;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("integer UTC nanoseconds, an RFC 3339 string or YYYY-MM-DD")
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Timestamp, E> {
                Ok(Timestamp(v))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Timestamp, E> {
                i64::try_from(v)
                    .map(Timestamp)
                    .map_err(|_| E::custom("timestamp out of range"))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Timestamp, E> {
                if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.2e18 {
                    Ok(Timestamp(v as i64))
                } else {
                    Err(E::custom(format!("invalid timestamp {v}")))
                }
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Timestamp, E> {
                Timestamp::parse(v).map_err(E::custom)
            }
        }
        deserializer.deserialize_any(V)
    }
}

impl JsonSchema for Timestamp {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("Timestamp")
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "UTC instant: integer nanoseconds since the Unix epoch, or an RFC 3339 string (\"2026-10-02T14:42:30-04:00\"), or a date YYYY-MM-DD (midnight UTC). Outputs are always integer nanoseconds.",
            "anyOf": [
                { "type": "integer" },
                { "type": "string" }
            ]
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(type = "string")]
pub struct ExchangeTz(pub Tz);

impl ExchangeTz {
    pub const NEW_YORK: ExchangeTz = ExchangeTz(Tz::America__New_York);
    pub const CHICAGO: ExchangeTz = ExchangeTz(Tz::America__Chicago);
    pub const UTC: ExchangeTz = ExchangeTz(Tz::UTC);

    pub fn name(self) -> &'static str {
        self.0.name()
    }

    pub fn tz(self) -> Tz {
        self.0
    }
}

impl fmt::Display for ExchangeTz {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl FromStr for ExchangeTz {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<Tz>().map(ExchangeTz).map_err(|e| e.to_string())
    }
}

impl Serialize for ExchangeTz {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> Deserialize<'de> for ExchangeTz {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for ExchangeTz {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("ExchangeTz")
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "description": "IANA time zone name, e.g. America/New_York." })
    }
}

pub fn system_zone() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|z| z.parse().ok())
        .unwrap_or(Tz::UTC)
}

#[derive(Clone, Debug)]
pub struct DisplayZone(Arc<RwLock<Tz>>);

impl DisplayZone {
    pub fn new(zone: Tz) -> Self {
        Self(Arc::new(RwLock::new(zone)))
    }

    pub fn get(&self) -> Tz {
        self.0.read().map_or(Tz::UTC, |z| *z)
    }

    pub fn set(&self, zone: Tz) {
        if let Ok(mut z) = self.0.write() {
            *z = zone;
        }
    }
}

impl Default for DisplayZone {
    fn default() -> Self {
        Self::new(system_zone())
    }
}

pub fn local_to_timestamp(tz: Tz, date: NaiveDate, hour: u32, minute: u32) -> Timestamp {
    let naive = date
        .and_hms_opt(hour, minute, 0)
        .unwrap_or_else(|| date.and_hms_opt(0, 0, 0).unwrap_or_default());
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Timestamp::from_datetime(dt),
        chrono::LocalResult::Ambiguous(early, _) => Timestamp::from_datetime(early),
        chrono::LocalResult::None => {
            let shifted = naive + chrono::Duration::hours(1);
            tz.from_local_datetime(&shifted)
                .earliest()
                .map(Timestamp::from_datetime)
                .unwrap_or_else(|| Timestamp::from_datetime(naive.and_utc()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_forms() {
        let a = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let b = Timestamp::parse("2026-10-02T18:42:30Z").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.millis(), 1_790_966_550_000);
        assert_eq!(Timestamp::parse(&a.0.to_string()).unwrap(), a);
        let d = Timestamp::parse("2026-10-02").unwrap();
        assert_eq!(d.to_rfc3339(), "2026-10-02T00:00:00+00:00");
        assert!(Timestamp::parse("yesterday").is_err());
    }

    #[test]
    fn serde_integer_and_string() {
        let t = Timestamp::from_millis(1_790_966_550_000);
        assert_eq!(serde_json::to_string(&t).unwrap(), "1790966550000000000");
        let s: Timestamp = serde_json::from_str("\"2026-10-02T14:42:30-04:00\"").unwrap();
        assert_eq!(s, t);
        let f: Timestamp = serde_json::from_str("1.79096655e18").unwrap();
        assert_eq!(f, t);
    }

    #[test]
    fn floor_and_tz() {
        let t = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let anchor = local_to_timestamp(
            Tz::America__New_York,
            t.in_tz(Tz::America__New_York).date_naive(),
            9,
            30,
        );
        let floored = t.floor_to(5 * NANOS_PER_MINUTE, anchor);
        assert_eq!(
            floored,
            Timestamp::parse("2026-10-02T14:40:00-04:00").unwrap()
        );
        assert_eq!(ExchangeTz::NEW_YORK.name(), "America/New_York");
        let tz: ExchangeTz = serde_json::from_str("\"America/Chicago\"").unwrap();
        assert_eq!(tz, ExchangeTz::CHICAGO);
    }

    #[test]
    fn dst_gaps_resolve() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 8).unwrap();
        let t = local_to_timestamp(Tz::America__New_York, date, 2, 30);
        assert_eq!(t, Timestamp::parse("2026-03-08T03:30:00-04:00").unwrap());
    }
}
