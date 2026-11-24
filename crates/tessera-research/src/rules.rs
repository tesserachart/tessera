use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backtest::Bars;

/// Which sides a rule may take.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Sides {
    /// Longs only.
    Long,
    /// Shorts only.
    Short,
    #[default]
    Both,
}

impl Sides {
    fn allows(self, side: f64) -> bool {
        match self {
            Sides::Long => side > 0.0,
            Sides::Short => side < 0.0,
            Sides::Both => true,
        }
    }
}

/// A built-in rule and its parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "rule", rename_all = "snake_case")]
pub enum Rule {
    /// In the direction of the fast EMA against the slow one, flipping as they cross.
    EmaCross {
        /// Fast EMA length.
        fast: u32,
        /// Slow EMA length.
        slow: u32,
        /// Sides taken (flat instead of the other side).
        #[serde(default)]
        sides: Sides,
    },
    /// A close beyond the extreme of the bars before it, held for `hold_bars`.
    Breakout {
        /// Bars whose high (low) the close must clear.
        lookback: u32,
        /// Bars a trade is held.
        #[serde(rename = "holdBars")]
        hold_bars: u32,
        /// Sides taken.
        #[serde(default)]
        sides: Sides,
    },
    /// Against an RSI extreme: long under `lower`, short over `upper`, out at 50 or after
    /// `hold_bars`.
    RsiReversion {
        /// Wilder RSI length.
        length: u32,
        /// Long below this.
        lower: f64,
        /// Short above this.
        upper: f64,
        /// Bars a trade is held at most.
        #[serde(rename = "holdBars")]
        hold_bars: u32,
        /// Sides taken.
        #[serde(default)]
        sides: Sides,
    },
}

