use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

use crate::time::{NANOS_PER_DAY, NANOS_PER_HOUR, NANOS_PER_MINUTE, NANOS_PER_SEC};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TimeUnit {
    Second,
    Minute,
    Hour,
    Day,
}

impl TimeUnit {
    pub const fn nanos(self) -> i64 {
        match self {
            TimeUnit::Second => NANOS_PER_SEC,
            TimeUnit::Minute => NANOS_PER_MINUTE,
            TimeUnit::Hour => NANOS_PER_HOUR,
            TimeUnit::Day => NANOS_PER_DAY,
        }
    }

    const fn letter(self) -> &'static str {
        match self {
            TimeUnit::Second => "s",
            TimeUnit::Minute => "m",
            TimeUnit::Hour => "h",
            TimeUnit::Day => "D",
        }
    }

    const fn noun(self) -> &'static str {
        match self {
            TimeUnit::Second => "second",
            TimeUnit::Minute => "minute",
            TimeUnit::Hour => "hour",
            TimeUnit::Day => "day",
        }
    }

    fn named(word: &str) -> Option<Self> {
        let unit = match word.to_ascii_lowercase().as_str() {
            "s" | "sec" | "secs" | "second" | "seconds" => TimeUnit::Second,
            "" | "m" | "min" | "mins" | "minute" | "minutes" => TimeUnit::Minute,
            "h" | "hr" | "hrs" | "hour" | "hours" => TimeUnit::Hour,
            "d" | "day" | "days" => TimeUnit::Day,
            _ => return None,
        };
        Some(unit)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(type = "`${number}${\"s\" | \"m\" | \"h\" | \"D\"}`")]
pub struct Timeframe {
    count: u32,
    unit: TimeUnit,
}

pub const MAX_INTRADAY_NANOS: i64 = NANOS_PER_DAY;

pub const MAX_SESSIONS: u32 = 365;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "unknown timeframe {0:?}; write a count and a unit, like 15s 5m 2h 1D, from 1s to 24h or 1D to 365D"
)]
pub struct TimeframeParseError(pub String);

impl Timeframe {
    pub const S1: Timeframe = Timeframe::of(1, TimeUnit::Second);
    pub const S15: Timeframe = Timeframe::of(15, TimeUnit::Second);
    pub const S30: Timeframe = Timeframe::of(30, TimeUnit::Second);
    pub const M1: Timeframe = Timeframe::of(1, TimeUnit::Minute);
    pub const M5: Timeframe = Timeframe::of(5, TimeUnit::Minute);
    pub const M15: Timeframe = Timeframe::of(15, TimeUnit::Minute);
    pub const M30: Timeframe = Timeframe::of(30, TimeUnit::Minute);
    pub const H1: Timeframe = Timeframe::of(1, TimeUnit::Hour);
    pub const H4: Timeframe = Timeframe::of(4, TimeUnit::Hour);
    pub const D1: Timeframe = Timeframe::of(1, TimeUnit::Day);

    pub const PRESETS: [Timeframe; 10] = [
        Timeframe::S1,
        Timeframe::S15,
        Timeframe::S30,
        Timeframe::M1,
        Timeframe::M5,
        Timeframe::M15,
        Timeframe::M30,
        Timeframe::H1,
        Timeframe::H4,
        Timeframe::D1,
    ];

    const fn of(count: u32, unit: TimeUnit) -> Self {
        Self { count, unit }
    }

    pub fn new(count: u32, unit: TimeUnit) -> Option<Self> {
        if count == 0 {
            return None;
        }
        if unit == TimeUnit::Day {
            return (count <= MAX_SESSIONS).then_some(Self::of(count, unit));
        }
        if i64::from(count) * unit.nanos() > MAX_INTRADAY_NANOS {
            return None;
        }
        let mut tf = Self::of(count, unit);
        while let Some(larger) = tf.in_larger_unit() {
            tf = larger;
        }
        Some(tf)
    }

    fn in_larger_unit(self) -> Option<Self> {
        let larger = match self.unit {
            TimeUnit::Second => TimeUnit::Minute,
            TimeUnit::Minute => TimeUnit::Hour,
            TimeUnit::Hour | TimeUnit::Day => return None,
        };
        let per = (larger.nanos() / self.unit.nanos()) as u32;
        self.count
            .is_multiple_of(per)
            .then(|| Self::of(self.count / per, larger))
    }

    pub const fn count(self) -> u32 {
        self.count
    }

    pub const fn unit(self) -> TimeUnit {
        self.unit
    }

    pub const fn nanos(self) -> i64 {
        self.count as i64 * self.unit.nanos()
    }

    pub const fn minutes(self) -> i64 {
        self.nanos() / NANOS_PER_MINUTE
    }

    pub const fn is_session(self) -> bool {
        matches!(self.unit, TimeUnit::Day)
    }

    pub const fn sessions(self) -> u32 {
        if self.is_session() { self.count } else { 0 }
    }

    pub const fn base(self) -> Option<Timeframe> {
        match self.unit {
            TimeUnit::Second => None,
            TimeUnit::Minute | TimeUnit::Hour => Some(Timeframe::M1),
            TimeUnit::Day => Some(Timeframe::D1),
        }
    }

