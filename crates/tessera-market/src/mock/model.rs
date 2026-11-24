use chrono::{NaiveDate, Timelike};
use tessera_core::Timestamp;
use tessera_core::session::{SessionCalendar, TradingSession};
use tessera_core::time::NANOS_PER_MINUTE;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DriverId {
    Nq,
    Es,
    Btc,
    Eth,
    Nvda,
    Aapl,
    Tsla,
}

#[derive(Clone, Copy, Debug)]
pub struct DriverSpec {
    pub id: DriverId,
    pub stream: u64,
    pub calendar: SessionCalendar,
    pub rth_only: bool,
    pub sigma_annual: f64,
    pub corr: Option<(DriverId, f64)>,
    pub beta: Option<(DriverId, f64)>,
    pub anchor: f64,
}

pub const DRIVERS: [DriverSpec; 7] = [
    DriverSpec {
        id: DriverId::Nq,
        stream: 101,
        calendar: SessionCalendar::CmeEquityIndex,
        rth_only: false,
        sigma_annual: 0.22,
        corr: None,
        beta: None,
        anchor: 20641.25,
    },
    DriverSpec {
        id: DriverId::Es,
        stream: 102,
        calendar: SessionCalendar::CmeEquityIndex,
        rth_only: false,
        sigma_annual: 0.17,
        corr: Some((DriverId::Nq, 0.9)),
        beta: None,
        anchor: 5583.25,
    },
    DriverSpec {
        id: DriverId::Btc,
        stream: 103,
        calendar: SessionCalendar::Crypto24x7,
        rth_only: false,
        sigma_annual: 0.50,
        corr: None,
        beta: None,
        anchor: 98412.00,
    },
    DriverSpec {
        id: DriverId::Eth,
        stream: 104,
        calendar: SessionCalendar::Crypto24x7,
        rth_only: false,
        sigma_annual: 0.65,
        corr: Some((DriverId::Btc, 0.75)),
        beta: None,
        anchor: 3650.00,
    },
    DriverSpec {
        id: DriverId::Nvda,
        stream: 105,
        calendar: SessionCalendar::UsEquities,
        rth_only: true,
        sigma_annual: 0.38,
        corr: None,
        beta: Some((DriverId::Nq, 1.6)),
        anchor: 178.42,
    },
    DriverSpec {
        id: DriverId::Aapl,
        stream: 106,
        calendar: SessionCalendar::UsEquities,
        rth_only: true,
        sigma_annual: 0.18,
        corr: None,
        beta: Some((DriverId::Nq, 0.9)),
        anchor: 231.64,
    },
    DriverSpec {
        id: DriverId::Tsla,
        stream: 107,
        calendar: SessionCalendar::UsEquities,
        rth_only: true,
        sigma_annual: 0.50,
        corr: None,
        beta: Some((DriverId::Nq, 1.4)),
        anchor: 246.18,
    },
];

pub fn driver(id: DriverId) -> &'static DriverSpec {
    DRIVERS
        .iter()
        .find(|d| d.id == id)
        .expect("every driver id has a spec")
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PriceMap {
    Identity,
    Scale(f64),
    AnchoredRatio,
}

#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub key: &'static str,
    pub driver: DriverId,
    pub map: PriceMap,
    pub anchor: f64,
    pub rth_only: bool,
    pub daily_volume: f64,
    pub overnight_share: f64,
    pub spread_ticks: i64,
    pub book_size: f64,
    pub trade_size: f64,
    pub qty_decimals: u32,
    pub index: bool,
    pub book_step: i64,
    pub book_rounds: [i64; 3],
}

const fn profile(key: &'static str, driver: DriverId, map: PriceMap, anchor: f64) -> Profile {
    Profile {
        key,
        driver,
        map,
        anchor,
        rth_only: false,
        daily_volume: 0.0,
        overnight_share: 0.0,
        spread_ticks: 1,
        book_size: 10.0,
        trade_size: 1.0,
        qty_decimals: 0,
        index: false,
        book_step: 1,
        book_rounds: [10, 50, 100],
    }
}