impl Rule {
    pub fn free_parameters(&self) -> u32 {
        match self {
            Rule::EmaCross { .. } => 2,
            Rule::Breakout { .. } => 2,
            Rule::RsiReversion { .. } => 4,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match *self {
            Rule::EmaCross { fast, slow, .. } if fast == 0 || slow <= fast => {
                Err("an EMA cross needs 0 < fast < slow".into())
            }
            Rule::Breakout {
                lookback,
                hold_bars,
                ..
            } if lookback == 0 || hold_bars == 0 => {
                Err("a breakout needs a lookback and a hold of at least one bar".into())
            }
            Rule::RsiReversion {
                length,
                lower,
                upper,
                hold_bars,
                ..
            } if length < 2
                || !(0.0..50.0).contains(&lower)
                || !(50.0..100.0).contains(&upper)
                || hold_bars == 0 =>
            {
                Err(
                    "an RSI reversion needs length ≥ 2, lower under 50, upper over 50 and a hold"
                        .into(),
                )
            }
            _ => Ok(()),
        }
    }

    #[allow(clippy::needless_range_loop)]
    pub fn targets(&self, bars: &Bars, qty: f64) -> Vec<f64> {
        let n = bars.len();
        let mut out = vec![f64::NAN; n];
        match *self {
            Rule::EmaCross { fast, slow, sides } => {
                let f = ema_seeded_with_first(&bars.close, fast);
                let s = ema_seeded_with_first(&bars.close, slow);
                for i in (slow as usize).min(n)..n {
                    let side = (f[i] - s[i]).signum();
                    out[i] = if side != 0.0 && sides.allows(side) {
                        side * qty
                    } else {
                        0.0
                    };
                }
            }
            Rule::Breakout {
                lookback,
                hold_bars,
                sides,
            } => {
                let (lb, hold) = (lookback as usize, hold_bars as usize);
                let mut until = 0usize;
                for i in lb..n {
                    if i < until {
                        continue;
                    }
                    if i == until && until > 0 {
                        out[i] = 0.0;
                    }
                    let hi = bars.high[i - lb..i]
                        .iter()
                        .copied()
                        .fold(f64::MIN, f64::max);
                    let lo = bars.low[i - lb..i].iter().copied().fold(f64::MAX, f64::min);
                    let side = if bars.close[i] > hi {
                        1.0
                    } else if bars.close[i] < lo {
                        -1.0
                    } else {
                        0.0
                    };
                    if side != 0.0 && sides.allows(side) {
                        out[i] = side * qty;
                        until = i + hold;
                    }
                }
            }
            Rule::RsiReversion {
                length,
                lower,
                upper,
                hold_bars,
                sides,
            } => {
                let r = wilder_rsi(&bars.close, length);
                let mut held: Option<(f64, usize)> = None;
                for i in 0..n {
                    let Some(v) = r[i] else { continue };
                    if let Some((side, at)) = held {
                        let back = if side > 0.0 { v >= 50.0 } else { v <= 50.0 };
                        if back || i >= at + hold_bars as usize {
                            out[i] = 0.0;
                            held = None;
                        }
                        continue;
                    }
                    let side = if v < lower {
                        1.0
                    } else if v > upper {
                        -1.0
                    } else {
                        0.0
                    };
                    if side != 0.0 && sides.allows(side) {
                        out[i] = side * qty;
                        held = Some((side, i));
                    }
                }
            }
        }
        out
    }
}

fn ema_seeded_with_first(v: &[f64], len: u32) -> Vec<f64> {
    let k = 2.0 / (f64::from(len) + 1.0);
    let mut out = Vec::with_capacity(v.len());
    let mut e = v.first().copied().unwrap_or(0.0);
    for x in v {
        e += k * (x - e);
        out.push(e);
    }
    out
}

fn wilder_rsi(v: &[f64], len: u32) -> Vec<Option<f64>> {
    let len = len as usize;
    let mut out = vec![None; v.len()];
    if v.len() <= len {
        return out;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for i in 1..=len {
        let d = v[i] - v[i - 1];
        if d > 0.0 {
            gain += d;
        } else {
            loss -= d;
        }
    }
    gain /= len as f64;
    loss /= len as f64;
    let value = |g: f64, l: f64| {
        if l == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + g / l)
        }
    };
    out[len] = Some(value(gain, loss));
    for i in len + 1..v.len() {
        let d = v[i] - v[i - 1];
        gain = (gain * (len as f64 - 1.0) + d.max(0.0)) / len as f64;
        loss = (loss * (len as f64 - 1.0) + (-d).max(0.0)) / len as f64;
        out[i] = Some(value(gain, loss));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closes(v: &[f64]) -> Bars {
        Bars {
            time: (0..v.len() as i64).collect(),
            open: v.to_vec(),
            high: v.iter().map(|x| x + 0.5).collect(),
            low: v.iter().map(|x| x - 0.5).collect(),
            close: v.to_vec(),
        }
    }

    #[test]
    fn an_ema_cross_follows_the_fast_line_and_respects_its_sides() {
        let mut v: Vec<f64> = (0..30).map(|i| 100.0 + f64::from(i)).collect();
        v.extend((0..30).map(|i| 130.0 - f64::from(i)));
        let b = closes(&v);
        let r = Rule::EmaCross {
            fast: 3,
            slow: 8,
            sides: Sides::Both,
        };
        let t = r.targets(&b, 2.0);
        assert!(
            t[..8].iter().all(|x| x.is_nan()),
            "nothing before the slow EMA has its length"
        );
        assert_eq!(t[20], 2.0);
        assert_eq!(t[59], -2.0);
        let longs = Rule::EmaCross {
            fast: 3,
            slow: 8,
            sides: Sides::Long,
        }
        .targets(&b, 1.0);
        assert_eq!(longs[59], 0.0);
        assert!(
            Rule::EmaCross {
                fast: 5,
                slow: 5,
                sides: Sides::Both
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn a_breakout_needs_the_close_beyond_the_bars_before_it_and_holds() {
        let b = closes(&[10.0, 10.0, 10.0, 12.0, 12.0, 12.0, 12.0, 12.0]);
        let t = Rule::Breakout {
            lookback: 3,
            hold_bars: 2,
            sides: Sides::Both,
        }
        .targets(&b, 1.0);
        assert_eq!(t[3], 1.0);
        assert!(t[4].is_nan());
        assert_eq!(t[5], 0.0, "out after two bars");
    }

    #[test]
    fn an_rsi_reversion_buys_the_low_extreme_and_leaves_at_fifty() {
        let mut v: Vec<f64> = (0..20).map(|i| 100.0 - f64::from(i)).collect();
        v.extend((0..20).map(|i| 81.0 + f64::from(i)));
        let b = closes(&v);
        let t = Rule::RsiReversion {
            length: 5,
            lower: 30.0,
            upper: 70.0,
            hold_bars: 50,
            sides: Sides::Long,
        }
        .targets(&b, 1.0);
        let first = t.iter().position(|x| *x == 1.0).unwrap();
        let out = t.iter().skip(first + 1).position(|x| *x == 0.0).unwrap() + first + 1;
        assert!(
            first < 20 && out >= 20,
            "in on the fall, out on the way back: {first} {out}"
        );
    }
}
