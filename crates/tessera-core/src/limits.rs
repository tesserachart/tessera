use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use chrono_tz::Tz;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::AccountId;
use crate::money::Money;
use crate::session::SessionCalendar;
use crate::time::{NANOS_PER_MINUTE, local_to_timestamp};
use crate::{Origin, Timestamp};

/// One set of limits. A limit left out is off.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RiskLimits {
    /// Daily loss limit, in the account's currency: today's loss (realized and open, from the
    /// session's start) may not reach it. Reached, Tessera cancels the account's working orders,
    /// closes its positions and refuses new entries until the next session opens (18:00 New York),
    /// even if the limit is changed meanwhile; exits always work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_loss_limit: Option<f64>,
    /// Max risk per trade: the money an entry loses at its stop, in the account's currency. An
    /// entry without a stop is refused while it is on (its risk is not bounded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_risk_per_trade: Option<f64>,
    /// Max contracts in one order that opens or adds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_order_qty: Option<u32>,
    /// Max contracts held in one contract, long or short.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_position_qty: Option<u32>,
    /// Max trades a day: a trade starts when a position opens from flat (or flips).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_trades_per_day: Option<u32>,
}

impl RiskLimits {
    pub fn is_off(&self) -> bool {
        self.daily_loss().is_none()
            && self.risk_per_trade().is_none()
            && self.order_qty().is_none()
            && self.position_qty().is_none()
            && self.trades_per_day().is_none()
    }

    pub fn daily_loss(&self) -> Option<f64> {
        self.daily_loss_limit.filter(|v| *v > 0.0)
    }

    pub fn risk_per_trade(&self) -> Option<f64> {
        self.max_risk_per_trade.filter(|v| *v > 0.0)
    }

    pub fn order_qty(&self) -> Option<u32> {
        self.max_order_qty.filter(|v| *v > 0)
    }

    pub fn position_qty(&self) -> Option<u32> {
        self.max_position_qty.filter(|v| *v > 0)
    }

    pub fn trades_per_day(&self) -> Option<u32> {
        self.max_trades_per_day.filter(|v| *v > 0)
    }
}

/// The value of `risk.limits`: one set for every account, the accounts that have their own, and
/// whether a firm's own rules hold too.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LimitsSetting {
    /// The limits every account is held to (each measured on its own).
    #[serde(default)]
    pub every: RiskLimits,
    /// Accounts with their own limits, by account id: an account here is held to its own set
    /// instead of `every` (an empty set: no limits on it).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub accounts: BTreeMap<String, RiskLimits>,
    /// A prop firm's own rules, as its platform reports them (daily loss, the firm's drawdown, a
    /// lock), refuse new positions that would break them. Off: they are shown in Accounts only.
    #[serde(default)]
    pub use_firm_limits: bool,
    /// A lock the trader set (Lock trading) may be lifted before it ends, by the trader typing
    /// UNLOCK. Off (the default): a lock holds until its time, even after a restart. A daily loss
    /// limit's lock never lifts early, and an agent never lifts a lock.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_early_unlock: bool,
}

impl LimitsSetting {
    pub fn from_value(v: &serde_json::Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }

    pub fn of(&self, account: &AccountId) -> (&RiskLimits, bool) {
        match self.accounts.get(account.as_str()) {
            Some(own) => (own, true),
            None => (&self.every, false),
        }
    }

    pub fn is_off(&self) -> bool {
        !self.use_firm_limits
            && self.every.is_off()
            && self.accounts.values().all(RiskLimits::is_off)
    }
}

/// Where an account stands against the limits it is held to. Present only when one is on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LimitsStatus {
    /// Account.
    pub account_id: AccountId,
    /// The account's own limits (true) or every account's (false).
    pub own: bool,
    /// The daily loss limit, when on.
    pub daily_loss_limit: Option<Money>,
    /// What can still be lost today before it binds: the limit plus today's P&L, never negative.
    pub daily_loss_left: Option<Money>,
    /// Max risk per trade (at the stop), when on.
    pub max_risk_per_trade: Option<Money>,
    /// Max contracts an order, when on.
    pub max_order_qty: Option<u32>,
    /// Max contracts held in one contract, when on.
    pub max_position_qty: Option<u32>,
    /// Max trades a day, when on.
    pub max_trades_per_day: Option<u32>,
    /// Trades started today (a position opened from flat, or flipped), when that limit is on.
    pub trades_today: Option<u32>,
    /// What the firm's own rules leave, when the user holds the account to them and its platform
    /// reports them.
    pub firm_room: Option<Money>,
    /// New positions are refused (the daily loss limit, or the firm's rules when used, is
    /// reached); exits work.
    pub locked: bool,
    /// Why, in the trader's words, when locked.
    pub locked_why: Option<String>,
    /// When new entries work again, while a lock holds: the next session's open once the daily
    /// loss limit was reached, or the end of the trader's own lock (the lock holds until then
    /// whatever the limits say).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked_until: Option<Timestamp>,
    /// What holds the lock `lockedUntil` names: `daily_loss` (the limit was reached and Tessera
    /// closed the positions) or `manual` (the trader locked the account; positions and their stops
    /// stay).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lock_kind: Option<LockKind>,
    /// As of.
    pub as_of: Timestamp,
}

