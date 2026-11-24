use chrono::{Datelike, Duration, NaiveDate, Timelike, Weekday};
use chrono_tz::Tz;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::time::{ExchangeTz, NANOS_PER_MINUTE, Timestamp, local_to_timestamp};
use crate::timeframe::Timeframe;

/// Which session calendar an instrument trades on. Every CME calendar trades Globex Sunday to Friday,
/// 18:00 to 17:00 ET, with the CME trade date; they differ in their regular session (RTH) and in how
/// they trade on holidays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionCalendar {
    /// NYSE/NASDAQ: pre-market 04:00, RTH 09:30–16:00, post-market to 20:00 ET.
    UsEquities,
    /// CME equity index futures (ES, NQ, RTY, YM and their micros): RTH 09:30–16:00 ET.
    CmeEquityIndex,
    /// CBOT Treasury futures (ZT, ZF, ZN, TN, ZB, UB): RTH 08:20–15:00 ET.
    CmeInterestRates,
    /// CME currency futures (6E, 6J, 6B, 6A, 6C, 6S and their micros): RTH 08:20–15:00 ET.
    CmeFx,
    /// NYMEX energy futures (CL, NG, RB, HO and their micros): RTH 09:00–14:30 ET.
    CmeEnergy,
    /// COMEX gold futures (GC, MGC): RTH 08:20–13:30 ET.
    CmeGold,
    /// COMEX silver futures (SI, SIL): RTH 08:25–13:25 ET.
    CmeSilver,
    /// COMEX copper futures (HG, MHG): RTH 08:10–13:00 ET.
    CmeCopper,
    /// NYMEX platinum futures (PL): RTH 08:20–13:05 ET.
    CmePlatinum,
    /// Another CME Globex product, whose regular session Tessera does not know: no RTH.
    CmeGlobex,
    /// Continuous trading; the session date is the UTC date.
    Crypto24x7,
}

impl SessionCalendar {
    pub const ALL: [SessionCalendar; 11] = [
        SessionCalendar::UsEquities,
        SessionCalendar::CmeEquityIndex,
        SessionCalendar::CmeInterestRates,
        SessionCalendar::CmeFx,
        SessionCalendar::CmeEnergy,
        SessionCalendar::CmeGold,
        SessionCalendar::CmeSilver,
        SessionCalendar::CmeCopper,
        SessionCalendar::CmePlatinum,
        SessionCalendar::CmeGlobex,
        SessionCalendar::Crypto24x7,
    ];

    pub fn of_cme_root(root: &str) -> SessionCalendar {
        crate::products::product(root).map_or(SessionCalendar::CmeGlobex, |p| p.calendar)
    }
}

/// A half-open window `[start, end)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindow {
    /// Inclusive start.
    pub start: Timestamp,
    /// Exclusive end.
    pub end: Timestamp,
}

impl SessionWindow {
    pub fn contains(&self, ts: Timestamp) -> bool {
        ts >= self.start && ts < self.end
    }

    pub fn len_nanos(&self) -> i64 {
        self.end.0 - self.start.0
    }
}

/// One trading session (one trade date) of a calendar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradingSession {
    /// The calendar this session belongs to.
    pub calendar: SessionCalendar,
    /// The trade date (CME session date for futures; UTC date for crypto).
    #[ts(type = "string")]
    pub trade_date: NaiveDate,
    /// First tradable instant (pre-market open for equities, Globex open for futures).
    pub open: Timestamp,
    /// End of the session (exclusive).
    pub close: Timestamp,
    /// Tradable windows inside `[open, close)`, in order.
    pub segments: Vec<SessionWindow>,
    /// The regular (cash) session, if the calendar has one.
    pub rth: Option<SessionWindow>,
    /// True on scheduled early-close days.
    pub early_close: bool,
}

impl TradingSession {
    pub fn is_open_at(&self, ts: Timestamp) -> bool {
        self.segments.iter().any(|s| s.contains(ts))
    }

    pub fn is_rth_at(&self, ts: Timestamp) -> bool {
        self.rth.is_some_and(|w| w.contains(ts))
    }

