use chrono::NaiveDate;
use tessera_core::Timestamp;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PrintSums {
    pub volume: f64,
    pub pv: f64,
    pub pv2: f64,
}

impl PrintSums {
    pub fn add(&mut self, price: f64, size: f64) {
        self.volume += size;
        self.pv += price * size;
        self.pv2 += price * price * size;
    }

    pub fn add_sums(&mut self, o: &PrintSums) {
        self.volume += o.volume;
        self.pv += o.pv;
        self.pv2 += o.pv2;
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SessionBar {
    pub t: Timestamp,
    pub session: NaiveDate,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VwapSource {
    Prints,
    TypicalPrice,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VwapPoint {
    pub vwap: f64,
    pub sd: f64,
    pub source: VwapSource,
}

pub fn session_vwap(
    bars: &[SessionBar],
    prints: impl Fn(Timestamp) -> Option<PrintSums>,
) -> Vec<VwapPoint> {
    let mut out = Vec::with_capacity(bars.len());
    let mut start = 0;
    while start < bars.len() {
        let session = bars[start].session;
        let end = bars[start..]
            .iter()
            .position(|b| b.session != session)
            .map_or(bars.len(), |k| start + k);
        let measured: Option<Vec<PrintSums>> = bars[start..end]
            .iter()
            .map(|b| match prints(b.t) {
                Some(s) if s.volume > 0.0 => Some(s),
                _ if b.volume <= 0.0 => Some(PrintSums::default()),
                _ => None,
            })
            .collect();
        let source = if measured.is_some() {
            VwapSource::Prints
        } else {
            VwapSource::TypicalPrice
        };
        let mut sum = PrintSums::default();
        for (k, b) in bars[start..end].iter().enumerate() {
            let typical = (b.high + b.low + b.close) / 3.0;
            match &measured {
                Some(m) => sum.add_sums(&m[k]),
                None => sum.add(typical, b.volume),
            }
            let (vwap, sd) = if sum.volume > 0.0 {
                let m = sum.pv / sum.volume;
                (m, (sum.pv2 / sum.volume - m * m).max(0.0).sqrt())
            } else {
                (typical, f64::NAN)
            };
            out.push(VwapPoint { vwap, sd, source });
        }
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn bar(t: i64, day: u32, hlc: (f64, f64, f64), volume: f64) -> SessionBar {
        SessionBar {
            t: Timestamp(t),
            session: NaiveDate::from_ymd_opt(2026, 10, day).unwrap(),
            high: hlc.0,
            low: hlc.1,
            close: hlc.2,
            volume,
        }
    }

    fn tape(prints: &[(i64, f64, f64)]) -> BTreeMap<Timestamp, PrintSums> {
        let mut out: BTreeMap<Timestamp, PrintSums> = BTreeMap::new();
        for &(t, price, size) in prints {
            out.entry(Timestamp(t)).or_default().add(price, size);
        }
        out
    }

    #[test]
    fn a_fixed_tape_gives_the_vwap_its_prints_work_out_to() {
        let prints = tape(&[
            (0, 100.00, 2.0),
            (0, 100.50, 1.0),
            (0, 101.00, 1.0),
            (1, 101.00, 3.0),
            (1, 99.00, 1.0),
        ]);
        let bars = [
            bar(0, 1, (101.0, 100.0, 101.0), 4.0),
            bar(1, 1, (101.0, 99.0, 99.0), 4.0),
        ];
        let got = session_vwap(&bars, |t| prints.get(&t).copied());
        assert_eq!(got[0].source, VwapSource::Prints);
        assert!((got[0].vwap - 100.375).abs() < 1e-12);
        assert!((got[1].vwap - 100.4375).abs() < 1e-12);
        let mean_sq = (2.0 * 100.0f64.powi(2)
            + 100.5f64.powi(2)
            + 101.0f64.powi(2)
            + 3.0 * 101.0f64.powi(2)
            + 99.0f64.powi(2))
            / 8.0;
        assert!((got[1].sd - (mean_sq - 100.4375f64.powi(2)).sqrt()).abs() < 1e-9);
        let typical = (100.0 + 101.0 + 101.0) / 3.0;
        assert!((got[0].vwap - typical).abs() > 0.2, "bar hlc3 is {typical}");
    }

    #[test]
    fn each_session_starts_over_and_one_without_all_its_prints_uses_typical_price() {
        let prints = tape(&[(0, 10.0, 1.0), (1, 12.0, 1.0), (3, 20.0, 5.0)]);
        let bars = [
            bar(0, 1, (10.0, 10.0, 10.0), 1.0),
            bar(1, 1, (12.0, 12.0, 12.0), 1.0),
            bar(2, 2, (18.0, 15.0, 15.0), 2.0),
            bar(3, 2, (20.0, 20.0, 20.0), 5.0),
        ];
        let got = session_vwap(&bars, |t| prints.get(&t).copied());
        assert_eq!(got[1].vwap, 11.0);
        assert_eq!(got[1].source, VwapSource::Prints);
        assert_eq!(got[2].vwap, 16.0);
        assert_eq!(got[2].source, VwapSource::TypicalPrice);
        assert!((got[3].vwap - (16.0 * 2.0 + 20.0 * 5.0) / 7.0).abs() < 1e-12);
        assert_eq!(got[3].source, VwapSource::TypicalPrice);
    }

    #[test]
    fn a_bar_with_no_volume_needs_no_prints_and_a_session_with_none_yet_sits_on_its_price() {
        let prints = tape(&[(1, 30.0, 2.0)]);
        let bars = [
            bar(0, 1, (31.0, 29.0, 30.0), 0.0),
            bar(1, 1, (30.0, 30.0, 30.0), 2.0),
        ];
        let got = session_vwap(&bars, |t| prints.get(&t).copied());
        assert_eq!(got[0].vwap, 30.0);
        assert!(got[0].sd.is_nan());
        assert_eq!(got[1].vwap, 30.0);
        assert_eq!(got[1].sd, 0.0);
        assert!(got.iter().all(|p| p.source == VwapSource::Prints));
    }
}
