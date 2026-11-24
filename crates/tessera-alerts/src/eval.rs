use tessera_core::{Timeframe, Timestamp};
use tessera_protocol::drawings::{Drawing, DrawingExtend, DrawingKind};
use tessera_protocol::indicators::{IndicatorLineObject, ObjectExtend};

use crate::io::{Alert, AlertOp, AlertRepeat, AlertStatus, AlertStep, EvaluateOn, Operand};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Feed {
    Trade,
    BarClose,
    Order,
    Zone,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observation {
    pub feed: Feed,
    pub at: Timestamp,
    pub price: f64,
    pub bar: Option<Timestamp>,
    pub size: f64,
    pub side: i8,
}

impl Observation {
    pub fn trade(at: Timestamp, price: f64) -> Self {
        Self::print(at, price, 0.0, 0)
    }

    pub fn print(at: Timestamp, price: f64, size: f64, side: i8) -> Self {
        Self {
            feed: Feed::Trade,
            at,
            price,
            bar: None,
            size,
            side,
        }
    }

    pub fn order(at: Timestamp, price: f64, size: f64, side: i8) -> Self {
        Self {
            feed: Feed::Order,
            ..Self::print(at, price, size, side)
        }
    }

    pub fn zone(at: Timestamp, price: f64, rows: u32, side: i8) -> Self {
        Self {
            feed: Feed::Zone,
            ..Self::print(at, price, f64::from(rows), side)
        }
    }

    pub fn close(bar: Timestamp, tf: Timeframe, close: f64) -> Self {
        Self {
            feed: Feed::BarClose,
            at: Timestamp(bar.0 + tf.nanos()),
            price: close,
            bar: Some(bar),
            size: 0.0,
            side: 0,
        }
    }
}

pub trait Values {
    fn value(&self, operand: &Operand, obs: &Observation) -> Option<f64>;
}

impl<F: Fn(&Operand, &Observation) -> Option<f64>> Values for F {
    fn value(&self, operand: &Operand, obs: &Observation) -> Option<f64> {
        self(operand, obs)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Above,
    Below,
    Touch,
}

fn side_of(subject: f64, target: f64) -> Side {
    let tolerance = 1e-9 * target.abs().max(1.0);
    if (subject - target).abs() <= tolerance {
        Side::Touch
    } else if subject > target {
        Side::Above
    } else {
        Side::Below
    }
}

fn side_after(prev: Option<Side>, cur: Side, crossed: bool) -> Option<Side> {
    match (cur, prev) {
        (Side::Touch, Some(Side::Below)) if crossed => Some(Side::Above),
        (Side::Touch, Some(Side::Above)) if crossed => Some(Side::Below),
        (Side::Touch, _) => prev,
        (side, _) => Some(side),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub subject: f64,
    pub target: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Quiet,
    Advanced(usize),
    Reset,
    Fired(Reading),
    Expired,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tracker {
    step: usize,
    closes_since_first_step: u32,
    sides: Vec<Option<Side>>,
    last_fired: Option<Timestamp>,
    spent: bool,
}

impl Tracker {
    pub fn new(alert: &Alert) -> Self {
        Self {
            sides: vec![None; alert.steps.len()],
            last_fired: alert.fired_at,
            ..Self::default()
        }
    }

    pub fn step(&self) -> usize {
        self.step
    }

    pub fn closes_since_first_step(&self) -> u32 {
        self.closes_since_first_step
    }

    pub fn prime(&mut self, alert: &Alert, obs: &Observation, values: &dyn Values) {
        for (i, s) in alert.steps.iter().enumerate() {
            if !applies(s, obs.feed) || s.subject.is_event() {
                continue;
            }
            if let Some(r) = read(&s.subject, &s.target, obs, values) {
                let side = side_of(r.subject, r.target);
                if side != Side::Touch {
                    self.sides[i] = Some(side);
                }
            }
        }
    }

    pub fn observe(&mut self, alert: &Alert, obs: &Observation, values: &dyn Values) -> Outcome {
        if alert.status != AlertStatus::Active || self.spent {
            return Outcome::Quiet;
        }
        if alert.expires_at.is_some_and(|e| obs.at >= e) {
            return Outcome::Expired;
        }
        if self.sides.len() != alert.steps.len() {
            self.sides = vec![None; alert.steps.len()];
            self.step = 0;
        }
        let mut met: Option<Reading> = None;
        for (i, s) in alert.steps.iter().enumerate() {
            if !applies(s, obs.feed) {
                continue;
            }
            let Some(r) = read(&s.subject, &s.target, obs, values) else {
                continue;
            };
            let prev = self.sides[i];
            let cur = side_of(r.subject, r.target);
            let hit = match s.op {
                AlertOp::Above => cur == Side::Above,
                AlertOp::Below => cur == Side::Below,
                AlertOp::CrossesAbove => prev == Some(Side::Below) && cur != Side::Below,
                AlertOp::CrossesBelow => prev == Some(Side::Above) && cur != Side::Above,
                AlertOp::Crosses => {
                    (prev == Some(Side::Below) && cur != Side::Below)
                        || (prev == Some(Side::Above) && cur != Side::Above)
                }
                AlertOp::AtLeast => cur != Side::Below,
            };
            self.sides[i] = side_after(prev, cur, hit);
            if i == self.step && hit {
                met = Some(r);
            }
        }
        let last = alert.steps.len().saturating_sub(1);
        match met {
            Some(r) if self.step >= last => {
                self.step = 0;
                self.closes_since_first_step = 0;
                if alert.repeat == AlertRepeat::Every
                    && let Some(t) = self.last_fired
                    && obs.at.0 < t.0 + i64::from(alert.cooldown_secs) * 1_000_000_000
                {
                    return Outcome::Quiet;
                }
                self.last_fired = Some(obs.at);
                if alert.repeat == AlertRepeat::Once {
                    self.spent = true;
                }
                Outcome::Fired(r)
            }
            Some(_) => {
                if self.step == 0 {
                    self.closes_since_first_step = 0;
                }
                self.step += 1;
                Outcome::Advanced(self.step)
            }
            None if self.step > 0 && obs.feed == Feed::BarClose => {
                self.closes_since_first_step += 1;
                if alert
                    .within_bars
                    .is_some_and(|n| self.closes_since_first_step >= n)
                {
                    self.step = 0;
                    self.closes_since_first_step = 0;
                    Outcome::Reset
                } else {
                    Outcome::Quiet
                }
            }
            None => Outcome::Quiet,
        }
    }
}

fn applies(step: &AlertStep, feed: Feed) -> bool {
    match step.subject {
        Operand::BigTrade { .. } => feed == Feed::Order,
        Operand::Print { .. } => feed == Feed::Trade,
        Operand::StackedImbalance { .. } => feed == Feed::Zone,
        _ => matches!(
            (step.on, feed),
            (EvaluateOn::Trade, Feed::Trade) | (EvaluateOn::BarClose, Feed::BarClose)
        ),
    }
}

fn read(
    subject: &Operand,
    target: &Operand,
    obs: &Observation,
    values: &dyn Values,
) -> Option<Reading> {
    let v = |o: &Operand| match o {
        Operand::Price => Some(obs.price),
        Operand::Value { value } => Some(*value),
        Operand::BigTrade { side }
        | Operand::Print { side }
        | Operand::StackedImbalance { side, .. } => side.takes(obs.side).then_some(obs.size),
        other => values.value(other, obs),
    };
    let subject = v(subject).filter(|x| x.is_finite())?;
    let target = v(target).filter(|x| x.is_finite())?;
    Some(Reading { subject, target })
}

pub fn line_at(a: (i64, f64), b: (i64, f64), left: bool, right: bool, t: i64) -> Option<f64> {
    let (early, late) = if a.0 <= b.0 { (a, b) } else { (b, a) };
    if early.0 == late.0 {
        return None;
    }
    if (t < early.0 && !left) || (t > late.0 && !right) {
        return None;
    }
    let slope = (late.1 - early.1) / (late.0 - early.0) as f64;
    Some(early.1 + slope * (t - early.0) as f64)
}

pub fn drawing_at(d: &Drawing, t: Timestamp) -> Option<f64> {
    let p = |i: usize| d.points.get(i).and_then(|p| p.price).map(|x| x.to_f64());
    let at = |i: usize| d.points.get(i).and_then(|p| p.t).map(|x| x.0);
    match d.kind {
        DrawingKind::HorizontalLine | DrawingKind::CrossLine => p(0),
        DrawingKind::HorizontalRay => match at(0) {
            Some(t0) if t.0 < t0 => None,
            _ => p(0),
        },
        DrawingKind::TrendLine
        | DrawingKind::TrendAngle
        | DrawingKind::Ray
        | DrawingKind::ExtendedLine => {
            let (left, right) = match d.style.extend {
                DrawingExtend::None => (false, false),
                DrawingExtend::Left => (true, false),
                DrawingExtend::Right => (false, true),
                DrawingExtend::Both => (true, true),
            };
            let (left, right) = if d.kind == DrawingKind::ExtendedLine {
                (true, true)
            } else {
                (left, right)
            };
            line_at((at(0)?, p(0)?), (at(1)?, p(1)?), left, right, t.0)
        }
        _ => None,
    }
}

pub fn is_line(kind: DrawingKind) -> bool {
    matches!(
        kind,
        DrawingKind::HorizontalLine
            | DrawingKind::HorizontalRay
            | DrawingKind::CrossLine
            | DrawingKind::TrendLine
            | DrawingKind::TrendAngle
            | DrawingKind::Ray
            | DrawingKind::ExtendedLine
    )
}

pub fn indicator_line_at(lines: &[IndicatorLineObject], label: &str, t: Timestamp) -> Option<f64> {
    let line = lines
        .iter()
        .filter(|l| l.label.as_ref().is_some_and(|x| x.text == label))
        .max_by_key(|l| l.time1)?;
    let (left, right) = match line.extend {
        ObjectExtend::None => (false, false),
        ObjectExtend::Left => (true, false),
        ObjectExtend::Right => (false, true),
        ObjectExtend::Both => (true, true),
    };
    match line.time2 {
        None => Some(line.price2),
        Some(t2) if t2 == line.time1 || line.price1 == line.price2 => Some(line.price2),
        Some(t2) => line_at(
            (line.time1.0, line.price1),
            (t2.0, line.price2),
            left,
            right,
            t.0,
        )
        .or_else(|| {
            let (early, late) = if line.time1 <= t2 {
                ((line.time1, line.price1), (t2, line.price2))
            } else {
                ((t2, line.price2), (line.time1, line.price1))
            };
            Some(if t < early.0 { early.1 } else { late.1 })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::{AlertDelivery, AlertLive, AlertStep};
    use tessera_core::InstrumentId;

    const SEC: i64 = 1_000_000_000;

    fn alert(steps: Vec<AlertStep>) -> Alert {
        Alert {
            id: "al_1".into(),
            symbol: "NQ".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            interval: Timeframe::M1,
            steps,
            within_bars: None,
            repeat: AlertRepeat::Once,
            cooldown_secs: 60,
            expires_at: None,
            message: None,
            deliver: AlertDelivery::default(),
            ask_analyst: false,
            status: AlertStatus::Active,
            title: String::new(),
            created_by: "user".into(),
            session_id: None,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
            fired_at: None,
            fire_count: 0,
            live: AlertLive::default(),
        }
    }

    fn step(op: AlertOp, target: Operand, on: EvaluateOn) -> AlertStep {
        AlertStep {
            subject: Operand::Price,
            op,
            target,
            on,
        }
    }

    fn value(v: f64) -> Operand {
        Operand::Value { value: v }
    }

    fn none(_: &Operand, _: &Observation) -> Option<f64> {
        None
    }

    fn trades(
        tr: &mut Tracker,
        a: &Alert,
        t0: i64,
        prices: &[f64],
        v: &dyn Values,
    ) -> Vec<Outcome> {
        prices
            .iter()
            .enumerate()
            .map(|(i, p)| {
                tr.observe(
                    a,
                    &Observation::trade(Timestamp(t0 + i as i64 * SEC), *p),
                    v,
                )
            })
            .collect()
    }

    fn fired(o: &[Outcome]) -> usize {
        o.iter().filter(|x| matches!(x, Outcome::Fired(_))).count()
    }

    #[test]
    fn price_crossing_on_trades_counts_a_touch_once() {
        let a = alert(vec![step(
            AlertOp::CrossesAbove,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        let mut tr = Tracker::new(&a);
        let o = trades(&mut tr, &a, 0, &[99.0, 99.5, 100.0], &none);
        assert_eq!(o[..2], [Outcome::Quiet, Outcome::Quiet]);
        assert_eq!(
            o[2],
            Outcome::Fired(Reading {
                subject: 100.0,
                target: 100.0
            })
        );
        assert_eq!(
            fired(&trades(&mut tr, &a, 10 * SEC, &[99.0, 101.0], &none)),
            0
        );
    }

    #[test]
    fn crossing_needs_a_side_first_and_either_way_for_crosses() {
        let a = alert(vec![step(
            AlertOp::CrossesAbove,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &[101.0, 102.0], &none)), 0);
        let mut b = alert(vec![step(
            AlertOp::Crosses,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        b.repeat = AlertRepeat::Every;
        b.cooldown_secs = 0;
        let mut tr = Tracker::new(&b);
        let o = trades(&mut tr, &b, 0, &[101.0, 99.0, 100.0, 101.0], &none);
        assert_eq!(fired(&o), 2);
        assert!(matches!(o[1], Outcome::Fired(_)) && matches!(o[2], Outcome::Fired(_)));
        assert_eq!(o[3], Outcome::Quiet);
    }

    #[test]
    fn a_touch_that_crossed_takes_the_far_side_and_one_that_did_not_keeps_its_side() {
        let mut a = alert(vec![step(
            AlertOp::CrossesAbove,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        a.repeat = AlertRepeat::Every;
        a.cooldown_secs = 0;
        let mut tr = Tracker::new(&a);
        let prices = [101.0, 100.0, 101.0, 99.0, 100.0, 100.0, 101.0];
        let o = trades(&mut tr, &a, 0, &prices, &none);
        let fired_at: Vec<usize> = (0..o.len())
            .filter(|&i| matches!(o[i], Outcome::Fired(_)))
            .collect();
        assert_eq!(fired_at, [4]);
    }

    #[test]
    fn above_and_below_are_states() {
        let mut a = alert(vec![step(AlertOp::Below, value(100.0), EvaluateOn::Trade)]);
        a.repeat = AlertRepeat::Every;
        a.cooldown_secs = 5;
        let mut tr = Tracker::new(&a);
        let o = trades(&mut tr, &a, 0, &[99.0; 11], &none);
        assert_eq!(fired(&o), 3);
        let b = alert(vec![step(AlertOp::Above, value(100.0), EvaluateOn::Trade)]);
        let mut tr = Tracker::new(&b);
        assert!(matches!(
            tr.observe(&b, &Observation::trade(Timestamp(0), 100.5), &none),
            Outcome::Fired(_)
        ));
    }

    #[test]
    fn bar_close_steps_ignore_trades() {
        let a = alert(vec![step(
            AlertOp::Above,
            value(100.0),
            EvaluateOn::BarClose,
        )]);
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &[105.0, 106.0], &none)), 0);
        let o = tr.observe(
            &a,
            &Observation::close(Timestamp(0), Timeframe::M1, 99.0),
            &none,
        );
        assert_eq!(o, Outcome::Quiet);
        let o = tr.observe(
            &a,
            &Observation::close(Timestamp(60 * SEC), Timeframe::M1, 100.25),
            &none,
        );
        assert!(matches!(o, Outcome::Fired(r) if r.subject == 100.25));
    }

    #[test]
    fn a_level_is_followed_at_its_current_value() {
        let key = "acme.classic.zero_gamma";
        let a = alert(vec![step(
            AlertOp::CrossesBelow,
            Operand::Level {
                key: key.into(),
                provider: None,
                label: Some("Zero Gamma".into()),
            },
            EvaluateOn::Trade,
        )]);
        let level = std::cell::Cell::new(100.0);
        let v = |o: &Operand, _: &Observation| match o {
            Operand::Level { key: k, .. } if k == key => Some(level.get()),
            _ => None,
        };
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &[101.0], &v)), 0);
        level.set(102.0);
        let o = trades(&mut tr, &a, SEC, &[101.0], &v);
        assert!(matches!(o[0], Outcome::Fired(r) if r.target == 102.0));
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &[101.0, 99.0], &none)), 0);
    }

    #[test]
    fn plots_cross_each_other_on_bar_close() {
        let ema = |n: u32| Operand::Plot {
            indicator: "ema".into(),
            inputs: serde_json::json!({"length": n})
                .as_object()
                .cloned()
                .unwrap(),
            plot: "ema".into(),
            label: None,
        };
        let a = alert(vec![AlertStep {
            subject: ema(9),
            op: AlertOp::CrossesAbove,
            target: ema(21),
            on: EvaluateOn::BarClose,
        }]);
        let series = [(99.0, 100.0), (99.5, 100.0), (100.5, 100.1), (101.0, 100.2)];
        let mut out = Vec::new();
        let mut tr = Tracker::new(&a);
        for (i, (fast, slow)) in series.iter().enumerate() {
            let v = |o: &Operand, _: &Observation| match o {
                Operand::Plot { inputs, .. } if inputs["length"] == 9 => Some(*fast),
                Operand::Plot { .. } => Some(*slow),
                _ => None,
            };
            out.push(tr.observe(
                &a,
                &Observation::close(Timestamp(i as i64 * 60 * SEC), Timeframe::M1, 0.0),
                &v,
            ));
        }
        assert_eq!(out[..2], [Outcome::Quiet, Outcome::Quiet]);
        assert!(matches!(out[2], Outcome::Fired(r) if r.subject == 100.5 && r.target == 100.1));
        assert_eq!(out[3], Outcome::Quiet);
    }

    #[test]
    fn a_drawn_line_is_read_at_the_time() {
        use tessera_core::Price;
        use tessera_protocol::drawings::DrawingStyle;
        use tessera_protocol::layout::{AnchorPoint, OverlayNamespace};
        let pt = |t: i64, p: f64| AnchorPoint {
            t: Some(Timestamp(t)),
            price: Some(Price::from_f64(p).unwrap()),
        };
        let mut d = Drawing {
            id: "dr_1".into(),
            kind: DrawingKind::TrendLine,
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            points: vec![pt(0, 100.0), pt(100 * SEC, 110.0)],
            style: DrawingStyle::default_for(DrawingKind::TrendLine),
            text: None,
            levels: None,
            label: None,
            locked: false,
            namespace: OverlayNamespace::User,
            session_id: None,
            created_at: Timestamp(0),
        };
        assert_eq!(drawing_at(&d, Timestamp(50 * SEC)), Some(105.0));
        assert_eq!(drawing_at(&d, Timestamp(150 * SEC)), None);
        d.style.extend = DrawingExtend::Right;
        assert_eq!(drawing_at(&d, Timestamp(150 * SEC)), Some(115.0));
        assert_eq!(drawing_at(&d, Timestamp(-SEC)), None);
        d.kind = DrawingKind::HorizontalLine;
        d.points = vec![AnchorPoint {
            t: None,
            price: Some(Price::from_f64(105.25).unwrap()),
        }];
        assert_eq!(drawing_at(&d, Timestamp(1)), Some(105.25));
        d.kind = DrawingKind::CrossLine;
        d.points = vec![pt(40 * SEC, 105.25)];
        assert_eq!(
            drawing_at(&d, Timestamp(500 * SEC)),
            Some(105.25),
            "a cross line's price holds across the chart"
        );
        d.kind = DrawingKind::TrendAngle;
        d.style.extend = DrawingExtend::None;
        d.points = vec![pt(0, 100.0), pt(100 * SEC, 110.0)];
        assert_eq!(drawing_at(&d, Timestamp(50 * SEC)), Some(105.0));
        assert!(is_line(DrawingKind::TrendAngle) && is_line(DrawingKind::CrossLine));
        assert!(!is_line(DrawingKind::FibExtension));

        d.kind = DrawingKind::Ray;
        d.points = vec![pt(0, 100.0), pt(100 * SEC, 110.0)];
        let a = alert(vec![step(
            AlertOp::CrossesBelow,
            Operand::Drawing {
                drawing_id: "dr_1".into(),
                label: None,
            },
            EvaluateOn::Trade,
        )]);
        let v = |o: &Operand, obs: &Observation| match o {
            Operand::Drawing { .. } => drawing_at(&d, obs.at),
            _ => None,
        };
        let mut tr = Tracker::new(&a);
        let o = trades(&mut tr, &a, 10 * SEC, &[102.0, 101.5, 101.15], &v);
        assert_eq!(o[..2], [Outcome::Quiet, Outcome::Quiet]);
        assert!(
            matches!(o[2], Outcome::Fired(r) if (r.target - 101.2).abs() < 1e-9),
            "{o:?}"
        );
    }

    #[test]
    fn indicator_lines_follow_the_newest_with_the_label() {
        use tessera_protocol::indicators::LineDash;
        use tessera_protocol::indicators::{LabelAlong, LabelSide, ObjectText};
        let line = |t1: i64, t2: Option<i64>, p: f64, text: &str| IndicatorLineObject {
            time1: Timestamp(t1),
            price1: p,
            time2: t2.map(Timestamp),
            price2: p,
            color: None,
            width: 1.0,
            line: LineDash::Solid,
            extend: ObjectExtend::None,
            label: Some(ObjectText {
                text: text.into(),
                at: LabelAlong::End,
                side: LabelSide::Above,
                color: None,
            }),
        };
        let lines = vec![
            line(0, Some(10), 100.0, "London high"),
            line(20, None, 105.0, "London high"),
            line(20, None, 90.0, "London low"),
            line(30, Some(40), 120.0, "Asia high"),
        ];
        assert_eq!(
            indicator_line_at(&lines, "London high", Timestamp(50)),
            Some(105.0)
        );
        assert_eq!(
            indicator_line_at(&lines, "London low", Timestamp(50)),
            Some(90.0)
        );
        assert_eq!(
            indicator_line_at(&lines, "Asia high", Timestamp(50)),
            Some(120.0)
        );
        assert_eq!(indicator_line_at(&lines, "NY high", Timestamp(50)), None);
    }

    fn sweep(within: u32) -> Alert {
        let level = Operand::IndicatorLine {
            indicator: "ci_1".into(),
            inputs: Default::default(),
            label: "London high".into(),
            name: None,
        };
        let mut a = alert(vec![
            step(AlertOp::CrossesAbove, level.clone(), EvaluateOn::Trade),
            step(AlertOp::Below, level, EvaluateOn::BarClose),
        ]);
        a.within_bars = Some(within);
        a
    }

    fn london(o: &Operand, _: &Observation) -> Option<f64> {
        matches!(o, Operand::IndicatorLine { .. }).then_some(100.0)
    }

    #[test]
    fn a_sweep_then_reclaim_fires_on_the_close_back() {
        let a = sweep(3);
        let mut tr = Tracker::new(&a);
        let v: &dyn Values = &london;
        assert_eq!(
            tr.observe(
                &a,
                &Observation::close(Timestamp(0), Timeframe::M1, 99.0),
                v
            ),
            Outcome::Quiet
        );
        let o = trades(&mut tr, &a, 61 * SEC, &[99.5, 100.25], v);
        assert_eq!(o, vec![Outcome::Quiet, Outcome::Advanced(1)]);
        assert_eq!(
            tr.observe(
                &a,
                &Observation::close(Timestamp(60 * SEC), Timeframe::M1, 100.5),
                v
            ),
            Outcome::Quiet
        );
        assert_eq!(tr.closes_since_first_step(), 1);
        assert_eq!(fired(&trades(&mut tr, &a, 125 * SEC, &[99.75], v)), 0);
        let o = tr.observe(
            &a,
            &Observation::close(Timestamp(120 * SEC), Timeframe::M1, 99.75),
            v,
        );
        assert!(matches!(o, Outcome::Fired(r) if r.subject == 99.75 && r.target == 100.0));
        assert_eq!(tr.step(), 0);
    }

    #[test]
    fn a_sweep_that_holds_above_starts_over_after_its_window() {
        let mut a = sweep(2);
        a.repeat = AlertRepeat::Every;
        a.cooldown_secs = 0;
        let v: &dyn Values = &london;
        let mut tr = Tracker::new(&a);
        trades(&mut tr, &a, 0, &[99.0, 101.0], v);
        assert_eq!(tr.step(), 1);
        assert_eq!(
            tr.observe(
                &a,
                &Observation::close(Timestamp(0), Timeframe::M1, 101.0),
                v
            ),
            Outcome::Quiet
        );
        assert_eq!(
            tr.observe(
                &a,
                &Observation::close(Timestamp(60 * SEC), Timeframe::M1, 102.0),
                v
            ),
            Outcome::Reset
        );
        assert_eq!(tr.step(), 0);
        assert_eq!(
            fired(&[tr.observe(
                &a,
                &Observation::close(Timestamp(120 * SEC), Timeframe::M1, 99.0),
                v
            )]),
            0
        );
        let o = trades(&mut tr, &a, 181 * SEC, &[99.5, 100.5, 99.5], v);
        assert_eq!(o[1], Outcome::Advanced(1));
        assert!(matches!(
            tr.observe(
                &a,
                &Observation::close(Timestamp(180 * SEC), Timeframe::M1, 99.5),
                v
            ),
            Outcome::Fired(_)
        ));
    }

    #[test]
    fn once_fires_once_and_every_honours_its_cooldown() {
        let mut a = alert(vec![step(
            AlertOp::Crosses,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        let path = [99.0, 101.0, 99.0, 101.0, 99.0, 101.0];
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &path, &none)), 1);
        a.repeat = AlertRepeat::Every;
        a.cooldown_secs = 0;
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &path, &none)), 5);
        a.cooldown_secs = 3;
        let mut tr = Tracker::new(&a);
        let o = trades(&mut tr, &a, 0, &path, &none);
        assert_eq!(fired(&o), 2);
        assert!(matches!(o[1], Outcome::Fired(_)) && matches!(o[4], Outcome::Fired(_)));
        a.fired_at = Some(Timestamp(5 * SEC));
        let mut tr = Tracker::new(&a);
        assert_eq!(
            fired(&trades(&mut tr, &a, 6 * SEC, &[99.0, 101.0], &none)),
            0
        );
    }

    #[test]
    fn paused_and_expired_alerts_do_not_fire() {
        let mut a = alert(vec![step(AlertOp::Above, value(100.0), EvaluateOn::Trade)]);
        a.status = AlertStatus::Paused;
        let mut tr = Tracker::new(&a);
        assert_eq!(fired(&trades(&mut tr, &a, 0, &[101.0], &none)), 0);
        a.status = AlertStatus::Active;
        a.expires_at = Some(Timestamp(10 * SEC));
        assert_eq!(
            trades(&mut tr, &a, 10 * SEC, &[101.0], &none),
            vec![Outcome::Expired]
        );
    }

    #[test]
    fn priming_sets_the_side_without_firing() {
        let a = alert(vec![step(
            AlertOp::CrossesAbove,
            value(100.0),
            EvaluateOn::Trade,
        )]);
        let mut tr = Tracker::new(&a);
        tr.prime(&a, &Observation::trade(Timestamp(0), 99.0), &none);
        assert!(matches!(
            tr.observe(&a, &Observation::trade(Timestamp(SEC), 100.5), &none),
            Outcome::Fired(_)
        ));
    }
}