/// What holds an account's lock on new entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LockKind {
    /// The daily loss limit was reached: Tessera closed the positions; entries wait for the next
    /// session.
    DailyLoss,
    /// The trader locked the account (Lock trading), or asked an agent to: positions, stops and
    /// targets stay.
    Manual,
}

/// Who set a manual lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LockedBy {
    /// The trader, in the app.
    User,
    /// An agent or MCP client, asked by the trader.
    Agent,
}

impl LockedBy {
    pub fn of(origin: &Origin) -> Self {
        if origin.is_user() {
            LockedBy::User
        } else {
            LockedBy::Agent
        }
    }
}

/// A market's session, by its own exchange's hours in its own time zone, Monday to Friday (the
/// exchange's holidays are not skipped).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarketSession {
    /// New York: 09:30–16:00 America/New_York.
    NewYork,
    /// London: 08:00–16:30 Europe/London.
    London,
    /// Tokyo: 09:00–15:30 Asia/Tokyo.
    Tokyo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionReach {
    Running { ends: Timestamp },
    Waiting { opens: Timestamp },
}

impl MarketSession {
    pub const ALL: [MarketSession; 3] = [
        MarketSession::NewYork,
        MarketSession::London,
        MarketSession::Tokyo,
    ];

    pub fn name(self) -> &'static str {
        match self {
            MarketSession::NewYork => "New York",
            MarketSession::London => "London",
            MarketSession::Tokyo => "Tokyo",
        }
    }

    pub fn tz(self) -> Tz {
        match self {
            MarketSession::NewYork => Tz::America__New_York,
            MarketSession::London => Tz::Europe__London,
            MarketSession::Tokyo => Tz::Asia__Tokyo,
        }
    }

    fn hours(self) -> ((u32, u32), (u32, u32)) {
        match self {
            MarketSession::NewYork => ((9, 30), (16, 0)),
            MarketSession::London => ((8, 0), (16, 30)),
            MarketSession::Tokyo => ((9, 0), (15, 30)),
        }
    }

    fn window_on(self, date: NaiveDate) -> Option<(Timestamp, Timestamp)> {
        if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            return None;
        }
        let ((sh, sm), (eh, em)) = self.hours();
        let tz = self.tz();
        Some((
            local_to_timestamp(tz, date, sh, sm),
            local_to_timestamp(tz, date, eh, em),
        ))
    }

    pub fn reach(self, now: Timestamp) -> SessionReach {
        let today = now.in_tz(self.tz()).date_naive();
        let mut date = today;
        loop {
            if let Some((start, end)) = self.window_on(date)
                && end > now
            {
                return if start <= now {
                    SessionReach::Running { ends: end }
                } else {
                    SessionReach::Waiting { opens: start }
                };
            }
            date += Duration::days(1);
        }
    }
}

/// How long a manual lock holds. Times are the exchange's own (CME's: New York), whatever zone
/// the app shows them in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum LockSpan {
    /// A number of minutes from now, 1 to 1440 (the app offers 5, 15, 30, 60, 120 and 240).
    Minutes {
        /// Minutes.
        minutes: u32,
    },
    /// Until today's market close (CME: 17:00 New York; earlier on an early-close day).
    MarketClose,
    /// Until the regular session opens on a later day than today (CME equity index: 09:30 New
    /// York; a contract without a regular session: its next session's open).
    NextOpen,
    /// The rest of the trading day: until the next session opens (CME: 18:00 New York), as after
    /// a reached daily loss limit.
    TradingDay,
    /// A market's session: until it ends while it runs, else until it opens.
    Session {
        /// The market.
        session: MarketSession,
    },
}

pub const LOCK_MINUTES_MAX: u32 = 24 * 60;

pub const LOCK_QUICK_MINUTES: [u32; 6] = [5, 15, 30, 60, 120, 240];

fn minutes_words(m: u32) -> String {
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (1, 0) => "1 hour".into(),
        (h, 0) => format!("{h} hours"),
        (h, m) => format!("{h} h {m} min"),
    }
}