    pub fn words(self) -> String {
        let plural = if self.count == 1 { "" } else { "s" };
        format!("{} {}{plural}", self.count, self.unit.noun())
    }
}

impl Ord for Timeframe {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.nanos(), self.unit).cmp(&(other.nanos(), other.unit))
    }
}

impl PartialOrd for Timeframe {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Timeframe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.count, self.unit.letter())
    }
}

impl FromStr for Timeframe {
    type Err = TimeframeParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let fail = || TimeframeParseError(s.to_owned());
        let t = s.trim();
        let digits = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
        let (count, word) = t.split_at(digits);
        let word = word.trim();
        let count: u32 = match count {
            "" if !word.is_empty() => 1,
            n => n.parse().map_err(|_| fail())?,
        };
        let unit = TimeUnit::named(word).ok_or_else(fail)?;
        Timeframe::new(count, unit).ok_or_else(fail)
    }
}

impl Serialize for Timeframe {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Timeframe {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = Cow::<str>::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for Timeframe {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("Timeframe")
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "description": "Bar timeframe: a count and a unit, s (seconds), m (minutes), h (hours) or D (trading sessions), e.g. 1s 15s 30s 1m 3m 5m 90m 2h 4h 1D 2D. Any count works from 1s to 24h and from 1D to 365D.",
            "examples": ["15s", "1m", "5m", "1h", "1D"]
        })
    }
}

pub const PRINT_BAR_SIZE_MAX: u32 = 100_000;

pub const TIMEFRAME_PATTERN: &str = "^[1-9][0-9]*(s|m|h|D)$";

pub const INTERVAL_PATTERN: &str = "^[1-9][0-9]*(s|m|h|D|T|R|V|Δ|Rk)$";

pub fn check_timeframe_text(text: &str) -> Result<Timeframe, String> {
    match text.parse::<Timeframe>() {
        Ok(tf) if tf.to_string() == text => Ok(tf),
        Ok(tf) => Err(format!("{text} is written {tf}")),
        Err(_) => Err(format!(
            "{text} is not a timeframe (a count and s, m, h or D: 15s 5m 2h 1D)"
        )),
    }
}

pub fn check_interval_text(text: &str) -> Result<(), String> {
    if PrintBars::from_short(text).is_some_and(|b| b.short() == text) {
        return Ok(());
    }
    match text.parse::<Timeframe>() {
        Ok(tf) if tf.to_string() == text => Ok(()),
        Ok(tf) => Err(format!("{text} is written {tf}")),
        Err(_) => Err(format!(
            "{text} is not an interval (a count and s, m, h or D, or T, R, V, Δ or Rk for ticks, range, volume, delta or renko: 15s 2D 377T)"
        )),
    }
}

/// What closes a bar built from prints. Every kind but renko starts a new bar at each session's open;
/// renko bricks run on across it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrintBars {
    /// A bar every `size` prints.
    Tick {
        /// Prints a bar.
        size: u32,
    },
    /// A bar whose high and low stay within `size` ticks: the print that would take it further
    /// starts the next.
    Range {
        /// Ticks from a bar's low to its high, at most.
        size: u32,
    },
    /// A bar every `size` contracts: it closes on the print that reaches it.
    Volume {
        /// Contracts a bar.
        size: u32,
    },
    /// A bar whose net delta (aggressive buys less aggressive sells) reaches `size` either way: it
    /// closes on the print that reaches it.
    Delta {
        /// Contracts of net delta a bar, bought or sold.
        size: u32,
    },
    /// Renko: bricks `size` ticks tall. A brick closes `size` ticks past the last close the way the
    /// bricks run, or `2 × size` ticks back against them; a print that jumps further leaves a brick
    /// for each box. A finished brick is its body alone, open to close. Bricks run on across the
    /// session's open.
    Renko {
        /// Ticks a brick.
        size: u32,
    },
}

impl PrintBars {
    pub fn size(self) -> u32 {
        match self {
            PrintBars::Tick { size }
            | PrintBars::Range { size }
            | PrintBars::Volume { size }
            | PrintBars::Delta { size }
            | PrintBars::Renko { size } => size,
        }
    }

    pub fn short(self) -> String {
        let letter = match self {
            PrintBars::Tick { .. } => "T",
            PrintBars::Range { .. } => "R",
            PrintBars::Volume { .. } => "V",
            PrintBars::Delta { .. } => "Δ",
            PrintBars::Renko { .. } => "Rk",
        };
        format!("{}{letter}", self.size())
    }

    pub fn from_short(text: &str) -> Option<Self> {
        let digits = text.find(|c: char| !c.is_ascii_digit())?;
        let (count, letter) = text.split_at(digits);
        let size: u32 = count
            .parse()
            .ok()
            .filter(|n| (1..=PRINT_BAR_SIZE_MAX).contains(n))?;
        match letter {
            "T" => Some(PrintBars::Tick { size }),
            "R" => Some(PrintBars::Range { size }),
            "V" => Some(PrintBars::Volume { size }),
            "Δ" => Some(PrintBars::Delta { size }),
            "Rk" => Some(PrintBars::Renko { size }),
            _ => None,
        }
    }

