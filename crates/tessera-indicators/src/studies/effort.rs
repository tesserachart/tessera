use tessera_core::Timestamp;
use tessera_protocol::indicators::{IndicatorBoxObject, IndicatorObjects, LineDash, ObjectExtend};
use tessera_script::ScriptError;

use super::natives::Inputs;
use super::{Drawn, Needs, Pulls, Study, columns};
use crate::frame::{Changed, FLOW_PULL_SESSIONS, Rows};

const NAN: f64 = f64::NAN;

#[derive(Clone, Debug)]
struct Config {
    min_delta_percent: f64,
    max_delta_percent: f64,
    max_delta_per_tick: f64,
    max_bar_seconds: f64,
    min_bars: usize,
    full_range_bars: usize,
    keep_percent: f64,
    extend_bars: usize,
    tick_size: f64,
    opacity: f64,
    buy_color: String,
    sell_color: String,
}

impl Config {
    fn of(i: Inputs<'_>) -> Self {
        Self {
            min_delta_percent: i.num("minDeltaPercent", 10.0),
            max_delta_percent: i.num("maxDeltaPercent", 40.0),
            max_delta_per_tick: i.num("maxDeltaPerTick", 14.0),
            max_bar_seconds: i.num("maxBarSeconds", 45.0),
            min_bars: i.len("minBars", 2.0, 1),
            full_range_bars: i.num("fullRangeBars", 1.0).max(0.0) as usize,
            keep_percent: i.num("keepPercent", 50.0),
            extend_bars: i.len("extendBars", 20.0, 1),
            tick_size: i.num("tickSize", 0.25).max(f64::MIN_POSITIVE),
            opacity: i.num("opacity", 0.18).clamp(0.0, 1.0),
            buy_color: i.text("buyColor").unwrap_or("#26a69a").to_owned(),
            sell_color: i.text("sellColor").unwrap_or("#ef5350").to_owned(),
        }
    }