impl LockSpan {
    pub fn offered() -> Vec<LockSpan> {
        LOCK_QUICK_MINUTES
            .iter()
            .map(|&minutes| LockSpan::Minutes { minutes })
            .chain([
                LockSpan::MarketClose,
                LockSpan::NextOpen,
                LockSpan::TradingDay,
            ])
            .chain(
                MarketSession::ALL
                    .iter()
                    .map(|&session| LockSpan::Session { session }),
            )
            .collect()
    }

    pub fn label(self, now: Timestamp) -> String {
        match self {
            LockSpan::Minutes { minutes } => minutes_words(minutes),
            LockSpan::MarketClose => "Until market close".into(),
            LockSpan::NextOpen => "Until tomorrow’s open".into(),
            LockSpan::TradingDay => "Rest of the trading day".into(),
            LockSpan::Session { session } => match session.reach(now) {
                SessionReach::Running { .. } => format!("Rest of the {} session", session.name()),
                SessionReach::Waiting { .. } => format!("Until {} opens", session.name()),
            },
        }
    }

    pub fn until(self, calendar: SessionCalendar, now: Timestamp) -> Result<Timestamp, String> {
        match self {
            LockSpan::Minutes { minutes } if (1..=LOCK_MINUTES_MAX).contains(&minutes) => {
                Ok(Timestamp(now.0 + i64::from(minutes) * NANOS_PER_MINUTE))
            }
            LockSpan::Minutes { minutes } => Err(format!(
                "A lock lasts 1 to {LOCK_MINUTES_MAX} minutes, not {minutes}"
            )),
            LockSpan::MarketClose => {
                let close = calendar
                    .session(calendar.trade_date(now))
                    .map(|s| s.close)
                    .filter(|close| *close > now);
                close.ok_or_else(|| "The market is closed now: pick another time".to_owned())
            }
            LockSpan::NextOpen => next_open_after_today(calendar, now)
                .ok_or_else(|| "No session opens in the next two weeks".to_owned()),
            LockSpan::TradingDay => Ok(next_session_open(calendar, now)),
            LockSpan::Session { session } => Ok(match session.reach(now) {
                SessionReach::Running { ends } => ends,
                SessionReach::Waiting { opens } => opens,
            }),
        }
    }
}

pub fn next_session_open(calendar: SessionCalendar, now: Timestamp) -> Timestamp {
    calendar
        .session(calendar.next_trade_date(calendar.trade_date(now)))
        .map_or(now, |s| s.open)
}