    pub fn words(self) -> String {
        match self {
            PrintBars::Tick { size } => format!("{size} tick"),
            PrintBars::Range { size } => format!("{size} range"),
            PrintBars::Volume { size } => format!("{size} volume"),
            PrintBars::Delta { size } => format!("{size} delta"),
            PrintBars::Renko { size } => format!("{size} renko"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tf(s: &str) -> Timeframe {
        s.parse().unwrap()
    }

    #[test]
    fn wire_names_round_trip() {
        for tf in Timeframe::PRESETS {
            let json = serde_json::to_string(&tf).unwrap();
            assert_eq!(json, format!("\"{tf}\""));
            let back: Timeframe = serde_json::from_str(&json).unwrap();
            assert_eq!(back, tf);
            assert_eq!(tf.to_string().parse::<Timeframe>().unwrap(), tf);
        }
        assert_eq!(
            Timeframe::PRESETS.map(|t| t.to_string()),
            [
                "1s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1D"
            ]
        );
    }

    #[test]
    fn any_count_of_any_unit_parses() {
        for (text, wire) in [
            ("2s", "2s"),
            ("45 sec", "45s"),
            ("7m", "7m"),
            ("13 minutes", "13m"),
            ("90m", "90m"),
            ("2h", "2h"),
            ("3 Hours", "3h"),
            ("2d", "2D"),
            ("5 days", "5D"),
            ("D", "1D"),
            ("1S", "1s"),
            ("4H", "4h"),
            ("15", "15m"),
        ] {
            assert_eq!(tf(text).to_string(), wire, "{text}");
        }
        assert_eq!(
            serde_json::from_str::<Timeframe>("\"10s\"").unwrap(),
            tf("10s")
        );
    }

    #[test]
    fn one_interval_has_one_name() {
        assert_eq!(tf("60s"), Timeframe::M1);
        assert_eq!(tf("120s"), tf("2m"));
        assert_eq!(tf("60m"), Timeframe::H1);
        assert_eq!(tf("240m"), Timeframe::H4);
        assert_eq!(tf("90s").to_string(), "90s");
        assert_eq!(tf("24h").to_string(), "24h");
        assert_ne!(tf("24h"), Timeframe::D1);
    }

    #[test]
    fn nonsense_and_out_of_range_are_refused() {
        for bad in [
            "", "0m", "abc", "5x", "1.5m", "-1m", "25h", "86401s", "366D", "1W", "m5",
        ] {
            assert!(bad.parse::<Timeframe>().is_err(), "{bad}");
        }
    }

    #[test]
    fn durations_order_and_pick_a_base() {
        let mut prev = 0;
        for tf in Timeframe::PRESETS {
            assert!(tf.nanos() > prev);
            prev = tf.nanos();
        }
        assert_eq!(Timeframe::H4.minutes(), 240);
        assert!(tf("24h") < Timeframe::D1);
        assert!(Timeframe::D1 < tf("2D"));
        assert_eq!(tf("15s").base(), None);
        assert_eq!(tf("90s").base(), None);
        assert_eq!(tf("7m").base(), Some(Timeframe::M1));
        assert_eq!(tf("2h").base(), Some(Timeframe::M1));
        assert_eq!(tf("3D").base(), Some(Timeframe::D1));
        assert_eq!(tf("3D").sessions(), 3);
        assert_eq!(tf("90m").words(), "90 minutes");
        assert_eq!(Timeframe::D1.words(), "1 day");
    }

    #[test]
    fn interval_text_is_one_canonical_spelling() {
        for ok in [
            "15s", "1m", "90m", "2h", "1D", "2D", "377T", "6R", "2500V", "300Δ", "8Rk",
        ] {
            assert_eq!(check_interval_text(ok), Ok(()), "{ok}");
        }
        assert_eq!(
            PrintBars::from_short("377T"),
            Some(PrintBars::Tick { size: 377 })
        );
        assert_eq!(PrintBars::Volume { size: 2500 }.short(), "2500V");
        assert_eq!(
            PrintBars::from_short("300Δ"),
            Some(PrintBars::Delta { size: 300 })
        );
        assert_eq!(
            PrintBars::from_short("8Rk"),
            Some(PrintBars::Renko { size: 8 })
        );
        assert_eq!(PrintBars::Renko { size: 8 }.words(), "8 renko");
        assert_eq!(
            check_interval_text("120s").unwrap_err(),
            "120s is written 2m"
        );
        for bad in [
            "1W", "soon", "0m", "377t", "0T", "100001T", "T", "", "1é", "+5T", "8rk", "8RK", "8K",
            "0Δ", "Δ", "5TΔ",
        ] {
            assert!(check_interval_text(bad).is_err(), "{bad}");
        }
        assert_eq!(check_timeframe_text("15s"), Ok(Timeframe::S15));
        assert!(check_timeframe_text("377T").is_err());
    }
}