const FUTURES_ROUNDS: [i64; 3] = [20, 100, 400];

pub const DEFERRED_CARRY: f64 = 1.0108;

pub const PROFILES: [Profile; 16] = [
    Profile {
        rth_only: true,
        daily_volume: 44.0e6,
        book_size: 1000.0,
        trade_size: 180.0,
        ..profile("QQQ", DriverId::Nq, PriceMap::AnchoredRatio, 487.85)
    },
    Profile {
        rth_only: true,
        index: true,
        ..profile("NDX", DriverId::Nq, PriceMap::AnchoredRatio, 20598.40)
    },
    Profile {
        rth_only: true,
        daily_volume: 58.0e6,
        book_size: 1500.0,
        trade_size: 200.0,
        ..profile("SPY", DriverId::Es, PriceMap::AnchoredRatio, 551.92)
    },
    Profile {
        rth_only: true,
        daily_volume: 190.0e6,
        book_size: 1200.0,
        trade_size: 160.0,
        ..profile("NVDA", DriverId::Nvda, PriceMap::Identity, 0.0)
    },
    Profile {
        rth_only: true,
        daily_volume: 52.0e6,
        book_size: 600.0,
        trade_size: 120.0,
        ..profile("AAPL", DriverId::Aapl, PriceMap::Identity, 0.0)
    },
    Profile {
        rth_only: true,
        daily_volume: 95.0e6,
        spread_ticks: 2,
        book_size: 400.0,
        trade_size: 140.0,
        ..profile("TSLA", DriverId::Tsla, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 530.0e3,
        overnight_share: 0.315,
        book_rounds: FUTURES_ROUNDS,
        book_size: 12.0,
        trade_size: 2.0,
        ..profile("NQ@0", DriverId::Nq, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 9.0e3,
        overnight_share: 0.25,
        book_rounds: FUTURES_ROUNDS,
        spread_ticks: 2,
        book_size: 3.0,
        trade_size: 1.0,
        ..profile("NQ@1", DriverId::Nq, PriceMap::Scale(DEFERRED_CARRY), 0.0)
    },
    Profile {
        daily_volume: 1.4e6,
        overnight_share: 0.3,
        book_rounds: FUTURES_ROUNDS,
        book_size: 40.0,
        trade_size: 3.0,
        ..profile("MNQ@0", DriverId::Nq, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 20.0e3,
        overnight_share: 0.25,
        book_rounds: FUTURES_ROUNDS,
        spread_ticks: 2,
        book_size: 8.0,
        trade_size: 2.0,
        ..profile("MNQ@1", DriverId::Nq, PriceMap::Scale(DEFERRED_CARRY), 0.0)
    },
    Profile {
        daily_volume: 1.3e6,
        overnight_share: 0.3,
        book_rounds: FUTURES_ROUNDS,
        book_size: 45.0,
        trade_size: 4.0,
        ..profile("ES@0", DriverId::Es, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 15.0e3,
        overnight_share: 0.25,
        book_rounds: FUTURES_ROUNDS,
        spread_ticks: 2,
        book_size: 10.0,
        trade_size: 2.0,
        ..profile(
            "ES@1",
            DriverId::Es,
            PriceMap::Scale(DEFERRED_CARRY * 0.9995),
            0.0,
        )
    },
    Profile {
        daily_volume: 1.1e6,
        overnight_share: 0.3,
        book_rounds: FUTURES_ROUNDS,
        book_size: 35.0,
        trade_size: 3.0,
        ..profile("MES@0", DriverId::Es, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 12.0e3,
        overnight_share: 0.25,
        book_rounds: FUTURES_ROUNDS,
        spread_ticks: 2,
        book_size: 9.0,
        trade_size: 2.0,
        ..profile(
            "MES@1",
            DriverId::Es,
            PriceMap::Scale(DEFERRED_CARRY * 0.9995),
            0.0,
        )
    },
    Profile {
        daily_volume: 14.0e3,
        qty_decimals: 4,
        book_size: 0.8,
        trade_size: 0.05,
        book_step: 500,
        book_rounds: [10, 20, 100],
        ..profile("BTC-USD", DriverId::Btc, PriceMap::Identity, 0.0)
    },
    Profile {
        daily_volume: 160.0e3,
        qty_decimals: 4,
        book_size: 9.0,
        trade_size: 0.6,
        book_step: 25,
        book_rounds: [10, 20, 100],
        ..profile("ETH-USD", DriverId::Eth, PriceMap::Identity, 0.0)
    },
];

/// US DST changes happen at 02:00 on Sundays, when both are closed.
fn local_minute(calendar: SessionCalendar, session: Option<&TradingSession>, t: Timestamp) -> u32 {
    const DAY: i64 = 24 * 60;
    match (calendar, session) {
        (SessionCalendar::Crypto24x7, _) => t.0.div_euclid(NANOS_PER_MINUTE).rem_euclid(DAY) as u32,
        (SessionCalendar::CmeEquityIndex, Some(s)) => {
            (18 * 60 + (t.0 - s.open.0).div_euclid(NANOS_PER_MINUTE)).rem_euclid(DAY) as u32
        }
        (SessionCalendar::UsEquities, Some(s)) => {
            (4 * 60 + (t.0 - s.open.0).div_euclid(NANOS_PER_MINUTE)).rem_euclid(DAY) as u32
        }
        _ => {
            let l = t.in_tz(calendar.tz());
            l.hour() * 60 + l.minute()
        }
    }
}

struct RthPosition {
    minutes_since_open: f64,
    length_minutes: f64,
}

fn rth_position(session: &TradingSession, t: Timestamp) -> Option<RthPosition> {
    let rth = session.rth?;
    rth.contains(t).then(|| RthPosition {
        minutes_since_open: ((t.0 - rth.start.0) / NANOS_PER_MINUTE) as f64,
        length_minutes: (rth.len_nanos() / NANOS_PER_MINUTE) as f64,
    })
}

const LONDON_MORNING_ET: std::ops::Range<u32> = 3 * 60..5 * 60;
const US_DATA_RELEASES_ET: std::ops::Range<u32> = 8 * 60 + 30..9 * 60 + 30;
const US_HOURS_UTC: std::ops::Range<u32> = 13 * 60 + 30..21 * 60;

pub fn vol_shape(calendar: SessionCalendar, session: Option<&TradingSession>, t: Timestamp) -> f64 {
    if calendar == SessionCalendar::Crypto24x7 {
        let m = local_minute(calendar, None, t);
        return 0.85 + if US_HOURS_UTC.contains(&m) { 0.35 } else { 0.0 };
    }
    let owned;
    let session = match session {
        Some(s) => Some(s),
        None => {
            owned = calendar.session(calendar.trade_date(t));
            owned.as_ref()
        }
    };
    match session.and_then(|s| rth_position(s, t)) {
        Some(RthPosition {
            minutes_since_open: k,
            length_minutes: n,
        }) => 0.75 + 1.1 * (-k / 20.0).exp() + 0.35 * (-(n - 1.0 - k) / 25.0).exp(),
        None => {
            let m = local_minute(calendar, session, t);
            let bump = if LONDON_MORNING_ET.contains(&m) {
                1.6
            } else if US_DATA_RELEASES_ET.contains(&m) {
                1.8
            } else {
                1.0
            };
            0.32 * bump
        }
    }
}

pub fn volume_shape(
    calendar: SessionCalendar,
    session: Option<&TradingSession>,
    t: Timestamp,
) -> (f64, bool) {
    if calendar == SessionCalendar::Crypto24x7 {
        let m = local_minute(calendar, None, t);
        return (
            1.0 + if US_HOURS_UTC.contains(&m) { 0.6 } else { 0.0 },
            true,
        );
    }
    let owned;
    let session = match session {
        Some(s) => Some(s),
        None => {
            owned = calendar.session(calendar.trade_date(t));
            owned.as_ref()
        }
    };
    match session.and_then(|s| rth_position(s, t)) {
        Some(RthPosition {
            minutes_since_open: k,
            length_minutes: n,
        }) => (
            1.0 + 2.4 * (-k / 15.0).exp() + 1.5 * (-(n - 1.0 - k) / 20.0).exp(),
            true,
        ),
        None => {
            let m = local_minute(calendar, session, t);
            let w = if LONDON_MORNING_ET.contains(&m) {
                2.5
            } else if US_DATA_RELEASES_ET.contains(&m) {
                3.0
            } else {
                1.0
            };
            (w, false)
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct VolumeNorm {
    pub rth_sum: f64,
    pub overnight_sum: f64,
    pub vol_norm: f64,
}

impl VolumeNorm {
    pub fn measure(calendar: SessionCalendar, rth_only: bool) -> Self {
        let date = NaiveDate::from_ymd_opt(2026, 10, 6).expect("valid date");
        let session = calendar.session(date).expect("reference session exists");
        let mut rth_sum = 0.0;
        let mut overnight_sum = 0.0;
        let mut var = 0.0;
        for t in session.minutes() {
            let in_rth = calendar == SessionCalendar::Crypto24x7 || session.is_rth_at(t);
            if rth_only && !in_rth {
                continue;
            }
            let (w, _) = volume_shape(calendar, Some(&session), t);
            if in_rth {
                rth_sum += w;
            } else {
                overnight_sum += w;
            }
            var += vol_shape(calendar, Some(&session), t).powi(2);
        }
        Self {
            rth_sum,
            overnight_sum,
            vol_norm: var.sqrt(),
        }
    }
}

pub fn periods_per_year(calendar: SessionCalendar) -> f64 {
    match calendar {
        SessionCalendar::Crypto24x7 => 365.0,
        _ => 252.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_are_u_shaped() {
        let cal = SessionCalendar::UsEquities;
        let open = Timestamp::parse("2026-10-06T09:30:00-04:00").unwrap();
        let mid = Timestamp::parse("2026-10-06T12:30:00-04:00").unwrap();
        let close = Timestamp::parse("2026-10-06T15:59:00-04:00").unwrap();
        assert!(volume_shape(cal, None, open).0 > 2.0 * volume_shape(cal, None, mid).0);
        assert!(volume_shape(cal, None, close).0 > 1.5 * volume_shape(cal, None, mid).0);
        assert!(vol_shape(cal, None, open) > vol_shape(cal, None, mid));
        let cme = SessionCalendar::CmeEquityIndex;
        let night = Timestamp::parse("2026-10-05T23:00:00-04:00").unwrap();
        assert!(vol_shape(cme, None, night) < vol_shape(cme, None, mid));
        let n = VolumeNorm::measure(cme, false);
        assert!(n.rth_sum > 0.0 && n.overnight_sum > n.rth_sum, "{n:?}");
        let e = VolumeNorm::measure(cal, true);
        assert_eq!(e.overnight_sum, 0.0);
    }

    #[test]
    fn every_driver_follows_drivers_listed_before_it() {
        for (i, d) in DRIVERS.iter().enumerate() {
            for (followed, _) in d.corr.into_iter().chain(d.beta) {
                assert!(
                    DRIVERS[..i].iter().any(|e| e.id == followed),
                    "{:?} follows {followed:?}, which must come first",
                    d.id
                );
            }
        }
    }

    #[test]
    fn tables_are_consistent() {
        for d in DRIVERS {
            let listed = DRIVERS.iter().filter(|e| e.id == d.id).count();
            assert_eq!(listed, 1, "{:?} is listed once", d.id);
        }
        for p in PROFILES {
            if p.map == PriceMap::AnchoredRatio {
                assert!(p.anchor > 0.0, "{}", p.key);
            }
            assert!(p.index || p.daily_volume > 0.0, "{}", p.key);
        }
    }
}