    fn color(&self, side: Side) -> &str {
        match side {
            Side::Buy => &self.buy_color,
            Side::Sell => &self.sell_color,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    t: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    delta: f64,
}

#[derive(Clone, Debug)]
struct Zone {
    top: f64,
    bottom: f64,
    start: usize,
    last: usize,
    ends: Option<usize>,
    side: Side,
}

impl Zone {
    fn open(&self) -> bool {
        self.ends.is_none()
    }

    fn touched_by(&self, bar: &Sample) -> bool {
        bar.high >= self.bottom && bar.low <= self.top
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Streak {
    bars: usize,
    start: usize,
    high: f64,
    low: f64,
}

impl Streak {
    fn push(&mut self, i: usize, bar: &Sample) {
        if self.bars == 0 {
            self.start = i;
            self.high = bar.high;
            self.low = bar.low;
        }
        self.bars += 1;
        self.high = self.high.max(bar.high);
        self.low = self.low.min(bar.low);
    }

    fn band(&self, cfg: &Config) -> Option<(f64, f64)> {
        if self.bars < cfg.min_bars {
            return None;
        }
        let inset = if self.bars > cfg.full_range_bars {
            (self.high - self.low) * cfg.keep_percent / 100.0
        } else {
            0.0
        };
        let (top, bottom) = (self.high - inset, self.low + inset);
        (top >= bottom).then_some((top, bottom))
    }
}

#[derive(Debug, Default)]
struct Streaks {
    buy: Streak,
    sell: Streak,
}

impl Streaks {
    fn of(&mut self, side: Side) -> &mut Streak {
        match side {
            Side::Buy => &mut self.buy,
            Side::Sell => &mut self.sell,
        }
    }

    fn building(&mut self, side: Option<Side>) -> Option<(Side, usize)> {
        let side = side?;
        let streak = self.of(side);
        (streak.bars > 0).then_some((side, streak.start))
    }

    fn push(&mut self, side: Side, i: usize, bar: &Sample) -> &Streak {
        let opposite = match side {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        };
        *self.of(opposite) = Streak::default();
        let streak = self.of(side);
        streak.push(i, bar);
        streak
    }
}

fn accepted(bars: &[Sample], i: usize, cfg: &Config) -> Option<Side> {
    let bar = &bars[i];
    if bar.volume <= 0.0 || !bar.delta.is_finite() {
        return None;
    }
    let side = if bar.delta >= 0.0 && bar.close >= bar.open {
        Side::Buy
    } else if bar.delta < 0.0 && bar.close < bar.open {
        Side::Sell
    } else {
        return None;
    };
    let percent = bar.delta.abs() / bar.volume * 100.0;
    if percent < cfg.min_delta_percent {
        return None;
    }
    if cfg.max_delta_percent > 0.0 && percent > cfg.max_delta_percent {
        return None;
    }
    let range_ticks = (bar.open - bar.close).abs() / cfg.tick_size;
    let per_tick = bar.delta.abs() / (range_ticks + 1.0);
    if cfg.max_delta_per_tick > 0.0 && per_tick > cfg.max_delta_per_tick {
        return None;
    }
    if cfg.max_bar_seconds > 0.0 && i + 1 < bars.len() {
        let seconds = (bars[i + 1].t - bar.t) as f64 / 1e9;
        if seconds > cfg.max_bar_seconds {
            return None;
        }
    }
    Some(side)
}

fn detect(bars: &[Sample], cfg: &Config) -> IndicatorObjects {
    let mut objects = IndicatorObjects::default();
    let Some(last) = bars.len().checked_sub(1) else {
        return objects;
    };
    let mut zones: Vec<Zone> = Vec::new();
    let mut streaks = Streaks::default();

    for (i, bar) in bars.iter().enumerate() {
        let side = accepted(bars, i, cfg);
        let building = streaks.building(side);
        for zone in zones.iter_mut().filter(|z| z.open()) {
            if building == Some((zone.side, zone.start)) {
                continue;
            }
            if zone.touched_by(bar) || i.saturating_sub(zone.last) > cfg.extend_bars {
                zone.ends = Some(i);
            }
        }

        let Some(side) = side else {
            streaks = Streaks::default();
            continue;
        };
        let streak = streaks.push(side, i, bar);
        let Some((top, bottom)) = streak.band(cfg) else {
            continue;
        };
        let start = streak.start;
        if let Some(zone) = zones
            .iter_mut()
            .find(|z| z.open() && z.side == side && z.start == start)
        {
            zone.top = top;
            zone.bottom = bottom;
            zone.last = i;
        } else {
            zones.push(Zone {
                top,
                bottom,
                start,
                last: i,
                ends: None,
                side,
            });
        }
    }

    for zone in zones {
        let end = zone.ends.unwrap_or(last);
        let color = cfg.color(zone.side).to_owned();
        objects.boxes.push(IndicatorBoxObject {
            time1: Timestamp(bars[zone.start].t),
            price1: zone.top,
            time2: Some(Timestamp(bars[end].t)),
            price2: zone.bottom,
            color: Some(color.clone()),
            width: 1.0,
            line: LineDash::Solid,
            fill: Some(color),
            opacity: cfg.opacity,
            extend: if zone.ends.is_some() {
                ObjectExtend::None
            } else {
                ObjectExtend::Right
            },
            label: None,
        });
    }
    objects.cap();
    objects
}

#[derive(Debug)]
pub(crate) struct Effort {
    columns: Vec<String>,
    config: Config,
}

impl Effort {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&[]),
            config: Config::of(i),
        }
    }
}

impl Study for Effort {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn restart(&self, _rows: &Rows, _changed: Changed) -> usize {
        0
    }

    fn needs(&self) -> Needs {
        Needs::Flow(Pulls::Sessions(FLOW_PULL_SESSIONS as u32))
    }