    pub fn minutes(&self) -> impl Iterator<Item = Timestamp> + '_ {
        self.segments.iter().flat_map(|seg| {
            let n = seg.len_nanos() / NANOS_PER_MINUTE;
            (0..n).map(move |i| Timestamp(seg.start.0 + i * NANOS_PER_MINUTE))
        })
    }

    pub fn minute_count(&self) -> i64 {
        self.segments
            .iter()
            .map(|s| s.len_nanos() / NANOS_PER_MINUTE)
            .sum()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum MarketDay {
    Weekend,
    Holiday { name: &'static str },
    EarlyClose { name: &'static str },
    Regular,
}

pub mod us_holidays {
    use super::*;

    pub fn nth_weekday(year: i32, month: u32, weekday: Weekday, n: u32) -> NaiveDate {
        NaiveDate::from_weekday_of_month_opt(year, month, weekday, n as u8)
            .expect("valid nth weekday")
    }

    pub fn last_weekday(year: i32, month: u32, weekday: Weekday) -> NaiveDate {
        let first_next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)
        }
        .expect("valid date");
        let mut d = first_next - Duration::days(1);
        while d.weekday() != weekday {
            d -= Duration::days(1);
        }
        d
    }

    /// Western (Gregorian) Easter Sunday, anonymous Gregorian algorithm.
    pub fn easter(year: i32) -> NaiveDate {
        let a = year % 19;
        let b = year / 100;
        let c = year % 100;
        let d = b / 4;
        let e = b % 4;
        let f = (b + 8) / 25;
        let g = (b - f + 1) / 3;
        let h = (19 * a + b - d - g + 15) % 30;
        let i = c / 4;
        let k = c % 4;
        let l = (32 + 2 * e + 2 * i - h - k) % 7;
        let m = (a + 11 * h + 22 * l) / 451;
        let month = (h + l - 7 * m + 114) / 31;
        let day = (h + l - 7 * m + 114) % 31 + 1;
        NaiveDate::from_ymd_opt(year, month as u32, day as u32).expect("valid easter")
    }

    fn observed(d: NaiveDate) -> NaiveDate {
        match d.weekday() {
            Weekday::Sat => d - Duration::days(1),
            Weekday::Sun => d + Duration::days(1),
            _ => d,
        }
    }

    pub fn holidays(year: i32) -> Vec<(NaiveDate, &'static str)> {
        let ymd = |m, d| NaiveDate::from_ymd_opt(year, m, d).expect("valid date");
        let mut out = Vec::with_capacity(10);
        // NYSE does not observe New Year's Day on the preceding Friday (Dec 31).
        let ny = ymd(1, 1);
        match ny.weekday() {
            Weekday::Sat => {}
            Weekday::Sun => out.push((ny + Duration::days(1), "New Year's Day")),
            _ => out.push((ny, "New Year's Day")),
        }
        out.push((
            nth_weekday(year, 1, Weekday::Mon, 3),
            "Martin Luther King Jr. Day",
        ));
        out.push((
            nth_weekday(year, 2, Weekday::Mon, 3),
            "Washington's Birthday",
        ));
        out.push((easter(year) - Duration::days(2), "Good Friday"));
        out.push((last_weekday(year, 5, Weekday::Mon), "Memorial Day"));
        if year >= 2022 {
            out.push((observed(ymd(6, 19)), "Juneteenth"));
        }
        out.push((observed(ymd(7, 4)), "Independence Day"));
        out.push((nth_weekday(year, 9, Weekday::Mon, 1), "Labor Day"));
        out.push((nth_weekday(year, 11, Weekday::Thu, 4), "Thanksgiving Day"));
        out.push((observed(ymd(12, 25)), "Christmas Day"));
        out.sort_by_key(|(d, _)| *d);
        out
    }

    pub fn holiday(date: NaiveDate) -> Option<&'static str> {
        holidays(date.year())
            .into_iter()
            .find(|(d, _)| *d == date)
            .map(|(_, n)| n)
    }

    pub fn early_close(date: NaiveDate) -> Option<&'static str> {
        if is_weekend(date) || holiday(date).is_some() {
            return None;
        }
        let year = date.year();
        let ymd = |m, d| NaiveDate::from_ymd_opt(year, m, d).expect("valid date");
        if date == ymd(7, 3) {
            return Some("Independence Day eve");
        }
        if date == nth_weekday(year, 11, Weekday::Thu, 4) + Duration::days(1) {
            return Some("Day after Thanksgiving");
        }
        if date == ymd(12, 24) {
            return Some("Christmas Eve");
        }
        None
    }

    pub fn is_weekend(date: NaiveDate) -> bool {
        matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
    }

    pub fn market_day(date: NaiveDate) -> MarketDay {
        if is_weekend(date) {
            MarketDay::Weekend
        } else if let Some(name) = holiday(date) {
            MarketDay::Holiday { name }
        } else if let Some(name) = early_close(date) {
            MarketDay::EarlyClose { name }
        } else {
            MarketDay::Regular
        }
    }

    pub fn is_trading_day(date: NaiveDate) -> bool {
        matches!(
            market_day(date),
            MarketDay::Regular | MarketDay::EarlyClose { .. }
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Clock(u32);

impl Clock {
    const fn at(hour: u32, minute: u32) -> Clock {
        Clock(hour * 60 + minute)
    }

    const fn hour(self) -> u32 {
        self.0 / 60
    }

    const fn minute(self) -> u32 {
        self.0 % 60
    }

    fn words(self) -> String {
        format!("{:02}:{:02}", self.hour(), self.minute())
    }
}

const GLOBEX_REOPEN: Clock = Clock::at(18, 0);
const GLOBEX_CLOSE: Clock = Clock::at(17, 0);
const FRIDAY_HOLIDAY_HALT: Clock = Clock::at(13, 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ShortDay {
    close: Clock,
    rth_end: Clock,
}

const fn short(close: Clock, rth_end: Clock) -> ShortDay {
    ShortDay { close, rth_end }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GlobexDay {
    Weekend,
    Closed,
    Halt(Clock),
    Short(ShortDay),
    Regular,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GlobexHours {
    market: &'static str,
    rth: Option<(Clock, Clock)>,
    holiday_halt: Clock,
    after_thanksgiving: ShortDay,
    christmas_eve: ShortDay,
    independence_eve: Option<ShortDay>,
    jobs_report_good_friday: GlobexDay,
}

const EQUITY_INDEX_HOURS: GlobexHours = GlobexHours {
    market: "CME equity index",
    rth: Some((Clock::at(9, 30), Clock::at(16, 0))),
    holiday_halt: Clock::at(13, 0),
    after_thanksgiving: short(Clock::at(13, 15), Clock::at(13, 0)),
    christmas_eve: short(Clock::at(13, 15), Clock::at(13, 0)),
    independence_eve: Some(short(Clock::at(13, 15), Clock::at(13, 0))),
    jobs_report_good_friday: GlobexDay::Halt(Clock::at(9, 15)),
};

const INTEREST_RATE_HOURS: GlobexHours = GlobexHours {
    market: "CBOT Treasuries",
    rth: Some((Clock::at(8, 20), Clock::at(15, 0))),
    holiday_halt: Clock::at(13, 0),
    after_thanksgiving: short(Clock::at(13, 15), Clock::at(13, 0)),
    christmas_eve: short(Clock::at(13, 15), Clock::at(13, 0)),
    independence_eve: Some(short(GLOBEX_CLOSE, Clock::at(13, 0))),
    jobs_report_good_friday: GlobexDay::Short(short(Clock::at(11, 15), Clock::at(11, 15))),
};

const FX_HOURS: GlobexHours = GlobexHours {
    market: "CME currencies",
    rth: Some((Clock::at(8, 20), Clock::at(15, 0))),
    holiday_halt: GLOBEX_CLOSE,
    after_thanksgiving: short(Clock::at(14, 45), Clock::at(13, 0)),
    christmas_eve: short(Clock::at(13, 45), Clock::at(13, 0)),
    independence_eve: None,
    jobs_report_good_friday: GlobexDay::Short(short(Clock::at(11, 15), Clock::at(11, 15))),
};

const ENERGY_HOURS: GlobexHours = GlobexHours {
    market: "NYMEX energy",
    rth: Some((Clock::at(9, 0), Clock::at(14, 30))),
    holiday_halt: Clock::at(14, 30),
    after_thanksgiving: short(Clock::at(14, 45), Clock::at(14, 30)),
    christmas_eve: short(Clock::at(13, 45), Clock::at(13, 30)),
    independence_eve: None,
    jobs_report_good_friday: GlobexDay::Closed,
};

const fn metal(
    market: &'static str,
    rth: (Clock, Clock),
    christmas_eve_rth_end: Clock,
) -> GlobexHours {
    GlobexHours {
        market,
        rth: Some(rth),
        holiday_halt: Clock::at(14, 30),
        after_thanksgiving: short(Clock::at(14, 45), rth.1),
        christmas_eve: short(Clock::at(13, 45), christmas_eve_rth_end),
        independence_eve: None,
        jobs_report_good_friday: GlobexDay::Closed,
    }
}

const GOLD_HOURS: GlobexHours = metal(
    "COMEX gold",
    (Clock::at(8, 20), Clock::at(13, 30)),
    Clock::at(12, 30),
);
const SILVER_HOURS: GlobexHours = metal(
    "COMEX silver",
    (Clock::at(8, 25), Clock::at(13, 25)),
    Clock::at(12, 25),
);
const COPPER_HOURS: GlobexHours = metal(
    "COMEX copper",
    (Clock::at(8, 10), Clock::at(13, 0)),
    Clock::at(12, 0),
);
const PLATINUM_HOURS: GlobexHours = metal(
    "NYMEX platinum",
    (Clock::at(8, 20), Clock::at(13, 5)),
    Clock::at(12, 5),
);

const OTHER_GLOBEX_HOURS: GlobexHours = GlobexHours {
    market: "CME Globex",
    rth: None,
    holiday_halt: Clock::at(13, 0),
    after_thanksgiving: short(Clock::at(13, 15), Clock::at(13, 15)),
    christmas_eve: short(Clock::at(13, 15), Clock::at(13, 15)),
    independence_eve: Some(short(Clock::at(13, 15), Clock::at(13, 15))),
    jobs_report_good_friday: GlobexDay::Closed,
};

const JOBS_REPORT_GOOD_FRIDAYS: [(i32, u32, u32); 1] = [(2026, 4, 3)];

fn jobs_report_good_friday(date: NaiveDate) -> bool {
    JOBS_REPORT_GOOD_FRIDAYS.contains(&(date.year(), date.month(), date.day()))
}

impl GlobexHours {
    fn day(&self, date: NaiveDate) -> GlobexDay {
        match us_holidays::market_day(date) {
            MarketDay::Weekend => GlobexDay::Weekend,
            MarketDay::Holiday {
                name: "Good Friday",
            } if jobs_report_good_friday(date) => self.jobs_report_good_friday,
            MarketDay::Holiday {
                name: "Good Friday" | "Christmas Day" | "New Year's Day",
            } => GlobexDay::Closed,
            MarketDay::Holiday { .. } if date.weekday() == Weekday::Fri => {
                GlobexDay::Halt(FRIDAY_HOLIDAY_HALT)
            }
            MarketDay::Holiday { .. } => GlobexDay::Halt(self.holiday_halt),
            MarketDay::EarlyClose { name } => {
                let short = match name {
                    "Day after Thanksgiving" => Some(self.after_thanksgiving),
                    "Christmas Eve" => Some(self.christmas_eve),
                    _ => self.independence_eve,
                };
                short.map_or(GlobexDay::Regular, GlobexDay::Short)
            }
            MarketDay::Regular => GlobexDay::Regular,
        }
    }

    fn is_trade_date(&self, date: NaiveDate) -> bool {
        matches!(self.day(date), GlobexDay::Short(_) | GlobexDay::Regular)
    }

    fn day_end(&self, date: NaiveDate) -> Option<Clock> {
        match self.day(date) {
            GlobexDay::Weekend | GlobexDay::Closed => None,
            GlobexDay::Halt(end) => Some(end),
            GlobexDay::Short(s) => Some(s.close),
            GlobexDay::Regular => Some(GLOBEX_CLOSE),
        }
    }

    fn reopens_evening_of(&self, date: NaiveDate) -> bool {
        !matches!(date.weekday(), Weekday::Fri | Weekday::Sat)
            && self.day(date + Duration::days(1)) != GlobexDay::Closed
    }

    fn rth_on(&self, date: NaiveDate) -> Option<(Clock, Clock)> {
        let (start, end) = self.rth?;
        let end = match self.day(date) {
            GlobexDay::Short(s) => end.min(s.rth_end),
            _ => end,
        };
        (start < end).then_some((start, end))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hours {
    Equities,
    Globex(GlobexHours),
    Crypto,
}

/// When a calendar's market trades.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionHours {
    /// The calendar.
    pub calendar: SessionCalendar,
    /// The market these hours are for, in words (`NYMEX energy`).
    pub market: String,
    /// IANA time zone of the times below.
    pub tz: String,
    /// The days it opens, in words (`Sun–Fri`).
    pub days: String,
    /// When it opens, `HH:MM`.
    pub opens: String,
    /// True when it opens the evening before the trade date (CME Globex).
    pub opens_day_before: bool,
    /// When it closes on the trade date, `HH:MM`.
    pub closes: String,
    /// The regular session (RTH), `HH:MM` to `HH:MM`, when the market has one apart from its whole session.
    pub rth: Option<ClockWindow>,
}

/// A window of the day in a calendar's time zone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClockWindow {
    /// Start, `HH:MM`.
    pub start: String,
    /// End, `HH:MM`.
    pub end: String,
}

/// A weekday on which a calendar has no session of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketHoliday {
    /// The day.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// The holiday.
    pub name: String,
    /// When trading that day stops, for a market that trades part of it; those hours count toward the next
    /// trade date. Empty when it is closed all day.
    pub halt: Option<Timestamp>,
}

impl SessionCalendar {
    fn hours_kind(self) -> Hours {
        match self {
            SessionCalendar::UsEquities => Hours::Equities,
            SessionCalendar::CmeEquityIndex => Hours::Globex(EQUITY_INDEX_HOURS),
            SessionCalendar::CmeInterestRates => Hours::Globex(INTEREST_RATE_HOURS),
            SessionCalendar::CmeFx => Hours::Globex(FX_HOURS),
            SessionCalendar::CmeEnergy => Hours::Globex(ENERGY_HOURS),
            SessionCalendar::CmeGold => Hours::Globex(GOLD_HOURS),
            SessionCalendar::CmeSilver => Hours::Globex(SILVER_HOURS),
            SessionCalendar::CmeCopper => Hours::Globex(COPPER_HOURS),
            SessionCalendar::CmePlatinum => Hours::Globex(PLATINUM_HOURS),
            SessionCalendar::CmeGlobex => Hours::Globex(OTHER_GLOBEX_HOURS),
            SessionCalendar::Crypto24x7 => Hours::Crypto,
        }
    }

    pub fn tz(self) -> Tz {
        match self.hours_kind() {
            Hours::Equities | Hours::Globex(_) => Tz::America__New_York,
            Hours::Crypto => Tz::UTC,
        }
    }

    pub fn exchange_tz(self) -> ExchangeTz {
        ExchangeTz(self.tz())
    }

    pub fn hours(self) -> SessionHours {
        let window = |(start, end): (Clock, Clock)| ClockWindow {
            start: start.words(),
            end: end.words(),
        };
        let (market, days, opens, opens_day_before, closes, rth) = match self.hours_kind() {
            Hours::Equities => (
                "US equities",
                "Mon–Fri",
                Clock::at(4, 0),
                false,
                Clock::at(20, 0),
                Some((Clock::at(9, 30), Clock::at(16, 0))),
            ),
            Hours::Globex(h) => (
                h.market,
                "Sun–Fri",
                GLOBEX_REOPEN,
                true,
                GLOBEX_CLOSE,
                h.rth,
            ),
            Hours::Crypto => (
                "Crypto",
                "Every day",
                Clock::at(0, 0),
                false,
                Clock::at(24, 0),
                None,
            ),
        };
        SessionHours {
            calendar: self,
            market: market.to_owned(),
            tz: self.tz().name().to_owned(),
            days: days.to_owned(),
            opens: opens.words(),
            opens_day_before,
            closes: closes.words(),
            rth: rth.map(window),
        }
    }

    pub fn holidays_between(self, from: NaiveDate, to: NaiveDate) -> Vec<MarketHoliday> {
        let kind = self.hours_kind();
        if kind == Hours::Crypto {
            return Vec::new();
        }
        let tz = self.tz();
        weekday_holidays(from, to)
            .filter(|(date, _)| !self.is_trade_date(*date))
            .map(|(date, name)| MarketHoliday {
                date,
                name: name.to_owned(),
                halt: match kind {
                    Hours::Globex(h) => match h.day(date) {
                        GlobexDay::Halt(end) => {
                            Some(local_to_timestamp(tz, date, end.hour(), end.minute()))
                        }
                        _ => None,
                    },
                    Hours::Equities | Hours::Crypto => None,
                },
            })
            .collect()
    }

    pub fn is_trade_date(self, date: NaiveDate) -> bool {
        match self.hours_kind() {
            Hours::Equities => us_holidays::is_trading_day(date),
            Hours::Globex(h) => h.is_trade_date(date),
            Hours::Crypto => true,
        }
    }

    pub fn next_trade_date(self, date: NaiveDate) -> NaiveDate {
        let mut d = date + Duration::days(1);
        while !self.is_trade_date(d) {
            d += Duration::days(1);
        }
        d
    }

    pub fn prev_trade_date(self, date: NaiveDate) -> NaiveDate {
        let mut d = date - Duration::days(1);
        while !self.is_trade_date(d) {
            d -= Duration::days(1);
        }
        d
    }

    pub fn trade_date(self, ts: Timestamp) -> NaiveDate {
        let local = ts.in_tz(self.tz());
        match self.hours_kind() {
            Hours::Equities | Hours::Crypto => local.date_naive(),
            Hours::Globex(_) => {
                let mut d = local.date_naive();
                if local.hour() >= GLOBEX_REOPEN.hour() {
                    d += Duration::days(1);
                }
                while !self.is_trade_date(d) {
                    d += Duration::days(1);
                }
                d
            }
        }
    }

    pub fn trade_date_end(self, date: NaiveDate) -> Timestamp {
        let tz = self.tz();
        match self.hours_kind() {
            Hours::Globex(_) => {
                local_to_timestamp(tz, date, GLOBEX_REOPEN.hour(), GLOBEX_REOPEN.minute())
            }
            Hours::Equities | Hours::Crypto => {
                local_to_timestamp(tz, date + Duration::days(1), 0, 0)
            }
        }
    }

    pub fn session(self, date: NaiveDate) -> Option<TradingSession> {
        if !self.is_trade_date(date) {
            return None;
        }
        let tz = self.tz();
        let at = |d: NaiveDate, c: Clock| local_to_timestamp(tz, d, c.hour(), c.minute());
        match self.hours_kind() {
            Hours::Equities => {
                let early = us_holidays::early_close(date).is_some();
                let (rth_end, post_end) = if early {
                    (Clock::at(13, 0), Clock::at(17, 0))
                } else {
                    (Clock::at(16, 0), Clock::at(20, 0))
                };
                let open = at(date, Clock::at(4, 0));
                let close = at(date, post_end);
                Some(TradingSession {
                    calendar: self,
                    trade_date: date,
                    open,
                    close,
                    segments: vec![SessionWindow {
                        start: open,
                        end: close,
                    }],
                    rth: Some(SessionWindow {
                        start: at(date, Clock::at(9, 30)),
                        end: at(date, rth_end),
                    }),
                    early_close: early,
                })
            }
            Hours::Globex(hours) => {
                let prev = self.prev_trade_date(date);
                let mut segments: Vec<SessionWindow> = Vec::new();
                let mut push = |w: SessionWindow| {
                    if let Some(last) = segments.last_mut()
                        && last.end == w.start
                    {
                        last.end = w.end;
                        return;
                    }
                    segments.push(w);
                };
                let mut c = prev;
                while c <= date {
                    if c > prev
                        && let Some(end) = hours.day_end(c)
                    {
                        push(SessionWindow {
                            start: at(c, Clock::at(0, 0)),
                            end: at(c, end),
                        });
                    }
                    if c < date && hours.reopens_evening_of(c) {
                        push(SessionWindow {
                            start: at(c, GLOBEX_REOPEN),
                            end: at(c + Duration::days(1), Clock::at(0, 0)),
                        });
                    }
                    c += Duration::days(1);
                }
                let open = segments.first()?.start;
                let close = segments.last()?.end;
                Some(TradingSession {
                    calendar: self,
                    trade_date: date,
                    open,
                    close,
                    segments,
                    rth: hours.rth_on(date).map(|(start, end)| SessionWindow {
                        start: at(date, start),
                        end: at(date, end),
                    }),
                    early_close: hours.day_end(date).is_some_and(|end| end < GLOBEX_CLOSE),
                })
            }
            Hours::Crypto => {
                let open = at(date, Clock::at(0, 0));
                let close = at(date + Duration::days(1), Clock::at(0, 0));
                let w = SessionWindow {
                    start: open,
                    end: close,
                };
                Some(TradingSession {
                    calendar: self,
                    trade_date: date,
                    open,
                    close,
                    segments: vec![w],
                    rth: Some(w),
                    early_close: false,
                })
            }
        }
    }

    pub fn session_containing(self, ts: Timestamp) -> Option<TradingSession> {
        let s = self.session(self.trade_date(ts))?;
        s.is_open_at(ts).then_some(s)
    }

    pub fn is_open(self, ts: Timestamp) -> bool {
        self.session_containing(ts).is_some()
    }

    pub fn open_for(self, ts: Timestamp) -> Option<std::time::Duration> {
        let session = self.session_containing(ts)?;
        let opened = session.segments.iter().find(|w| w.contains(ts))?.start;
        u64::try_from(ts.0 - opened.0)
            .ok()
            .map(std::time::Duration::from_nanos)
    }

    pub fn is_rth(self, ts: Timestamp) -> bool {
        self.session(self.trade_date(ts))
            .is_some_and(|s| s.is_rth_at(ts))
    }

    pub fn sessions_between(self, from: NaiveDate, to: NaiveDate) -> Vec<TradingSession> {
        let mut out = Vec::new();
        let mut d = from;
        while d <= to {
            if let Some(s) = self.session(d) {
                out.push(s);
            }
            d += Duration::days(1);
        }
        out
    }

    pub fn last_sessions(self, ts: Timestamp, n: usize) -> Vec<TradingSession> {
        let mut out = Vec::with_capacity(n);
        let mut d = self.trade_date(ts);
        let mut guard = 0;
        while out.len() < n && guard < n * 4 + 14 {
            if let Some(s) = self.session(d)
                && s.open <= ts
            {
                out.push(s);
            }
            d -= Duration::days(1);
            guard += 1;
        }
        out.reverse();
        out
    }

    pub fn bucket_anchor(self, ts: Timestamp) -> Timestamp {
        let tz = self.tz();
        let local = ts.in_tz(tz);
        let date = local.date_naive();
        match self.hours_kind() {
            Hours::Equities => local_to_timestamp(tz, date, 9, 30),
            Hours::Globex(_) => {
                let d = if local.hour() >= GLOBEX_REOPEN.hour() {
                    date
                } else {
                    date - Duration::days(1)
                };
                local_to_timestamp(tz, d, GLOBEX_REOPEN.hour(), GLOBEX_REOPEN.minute())
            }
            Hours::Crypto => local_to_timestamp(tz, date, 0, 0),
        }
    }

    pub fn bucket_start(self, ts: Timestamp, tf: Timeframe) -> Timestamp {
        if tf.is_session() {
            let (first, _) = self.session_group(self.trade_date(ts), tf.sessions());
            return local_to_timestamp(self.tz(), first, 0, 0);
        }
        ts.floor_to(tf.nanos(), self.bucket_anchor(ts))
    }

    pub fn bucket_span(self, ts: Timestamp, tf: Timeframe) -> (Timestamp, Timestamp) {
        let key = self.bucket_start(ts, tf);
        if !tf.is_session() {
            return (key, key.add_nanos(tf.nanos()));
        }
        let (first, last) = self.session_group(self.trade_date(ts), tf.sessions());
        let sessions = self.sessions_between(first, last);
        match (sessions.first(), sessions.last()) {
            (Some(open), Some(close)) => (open.open, close.close),
            _ => (key, key.add_nanos(tf.nanos())),
        }
    }

    pub fn session_group(self, date: NaiveDate, sessions: u32) -> (NaiveDate, NaiveDate) {
        if sessions <= 1 {
            return (date, date);
        }
        let n = i64::from(sessions);
        let first = self.day_slot(date).div_euclid(n) * n;
        (self.slot_date(first), self.slot_date(first + n - 1))
    }

    fn day_slot(self, date: NaiveDate) -> i64 {
        let days = (date - SLOT_EPOCH).num_days();
        match self.hours_kind() {
            Hours::Crypto => days,
            Hours::Equities | Hours::Globex(_) => {
                days.div_euclid(7) * 5 + days.rem_euclid(7).min(4)
            }
        }
    }

    fn slot_date(self, slot: i64) -> NaiveDate {
        let days = match self.hours_kind() {
            Hours::Crypto => slot,
            Hours::Equities | Hours::Globex(_) => slot.div_euclid(5) * 7 + slot.rem_euclid(5),
        };
        SLOT_EPOCH + Duration::days(days)
    }
}

const SLOT_EPOCH: NaiveDate = match NaiveDate::from_ymd_opt(1970, 1, 5) {
    Some(monday) => monday,
    None => panic!("1970-01-05 is a date"),
};

fn weekday_holidays(
    from: NaiveDate,
    to: NaiveDate,
) -> impl Iterator<Item = (NaiveDate, &'static str)> {
    (from.year()..=to.year())
        .flat_map(us_holidays::holidays)
        .filter(move |(d, _)| *d >= from && *d <= to && !us_holidays::is_weekend(*d))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn et(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    #[test]
    fn holidays_2026_match_the_kit_list() {
        let got: Vec<NaiveDate> = us_holidays::holidays(2026)
            .into_iter()
            .map(|(d, _)| d)
            .collect();
        let expected = [
            date(2026, 1, 1),
            date(2026, 1, 19),
            date(2026, 2, 16),
            date(2026, 4, 3),
            date(2026, 5, 25),
            date(2026, 6, 19),
            date(2026, 7, 3),
            date(2026, 9, 7),
            date(2026, 11, 26),
            date(2026, 12, 25),
        ];
        assert_eq!(got, expected);
    }

    #[test]
    fn observance_rules() {
        let h27: Vec<NaiveDate> = us_holidays::holidays(2027)
            .into_iter()
            .map(|(d, _)| d)
            .collect();
        assert!(h27.contains(&date(2027, 7, 5)));
        assert!(h27.contains(&date(2027, 12, 24)));
        assert!(!h27.contains(&date(2027, 12, 31)));
        assert!(
            us_holidays::holidays(2028)
                .iter()
                .all(|(d, _)| *d != date(2027, 12, 31))
        );
        assert_eq!(us_holidays::easter(2026), date(2026, 4, 5));
        assert_eq!(us_holidays::easter(2027), date(2027, 3, 28));
        assert_eq!(us_holidays::easter(2025), date(2025, 4, 20));
    }

    #[test]
    fn early_closes() {
        assert_eq!(
            us_holidays::early_close(date(2026, 11, 27)),
            Some("Day after Thanksgiving")
        );
        assert_eq!(
            us_holidays::early_close(date(2026, 12, 24)),
            Some("Christmas Eve")
        );
        assert_eq!(us_holidays::early_close(date(2026, 7, 3)), None);
        assert_eq!(
            us_holidays::early_close(date(2025, 7, 3)),
            Some("Independence Day eve")
        );
        let s = SessionCalendar::UsEquities
            .session(date(2026, 11, 27))
            .unwrap();
        assert!(s.early_close);
        assert_eq!(s.rth.unwrap().end, et("2026-11-27T13:00:00-05:00"));
    }

    #[test]
    fn us_equities_rth_and_eth() {
        let cal = SessionCalendar::UsEquities;
        let s = cal.session(date(2026, 10, 2)).unwrap();
        assert_eq!(s.open, et("2026-10-02T04:00:00-04:00"));
        assert_eq!(s.close, et("2026-10-02T20:00:00-04:00"));
        assert_eq!(s.rth.unwrap().start, et("2026-10-02T09:30:00-04:00"));
        assert_eq!(s.rth.unwrap().len_nanos() / NANOS_PER_MINUTE, 390);
        assert!(cal.is_rth(et("2026-10-02T14:42:30-04:00")));
        assert!(!cal.is_rth(et("2026-10-02T09:29:59-04:00")));
        assert!(cal.is_open(et("2026-10-02T08:00:00-04:00")));
        assert!(!cal.is_open(et("2026-10-03T12:00:00-04:00")), "Saturday");
        assert!(cal.session(date(2026, 4, 3)).is_none(), "Good Friday");
        let w = cal.session(date(2026, 12, 1)).unwrap();
        assert_eq!(w.rth.unwrap().start, et("2026-12-01T09:30:00-05:00"));
    }

    #[test]
    fn cme_regular_week() {
        let cal = SessionCalendar::CmeEquityIndex;
        let mon = cal.session(date(2026, 10, 5)).unwrap();
        assert_eq!(mon.segments.len(), 1);
        assert_eq!(mon.open, et("2026-10-04T18:00:00-04:00"));
        assert_eq!(mon.close, et("2026-10-05T17:00:00-04:00"));
        assert_eq!(mon.minute_count(), 23 * 60);
        let fri = cal.session(date(2026, 10, 2)).unwrap();
        assert_eq!(fri.open, et("2026-10-01T18:00:00-04:00"));
        assert_eq!(
            cal.trade_date(et("2026-10-01T17:59:00-04:00")),
            date(2026, 10, 1)
        );
        assert_eq!(
            cal.trade_date(et("2026-10-01T18:00:00-04:00")),
            date(2026, 10, 2)
        );
        assert_eq!(
            cal.trade_date(et("2026-10-02T19:00:00-04:00")),
            date(2026, 10, 5)
        );
        assert_eq!(
            cal.trade_date(et("2026-10-04T18:30:00-04:00")),
            date(2026, 10, 5)
        );
        assert!(!cal.is_open(et("2026-10-01T17:30:00-04:00")));
        assert!(cal.is_open(et("2026-10-01T18:00:00-04:00")));
        assert!(!cal.is_open(et("2026-10-03T12:00:00-04:00")), "Saturday");
        assert!(
            !cal.is_open(et("2026-10-04T17:59:00-04:00")),
            "Sunday before open"
        );
        assert!(cal.is_open(et("2026-10-04T18:01:00-04:00")));
    }

    #[test]
    fn open_for_counts_from_the_last_reopen_and_is_none_while_closed() {
        let cal = SessionCalendar::CmeEquityIndex;
        let minutes = |m: u64| Some(std::time::Duration::from_secs(m * 60));
        assert_eq!(
            cal.open_for(et("2026-11-05T17:05:00-05:00")),
            None,
            "daily break"
        );
        assert_eq!(cal.open_for(et("2026-11-05T18:10:00-05:00")), minutes(10));
        assert_eq!(
            cal.open_for(et("2026-11-06T00:10:00-05:00")),
            minutes(6 * 60 + 10)
        );
        assert_eq!(
            cal.open_for(et("2026-11-07T12:00:00-05:00")),
            None,
            "Saturday"
        );
        assert_eq!(cal.open_for(et("2026-11-08T18:01:00-05:00")), minutes(1));
        assert_eq!(
            cal.open_for(et("2026-01-19T14:00:00-05:00")),
            None,
            "MLK halt"
        );
        assert_eq!(
            SessionCalendar::Crypto24x7.open_for(et("2026-11-07T00:00:30Z")),
            Some(std::time::Duration::from_secs(30))
        );
    }

    #[test]
    fn cme_holiday_sessions() {
        let cal = SessionCalendar::CmeEquityIndex;
        let tue = cal.session(date(2026, 1, 20)).unwrap();
        assert_eq!(
            tue.segments,
            vec![
                SessionWindow {
                    start: et("2026-01-18T18:00:00-05:00"),
                    end: et("2026-01-19T13:00:00-05:00")
                },
                SessionWindow {
                    start: et("2026-01-19T18:00:00-05:00"),
                    end: et("2026-01-20T17:00:00-05:00")
                },
            ]
        );
        assert_eq!(
            cal.trade_date(et("2026-01-19T10:00:00-05:00")),
            date(2026, 1, 20)
        );
        assert!(!cal.is_open(et("2026-01-19T14:00:00-05:00")));
        let mon = cal.session(date(2025, 4, 21)).unwrap();
        assert_eq!(mon.open, et("2025-04-20T18:00:00-04:00"));
        assert!(!cal.is_open(et("2025-04-17T19:00:00-04:00")));
        let eve = cal.session(date(2026, 12, 24)).unwrap();
        assert_eq!(eve.close, et("2026-12-24T13:15:00-05:00"));
        assert!(eve.early_close);
        let mon28 = cal.session(date(2026, 12, 28)).unwrap();
        assert_eq!(mon28.open, et("2026-12-27T18:00:00-05:00"));
        let fri = cal.session(date(2026, 11, 27)).unwrap();
        assert_eq!(fri.segments.len(), 2);
        assert_eq!(fri.segments[0].end, et("2026-11-26T13:00:00-05:00"));
        assert_eq!(fri.close, et("2026-11-27T13:15:00-05:00"));
    }

    #[test]
    fn crypto_is_continuous() {
        let cal = SessionCalendar::Crypto24x7;
        let t = et("2026-10-03T12:00:00-04:00");
        assert!(cal.is_open(t));
        assert_eq!(cal.trade_date(t), date(2026, 10, 3));
        assert_eq!(cal.session(date(2026, 10, 3)).unwrap().minute_count(), 1440);
    }

    #[test]
    fn buckets() {
        let eq = SessionCalendar::UsEquities;
        let t = et("2026-10-02T14:42:30-04:00");
        assert_eq!(
            eq.bucket_start(t, Timeframe::M5),
            et("2026-10-02T14:40:00-04:00")
        );
        assert_eq!(
            eq.bucket_start(t, Timeframe::H1),
            et("2026-10-02T14:30:00-04:00")
        );
        assert_eq!(
            eq.bucket_start(t, Timeframe::H4),
            et("2026-10-02T13:30:00-04:00")
        );
        assert_eq!(
            eq.bucket_start(t, Timeframe::D1),
            et("2026-10-02T00:00:00-04:00")
        );
        let cme = SessionCalendar::CmeEquityIndex;
        assert_eq!(
            cme.bucket_start(t, Timeframe::H1),
            et("2026-10-02T14:00:00-04:00")
        );
        assert_eq!(
            cme.bucket_start(t, Timeframe::H4),
            et("2026-10-02T14:00:00-04:00")
        );
        let night = et("2026-10-01T23:10:00-04:00");
        assert_eq!(
            cme.bucket_start(night, Timeframe::H4),
            et("2026-10-01T22:00:00-04:00")
        );
        assert_eq!(
            cme.bucket_start(night, Timeframe::D1),
            et("2026-10-02T00:00:00-04:00")
        );
    }

    #[test]
    fn last_sessions_skip_weekends() {
        let sat = et("2026-10-03T12:00:00-04:00");
        let s = SessionCalendar::UsEquities.last_sessions(sat, 3);
        let dates: Vec<_> = s.iter().map(|s| s.trade_date).collect();
        assert_eq!(
            dates,
            vec![date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)]
        );
        let c = SessionCalendar::CmeEquityIndex.last_sessions(et("2026-10-04T19:00:00-04:00"), 2);
        let dates: Vec<_> = c.iter().map(|s| s.trade_date).collect();
        assert_eq!(dates, vec![date(2026, 10, 2), date(2026, 10, 5)]);
    }

    fn rth(cal: SessionCalendar, d: NaiveDate) -> Option<(Timestamp, Timestamp)> {
        cal.session(d).and_then(|s| s.rth).map(|w| (w.start, w.end))
    }

    fn window(a: &str, b: &str) -> Option<(Timestamp, Timestamp)> {
        Some((et(a), et(b)))
    }

    const FAMILIES: [SessionCalendar; 9] = [
        SessionCalendar::CmeEquityIndex,
        SessionCalendar::CmeInterestRates,
        SessionCalendar::CmeFx,
        SessionCalendar::CmeEnergy,
        SessionCalendar::CmeGold,
        SessionCalendar::CmeSilver,
        SessionCalendar::CmeCopper,
        SessionCalendar::CmePlatinum,
        SessionCalendar::CmeGlobex,
    ];

    #[test]
    fn products_map_to_their_exchange_calendar() {
        let of = SessionCalendar::of_cme_root;
        assert_eq!(of("NQ"), SessionCalendar::CmeEquityIndex);
        assert_eq!(of("mes"), SessionCalendar::CmeEquityIndex);
        assert_eq!(of("YM"), SessionCalendar::CmeEquityIndex);
        assert_eq!(of("ZN"), SessionCalendar::CmeInterestRates);
        assert_eq!(of("UB"), SessionCalendar::CmeInterestRates);
        assert_eq!(of("6E"), SessionCalendar::CmeFx);
        assert_eq!(of("M6E"), SessionCalendar::CmeFx);
        assert_eq!(of("CL"), SessionCalendar::CmeEnergy);
        assert_eq!(of("MCL"), SessionCalendar::CmeEnergy);
        assert_eq!(of("NG"), SessionCalendar::CmeEnergy);
        assert_eq!(of("GC"), SessionCalendar::CmeGold);
        assert_eq!(of("MGC"), SessionCalendar::CmeGold);
        assert_eq!(of("SI"), SessionCalendar::CmeSilver);
        assert_eq!(of("HG"), SessionCalendar::CmeCopper);
        assert_eq!(of("PL"), SessionCalendar::CmePlatinum);
        assert_eq!(of("LE"), SessionCalendar::CmeGlobex);
        assert_eq!(rth(of("LE"), date(2026, 10, 5)), None);
    }

    #[test]
    fn every_cme_family_trades_the_globex_week_with_its_own_rth() {
        let mon = date(2026, 10, 5);
        for cal in FAMILIES {
            let s = cal.session(mon).unwrap();
            assert_eq!(s.open, et("2026-10-04T18:00:00-04:00"), "{cal:?}");
            assert_eq!(s.close, et("2026-10-05T17:00:00-04:00"), "{cal:?}");
            assert_eq!(s.minute_count(), 23 * 60, "{cal:?}");
            assert!(!s.early_close, "{cal:?}");
            assert_eq!(
                cal.trade_date(et("2026-10-05T18:00:00-04:00")),
                date(2026, 10, 6)
            );
        }
        let rth_on_monday = [
            (SessionCalendar::CmeEquityIndex, "09:30", "16:00"),
            (SessionCalendar::CmeInterestRates, "08:20", "15:00"),
            (SessionCalendar::CmeFx, "08:20", "15:00"),
            (SessionCalendar::CmeEnergy, "09:00", "14:30"),
            (SessionCalendar::CmeGold, "08:20", "13:30"),
            (SessionCalendar::CmeSilver, "08:25", "13:25"),
            (SessionCalendar::CmeCopper, "08:10", "13:00"),
            (SessionCalendar::CmePlatinum, "08:20", "13:05"),
        ];
        for (cal, start, end) in rth_on_monday {
            assert_eq!(
                rth(cal, mon),
                window(
                    &format!("2026-10-05T{start}:00-04:00"),
                    &format!("2026-10-05T{end}:00-04:00")
                ),
                "{cal:?}"
            );
        }
        assert_eq!(rth(SessionCalendar::CmeGlobex, mon), None);
        assert!(SessionCalendar::CmeEnergy.is_rth(et("2026-10-05T09:00:00-04:00")));
        assert!(!SessionCalendar::CmeEnergy.is_rth(et("2026-10-05T14:30:00-04:00")));
        assert!(SessionCalendar::CmeEquityIndex.is_rth(et("2026-10-05T14:30:00-04:00")));
        assert!(!SessionCalendar::CmeGlobex.is_rth(et("2026-10-05T12:00:00-04:00")));
    }

    #[test]
    fn rth_keeps_its_new_york_hours_across_the_dst_change() {
        let fri = date(2026, 10, 30);
        let mon = date(2026, 11, 2);
        for cal in FAMILIES {
            let after = cal.session(mon).unwrap();
            assert_eq!(after.open, et("2026-11-01T18:00:00-05:00"), "{cal:?}");
            assert_eq!(after.minute_count(), 23 * 60, "{cal:?}");
        }
        assert_eq!(
            rth(SessionCalendar::CmeEnergy, fri).map(|w| w.0),
            Some(et("2026-10-30T13:00:00Z"))
        );
        assert_eq!(
            rth(SessionCalendar::CmeEnergy, mon).map(|w| w.0),
            Some(et("2026-11-02T14:00:00Z"))
        );
        assert_eq!(
            rth(SessionCalendar::CmeGold, mon),
            window("2026-11-02T13:20:00Z", "2026-11-02T18:30:00Z")
        );
        assert_eq!(
            rth(SessionCalendar::CmeInterestRates, date(2026, 3, 9)),
            window("2026-03-09T12:20:00Z", "2026-03-09T19:00:00Z")
        );
        assert_eq!(
            rth(SessionCalendar::CmeInterestRates, date(2026, 3, 6)),
            window("2026-03-06T13:20:00Z", "2026-03-06T20:00:00Z")
        );
        let spring = SessionCalendar::CmeFx.session(date(2026, 3, 9)).unwrap();
        assert_eq!(spring.open, et("2026-03-08T22:00:00Z"));
        assert_eq!(spring.minute_count(), 23 * 60);
    }

    #[test]
    fn a_holiday_halts_each_family_at_its_own_hour_for_the_next_trade_date() {
        let thanksgiving = date(2026, 11, 26);
        let friday = date(2026, 11, 27);
        let halt = |cal: SessionCalendar| cal.session(friday).unwrap().segments[0].end;
        let at = |t: &str| et(&format!("2026-11-26T{t}:00-05:00"));
        assert_eq!(halt(SessionCalendar::CmeEquityIndex), at("13:00"));
        assert_eq!(halt(SessionCalendar::CmeInterestRates), at("13:00"));
        assert_eq!(halt(SessionCalendar::CmeFx), at("17:00"));
        assert_eq!(halt(SessionCalendar::CmeEnergy), at("14:30"));
        assert_eq!(halt(SessionCalendar::CmeGold), at("14:30"));
        assert_eq!(halt(SessionCalendar::CmeCopper), at("14:30"));
        for cal in FAMILIES {
            assert!(cal.session(thanksgiving).is_none(), "{cal:?}");
            assert_eq!(cal.trade_date(at("10:00")), friday, "{cal:?}");
            assert!(
                cal.session(date(2025, 4, 18)).is_none(),
                "Good Friday 2025 {cal:?}"
            );
        }
        let mlk = SessionCalendar::CmeInterestRates
            .session(date(2026, 1, 20))
            .unwrap();
        assert_eq!(mlk.segments[0].end, et("2026-01-19T13:00:00-05:00"));
        assert_eq!(mlk.segments[1].start, et("2026-01-19T18:00:00-05:00"));
        let mlk_energy = SessionCalendar::CmeEnergy
            .session(date(2026, 1, 20))
            .unwrap();
        assert_eq!(mlk_energy.segments[0].end, et("2026-01-19T14:30:00-05:00"));
    }

    #[test]
    fn a_friday_holiday_halts_every_family_at_one_for_monday() {
        let monday = date(2026, 7, 6);
        for cal in FAMILIES {
            assert!(cal.session(date(2026, 7, 3)).is_none(), "{cal:?}");
            let s = cal.session(monday).unwrap();
            assert_eq!(
                s.segments[0],
                SessionWindow {
                    start: et("2026-07-02T18:00:00-04:00"),
                    end: et("2026-07-03T13:00:00-04:00"),
                },
                "{cal:?}"
            );
            assert_eq!(
                s.segments[1].start,
                et("2026-07-05T18:00:00-04:00"),
                "{cal:?}"
            );
        }
    }

    #[test]
    fn early_close_days_close_and_settle_at_each_familys_hours() {
        let friday = date(2026, 11, 27);
        let eve = date(2026, 12, 24);
        let close = |cal: SessionCalendar, d: NaiveDate| cal.session(d).unwrap().close;
        let rth_end = |cal: SessionCalendar, d: NaiveDate| rth(cal, d).map(|w| w.1);
        let at = |d: &str, t: &str| et(&format!("2026-{d}T{t}:00-05:00"));
        let cases = [
            (
                SessionCalendar::CmeEquityIndex,
                "13:15",
                "13:00",
                "13:15",
                "13:00",
            ),
            (
                SessionCalendar::CmeInterestRates,
                "13:15",
                "13:00",
                "13:15",
                "13:00",
            ),
            (SessionCalendar::CmeFx, "14:45", "13:00", "13:45", "13:00"),
            (
                SessionCalendar::CmeEnergy,
                "14:45",
                "14:30",
                "13:45",
                "13:30",
            ),
            (SessionCalendar::CmeGold, "14:45", "13:30", "13:45", "12:30"),
            (
                SessionCalendar::CmeSilver,
                "14:45",
                "13:25",
                "13:45",
                "12:25",
            ),
            (
                SessionCalendar::CmeCopper,
                "14:45",
                "13:00",
                "13:45",
                "12:00",
            ),
            (
                SessionCalendar::CmePlatinum,
                "14:45",
                "13:05",
                "13:45",
                "12:05",
            ),
        ];
        for (cal, fri_close, fri_rth, eve_close, eve_rth) in cases {
            assert_eq!(close(cal, friday), at("11-27", fri_close), "{cal:?}");
            assert_eq!(rth_end(cal, friday), Some(at("11-27", fri_rth)), "{cal:?}");
            assert_eq!(close(cal, eve), at("12-24", eve_close), "{cal:?}");
            assert_eq!(rth_end(cal, eve), Some(at("12-24", eve_rth)), "{cal:?}");
            assert!(cal.session(friday).unwrap().early_close, "{cal:?}");
            assert!(cal.session(date(2026, 12, 25)).is_none(), "{cal:?}");
            assert_eq!(
                cal.session(date(2026, 12, 28)).unwrap().open,
                et("2026-12-27T18:00:00-05:00"),
                "{cal:?}"
            );
        }
        let july_3 = date(2025, 7, 3);
        let at_july = |t: &str| et(&format!("2025-07-03T{t}:00-04:00"));
        assert_eq!(
            close(SessionCalendar::CmeEquityIndex, july_3),
            at_july("13:15")
        );
        assert_eq!(
            close(SessionCalendar::CmeInterestRates, july_3),
            at_july("17:00")
        );
        assert_eq!(
            rth_end(SessionCalendar::CmeInterestRates, july_3),
            Some(at_july("13:00"))
        );
        assert_eq!(close(SessionCalendar::CmeEnergy, july_3), at_july("17:00"));
        assert_eq!(
            rth_end(SessionCalendar::CmeEnergy, july_3),
            Some(at_july("14:30"))
        );
        assert!(
            !SessionCalendar::CmeEnergy
                .session(july_3)
                .unwrap()
                .early_close
        );
    }

    #[test]
    fn good_friday_2026_traded_short_where_cme_opened_it() {
        let good_friday = date(2026, 4, 3);
        let monday = date(2026, 4, 6);
        let rates = SessionCalendar::CmeInterestRates
            .session(good_friday)
            .unwrap();
        assert_eq!(rates.open, et("2026-04-02T18:00:00-04:00"));
        assert_eq!(rates.close, et("2026-04-03T11:15:00-04:00"));
        assert_eq!(
            rates.rth.map(|w| (w.start, w.end)),
            window("2026-04-03T08:20:00-04:00", "2026-04-03T11:15:00-04:00")
        );
        assert!(SessionCalendar::CmeFx.session(good_friday).is_some());
        let equity = SessionCalendar::CmeEquityIndex;
        assert!(equity.session(good_friday).is_none());
        assert_eq!(
            equity.session(monday).unwrap().segments[0],
            SessionWindow {
                start: et("2026-04-02T18:00:00-04:00"),
                end: et("2026-04-03T09:15:00-04:00"),
            }
        );
        assert_eq!(equity.trade_date(et("2026-04-03T08:00:00-04:00")), monday);
        for cal in [SessionCalendar::CmeEnergy, SessionCalendar::CmeGold] {
            assert!(cal.session(good_friday).is_none(), "{cal:?}");
            assert_eq!(
                cal.session(monday).unwrap().open,
                et("2026-04-05T18:00:00-04:00"),
                "{cal:?}"
            );
            assert!(!cal.is_open(et("2026-04-02T19:00:00-04:00")), "{cal:?}");
        }
    }

    #[test]
    fn holidays_name_the_day_and_when_trading_stops() {
        let got =
            SessionCalendar::CmeEnergy.holidays_between(date(2026, 11, 1), date(2026, 12, 31));
        assert_eq!(
            got,
            vec![
                MarketHoliday {
                    date: date(2026, 11, 26),
                    name: "Thanksgiving Day".into(),
                    halt: Some(et("2026-11-26T14:30:00-05:00")),
                },
                MarketHoliday {
                    date: date(2026, 12, 25),
                    name: "Christmas Day".into(),
                    halt: None,
                },
            ]
        );
        let april =
            |cal: SessionCalendar| cal.holidays_between(date(2026, 4, 1), date(2026, 4, 30));
        assert!(april(SessionCalendar::CmeInterestRates).is_empty());
        assert_eq!(
            april(SessionCalendar::CmeEquityIndex)[0].halt,
            Some(et("2026-04-03T09:15:00-04:00"))
        );
        assert_eq!(april(SessionCalendar::CmeEnergy)[0].halt, None);
        let july =
            SessionCalendar::UsEquities.holidays_between(date(2027, 7, 1), date(2027, 7, 31));
        assert_eq!(july.len(), 1);
        assert_eq!(july[0].date, date(2027, 7, 5));
        assert_eq!(july[0].halt, None);
        assert!(
            SessionCalendar::Crypto24x7
                .holidays_between(date(2026, 1, 1), date(2026, 12, 31))
                .is_empty()
        );
    }

    #[test]
    fn hours_describe_each_calendar() {
        let energy = SessionCalendar::CmeEnergy.hours();
        assert_eq!(energy.market, "NYMEX energy");
        assert_eq!(energy.tz, "America/New_York");
        assert_eq!(energy.days, "Sun–Fri");
        assert_eq!(
            (energy.opens.as_str(), energy.closes.as_str()),
            ("18:00", "17:00")
        );
        assert!(energy.opens_day_before);
        assert_eq!(
            energy.rth,
            Some(ClockWindow {
                start: "09:00".into(),
                end: "14:30".into()
            })
        );
        assert_eq!(SessionCalendar::CmeGlobex.hours().rth, None);
        let eq = SessionCalendar::UsEquities.hours();
        assert_eq!((eq.opens.as_str(), eq.closes.as_str()), ("04:00", "20:00"));
        assert!(!eq.opens_day_before);
        for cal in SessionCalendar::ALL {
            assert_eq!(cal.hours().calendar, cal);
        }
    }

    #[test]
    fn a_trade_date_ends_where_the_next_one_starts() {
        for cal in SessionCalendar::ALL {
            for d in [date(2026, 10, 2), date(2026, 11, 27), date(2026, 3, 6)] {
                let end = cal.trade_date_end(d);
                assert_eq!(cal.trade_date(Timestamp(end.0 - 1)), d, "{cal:?} {d}");
                assert_ne!(cal.trade_date(end), d, "{cal:?} {d}");
            }
        }
    }

    #[test]
    fn multi_session_bars_group_trading_days_from_a_fixed_start() {
        let cal = SessionCalendar::CmeEquityIndex;
        let two = Timeframe::new(2, crate::timeframe::TimeUnit::Day).unwrap();
        let mut per_bar: std::collections::BTreeMap<NaiveDate, usize> = Default::default();
        for d in (5..=23)
            .map(|d| date(2026, 10, d))
            .filter(|d| cal.is_trade_date(*d))
        {
            *per_bar.entry(cal.session_group(d, 2).0).or_default() += 1;
        }
        let counts: Vec<usize> = per_bar.values().copied().collect();
        assert!(counts.len() >= 7);
        assert!(
            counts[1..counts.len() - 1].iter().all(|&n| n == 2),
            "{per_bar:?}"
        );
        let thu_evening = et("2026-10-07T19:00:00-04:00");
        let (open, close) = cal.bucket_span(thu_evening, two);
        let (first, last) = cal.session_group(cal.trade_date(thu_evening), 2);
        assert_eq!(open, cal.session(first).unwrap().open);
        assert_eq!(close, cal.session(last).unwrap().close);
        assert_eq!(
            cal.bucket_start(thu_evening, two),
            local_to_timestamp(cal.tz(), first, 0, 0)
        );
        let crypto = SessionCalendar::Crypto24x7;
        let sat = date(2026, 10, 10);
        let (a, b) = crypto.session_group(sat, 7);
        assert_eq!((b - a).num_days(), 6);
        assert!(a <= sat && sat <= b);
        assert_eq!(
            cal.session_group(date(2026, 10, 7), 1),
            (date(2026, 10, 7), date(2026, 10, 7))
        );
    }
}
