use chrono::NaiveDate;
use tessera_core::Timestamp;
use tessera_core::market::Aggressor;
use tessera_core::session::{SessionCalendar, TradingSession};
use tessera_core::time::{NANOS_PER_MINUTE, local_to_timestamp};

use super::model::{
    DriverSpec, PriceMap, Profile, VolumeNorm, driver, periods_per_year, vol_shape, volume_shape,
};
use crate::rng::{SplitMix, hash3, normal};

const STREAM_HIGH: u64 = 3;
const STREAM_LOW: u64 = 4;
const STREAM_REGIME: u64 = 7;
const STREAM_GAP: u64 = 9;
const STREAM_DAILY: u64 = 11;
const STREAM_DAILY_GAP: u64 = 12;
const STREAM_DAILY_RANGE: u64 = 13;
const STREAM_ACTIVITY: u64 = 21;
const STREAM_FLOW: u64 = 22;
const STREAM_TAPE: u64 = 23;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DriverBar {
    pub t: i64,
    pub log_open: f64,
    pub log_high: f64,
    pub log_low: f64,
    pub log_close: f64,
    pub z: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScenarioBar {
    pub t: Timestamp,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
}

#[derive(Clone, Debug, Default)]
pub struct DriverPath {
    pub minutes: Vec<DriverBar>,
    pub daily: Vec<DriverBar>,
    pub sessions: Vec<TradingSession>,
    pub session_of: Vec<u32>,
}

impl DriverPath {
    pub fn session_at(&self, i: usize) -> Option<&TradingSession> {
        self.session_of
            .get(i)
            .and_then(|&k| self.sessions.get(k as usize))
    }

    pub fn index_at_or_before(&self, t: i64) -> Option<usize> {
        match self.minutes.binary_search_by_key(&t, |b| b.t) {
            Ok(i) => Some(i),
            Err(0) => None,
            Err(i) => Some(i - 1),
        }
    }

    pub fn at_or_before(&self, t: i64) -> Option<&DriverBar> {
        self.index_at_or_before(t).map(|i| &self.minutes[i])
    }
}

pub fn day_index(date: NaiveDate) -> i64 {
    i64::from(chrono::Datelike::num_days_from_ce(&date))
}

pub fn regime(seed: u64, stream: u64, date: NaiveDate) -> f64 {
    (0.25 * normal(seed, stream + STREAM_REGIME, day_index(date)) - 0.03).exp()
}

#[derive(Clone, Copy, Debug)]
pub struct DriverVol {
    pub sigma_daily: f64,
    pub sigma_base: f64,
}

impl DriverVol {
    pub fn of(spec: &DriverSpec) -> Self {
        let sigma_daily = spec.sigma_annual / periods_per_year(spec.calendar).sqrt();
        let norm = VolumeNorm::measure(spec.calendar, spec.rth_only).vol_norm;
        Self {
            sigma_daily,
            sigma_base: sigma_daily / norm.max(1e-9),
        }
    }

    pub fn minute_sigma(
        &self,
        seed: u64,
        spec: &DriverSpec,
        session: Option<&TradingSession>,
        t: Timestamp,
    ) -> f64 {
        let date = session.map_or_else(|| spec.calendar.trade_date(t), |s| s.trade_date);
        self.sigma_base * vol_shape(spec.calendar, session, t) * regime(seed, spec.stream, date)
    }
}

pub fn minute_shock(seed: u64, spec: &DriverSpec, m: i64) -> f64 {
    let own = normal(seed, spec.stream, m);
    match spec.corr {
        Some((other, rho)) => {
            rho * normal(seed, driver(other).stream, m) + (1.0 - rho * rho).sqrt() * own
        }
        None => own,
    }
}

pub fn minute_index(t: i64) -> i64 {
    t.div_euclid(NANOS_PER_MINUTE)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridMinute {
    pub t: i64,
    pub session: u32,
}

pub fn minute_grid(
    spec: &DriverSpec,
    sessions: &[TradingSession],
    end: Timestamp,
) -> Vec<GridMinute> {
    let mut out = Vec::new();
    for (k, s) in sessions.iter().enumerate() {
        for t in s.minutes() {
            if t.0 + NANOS_PER_MINUTE > end.0 {
                break;
            }
            if spec.rth_only && !s.is_rth_at(t) {
                continue;
            }
            out.push(GridMinute {
                t: t.0,
                session: k as u32,
            });
        }
    }
    out
}

pub fn window_sessions(calendar: SessionCalendar, end: Timestamp, n: usize) -> Vec<TradingSession> {
    calendar.last_sessions(end, n)
}

fn half_normal(seed: u64, stream: u64, m: i64) -> f64 {
    normal(seed, stream, m).abs()
}

pub fn generate_driver(
    seed: u64,
    spec: &DriverSpec,
    end: Timestamp,
    intraday_sessions: usize,
    daily_sessions: usize,
    market: Option<&DriverPath>,
) -> DriverPath {
    let vol = DriverVol::of(spec);
    let sessions = window_sessions(spec.calendar, end, intraday_sessions);
    let cells = minute_grid(spec, &sessions, end);
    let grid: Vec<i64> = cells.iter().map(|c| c.t).collect();
    let n = grid.len();
    let mut path = DriverPath::default();
    if n == 0 {
        return path;
    }

    let mut sig = Vec::with_capacity(n);
    let mut own = Vec::with_capacity(n);
    let mut gap = vec![0.0; n];
    let mut prev_date: Option<NaiveDate> = None;
    for (i, &GridMinute { t, session }) in cells.iter().enumerate() {
        let ts = Timestamp(t);
        let session = &sessions[session as usize];
        let s = vol.minute_sigma(seed, spec, Some(session), ts);
        own.push(s * minute_shock(seed, spec, minute_index(t)));
        if spec.beta.is_some() {
            let date = session.trade_date;
            if prev_date.is_some_and(|d| d != date) {
                gap[i] = 0.35
                    * vol.sigma_daily
                    * normal(seed, spec.stream + STREAM_GAP, day_index(date));
            }
            prev_date = Some(date);
        }
        sig.push(s);
    }

    let mut c = vec![0.0; n];
    let mut market_r = vec![0.0; n];
    match (spec.beta, market) {
        (Some((_, beta)), Some(mkt)) => {
            let m_close = |t: i64| mkt.at_or_before(t).map_or(0.0, |b| b.log_close);
            let m_open = |t: i64| mkt.at_or_before(t).map_or(0.0, |b| b.log_open);
            let anchor_m = m_close(grid[n - 1]);
            let mut w = 0.0;
            for i in (0..n).rev() {
                if i < n - 1 {
                    w -= own[i + 1] + gap[i + 1];
                }
                c[i] = spec.anchor.ln() + beta * (m_close(grid[i]) - anchor_m) + w;
                market_r[i] = beta * (m_close(grid[i]) - m_open(grid[i]));
            }
        }
        _ => {
            c[n - 1] = spec.anchor.ln();
            for i in (0..n - 1).rev() {
                c[i] = c[i + 1] - own[i + 1];
            }
        }
    }

    path.minutes.reserve(n);
    for i in 0..n {
        let t = grid[i];
        let m = minute_index(t);
        let o = c[i] - own[i] - market_r[i];
        let spread = sig[i] * if spec.beta.is_some() { 1.5 } else { 1.0 };
        let h = o.max(c[i]) + 0.5 * spread * half_normal(seed, spec.stream + STREAM_HIGH, m);
        let l = o.min(c[i]) - 0.5 * spread * half_normal(seed, spec.stream + STREAM_LOW, m);
        let z = (c[i] - o) / spread.max(1e-12);
        path.minutes.push(DriverBar {
            t,
            log_open: o,
            log_high: h,
            log_low: l,
            log_close: c[i],
            z,
        });
    }

    path.daily = generate_daily(
        seed,
        spec,
        &vol,
        &sessions,
        path.minutes[0].log_open,
        daily_sessions,
    );
    path.session_of = cells.iter().map(|c| c.session).collect();
    path.sessions = sessions;
    path
}

fn generate_daily(
    seed: u64,
    spec: &DriverSpec,
    vol: &DriverVol,
    window: &[TradingSession],
    first_open: f64,
    count: usize,
) -> Vec<DriverBar> {
    let Some(first) = window.first() else {
        return Vec::new();
    };
    let cal = spec.calendar;
    let mut dates = Vec::with_capacity(count);
    let mut d = first.trade_date;
    for _ in 0..count {
        d = cal.prev_trade_date(d);
        dates.push(d);
    }
    dates.reverse();
    let daily_return = |date: NaiveDate| -> (f64, f64) {
        let sd = vol.sigma_daily * regime(seed, spec.stream, date);
        let idx = day_index(date);
        let own = normal(seed, spec.stream + STREAM_DAILY, idx);
        let z = match spec.corr {
            Some((other, rho)) => {
                rho * normal(seed, driver(other).stream + STREAM_DAILY, idx)
                    + (1.0 - rho * rho).sqrt() * own
            }
            None => own,
        };
        let mut r = sd * z;
        if let Some((m, beta)) = spec.beta {
            let ms = driver(m);
            let mvol = DriverVol::of(ms);
            let msd = mvol.sigma_daily * regime(seed, ms.stream, date);
            r += beta * msd * normal(seed, ms.stream + STREAM_DAILY, idx);
        }
        (r, sd)
    };
    let k = dates.len();
    let mut close = vec![0.0; k];
    if k > 0 {
        close[k - 1] = first_open;
        for i in (0..k - 1).rev() {
            close[i] = close[i + 1] - daily_return(dates[i + 1]).0;
        }
    }
    let tz = cal.tz();
    dates
        .iter()
        .enumerate()
        .map(|(i, &date)| {
            let (r, sd) = daily_return(date);
            let idx = day_index(date);
            let o = if i == 0 {
                close[0] - r
            } else {
                close[i - 1] + 0.2 * sd * normal(seed, spec.stream + STREAM_DAILY_GAP, idx)
            };
            let c = close[i];
            let range = 0.45 * sd;
            let h = o.max(c) + range * half_normal(seed, spec.stream + STREAM_DAILY_RANGE, idx);
            let l = o.min(c) - range * half_normal(seed, spec.stream + STREAM_DAILY_RANGE + 1, idx);
            DriverBar {
                t: local_to_timestamp(tz, date, 0, 0).0,
                log_open: o,
                log_high: h,
                log_low: l,
                log_close: c,
                z: (c - o) / sd.max(1e-12),
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawBar {
    pub t: i64,
    pub o: i64,
    pub h: i64,
    pub l: i64,
    pub c: i64,
    pub v: f64,
    pub bv: f64,
    pub live: bool,
}

impl RawBar {
    pub fn open_at(t: i64, price: i64) -> Self {
        Self {
            t,
            o: price,
            h: price,
            l: price,
            c: price,
            v: 0.0,
            bv: 0.0,
            live: true,
        }
    }
}

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET_BASIS, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(FNV_PRIME)
    })
}

pub fn profile_stream(key: &str) -> u64 {
    fnv1a(key.as_bytes())
}

pub fn round_qty(v: f64, decimals: u32) -> f64 {
    let p = 10f64.powi(decimals as i32);
    (v * p).round() / p
}

pub fn expected_minute_volume(
    profile: &Profile,
    calendar: SessionCalendar,
    session: Option<&TradingSession>,
    norm: &VolumeNorm,
    t: Timestamp,
) -> f64 {
    if profile.index || profile.daily_volume <= 0.0 {
        return 0.0;
    }
    let (w, in_rth) = volume_shape(calendar, session, t);
    let (share, sum) = if in_rth {
        (1.0 - profile.overnight_share, norm.rth_sum)
    } else {
        (profile.overnight_share, norm.overnight_sum)
    };
    if sum <= 0.0 {
        return 0.0;
    }
    profile.daily_volume * share * w / sum
}

pub fn price_scale(profile: &Profile, anchor_log_close: f64) -> f64 {
    match profile.map {
        PriceMap::Identity => 1.0,
        PriceMap::Scale(k) => k,
        PriceMap::AnchoredRatio => profile.anchor / anchor_log_close.exp(),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct InstrumentMap<'a> {
    pub seed: u64,
    pub profile: &'a Profile,
    pub stream: u64,
    pub calendar: SessionCalendar,
    pub norm: &'a VolumeNorm,
    pub tick: f64,
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarSpan {
    Minute,
    Session,
}

pub fn instrument_bar(
    map: &InstrumentMap<'_>,
    session: Option<&TradingSession>,
    b: &DriverBar,
    span: BarSpan,
) -> RawBar {
    let InstrumentMap {
        seed,
        profile,
        stream,
        calendar,
        norm,
        tick,
        scale,
    } = *map;
    let to_ticks = |x: f64| ((x.exp() * scale) / tick).round() as i64;
    let (o, c) = (to_ticks(b.log_open), to_ticks(b.log_close));
    let h = to_ticks(b.log_high).max(o).max(c);
    let l = to_ticks(b.log_low).min(o).min(c);
    let m = minute_index(b.t);
    let (v, bv) = if profile.index || profile.daily_volume <= 0.0 {
        (0.0, 0.0)
    } else {
        let expected = match span {
            BarSpan::Session => profile.daily_volume,
            BarSpan::Minute => {
                expected_minute_volume(profile, calendar, session, norm, Timestamp(b.t))
            }
        };
        let activity = (0.35 * normal(seed, stream + STREAM_ACTIVITY, m) - 0.06).exp()
            * (0.7 + 0.45 * b.z.abs());
        let mut v = round_qty(expected * activity, profile.qty_decimals);
        if profile.qty_decimals == 0 && expected >= 0.5 {
            v = v.max(1.0);
        }
        let imbalance =
            (0.5 + 0.3 * (1.2 * b.z).tanh() + 0.06 * normal(seed, stream + STREAM_FLOW, m))
                .clamp(0.05, 0.95);
        let bv = round_qty(v * imbalance, profile.qty_decimals).min(v);
        (v, bv)
    };
    RawBar {
        t: b.t,
        o,
        h,
        l,
        c,
        v,
        bv,
        live: false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TapePrint {
    pub t: i64,
    pub ticks: i64,
    pub size: f64,
    pub aggressor: Aggressor,
}

const MAX_TAPE_PRINTS: usize = 4_000;

pub fn minute_tape(
    seed: u64,
    stream: u64,
    bar: &RawBar,
    trade_size: f64,
    qty_decimals: u32,
) -> Vec<TapePrint> {
    let scale = 10f64.powi(qty_decimals as i32);
    let v_lots = (bar.v * scale).round() as i64;
    let b_lots = ((bar.bv * scale).round() as i64).clamp(0, v_lots.max(0));
    let s_lots = v_lots - b_lots;
    if v_lots <= 0 {
        return Vec::new();
    }
    let mut rng = SplitMix::new(hash3(seed, stream + STREAM_TAPE, minute_index(bar.t)));
    let want = (bar.v / trade_size.max(1e-12) * (0.2 * rng.normal()).exp()).round() as i64;
    let n = want.clamp(1, (MAX_TAPE_PRINTS as i64).min(v_lots));
    let side_count = |lots: i64| {
        if lots == 0 {
            0
        } else {
            ((n as f64 * lots as f64 / v_lots as f64).round() as i64).clamp(1, lots)
        }
    };
    let (n_buy, n_sell) = (side_count(b_lots), side_count(s_lots));
    let n = (n_buy + n_sell) as usize;

    let up = bar.c >= bar.o;
    let (e1, e2) = if up { (bar.l, bar.h) } else { (bar.h, bar.l) };
    let f1 = 0.15 + 0.3 * rng.uniform();
    let f2 = 0.55 + 0.3 * rng.uniform();
    let knots = [
        (0.0, bar.o as f64),
        (f1, e1 as f64),
        (f2, e2 as f64),
        (1.0, bar.c as f64),
    ];
    let at = |f: f64| -> (f64, f64) {
        let k = knots.windows(2).position(|w| f <= w[1].0).unwrap_or(2);
        let (a, b) = (knots[k], knots[k + 1]);
        let span = (b.0 - a.0).max(1e-9);
        let x = ((f - a.0) / span).clamp(0.0, 1.0);
        (a.1 + (b.1 - a.1) * x, (b.1 - a.1).signum())
    };
    let mut times: Vec<f64> = (0..n).map(|_| rng.uniform()).collect();
    times.sort_by(f64::total_cmp);
    let range = (bar.h - bar.l) as f64;
    let mut prints: Vec<TapePrint> = Vec::with_capacity(n);
    let mut propensity: Vec<(f64, usize)> = Vec::with_capacity(n);
    for (i, &f) in times.iter().enumerate() {
        let (price, slope) = at(f);
        let wobble = 0.12 * range * rng.normal();
        let ticks = ((price + wobble).round() as i64).clamp(bar.l, bar.h);
        propensity.push((0.9 * slope + rng.normal(), i));
        prints.push(TapePrint {
            t: bar.t + (f * NANOS_PER_MINUTE as f64) as i64,
            ticks,
            size: 0.0,
            aggressor: Aggressor::Sell,
        });
    }
    if let Some(p) = prints.first_mut() {
        p.ticks = bar.o;
    }
    if let Some(p) = prints.last_mut() {
        p.ticks = bar.c;
    }
    if n >= 4 {
        let nearest = |f: f64| {
            times
                .iter()
                .enumerate()
                .skip(1)
                .take(n - 2)
                .min_by(|a, b| (a.1 - f).abs().total_cmp(&(b.1 - f).abs()))
                .map_or(1, |(i, _)| i)
        };
        let i1 = nearest(f1);
        let mut i2 = nearest(f2);
        if i2 == i1 {
            i2 = if i1 + 1 < n - 1 { i1 + 1 } else { i1 - 1 };
        }
        prints[i1].ticks = e1;
        prints[i2].ticks = e2;
    }
    propensity.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut buys: Vec<usize> = propensity[..n_buy as usize].iter().map(|p| p.1).collect();
    let mut sells: Vec<usize> = propensity[n_buy as usize..].iter().map(|p| p.1).collect();
    buys.sort_unstable();
    sells.sort_unstable();
    for (idx, lots, aggressor) in [
        (&buys, b_lots, Aggressor::Buy),
        (&sells, s_lots, Aggressor::Sell),
    ] {
        let sizes = split_lots(&mut rng, lots, idx.len());
        for (&i, l) in idx.iter().zip(sizes) {
            prints[i].size = l as f64 / scale;
            prints[i].aggressor = aggressor;
        }
    }
    prints
}

fn split_lots(rng: &mut SplitMix, lots: i64, n: usize) -> Vec<i64> {
    if n == 0 {
        return Vec::new();
    }
    let extra = lots - n as i64;
    let weights: Vec<f64> = (0..n)
        .map(|_| {
            let w = (0.8 * rng.normal()).exp();
            if rng.uniform() < 0.015 {
                w * (12.0 + 38.0 * rng.uniform())
            } else {
                w
            }
        })
        .collect();
    let total: f64 = weights.iter().sum();
    let raw: Vec<f64> = weights
        .iter()
        .map(|w| extra as f64 * w / total.max(1e-12))
        .collect();
    let mut out: Vec<i64> = raw.iter().map(|r| 1 + r.floor() as i64).collect();
    let short = lots - out.iter().sum::<i64>();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        let (fa, fb) = (raw[a] - raw[a].floor(), raw[b] - raw[b].floor());
        fb.total_cmp(&fa).then(a.cmp(&b))
    });
    for &i in order.iter().cycle().take(short.max(0) as usize) {
        out[i] += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::model::{DRIVERS, DriverId};

    fn end() -> Timestamp {
        Timestamp::parse(crate::mock::FROZEN_AT).unwrap()
    }

    #[test]
    fn nq_path_is_anchored_and_deterministic() {
        let spec = driver(DriverId::Nq);
        let a = generate_driver(7, spec, end(), 5, 30, None);
        let b = generate_driver(7, spec, end(), 5, 30, None);
        let c = generate_driver(8, spec, end(), 5, 30, None);
        assert_eq!(a.minutes, b.minutes);
        assert_ne!(a.minutes[0].log_close, c.minutes[0].log_close);
        let last = a.minutes.last().unwrap();
        assert!((last.log_close.exp() - 20641.25).abs() < 1e-6);
        assert_eq!(
            last.t,
            Timestamp::parse("2026-10-02T14:41:00-04:00").unwrap().0
        );
        assert_eq!(a.daily.len(), 30);
        assert!(
            a.minutes
                .iter()
                .all(|b| b.log_low <= b.log_open.min(b.log_close)
                    && b.log_high >= b.log_open.max(b.log_close))
        );
        for w in a.minutes.windows(2) {
            assert!((w[1].log_open - w[0].log_close).abs() < 1e-12);
        }
        assert!((a.daily.last().unwrap().log_close - a.minutes[0].log_open).abs() < 1e-12);
    }

    #[test]
    fn realised_volatility_is_in_range() {
        let spec = driver(DriverId::Nq);
        let p = generate_driver(42, spec, end(), 20, 0, None);
        let rets: Vec<f64> = p
            .minutes
            .windows(2)
            .map(|w| w[1].log_close - w[0].log_close)
            .collect();
        let var: f64 = rets.iter().map(|r| r * r).sum::<f64>();
        let days = 20.0;
        let annual = (var / days * 252.0).sqrt();
        assert!((0.12..0.40).contains(&annual), "annualised vol {annual}");
    }

    #[test]
    fn stocks_follow_the_market_factor() {
        let nq = generate_driver(5, driver(DriverId::Nq), end(), 10, 0, None);
        let nvda = generate_driver(5, driver(DriverId::Nvda), end(), 10, 0, Some(&nq));
        assert!((nvda.minutes.last().unwrap().log_close.exp() - 178.42).abs() < 1e-6);
        let pairs: Vec<(f64, f64)> = nvda
            .minutes
            .windows(6)
            .step_by(5)
            .filter_map(|w| {
                let a = nq.at_or_before(w[0].t)?.log_close;
                let b = nq.at_or_before(w[5].t)?.log_close;
                Some((w[5].log_close - w[0].log_close, b - a))
            })
            .collect();
        let n = pairs.len() as f64;
        let (mx, my) = pairs
            .iter()
            .fold((0.0, 0.0), |(x, y), p| (x + p.0 / n, y + p.1 / n));
        let cov: f64 = pairs.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>();
        let vx: f64 = pairs.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>();
        let vy: f64 = pairs.iter().map(|p| (p.1 - my).powi(2)).sum::<f64>();
        let corr = cov / (vx * vy).sqrt();
        assert!(corr > 0.5, "corr {corr}");
        for b in &nvda.minutes {
            assert!(SessionCalendar::UsEquities.is_rth(Timestamp(b.t)));
        }
    }

    #[test]
    fn every_driver_generates() {
        let nq = generate_driver(1, driver(DriverId::Nq), end(), 3, 5, None);
        for spec in DRIVERS {
            let p = generate_driver(1, &spec, end(), 3, 5, Some(&nq));
            assert!(!p.minutes.is_empty(), "{:?}", spec.id);
            assert!((p.minutes.last().unwrap().log_close.exp() - spec.anchor).abs() < 1e-6);
        }
    }

    #[test]
    fn minute_tapes_add_up_to_their_bars() {
        let nq = generate_driver(3, driver(DriverId::Nq), end(), 2, 0, None);
        let profile = crate::mock::model::PROFILES
            .iter()
            .find(|p| p.key == "NQ@0")
            .unwrap();
        let norm = VolumeNorm::measure(SessionCalendar::CmeEquityIndex, false);
        let map = InstrumentMap {
            seed: 3,
            profile,
            stream: profile_stream(profile.key),
            calendar: SessionCalendar::CmeEquityIndex,
            norm: &norm,
            tick: 0.25,
            scale: 1.0,
        };
        let mut checked = 0;
        for (i, b) in nq.minutes.iter().enumerate().step_by(7) {
            let bar = instrument_bar(&map, nq.session_at(i), b, BarSpan::Minute);
            let tape = minute_tape(3, map.stream, &bar, profile.trade_size, 0);
            assert_eq!(
                tape,
                minute_tape(3, map.stream, &bar, profile.trade_size, 0)
            );
            if bar.v == 0.0 {
                assert!(tape.is_empty());
                continue;
            }
            let v: f64 = tape.iter().map(|p| p.size).sum();
            let bv: f64 = tape
                .iter()
                .filter(|p| p.aggressor == Aggressor::Buy)
                .map(|p| p.size)
                .sum();
            assert_eq!(v, bar.v, "volume at {}", bar.t);
            assert_eq!(bv, bar.bv, "buy volume at {}", bar.t);
            assert!(tape.iter().all(|p| p.size >= 1.0));
            assert!(tape.iter().all(|p| (bar.l..=bar.h).contains(&p.ticks)));
            assert!(tape.windows(2).all(|w| w[0].t <= w[1].t));
            assert!(
                tape.iter()
                    .all(|p| p.t >= bar.t && p.t < bar.t + NANOS_PER_MINUTE)
            );
            assert_eq!(tape[0].ticks, bar.o);
            assert_eq!(tape.last().unwrap().ticks, bar.c);
            if tape.len() >= 4 {
                assert!(tape.iter().any(|p| p.ticks == bar.h));
                assert!(tape.iter().any(|p| p.ticks == bar.l));
            }
            checked += 1;
        }
        assert!(checked > 100, "{checked}");
    }

    #[test]
    fn fractional_tapes_split_exactly() {
        let bar = RawBar {
            t: 0,
            o: 100,
            h: 104,
            l: 98,
            c: 103,
            v: 1.2345,
            bv: 0.8001,
            live: false,
        };
        let tape = minute_tape(1, 2, &bar, 0.05, 4);
        let sum = |side: Option<Aggressor>| -> f64 {
            let x: f64 = tape
                .iter()
                .filter(|p| side.is_none_or(|s| p.aggressor == s))
                .map(|p| p.size)
                .sum();
            round_qty(x, 4)
        };
        assert_eq!(sum(None), 1.2345);
        assert_eq!(sum(Some(Aggressor::Buy)), 0.8001);
        assert!(tape.len() > 10);
        assert!(
            tape.iter()
                .filter(|p| p.aggressor == Aggressor::Buy)
                .count()
                > tape.len() / 2
        );
    }
}