    fn run(
        &self,
        rows: &Rows,
        _cols: &mut [Vec<f64>],
        _from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let bars: Vec<Sample> = rows
            .iter()
            .map(|row| {
                let sides = row.flow.sides;
                Sample {
                    t: row.t,
                    open: row.open,
                    high: row.high,
                    low: row.low,
                    close: row.close,
                    volume: sides.map_or(NAN, |s| s.volume),
                    delta: sides.map_or(NAN, |s| s.delta),
                }
            })
            .collect();
        Ok(Some(Drawn::new(detect(&bars, &self.config), String::new())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            min_delta_percent: 10.0,
            max_delta_percent: 40.0,
            max_delta_per_tick: 14.0,
            max_bar_seconds: 45.0,
            min_bars: 2,
            full_range_bars: 1,
            keep_percent: 50.0,
            extend_bars: 3,
            tick_size: 0.25,
            opacity: 0.2,
            buy_color: "#26a69a".into(),
            sell_color: "#ef5350".into(),
        }
    }

    fn bar(t: i64, open: f64, close: f64, high: f64, low: f64, volume: f64, delta: f64) -> Sample {
        Sample {
            t,
            open,
            close,
            high,
            low,
            volume,
            delta,
        }
    }

    fn absorbing(start: i64, up: bool) -> Vec<Sample> {
        let (open, close, delta) = if up {
            (100.0, 100.0, 10.0)
        } else {
            (100.0, 99.75, -10.0)
        };
        (0..3)
            .map(|k| {
                bar(
                    start + k,
                    open,
                    close,
                    open + 0.25,
                    close - 0.25,
                    100.0,
                    delta,
                )
            })
            .collect()
    }

    #[test]
    fn a_directional_absorption_streak_arms_a_zone() {
        let bars = absorbing(0, true);
        let objects = detect(&bars, &config());
        assert_eq!(objects.boxes.len(), 1);
        assert_eq!(objects.boxes[0].extend, ObjectExtend::Right);
        assert_eq!(objects.boxes[0].price1, objects.boxes[0].price2);
    }

    #[test]
    fn an_opposite_bar_resets_the_streak() {
        let mut bars = absorbing(0, true);
        bars.push(bar(3, 100.0, 99.75, 100.0, 99.5, 100.0, -30.0));
        bars.push(bar(4, 100.0, 100.0, 100.25, 99.75, 100.0, 30.0));
        let objects = detect(&bars, &config());
        assert_eq!(objects.boxes.len(), 1);
    }

    #[test]
    fn a_wide_bar_with_the_same_delta_fails_the_effort_cap() {
        let mut bars = absorbing(0, true);
        bars[1] = bar(1, 100.0, 100.25, 100.5, 99.75, 1000.0, 100.0);
        let objects = detect(&bars, &config());
        assert!(objects.boxes.is_empty());
    }

    #[test]
    fn a_retest_ends_the_zone_and_a_late_bar_expires_it() {
        let mut bars = absorbing(0, true);
        bars.push(bar(3, 100.0, 100.0, 100.0, 100.0, 100.0, 30.0));
        bars.push(bar(4, 100.0, 100.0, 100.0, 100.0, 100.0, 30.0));
        let objects = detect(&bars, &config());
        assert!(objects.boxes.iter().all(|b| b.extend == ObjectExtend::None));
        assert_eq!(objects.boxes[0].time2, Some(Timestamp(3)));
    }

    #[test]
    fn a_slow_bar_does_not_extend_the_streak() {
        let mut bars = absorbing(0, true);
        bars[2] = bar(3_000_000_000, 100.0, 100.0, 100.25, 99.75, 100.0, 10.0);
        bars.push(bar(
            60_000_000_000,
            100.0,
            100.0,
            100.25,
            99.75,
            100.0,
            10.0,
        ));
        let objects = detect(&bars, &config());
        assert_eq!(objects.boxes.len(), 1);
        assert_eq!(objects.boxes[0].price1, 100.0);
    }

    fn colours(objects: &IndicatorObjects) -> Vec<(&str, &str)> {
        objects
            .boxes
            .iter()
            .map(|b| {
                (
                    b.color.as_deref().unwrap_or_default(),
                    b.fill.as_deref().unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn a_sell_streak_arms_one_sell_coloured_zone() {
        let bars = absorbing(0, false);
        let objects = detect(&bars, &config());
        assert_eq!(colours(&objects), vec![("#ef5350", "#ef5350")]);
        assert_eq!(objects.boxes[0].extend, ObjectExtend::Right);
        assert_eq!(objects.boxes[0].price1, 99.875);
        assert_eq!(objects.boxes[0].price2, 99.875);
    }

    #[test]
    fn an_up_bar_resets_a_sell_streak() {
        let sell = absorbing(0, false)[0];
        let buy = absorbing(0, true)[0];
        let bars: Vec<Sample> = [sell, buy, sell, buy, sell]
            .into_iter()
            .enumerate()
            .map(|(t, b)| Sample { t: t as i64, ..b })
            .collect();
        let objects = detect(&bars, &config());
        assert!(objects.boxes.is_empty());
    }

    #[test]
    fn a_sell_retest_ends_the_sell_zone() {
        let mut bars = absorbing(0, false);
        bars.push(bar(3, 99.25, 99.25, 99.5, 99.0, 100.0, 50.0));
        bars.push(bar(4, 99.75, 100.0, 100.0, 99.75, 100.0, 50.0));
        let objects = detect(&bars, &config());
        assert_eq!(colours(&objects), vec![("#ef5350", "#ef5350")]);
        assert_eq!(objects.boxes[0].extend, ObjectExtend::None);
        assert_eq!(objects.boxes[0].time2, Some(Timestamp(4)));
    }

    #[test]
    fn a_buy_streak_then_a_sell_streak_draw_one_zone_each() {
        let mut bars = absorbing(0, true);
        bars.extend(absorbing(3, false));
        let objects = detect(&bars, &config());
        assert_eq!(
            colours(&objects),
            vec![("#26a69a", "#26a69a"), ("#ef5350", "#ef5350")]
        );
        assert_eq!(objects.boxes[0].time2, Some(Timestamp(3)));
        assert_eq!(objects.boxes[1].extend, ObjectExtend::Right);
    }
}