fn next_open_after_today(calendar: SessionCalendar, now: Timestamp) -> Option<Timestamp> {
    let tz = calendar.tz();
    let today = now.in_tz(tz).date_naive();
    let mut date = calendar.trade_date(now);
    for _ in 0..14 {
        if let Some(s) = calendar.session(date) {
            let opens = s.rth.map_or(s.open, |w| w.start);
            if opens > now && opens.in_tz(tz).date_naive() > today {
                return Some(opens);
            }
        }
        date = calendar.next_trade_date(date);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nothing_set_is_off_and_an_account_of_its_own_wins() {
        let s = LimitsSetting::from_value(&json!({}));
        assert!(s.is_off());
        assert!(LimitsSetting::from_value(&json!("garbage")).is_off());
        let s = LimitsSetting::from_value(&json!({
            "every": {"dailyLossLimit": 500, "maxOrderQty": 5},
            "accounts": {"eval-50k": {"dailyLossLimit": 1000}},
        }));
        assert!(!s.is_off());
        let (paper, own) = s.of(&AccountId::new("paper-main"));
        assert!(!own);
        assert_eq!(paper.daily_loss(), Some(500.0));
        assert_eq!(paper.order_qty(), Some(5));
        let (eval, own) = s.of(&AccountId::new("eval-50k"));
        assert!(own);
        assert_eq!(eval.daily_loss(), Some(1000.0));
        assert_eq!(
            eval.order_qty(),
            None,
            "its own set replaces the shared one whole"
        );
        let z = LimitsSetting::from_value(
            &json!({"every": {"dailyLossLimit": 0, "maxTradesPerDay": 0}}),
        );
        assert!(z.is_off());
        assert!(!LimitsSetting::from_value(&json!({"useFirmLimits": true})).is_off());
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(
            back["every"],
            json!({"dailyLossLimit": 500.0, "maxOrderQty": 5})
        );
        assert!(back.get("allowEarlyUnlock").is_none());
        let unlockable = LimitsSetting::from_value(&json!({"allowEarlyUnlock": true}));
        assert!(unlockable.allow_early_unlock && unlockable.is_off());
    }

    fn at(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    fn until(span: LockSpan, now: &str) -> Timestamp {
        span.until(SessionCalendar::CmeEquityIndex, at(now))
            .unwrap()
    }

    #[test]
    fn a_lock_span_ends_at_the_exchanges_own_clock_time() {
        let tuesday = "2026-10-06T14:42:00-04:00";
        assert_eq!(
            until(LockSpan::Minutes { minutes: 15 }, tuesday),
            at("2026-10-06T14:57:00-04:00")
        );
        for bad in [0, LOCK_MINUTES_MAX + 1] {
            assert!(
                LockSpan::Minutes { minutes: bad }
                    .until(SessionCalendar::CmeEquityIndex, at(tuesday))
                    .is_err()
            );
        }
        assert_eq!(
            until(LockSpan::MarketClose, tuesday),
            at("2026-10-06T17:00:00-04:00")
        );
        assert!(
            LockSpan::MarketClose
                .until(
                    SessionCalendar::CmeEquityIndex,
                    at("2026-10-06T17:30:00-04:00")
                )
                .is_err(),
            "the Globex break: the market is closed"
        );
        assert_eq!(
            until(LockSpan::NextOpen, tuesday),
            at("2026-10-07T09:30:00-04:00")
        );
        assert_eq!(
            until(LockSpan::NextOpen, "2026-10-06T19:00:00-04:00"),
            at("2026-10-07T09:30:00-04:00"),
            "Tuesday evening is already Wednesday's CME trade date"
        );
        assert_eq!(
            until(LockSpan::NextOpen, "2026-10-06T03:00:00-04:00"),
            at("2026-10-07T09:30:00-04:00"),
            "tomorrow's open, not today's"
        );
        assert_eq!(
            until(LockSpan::NextOpen, "2026-10-09T15:00:00-04:00"),
            at("2026-10-12T09:30:00-04:00"),
            "Friday's: Monday"
        );
        assert_eq!(
            until(LockSpan::TradingDay, tuesday),
            at("2026-10-06T18:00:00-04:00")
        );
        assert_eq!(
            until(LockSpan::TradingDay, "2026-10-09T15:00:00-04:00"),
            at("2026-10-11T18:00:00-04:00"),
            "Friday's trading day ends when Globex opens on Sunday"
        );
    }

    #[test]
    fn a_market_session_runs_to_its_end_or_waits_for_its_open_across_clock_changes() {
        let ny = LockSpan::Session {
            session: MarketSession::NewYork,
        };
        let london = LockSpan::Session {
            session: MarketSession::London,
        };
        let tokyo = LockSpan::Session {
            session: MarketSession::Tokyo,
        };
        let tuesday = "2026-10-06T10:00:00-04:00";
        assert_eq!(until(ny, tuesday), at("2026-10-06T16:00:00-04:00"));
        assert_eq!(ny.label(at(tuesday)), "Rest of the New York session");
        assert_eq!(until(london, tuesday), at("2026-10-06T16:30:00+01:00"));
        assert_eq!(until(tokyo, tuesday), at("2026-10-07T09:00:00+09:00"));
        assert_eq!(tokyo.label(at(tuesday)), "Until Tokyo opens");
        assert_eq!(
            until(london, "2026-10-30T10:00:00-04:00"),
            at("2026-10-30T16:30:00+00:00"),
            "London is on GMT, New York still on EDT"
        );
        assert_eq!(
            until(ny, "2026-10-09T17:00:00-04:00"),
            at("2026-10-12T09:30:00-04:00"),
            "after Friday's close: Monday's open"
        );
        assert_eq!(
            until(tokyo, "2026-10-09T21:00:00-04:00"),
            at("2026-10-12T09:00:00+09:00"),
            "Saturday in Tokyo: Monday"
        );
    }

    #[test]
    fn the_offered_spans_read_back_from_the_wire() {
        let offered = LockSpan::offered();
        assert_eq!(offered.len(), 12);
        assert_eq!(
            serde_json::to_value(offered[1]).unwrap(),
            json!({"kind": "minutes", "minutes": 15})
        );
        assert_eq!(
            serde_json::from_value::<LockSpan>(json!({"kind": "session", "session": "tokyo"}))
                .unwrap(),
            LockSpan::Session {
                session: MarketSession::Tokyo
            }
        );
        assert_eq!(
            offered
                .iter()
                .take(6)
                .map(|s| s.label(Timestamp(0)))
                .collect::<Vec<_>>(),
            ["5 min", "15 min", "30 min", "1 hour", "2 hours", "4 hours"]
        );
    }
}
